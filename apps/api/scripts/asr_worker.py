#!/usr/bin/env python3
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, Optional

from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL

try:
    import ctranslate2
except Exception:  # pragma: no cover - defensive fallback
    ctranslate2 = None


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_env_int(key: str, default: int) -> int:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
        return parsed if parsed > 0 else default
    except ValueError:
        return default


MODEL_NAME = os.environ.get("LOCAL_ASR_MODEL", "large-v3-turbo").strip() or "large-v3-turbo"
REQUESTED_COMPUTE_TYPE = os.environ.get("LOCAL_ASR_COMPUTE_TYPE", "auto").strip().lower() or "auto"
DEFAULT_LANGUAGE = os.environ.get("LOCAL_ASR_LANGUAGE", "auto").strip() or "auto"
BEAM_SIZE = parse_env_int("LOCAL_ASR_BEAM_SIZE", 5)
DOWNLOAD_TIMEOUT_SEC = parse_env_int("YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC", 300)

FFMPEG_BIN = shutil.which("ffmpeg")
if not FFMPEG_BIN:
    log("ffmpeg not found in PATH; local ASR requests will fail")

device = "cpu"
if ctranslate2 is not None:
    try:
        if ctranslate2.get_cuda_device_count() > 0:
            device = "cuda"
    except Exception:
        device = "cpu"


def unique_in_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def compute_type_candidates(target_device: str, requested: str) -> list[str]:
    if target_device == "cuda":
        preferred = ["int8_float16", "float16", "int8", "float32"]
    else:
        preferred = ["int8", "int8_float32", "float32"]

    if requested == "auto":
        return preferred

    return unique_in_order([requested, *preferred])


def is_compute_type_error(error: Exception) -> bool:
    message = str(error).lower()
    return "compute type" in message and "support" in message


def initialize_model(model_name: str, target_device: str, requested_compute_type: str) -> tuple[WhisperModel, str]:
    last_error: Optional[Exception] = None
    candidates = compute_type_candidates(target_device, requested_compute_type)

    for candidate in candidates:
        log(f"Loading faster-whisper model={model_name} device={target_device} compute_type={candidate}")
        try:
            return WhisperModel(model_name, device=target_device, compute_type=candidate), candidate
        except Exception as error:  # pragma: no cover - exercised through process boundary
            last_error = error
            if not is_compute_type_error(error):
                raise
            log(f"compute_type={candidate} unsupported on device={target_device}, trying fallback")

    if last_error is not None:
        raise last_error
    raise RuntimeError("failed to initialize faster-whisper model")


MODEL, ACTIVE_COMPUTE_TYPE = initialize_model(MODEL_NAME, device, REQUESTED_COMPUTE_TYPE)
log(f"ASR worker ready (compute_type={ACTIVE_COMPUTE_TYPE})")


def cleanup_download_artifacts(base_path: Path) -> None:
    for candidate in base_path.parent.glob(f"{base_path.stem}.*"):
        if candidate.is_file():
            candidate.unlink(missing_ok=True)


def download_audio(video_id: str, output_mp3_path: Path) -> Path:
    if not FFMPEG_BIN:
        raise RuntimeError("ffmpeg is required for mp3 extraction but was not found in PATH")

    if output_mp3_path.exists():
        return output_mp3_path

    output_mp3_path.parent.mkdir(parents=True, exist_ok=True)
    cleanup_download_artifacts(output_mp3_path)

    outtmpl = str(output_mp3_path.with_suffix(".%(ext)s"))
    ydl_opts: Dict[str, Any] = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": DOWNLOAD_TIMEOUT_SEC,
        "outtmpl": outtmpl,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
    }

    with YoutubeDL(ydl_opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])

    if output_mp3_path.exists():
        return output_mp3_path

    candidates = list(output_mp3_path.parent.glob(f"{output_mp3_path.stem}*.mp3"))
    if not candidates:
        raise RuntimeError(f"Audio download completed but mp3 was not generated for {video_id}")
    if candidates[0] != output_mp3_path:
        candidates[0].replace(output_mp3_path)
    return output_mp3_path


def transcribe_audio(mp3_path: Path, language: str) -> Dict[str, Any]:
    language_param: Optional[str] = None if language == "auto" else language
    segments, info = MODEL.transcribe(
        str(mp3_path),
        language=language_param,
        beam_size=BEAM_SIZE,
        vad_filter=True,
    )
    parts: list[str] = []
    normalized_segments: list[Dict[str, Any]] = []

    for segment in segments:
        text = segment.text.strip() if segment.text else ""
        if not text:
            continue

        parts.append(text)
        start = float(segment.start) if segment.start is not None else None
        end = float(segment.end) if segment.end is not None else None
        normalized_segments.append(
            {
                "startSec": start,
                "endSec": end,
                "text": text,
                "confidence": None,
            }
        )

    detected_language = getattr(info, "language", None) if info is not None else None
    return {
        "transcript": " ".join(parts).strip(),
        "segments": normalized_segments,
        "language": detected_language if isinstance(detected_language, str) and detected_language.strip() else language,
    }


for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    request_id = ""
    try:
        payload = json.loads(line)
        request_id = str(payload.get("id", "")).strip()
        mode = str(payload.get("mode", "download_and_transcribe")).strip() or "download_and_transcribe"
        if mode not in {"download_and_transcribe", "download_only"}:
            raise ValueError(f"unsupported worker mode: {mode}")

        video_id = str(payload.get("videoId", "")).strip()
        output_mp3_raw = str(payload.get("outputMp3Path", "")).strip()
        language = str(payload.get("language", DEFAULT_LANGUAGE)).strip() or DEFAULT_LANGUAGE

        if not request_id:
            raise ValueError("missing request id")
        if not video_id:
            raise ValueError("missing videoId")
        if not output_mp3_raw:
            raise ValueError("missing outputMp3Path")

        output_mp3_path = Path(output_mp3_raw).resolve()
        emit({"id": request_id, "event": "downloading_audio"})
        mp3_path = download_audio(video_id, output_mp3_path)

        if mode == "download_only":
            emit(
                {
                    "id": request_id,
                    "ok": True,
                    "downloadedPath": str(mp3_path),
                }
            )
            continue

        emit({"id": request_id, "event": "transcribing"})
        transcription = transcribe_audio(mp3_path, language)

        emit(
            {
                "id": request_id,
                "ok": True,
                "transcript": transcription["transcript"],
                "segments": transcription["segments"],
                "language": transcription["language"],
                "model": MODEL_NAME,
                "computeType": ACTIVE_COMPUTE_TYPE,
            }
        )
    except Exception as error:  # pragma: no cover - exercised through process boundary
        message = str(error) if str(error) else "unknown worker error"
        log(f"request failed id={request_id or 'unknown'}: {message}")
        emit({"id": request_id, "ok": False, "error": message})
