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

export const env = {
  port: parsePort(process.env.PORT),
  youtubeApiKey: process.env.YOUTUBE_API_KEY?.trim() ?? "",
  transcriptLang: process.env.TRANSCRIPT_LANG?.trim() || undefined,
  localAsrEnabled: parseBoolean(process.env.LOCAL_ASR_ENABLED, true),
  localAsrModel: process.env.LOCAL_ASR_MODEL?.trim() || "large-v3-turbo",
  localAsrComputeType: process.env.LOCAL_ASR_COMPUTE_TYPE?.trim() || "auto",
  localAsrLanguage: process.env.LOCAL_ASR_LANGUAGE?.trim() || "auto",
  localAsrMaxConcurrency: parsePositiveInt(process.env.LOCAL_ASR_MAX_CONCURRENCY, 1),
  localAsrTimeoutSec: parsePositiveInt(process.env.LOCAL_ASR_TIMEOUT_SEC, 900),
  localAsrBeamSize: parsePositiveInt(process.env.LOCAL_ASR_BEAM_SIZE, 5),
  youtubeAudioDownloadTimeoutSec: parsePositiveInt(process.env.YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC, 300)
};
