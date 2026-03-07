#!/usr/bin/env python3
import json
import inspect
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

try:
    from paddleocr import PaddleOCR
except Exception:  # pragma: no cover - depends on runtime
    PaddleOCR = None

try:
    import easyocr
except Exception:  # pragma: no cover - depends on runtime
    easyocr = None


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
        return parsed if parsed > 0 else default
    except Exception:
        return default


def normalize_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())


def clamp_conf(value: Any) -> float:
    try:
        parsed = float(value)
    except Exception:
        return 0.0
    if parsed <= 0:
        return 0.0
    if parsed >= 1:
        return 1.0
    return round(parsed, 6)


def normalize_langs(raw_langs: Any) -> List[str]:
    if not isinstance(raw_langs, list):
        return ["eng"]

    normalized: List[str] = []
    for raw in raw_langs:
        if not isinstance(raw, str):
            continue
        value = raw.strip().lower()
        if not value:
            continue
        normalized.append(value)

    if not normalized:
        return ["eng"]

    seen: set[str] = set()
    deduped: List[str] = []
    for lang in normalized:
        if lang in seen:
            continue
        seen.add(lang)
        deduped.append(lang)
    return deduped


TESSERACT_TO_PADDLE = {
    "eng": "en",
    "spa": "es",
    "por": "pt",
    "fra": "french",
    "deu": "german",
    "ita": "it",
    "chi_sim": "ch",
    "chi_tra": "chinese_cht",
    "jpn": "japan",
    "kor": "korean",
}

TESSERACT_TO_EASY = {
    "eng": "en",
    "spa": "es",
    "por": "pt",
    "fra": "fr",
    "deu": "de",
    "ita": "it",
    "chi_sim": "ch_sim",
    "chi_tra": "ch_tra",
    "jpn": "ja",
    "kor": "ko",
}

PADDLE_MODELS: Dict[str, Any] = {}
EASY_MODELS: Dict[str, Any] = {}


def paddle_lang(langs: List[str]) -> str:
    for lang in langs:
        mapped = TESSERACT_TO_PADDLE.get(lang)
        if mapped:
            return mapped
    return "en"


def easy_langs(langs: List[str]) -> List[str]:
    resolved: List[str] = []
    for lang in langs:
        mapped = TESSERACT_TO_EASY.get(lang)
        if mapped:
            resolved.append(mapped)

    if not resolved:
        resolved = ["en"]

    seen: set[str] = set()
    deduped: List[str] = []
    for lang in resolved:
        if lang in seen:
            continue
        seen.add(lang)
        deduped.append(lang)
    return deduped


def append_paddle_candidate(candidates: List[Dict[str, Any]], candidate: Dict[str, Any]) -> None:
    normalized = dict(candidate)
    if normalized in candidates:
        return
    candidates.append(normalized)


def build_paddle_init_candidates(lang: str) -> List[Dict[str, Any]]:
    base_candidate: Dict[str, Any] = {"lang": lang}
    params: Dict[str, Any] = {}

    try:
        signature = inspect.signature(PaddleOCR.__init__)
        params = dict(signature.parameters)
    except Exception:
        params = {}

    safe_candidate = dict(base_candidate)
    if "use_doc_orientation_classify" in params:
        safe_candidate["use_doc_orientation_classify"] = False
    if "use_doc_unwarping" in params:
        safe_candidate["use_doc_unwarping"] = False
    if "use_textline_orientation" in params:
        safe_candidate["use_textline_orientation"] = False
    elif "use_angle_cls" in params:
        safe_candidate["use_angle_cls"] = False

    # PaddleOCR 3.x enables MKLDNN by default; on Windows this can fail on OCR
    # thumbnails with oneDNN/PIR conversion errors inside Paddle runtime.
    if sys.platform == "win32":
        safe_candidate["enable_mkldnn"] = False

    candidates: List[Dict[str, Any]] = []
    append_paddle_candidate(candidates, safe_candidate)

    if "enable_mkldnn" in safe_candidate:
        without_mkldnn = dict(safe_candidate)
        without_mkldnn.pop("enable_mkldnn", None)
        append_paddle_candidate(candidates, without_mkldnn)

    legacy_candidate = dict(base_candidate)
    if "use_angle_cls" in params:
        legacy_candidate["use_angle_cls"] = False
    append_paddle_candidate(candidates, legacy_candidate)
    append_paddle_candidate(candidates, base_candidate)
    return candidates


def get_paddle_model(lang: str) -> Any:
    model = PADDLE_MODELS.get(lang)
    if model is not None:
        return model

    if PaddleOCR is None:
        raise RuntimeError("paddleocr is not installed")

    log(f"Loading PaddleOCR model lang={lang}")
    candidates = build_paddle_init_candidates(lang)

    last_error: Optional[Exception] = None
    model = None
    for candidate in candidates:
        try:
            model = PaddleOCR(**candidate)
            break
        except TypeError as error:
            last_error = error
        except Exception as error:
            message = str(error)
            if "Unknown argument" not in message and "unexpected keyword argument" not in message:
                raise
            last_error = error

    if model is None:
        raise last_error if last_error is not None else RuntimeError("Unable to initialize PaddleOCR")

    PADDLE_MODELS[lang] = model
    return model


def get_easy_model(langs: List[str]) -> Any:
    key = "+".join(langs)
    model = EASY_MODELS.get(key)
    if model is not None:
        return model

    if easyocr is None:
        raise RuntimeError("easyocr is not installed")

    log(f"Loading EasyOCR model langs={key}")
    model = easyocr.Reader(langs, gpu=False)
    EASY_MODELS[key] = model
    return model


def scale_box(x_min: float, y_min: float, x_max: float, y_max: float, inv_scale: float) -> Dict[str, int]:
    x = max(0, int(round(x_min * inv_scale)))
    y = max(0, int(round(y_min * inv_scale)))
    w = max(0, int(round((x_max - x_min) * inv_scale)))
    h = max(0, int(round((y_max - y_min) * inv_scale)))
    return {"x": x, "y": y, "w": w, "h": h}


def bbox_from_quad(quad: Any) -> Optional[Dict[str, float]]:
    if not isinstance(quad, (list, tuple)):
        try:
            quad = quad.tolist()
        except Exception:
            return None

    if len(quad) < 4:
        return None

    xs: List[float] = []
    ys: List[float] = []
    for point in quad:
        if not isinstance(point, (list, tuple)):
            try:
                point = point.tolist()
            except Exception:
                continue
        if len(point) < 2:
            continue
        try:
            xs.append(float(point[0]))
            ys.append(float(point[1]))
        except Exception:
            continue

    if len(xs) < 2 or len(ys) < 2:
        return None

    return {
        "x_min": min(xs),
        "y_min": min(ys),
        "x_max": max(xs),
        "y_max": max(ys),
    }


def detect_with_paddle(image_bgr: np.ndarray, langs: List[str], inv_scale: float) -> List[Dict[str, Any]]:
    lang = paddle_lang(langs)
    model = get_paddle_model(lang)

    predict = getattr(model, "predict", None)
    if callable(predict):
        raw = predict(image_bgr)
    else:
        raw = model.ocr(image_bgr)
    if not isinstance(raw, list):
        return []

    boxes: List[Dict[str, Any]] = []

    # PaddleOCR v3 returns [OCRResult], where OCRResult exposes dt_polys/rec_texts/rec_scores.
    if len(raw) == 1 and not isinstance(raw[0], list):
        result_obj = raw[0]
        try:
            dt_polys = result_obj["dt_polys"]  # type: ignore[index]
            rec_texts = result_obj["rec_texts"]  # type: ignore[index]
            rec_scores = result_obj["rec_scores"]  # type: ignore[index]
        except Exception:
            dt_polys = []
            rec_texts = []
            rec_scores = []

        if isinstance(dt_polys, list) and isinstance(rec_texts, list) and isinstance(rec_scores, list):
            count = min(len(dt_polys), len(rec_texts), len(rec_scores))
            for index in range(count):
                bounds = bbox_from_quad(dt_polys[index])
                if not bounds:
                    continue

                text = normalize_text(rec_texts[index])
                conf = clamp_conf(rec_scores[index])
                if not text:
                    continue

                scaled = scale_box(bounds["x_min"], bounds["y_min"], bounds["x_max"], bounds["y_max"], inv_scale)
                if scaled["w"] <= 0 or scaled["h"] <= 0:
                    continue

                boxes.append(
                    {
                        "x": scaled["x"],
                        "y": scaled["y"],
                        "w": scaled["w"],
                        "h": scaled["h"],
                        "conf": conf,
                        "text": text,
                    }
                )

            if boxes:
                return boxes

    lines = raw[0] if len(raw) == 1 and isinstance(raw[0], list) else raw

    for item in lines:
        if not isinstance(item, list) or len(item) < 2:
            continue

        bounds = bbox_from_quad(item[0])
        if not bounds:
            continue

        rec = item[1]
        text = ""
        conf = 0.0

        if isinstance(rec, (list, tuple)) and len(rec) >= 2:
            text = normalize_text(rec[0])
            conf = clamp_conf(rec[1])

        if not text:
            continue

        scaled = scale_box(bounds["x_min"], bounds["y_min"], bounds["x_max"], bounds["y_max"], inv_scale)
        if scaled["w"] <= 0 or scaled["h"] <= 0:
            continue

        boxes.append(
            {
                "x": scaled["x"],
                "y": scaled["y"],
                "w": scaled["w"],
                "h": scaled["h"],
                "conf": conf,
                "text": text,
            }
        )

    return boxes


def detect_with_easyocr(image_bgr: np.ndarray, langs: List[str], inv_scale: float) -> List[Dict[str, Any]]:
    resolved_langs = easy_langs(langs)
    model = get_easy_model(resolved_langs)

    raw = model.readtext(image_bgr, detail=1, paragraph=False)
    if not isinstance(raw, list):
        return []

    boxes: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            continue

        bounds = bbox_from_quad(item[0])
        if not bounds:
            continue

        text = normalize_text(item[1])
        conf = clamp_conf(item[2])

        if not text:
            continue

        scaled = scale_box(bounds["x_min"], bounds["y_min"], bounds["x_max"], bounds["y_max"], inv_scale)
        if scaled["w"] <= 0 or scaled["h"] <= 0:
            continue

        boxes.append(
            {
                "x": scaled["x"],
                "y": scaled["y"],
                "w": scaled["w"],
                "h": scaled["h"],
                "conf": conf,
                "text": text,
            }
        )

    return boxes


def detect_text(image_bgr: np.ndarray, langs: List[str], inv_scale: float) -> tuple[str, List[Dict[str, Any]]]:
    paddle_error: Optional[Exception] = None
    if PaddleOCR is not None:
        try:
            return "paddleocr", detect_with_paddle(image_bgr, langs, inv_scale)
        except Exception as error:
            paddle_error = error
            log(f"PaddleOCR runtime failed, attempting fallback: {error}")

    if easyocr is not None:
        try:
            return "easyocr", detect_with_easyocr(image_bgr, langs, inv_scale)
        except Exception as error:
            if paddle_error is not None:
                raise RuntimeError(f"PaddleOCR failed: {paddle_error}; EasyOCR fallback failed: {error}")
            raise

    if paddle_error is not None:
        raise paddle_error
    raise RuntimeError("Neither paddleocr nor easyocr is installed")


if PaddleOCR is None and easyocr is None:
    log("OCR worker ready without OCR backends (install paddleocr or easyocr)")
else:
    active = "paddleocr" if PaddleOCR is not None else "easyocr"
    log(f"OCR worker ready (preferred_engine={active})")


for raw_line in sys.stdin:
    line = raw_line.strip()
    if not line:
        continue

    request_id = ""
    try:
        payload = json.loads(line)
        request_id = str(payload.get("id", "")).strip()
        image_path_raw = str(payload.get("imagePath", "")).strip()
        langs = normalize_langs(payload.get("langs"))
        downscale_width = parse_positive_int(payload.get("downscaleWidth"), 0)

        if not request_id:
            raise ValueError("missing request id")
        if not image_path_raw:
            raise ValueError("missing imagePath")

        image_path = Path(image_path_raw).resolve()
        if not image_path.exists() or not image_path.is_file():
            raise FileNotFoundError(f"image not found: {image_path}")

        t0 = time.perf_counter()
        encoded = np.fromfile(str(image_path), dtype=np.uint8)
        image_bgr = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if image_bgr is None:
            raise RuntimeError(f"failed to decode image: {image_path}")
        image_height, image_width = image_bgr.shape[:2]
        load_ms = int(round((time.perf_counter() - t0) * 1000))

        detect_img = image_bgr
        scale = 1.0
        if downscale_width > 0 and image_width > downscale_width:
            scale = downscale_width / float(image_width)
            target_height = max(1, int(round(image_height * scale)))
            detect_img = cv2.resize(image_bgr, (downscale_width, target_height), interpolation=cv2.INTER_AREA)

        inv_scale = 1.0 / scale if scale > 0 else 1.0

        t1 = time.perf_counter()
        engine, boxes = detect_text(detect_img, langs, inv_scale)
        ocr_ms = int(round((time.perf_counter() - t1) * 1000))

        emit(
            {
                "id": request_id,
                "ok": True,
                "engine": engine,
                "imageWidth": int(image_width),
                "imageHeight": int(image_height),
                "boxes": boxes,
                "timingMs": {"load": load_ms, "ocr": ocr_ms},
            }
        )
    except Exception as error:  # pragma: no cover - exercised through process boundary
        message = str(error) if str(error) else "unknown worker error"
        log(f"request failed id={request_id or 'unknown'}: {message}")
        emit({"id": request_id, "ok": False, "error": message})
