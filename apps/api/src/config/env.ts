import dotenv from "dotenv";

dotenv.config();

function parsePort(value: string | undefined): number {
  if (!value) {
    return 3001;
  }

  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return 3001;
  }
  return port;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return defaultValue;
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return parsed;
}

function parseReasoningEffort(
  value: string | undefined,
  defaultValue: "low" | "medium" | "high"
): "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "low") {
    return "low";
  }
  if (normalized === "medium") {
    return "medium";
  }
  if (normalized === "high") {
    return "high";
  }
  return defaultValue;
}

function parseThumbOcrEngine(_value: string | undefined, _defaultValue: "python"): "python" {
  return "python";
}

export const env = {
  localAsrMaxConcurrency: parsePositiveInt(process.env.LOCAL_ASR_MAX_CONCURRENCY, 1),
  exportAsrConcurrency: parsePositiveInt(
    process.env.EXPORT_ASR_CONCURRENCY,
    parsePositiveInt(process.env.LOCAL_ASR_MAX_CONCURRENCY, 1)
  ),
  port: parsePort(process.env.PORT),
  youtubeApiKey: process.env.YOUTUBE_API_KEY?.trim() ?? "",
  openAiApiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
  transcriptLang: process.env.TRANSCRIPT_LANG?.trim() || undefined,
  localAsrEnabled: parseBoolean(process.env.LOCAL_ASR_ENABLED, true),
  localAsrModel: process.env.LOCAL_ASR_MODEL?.trim() || "large-v3-turbo",
  localAsrComputeType: process.env.LOCAL_ASR_COMPUTE_TYPE?.trim() || "auto",
  localAsrLanguage: process.env.LOCAL_ASR_LANGUAGE?.trim() || "auto",
  localAsrTimeoutSec: parsePositiveInt(process.env.LOCAL_ASR_TIMEOUT_SEC, 900),
  localAsrBeamSize: parsePositiveInt(process.env.LOCAL_ASR_BEAM_SIZE, 5),
  youtubeAudioDownloadTimeoutSec: parsePositiveInt(process.env.YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC, 300),
  exportVideoConcurrency: parsePositiveInt(process.env.EXPORT_VIDEO_CONCURRENCY, 3),
  exportHttpConcurrency: parsePositiveInt(process.env.EXPORT_HTTP_CONCURRENCY, 6),
  exportOcrConcurrency: parsePositiveInt(process.env.EXPORT_OCR_CONCURRENCY, 2),
  exportLlmConcurrency: parsePositiveInt(process.env.EXPORT_LLM_CONCURRENCY, 2),
  exportEmbeddingsConcurrency: parsePositiveInt(process.env.EXPORT_EMBEDDINGS_CONCURRENCY, 2),
  exportFsConcurrency: parsePositiveInt(process.env.EXPORT_FS_CONCURRENCY, 6),
  exportFailFast: parseBoolean(process.env.EXPORT_FAIL_FAST, false),
  autoGenEnabled: parseBoolean(process.env.AUTO_GEN_ENABLED, true),
  autoGenModelTitle: process.env.AUTO_GEN_MODEL_TITLE?.trim() || "gpt-5.2",
  autoGenModelDescription: process.env.AUTO_GEN_MODEL_DESCRIPTION?.trim() || "gpt-5.2",
  autoGenModelThumbnail: process.env.AUTO_GEN_MODEL_THUMBNAIL?.trim() || "gpt-5.2",
  autoGenModelOrchestrator: process.env.AUTO_GEN_MODEL_ORCHESTRATOR?.trim() || "gpt-5.2-pro",
  autoGenReasoningEffort: parseReasoningEffort(process.env.AUTO_GEN_REASONING_EFFORT, "low"),
  autoGenReasoningEffortOrchestrator: parseReasoningEffort(
    process.env.AUTO_GEN_REASONING_EFFORT_ORCHESTRATOR,
    "medium"
  ),
  autoGenTimeoutSec: parsePositiveInt(process.env.AUTO_GEN_TIMEOUT_SEC, 60),
  autoGenTimeoutOrchestratorSec: parsePositiveInt(process.env.AUTO_GEN_TIMEOUT_ORCHESTRATOR_SEC, 300),
  exportBundleRawVideosMaxBytes: parsePositiveInt(process.env.EXPORT_BUNDLE_RAW_VIDEOS_MAX_BYTES, 30 * 1024 * 1024),
  exportBundleConfirmThresholdMb: parsePositiveInt(process.env.EXPORT_BUNDLE_CONFIRM_THRESHOLD_MB, 80),
  thumbOcrEnabled: parseBoolean(process.env.THUMB_OCR_ENABLED, true),
  thumbOcrEngine: parseThumbOcrEngine(process.env.THUMB_OCR_ENGINE, "python"),
  thumbOcrLangs: process.env.THUMB_OCR_LANGS?.trim() || "eng",
  thumbVisionDownscaleWidth: parsePositiveInt(process.env.THUMB_VISION_DOWNSCALE_WIDTH, 256)
};
