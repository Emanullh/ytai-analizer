import { env } from "../config/env.js";
import type { TranscriptPipelineResult } from "./transcriptPipeline.js";
import type { TranscriptSegment } from "./transcriptModels.js";

export interface TranscriptArtifactMetaRecordV1 {
  type: "meta";
  videoId: string;
  source: TranscriptPipelineResult["source"];
  status: "ok" | "missing" | "error";
  language: string;
  model: string | null;
  computeType: string | null;
  createdAt: string;
  transcriptCleaned: boolean;
  warning?: string;
}

export interface TranscriptArtifactSegmentRecordV1 {
  type: "segment";
  i: number;
  startSec: number | null;
  endSec: number | null;
  text: string;
  confidence: number | null;
}

export type TranscriptArtifactRecordV1 = TranscriptArtifactMetaRecordV1 | TranscriptArtifactSegmentRecordV1;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeTranscriptSegments(segments: TranscriptSegment[] | undefined): TranscriptSegment[] {
  if (!Array.isArray(segments)) {
    return [];
  }

  return segments
    .map((segment) => {
      const text = segment.text.trim();
      if (!text) {
        return null;
      }

      return {
        startSec: toFiniteNumber(segment.startSec),
        endSec: toFiniteNumber(segment.endSec),
        text,
        confidence: toFiniteNumber(segment.confidence)
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

export function resolveTranscriptLanguage(result: TranscriptPipelineResult): string {
  if (result.language?.trim()) {
    return result.language.trim();
  }
  if (result.source === "asr" || result.source === "none") {
    return env.localAsrLanguage || "auto";
  }
  return env.transcriptLang ?? "auto";
}

export function buildTranscriptArtifactRecords(input: {
  videoId: string;
  result: TranscriptPipelineResult;
  transcriptStatus: "ok" | "missing" | "error";
  transcriptText: string;
  transcriptCleaned: boolean;
  createdAt: string;
}): TranscriptArtifactRecordV1[] {
  const meta: TranscriptArtifactMetaRecordV1 = {
    type: "meta",
    videoId: input.videoId,
    source: input.result.source,
    status: input.transcriptStatus,
    language: resolveTranscriptLanguage(input.result),
    model: input.result.asrMeta?.model ?? null,
    computeType: input.result.asrMeta?.computeType ?? null,
    createdAt: input.createdAt,
    transcriptCleaned: input.transcriptCleaned,
    ...(input.result.warning ? { warning: input.result.warning } : {})
  };

  const segments = normalizeTranscriptSegments(input.result.segments);
  const effectiveSegments =
    segments.length > 0
      ? segments
      : input.transcriptStatus === "ok" && input.transcriptText.trim()
        ? [
            {
              startSec: null,
              endSec: null,
              text: input.transcriptText,
              confidence: null
            } satisfies TranscriptSegment
          ]
        : [];

  const segmentRecords: TranscriptArtifactSegmentRecordV1[] = effectiveSegments.map((segment, index) => ({
    type: "segment",
    i: index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    confidence: segment.confidence
  }));

  return [meta, ...segmentRecords];
}
