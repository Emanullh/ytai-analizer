import { promises as fs } from "node:fs";

export interface TranscriptArtifactMeta {
  type: "meta";
  videoId?: string;
  source?: "captions" | "asr" | "none";
  status?: "ok" | "missing" | "error";
  language?: string;
  model?: string | null;
  computeType?: string | null;
  createdAt?: string;
  transcriptCleaned?: boolean;
  warning?: string;
}

export interface TranscriptArtifactSegment {
  type: "segment";
  i: number;
  startSec: number | null;
  endSec: number | null;
  text: string;
  confidence: number | null;
}

export interface TranscriptArtifact {
  meta: TranscriptArtifactMeta | null;
  segments: TranscriptArtifactSegment[];
  warnings: string[];
  sourcePath: string;
  usedFallback: boolean;
}

export interface LoadTranscriptJsonlOptions {
  fallbackTranscript?: string;
  videoId?: string;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeSegment(raw: unknown, fallbackIndex: number): TranscriptArtifactSegment | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const text = typeof source.text === "string" ? source.text.trim() : "";
  if (!text) {
    return null;
  }

  const iRaw = source.i;
  const i = typeof iRaw === "number" && Number.isFinite(iRaw) ? Math.max(0, Math.floor(iRaw)) : fallbackIndex;

  return {
    type: "segment",
    i,
    startSec: toFiniteNumber(source.startSec),
    endSec: toFiniteNumber(source.endSec),
    text,
    confidence: toFiniteNumber(source.confidence)
  };
}

function normalizeMeta(raw: unknown): TranscriptArtifactMeta | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const typeRaw = source.type;
  if (typeRaw !== "meta") {
    return null;
  }

  const sourceRaw = source.source;
  const statusRaw = source.status;

  return {
    type: "meta",
    videoId: typeof source.videoId === "string" ? source.videoId : undefined,
    source:
      sourceRaw === "captions" || sourceRaw === "asr" || sourceRaw === "none"
        ? sourceRaw
        : undefined,
    status: statusRaw === "ok" || statusRaw === "missing" || statusRaw === "error" ? statusRaw : undefined,
    language: typeof source.language === "string" ? source.language : undefined,
    model: typeof source.model === "string" ? source.model : null,
    computeType: typeof source.computeType === "string" ? source.computeType : null,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : undefined,
    transcriptCleaned: typeof source.transcriptCleaned === "boolean" ? source.transcriptCleaned : undefined,
    warning: typeof source.warning === "string" ? source.warning : undefined
  };
}

function buildFallbackArtifact(pathToArtifact: string, options: LoadTranscriptJsonlOptions): TranscriptArtifact {
  const fallbackText = options.fallbackTranscript?.trim() ?? "";

  return {
    meta: {
      type: "meta",
      videoId: options.videoId,
      source: "none",
      status: fallbackText ? "ok" : "missing",
      language: "auto",
      model: null,
      computeType: null,
      createdAt: new Date().toISOString(),
      transcriptCleaned: false,
      warning: `Transcript artifact missing at ${pathToArtifact}; used in-memory fallback`
    },
    segments: [
      {
        type: "segment",
        i: 0,
        startSec: null,
        endSec: null,
        text: fallbackText,
        confidence: null
      }
    ],
    warnings: [
      `Transcript artifact missing at ${pathToArtifact}; used in-memory fallback segment`
    ],
    sourcePath: pathToArtifact,
    usedFallback: true
  };
}

export async function loadTranscriptJsonl(
  pathToArtifact: string,
  options: LoadTranscriptJsonlOptions = {}
): Promise<TranscriptArtifact> {
  try {
    const raw = await fs.readFile(pathToArtifact, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    let meta: TranscriptArtifactMeta | null = null;
    const segments: TranscriptArtifactSegment[] = [];
    const warnings: string[] = [];

    lines.forEach((line, lineIndex) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const type = parsed.type;

        if (type === "meta") {
          const normalizedMeta = normalizeMeta(parsed);
          if (normalizedMeta) {
            meta = normalizedMeta;
          }
          return;
        }

        if (type === "segment") {
          const segment = normalizeSegment(parsed, lineIndex - 1);
          if (segment) {
            segments.push(segment);
          }
        }
      } catch {
        warnings.push(`Invalid transcript JSONL row ignored at line ${lineIndex + 1} (${pathToArtifact})`);
      }
    });

    segments.sort((a, b) => a.i - b.i);

    return {
      meta,
      segments,
      warnings,
      sourcePath: pathToArtifact,
      usedFallback: false
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return buildFallbackArtifact(pathToArtifact, options);
    }
    throw error;
  }
}
