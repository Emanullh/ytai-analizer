import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { requestAutoGenTask } from "../services/autogenRuntime.js";
import {
  computeDescriptionDeterministicFeatures,
  type ComputeDescriptionDeterministicFeaturesArgs,
  type DescriptionDeterministicEvidence,
  type DescriptionDeterministicFeatures,
  type UrlWithSpan
} from "./descriptionDeterministic.js";

const LINK_PURPOSE_LABELS = [
  "sponsor",
  "affiliate",
  "sources",
  "social",
  "merch",
  "newsletter",
  "community",
  "other"
] as const;

const PRIMARY_CTA_LABELS = ["subscribe", "like", "comment", "link", "follow", "none"] as const;

type LinkPurposeLabel = (typeof LINK_PURPOSE_LABELS)[number];
type PrimaryCtaLabel = (typeof PRIMARY_CTA_LABELS)[number];

export interface LlmEvidenceSpan {
  charStart: number;
  charEnd: number;
  snippet: string;
}

export interface DescriptionLlmResultV1 {
  schemaVersion: "derived.description_llm.v1";
  linkPurpose: Array<{
    url: string;
    label: LinkPurposeLabel;
    confidence: number;
    evidence: LlmEvidenceSpan;
  }>;
  sponsorBrandMentions: Array<{
    brand: string;
    confidence: number;
    evidence: LlmEvidenceSpan[];
  }>;
  primaryCTA: {
    label: PrimaryCtaLabel;
    confidence: number;
    evidence: LlmEvidenceSpan[];
  } | null;
}

export interface DescriptionFeaturesSection {
  deterministic: DescriptionDeterministicFeatures & {
    evidence: DescriptionDeterministicEvidence;
  };
  llm: DescriptionLlmResultV1 | null;
  warnings: string[];
}

export interface DescriptionFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  descriptionFeatures: DescriptionFeaturesSection;
}

export interface DerivedVideoFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  titleFeatures?: unknown;
  descriptionFeatures?: DescriptionFeaturesSection;
  [key: string]: unknown;
}

export interface ComputeDescriptionFeaturesArgs {
  videoId: string;
  title: string;
  description: string;
  languageHint?: "auto" | "en" | "es";
}

export interface ComputeDescriptionFeaturesResult {
  bundle: DescriptionFeaturesArtifactV1;
  warnings: string[];
}

export interface PersistDescriptionFeaturesArgs extends ComputeDescriptionFeaturesArgs {
  exportsRoot: string;
  channelFolderPath: string;
  compute?: {
    deterministic?: boolean;
    llm?: boolean;
  };
}

export interface PersistDescriptionFeaturesResult extends ComputeDescriptionFeaturesResult {
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

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function normalizeEvidenceSpan(raw: unknown, sourceText: string): LlmEvidenceSpan {
  const fallback: LlmEvidenceSpan = { charStart: 0, charEnd: 0, snippet: "" };
  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const charStartRaw = (raw as { charStart?: unknown }).charStart;
  const charEndRaw = (raw as { charEnd?: unknown }).charEnd;
  const snippetRaw = (raw as { snippet?: unknown }).snippet;

  const charStart = typeof charStartRaw === "number" && Number.isFinite(charStartRaw) ? Math.max(0, Math.floor(charStartRaw)) : 0;
  const charEnd =
    typeof charEndRaw === "number" && Number.isFinite(charEndRaw) ? Math.max(charStart, Math.floor(charEndRaw)) : charStart;

  const boundedStart = Math.min(charStart, sourceText.length);
  const boundedEnd = Math.min(Math.max(boundedStart, charEnd), sourceText.length);

  return {
    charStart: boundedStart,
    charEnd: boundedEnd,
    snippet:
      typeof snippetRaw === "string" && snippetRaw.trim()
        ? snippetRaw.trim()
        : sourceText.slice(boundedStart, boundedEnd)
  };
}

function normalizeEvidenceSpans(raw: unknown, sourceText: string): LlmEvidenceSpan[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => normalizeEvidenceSpan(item, sourceText))
    .filter((item) => item.charEnd >= item.charStart);
}

function normalizeDescriptionLlmResult(raw: unknown, description: string): DescriptionLlmResultV1 {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const linkPurposeRaw = Array.isArray(source.linkPurpose) ? source.linkPurpose : [];
  const sponsorBrandMentionsRaw = Array.isArray(source.sponsorBrandMentions) ? source.sponsorBrandMentions : [];

  const allowedLinkPurpose = new Set<LinkPurposeLabel>(LINK_PURPOSE_LABELS);
  const allowedPrimaryCta = new Set<PrimaryCtaLabel>(PRIMARY_CTA_LABELS);

  const linkPurpose = linkPurposeRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const urlRaw = (item as { url?: unknown }).url;
      const labelRaw = (item as { label?: unknown }).label;
      if (typeof urlRaw !== "string" || !urlRaw.trim() || typeof labelRaw !== "string" || !allowedLinkPurpose.has(labelRaw as LinkPurposeLabel)) {
        return null;
      }

      const confidenceRaw = (item as { confidence?: unknown }).confidence;
      return {
        url: urlRaw.trim(),
        label: labelRaw as LinkPurposeLabel,
        confidence: clampRatio(typeof confidenceRaw === "number" ? confidenceRaw : 0),
        evidence: normalizeEvidenceSpan((item as { evidence?: unknown }).evidence, description)
      };
    })
    .filter((entry): entry is DescriptionLlmResultV1["linkPurpose"][number] => entry !== null);

  const sponsorBrandMentions = sponsorBrandMentionsRaw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const brandRaw = (item as { brand?: unknown }).brand;
      if (typeof brandRaw !== "string" || !brandRaw.trim()) {
        return null;
      }

      const confidenceRaw = (item as { confidence?: unknown }).confidence;
      return {
        brand: brandRaw.trim(),
        confidence: clampRatio(typeof confidenceRaw === "number" ? confidenceRaw : 0),
        evidence: normalizeEvidenceSpans((item as { evidence?: unknown }).evidence, description)
      };
    })
    .filter((entry): entry is DescriptionLlmResultV1["sponsorBrandMentions"][number] => entry !== null);

  let primaryCTA: DescriptionLlmResultV1["primaryCTA"] = null;
  if (source.primaryCTA && typeof source.primaryCTA === "object") {
    const primary = source.primaryCTA as Record<string, unknown>;
    const labelRaw = primary.label;
    if (typeof labelRaw === "string" && allowedPrimaryCta.has(labelRaw as PrimaryCtaLabel)) {
      primaryCTA = {
        label: labelRaw as PrimaryCtaLabel,
        confidence: clampRatio(typeof primary.confidence === "number" ? primary.confidence : 0),
        evidence: normalizeEvidenceSpans(primary.evidence, description)
      };
    }
  }

  return {
    schemaVersion: "derived.description_llm.v1",
    linkPurpose,
    sponsorBrandMentions,
    primaryCTA
  };
}

async function callAutoGenDescriptionClassifier(input: {
  videoId: string;
  title: string;
  description: string;
  urlsWithSpans: UrlWithSpan[];
  languageHint: "auto" | "en" | "es";
}): Promise<{ value: DescriptionLlmResultV1 | null; warnings: string[] }> {
  if (!env.autoGenEnabled) {
    return {
      value: null,
      warnings: ["AutoGen description classifier skipped: AUTO_GEN_ENABLED=false"]
    };
  }

  if (!env.openAiApiKey) {
    return {
      value: null,
      warnings: ["AutoGen description classifier skipped: OPENAI_API_KEY is not configured"]
    };
  }

  try {
    const raw = await requestAutoGenTask({
      task: "description_classifier_v1",
      payload: {
        videoId: input.videoId,
        title: input.title,
        description: input.description,
        urlsWithSpans: input.urlsWithSpans.slice(0, 10),
        languageHint: input.languageHint
      },
      provider: "openai",
      model: env.autoGenModelDescription,
      reasoningEffort: env.autoGenReasoningEffort
    });

    return {
      value: normalizeDescriptionLlmResult(raw, input.description),
      warnings: []
    };
  } catch (error) {
    return {
      value: null,
      warnings: [
        `AutoGen description classifier failed for ${input.videoId}: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    };
  }
}

export function computeDeterministic(
  args: ComputeDescriptionDeterministicFeaturesArgs
): ReturnType<typeof computeDescriptionDeterministicFeatures> {
  return computeDescriptionDeterministicFeatures(args);
}

export async function computeDescriptionFeaturesBundle(
  args: ComputeDescriptionFeaturesArgs
): Promise<ComputeDescriptionFeaturesResult> {
  const deterministicResult = computeDeterministic({
    title: args.title,
    description: args.description
  });

  const warnings = [...deterministicResult.warnings];

  const llmResult = await callAutoGenDescriptionClassifier({
    videoId: args.videoId,
    title: args.title,
    description: args.description,
    urlsWithSpans: deterministicResult.features.urls,
    languageHint: args.languageHint ?? "auto"
  });

  warnings.push(...llmResult.warnings);

  return {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      descriptionFeatures: {
        deterministic: {
          ...deterministicResult.features,
          evidence: deterministicResult.evidence
        },
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
  args: ComputeDescriptionFeaturesArgs,
  bundle: DescriptionFeaturesArtifactV1,
  existing: Record<string, unknown> | null
): DerivedVideoFeaturesArtifactV1 {
  const base = existing ?? {};

  return {
    ...base,
    schemaVersion: "derived.video_features.v1",
    videoId: args.videoId,
    computedAt: bundle.computedAt,
    descriptionFeatures: bundle.descriptionFeatures
  };
}

export async function persistDescriptionFeaturesArtifact(
  args: PersistDescriptionFeaturesArgs
): Promise<PersistDescriptionFeaturesResult> {
  const derivedFolderPath = path.resolve(args.channelFolderPath, "derived", "video_features");
  const artifactAbsolutePath = path.resolve(derivedFolderPath, `${args.videoId}.json`);

  ensureInsideRoot(args.exportsRoot, derivedFolderPath);
  ensureInsideRoot(args.exportsRoot, artifactAbsolutePath);

  await fs.mkdir(derivedFolderPath, { recursive: true });
  const existing = await readExistingArtifact(artifactAbsolutePath);
  const existingSection = readExistingDescriptionSection(existing);
  const requestedDeterministic = args.compute?.deterministic ?? true;
  const requestedLlm = args.compute?.llm ?? true;

  const shouldComputeDeterministic = requestedDeterministic || !existingSection?.deterministic;
  const deterministicResult = shouldComputeDeterministic
    ? computeDeterministic({
        title: args.title,
        description: args.description
      })
    : null;

  let deterministic =
    deterministicResult !== null
      ? {
          ...deterministicResult.features,
          evidence: deterministicResult.evidence
        }
      : existingSection?.deterministic ?? null;

  let llm = existingSection?.llm ?? null;
  const warnings: string[] = [...(deterministicResult?.warnings ?? []), ...(existingSection?.warnings ?? [])];
  if (!deterministic) {
    const fallbackDeterministic = computeDeterministic({
      title: args.title,
      description: args.description
    });
    deterministic = {
      ...fallbackDeterministic.features,
      evidence: fallbackDeterministic.evidence
    };
    warnings.push(...fallbackDeterministic.warnings);
  }
  if (requestedLlm) {
    const urlsWithSpans = Array.isArray(deterministic.urls) ? (deterministic.urls as UrlWithSpan[]) : [];
    const llmResult = await callAutoGenDescriptionClassifier({
      videoId: args.videoId,
      title: args.title,
      description: args.description,
      urlsWithSpans,
      languageHint: args.languageHint ?? "auto"
    });
    llm = llmResult.value;
    warnings.push(...llmResult.warnings);
  }

  const result: ComputeDescriptionFeaturesResult = {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      descriptionFeatures: {
        deterministic,
        llm,
        warnings
      }
    },
    warnings
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

function readExistingDescriptionSection(existing: Record<string, unknown> | null): DescriptionFeaturesSection | null {
  if (!existing || typeof existing !== "object") {
    return null;
  }
  if (
    !existing.descriptionFeatures ||
    typeof existing.descriptionFeatures !== "object" ||
    Array.isArray(existing.descriptionFeatures)
  ) {
    return null;
  }
  return existing.descriptionFeatures as DescriptionFeaturesSection;
}
