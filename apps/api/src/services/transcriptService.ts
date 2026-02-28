import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError
} from "youtube-transcript";
import type { TranscriptResponse } from "youtube-transcript";
import { env } from "../config/env.js";
import type { TranscriptSegment } from "./transcriptModels.js";
import { SimpleCache } from "../utils/cache.js";

export type TranscriptStatus = "ok" | "missing" | "error";

export interface TranscriptResult {
  transcript: string;
  status: TranscriptStatus;
  warning?: string;
  language?: string;
  segments?: TranscriptSegment[];
}

export interface TranscriptOptions {
  timeoutMs?: number;
  maxRetries?: number;
  lang?: string;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 400;
const transcriptCache = new SimpleCache<string, TranscriptResult>(10 * 60 * 1000);
const isDevMode = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";

function logTranscriptEvent(payload: Record<string, unknown>): void {
  if (!isDevMode) {
    return;
  }

  // eslint-disable-next-line no-console
  console.info(
    JSON.stringify({
      scope: "transcript",
      ...payload
    })
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

function isMissingError(error: unknown): boolean {
  return (
    error instanceof YoutubeTranscriptDisabledError ||
    error instanceof YoutubeTranscriptNotAvailableError ||
    error instanceof YoutubeTranscriptVideoUnavailableError ||
    error instanceof YoutubeTranscriptNotAvailableLanguageError
  );
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof YoutubeTranscriptTooManyRequestError) {
    return true;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("too many requests") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("eai_again")
  );
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown transcript error";
}

function buildMissingWarning(videoId: string, lang?: string): string {
  if (lang) {
    return `Transcript unavailable for video ${videoId} (captions missing/disabled or language "${lang}" unavailable)`;
  }
  return `Transcript unavailable for video ${videoId} (captions missing/disabled)`;
}

function buildErrorWarning(videoId: string, message: string): string {
  return `Transcript fetch error for video ${videoId}: ${message}`;
}

function buildCacheKey(videoId: string, lang?: string): string {
  return `${videoId}:${lang ?? "default"}`;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTranscriptLines(videoId: string, lang: string | undefined, timeoutMs: number) {
  try {
    return await withTimeout(
      YoutubeTranscript.fetchTranscript(videoId, lang ? { lang } : undefined),
      timeoutMs,
      "Transcript timeout"
    );
  } catch (error) {
    if (lang && error instanceof YoutubeTranscriptNotAvailableLanguageError) {
      logTranscriptEvent({
        videoId,
        status: "lang_fallback",
        lang
      });
      return withTimeout(YoutubeTranscript.fetchTranscript(videoId), timeoutMs, "Transcript timeout");
    }
    throw error;
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function buildTranscriptSegments(lines: TranscriptResponse[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) {
      continue;
    }

    const startSec = toFiniteNumber(line.offset);
    const durationSec = toFiniteNumber(line.duration);
    segments.push({
      startSec,
      endSec: startSec !== null && durationSec !== null ? startSec + durationSec : null,
      text,
      confidence: null
    });
  }

  return segments;
}

function resolveLanguage(lines: TranscriptResponse[], fallback?: string): string {
  for (const line of lines) {
    const maybeLanguage = line.lang?.trim();
    if (maybeLanguage) {
      return maybeLanguage;
    }
  }
  return fallback ?? "auto";
}

export async function getTranscript(videoId: string, options: TranscriptOptions = {}): Promise<TranscriptResult> {
  const normalizedVideoId = videoId.trim();
  const lang = options.lang ?? env.transcriptLang;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const cacheKey = buildCacheKey(normalizedVideoId, lang);

  const cached = transcriptCache.get(cacheKey);
  if (cached !== null) {
    logTranscriptEvent({
      videoId: normalizedVideoId,
      status: cached.status,
      cache: "hit"
    });
    return cached;
  }

  let attempt = 0;
  while (attempt <= maxRetries) {
    attempt += 1;

    try {
      const transcriptLines = await fetchTranscriptLines(normalizedVideoId, lang, timeoutMs);
      const segments = buildTranscriptSegments(transcriptLines);
      const transcript = segments.map((segment) => segment.text).join(" ").trim();
      const language = resolveLanguage(transcriptLines, lang);

      if (!transcript) {
        const missingResult: TranscriptResult = {
          transcript: "",
          status: "missing",
          warning: buildMissingWarning(normalizedVideoId, lang),
          language
        };
        transcriptCache.set(cacheKey, missingResult);
        logTranscriptEvent({
          videoId: normalizedVideoId,
          status: missingResult.status,
          attempt
        });
        return missingResult;
      }

      const okResult: TranscriptResult = {
        transcript,
        status: "ok",
        language,
        segments
      };
      transcriptCache.set(cacheKey, okResult);
      logTranscriptEvent({
        videoId: normalizedVideoId,
        status: okResult.status,
        attempt
      });
      return okResult;
    } catch (error) {
      const message = normalizeErrorMessage(error);
      if (isMissingError(error)) {
        const missingResult: TranscriptResult = {
          transcript: "",
          status: "missing",
          warning: buildMissingWarning(normalizedVideoId, lang)
        };
        transcriptCache.set(cacheKey, missingResult);
        logTranscriptEvent({
          videoId: normalizedVideoId,
          status: missingResult.status,
          attempt,
          message
        });
        return missingResult;
      }

      const retryable = isRetryableError(error);
      if (retryable && attempt <= maxRetries) {
        logTranscriptEvent({
          videoId: normalizedVideoId,
          status: "retry",
          attempt,
          message
        });
        await wait(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      const errorResult: TranscriptResult = {
        transcript: "",
        status: "error",
        warning: buildErrorWarning(normalizedVideoId, message)
      };
      transcriptCache.set(cacheKey, errorResult);
      logTranscriptEvent({
        videoId: normalizedVideoId,
        status: errorResult.status,
        attempt,
        message
      });
      return errorResult;
    }
  }

  const fallbackError: TranscriptResult = {
    transcript: "",
    status: "error",
    warning: buildErrorWarning(normalizedVideoId, "retry limit reached")
  };
  transcriptCache.set(cacheKey, fallbackError);
  return fallbackError;
}

export function __resetTranscriptCacheForTests(): void {
  transcriptCache.clear();
}

export async function getTranscriptBestEffort(videoId: string): Promise<{ transcript: string; warning?: string }> {
  const result = await getTranscript(videoId);
  return {
    transcript: result.transcript,
    warning: result.warning
  };
}
