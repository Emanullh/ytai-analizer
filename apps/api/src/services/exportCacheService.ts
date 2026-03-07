import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type { Timeframe } from "../types.js";
import { fileExists } from "../utils/fileExists.js";
import { hashFileSha1, hashStringSha1 } from "../utils/hash.js";

const CACHE_INDEX_SCHEMA_VERSION = "cache.index.v1";
const TITLE_EMBEDDING_MODEL = "text-embedding-3-small";
const SUPPORTED_TIMEFRAMES: Timeframe[] = ["1m", "6m", "1y", "2y", "5y"];

type TranscriptSource = "captions" | "asr" | "none";
type TranscriptStatus = "ok" | "missing" | "error";

type CacheItemStatus = {
  rawTranscript: "ok" | "missing" | "error";
  thumbnail: "ok" | "failed";
  derived: "ok" | "partial" | "error";
  warnings: string[];
};

export interface CacheEntry {
  videoId: string;
  lastUpdatedAt: string;
  inputs: {
    titleHash: string;
    descriptionHash: string;
    thumbnailHash: string;
    transcriptHash: string;
    transcriptSource: TranscriptSource;
    asrConfigHash: string;
    ocrConfigHash: string;
    embeddingModel: string;
    llmModels: {
      title: string;
      description: string;
      transcript: string;
      thumbnail: string;
    };
  };
  artifacts: {
    rawTranscriptPath: string;
    thumbnailPath: string;
    derivedVideoFeaturesPath: string;
  };
  status: CacheItemStatus;
}

export interface CacheIndex {
  schemaVersion: "cache.index.v1";
  channelId: string;
  channelFolder: string;
  updatedAt: string;
  exportVersion: string;
  timeframes: Record<Timeframe, { videos: Record<string, CacheEntry> }>;
}

export interface HashBundle {
  titleHash: string;
  descriptionHash: string;
  thumbnailHash: string;
  transcriptHash: string;
  transcriptSource: TranscriptSource;
  asrConfigHash: string;
  ocrConfigHash: string;
  embeddingModel: string;
  llmModels: {
    title: string;
    description: string;
    transcript: string;
    thumbnail: string;
  };
}

export interface ComputeHashesArgs {
  title: string;
  description: string;
  transcriptText: string;
  transcriptSource: TranscriptSource;
  thumbnailFilePath?: string;
}

export type OcrEngine = "python";
const PYTHON_OCR_IMPLEMENTATION_VERSION = "python-ocr-v2";

export interface DerivedFeaturePresence {
  titleDeterministic: boolean;
  titleLlm: boolean;
  descriptionDeterministic: boolean;
  descriptionLlm: boolean;
  transcriptDeterministic: boolean;
  transcriptLlm: boolean;
  thumbnailDeterministic: boolean;
  thumbnailLlm: boolean;
}

export interface VideoDerivedPartsPlan {
  titleDeterministic: boolean;
  titleLlm: boolean;
  descriptionDeterministic: boolean;
  descriptionLlm: boolean;
  transcriptDeterministic: boolean;
  transcriptLlm: boolean;
  thumbnailDeterministic: boolean;
  thumbnailDeterministicMode: "full" | "ocr_only";
  thumbnailLlm: boolean;
}

export interface VideoCachePlan {
  needThumbnailDownload: boolean;
  needTranscriptFetch: boolean;
  needDerivedParts: VideoDerivedPartsPlan;
}

export interface CheckVideoCacheResult {
  hit: "full" | "partial" | "miss";
  reasons: string[];
  entry?: CacheEntry;
  artifacts: {
    rawTranscriptPath: string;
    thumbnailPath: string;
    derivedVideoFeaturesPath: string;
    rawTranscriptExists: boolean;
    thumbnailExists: boolean;
    derivedExists: boolean;
  };
  derivedPresence: DerivedFeaturePresence;
  plan: VideoCachePlan;
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid cache path");
  }
}

function isSafeRelativePath(value: string): boolean {
  if (!value.trim() || path.isAbsolute(value)) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return false;
  }
  return true;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function toSafeRelativePath(rootPath: string, targetPath: string): string {
  ensureInsideRoot(rootPath, targetPath);
  const relative = toPosixPath(path.relative(rootPath, targetPath));
  if (!isSafeRelativePath(relative)) {
    throw new Error("Invalid relative cache path");
  }
  return relative;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEmptyTimeframes(): Record<Timeframe, { videos: Record<string, CacheEntry> }> {
  return {
    "1m": { videos: {} },
    "6m": { videos: {} },
    "1y": { videos: {} },
    "2y": { videos: {} },
    "5y": { videos: {} }
  };
}

function getCacheFolderPath(channelFolderPath: string): string {
  return path.resolve(channelFolderPath, ".cache");
}

function getCacheIndexPath(channelFolderPath: string): string {
  return path.resolve(getCacheFolderPath(channelFolderPath), "index.json");
}

function defaultArtifactPaths(videoId: string): CacheEntry["artifacts"] {
  return {
    rawTranscriptPath: path.posix.join("raw", "transcripts", `${videoId}.jsonl`),
    thumbnailPath: path.posix.join("thumbnails", `${videoId}.jpg`),
    derivedVideoFeaturesPath: path.posix.join("derived", "video_features", `${videoId}.json`)
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTranscriptSource(value: unknown): TranscriptSource {
  if (value === "captions" || value === "asr" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeRawTranscriptStatus(value: unknown): CacheItemStatus["rawTranscript"] {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function normalizeThumbnailStatus(value: unknown): CacheItemStatus["thumbnail"] {
  if (value === "ok" || value === "failed") {
    return value;
  }
  return "failed";
}

function normalizeDerivedStatus(value: unknown): CacheItemStatus["derived"] {
  if (value === "ok" || value === "partial" || value === "error") {
    return value;
  }
  return "partial";
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeArtifactPath(value: unknown, fallbackPath: string): string {
  const candidate = normalizeString(value).replace(/\\/g, "/");
  if (!candidate || !isSafeRelativePath(candidate)) {
    return fallbackPath;
  }
  return candidate;
}

function normalizeEntry(videoId: string, raw: unknown): CacheEntry {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const inputsRaw =
    source.inputs && typeof source.inputs === "object" ? (source.inputs as Record<string, unknown>) : {};
  const artifactsRaw =
    source.artifacts && typeof source.artifacts === "object" ? (source.artifacts as Record<string, unknown>) : {};
  const llmModelsRaw =
    inputsRaw.llmModels && typeof inputsRaw.llmModels === "object"
      ? (inputsRaw.llmModels as Record<string, unknown>)
      : {};
  const statusRaw =
    source.status && typeof source.status === "object" ? (source.status as Record<string, unknown>) : {};
  const fallbackArtifacts = defaultArtifactPaths(videoId);

  return {
    videoId,
    lastUpdatedAt: normalizeString(source.lastUpdatedAt) || nowIso(),
    inputs: {
      titleHash: normalizeString(inputsRaw.titleHash),
      descriptionHash: normalizeString(inputsRaw.descriptionHash),
      thumbnailHash: normalizeString(inputsRaw.thumbnailHash),
      transcriptHash: normalizeString(inputsRaw.transcriptHash),
      transcriptSource: normalizeTranscriptSource(inputsRaw.transcriptSource),
      asrConfigHash: normalizeString(inputsRaw.asrConfigHash),
      ocrConfigHash: normalizeString(inputsRaw.ocrConfigHash),
      embeddingModel: normalizeString(inputsRaw.embeddingModel) || TITLE_EMBEDDING_MODEL,
      llmModels: {
        title: normalizeString(llmModelsRaw.title),
        description: normalizeString(llmModelsRaw.description),
        transcript: normalizeString(llmModelsRaw.transcript),
        thumbnail: normalizeString(llmModelsRaw.thumbnail)
      }
    },
    artifacts: {
      rawTranscriptPath: sanitizeArtifactPath(artifactsRaw.rawTranscriptPath, fallbackArtifacts.rawTranscriptPath),
      thumbnailPath: sanitizeArtifactPath(artifactsRaw.thumbnailPath, fallbackArtifacts.thumbnailPath),
      derivedVideoFeaturesPath: sanitizeArtifactPath(
        artifactsRaw.derivedVideoFeaturesPath,
        fallbackArtifacts.derivedVideoFeaturesPath
      )
    },
    status: {
      rawTranscript: normalizeRawTranscriptStatus(statusRaw.rawTranscript),
      thumbnail: normalizeThumbnailStatus(statusRaw.thumbnail),
      derived: normalizeDerivedStatus(statusRaw.derived),
      warnings: normalizeWarnings(statusRaw.warnings)
    }
  };
}

function createDefaultIndex(args: {
  channelId: string;
  channelFolderPath: string;
  exportVersion: string;
}): CacheIndex {
  return {
    schemaVersion: CACHE_INDEX_SCHEMA_VERSION,
    channelId: args.channelId,
    channelFolder: path.basename(args.channelFolderPath),
    updatedAt: nowIso(),
    exportVersion: args.exportVersion,
    timeframes: createEmptyTimeframes()
  };
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tempPath, targetPath);
}

function hasOpenAiAccess(): boolean {
  return Boolean(env.openAiApiKey);
}

function canRunLlm(): boolean {
  return env.autoGenEnabled && hasOpenAiAccess();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasObjectPath(source: Record<string, unknown>, pathParts: string[]): boolean {
  let cursor: unknown = source;
  for (const part of pathParts) {
    if (!isObject(cursor)) {
      return false;
    }
    cursor = cursor[part];
  }
  return isObject(cursor);
}

function hasNonNullPath(source: Record<string, unknown>, pathParts: string[]): boolean {
  let cursor: unknown = source;
  for (const part of pathParts) {
    if (!isObject(cursor)) {
      return false;
    }
    cursor = cursor[part];
  }
  return cursor !== null && cursor !== undefined;
}

async function readDerivedFeaturePresence(artifactPath: string): Promise<DerivedFeaturePresence> {
  const empty: DerivedFeaturePresence = {
    titleDeterministic: false,
    titleLlm: false,
    descriptionDeterministic: false,
    descriptionLlm: false,
    transcriptDeterministic: false,
    transcriptLlm: false,
    thumbnailDeterministic: false,
    thumbnailLlm: false
  };

  try {
    const raw = await fs.readFile(artifactPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      return empty;
    }

    return {
      titleDeterministic: hasObjectPath(parsed, ["titleFeatures", "deterministic"]),
      titleLlm: hasNonNullPath(parsed, ["titleFeatures", "llm"]),
      descriptionDeterministic: hasObjectPath(parsed, ["descriptionFeatures", "deterministic"]),
      descriptionLlm: hasNonNullPath(parsed, ["descriptionFeatures", "llm"]),
      transcriptDeterministic: hasObjectPath(parsed, ["transcriptFeatures", "deterministic"]),
      transcriptLlm: hasNonNullPath(parsed, ["transcriptFeatures", "llm"]),
      thumbnailDeterministic: hasObjectPath(parsed, ["thumbnailFeatures", "deterministic"]),
      thumbnailLlm: hasNonNullPath(parsed, ["thumbnailFeatures", "llm"])
    };
  } catch {
    return empty;
  }
}

function resolveArtifactAbsolutePath(args: {
  channelFolderPath: string;
  exportsRoot: string;
  relativePath: string;
}): string {
  const absolute = path.resolve(args.channelFolderPath, args.relativePath);
  ensureInsideRoot(args.exportsRoot, absolute);
  return absolute;
}

export async function loadCacheIndex(args: {
  exportsRoot: string;
  channelFolderPath: string;
  channelId: string;
  exportVersion: string;
}): Promise<CacheIndex> {
  const cacheFolderPath = getCacheFolderPath(args.channelFolderPath);
  const indexPath = getCacheIndexPath(args.channelFolderPath);
  ensureInsideRoot(args.exportsRoot, cacheFolderPath);
  ensureInsideRoot(args.exportsRoot, indexPath);
  await fs.mkdir(cacheFolderPath, { recursive: true });

  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      return createDefaultIndex(args);
    }

    const schemaVersion = normalizeString(parsed.schemaVersion);
    const exportVersion = normalizeString(parsed.exportVersion);
    const channelId = normalizeString(parsed.channelId);
    const timeframesRaw =
      parsed.timeframes && typeof parsed.timeframes === "object"
        ? (parsed.timeframes as Record<string, unknown>)
        : {};

    if (
      schemaVersion !== CACHE_INDEX_SCHEMA_VERSION ||
      !channelId ||
      channelId !== args.channelId ||
      !exportVersion ||
      exportVersion !== args.exportVersion
    ) {
      return createDefaultIndex(args);
    }

    const normalized: CacheIndex = {
      schemaVersion: CACHE_INDEX_SCHEMA_VERSION,
      channelId: args.channelId,
      channelFolder: path.basename(args.channelFolderPath),
      updatedAt: normalizeString(parsed.updatedAt) || nowIso(),
      exportVersion: args.exportVersion,
      timeframes: createEmptyTimeframes()
    };

    for (const timeframe of SUPPORTED_TIMEFRAMES) {
      const timeframeRaw =
        timeframesRaw[timeframe] && typeof timeframesRaw[timeframe] === "object"
          ? (timeframesRaw[timeframe] as Record<string, unknown>)
          : {};
      const videosRaw =
        timeframeRaw.videos && typeof timeframeRaw.videos === "object"
          ? (timeframeRaw.videos as Record<string, unknown>)
          : {};
      const videos: Record<string, CacheEntry> = {};

      for (const [videoId, rawEntry] of Object.entries(videosRaw)) {
        const normalizedVideoId = normalizeString(videoId);
        if (!normalizedVideoId) {
          continue;
        }
        videos[normalizedVideoId] = normalizeEntry(normalizedVideoId, rawEntry);
      }
      normalized.timeframes[timeframe] = { videos };
    }

    return normalized;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createDefaultIndex(args);
    }
    throw error;
  }
}

export async function saveCacheIndex(args: {
  exportsRoot: string;
  channelFolderPath: string;
  index: CacheIndex;
}): Promise<void> {
  const cacheFolderPath = getCacheFolderPath(args.channelFolderPath);
  const indexPath = getCacheIndexPath(args.channelFolderPath);
  ensureInsideRoot(args.exportsRoot, cacheFolderPath);
  ensureInsideRoot(args.exportsRoot, indexPath);

  const sanitized: CacheIndex = {
    schemaVersion: CACHE_INDEX_SCHEMA_VERSION,
    channelId: args.index.channelId,
    channelFolder: path.basename(args.channelFolderPath),
    updatedAt: nowIso(),
    exportVersion: args.index.exportVersion,
    timeframes: createEmptyTimeframes()
  };

  for (const timeframe of SUPPORTED_TIMEFRAMES) {
    const sourceVideos = args.index.timeframes[timeframe]?.videos ?? {};
    const targetVideos: Record<string, CacheEntry> = {};
    for (const [videoId, entry] of Object.entries(sourceVideos)) {
      const normalizedVideoId = normalizeString(videoId);
      if (!normalizedVideoId) {
        continue;
      }
      targetVideos[normalizedVideoId] = normalizeEntry(normalizedVideoId, entry);
    }
    sanitized.timeframes[timeframe] = { videos: targetVideos };
  }

  await fs.mkdir(cacheFolderPath, { recursive: true });
  await writeJsonAtomic(indexPath, sanitized);
}

export async function computeHashes(args: ComputeHashesArgs): Promise<HashBundle> {
  const asrConfigHash = hashStringSha1(
    JSON.stringify({
      model: env.localAsrModel,
      computeType: env.localAsrComputeType,
      language: env.localAsrLanguage,
      beamSize: env.localAsrBeamSize
    })
  );
  const ocrConfigHash = computeOcrConfigHash();

  let thumbnailHash = "";
  if (args.thumbnailFilePath && (await fileExists(args.thumbnailFilePath))) {
    thumbnailHash = await hashFileSha1(args.thumbnailFilePath);
  }

  return {
    titleHash: hashStringSha1(args.title),
    descriptionHash: hashStringSha1(args.description),
    thumbnailHash,
    transcriptHash: hashStringSha1(args.transcriptText),
    transcriptSource: args.transcriptSource,
    asrConfigHash,
    ocrConfigHash,
    embeddingModel: TITLE_EMBEDDING_MODEL,
    llmModels: {
      title: env.autoGenModelTitle,
      description: env.autoGenModelDescription,
      transcript: env.autoGenModelDescription,
      thumbnail: env.autoGenModelThumbnail
    }
  };
}

export function computeOcrConfigHash(args?: {
  engine?: OcrEngine;
  langs?: string;
  downscaleWidth?: number;
}): string {
  const engine = "python";
  const langs = args?.langs ?? env.thumbOcrLangs;
  const downscaleWidth = args?.downscaleWidth ?? env.thumbVisionDownscaleWidth;
  return hashStringSha1(
    JSON.stringify({
      engine,
      langs,
      downscaleWidth,
      implementationVersion: PYTHON_OCR_IMPLEMENTATION_VERSION
    })
  );
}

function markThumbnailDeterministic(plan: VideoDerivedPartsPlan, mode: "full" | "ocr_only"): void {
  if (!plan.thumbnailDeterministic) {
    plan.thumbnailDeterministic = true;
    plan.thumbnailDeterministicMode = mode;
    return;
  }
  if (mode === "full") {
    plan.thumbnailDeterministicMode = "full";
  }
}

function createEmptyDerivedPlan(): VideoDerivedPartsPlan {
  return {
    titleDeterministic: false,
    titleLlm: false,
    descriptionDeterministic: false,
    descriptionLlm: false,
    transcriptDeterministic: false,
    transcriptLlm: false,
    thumbnailDeterministic: false,
    thumbnailDeterministicMode: "full",
    thumbnailLlm: false
  };
}

function forceFullRecompute(plan: VideoCachePlan): void {
  plan.needThumbnailDownload = true;
  plan.needTranscriptFetch = true;
  plan.needDerivedParts.titleDeterministic = true;
  plan.needDerivedParts.descriptionDeterministic = true;
  plan.needDerivedParts.transcriptDeterministic = true;
  markThumbnailDeterministic(plan.needDerivedParts, "full");
  if (canRunLlm()) {
    plan.needDerivedParts.titleLlm = true;
    plan.needDerivedParts.descriptionLlm = true;
    plan.needDerivedParts.transcriptLlm = true;
    plan.needDerivedParts.thumbnailLlm = true;
  }
}

export async function checkVideoCache(args: {
  exportsRoot: string;
  channelFolderPath: string;
  index: CacheIndex;
  timeframe: Timeframe;
  videoId: string;
  currentHashes: HashBundle;
}): Promise<CheckVideoCacheResult> {
  const timeBucket = args.index.timeframes[args.timeframe] ?? { videos: {} };
  const entry = timeBucket.videos[args.videoId];
  const baseArtifacts = entry?.artifacts ?? defaultArtifactPaths(args.videoId);

  const rawTranscriptAbsolutePath = resolveArtifactAbsolutePath({
    channelFolderPath: args.channelFolderPath,
    exportsRoot: args.exportsRoot,
    relativePath: baseArtifacts.rawTranscriptPath
  });
  const thumbnailAbsolutePath = resolveArtifactAbsolutePath({
    channelFolderPath: args.channelFolderPath,
    exportsRoot: args.exportsRoot,
    relativePath: baseArtifacts.thumbnailPath
  });
  const derivedAbsolutePath = resolveArtifactAbsolutePath({
    channelFolderPath: args.channelFolderPath,
    exportsRoot: args.exportsRoot,
    relativePath: baseArtifacts.derivedVideoFeaturesPath
  });

  const [rawTranscriptExists, thumbnailExists, derivedExists] = await Promise.all([
    fileExists(rawTranscriptAbsolutePath),
    fileExists(thumbnailAbsolutePath),
    fileExists(derivedAbsolutePath)
  ]);

  const derivedPresence = derivedExists
    ? await readDerivedFeaturePresence(derivedAbsolutePath)
    : {
        titleDeterministic: false,
        titleLlm: false,
        descriptionDeterministic: false,
        descriptionLlm: false,
        transcriptDeterministic: false,
        transcriptLlm: false,
        thumbnailDeterministic: false,
        thumbnailLlm: false
      };
  const reasons: string[] = [];
  const plan: VideoCachePlan = {
    needThumbnailDownload: false,
    needTranscriptFetch: false,
    needDerivedParts: createEmptyDerivedPlan()
  };

  if (!entry) {
    reasons.push("cache entry missing");
    forceFullRecompute(plan);
    return {
      hit: "miss",
      reasons,
      artifacts: {
        rawTranscriptPath: baseArtifacts.rawTranscriptPath,
        thumbnailPath: baseArtifacts.thumbnailPath,
        derivedVideoFeaturesPath: baseArtifacts.derivedVideoFeaturesPath,
        rawTranscriptExists,
        thumbnailExists,
        derivedExists
      },
      derivedPresence,
      plan
    };
  }

  if (!thumbnailExists) {
    reasons.push("thumbnail artifact missing");
    plan.needThumbnailDownload = true;
    markThumbnailDeterministic(plan.needDerivedParts, "full");
    if (canRunLlm()) {
      plan.needDerivedParts.thumbnailLlm = true;
    }
  }
  if (!rawTranscriptExists) {
    reasons.push("transcript artifact missing");
    plan.needTranscriptFetch = true;
    plan.needDerivedParts.titleDeterministic = true;
    plan.needDerivedParts.transcriptDeterministic = true;
    if (canRunLlm()) {
      plan.needDerivedParts.transcriptLlm = true;
    }
  }
  if (!derivedExists) {
    reasons.push("derived artifact missing");
    plan.needDerivedParts.titleDeterministic = true;
    plan.needDerivedParts.descriptionDeterministic = true;
    plan.needDerivedParts.transcriptDeterministic = true;
    markThumbnailDeterministic(plan.needDerivedParts, "full");
    if (canRunLlm()) {
      plan.needDerivedParts.titleLlm = true;
      plan.needDerivedParts.descriptionLlm = true;
      plan.needDerivedParts.transcriptLlm = true;
      plan.needDerivedParts.thumbnailLlm = true;
    }
  }

  if (!derivedPresence.titleDeterministic) {
    reasons.push("title deterministic missing");
    plan.needDerivedParts.titleDeterministic = true;
  }
  if (!derivedPresence.descriptionDeterministic) {
    reasons.push("description deterministic missing");
    plan.needDerivedParts.descriptionDeterministic = true;
  }
  if (!derivedPresence.transcriptDeterministic) {
    reasons.push("transcript deterministic missing");
    plan.needDerivedParts.transcriptDeterministic = true;
  }
  if (!derivedPresence.thumbnailDeterministic) {
    reasons.push("thumbnail deterministic missing");
    markThumbnailDeterministic(plan.needDerivedParts, "full");
  }

  if (canRunLlm()) {
    if (!derivedPresence.titleLlm) {
      reasons.push("title llm missing (upgrade)");
      plan.needDerivedParts.titleLlm = true;
    }
    if (!derivedPresence.descriptionLlm) {
      reasons.push("description llm missing (upgrade)");
      plan.needDerivedParts.descriptionLlm = true;
    }
    if (!derivedPresence.transcriptLlm) {
      reasons.push("transcript llm missing (upgrade)");
      plan.needDerivedParts.transcriptLlm = true;
    }
    if (!derivedPresence.thumbnailLlm) {
      reasons.push("thumbnail llm missing (upgrade)");
      plan.needDerivedParts.thumbnailLlm = true;
    }
  }

  if (entry.inputs.titleHash !== args.currentHashes.titleHash) {
    reasons.push("title hash changed");
    plan.needDerivedParts.titleDeterministic = true;
    plan.needDerivedParts.transcriptDeterministic = true;
    if (canRunLlm()) {
      plan.needDerivedParts.titleLlm = true;
    }
  }
  if (entry.inputs.descriptionHash !== args.currentHashes.descriptionHash) {
    reasons.push("description hash changed");
    plan.needDerivedParts.descriptionDeterministic = true;
    if (canRunLlm()) {
      plan.needDerivedParts.descriptionLlm = true;
    }
  }
  if (entry.inputs.transcriptHash !== args.currentHashes.transcriptHash) {
    reasons.push("transcript hash changed");
    plan.needDerivedParts.titleDeterministic = true;
    plan.needDerivedParts.transcriptDeterministic = true;
    if (canRunLlm()) {
      plan.needDerivedParts.transcriptLlm = true;
    }
  }
  if (entry.inputs.transcriptSource !== args.currentHashes.transcriptSource) {
    reasons.push("transcript source changed");
    plan.needTranscriptFetch = true;
    plan.needDerivedParts.titleDeterministic = true;
    plan.needDerivedParts.transcriptDeterministic = true;
    if (canRunLlm()) {
      plan.needDerivedParts.transcriptLlm = true;
    }
  }
  if (entry.inputs.asrConfigHash !== args.currentHashes.asrConfigHash && entry.inputs.transcriptSource === "asr") {
    reasons.push("asr config changed");
    plan.needTranscriptFetch = true;
    plan.needDerivedParts.titleDeterministic = true;
    plan.needDerivedParts.transcriptDeterministic = true;
    if (canRunLlm()) {
      plan.needDerivedParts.transcriptLlm = true;
    }
  }
  if (entry.inputs.ocrConfigHash !== args.currentHashes.ocrConfigHash) {
    reasons.push("ocr config changed");
    markThumbnailDeterministic(plan.needDerivedParts, "ocr_only");
  }
  if (entry.inputs.thumbnailHash !== args.currentHashes.thumbnailHash) {
    reasons.push("thumbnail hash changed");
    markThumbnailDeterministic(plan.needDerivedParts, "full");
    if (canRunLlm()) {
      plan.needDerivedParts.thumbnailLlm = true;
    }
  }
  if (entry.inputs.embeddingModel !== args.currentHashes.embeddingModel) {
    reasons.push("embedding model changed");
    plan.needDerivedParts.titleDeterministic = true;
  }

  if (
    entry.inputs.llmModels.title !== args.currentHashes.llmModels.title &&
    canRunLlm() &&
    derivedPresence.titleLlm
  ) {
    reasons.push("title llm model changed");
    plan.needDerivedParts.titleLlm = true;
  }
  if (
    entry.inputs.llmModels.description !== args.currentHashes.llmModels.description &&
    canRunLlm() &&
    derivedPresence.descriptionLlm
  ) {
    reasons.push("description llm model changed");
    plan.needDerivedParts.descriptionLlm = true;
  }
  if (
    entry.inputs.llmModels.transcript !== args.currentHashes.llmModels.transcript &&
    canRunLlm() &&
    derivedPresence.transcriptLlm
  ) {
    reasons.push("transcript llm model changed");
    plan.needDerivedParts.transcriptLlm = true;
  }
  if (
    entry.inputs.llmModels.thumbnail !== args.currentHashes.llmModels.thumbnail &&
    canRunLlm() &&
    derivedPresence.thumbnailLlm
  ) {
    reasons.push("thumbnail llm model changed");
    plan.needDerivedParts.thumbnailLlm = true;
  }

  const hasWork =
    plan.needThumbnailDownload ||
    plan.needTranscriptFetch ||
    plan.needDerivedParts.titleDeterministic ||
    plan.needDerivedParts.titleLlm ||
    plan.needDerivedParts.descriptionDeterministic ||
    plan.needDerivedParts.descriptionLlm ||
    plan.needDerivedParts.transcriptDeterministic ||
    plan.needDerivedParts.transcriptLlm ||
    plan.needDerivedParts.thumbnailDeterministic ||
    plan.needDerivedParts.thumbnailLlm;

  const hit: "full" | "partial" = hasWork ? "partial" : "full";
  return {
    hit,
    reasons,
    entry,
    artifacts: {
      rawTranscriptPath: baseArtifacts.rawTranscriptPath,
      thumbnailPath: baseArtifacts.thumbnailPath,
      derivedVideoFeaturesPath: baseArtifacts.derivedVideoFeaturesPath,
      rawTranscriptExists,
      thumbnailExists,
      derivedExists
    },
    derivedPresence,
    plan
  };
}

export function updateVideoCacheEntry(args: {
  index: CacheIndex;
  timeframe: Timeframe;
  videoId: string;
  entry: CacheEntry;
}): void {
  if (!args.index.timeframes[args.timeframe]) {
    args.index.timeframes[args.timeframe] = { videos: {} };
  }
  args.index.timeframes[args.timeframe].videos[args.videoId] = normalizeEntry(args.videoId, args.entry);
  args.index.updatedAt = nowIso();
}

export function buildCacheEntry(args: {
  videoId: string;
  hashes: HashBundle;
  artifacts?: Partial<CacheEntry["artifacts"]>;
  status: CacheItemStatus;
}): CacheEntry {
  const defaults = defaultArtifactPaths(args.videoId);
  return normalizeEntry(args.videoId, {
    videoId: args.videoId,
    lastUpdatedAt: nowIso(),
    inputs: args.hashes,
    artifacts: {
      rawTranscriptPath: args.artifacts?.rawTranscriptPath ?? defaults.rawTranscriptPath,
      thumbnailPath: args.artifacts?.thumbnailPath ?? defaults.thumbnailPath,
      derivedVideoFeaturesPath: args.artifacts?.derivedVideoFeaturesPath ?? defaults.derivedVideoFeaturesPath
    },
    status: args.status
  });
}

export function resolveCacheIndexPath(args: {
  exportsRoot: string;
  channelFolderPath: string;
}): { cacheFolderPath: string; indexPath: string } {
  const cacheFolderPath = getCacheFolderPath(args.channelFolderPath);
  const indexPath = getCacheIndexPath(args.channelFolderPath);
  ensureInsideRoot(args.exportsRoot, cacheFolderPath);
  ensureInsideRoot(args.exportsRoot, indexPath);
  return { cacheFolderPath, indexPath };
}

export function resolveCacheArtifactRelativePath(args: {
  channelFolderPath: string;
  artifactAbsolutePath: string;
}): string {
  return toSafeRelativePath(args.channelFolderPath, args.artifactAbsolutePath);
}
