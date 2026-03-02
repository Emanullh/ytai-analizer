import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type { TranscriptSegment } from "../services/transcriptModels.js";
import { requestAutoGenTask } from "../services/autogenRuntime.js";
import {
  computeTitleDeterministicFeatures,
  type ComputeTitleDeterministicFeaturesArgs,
  type DeterministicTitleFeatures
} from "./titleDeterministic.js";

const PROMISE_TYPE_LABELS = [
  "howto/tutorial",
  "review",
  "news",
  "challenge",
  "comparison",
  "listicle",
  "storytime",
  "reaction",
  "case-study",
  "tooling",
  "explainer"
] as const;

const CURIOSITY_GAP_LABELS = [
  "threat",
  "mystery",
  "contrarian",
  "how-to",
  "controversy",
  "warning",
  "breakdown",
  "unknown"
] as const;

const CLAIM_STRENGTH_LABELS = ["low", "medium", "high"] as const;

type PromiseTypeLabel = (typeof PROMISE_TYPE_LABELS)[number];
type CuriosityGapLabel = (typeof CURIOSITY_GAP_LABELS)[number];
type HeadlineClaimStrength = (typeof CLAIM_STRENGTH_LABELS)[number];

export interface LlmEvidenceSpan {
  charStart: number;
  charEnd: number;
  snippet: string;
}

export interface LlmLabelScore<TLabel extends string> {
  label: TLabel;
  score: number;
  confidence: number;
  evidence: LlmEvidenceSpan[];
}

export interface TitleLlmResultV1 {
  schemaVersion: "derived.title_llm.v1";
  promise_type: Array<LlmLabelScore<PromiseTypeLabel>>;
  curiosity_gap_type: Array<LlmLabelScore<CuriosityGapLabel>>;
  headline_claim_strength: {
    label: HeadlineClaimStrength;
    confidence: number;
    evidence: LlmEvidenceSpan[];
  } | null;
}

export interface TitleFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  titleFeatures: {
    deterministic: DeterministicTitleFeatures;
    llm: TitleLlmResultV1 | null;
  };
}

export interface ComputeTitleFeaturesArgs {
  videoId: string;
  title: string;
  transcript?: string;
  transcriptSegments?: TranscriptSegment[];
  languageHint?: "auto" | "en" | "es";
}

export interface ComputeTitleFeaturesResult {
  bundle: TitleFeaturesArtifactV1;
  warnings: string[];
}

export interface PersistTitleFeaturesArgs extends ComputeTitleFeaturesArgs {
  exportsRoot: string;
  channelFolderPath: string;
}

export interface PersistTitleFeaturesResult extends ComputeTitleFeaturesResult {
  artifactAbsolutePath: string;
  artifactRelativePath: string;
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid export path for derived artifact");
  }
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA <= 0 || normB <= 0) {
    return 0;
  }

  const cosine = dot / Math.sqrt(normA * normB);
  if (cosine <= -1) {
    return -1;
  }
  if (cosine >= 1) {
    return 1;
  }
  return Number(cosine.toFixed(6));
}

function toSafeRelativePath(rootPath: string, targetPath: string): string {
  ensureInsideRoot(rootPath, targetPath);
  const relativePath = path.relative(rootPath, targetPath);
  const normalized = relativePath.split(path.sep).join(path.posix.sep);
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid relative artifact path");
  }
  return normalized;
}

async function fetchEmbedding(input: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openAiApiKey}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input
    }),
    signal: AbortSignal.timeout(Math.max(5_000, env.autoGenTimeoutSec * 1_000))
  });

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    const message = payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(message);
  }

  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("OpenAI embeddings response did not contain a valid vector");
  }

  return embedding;
}

export async function maybeComputeEmbeddingsSimilarity(
  title: string,
  transcript: string
): Promise<{ value: number | null; warnings: string[] }> {
  if (!env.openAiApiKey) {
    return {
      value: null,
      warnings: ["Embeddings similarity skipped: OPENAI_API_KEY is not configured"]
    };
  }

  if (!transcript.trim()) {
    return {
      value: null,
      warnings: ["Embeddings similarity skipped: transcript is empty"]
    };
  }

  try {
    const [titleEmbedding, transcriptEmbedding] = await Promise.all([fetchEmbedding(title), fetchEmbedding(transcript)]);
    return {
      value: cosineSimilarity(titleEmbedding, transcriptEmbedding),
      warnings: []
    };
  } catch (error) {
    return {
      value: null,
      warnings: [
        `Embeddings similarity failed: ${error instanceof Error ? error.message : "unknown embeddings error"}`
      ]
    };
  }
}

function normalizeEvidenceSpans(raw: unknown, title: string): LlmEvidenceSpan[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const charStartRaw = (item as { charStart?: unknown }).charStart;
      const charEndRaw = (item as { charEnd?: unknown }).charEnd;
      const snippetRaw = (item as { snippet?: unknown }).snippet;

      const charStart = typeof charStartRaw === "number" && Number.isFinite(charStartRaw) ? Math.max(0, Math.floor(charStartRaw)) : 0;
      const charEnd =
        typeof charEndRaw === "number" && Number.isFinite(charEndRaw)
          ? Math.max(charStart, Math.floor(charEndRaw))
          : charStart;
      const boundedEnd = Math.min(charEnd, title.length);
      const boundedStart = Math.min(charStart, boundedEnd);
      const snippet =
        typeof snippetRaw === "string" && snippetRaw.trim()
          ? snippetRaw.trim()
          : title.slice(boundedStart, Math.max(boundedStart, boundedEnd));

      return {
        charStart: boundedStart,
        charEnd: boundedEnd,
        snippet
      } satisfies LlmEvidenceSpan;
    })
    .filter((span): span is LlmEvidenceSpan => span !== null);
}

function normalizeScoredLabels<TLabel extends string>(input: {
  raw: unknown;
  allowedLabels: readonly TLabel[];
  title: string;
}): Array<LlmLabelScore<TLabel>> {
  if (!Array.isArray(input.raw)) {
    return [];
  }

  const allowedLabelSet = new Set(input.allowedLabels);

  return input.raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const labelRaw = (item as { label?: unknown }).label;
      if (typeof labelRaw !== "string" || !allowedLabelSet.has(labelRaw as TLabel)) {
        return null;
      }

      const scoreRaw = (item as { score?: unknown }).score;
      const confidenceRaw = (item as { confidence?: unknown }).confidence;

      return {
        label: labelRaw as TLabel,
        score: clampRatio(typeof scoreRaw === "number" ? scoreRaw : 0),
        confidence: clampRatio(typeof confidenceRaw === "number" ? confidenceRaw : 0),
        evidence: normalizeEvidenceSpans((item as { evidence?: unknown }).evidence, input.title)
      } satisfies LlmLabelScore<TLabel>;
    })
    .filter((entry): entry is LlmLabelScore<TLabel> => entry !== null)
    .sort((a, b) => b.score - a.score);
}

function normalizeHeadlineClaimStrength(raw: unknown, title: string): TitleLlmResultV1["headline_claim_strength"] {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const labelRaw = (raw as { label?: unknown }).label;
  if (typeof labelRaw !== "string" || !CLAIM_STRENGTH_LABELS.includes(labelRaw as HeadlineClaimStrength)) {
    return null;
  }

  const confidenceRaw = (raw as { confidence?: unknown }).confidence;
  return {
    label: labelRaw as HeadlineClaimStrength,
    confidence: clampRatio(typeof confidenceRaw === "number" ? confidenceRaw : 0),
    evidence: normalizeEvidenceSpans((raw as { evidence?: unknown }).evidence, title)
  };
}

function normalizeTitleLlmResult(raw: unknown, title: string): TitleLlmResultV1 {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  return {
    schemaVersion: "derived.title_llm.v1",
    promise_type: normalizeScoredLabels({
      raw: source.promise_type,
      allowedLabels: PROMISE_TYPE_LABELS,
      title
    }),
    curiosity_gap_type: normalizeScoredLabels({
      raw: source.curiosity_gap_type,
      allowedLabels: CURIOSITY_GAP_LABELS,
      title
    }),
    headline_claim_strength: normalizeHeadlineClaimStrength(source.headline_claim_strength, title)
  };
}

export async function callAutoGenTitleClassifier(input: {
  videoId: string;
  title: string;
  languageHint?: "auto" | "en" | "es";
}): Promise<{ value: TitleLlmResultV1 | null; warnings: string[] }> {
  if (!env.autoGenEnabled) {
    return {
      value: null,
      warnings: ["AutoGen title classifier skipped: AUTO_GEN_ENABLED=false"]
    };
  }

  if (!env.openAiApiKey) {
    return {
      value: null,
      warnings: ["AutoGen title classifier skipped: OPENAI_API_KEY is not configured"]
    };
  }

  try {
    const result = await requestAutoGenTask({
      task: "title_classifier_v1",
      payload: {
        videoId: input.videoId,
        title: input.title,
        languageHint: input.languageHint ?? "auto"
      },
      provider: "openai",
      model: env.autoGenModelTitle,
      reasoningEffort: env.autoGenReasoningEffort
    });

    return {
      value: normalizeTitleLlmResult(result, input.title),
      warnings: []
    };
  } catch (error) {
    return {
      value: null,
      warnings: [
        `AutoGen title classifier failed for ${input.videoId}: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    };
  }
}

export function computeDeterministic(args: ComputeTitleDeterministicFeaturesArgs): DeterministicTitleFeatures {
  return computeTitleDeterministicFeatures(args);
}

export async function computeTitleFeaturesBundle(args: ComputeTitleFeaturesArgs): Promise<ComputeTitleFeaturesResult> {
  const warnings: string[] = [];
  const deterministic = computeDeterministic({
    title: args.title,
    transcript: args.transcript,
    transcriptSegments: args.transcriptSegments
  });

  const embeddingsResult = await maybeComputeEmbeddingsSimilarity(args.title, args.transcript ?? "");
  if (embeddingsResult.warnings.length > 0) {
    warnings.push(...embeddingsResult.warnings);
  }
  deterministic.title_transcript_sim_cosine = embeddingsResult.value;

  const llmResult = await callAutoGenTitleClassifier({
    videoId: args.videoId,
    title: args.title,
    languageHint: args.languageHint
  });
  if (llmResult.warnings.length > 0) {
    warnings.push(...llmResult.warnings);
  }

  return {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      titleFeatures: {
        deterministic,
        llm: llmResult.value
      }
    },
    warnings
  };
}

export async function persistTitleFeaturesArtifact(args: PersistTitleFeaturesArgs): Promise<PersistTitleFeaturesResult> {
  const result = await computeTitleFeaturesBundle(args);

  const derivedFolderPath = path.resolve(args.channelFolderPath, "derived", "video_features");
  const artifactAbsolutePath = path.resolve(derivedFolderPath, `${args.videoId}.json`);

  ensureInsideRoot(args.exportsRoot, derivedFolderPath);
  ensureInsideRoot(args.exportsRoot, artifactAbsolutePath);

  await fs.mkdir(derivedFolderPath, { recursive: true });
  await fs.writeFile(artifactAbsolutePath, `${JSON.stringify(result.bundle, null, 2)}\n`, "utf-8");

  return {
    ...result,
    artifactAbsolutePath,
    artifactRelativePath: toSafeRelativePath(args.channelFolderPath, artifactAbsolutePath)
  };
}
