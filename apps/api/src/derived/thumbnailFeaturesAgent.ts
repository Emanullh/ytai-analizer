import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { env } from "../config/env.js";
import { requestAutoGenTask } from "../services/autogenRuntime.js";
import { runOcr, type OcrBox } from "./ocr/tesseractOcr.js";
import {
  computeBrightnessContrast,
  computeColorfulness,
  computeEdgeDensity,
  computeSharpnessLaplacianVar,
  decodeThumbnailToRgb
} from "./vision/imageStats.js";

const ARCHETYPE_LABELS = ["reaction", "diagram", "logo", "portrait", "screenshot", "text-heavy", "collage", "other"] as const;
const FACE_COUNT_BUCKETS = ["0", "1", "2", "3plus"] as const;
const FACE_POSITION_X = ["left", "center", "right", "unknown"] as const;
const FACE_POSITION_Y = ["top", "mid", "bottom", "unknown"] as const;
const FACE_EMOTION_TONES = ["positive", "negative", "neutral", "mixed", "unknown"] as const;
const CLUTTER_LEVELS = ["low", "medium", "high"] as const;
const STYLE_TAGS = [
  "high-contrast",
  "low-contrast",
  "colorful",
  "dark",
  "minimal",
  "cluttered",
  "clean",
  "big-text",
  "no-text",
  "face",
  "no-face",
  "logo-heavy",
  "screenshot-like",
  "diagram-like"
] as const;
const DETERMINISTIC_SIGNAL_FIELDS = new Set([
  "fileSizeBytes",
  "imageWidth",
  "imageHeight",
  "aspectRatio",
  "ocrConfidenceMean",
  "ocrCharCount",
  "ocrWordCount",
  "textAreaRatio",
  "brightnessMean",
  "contrastStd",
  "colorfulness",
  "sharpnessLaplacianVar",
  "edgeDensity",
  "thumb_ocr_title_overlap_jaccard",
  "hasBigText"
]);
const DETERMINISTIC_SIGNAL_PREFIXES = ["ocrSummary.", "imageStats.", "statsSummary.", "thumbMeta.", "deterministic."] as const;

type ArchetypeLabel = (typeof ARCHETYPE_LABELS)[number];
type FaceCountBucket = (typeof FACE_COUNT_BUCKETS)[number];
type FacePositionX = (typeof FACE_POSITION_X)[number];
type FacePositionY = (typeof FACE_POSITION_Y)[number];
type FaceEmotionTone = (typeof FACE_EMOTION_TONES)[number];
type ClutterLevel = (typeof CLUTTER_LEVELS)[number];
type StyleTag = (typeof STYLE_TAGS)[number];

export interface ThumbnailDeterministicFeatures {
  thumbnailLocalPath: string;
  fileSizeBytes: number;
  imageWidth: number;
  imageHeight: number;
  aspectRatio: number;
  ocrText: string;
  ocrConfidenceMean: number;
  ocrBoxes: OcrBox[];
  ocrCharCount: number;
  ocrWordCount: number;
  textAreaRatio: number;
  brightnessMean: number;
  contrastStd: number;
  colorfulness: number;
  sharpnessLaplacianVar: number;
  edgeDensity: number;
  thumb_ocr_title_overlap_jaccard: number;
  thumb_ocr_title_overlap_tokens: {
    titleTokens: string[];
    ocrTokens: string[];
    overlapTokens: string[];
  };
  hasBigText: boolean;
}

export interface ThumbnailEvidenceRegion {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ThumbnailEvidenceSignal {
  fieldName: string;
  value: number | string | boolean | null;
}

export interface ThumbnailLlmResultV1 {
  schemaVersion: "derived.thumbnail_llm.v1";
  archetype: {
    label: ArchetypeLabel;
    confidence: number;
  };
  faceSignals: {
    faceCountBucket: FaceCountBucket;
    dominantFacePosition: {
      x: FacePositionX;
      y: FacePositionY;
    };
    faceEmotionTone: FaceEmotionTone;
    hasEyeContact: boolean | "unknown";
    confidence: number;
  };
  clutterLevel: {
    label: ClutterLevel;
    confidence: number;
  };
  styleTags: Array<{
    label: StyleTag;
    confidence: number;
  }>;
  evidenceRegions: ThumbnailEvidenceRegion[];
  evidenceSignals: ThumbnailEvidenceSignal[];
}

export interface ThumbnailFeaturesSection {
  deterministic: ThumbnailDeterministicFeatures;
  llm: ThumbnailLlmResultV1 | null;
  warnings: string[];
}

export interface ThumbnailFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  thumbnailFeatures: ThumbnailFeaturesSection;
}

export interface DerivedVideoFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  titleFeatures?: unknown;
  descriptionFeatures?: unknown;
  transcriptFeatures?: unknown;
  thumbnailFeatures?: ThumbnailFeaturesSection;
  [key: string]: unknown;
}

export interface ComputeThumbnailFeaturesArgs {
  videoId: string;
  title: string;
  thumbnailAbsPath: string;
  thumbnailLocalPath: string;
}

export interface PersistThumbnailFeaturesArgs extends ComputeThumbnailFeaturesArgs {
  exportsRoot: string;
  channelFolderPath: string;
  compute?: {
    deterministic?: boolean;
    deterministicMode?: "full" | "ocr_only";
    llm?: boolean;
  };
  trace?: {
    onAutoGenWorkerRequestId?: (workerRequestId: string) => void;
  };
}

export interface ComputeThumbnailFeaturesResult {
  bundle: ThumbnailFeaturesArtifactV1;
  warnings: string[];
}

export interface PersistThumbnailFeaturesResult extends ComputeThumbnailFeaturesResult {
  artifactAbsolutePath: string;
  artifactRelativePath: string;
  mergedBundle: DerivedVideoFeaturesArtifactV1;
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

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.map((warning) => warning.trim()).filter(Boolean)));
}

function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function tokenize(input: string): string[] {
  if (!input.trim()) {
    return [];
  }

  const seen = new Set<string>();
  for (const token of input.split(/\s+/g)) {
    const normalized = normalizeToken(token);
    if (!normalized) {
      continue;
    }
    seen.add(normalized);
  }

  return Array.from(seen);
}

function countWords(input: string): number {
  return input
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean).length;
}

function toFinitePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function clampBboxComponent(value: number): number {
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

export function computeTextAreaRatio(
  boxes: Array<Pick<OcrBox, "x" | "y" | "w" | "h">>,
  imageWidth: number,
  imageHeight: number
): number {
  const area = Math.max(0, imageWidth) * Math.max(0, imageHeight);
  if (area <= 0 || boxes.length === 0) {
    return 0;
  }

  const boxesArea = boxes.reduce((acc, box) => {
    const w = Math.max(0, box.w);
    const h = Math.max(0, box.h);
    return acc + w * h;
  }, 0);

  return clamp01(boxesArea / area);
}

export function limitOcrBoxes(boxes: OcrBox[], maxItems = 50): OcrBox[] {
  if (maxItems <= 0 || boxes.length === 0) {
    return [];
  }

  return [...boxes]
    .sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      return b.w * b.h - a.w * a.h;
    })
    .slice(0, maxItems)
    .map((box) => ({ ...box }));
}

export function computeTitleOcrOverlap(
  title: string,
  ocrText: string
): ThumbnailDeterministicFeatures["thumb_ocr_title_overlap_tokens"] & { jaccard: number } {
  const titleTokens = tokenize(title);
  const ocrTokens = tokenize(ocrText);

  const titleSet = new Set(titleTokens);
  const ocrSet = new Set(ocrTokens);

  const overlapTokens = titleTokens.filter((token) => ocrSet.has(token));
  const unionSize = new Set([...titleSet, ...ocrSet]).size;

  return {
    titleTokens,
    ocrTokens,
    overlapTokens,
    jaccard: unionSize > 0 ? clamp01(overlapTokens.length / unionSize) : 0
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

export async function computeDeterministic(args: {
  title: string;
  thumbnailAbsPath: string;
  thumbnailLocalPath: string;
}): Promise<{ value: ThumbnailDeterministicFeatures; warnings: string[] }> {
  const warnings: string[] = [];

  const base: ThumbnailDeterministicFeatures = {
    thumbnailLocalPath: args.thumbnailLocalPath,
    fileSizeBytes: 0,
    imageWidth: 0,
    imageHeight: 0,
    aspectRatio: 0,
    ocrText: "",
    ocrConfidenceMean: 0,
    ocrBoxes: [],
    ocrCharCount: 0,
    ocrWordCount: 0,
    textAreaRatio: 0,
    brightnessMean: 0,
    contrastStd: 0,
    colorfulness: 0,
    sharpnessLaplacianVar: 0,
    edgeDensity: 0,
    thumb_ocr_title_overlap_jaccard: 0,
    thumb_ocr_title_overlap_tokens: {
      titleTokens: tokenize(args.title),
      ocrTokens: [],
      overlapTokens: []
    },
    hasBigText: false
  };

  try {
    const stat = await fs.stat(args.thumbnailAbsPath);
    base.fileSizeBytes = toFinitePositiveInt(stat.size);
  } catch (error) {
    warnings.push(
      `Thumbnail deterministic stats failed: cannot access file ${args.thumbnailAbsPath} (${error instanceof Error ? error.message : "unknown error"})`
    );
    return { value: base, warnings };
  }

  try {
    const metadata = await sharp(args.thumbnailAbsPath).metadata();
    base.imageWidth = toFinitePositiveInt(metadata.width);
    base.imageHeight = toFinitePositiveInt(metadata.height);
    base.aspectRatio =
      base.imageWidth > 0 && base.imageHeight > 0 ? Number((base.imageWidth / base.imageHeight).toFixed(6)) : 0;
  } catch (error) {
    warnings.push(
      `Thumbnail metadata extraction failed for ${args.thumbnailAbsPath}: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  try {
    const { width, height, rgbBuffer } = await decodeThumbnailToRgb(args.thumbnailAbsPath);
    const brightnessContrast = computeBrightnessContrast(rgbBuffer);
    base.brightnessMean = brightnessContrast.brightnessMean;
    base.contrastStd = brightnessContrast.contrastStd;
    base.colorfulness = computeColorfulness(rgbBuffer);
    base.sharpnessLaplacianVar = computeSharpnessLaplacianVar(rgbBuffer, width, height);
    base.edgeDensity = computeEdgeDensity(rgbBuffer, width, height);
  } catch (error) {
    warnings.push(
      `Thumbnail visual stats failed for ${args.thumbnailAbsPath}: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }

  if (env.thumbOcrEnabled) {
    try {
      const ocr = await runOcr(args.thumbnailAbsPath);
      base.ocrText = ocr.text;
      base.ocrConfidenceMean = clamp01(ocr.confidenceMean);
      base.ocrBoxes = limitOcrBoxes(ocr.boxes, 50);
      base.ocrCharCount = ocr.text.length;
      base.ocrWordCount = countWords(ocr.text);
      base.textAreaRatio = computeTextAreaRatio(ocr.boxes, base.imageWidth, base.imageHeight);
    } catch (error) {
      warnings.push(
        `Thumbnail OCR failed for ${args.thumbnailAbsPath}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  } else {
    warnings.push("Thumbnail OCR skipped: THUMB_OCR_ENABLED=false");
  }

  const overlap = computeTitleOcrOverlap(args.title, base.ocrText);
  base.thumb_ocr_title_overlap_tokens = {
    titleTokens: overlap.titleTokens,
    ocrTokens: overlap.ocrTokens,
    overlapTokens: overlap.overlapTokens
  };
  base.thumb_ocr_title_overlap_jaccard = overlap.jaccard;
  base.hasBigText = base.textAreaRatio >= 0.08 || base.ocrWordCount >= 3;

  return {
    value: base,
    warnings
  };
}

async function computeDeterministicOcrOnly(args: {
  title: string;
  thumbnailAbsPath: string;
  thumbnailLocalPath: string;
  existing: ThumbnailDeterministicFeatures;
}): Promise<{ value: ThumbnailDeterministicFeatures; warnings: string[] }> {
  const warnings: string[] = [];
  const next: ThumbnailDeterministicFeatures = {
    ...args.existing,
    thumbnailLocalPath: args.thumbnailLocalPath
  };

  if (env.thumbOcrEnabled) {
    try {
      const ocr = await runOcr(args.thumbnailAbsPath);
      const limitedBoxes = limitOcrBoxes(ocr.boxes, 50);
      const ocrText = ocr.text.trim();
      next.ocrText = ocrText;
      next.ocrBoxes = limitedBoxes;
      next.ocrConfidenceMean = clamp01(ocr.confidenceMean);
      next.ocrCharCount = ocrText.length;
      next.ocrWordCount = countWords(ocrText);
      next.textAreaRatio = computeTextAreaRatio(limitedBoxes, next.imageWidth, next.imageHeight);
    } catch (error) {
      warnings.push(
        `Thumbnail OCR failed for ${args.thumbnailAbsPath}: ${error instanceof Error ? error.message : "unknown error"}`
      );
      next.ocrText = "";
      next.ocrBoxes = [];
      next.ocrConfidenceMean = 0;
      next.ocrCharCount = 0;
      next.ocrWordCount = 0;
      next.textAreaRatio = 0;
    }
  } else {
    next.ocrText = "";
    next.ocrBoxes = [];
    next.ocrConfidenceMean = 0;
    next.ocrCharCount = 0;
    next.ocrWordCount = 0;
    next.textAreaRatio = 0;
  }

  const overlap = computeTitleOcrOverlap(args.title, next.ocrText);
  next.thumb_ocr_title_overlap_jaccard = overlap.jaccard;
  next.thumb_ocr_title_overlap_tokens = {
    titleTokens: overlap.titleTokens,
    ocrTokens: overlap.ocrTokens,
    overlapTokens: overlap.overlapTokens
  };
  next.hasBigText = next.ocrCharCount >= 12 && next.textAreaRatio >= 0.08;

  return { value: next, warnings };
}

export function buildLLMPayload(args: {
  videoId: string;
  title: string;
  thumbnailAbsPath: string;
  thumbMeta: Pick<
    ThumbnailDeterministicFeatures,
    "thumbnailLocalPath" | "fileSizeBytes" | "imageWidth" | "imageHeight" | "aspectRatio"
  >;
  ocrSummary: Pick<
    ThumbnailDeterministicFeatures,
    "ocrText" | "ocrConfidenceMean" | "ocrCharCount" | "ocrWordCount" | "textAreaRatio" | "hasBigText"
  >;
  statsSummary: Pick<
    ThumbnailDeterministicFeatures,
    | "brightnessMean"
    | "contrastStd"
    | "colorfulness"
    | "sharpnessLaplacianVar"
    | "edgeDensity"
    | "thumb_ocr_title_overlap_jaccard"
  >;
}): {
  videoId: string;
  title: string;
  thumbnailAbsPath: string;
  thumbMeta: Record<string, unknown>;
  ocrSummary: Record<string, unknown>;
  statsSummary: Record<string, unknown>;
} {
  const ocrText = args.ocrSummary.ocrText;
  const ocrTextTruncated = ocrText.length > 700 ? `${ocrText.slice(0, 700)}...` : ocrText;

  return {
    videoId: args.videoId,
    title: args.title,
    thumbnailAbsPath: args.thumbnailAbsPath,
    thumbMeta: {
      ...args.thumbMeta
    },
    ocrSummary: {
      ...args.ocrSummary,
      ocrText: ocrTextTruncated
    },
    statsSummary: {
      ...args.statsSummary
    }
  };
}

function normalizeStyleTags(raw: unknown): Array<{ label: StyleTag; confidence: number }> {
  if (!Array.isArray(raw)) {
    return [];
  }

  const seen = new Set<StyleTag>();
  const allowed = new Set<StyleTag>(STYLE_TAGS);
  const normalized: Array<{ label: StyleTag; confidence: number }> = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const source = item as Record<string, unknown>;
    const labelRaw = source.label;
    if (typeof labelRaw !== "string" || !allowed.has(labelRaw as StyleTag)) {
      continue;
    }

    const label = labelRaw as StyleTag;
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);

    normalized.push({
      label,
      confidence: clamp01(typeof source.confidence === "number" ? source.confidence : 0)
    });

    if (normalized.length >= 6) {
      break;
    }
  }

  return normalized;
}

function normalizeEvidenceRegions(raw: unknown): ThumbnailEvidenceRegion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const source = item as Record<string, unknown>;
      const label = typeof source.label === "string" && source.label.trim() ? source.label.trim() : "region";
      const x = clampBboxComponent(typeof source.x === "number" ? source.x : 0);
      const y = clampBboxComponent(typeof source.y === "number" ? source.y : 0);
      const w = clampBboxComponent(typeof source.w === "number" ? source.w : 0);
      const h = clampBboxComponent(typeof source.h === "number" ? source.h : 0);
      return { label, x, y, w, h };
    })
    .filter((region): region is ThumbnailEvidenceRegion => region !== null);
}

function normalizeEvidenceSignals(raw: unknown, warnings: string[]): ThumbnailEvidenceSignal[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const resolveDeterministicSignalField = (rawFieldName: string): string | null => {
    if (DETERMINISTIC_SIGNAL_FIELDS.has(rawFieldName)) {
      return rawFieldName;
    }

    for (const prefix of DETERMINISTIC_SIGNAL_PREFIXES) {
      if (rawFieldName.startsWith(prefix)) {
        const candidate = rawFieldName.slice(prefix.length).trim();
        if (candidate && DETERMINISTIC_SIGNAL_FIELDS.has(candidate)) {
          return candidate;
        }
      }
    }

    const dotIndex = rawFieldName.lastIndexOf(".");
    if (dotIndex >= 0) {
      const suffix = rawFieldName.slice(dotIndex + 1).trim();
      if (suffix && DETERMINISTIC_SIGNAL_FIELDS.has(suffix)) {
        return suffix;
      }
    }

    return null;
  };

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const source = item as Record<string, unknown>;
      const fieldName = typeof source.fieldName === "string" ? source.fieldName.trim() : "";
      if (!fieldName) {
        return null;
      }
      const resolvedFieldName = resolveDeterministicSignalField(fieldName);
      if (!resolvedFieldName) {
        warnings.push(`Discarded evidence signal '${fieldName}': unknown deterministic field`);
        return null;
      }

      const rawValue = source.value;
      const value =
        typeof rawValue === "number"
          ? (Number.isFinite(rawValue) ? Number(rawValue.toFixed(6)) : 0)
          : typeof rawValue === "string" || typeof rawValue === "boolean" || rawValue === null
            ? rawValue
            : null;

      return {
        fieldName: resolvedFieldName,
        value
      };
    })
    .filter((signal): signal is ThumbnailEvidenceSignal => signal !== null);
}

function normalizeLlmResult(raw: unknown): { value: ThumbnailLlmResultV1; warnings: string[] } {
  const warnings: string[] = [];
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const archetypeRaw = source.archetype && typeof source.archetype === "object" ? (source.archetype as Record<string, unknown>) : {};
  const archetypeLabelRaw = archetypeRaw.label;
  const archetypeLabel = ARCHETYPE_LABELS.includes(archetypeLabelRaw as ArchetypeLabel)
    ? (archetypeLabelRaw as ArchetypeLabel)
    : "other";
  if (archetypeLabel !== archetypeLabelRaw) {
    warnings.push("Normalized thumbnail archetype to 'other' due to invalid label");
  }

  const faceRaw = source.faceSignals && typeof source.faceSignals === "object" ? (source.faceSignals as Record<string, unknown>) : {};
  const faceCountRaw = faceRaw.faceCountBucket;
  const faceCountBucket = FACE_COUNT_BUCKETS.includes(faceCountRaw as FaceCountBucket)
    ? (faceCountRaw as FaceCountBucket)
    : "0";
  if (faceCountBucket !== faceCountRaw) {
    warnings.push("Normalized faceCountBucket to '0' due to invalid label");
  }

  const positionRaw =
    faceRaw.dominantFacePosition && typeof faceRaw.dominantFacePosition === "object"
      ? (faceRaw.dominantFacePosition as Record<string, unknown>)
      : {};
  let dominantFacePosition = {
    x: FACE_POSITION_X.includes(positionRaw.x as FacePositionX) ? (positionRaw.x as FacePositionX) : "unknown",
    y: FACE_POSITION_Y.includes(positionRaw.y as FacePositionY) ? (positionRaw.y as FacePositionY) : "unknown"
  };

  const emotionRaw = faceRaw.faceEmotionTone;
  let faceEmotionTone: FaceEmotionTone = FACE_EMOTION_TONES.includes(emotionRaw as FaceEmotionTone)
    ? (emotionRaw as FaceEmotionTone)
    : "unknown";

  let hasEyeContact: boolean | "unknown" = "unknown";
  if (faceRaw.hasEyeContact === true || faceRaw.hasEyeContact === false) {
    hasEyeContact = faceRaw.hasEyeContact;
  } else if (faceRaw.hasEyeContact === "unknown") {
    hasEyeContact = "unknown";
  }

  if (faceCountBucket === "0") {
    dominantFacePosition = { x: "unknown", y: "unknown" };
    hasEyeContact = "unknown";
    faceEmotionTone = faceEmotionTone === "unknown" ? "unknown" : faceEmotionTone;
  }

  const clutterRaw = source.clutterLevel && typeof source.clutterLevel === "object" ? (source.clutterLevel as Record<string, unknown>) : {};
  const clutterLabelRaw = clutterRaw.label;
  const clutterLabel = CLUTTER_LEVELS.includes(clutterLabelRaw as ClutterLevel)
    ? (clutterLabelRaw as ClutterLevel)
    : "medium";

  const styleTags = normalizeStyleTags(source.styleTags);
  const faceTagIndex = styleTags.findIndex((tag) => tag.label === "face");
  if (faceTagIndex >= 0 && faceCountBucket === "0") {
    styleTags.splice(faceTagIndex, 1);
    warnings.push("Removed style tag 'face' because faceCountBucket=0");
  }

  const value: ThumbnailLlmResultV1 = {
    schemaVersion: "derived.thumbnail_llm.v1",
    archetype: {
      label: archetypeLabel,
      confidence: clamp01(typeof archetypeRaw.confidence === "number" ? archetypeRaw.confidence : 0)
    },
    faceSignals: {
      faceCountBucket,
      dominantFacePosition,
      faceEmotionTone,
      hasEyeContact,
      confidence: clamp01(typeof faceRaw.confidence === "number" ? faceRaw.confidence : 0)
    },
    clutterLevel: {
      label: clutterLabel,
      confidence: clamp01(typeof clutterRaw.confidence === "number" ? clutterRaw.confidence : 0)
    },
    styleTags,
    evidenceRegions: normalizeEvidenceRegions(source.evidenceRegions),
    evidenceSignals: normalizeEvidenceSignals(source.evidenceSignals, warnings)
  };

  return { value, warnings };
}

async function callAutoGenThumbnailClassifier(args: {
  videoId: string;
  title: string;
  thumbnailAbsPath: string;
  deterministic: ThumbnailDeterministicFeatures;
  onAutoGenWorkerRequestId?: (workerRequestId: string) => void;
}): Promise<{ value: ThumbnailLlmResultV1 | null; warnings: string[] }> {
  if (!env.autoGenEnabled) {
    return {
      value: null,
      warnings: ["AutoGen thumbnail classifier skipped: AUTO_GEN_ENABLED=false"]
    };
  }

  if (!env.openAiApiKey) {
    return {
      value: null,
      warnings: ["AutoGen thumbnail classifier skipped: OPENAI_API_KEY is not configured"]
    };
  }

  try {
    await fs.access(args.thumbnailAbsPath);
  } catch {
    return {
      value: null,
      warnings: [`AutoGen thumbnail classifier skipped: thumbnail file is not accessible (${args.thumbnailAbsPath})`]
    };
  }

  const payload = buildLLMPayload({
    videoId: args.videoId,
    title: args.title,
    thumbnailAbsPath: args.thumbnailAbsPath,
    thumbMeta: {
      thumbnailLocalPath: args.deterministic.thumbnailLocalPath,
      fileSizeBytes: args.deterministic.fileSizeBytes,
      imageWidth: args.deterministic.imageWidth,
      imageHeight: args.deterministic.imageHeight,
      aspectRatio: args.deterministic.aspectRatio
    },
    ocrSummary: {
      ocrText: args.deterministic.ocrText,
      ocrConfidenceMean: args.deterministic.ocrConfidenceMean,
      ocrCharCount: args.deterministic.ocrCharCount,
      ocrWordCount: args.deterministic.ocrWordCount,
      textAreaRatio: args.deterministic.textAreaRatio,
      hasBigText: args.deterministic.hasBigText
    },
    statsSummary: {
      brightnessMean: args.deterministic.brightnessMean,
      contrastStd: args.deterministic.contrastStd,
      colorfulness: args.deterministic.colorfulness,
      sharpnessLaplacianVar: args.deterministic.sharpnessLaplacianVar,
      edgeDensity: args.deterministic.edgeDensity,
      thumb_ocr_title_overlap_jaccard: args.deterministic.thumb_ocr_title_overlap_jaccard
    }
  });

  try {
    const requestPayload = {
      task: "thumbnail_classifier_v1" as const,
      payload,
      provider: "openai" as const,
      model: env.autoGenModelThumbnail,
      reasoningEffort: env.autoGenReasoningEffort
    };
    const raw = args.onAutoGenWorkerRequestId
      ? await requestAutoGenTask(requestPayload, { onWorkerRequestId: args.onAutoGenWorkerRequestId })
      : await requestAutoGenTask(requestPayload);

    const normalized = normalizeLlmResult(raw);
    return {
      value: normalized.value,
      warnings: normalized.warnings
    };
  } catch (error) {
    return {
      value: null,
      warnings: [
        `AutoGen thumbnail classifier failed for ${args.videoId}: ${error instanceof Error ? error.message : "unknown error"}`
      ]
    };
  }
}

export async function computeThumbnailFeaturesBundle(
  args: ComputeThumbnailFeaturesArgs
): Promise<ComputeThumbnailFeaturesResult> {
  const deterministicResult = await computeDeterministic({
    title: args.title,
    thumbnailAbsPath: args.thumbnailAbsPath,
    thumbnailLocalPath: args.thumbnailLocalPath
  });

  const llmResult = await callAutoGenThumbnailClassifier({
    videoId: args.videoId,
    title: args.title,
    thumbnailAbsPath: args.thumbnailAbsPath,
    deterministic: deterministicResult.value
  });

  const warnings = dedupeWarnings([...deterministicResult.warnings, ...llmResult.warnings]);

  return {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      thumbnailFeatures: {
        deterministic: deterministicResult.value,
        llm: llmResult.value,
        warnings
      }
    },
    warnings
  };
}

function mergeBundle(
  args: ComputeThumbnailFeaturesArgs,
  bundle: ThumbnailFeaturesArtifactV1,
  existing: Record<string, unknown> | null
): DerivedVideoFeaturesArtifactV1 {
  return {
    ...(existing ?? {}),
    schemaVersion: "derived.video_features.v1",
    videoId: args.videoId,
    computedAt: bundle.computedAt,
    thumbnailFeatures: bundle.thumbnailFeatures
  };
}

export async function persistThumbnailFeaturesArtifact(
  args: PersistThumbnailFeaturesArgs
): Promise<PersistThumbnailFeaturesResult> {
  const derivedFolderPath = path.resolve(args.channelFolderPath, "derived", "video_features");
  const artifactAbsolutePath = path.resolve(derivedFolderPath, `${args.videoId}.json`);

  ensureInsideRoot(args.exportsRoot, derivedFolderPath);
  ensureInsideRoot(args.exportsRoot, artifactAbsolutePath);

  await fs.mkdir(derivedFolderPath, { recursive: true });
  const existing = await readExistingArtifact(artifactAbsolutePath);
  const existingSection = readExistingThumbnailSection(existing);
  const requestedDeterministic = args.compute?.deterministic ?? true;
  const deterministicMode = args.compute?.deterministicMode ?? "full";
  const requestedLlm = args.compute?.llm ?? true;

  let deterministic = existingSection?.deterministic ?? null;
  const warnings: string[] = [...(existingSection?.warnings ?? [])];
  if (requestedDeterministic || !deterministic) {
    const deterministicResult =
      deterministicMode === "ocr_only" && deterministic
        ? await computeDeterministicOcrOnly({
            title: args.title,
            thumbnailAbsPath: args.thumbnailAbsPath,
            thumbnailLocalPath: args.thumbnailLocalPath,
            existing: deterministic
          })
        : await computeDeterministic({
            title: args.title,
            thumbnailAbsPath: args.thumbnailAbsPath,
            thumbnailLocalPath: args.thumbnailLocalPath
          });
    deterministic = deterministicResult.value;
    warnings.push(...deterministicResult.warnings);
  }

  let llm = existingSection?.llm ?? null;
  if (requestedLlm && deterministic) {
    const llmResult = await callAutoGenThumbnailClassifier({
      videoId: args.videoId,
      title: args.title,
      thumbnailAbsPath: args.thumbnailAbsPath,
      deterministic,
      onAutoGenWorkerRequestId: args.trace?.onAutoGenWorkerRequestId
    });
    llm = llmResult.value;
    warnings.push(...llmResult.warnings);
  }

  const result: ComputeThumbnailFeaturesResult = {
    bundle: {
      schemaVersion: "derived.video_features.v1",
      videoId: args.videoId,
      computedAt: new Date().toISOString(),
      thumbnailFeatures: {
        deterministic:
          deterministic ??
          (
            await computeDeterministic({
              title: args.title,
              thumbnailAbsPath: args.thumbnailAbsPath,
              thumbnailLocalPath: args.thumbnailLocalPath
            })
          ).value,
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

function readExistingThumbnailSection(existing: Record<string, unknown> | null): ThumbnailFeaturesSection | null {
  if (!existing || typeof existing !== "object") {
    return null;
  }
  if (
    !existing.thumbnailFeatures ||
    typeof existing.thumbnailFeatures !== "object" ||
    Array.isArray(existing.thumbnailFeatures)
  ) {
    return null;
  }
  return existing.thumbnailFeatures as ThumbnailFeaturesSection;
}
