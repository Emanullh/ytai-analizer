import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { requestAutoGenTask } from "../services/autogenRuntime.js";
import {
  computeTranscriptDeterministicFeatures,
  type ComputeTranscriptDeterministicFeaturesArgs,
  type TranscriptDeterministicFeatures
} from "./transcriptDeterministic.js";
import {
  loadTranscriptJsonl,
  type TranscriptArtifact,
  type TranscriptArtifactSegment
} from "./transcriptArtifacts.js";

const STORY_ARC_LABELS = [
  "problem-solution",
  "listicle",
  "timeline",
  "explainer",
  "debate",
  "investigation",
  "tutorial",
  "other"
] as const;

const CTA_TYPES = ["subscribe", "like", "comment", "link", "follow", "none"] as const;

type StoryArcLabel = (typeof STORY_ARC_LABELS)[number];
type CtaType = (typeof CTA_TYPES)[number];

interface TranscriptSampleSegment {
  segmentIndex: number;
  startSec: number | null;
  endSec: number | null;
  text: string;
}

interface LlmEvidenceSegment {
  segmentIndex: number;
  snippet: string;
}

export interface TranscriptLlmResultV1 {
  schemaVersion: "derived.transcript_llm.v1";
  story_arc: {
    label: StoryArcLabel;
    confidence: number;
    evidenceSegments: LlmEvidenceSegment[];
  } | null;
  sponsor_segments: Array<{
    startSec: number | null;
    endSec: number | null;
    brand: string;
    confidence: number;
    evidenceSegments: LlmEvidenceSegment[];
  }>;
  cta_segments: Array<{
    type: CtaType;
    confidence: number;
    evidenceSegments: LlmEvidenceSegment[];
  }>;
}

export interface TranscriptFeaturesSection {
  deterministic: TranscriptDeterministicFeatures;
  llm: TranscriptLlmResultV1 | null;
  warnings: string[];
}

export interface TranscriptFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  transcriptFeatures: TranscriptFeaturesSection;
}

export interface DerivedVideoFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  titleFeatures?: unknown;
  descriptionFeatures?: unknown;
  transcriptFeatures?: TranscriptFeaturesSection;
  [key: string]: unknown;
}

export interface ComputeTranscriptFeaturesArgs {
  videoId: string;
  title: string;
  transcript?: string;
  transcriptArtifactPath?: string;
  durationSec?: number;
  publishedAt?: string;
  nowISO?: string;
  languageHint?: "auto" | "en" | "es";
}

export interface PersistTranscriptFeaturesArgs extends ComputeTranscriptFeaturesArgs {
  exportsRoot: string;
  channelFolderPath: string;
  compute?: {
    deterministic?: boolean;
    llm?: boolean;
  };
  trace?: {
    onAutoGenWorkerRequestId?: (workerRequestId: string) => void;
  };
}

export interface ComputeTranscriptFeaturesResult {
  bundle: TranscriptFeaturesArtifactV1;
  warnings: string[];
}

export interface PersistTranscriptFeaturesResult extends ComputeTranscriptFeaturesResult {
  artifactAbsolutePath: string;
  artifactRelativePath: string;
  mergedBundle: DerivedVideoFeaturesArtifactV1;
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid export path for derived artifact");
  }
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

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function normalizeSegmentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.filter((warning) => warning.trim().length > 0)));
}

function normalizeSegmentsForSampling(artifact: TranscriptArtifact): TranscriptArtifactSegment[] {
  return [...artifact.segments]
    .map((segment, index) => ({
      ...segment,
      i: typeof segment.i === "number" && Number.isFinite(segment.i) ? segment.i : index,
      text: typeof segment.text === "string" ? segment.text.trim() : ""
    }))
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.i - b.i);
}

function buildSampleIndices(total: number): number[] {
  if (total <= 0) {
    return [];
  }

  const indices = new Set<number>();
  const firstEnd = Math.min(20, total);
  for (let i = 0; i < firstEnd; i += 1) {
    indices.add(i);
  }

  const lastStart = Math.max(0, total - 10);
  for (let i = lastStart; i < total; i += 1) {
    indices.add(i);
  }

  const remaining = Array.from({ length: total }, (_, i) => i).filter((i) => !indices.has(i));
  if (remaining.length <= 5) {
    for (const index of remaining) {
      indices.add(index);
    }
  } else {
    const middleStart = Math.floor((remaining.length - 5) / 2);
    for (const index of remaining.slice(middleStart, middleStart + 5)) {
      indices.add(index);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

function buildCandidateSegments(
  segments: TranscriptArtifactSegment[],
  matcher: RegExp,
  maxItems: number
): TranscriptSampleSegment[] {
  const candidates: TranscriptSampleSegment[] = [];

  for (const segment of segments) {
    if (candidates.length >= maxItems) {
      break;
    }

    matcher.lastIndex = 0;
    if (!matcher.test(segment.text)) {
      continue;
    }

    candidates.push({
      segmentIndex: segment.i,
      startSec: toFiniteNumber(segment.startSec),
      endSec: toFiniteNumber(segment.endSec),
      text: truncate(normalizeSegmentText(segment.text), 240)
    });
  }

  return candidates;
}

export function buildLLMPayloadSample(args: {
  videoId: string;
  title: string;
  languageHint?: "auto" | "en" | "es";
  transcriptArtifact: TranscriptArtifact;
}): {
  videoId: string;
  title: string;
  languageHint: "auto" | "en" | "es";
  segmentsSample: TranscriptSampleSegment[];
  candidateSponsorSegments: TranscriptSampleSegment[];
  candidateCTASegments: TranscriptSampleSegment[];
} {
  const normalizedSegments = normalizeSegmentsForSampling(args.transcriptArtifact);
  const sampleIndices = buildSampleIndices(normalizedSegments.length);

  const segmentsSample = sampleIndices.map((sampleIndex) => {
    const segment = normalizedSegments[sampleIndex];
    return {
      segmentIndex: segment.i,
      startSec: toFiniteNumber(segment.startSec),
      endSec: toFiniteNumber(segment.endSec),
      text: truncate(normalizeSegmentText(segment.text), 240)
    };
  });

  const candidateSponsorSegments = buildCandidateSegments(
    normalizedSegments,
    /\b(sponsor|sponsored|brought to you by|patrocinad[oa]|patrocinio)\b/giu,
    20
  );

  const candidateCTASegments = buildCandidateSegments(
    normalizedSegments,
    /\b(subscribe|like|comment|follow|suscrib|me gusta|comenta|seguir|link in bio|enlace)\b/giu,
    20
  );

  return {
    videoId: args.videoId,
    title: args.title,
    languageHint: args.languageHint ?? "auto",
    segmentsSample,
    candidateSponsorSegments,
    candidateCTASegments
  };
}

function normalizeEvidenceSegments(
  raw: unknown,
  sampleBySegmentIndex: Map<number, TranscriptSampleSegment>,
  warnings: string[],
  contextLabel: string
): LlmEvidenceSegment[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: LlmEvidenceSegment[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const source = entry as Record<string, unknown>;
    const segmentIndexRaw = source.segmentIndex;
    const snippetRaw = source.snippet;

    if (typeof segmentIndexRaw !== "number" || !Number.isFinite(segmentIndexRaw)) {
      warnings.push(`Discarded ${contextLabel} evidence: invalid segmentIndex`);
      continue;
    }

    const segmentIndex = Math.floor(segmentIndexRaw);
    const sampleSegment = sampleBySegmentIndex.get(segmentIndex);
    if (!sampleSegment) {
      warnings.push(`Discarded ${contextLabel} evidence: segmentIndex ${segmentIndex} not present in sample`);
      continue;
    }

    const snippet = typeof snippetRaw === "string" ? snippetRaw.trim() : "";
    if (!snippet) {
      warnings.push(`Discarded ${contextLabel} evidence: empty snippet for segmentIndex ${segmentIndex}`);
      continue;
    }

    if (!sampleSegment.text.includes(snippet)) {
      warnings.push(
        `Discarded ${contextLabel} evidence: snippet is not a substring of sampled segment ${segmentIndex}`
      );
      continue;
    }

    normalized.push({
      segmentIndex,
      snippet
    });
  }

  return normalized;
}

function normalizeTranscriptLlmResult(
  raw: unknown,
  sampleSegments: TranscriptSampleSegment[]
): { value: TranscriptLlmResultV1; warnings: string[] } {
  const warnings: string[] = [];
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const sampleBySegmentIndex = new Map(sampleSegments.map((segment) => [segment.segmentIndex, segment]));

  let storyArc: TranscriptLlmResultV1["story_arc"] = null;
  const storyArcRaw = source.story_arc;
  if (storyArcRaw && typeof storyArcRaw === "object") {
    const storyObject = storyArcRaw as Record<string, unknown>;
    const labelRaw = storyObject.label;
    if (typeof labelRaw === "string" && STORY_ARC_LABELS.includes(labelRaw as StoryArcLabel)) {
      storyArc = {
        label: labelRaw as StoryArcLabel,
        confidence: clamp01(typeof storyObject.confidence === "number" ? storyObject.confidence : 0),
        evidenceSegments: normalizeEvidenceSegments(
          storyObject.evidenceSegments,
          sampleBySegmentIndex,
          warnings,
          "story_arc"
        )
      };
    } else {
      warnings.push("Discarded story_arc: invalid label");
    }
  }

  const sponsorSegmentsRaw = Array.isArray(source.sponsor_segments) ? source.sponsor_segments : [];
  const sponsorSegments: TranscriptLlmResultV1["sponsor_segments"] = [];

  for (const item of sponsorSegmentsRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const brand = typeof entry.brand === "string" ? entry.brand.trim() : "";
    if (!brand) {
      warnings.push("Discarded sponsor entry: brand is required");
      continue;
    }

    const evidenceSegments = normalizeEvidenceSegments(
      entry.evidenceSegments,
      sampleBySegmentIndex,
      warnings,
      `sponsor_segments(${brand})`
    );

    if (evidenceSegments.length === 0) {
      warnings.push(`Discarded sponsor entry '${brand}': no valid evidence segments`);
      continue;
    }

    const hasBrandInSnippet = evidenceSegments.some((evidence) =>
      evidence.snippet.toLowerCase().includes(brand.toLowerCase())
    );

    if (!hasBrandInSnippet) {
      warnings.push(`Discarded sponsor entry '${brand}': brand does not appear in evidence snippets`);
      continue;
    }

    sponsorSegments.push({
      startSec: toFiniteNumber(entry.startSec),
      endSec: toFiniteNumber(entry.endSec),
      brand,
      confidence: clamp01(typeof entry.confidence === "number" ? entry.confidence : 0),
      evidenceSegments
    });
  }

  const ctaSegmentsRaw = Array.isArray(source.cta_segments) ? source.cta_segments : [];
  const ctaSegments: TranscriptLlmResultV1["cta_segments"] = [];

  for (const item of ctaSegmentsRaw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const entry = item as Record<string, unknown>;
    const typeRaw = entry.type;
    if (typeof typeRaw !== "string" || !CTA_TYPES.includes(typeRaw as CtaType)) {
      warnings.push("Discarded cta segment: invalid type");
      continue;
    }

    ctaSegments.push({
      type: typeRaw as CtaType,
      confidence: clamp01(typeof entry.confidence === "number" ? entry.confidence : 0),
      evidenceSegments: normalizeEvidenceSegments(
        entry.evidenceSegments,
        sampleBySegmentIndex,
        warnings,
        `cta_segments(${typeRaw})`
      )
    });
  }

  return {
    value: {
      schemaVersion: "derived.transcript_llm.v1",
      story_arc: storyArc,
      sponsor_segments: sponsorSegments,
      cta_segments: ctaSegments
    },
    warnings
  };
}

async function callAutoGenTranscriptClassifier(args: {
  videoId: string;
  title: string;
  languageHint?: "auto" | "en" | "es";
  transcriptArtifact: TranscriptArtifact;
  onAutoGenWorkerRequestId?: (workerRequestId: string) => void;
}): Promise<{ value: TranscriptLlmResultV1 | null; warnings: string[] }> {
  if (!env.autoGenEnabled) {
    return {
      value: null,
      warnings: ["AutoGen transcript classifier skipped: AUTO_GEN_ENABLED=false"]
    };
  }

  if (!env.openAiApiKey) {
    return {
      value: null,
      warnings: ["AutoGen transcript classifier skipped: OPENAI_API_KEY is not configured"]
    };
  }

  const payload = buildLLMPayloadSample({
    videoId: args.videoId,
    title: args.title,
    languageHint: args.languageHint,
    transcriptArtifact: args.transcriptArtifact
  });

  if (payload.segmentsSample.length === 0) {
    return {
      value: null,
      warnings: []
    };
  }

  try {
    const requestPayload = {
      task: "transcript_classifier_v1" as const,
      payload,
      provider: "openai" as const,
      model: env.autoGenModelDescription,
      reasoningEffort: env.autoGenReasoningEffort
    };
    const raw = args.onAutoGenWorkerRequestId
      ? await requestAutoGenTask(requestPayload, { onWorkerRequestId: args.onAutoGenWorkerRequestId })
      : await requestAutoGenTask(requestPayload);

    const normalized = normalizeTranscriptLlmResult(raw, payload.segmentsSample);
    return {
      value: normalized.value,
      warnings: normalized.warnings
    };
  } catch (error) {
    return {
      value: null,
      warnings: [
        `AutoGen transcript classifier failed for ${args.videoId}: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    };
  }
}

async function loadArtifactForFeatures(args: ComputeTranscriptFeaturesArgs): Promise<TranscriptArtifact> {
  if (args.transcriptArtifactPath) {
    return loadTranscriptJsonl(args.transcriptArtifactPath, {
      fallbackTranscript: args.transcript ?? "",
      videoId: args.videoId
    });
  }

  const fallbackText = args.transcript?.trim() ?? "";
  return {
    meta: {
      type: "meta",
      videoId: args.videoId,
      source: "none",
      status: fallbackText ? "ok" : "missing",
      language: "auto",
      model: null,
      computeType: null,
      createdAt: new Date().toISOString(),
      transcriptCleaned: false,
      warning: "No transcript artifact path provided; using in-memory transcript fallback"
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
    warnings: ["No transcript artifact path provided; using in-memory transcript fallback"],
    sourcePath: "<in-memory>",
    usedFallback: true
  };
}

export function computeDeterministic(
  args: ComputeTranscriptDeterministicFeaturesArgs
): ReturnType<typeof computeTranscriptDeterministicFeatures> {
  return computeTranscriptDeterministicFeatures(args);
}

export async function computeTranscriptFeaturesBundle(
  args: ComputeTranscriptFeaturesArgs
): Promise<ComputeTranscriptFeaturesResult> {
  const transcriptArtifact = await loadArtifactForFeatures(args);

  const deterministicResult = await computeDeterministic({
    title: args.title,
    transcriptArtifact,
    durationSec: args.durationSec,
    publishedAt: args.publishedAt,
    nowISO: args.nowISO
  });

  const llmResult = await callAutoGenTranscriptClassifier({
    videoId: args.videoId,
    title: args.title,
    languageHint: args.languageHint,
    transcriptArtifact
  });

  const warnings = dedupeWarnings([...deterministicResult.warnings, ...llmResult.warnings]);

  return {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      transcriptFeatures: {
        deterministic: deterministicResult.features,
        llm: llmResult.value,
        warnings
      }
    },
    warnings
  };
}

async function readExistingArtifact(artifactPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(artifactPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

function mergeBundle(
  args: ComputeTranscriptFeaturesArgs,
  bundle: TranscriptFeaturesArtifactV1,
  existing: Record<string, unknown> | null
): DerivedVideoFeaturesArtifactV1 {
  const base = existing ?? {};

  return {
    ...base,
    schemaVersion: "derived.video_features.v1",
    videoId: args.videoId,
    computedAt: bundle.computedAt,
    transcriptFeatures: bundle.transcriptFeatures
  };
}

export async function persistTranscriptFeaturesArtifact(
  args: PersistTranscriptFeaturesArgs
): Promise<PersistTranscriptFeaturesResult> {
  const derivedFolderPath = path.resolve(args.channelFolderPath, "derived", "video_features");
  const artifactAbsolutePath = path.resolve(derivedFolderPath, `${args.videoId}.json`);

  ensureInsideRoot(args.exportsRoot, derivedFolderPath);
  ensureInsideRoot(args.exportsRoot, artifactAbsolutePath);

  await fs.mkdir(derivedFolderPath, { recursive: true });
  const existing = await readExistingArtifact(artifactAbsolutePath);
  const existingSection = readExistingTranscriptSection(existing);
  const requestedDeterministic = args.compute?.deterministic ?? true;
  const requestedLlm = args.compute?.llm ?? true;
  const transcriptArtifact = await loadArtifactForFeatures(args);

  const shouldComputeDeterministic = requestedDeterministic || !existingSection?.deterministic;
  const deterministicResult = shouldComputeDeterministic
    ? await computeDeterministic({
        title: args.title,
        transcriptArtifact,
        durationSec: args.durationSec,
        publishedAt: args.publishedAt,
        nowISO: args.nowISO
      })
    : null;
  let deterministic = deterministicResult?.features ?? existingSection?.deterministic ?? null;
  const warnings = dedupeWarnings([...(deterministicResult?.warnings ?? []), ...(existingSection?.warnings ?? [])]);
  if (!deterministic) {
    const fallbackDeterministic = await computeDeterministic({
      title: args.title,
      transcriptArtifact,
      durationSec: args.durationSec,
      publishedAt: args.publishedAt,
      nowISO: args.nowISO
    });
    deterministic = fallbackDeterministic.features;
    warnings.push(...fallbackDeterministic.warnings);
  }

  let llm = existingSection?.llm ?? null;

  if (requestedLlm) {
    const llmResult = await callAutoGenTranscriptClassifier({
      videoId: args.videoId,
      title: args.title,
      languageHint: args.languageHint,
      transcriptArtifact,
      onAutoGenWorkerRequestId: args.trace?.onAutoGenWorkerRequestId
    });
    llm = llmResult.value;
    warnings.push(...llmResult.warnings);
  }

  const result: ComputeTranscriptFeaturesResult = {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      transcriptFeatures: {
        deterministic,
        llm,
        warnings: dedupeWarnings(warnings)
      }
    },
    warnings: dedupeWarnings(warnings)
  };

  const mergedBundle = mergeBundle(args, result.bundle, existing);
  await writeJsonAtomic(artifactAbsolutePath, mergedBundle);

  return {
    ...result,
    artifactAbsolutePath,
    artifactRelativePath: toSafeRelativePath(args.channelFolderPath, artifactAbsolutePath),
    mergedBundle
  };
}

function readExistingTranscriptSection(existing: Record<string, unknown> | null): TranscriptFeaturesSection | null {
  if (!existing || typeof existing !== "object") {
    return null;
  }
  if (
    !existing.transcriptFeatures ||
    typeof existing.transcriptFeatures !== "object" ||
    Array.isArray(existing.transcriptFeatures)
  ) {
    return null;
  }
  return existing.transcriptFeatures as TranscriptFeaturesSection;
}
