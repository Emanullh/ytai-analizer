import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { env } from "../config/env.js";
import type { JobLogger, JobLogScope } from "../observability/jobLogger.js";
import { newStepId } from "../observability/ids.js";
import { ExportPayload, Timeframe, TimeframeResolved } from "../types.js";
import {
  getChannelDetails,
  getSelectedVideoDetails,
  getVideoDetails,
  YoutubeChannelStats,
  YoutubeThumbnail,
  YoutubeVideoDetails
} from "./youtubeService.js";
import { HttpError } from "../utils/errors.js";
import { downloadToBuffer } from "../utils/http.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { fileExists } from "../utils/fileExists.js";
import { getTranscriptWithFallback } from "./transcriptPipeline.js";
import type { TranscriptPipelineResult } from "./transcriptPipeline.js";
import type { LocalAsrStage } from "./localAsrService.js";
import type { TranscriptSegment } from "./transcriptModels.js";
import { resolveTimeframeRange } from "../utils/timeframe.js";
import { loadTranscriptJsonl } from "../derived/transcriptArtifacts.js";
import {
  computePerformancePerVideo,
  type ChannelModelSummary,
  type VideoPerformanceFeatures
} from "../derived/performanceNormalization.js";
import {
  buildCacheEntry,
  checkVideoCache,
  computeHashes,
  loadCacheIndex,
  resolveCacheArtifactRelativePath,
  saveCacheIndex,
  updateVideoCacheEntry
} from "./exportCacheService.js";
import { sanitizeProjectWarnings, sanitizeVideoWarnings } from "./exportWarningSanitizer.js";
import { buildVideoPlan, validatePlan } from "./exportPlan.js";
import { createScheduler } from "./taskScheduler.js";
import { projectOperationLockService, ProjectLockError } from "./projectOperationLockService.js";
import {
  prepareVideoFeatureInputs,
  type ChannelContext as VideoFeatureChannelContext,
  type RawVideoRecord as VideoFeatureRawVideoRecord
} from "./videoFeaturePreparationService.js";
import { computeVideoFeatureArtifact } from "./videoFeatureComputeService.js";

export type ExportVideoStage =
  | "queue"
  | "downloading_audio"
  | "transcribing"
  | "downloading_thumbnail"
  | "writing_json"
  | "done"
  | "warning"
  | "failed";

export interface ExportRequest {
  channelId: string;
  channelName: string;
  sourceInput: string;
  timeframe: Timeframe;
  selectedVideoIds: string[];
  jobId?: string;
}

export interface ExportProgressCallbacks {
  onJobStarted?: (payload: { total: number }) => void;
  onVideoProgress?: (payload: { videoId: string; stage: ExportVideoStage; percent?: number }) => void;
  onJobProgress?: (payload: { completed: number; total: number }) => void;
  onWarning?: (payload: { videoId?: string; message: string }) => void;
  jobId?: string;
  jobLogger?: JobLogger;
  requestId?: string;
}

interface ExportDependencies {
  getChannelDetails: typeof getChannelDetails;
  getSelectedVideoDetails: typeof getSelectedVideoDetails;
  getVideoDetails: typeof getVideoDetails;
  downloadToBuffer: typeof downloadToBuffer;
  getTranscriptWithFallback: typeof getTranscriptWithFallback;
}

type ProcessedVideo = ExportPayload["videos"][number] & {
  warnings: string[];
  rawTranscriptArtifactPath: string;
  rawAudioArtifactPath?: string;
  derivedVideoFeaturesArtifactPath?: string;
};

interface RawChannelExportV1 {
  exportVersion: string;
  exportedAt: string;
  jobId: string;
  channelId: string;
  channelName: string;
  sourceInput: string;
  timeframe: Timeframe;
  timeframeResolved: TimeframeResolved;
  channelStats?: YoutubeChannelStats;
  provenance: {
    dataSources: string[];
    warnings: string[];
    env: {
      LOCAL_ASR_ENABLED: boolean;
      TRANSCRIPT_LANG: string | null;
    };
  };
}

interface RawVideoRecordV1 {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec: number;
  categoryId: string;
  tags: string[];
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  madeForKids: boolean;
  liveBroadcastContent: string;
  statistics: {
    viewCount: number;
    likeCount: number;
    commentCount: number;
  };
  thumbnails: Partial<Record<"default" | "medium" | "high" | "standard" | "maxres", YoutubeThumbnail>>;
  audioLocalPath?: string;
  thumbnailLocalPath: string;
  thumbnailOriginalUrl: string;
  transcriptRef: {
    transcriptPath: string;
    transcriptSource: TranscriptPipelineResult["source"];
    transcriptStatus: "ok" | "missing" | "error";
  };
  daysSincePublish: number;
  viewsPerDay: number;
  likeRate: number;
  commentRate: number;
  warnings: string[];
}

interface ExportManifestV1 {
  jobId: string;
  channelId: string;
  channelFolder: string;
  exportVersion: string;
  exportedAt: string;
  counts: {
    totalVideosSelected: number;
    transcriptsOk: number;
    transcriptsMissing: number;
    transcriptsError: number;
    thumbnailsOk: number;
    thumbnailsFailed: number;
  };
  warnings: string[];
  artifacts: string[];
}

interface ThumbnailAvailability {
  okCount: number;
  failedCount: number;
  existingVideoIds: Set<string>;
}

interface RawPaths {
  rawFolderPath: string;
  rawChannelFilePath: string;
  rawVideosFilePath: string;
  rawTranscriptsFolderPath: string;
}

interface RawPackInput {
  exportsRoot: string;
  channelFolderPath: string;
  rawPaths: RawPaths;
  thumbnailsFolderPath: string;
  processedVideos: ProcessedVideo[];
  request: ExportRequest;
  jobId: string;
  exportVersion: string;
  exportedAt: string;
  timeframeResolved: TimeframeResolved;
  warnings: string[];
  channelStats?: YoutubeChannelStats;
  transcriptArtifactPaths: string[];
  audioArtifactPaths: string[];
  existingThumbnailVideoIds: Set<string>;
}

interface RawPackOutput {
  artifactPaths: string[];
}

interface DerivedVideoFeaturesArtifactV1 {
  schemaVersion: "derived.video_features.v1";
  videoId: string;
  computedAt: string;
  performance?: VideoPerformanceFeatures;
  [key: string]: unknown;
}

interface DerivedChannelModelsArtifactV1 {
  schemaVersion: "derived.channel_models.v1";
  computedAt: string;
  channelId: string;
  timeframe: Timeframe;
  model: ChannelModelSummary;
}

export const EXPORT_VERSION = "1.1";

const defaultDependencies: ExportDependencies = {
  getChannelDetails,
  getSelectedVideoDetails,
  getVideoDetails,
  downloadToBuffer,
  getTranscriptWithFallback
};

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new HttpError(400, "Invalid export path");
  }
}

function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join(path.posix.sep);
}

function toSafeRelativePath(rootPath: string, targetPath: string): string {
  ensureInsideRoot(rootPath, targetPath);
  const relativePath = path.relative(rootPath, targetPath);
  const normalized = toPosixPath(relativePath);
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new HttpError(400, "Invalid relative artifact path");
  }
  return normalized;
}

function createRawPaths(channelFolderPath: string): RawPaths {
  const rawFolderPath = path.resolve(channelFolderPath, "raw");
  return {
    rawFolderPath,
    rawChannelFilePath: path.resolve(rawFolderPath, "channel.json"),
    rawVideosFilePath: path.resolve(rawFolderPath, "videos.jsonl"),
    rawTranscriptsFolderPath: path.resolve(rawFolderPath, "transcripts")
  };
}

async function initializeRawPaths(exportsRoot: string, rawPaths: RawPaths): Promise<void> {
  ensureInsideRoot(exportsRoot, rawPaths.rawFolderPath);
  ensureInsideRoot(exportsRoot, rawPaths.rawChannelFilePath);
  ensureInsideRoot(exportsRoot, rawPaths.rawVideosFilePath);
  ensureInsideRoot(exportsRoot, rawPaths.rawTranscriptsFolderPath);

  await fs.mkdir(rawPaths.rawTranscriptsFolderPath, { recursive: true });
  await fs.writeFile(rawPaths.rawVideosFilePath, "", "utf-8");
}

function createJsonLineAppender(filePath: string): (record: unknown) => Promise<void> {
  let chain = Promise.resolve();
  return async (record: unknown) => {
    chain = chain.then(async () => {
      await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
    });
    await chain;
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
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tempPath, targetPath);
}

function toOptionalMetricCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function toOptionalDurationSec(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

async function persistPerformanceFeaturesArtifact(args: {
  exportsRoot: string;
  channelFolderPath: string;
  videoId: string;
  computedAt: string;
  performance: VideoPerformanceFeatures;
}): Promise<string> {
  const derivedFolderPath = path.resolve(args.channelFolderPath, "derived", "video_features");
  const artifactAbsolutePath = path.resolve(derivedFolderPath, `${args.videoId}.json`);

  ensureInsideRoot(args.exportsRoot, derivedFolderPath);
  ensureInsideRoot(args.exportsRoot, artifactAbsolutePath);

  await fs.mkdir(derivedFolderPath, { recursive: true });
  const existing = await readExistingArtifact(artifactAbsolutePath);
  const mergedBundle: DerivedVideoFeaturesArtifactV1 = {
    ...(existing ?? {}),
    schemaVersion: "derived.video_features.v1",
    videoId: args.videoId,
    computedAt: args.computedAt,
    performance: args.performance
  };
  await writeJsonAtomic(artifactAbsolutePath, mergedBundle);
  return artifactAbsolutePath;
}

async function writeChannelModelsArtifact(args: {
  exportsRoot: string;
  channelFolderPath: string;
  channelId: string;
  timeframe: Timeframe;
  computedAt: string;
  model: ChannelModelSummary;
}): Promise<string> {
  const derivedFolderPath = path.resolve(args.channelFolderPath, "derived");
  const channelModelsPath = path.resolve(derivedFolderPath, "channel_models.json");

  ensureInsideRoot(args.exportsRoot, derivedFolderPath);
  ensureInsideRoot(args.exportsRoot, channelModelsPath);

  await fs.mkdir(derivedFolderPath, { recursive: true });
  const payload: DerivedChannelModelsArtifactV1 = {
    schemaVersion: "derived.channel_models.v1",
    computedAt: args.computedAt,
    channelId: args.channelId,
    timeframe: args.timeframe,
    model: args.model
  };
  await writeJsonAtomic(channelModelsPath, payload);
  return channelModelsPath;
}

function daysBetweenDates(fromIsoDate: string, toDate: Date): number {
  const fromTime = new Date(fromIsoDate).getTime();
  if (!Number.isFinite(fromTime)) {
    return 0;
  }
  const deltaMs = toDate.getTime() - fromTime;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return 0;
  }
  return Math.floor(deltaMs / 86_400_000);
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Number((numerator / denominator).toFixed(6));
}

function toTranscriptStatus(value: ProcessedVideo["transcriptStatus"]): "ok" | "missing" | "error" {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function toLanguageHint(language: string | undefined): "auto" | "en" | "es" {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) {
    return "auto";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  if (normalized.startsWith("es")) {
    return "es";
  }
  return "auto";
}

function toRelativeExportPath(channelFolderPath: string, absolutePath: string): string {
  const relative = path.relative(channelFolderPath, absolutePath).split(path.sep).join(path.posix.sep);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "<invalid>";
  }
  return relative;
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function estimateSizeBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf-8");
  } catch {
    return 0;
  }
}

function extractDomain(urlRaw: string): string | null {
  if (!urlRaw.trim()) {
    return null;
  }
  try {
    return new URL(urlRaw).hostname;
  } catch {
    return null;
  }
}

const THUMBNAIL_RESOLUTION_PRIORITY = ["maxres", "standard", "high", "medium", "default"] as const;
const THUMBNAIL_FILENAME_FALLBACKS = [
  "maxresdefault.jpg",
  "sddefault.jpg",
  "hqdefault.jpg",
  "mqdefault.jpg",
  "default.jpg"
] as const;

function pushUniqueThumbnailUrl(target: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || !value.trim()) {
    return;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return;
    }
    const normalized = parsed.toString();
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    target.push(normalized);
  } catch {
    // Ignore malformed URLs and continue with other candidates.
  }
}

function buildThumbnailCandidateUrls(args: {
  videoId: string;
  primaryUrl?: string;
  thumbnails?: Partial<Record<"default" | "medium" | "high" | "standard" | "maxres", YoutubeThumbnail>>;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  pushUniqueThumbnailUrl(candidates, seen, args.primaryUrl);
  for (const key of THUMBNAIL_RESOLUTION_PRIORITY) {
    pushUniqueThumbnailUrl(candidates, seen, args.thumbnails?.[key]?.url);
  }
  for (const filename of THUMBNAIL_FILENAME_FALLBACKS) {
    pushUniqueThumbnailUrl(candidates, seen, `https://i.ytimg.com/vi/${args.videoId}/${filename}`);
  }

  return candidates;
}

function logEvent(
  callbacks: ExportProgressCallbacks,
  input: {
    level?: "trace" | "debug" | "info" | "warn" | "error";
    scope: JobLogScope;
    action: string;
    stage?: ExportVideoStage;
    videoId?: string;
    msg: string;
    data?: Record<string, unknown>;
    stepId?: string;
  }
): string {
  const stepId = input.stepId ?? newStepId();
  callbacks.jobLogger?.event({
    level: input.level,
    stepId,
    scope: input.scope,
    action: input.action,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.videoId ? { videoId: input.videoId } : {}),
    msg: input.msg,
    data: input.data,
    requestId: callbacks.requestId
  });
  return stepId;
}

function logErrorAndWarn(
  callbacks: ExportProgressCallbacks,
  input: {
    scope: JobLogScope;
    action: string;
    stage?: ExportVideoStage;
    videoId?: string;
    err: unknown;
    msg: string;
    data?: Record<string, unknown>;
    retry?: { attempt: number; max: number; willRetry: boolean };
  }
): string {
  const stepId = newStepId();
  const errorLog = callbacks.jobLogger?.error({
    stepId,
    scope: input.scope,
    action: input.action,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.videoId ? { videoId: input.videoId } : {}),
    err: input.err,
    msg: input.msg,
    data: input.data,
    retry: input.retry,
    requestId: callbacks.requestId
  });
  const jobRef = callbacks.jobId ?? "<jobId>";
  const warningMessage = `ERR ${input.scope}/${input.action} stepId=${errorLog?.stepId ?? stepId} (see logs/job_${jobRef}.errors.jsonl)`;
  callbacks.onWarning?.({
    ...(input.videoId ? { videoId: input.videoId } : {}),
    message: warningMessage
  });
  return stepId;
}

async function collectThumbnailAvailability(
  exportsRoot: string,
  channelFolderPath: string,
  processedVideos: ProcessedVideo[]
): Promise<ThumbnailAvailability> {
  const entries = await Promise.all(
    processedVideos.map(async (video) => {
      const thumbnailAbsolutePath = path.resolve(channelFolderPath, video.thumbnailPath);
      ensureInsideRoot(exportsRoot, thumbnailAbsolutePath);
      try {
        await fs.access(thumbnailAbsolutePath);
        return { videoId: video.videoId, exists: true };
      } catch {
        return { videoId: video.videoId, exists: false };
      }
    })
  );

  const existingVideoIds = new Set(entries.filter((entry) => entry.exists).map((entry) => entry.videoId));
  return {
    okCount: existingVideoIds.size,
    failedCount: entries.length - existingVideoIds.size,
    existingVideoIds
  };
}

function buildRawVideoRecord(
  sourceVideo: { videoId: string; title: string; publishedAt: string; viewCount: number; thumbnailUrl: string },
  videoDetails: YoutubeVideoDetails | undefined,
  transcriptRef: RawVideoRecordV1["transcriptRef"],
  audioLocalPath: string | undefined,
  exportTimestamp: Date,
  warnings: string[]
): RawVideoRecordV1 {
  const publishedAt = videoDetails?.publishedAt || sourceVideo.publishedAt || "";
  const statistics = {
    viewCount: videoDetails?.statistics.viewCount ?? sourceVideo.viewCount,
    likeCount: videoDetails?.statistics.likeCount ?? 0,
    commentCount: videoDetails?.statistics.commentCount ?? 0
  };
  const daysSincePublish = daysBetweenDates(publishedAt, exportTimestamp);

  return {
    videoId: sourceVideo.videoId,
    title: videoDetails?.title || sourceVideo.title,
    description: videoDetails?.description ?? "",
    publishedAt,
    durationSec: videoDetails?.durationSec ?? 0,
    categoryId: videoDetails?.categoryId ?? "",
    tags: videoDetails?.tags ?? [],
    defaultLanguage: videoDetails?.defaultLanguage,
    defaultAudioLanguage: videoDetails?.defaultAudioLanguage,
    madeForKids: videoDetails?.madeForKids ?? false,
    liveBroadcastContent: videoDetails?.liveBroadcastContent ?? "none",
    statistics,
    thumbnails: videoDetails?.thumbnails ?? {},
    ...(audioLocalPath ? { audioLocalPath } : {}),
    thumbnailLocalPath: path.posix.join("raw", "thumbnails", `${sourceVideo.videoId}.jpg`),
    thumbnailOriginalUrl: videoDetails?.thumbnailOriginalUrl || sourceVideo.thumbnailUrl || "",
    transcriptRef,
    daysSincePublish,
    viewsPerDay: safeRatio(statistics.viewCount, Math.max(daysSincePublish, 1)),
    likeRate: safeRatio(statistics.likeCount, statistics.viewCount),
    commentRate: safeRatio(statistics.commentCount, statistics.viewCount),
    warnings: [...warnings]
  };
}

function buildPreparationVideoRecord(args: {
  sourceVideo: {
    videoId: string;
    title: string;
    publishedAt: string;
    thumbnailUrl: string;
  };
  videoDetails: YoutubeVideoDetails | undefined;
  transcriptRef: {
    transcriptPath: string;
    transcriptSource: TranscriptPipelineResult["source"];
    transcriptStatus: "ok" | "missing" | "error";
  };
}): VideoFeatureRawVideoRecord {
  return {
    videoId: args.sourceVideo.videoId,
    title: args.videoDetails?.title || args.sourceVideo.title,
    description: args.videoDetails?.description ?? "",
    publishedAt: args.videoDetails?.publishedAt ?? args.sourceVideo.publishedAt ?? null,
    durationSec: args.videoDetails?.durationSec,
    defaultLanguage: args.videoDetails?.defaultLanguage,
    defaultAudioLanguage: args.videoDetails?.defaultAudioLanguage,
    thumbnailLocalPath: path.posix.join("raw", "thumbnails", `${args.sourceVideo.videoId}.jpg`),
    thumbnailOriginalUrl: args.videoDetails?.thumbnailOriginalUrl || args.sourceVideo.thumbnailUrl || undefined,
    thumbnails: args.videoDetails?.thumbnails,
    transcriptRef: args.transcriptRef
  };
}

async function ensureRawThumbnailsPath(
  exportsRoot: string,
  rawFolderPath: string,
  thumbnailsFolderPath: string,
  channelFolderPath: string,
  processedVideos: ProcessedVideo[]
): Promise<void> {
  const rawThumbnailsPath = path.resolve(rawFolderPath, "thumbnails");
  ensureInsideRoot(exportsRoot, rawThumbnailsPath);
  await fs.rm(rawThumbnailsPath, { recursive: true, force: true });

  const symlinkTarget = path.relative(path.dirname(rawThumbnailsPath), thumbnailsFolderPath);
  try {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    await fs.symlink(symlinkTarget, rawThumbnailsPath, symlinkType);
    return;
  } catch {
    await fs.mkdir(rawThumbnailsPath, { recursive: true });
  }

  await Promise.all(
    processedVideos.map(async (video) => {
      const sourcePath = path.resolve(channelFolderPath, video.thumbnailPath);
      const destinationPath = path.resolve(rawThumbnailsPath, `${video.videoId}.jpg`);
      ensureInsideRoot(exportsRoot, sourcePath);
      ensureInsideRoot(exportsRoot, destinationPath);

      try {
        await fs.copyFile(sourcePath, destinationPath);
      } catch {
        // Thumbnail may be missing when download failed; skip and surface in manifest counts.
      }
    })
  );
}

async function writeRawPack(input: RawPackInput): Promise<RawPackOutput> {
  ensureInsideRoot(input.exportsRoot, input.rawPaths.rawFolderPath);
  ensureInsideRoot(input.exportsRoot, input.rawPaths.rawChannelFilePath);
  ensureInsideRoot(input.exportsRoot, input.rawPaths.rawVideosFilePath);
  ensureInsideRoot(input.exportsRoot, input.rawPaths.rawTranscriptsFolderPath);
  await ensureRawThumbnailsPath(
    input.exportsRoot,
    input.rawPaths.rawFolderPath,
    input.thumbnailsFolderPath,
    input.channelFolderPath,
    input.processedVideos
  );

  const rawChannel: RawChannelExportV1 = {
    exportVersion: input.exportVersion,
    exportedAt: input.exportedAt,
    jobId: input.jobId,
    channelId: input.request.channelId,
    channelName: input.request.channelName,
    sourceInput: input.request.sourceInput,
    timeframe: input.request.timeframe,
    timeframeResolved: input.timeframeResolved,
    channelStats: input.channelStats,
    provenance: {
      dataSources: ["youtube-data-api-v3", "youtube-thumbnail-http", "local-asr"],
      warnings: [...input.warnings],
      env: {
        LOCAL_ASR_ENABLED: env.localAsrEnabled,
        TRANSCRIPT_LANG: env.transcriptLang ?? null
      }
    }
  };

  await fs.writeFile(input.rawPaths.rawChannelFilePath, JSON.stringify(rawChannel, null, 2), "utf-8");

  const rawThumbnailArtifacts = Array.from(input.existingThumbnailVideoIds, (videoId) =>
    path.resolve(input.rawPaths.rawFolderPath, "thumbnails", `${videoId}.jpg`)
  );

  return {
    artifactPaths: [
      input.rawPaths.rawChannelFilePath,
      input.rawPaths.rawVideosFilePath,
      ...input.transcriptArtifactPaths,
      ...input.audioArtifactPaths,
      ...rawThumbnailArtifacts
    ]
  };
}

function fallbackTranscriptResult(videoId: string, error: unknown): TranscriptPipelineResult {
  return {
    transcript: "",
    status: "error",
    source: "none",
    warning: `Transcript pipeline failed for video ${videoId}: ${error instanceof Error ? error.message : "unknown error"}`
  };
}

interface TranscriptSnapshot {
  transcript: string;
  status: "ok" | "missing" | "error";
  source: TranscriptPipelineResult["source"];
  warning?: string;
  language?: string;
  segments: TranscriptSegment[];
}

async function readTranscriptSnapshot(
  transcriptArtifactPath: string,
  videoId: string
): Promise<TranscriptSnapshot | null> {
  const artifact = await loadTranscriptJsonl(transcriptArtifactPath, { videoId });
  if (artifact.usedFallback) {
    return null;
  }

  const transcript = artifact.segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  const status = artifact.meta?.status ?? (transcript ? "ok" : "missing");
  const source = artifact.meta?.source ?? "none";

  return {
    transcript,
    status,
    source,
    warning: artifact.meta?.warning,
    language: artifact.meta?.language,
    segments: artifact.segments.map((segment) => ({
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text,
      confidence: segment.confidence
    }))
  };
}

export async function exportSelectedVideos(
  request: ExportRequest,
  callbacks: ExportProgressCallbacks = {},
  dependencies: ExportDependencies = defaultDependencies
): Promise<{ folderPath: string; warnings: string[]; exportedCount: number }> {
  const folderName = sanitizeFolderName(request.channelName);
  const jobId = request.jobId ?? randomUUID();
  try {
    projectOperationLockService.acquireOrThrow({
      projectId: folderName,
      operation: "export",
      ownerId: jobId
    });
  } catch (error) {
    if (error instanceof ProjectLockError) {
      throw new HttpError(
        409,
        `Project is busy with ${error.conflict.currentOperation} (${error.conflict.currentOwnerId}). Try again later.`
      );
    }
    throw error;
  }

  const jobStepId = logEvent(callbacks, {
    scope: "exportService",
    action: "export_start",
    msg: "Export started",
    data: {
      channelId: request.channelId,
      selectedVideoIds: request.selectedVideoIds.length,
      timeframe: request.timeframe
    }
  });
  const warnings: string[] = [];
  const addWarning = (message: string, videoId?: string) => {
    warnings.push(message);
    logEvent(callbacks, {
      level: "warn",
      scope: "exportService",
      action: "warning",
      ...(videoId ? { videoId } : {}),
      msg: message
    });
    callbacks.onWarning?.({ videoId, message });
  };
  const emitInfo = (message: string, videoId?: string) => {
    logEvent(callbacks, {
      level: "info",
      scope: "exportService",
      action: "info",
      ...(videoId ? { videoId } : {}),
      msg: message
    });
    callbacks.onWarning?.({ videoId, message });
  };

  const exportsRoot = path.resolve(process.cwd(), "exports");
  const exportedAt = new Date().toISOString();
  const exportedAtDate = new Date(exportedAt);
  const timeframeResolved = resolveTimeframeRange(request.timeframe);
  const scheduler = createScheduler({
    video: env.exportVideoConcurrency,
    http: env.exportHttpConcurrency,
    asr: env.exportAsrConcurrency,
    ocr: env.exportOcrConcurrency,
    llm: env.exportLlmConcurrency,
    embeddings: env.exportEmbeddingsConcurrency,
    fs: env.exportFsConcurrency
  });
  const channelFolderPath = path.resolve(exportsRoot, folderName);
  const thumbnailsFolderPath = path.resolve(channelFolderPath, "thumbnails");
  const tempRootPath = path.resolve(exportsRoot, ".tmp", jobId);
  const rawPaths = createRawPaths(channelFolderPath);

  try {
    logEvent(callbacks, {
      scope: "youtube",
      action: "selected_videos_fetch_start",
      stepId: jobStepId,
      msg: "Fetching selected videos metadata"
    });
    const details = await dependencies.getSelectedVideoDetails(request.channelId, request.timeframe, request.selectedVideoIds);
    logEvent(callbacks, {
      scope: "youtube",
      action: "selected_videos_fetch_done",
      msg: "Selected videos metadata fetched",
      data: { total: details.videos.length, warnings: details.warnings.length }
    });
    for (const warning of details.warnings) {
      addWarning(warning);
    }

    if (!details.videos.length) {
      throw new HttpError(400, "No selected videos found to export");
    }

    ensureInsideRoot(exportsRoot, channelFolderPath);
    ensureInsideRoot(exportsRoot, thumbnailsFolderPath);
    ensureInsideRoot(exportsRoot, tempRootPath);

  logEvent(callbacks, {
    scope: "exportService",
    action: "scheduler_config",
    msg: "Export scheduler configured",
    data: {
      limits: scheduler.limits,
      failFast: env.exportFailFast
    }
  });

  await scheduler.run("fs", async () => {
    await fs.mkdir(thumbnailsFolderPath, { recursive: true });
  });
  logEvent(callbacks, {
    scope: "fs",
    action: "raw_write_start",
    msg: "Initializing raw export paths",
    data: { rawFolder: toRelativeExportPath(channelFolderPath, rawPaths.rawFolderPath) }
  });
  await scheduler.run("fs", () => initializeRawPaths(exportsRoot, rawPaths));
  logEvent(callbacks, {
    scope: "fs",
    action: "raw_write_done",
    msg: "Raw export paths ready"
  });
  logEvent(callbacks, {
    scope: "cache",
    action: "cache_check_start",
    msg: "Loading cache index"
  });
  const cacheIndex = await scheduler.run("fs", () =>
    loadCacheIndex({
      exportsRoot,
      channelFolderPath,
      channelId: request.channelId,
      exportVersion: EXPORT_VERSION
    })
  );
  logEvent(callbacks, {
    scope: "cache",
    action: "cache_check_done",
    msg: "Cache index loaded"
  });
  let cacheSaveChain = Promise.resolve();
  const enqueueCacheEntryUpdate = async (videoId: string, entry: ReturnType<typeof buildCacheEntry>) => {
    cacheSaveChain = cacheSaveChain.then(async () => {
      updateVideoCacheEntry({
        index: cacheIndex,
        timeframe: request.timeframe,
        videoId,
        entry
      });
      await scheduler.run("fs", () =>
        saveCacheIndex({
          exportsRoot,
          channelFolderPath,
          index: cacheIndex
        })
      );
    });
    await cacheSaveChain;
  };

  const [videoDetailsResult, channelDetailsResult] = await Promise.all([
    dependencies.getVideoDetails(details.videos.map((video) => video.videoId)),
    dependencies.getChannelDetails(request.channelId)
  ]);
  logEvent(callbacks, {
    scope: "youtube",
    action: "video_details_done",
    msg: "Video/channel enrichment fetched",
    data: {
      videos: videoDetailsResult.videos.length,
      videoWarnings: videoDetailsResult.warnings.length,
      channelWarnings: channelDetailsResult.warnings.length
    }
  });
  for (const warning of videoDetailsResult.warnings) {
    addWarning(warning);
  }
  for (const warning of channelDetailsResult.warnings) {
    addWarning(warning);
  }
  const videoDetailsById = new Map(videoDetailsResult.videos.map((video) => [video.videoId, video]));
  const appendRawVideoRecord = createJsonLineAppender(rawPaths.rawVideosFilePath);
  const featureChannelContext: VideoFeatureChannelContext = {
    projectRoot: channelFolderPath,
    exportsRoot,
    channelId: request.channelId,
    exportVersion: EXPORT_VERSION,
    timeframe: request.timeframe
  };

    callbacks.onJobStarted?.({ total: details.videos.length });
    for (const video of details.videos) {
      callbacks.onVideoProgress?.({
        videoId: video.videoId,
        stage: "queue"
      });
    }

    const processedVideos = await Promise.all(
      details.videos.map((video) =>
        scheduler.runVideo(video.videoId, async (): Promise<ProcessedVideo> => {
        const videoWarnings: string[] = [];
        const videoStageTimingsMs: Record<string, number> = {};
        const videoStartedAtMs = Date.now();
        const markStageTiming = (stageName: string, startedAtMs: number): void => {
          videoStageTimingsMs[stageName] = Number(
            ((videoStageTimingsMs[stageName] ?? 0) + elapsedMs(startedAtMs)).toFixed(3)
          );
        };

        logEvent(callbacks, {
          scope: "exportService",
          action: "video_start",
          videoId: video.videoId,
          stage: "queue",
          msg: "Video export started",
          data: {
            title: video.title,
            publishedAt: video.publishedAt
          }
        });
        const enrichedVideo = videoDetailsById.get(video.videoId);
        if (!enrichedVideo) {
          const warning = `Metadata enrichment missing for ${video.videoId}`;
          videoWarnings.push(warning);
          addWarning(warning, video.videoId);
        }

        const thumbnailRelativePath = path.posix.join("thumbnails", `${video.videoId}.jpg`);
        const thumbnailAbsolutePath = path.resolve(channelFolderPath, thumbnailRelativePath);
        const transcriptAbsolutePath = path.resolve(rawPaths.rawTranscriptsFolderPath, `${video.videoId}.jsonl`);
        const transcriptRelativePath = path.posix.join("raw", "transcripts", `${video.videoId}.jsonl`);

        ensureInsideRoot(exportsRoot, thumbnailAbsolutePath);
        ensureInsideRoot(exportsRoot, transcriptAbsolutePath);
        const titleForFeatures = enrichedVideo?.title || video.title;
        const descriptionForFeatures = enrichedVideo?.description ?? "";
        logEvent(callbacks, {
          scope: "cache",
          action: "cache_check_start",
          videoId: video.videoId,
          msg: "Checking cache for video"
        });
        let transcriptSnapshot: TranscriptSnapshot | null = null;
        try {
          transcriptSnapshot = await readTranscriptSnapshot(transcriptAbsolutePath, video.videoId);
        } catch (error) {
          logErrorAndWarn(callbacks, {
            scope: "transcript",
            action: "transcript_snapshot_read",
            stage: "transcribing",
            videoId: video.videoId,
            err: error,
            msg: "Failed to read transcript snapshot"
          });
          throw error;
        }
        const initialHashes = await computeHashes({
          title: titleForFeatures,
          description: descriptionForFeatures,
          transcriptText: transcriptSnapshot?.transcript ?? "",
          transcriptSource: transcriptSnapshot?.source ?? "none",
          thumbnailFilePath: thumbnailAbsolutePath
        });
        const cacheCheck = await checkVideoCache({
          exportsRoot,
          channelFolderPath,
          index: cacheIndex,
          timeframe: request.timeframe,
          videoId: video.videoId,
          currentHashes: initialHashes
        });
        if (cacheCheck.hit === "full") {
          logEvent(callbacks, {
            scope: "cache",
            action: "cache_hit_full",
            videoId: video.videoId,
            msg: "Cache hit full",
            data: {
              reasons: cacheCheck.reasons,
              invalidationFlags: cacheCheck.reasons,
              willCompute: cacheCheck.plan
            }
          });
        } else if (cacheCheck.hit === "partial") {
          logEvent(callbacks, {
            scope: "cache",
            action: "cache_hit_partial",
            videoId: video.videoId,
            msg: "Cache hit partial",
            data: {
              reasons: cacheCheck.reasons,
              invalidationFlags: cacheCheck.reasons,
              willCompute: cacheCheck.plan
            }
          });
        } else {
          logEvent(callbacks, {
            scope: "cache",
            action: "cache_miss",
            videoId: video.videoId,
            msg: "Cache miss",
            data: {
              reasons: cacheCheck.reasons,
              invalidationFlags: cacheCheck.reasons,
              willCompute: cacheCheck.plan
            }
          });
        }
        let cacheEntryForPersist = buildCacheEntry({
          videoId: video.videoId,
          hashes: initialHashes,
          artifacts: {
            rawTranscriptPath: cacheCheck.artifacts.rawTranscriptPath,
            thumbnailPath: cacheCheck.artifacts.thumbnailPath,
            derivedVideoFeaturesPath: cacheCheck.artifacts.derivedVideoFeaturesPath
          },
          status: {
            rawTranscript: transcriptSnapshot?.status ?? "missing",
            thumbnail: cacheCheck.artifacts.thumbnailExists ? "ok" : "failed",
            derived: cacheCheck.artifacts.derivedExists ? "partial" : "error",
            warnings: []
          }
        });
        const videoPlanTasks = buildVideoPlan({
          videoId: video.videoId,
          cacheHit: cacheCheck.hit,
          cachePlan: cacheCheck.plan,
          artifacts: {
            rawTranscriptExists: cacheCheck.artifacts.rawTranscriptExists,
            thumbnailExists: cacheCheck.artifacts.thumbnailExists
          },
          strategy: {
            titleWaitForTranscript: true
          }
        });
        const videoPlanValidation = validatePlan({
          tasks: videoPlanTasks,
          limits: {
            http: scheduler.limits.http,
            asr: scheduler.limits.asr,
            ocr: scheduler.limits.ocr,
            llm: scheduler.limits.llm,
            embeddings: scheduler.limits.embeddings,
            fs: scheduler.limits.fs
          }
        });
        const runVideoPipelineInParallel = videoPlanValidation.ok;
        logEvent(callbacks, {
          scope: "exportService",
          action: "video_plan",
          videoId: video.videoId,
          msg: "Video execution plan prepared",
          data: {
            cacheHit: cacheCheck.hit,
            parallelMode: runVideoPipelineInParallel,
            summary: videoPlanValidation.summary,
            warnings: videoPlanValidation.warnings
          }
        });
        if (!videoPlanValidation.ok) {
          const warning = `Plan validation failed for ${video.videoId}; switching to sequential mode: ${videoPlanValidation.errors.join(
            "; "
          )}`;
          videoWarnings.push(warning);
          addWarning(warning, video.videoId);
        }
        for (const warning of videoPlanValidation.warnings) {
          addWarning(`Plan warning for ${video.videoId}: ${warning}`, video.videoId);
        }

        try {
          if (cacheCheck.hit === "full") {
            emitInfo("cache hit: reused transcript/thumbnail/derived", video.videoId);
          } else if (cacheCheck.hit === "partial") {
            emitInfo(`cache partial: ${cacheCheck.reasons.join(", ") || "recompute required fields only"}`, video.videoId);
          }

          const needTranscriptPreparation = cacheCheck.plan.needTranscriptFetch || !cacheCheck.artifacts.rawTranscriptExists || !transcriptSnapshot;
          const audioRelativePath = path.posix.join("raw", "audio", `${video.videoId}.mp3`);
          const audioAbsolutePath = path.resolve(channelFolderPath, audioRelativePath);
          ensureInsideRoot(exportsRoot, audioAbsolutePath);

          const preparationVideo = buildPreparationVideoRecord({
            sourceVideo: video,
            videoDetails: enrichedVideo,
            transcriptRef: {
              transcriptPath: transcriptRelativePath,
              transcriptSource: transcriptSnapshot?.source ?? "none",
              transcriptStatus: transcriptSnapshot?.status ?? "missing"
            }
          });

          const runTranscriptTask = async (): Promise<{
            transcriptText: string;
            transcriptStatus: "ok" | "missing" | "error";
            transcriptSource: TranscriptPipelineResult["source"];
            transcriptPath: string;
            transcriptSegments: TranscriptSegment[];
            languageHint: "auto" | "en" | "es";
            audioLocalPath: string | null;
          }> => {
            if (!needTranscriptPreparation) {
              return {
                transcriptText: transcriptSnapshot?.transcript ?? "",
                transcriptStatus: transcriptSnapshot?.status ?? "missing",
                transcriptSource: transcriptSnapshot?.source ?? "none",
                transcriptPath: transcriptRelativePath,
                transcriptSegments: transcriptSnapshot?.segments ?? [],
                languageHint: toLanguageHint(transcriptSnapshot?.language),
                audioLocalPath: (await fileExists(audioAbsolutePath)) ? audioRelativePath : null
              };
            }

            const transcriptStartedAtMs = Date.now();
            const transcriptStepId = logEvent(callbacks, {
              scope: "transcript",
              action: "transcript_start",
              videoId: video.videoId,
              stage: "transcribing",
              msg: "Transcript stage started"
            });
            logEvent(callbacks, {
              stepId: transcriptStepId,
              scope: "transcript",
              action: "transcript_attempt",
              videoId: video.videoId,
              stage: "transcribing",
              msg: "Preparing transcript asset via shared transcript prestep"
            });
            logEvent(callbacks, {
              scope: "asr",
              action: "asr_attempt",
              videoId: video.videoId,
              stage: "transcribing",
              msg: env.localAsrEnabled ? "Local ASR requested" : "Local ASR requested but disabled"
            });

            let asrWorkerRequestId: string | null = null;
            const rawWriteStartedAt = Date.now();
            logEvent(callbacks, {
              scope: "fs",
              action: "raw_write_start",
              videoId: video.videoId,
              stage: "writing_json",
              msg: "Preparing transcript artifact with shared prestep",
              data: {
                path: transcriptRelativePath
              }
            });

            try {
              const preparedTranscript = await scheduler.run("asr", () =>
                prepareVideoFeatureInputs({
                  context: featureChannelContext,
                  video: preparationVideo,
                  feature: "transcript",
                  mode: "prepare",
                  createdAt: exportedAt,
                  dependencies: {
                    getTranscriptWithFallback: dependencies.getTranscriptWithFallback
                  },
                  onLocalAsrStage: (stage: LocalAsrStage) => {
                    callbacks.onVideoProgress?.({
                      videoId: video.videoId,
                      stage
                    });
                    logEvent(callbacks, {
                      scope: "asr",
                      action: stage === "downloading_audio" ? "asr_download_audio" : "asr_transcribe",
                      videoId: video.videoId,
                      stage,
                      msg: `ASR stage: ${stage}`
                    });
                  },
                  onLocalAsrWorkerRequestId: (workerRequestId) => {
                    asrWorkerRequestId = workerRequestId;
                    logEvent(callbacks, {
                      scope: "asr",
                      action: "asr_request",
                      videoId: video.videoId,
                      stage: "transcribing",
                      msg: "ASR worker request mapped",
                      data: {
                        workerRequestId,
                        stepId: transcriptStepId
                      }
                    });
                  }
                })
              );

              logEvent(callbacks, {
                scope: "fs",
                action: "raw_write_done",
                videoId: video.videoId,
                stage: "writing_json",
                msg: "Transcript artifact prepared",
                data: {
                  path: transcriptRelativePath,
                  ms: elapsedMs(rawWriteStartedAt)
                }
              });
              markStageTiming("raw_write_transcript", rawWriteStartedAt);

              logEvent(callbacks, {
                scope: "asr",
                action: "asr_result",
                videoId: video.videoId,
                stage: "transcribing",
                msg: "ASR result",
                data: {
                  workerRequestId: asrWorkerRequestId,
                  transcriptSource: preparedTranscript.transcriptSource,
                  transcriptStatus: preparedTranscript.transcriptStatus
                }
              });
              logEvent(callbacks, {
                stepId: transcriptStepId,
                scope: "transcript",
                action: "transcript_result",
                videoId: video.videoId,
                stage: "transcribing",
                msg: "Transcript stage finished",
                data: {
                  transcriptSource: preparedTranscript.transcriptSource,
                  transcriptStatus: preparedTranscript.transcriptStatus,
                  segmentsCount: preparedTranscript.transcriptSegments.length,
                  transcriptLen: preparedTranscript.transcriptText.length,
                  ms: elapsedMs(transcriptStartedAtMs),
                  stepsExecuted: preparedTranscript.stepsExecuted
                }
              });
              markStageTiming("transcript", transcriptStartedAtMs);

              for (const warning of preparedTranscript.warnings) {
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }

              return {
                transcriptText: preparedTranscript.transcriptText,
                transcriptStatus: preparedTranscript.transcriptStatus,
                transcriptSource: preparedTranscript.transcriptSource,
                transcriptPath: preparedTranscript.transcriptPath,
                transcriptSegments: preparedTranscript.transcriptSegments,
                languageHint: preparedTranscript.languageHint,
                audioLocalPath: preparedTranscript.preparedAssets.audioPath
              };
            } catch (error) {
              logErrorAndWarn(callbacks, {
                scope: "transcript",
                action: "transcript_fetch_failed",
                stage: "transcribing",
                videoId: video.videoId,
                err: error,
                msg: "Shared transcript prestep failed",
                retry: {
                  attempt: 1,
                  max: 1,
                  willRetry: false
                }
              });
              if (env.exportFailFast) {
                throw error;
              }
              const fallback = fallbackTranscriptResult(video.videoId, error);
              if (fallback.warning) {
                videoWarnings.push(fallback.warning);
                addWarning(fallback.warning, video.videoId);
              }
              markStageTiming("transcript", transcriptStartedAtMs);
              return {
                transcriptText: "",
                transcriptStatus: toTranscriptStatus(fallback.status),
                transcriptSource: fallback.source,
                transcriptPath: transcriptRelativePath,
                transcriptSegments: [],
                languageHint: "auto",
                audioLocalPath: (await fileExists(audioAbsolutePath)) ? audioRelativePath : null
              };
            }
          };

          const runThumbnailPreparationTask = async (): Promise<{ thumbnailPath: string }> => {
            if (!cacheCheck.plan.needThumbnailDownload) {
              return {
                thumbnailPath: thumbnailRelativePath
              };
            }

            const thumbnailStartedAtMs = Date.now();
            callbacks.onVideoProgress?.({
              videoId: video.videoId,
              stage: "downloading_thumbnail"
            });
            logEvent(callbacks, {
              scope: "youtube",
              action: "thumbnail_download_start",
              videoId: video.videoId,
              stage: "downloading_thumbnail",
              msg: "Collecting thumbnail asset through shared prestep",
              data: {
                urlDomain: extractDomain(enrichedVideo?.thumbnailOriginalUrl || video.thumbnailUrl),
                path: thumbnailRelativePath
              }
            });

            try {
              const preparedThumbnail = await scheduler.run("http", () =>
                prepareVideoFeatureInputs({
                  context: featureChannelContext,
                  video: preparationVideo,
                  feature: "thumbnail",
                  mode: "collect_assets",
                  dependencies: {
                    downloadToBuffer: dependencies.downloadToBuffer
                  }
                })
              );

              logEvent(callbacks, {
                scope: "youtube",
                action: "thumbnail_download_done",
                videoId: video.videoId,
                stage: "downloading_thumbnail",
                msg: "Thumbnail asset ready",
                data: {
                  path: preparedThumbnail.thumbnailPath,
                  ms: elapsedMs(thumbnailStartedAtMs),
                  stepsExecuted: preparedThumbnail.stepsExecuted
                }
              });
              markStageTiming("thumbnail_download", thumbnailStartedAtMs);
              for (const warning of preparedThumbnail.warnings) {
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }

              return {
                thumbnailPath: preparedThumbnail.thumbnailPath
              };
            } catch (error) {
              logErrorAndWarn(callbacks, {
                scope: "youtube",
                action: "download_thumbnail",
                stage: "downloading_thumbnail",
                videoId: video.videoId,
                err: error,
                msg: "Shared thumbnail prestep failed"
              });
              if (env.exportFailFast) {
                throw error;
              }
              const warning = `Thumbnail download failed for ${video.videoId}: ${
                error instanceof Error ? error.message : "unknown error"
              }`;
              videoWarnings.push(warning);
              addWarning(warning, video.videoId);
              return {
                thumbnailPath: thumbnailRelativePath
              };
            }
          };

          const thumbnailPreparationPromise = runVideoPipelineInParallel ? runThumbnailPreparationTask() : null;
          let preparedTranscript!: Awaited<ReturnType<typeof runTranscriptTask>>;
          let preparedThumbnail: Awaited<ReturnType<typeof runThumbnailPreparationTask>> = {
            thumbnailPath: thumbnailRelativePath
          };
          try {
            preparedTranscript = await runTranscriptTask();
          } finally {
            if (thumbnailPreparationPromise) {
              preparedThumbnail = await thumbnailPreparationPromise;
            } else {
              preparedThumbnail = await runThumbnailPreparationTask();
            }
          }

          const effectiveThumbnailRelativePath = preparedThumbnail.thumbnailPath;
          const effectiveThumbnailAbsolutePath = path.resolve(channelFolderPath, effectiveThumbnailRelativePath);
          ensureInsideRoot(exportsRoot, effectiveThumbnailAbsolutePath);
          const transcriptStatus = preparedTranscript.transcriptStatus;

          callbacks.onVideoProgress?.({
            videoId: video.videoId,
            stage: "writing_json",
            percent: 62
          });

          const derivedArtifactAbsolutePath = path.resolve(
            channelFolderPath,
            cacheCheck.artifacts.derivedVideoFeaturesPath
          );
          ensureInsideRoot(exportsRoot, derivedArtifactAbsolutePath);
          let derivedVideoFeaturesArtifactPath: string | undefined = cacheCheck.artifacts.derivedExists
            ? derivedArtifactAbsolutePath
            : undefined;
          const languageHint = preparedTranscript.languageHint;

          if (cacheCheck.plan.needDerivedParts.thumbnailDeterministic || cacheCheck.plan.needDerivedParts.thumbnailLlm) {
            const thumbnailAccessibleForFeatures = await fileExists(effectiveThumbnailAbsolutePath);
            if (!thumbnailAccessibleForFeatures) {
              const warning = `Thumbnail features skipped for ${video.videoId}: thumbnail file is not accessible (${effectiveThumbnailAbsolutePath})`;
              videoWarnings.push(warning);
              addWarning(warning, video.videoId);
            } else {
              const thumbnailFeaturesStartedAt = Date.now();
              if (cacheCheck.plan.needDerivedParts.thumbnailDeterministic && env.thumbOcrEnabled) {
                logEvent(callbacks, {
                  scope: "ocr",
                  action: "ocr_start",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "OCR started"
                });
              }
              const thumbnailTaskStepId = cacheCheck.plan.needDerivedParts.thumbnailLlm
                ? logEvent(callbacks, {
                    scope: "autogen",
                    action: "autogen_task_start",
                    videoId: video.videoId,
                    stage: "writing_json",
                    msg: "AutoGen thumbnail task started",
                    data: {
                      taskName: "thumbnail",
                      model: env.autoGenModelThumbnail,
                      reasoningEffort: env.autoGenReasoningEffort,
                      inputBytes: estimateSizeBytes({
                        title: titleForFeatures,
                        thumbnailLocalPath: effectiveThumbnailRelativePath
                      })
                    }
                  })
                : null;
              const thumbnailTaskType =
                cacheCheck.plan.needDerivedParts.thumbnailLlm
                  ? "llm"
                  : cacheCheck.plan.needDerivedParts.thumbnailDeterministic && env.thumbOcrEnabled
                    ? "ocr"
                    : "fs";
              try {
                const derived = await scheduler.run(thumbnailTaskType, () =>
                  computeVideoFeatureArtifact({
                    feature: "thumbnail",
                    exportsRoot,
                    channelFolderPath,
                    videoId: video.videoId,
                    title: titleForFeatures,
                    thumbnailAbsPath: effectiveThumbnailAbsolutePath,
                    thumbnailLocalPath: effectiveThumbnailRelativePath,
                    thumbnailCompute: {
                      deterministic: cacheCheck.plan.needDerivedParts.thumbnailDeterministic,
                      deterministicMode: cacheCheck.plan.needDerivedParts.thumbnailDeterministicMode,
                      llm: cacheCheck.plan.needDerivedParts.thumbnailLlm
                    },
                    trace: thumbnailTaskStepId
                      ? {
                          thumbnail: {
                            onAutoGenWorkerRequestId: (workerRequestId) => {
                              logEvent(callbacks, {
                                scope: "autogen",
                                action: "worker_request_map",
                                videoId: video.videoId,
                                stage: "writing_json",
                                msg: "Mapped AutoGen worker request",
                                data: {
                                  workerRequestId,
                                  stepId: thumbnailTaskStepId
                                }
                              });
                            }
                          }
                        }
                      : undefined
                  })
                );
                derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;
                if (cacheCheck.plan.needDerivedParts.thumbnailDeterministic && env.thumbOcrEnabled) {
                  logEvent(callbacks, {
                    scope: "ocr",
                    action: "ocr_done",
                    videoId: video.videoId,
                    stage: "writing_json",
                    msg: "OCR finished",
                    data: {
                      ms: elapsedMs(thumbnailFeaturesStartedAt)
                    }
                  });
                }
                if (thumbnailTaskStepId) {
                  logEvent(callbacks, {
                    stepId: thumbnailTaskStepId,
                    scope: "autogen",
                    action: "autogen_task_done",
                    videoId: video.videoId,
                    stage: "writing_json",
                    msg: "AutoGen thumbnail task finished",
                    data: {
                      taskName: "thumbnail",
                      model: env.autoGenModelThumbnail,
                      reasoningEffort: env.autoGenReasoningEffort,
                      inputBytes: estimateSizeBytes({
                        title: titleForFeatures,
                        thumbnailLocalPath: effectiveThumbnailRelativePath
                      }),
                      ms: elapsedMs(thumbnailFeaturesStartedAt),
                      ok: true
                    }
                  });
                }
                markStageTiming("thumbnail_features", thumbnailFeaturesStartedAt);

                for (const warning of derived.warnings) {
                  videoWarnings.push(warning);
                  addWarning(warning, video.videoId);
                }
              } catch (error) {
                logErrorAndWarn(callbacks, {
                  scope: "ocr",
                  action: "thumbnail_features",
                  stage: "writing_json",
                  videoId: video.videoId,
                  err: error,
                  msg: "Thumbnail features generation failed"
                });
                if (env.exportFailFast) {
                  throw error;
                }
                if (thumbnailTaskStepId) {
                  logEvent(callbacks, {
                    stepId: thumbnailTaskStepId,
                    scope: "autogen",
                    action: "autogen_task_done",
                    videoId: video.videoId,
                    stage: "writing_json",
                    msg: "AutoGen thumbnail task failed",
                    data: {
                      taskName: "thumbnail",
                      model: env.autoGenModelThumbnail,
                      reasoningEffort: env.autoGenReasoningEffort,
                      inputBytes: estimateSizeBytes({
                        title: titleForFeatures,
                        thumbnailLocalPath: effectiveThumbnailRelativePath
                      }),
                      ms: elapsedMs(thumbnailFeaturesStartedAt),
                      ok: false
                    }
                  });
                }
                const warning = `Thumbnail features generation failed for ${video.videoId}: ${
                  error instanceof Error ? error.message : "unknown error"
                }`;
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }
            }
          }

          callbacks.onVideoProgress?.({
            videoId: video.videoId,
            stage: "writing_json",
            percent: 70
          });

          if (cacheCheck.plan.needDerivedParts.titleDeterministic || cacheCheck.plan.needDerivedParts.titleLlm) {
            const titleFeaturesStartedAt = Date.now();
            const willComputeEmbeddings = cacheCheck.plan.needDerivedParts.titleDeterministic && Boolean(env.openAiApiKey);
            const titleTaskType =
              cacheCheck.plan.needDerivedParts.titleLlm
                ? "llm"
                : willComputeEmbeddings
                  ? "embeddings"
                  : "fs";
            if (willComputeEmbeddings) {
              logEvent(callbacks, {
                scope: "embeddings",
                action: "embeddings_start",
                videoId: video.videoId,
                stage: "writing_json",
                msg: "Embeddings computation started",
                data: {
                  model: "text-embedding-3-small",
                  inputChars: titleForFeatures.length + preparedTranscript.transcriptText.length
                }
              });
            }
            try {
              const derived = await scheduler.run(titleTaskType, () =>
                computeVideoFeatureArtifact({
                  feature: "title",
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  transcriptText: preparedTranscript.transcriptText,
                  transcriptSegments: preparedTranscript.transcriptSegments,
                  languageHint,
                  titleCompute: {
                    deterministic: cacheCheck.plan.needDerivedParts.titleDeterministic,
                    embeddings: cacheCheck.plan.needDerivedParts.titleDeterministic,
                    llm: cacheCheck.plan.needDerivedParts.titleLlm
                  }
                })
              );
              derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;
              if (willComputeEmbeddings) {
                logEvent(callbacks, {
                  scope: "embeddings",
                  action: "embeddings_done",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "Embeddings computation finished",
                  data: {
                    model: "text-embedding-3-small",
                    inputChars: titleForFeatures.length + preparedTranscript.transcriptText.length,
                    ms: elapsedMs(titleFeaturesStartedAt)
                  }
                });
              }
              markStageTiming("title_features", titleFeaturesStartedAt);

              for (const warning of derived.warnings) {
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }
            } catch (error) {
              if (willComputeEmbeddings) {
                logErrorAndWarn(callbacks, {
                  scope: "embeddings",
                  action: "embeddings_compute",
                  stage: "writing_json",
                  videoId: video.videoId,
                  err: error,
                  msg: "Embeddings/title features failed"
                });
              } else {
                logErrorAndWarn(callbacks, {
                  scope: "exportService",
                  action: "title_features",
                  stage: "writing_json",
                  videoId: video.videoId,
                  err: error,
                  msg: "Title features generation failed"
                });
              }
              if (env.exportFailFast) {
                throw error;
              }
              const warning = `Title features generation failed for ${video.videoId}: ${
                error instanceof Error ? error.message : "unknown error"
              }`;
              videoWarnings.push(warning);
              addWarning(warning, video.videoId);
            }
          }

          callbacks.onVideoProgress?.({
            videoId: video.videoId,
            stage: "writing_json",
            percent: 82
          });

          if (cacheCheck.plan.needDerivedParts.descriptionDeterministic || cacheCheck.plan.needDerivedParts.descriptionLlm) {
            const descriptionStartedAt = Date.now();
            const descriptionTaskStepId = cacheCheck.plan.needDerivedParts.descriptionLlm
              ? logEvent(callbacks, {
                  scope: "autogen",
                  action: "autogen_task_start",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "AutoGen description task started",
                  data: {
                    taskName: "description",
                    model: env.autoGenModelDescription,
                    reasoningEffort: env.autoGenReasoningEffort,
                    inputBytes: estimateSizeBytes({
                      title: titleForFeatures,
                      description: descriptionForFeatures
                    })
                  }
                })
              : null;
            const descriptionTaskType = cacheCheck.plan.needDerivedParts.descriptionLlm ? "llm" : "fs";
            try {
              const derived = await scheduler.run(descriptionTaskType, () =>
                computeVideoFeatureArtifact({
                  feature: "description",
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  description: descriptionForFeatures,
                  languageHint,
                  descriptionCompute: {
                    deterministic: cacheCheck.plan.needDerivedParts.descriptionDeterministic,
                    llm: cacheCheck.plan.needDerivedParts.descriptionLlm
                  },
                  trace: descriptionTaskStepId
                    ? {
                        description: {
                          onAutoGenWorkerRequestId: (workerRequestId) => {
                            logEvent(callbacks, {
                              scope: "autogen",
                              action: "worker_request_map",
                              videoId: video.videoId,
                              stage: "writing_json",
                              msg: "Mapped AutoGen worker request",
                              data: {
                                workerRequestId,
                                stepId: descriptionTaskStepId
                              }
                            });
                          }
                        }
                      }
                    : undefined
                })
              );
              derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;
              if (descriptionTaskStepId) {
                logEvent(callbacks, {
                  stepId: descriptionTaskStepId,
                  scope: "autogen",
                  action: "autogen_task_done",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "AutoGen description task finished",
                  data: {
                    taskName: "description",
                    model: env.autoGenModelDescription,
                    reasoningEffort: env.autoGenReasoningEffort,
                    inputBytes: estimateSizeBytes({
                      title: titleForFeatures,
                      description: descriptionForFeatures
                    }),
                    ms: elapsedMs(descriptionStartedAt),
                    ok: true
                  }
                });
              }
              markStageTiming("description_features", descriptionStartedAt);

              for (const warning of derived.warnings) {
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }
            } catch (error) {
              logErrorAndWarn(callbacks, {
                scope: "autogen",
                action: "description_features",
                stage: "writing_json",
                videoId: video.videoId,
                err: error,
                msg: "Description features generation failed"
              });
              if (env.exportFailFast) {
                throw error;
              }
              if (descriptionTaskStepId) {
                logEvent(callbacks, {
                  stepId: descriptionTaskStepId,
                  scope: "autogen",
                  action: "autogen_task_done",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "AutoGen description task failed",
                  data: {
                    taskName: "description",
                    model: env.autoGenModelDescription,
                    reasoningEffort: env.autoGenReasoningEffort,
                    inputBytes: estimateSizeBytes({
                      title: titleForFeatures,
                      description: descriptionForFeatures
                    }),
                    ms: elapsedMs(descriptionStartedAt),
                    ok: false
                  }
                });
              }
              const warning = `Description features generation failed for ${video.videoId}: ${
                error instanceof Error ? error.message : "unknown error"
              }`;
              videoWarnings.push(warning);
              addWarning(warning, video.videoId);
            }
          }

          callbacks.onVideoProgress?.({
            videoId: video.videoId,
            stage: "writing_json",
            percent: 90
          });

          if (cacheCheck.plan.needDerivedParts.transcriptDeterministic || cacheCheck.plan.needDerivedParts.transcriptLlm) {
            const transcriptFeaturesStartedAt = Date.now();
            const transcriptTaskStepId = cacheCheck.plan.needDerivedParts.transcriptLlm
              ? logEvent(callbacks, {
                  scope: "autogen",
                  action: "autogen_task_start",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "AutoGen transcript task started",
                  data: {
                    taskName: "transcript",
                    model: env.autoGenModelDescription,
                    reasoningEffort: env.autoGenReasoningEffort,
                    inputBytes: preparedTranscript.transcriptText.length
                  }
                })
              : null;
            const transcriptTaskType = cacheCheck.plan.needDerivedParts.transcriptLlm ? "llm" : "fs";
            try {
              const derived = await scheduler.run(transcriptTaskType, () =>
                computeVideoFeatureArtifact({
                  feature: "transcript",
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  transcriptText: preparedTranscript.transcriptText,
                  transcriptArtifactPath: transcriptAbsolutePath,
                  durationSec: enrichedVideo?.durationSec,
                  publishedAt: enrichedVideo?.publishedAt ?? video.publishedAt,
                  nowISO: exportedAt,
                  languageHint,
                  transcriptCompute: {
                    deterministic: cacheCheck.plan.needDerivedParts.transcriptDeterministic,
                    llm: cacheCheck.plan.needDerivedParts.transcriptLlm
                  },
                  trace: transcriptTaskStepId
                    ? {
                        transcript: {
                          onAutoGenWorkerRequestId: (workerRequestId) => {
                            logEvent(callbacks, {
                              scope: "autogen",
                              action: "worker_request_map",
                              videoId: video.videoId,
                              stage: "writing_json",
                              msg: "Mapped AutoGen worker request",
                              data: {
                                workerRequestId,
                                stepId: transcriptTaskStepId
                              }
                            });
                          }
                        }
                      }
                    : undefined
                })
              );
              derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;
              if (transcriptTaskStepId) {
                logEvent(callbacks, {
                  stepId: transcriptTaskStepId,
                  scope: "autogen",
                  action: "autogen_task_done",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "AutoGen transcript task finished",
                  data: {
                    taskName: "transcript",
                    model: env.autoGenModelDescription,
                    reasoningEffort: env.autoGenReasoningEffort,
                    inputBytes: preparedTranscript.transcriptText.length,
                    ms: elapsedMs(transcriptFeaturesStartedAt),
                    ok: true
                  }
                });
              }
              markStageTiming("transcript_features", transcriptFeaturesStartedAt);

              for (const warning of derived.warnings) {
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }
            } catch (error) {
              logErrorAndWarn(callbacks, {
                scope: "autogen",
                action: "transcript_features",
                stage: "writing_json",
                videoId: video.videoId,
                err: error,
                msg: "Transcript features generation failed"
              });
              if (env.exportFailFast) {
                throw error;
              }
              if (transcriptTaskStepId) {
                logEvent(callbacks, {
                  stepId: transcriptTaskStepId,
                  scope: "autogen",
                  action: "autogen_task_done",
                  videoId: video.videoId,
                  stage: "writing_json",
                  msg: "AutoGen transcript task failed",
                  data: {
                    taskName: "transcript",
                    model: env.autoGenModelDescription,
                    reasoningEffort: env.autoGenReasoningEffort,
                    inputBytes: preparedTranscript.transcriptText.length,
                    ms: elapsedMs(transcriptFeaturesStartedAt),
                    ok: false
                  }
                });
              }
              const warning = `Transcript features generation failed for ${video.videoId}: ${
                error instanceof Error ? error.message : "unknown error"
              }`;
              videoWarnings.push(warning);
              addWarning(warning, video.videoId);
            }
          }

          callbacks.onVideoProgress?.({
            videoId: video.videoId,
            stage: "writing_json",
            percent: 97
          });

          const transcriptRef: RawVideoRecordV1["transcriptRef"] = {
            transcriptPath: transcriptRelativePath,
            transcriptSource: preparedTranscript.transcriptSource,
            transcriptStatus
          };
          const sanitizedVideoWarnings = await sanitizeVideoWarnings({
            projectRoot: channelFolderPath,
            videoId: video.videoId,
            transcriptPath: transcriptRelativePath,
            warnings: videoWarnings
          });
          const rawVideoRecord = buildRawVideoRecord(
            video,
            enrichedVideo,
            transcriptRef,
            preparedTranscript.audioLocalPath ?? undefined,
            exportedAtDate,
            sanitizedVideoWarnings
          );
          const rawVideoWriteStartedAt = Date.now();
          logEvent(callbacks, {
            scope: "fs",
            action: "raw_write_start",
            videoId: video.videoId,
            stage: "writing_json",
            msg: "Writing raw video record",
            data: {
              path: toRelativeExportPath(channelFolderPath, rawPaths.rawVideosFilePath)
            }
          });
          await scheduler.run("fs", () => appendRawVideoRecord(rawVideoRecord));
          logEvent(callbacks, {
            scope: "fs",
            action: "raw_write_done",
            videoId: video.videoId,
            stage: "writing_json",
            msg: "Raw video record written",
            data: {
              path: toRelativeExportPath(channelFolderPath, rawPaths.rawVideosFilePath),
              ms: elapsedMs(rawVideoWriteStartedAt)
            }
          });
          markStageTiming("raw_write_video", rawVideoWriteStartedAt);

          const finalHashes = await computeHashes({
            title: titleForFeatures,
            description: descriptionForFeatures,
            transcriptText: preparedTranscript.transcriptText,
            transcriptSource: preparedTranscript.transcriptSource,
            thumbnailFilePath: effectiveThumbnailAbsolutePath
          });
          const thumbnailExists = await fileExists(effectiveThumbnailAbsolutePath);
          const derivedExists = derivedVideoFeaturesArtifactPath ? await fileExists(derivedVideoFeaturesArtifactPath) : false;
          cacheEntryForPersist = buildCacheEntry({
            videoId: video.videoId,
            hashes: finalHashes,
            artifacts: {
              rawTranscriptPath: preparedTranscript.transcriptPath,
              thumbnailPath: effectiveThumbnailRelativePath,
              derivedVideoFeaturesPath:
                derivedVideoFeaturesArtifactPath && path.isAbsolute(derivedVideoFeaturesArtifactPath)
                  ? resolveCacheArtifactRelativePath({
                      channelFolderPath,
                      artifactAbsolutePath: derivedVideoFeaturesArtifactPath
                    })
                  : cacheCheck.artifacts.derivedVideoFeaturesPath
            },
            status: {
              rawTranscript: transcriptStatus,
              thumbnail: thumbnailExists ? "ok" : "failed",
              derived: derivedExists ? (sanitizedVideoWarnings.length > 0 ? "partial" : "ok") : "error",
              warnings: [...sanitizedVideoWarnings]
            }
          });

          markStageTiming("video_total", videoStartedAtMs);
          logEvent(callbacks, {
            scope: "exportService",
            action: "video_done",
            videoId: video.videoId,
            stage: sanitizedVideoWarnings.length > 0 ? "warning" : "done",
            msg: "Video processing finished",
            data: {
              status: sanitizedVideoWarnings.length > 0 ? "warning" : "done",
              cacheHit: cacheCheck.hit,
              transcriptStatus,
              transcriptSource: preparedTranscript.transcriptSource,
              timingsMs: videoStageTimingsMs,
              llmUsed: {
                description:
                  cacheCheck.plan.needDerivedParts.descriptionLlm && Boolean(env.autoGenEnabled && env.openAiApiKey),
                transcript:
                  cacheCheck.plan.needDerivedParts.transcriptLlm && Boolean(env.autoGenEnabled && env.openAiApiKey),
                thumbnail:
                  cacheCheck.plan.needDerivedParts.thumbnailLlm && Boolean(env.autoGenEnabled && env.openAiApiKey)
              }
            }
          });

          return {
            videoId: video.videoId,
            title: video.title,
            viewCount: video.viewCount,
            publishedAt: video.publishedAt,
            thumbnailPath: effectiveThumbnailRelativePath,
            transcript: preparedTranscript.transcriptText,
            transcriptStatus: transcriptStatus,
            transcriptSource: preparedTranscript.transcriptSource,
            transcriptPath: preparedTranscript.transcriptPath,
            warnings: sanitizedVideoWarnings,
            rawTranscriptArtifactPath: transcriptAbsolutePath,
            rawAudioArtifactPath: preparedTranscript.audioLocalPath
              ? path.resolve(channelFolderPath, preparedTranscript.audioLocalPath)
              : undefined,
            derivedVideoFeaturesArtifactPath
          };
        } finally {
          try {
            await enqueueCacheEntryUpdate(video.videoId, cacheEntryForPersist);
          } catch (error) {
            logErrorAndWarn(callbacks, {
              scope: "cache",
              action: "cache_update",
              stage: "writing_json",
              videoId: video.videoId,
              err: error,
              msg: "Cache update failed"
            });
            addWarning(
              `Export cache update failed for ${video.videoId}: ${error instanceof Error ? error.message : "unknown error"}`,
              video.videoId
            );
            if (env.exportFailFast) {
              throw error;
            }
          }
        }
        })
      )
    );

    const performanceInputVideos = processedVideos.map((video) => {
      const enrichedVideo = videoDetailsById.get(video.videoId);
      return {
        videoId: video.videoId,
        publishedAt: enrichedVideo?.publishedAt ?? video.publishedAt,
        viewCount: enrichedVideo?.statistics.viewCount ?? video.viewCount,
        likeCount: toOptionalMetricCount(enrichedVideo?.statistics.likeCount),
        commentCount: toOptionalMetricCount(enrichedVideo?.statistics.commentCount),
        durationSec: toOptionalDurationSec(enrichedVideo?.durationSec)
      };
    });

    const performanceResult = computePerformancePerVideo(performanceInputVideos, exportedAt);
    for (const warning of performanceResult.warnings) {
      addWarning(warning);
    }

    const performanceProgressDenominator = Math.max(processedVideos.length, 1);
    for (const [index, video] of processedVideos.entries()) {
      const performance = performanceResult.perVideoMap[video.videoId];
      if (!performance) {
        continue;
      }

      const derivedWriteStartedAt = Date.now();
      logEvent(callbacks, {
        scope: "fs",
        action: "derived_write_start",
        videoId: video.videoId,
        stage: "writing_json",
        msg: "Writing performance-derived artifact"
      });
      const artifactAbsolutePath = await scheduler.run("fs", () =>
        persistPerformanceFeaturesArtifact({
          exportsRoot,
          channelFolderPath,
          videoId: video.videoId,
          computedAt: exportedAt,
          performance
        })
      );
      video.derivedVideoFeaturesArtifactPath = artifactAbsolutePath;
      logEvent(callbacks, {
        scope: "fs",
        action: "derived_write_done",
        videoId: video.videoId,
        stage: "writing_json",
        msg: "Performance-derived artifact written",
        data: {
          path: toRelativeExportPath(channelFolderPath, artifactAbsolutePath),
          ms: elapsedMs(derivedWriteStartedAt)
        }
      });

      callbacks.onVideoProgress?.({
        videoId: video.videoId,
        stage: "writing_json",
        percent: 92 + Math.floor(((index + 1) / performanceProgressDenominator) * 2)
      });
    }

    const channelModelsWriteStartedAt = Date.now();
    logEvent(callbacks, {
      scope: "fs",
      action: "derived_write_start",
      stage: "writing_json",
      msg: "Writing channel models artifact"
    });
    const channelModelsArtifactPath = await scheduler.run("fs", () =>
      writeChannelModelsArtifact({
        exportsRoot,
        channelFolderPath,
        channelId: request.channelId,
        timeframe: request.timeframe,
        computedAt: exportedAt,
        model: performanceResult.modelSummary
      })
    );
    logEvent(callbacks, {
      scope: "fs",
      action: "derived_write_done",
      stage: "writing_json",
      msg: "Channel models artifact written",
      data: {
        path: toRelativeExportPath(channelFolderPath, channelModelsArtifactPath),
        ms: elapsedMs(channelModelsWriteStartedAt)
      }
    });

    const exportVideos: ExportPayload["videos"] = processedVideos.map(
      ({
        warnings: _,
        rawTranscriptArtifactPath: __,
        rawAudioArtifactPath: ___,
        derivedVideoFeaturesArtifactPath: ____,
        ...video
      }) => video
    );
    const thumbnailAvailability = await scheduler.run("fs", () =>
      collectThumbnailAvailability(exportsRoot, channelFolderPath, processedVideos)
    );
    const channelJson: ExportPayload = {
      exportVersion: EXPORT_VERSION,
      exportedAt,
      channelName: request.channelName,
      channelId: request.channelId,
      sourceInput: request.sourceInput,
      timeframe: request.timeframe,
      timeframeResolved,
      videos: exportVideos
    };

    const channelFilePath = path.resolve(channelFolderPath, "channel.json");
    ensureInsideRoot(exportsRoot, channelFilePath);
    const channelWriteStartedAt = Date.now();
    logEvent(callbacks, {
      scope: "fs",
      action: "raw_write_start",
      stage: "writing_json",
      msg: "Writing channel export JSON",
      data: {
        path: toRelativeExportPath(channelFolderPath, channelFilePath)
      }
    });
    await scheduler.run("fs", () => fs.writeFile(channelFilePath, JSON.stringify(channelJson, null, 2), "utf-8"));
    logEvent(callbacks, {
      scope: "fs",
      action: "raw_write_done",
      stage: "writing_json",
      msg: "Channel export JSON written",
      data: {
        path: toRelativeExportPath(channelFolderPath, channelFilePath),
        ms: elapsedMs(channelWriteStartedAt)
      }
    });

    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json",
        percent: 95
      });
    }

    let orchestratorArtifactPaths: string[] = [];
    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json",
        percent: 98
      });
    }
    logEvent(callbacks, {
      scope: "orchestrator",
      action: "orchestrator_skipped",
      msg: "Channel orchestrator skipped during export (manual trigger only)"
    });
    addWarning("Channel orchestrator skipped during export; run it manually from the Projects tab if needed.");
    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json",
        percent: 100
      });
    }

    const persistedProjectWarnings = await sanitizeProjectWarnings({
      projectRoot: channelFolderPath,
      rows: processedVideos.map((video) => ({
        videoId: video.videoId,
        transcriptPath: video.transcriptPath,
        warnings: video.warnings
      })),
      warnings,
      performanceWarnings: performanceResult.warnings
    });

    const rawPackStartedAt = Date.now();
    logEvent(callbacks, {
      scope: "fs",
      action: "raw_write_start",
      stage: "writing_json",
      msg: "Writing raw pack"
    });
    const rawPack = await scheduler.run("fs", () =>
      writeRawPack({
        exportsRoot,
        channelFolderPath,
        rawPaths,
        thumbnailsFolderPath,
        processedVideos,
        request,
        jobId,
        exportVersion: EXPORT_VERSION,
        exportedAt,
        timeframeResolved,
        warnings: persistedProjectWarnings,
        channelStats: channelDetailsResult.channelStats,
        transcriptArtifactPaths: processedVideos.map((video) => video.rawTranscriptArtifactPath),
        audioArtifactPaths: processedVideos
          .map((video) => video.rawAudioArtifactPath)
          .filter((artifactPath): artifactPath is string => Boolean(artifactPath)),
        existingThumbnailVideoIds: thumbnailAvailability.existingVideoIds
      })
    );
    logEvent(callbacks, {
      scope: "fs",
      action: "raw_write_done",
      stage: "writing_json",
      msg: "Raw pack written",
      data: {
        artifactsCount: rawPack.artifactPaths.length,
        ms: elapsedMs(rawPackStartedAt)
      }
    });

    const selectedVideoCount = new Set(request.selectedVideoIds).size;
    const transcriptCounts = processedVideos.reduce(
      (acc, video) => {
        const status = toTranscriptStatus(video.transcriptStatus);
        if (status === "ok") {
          acc.ok += 1;
        } else if (status === "missing") {
          acc.missing += 1;
        } else {
          acc.error += 1;
        }
        return acc;
      },
      { ok: 0, missing: 0, error: 0 }
    );

    const thumbnailArtifactPaths = Array.from(thumbnailAvailability.existingVideoIds, (videoId) =>
      path.resolve(channelFolderPath, "thumbnails", `${videoId}.jpg`)
    );
    const derivedArtifactPaths = processedVideos
      .map((video) => video.derivedVideoFeaturesArtifactPath)
      .filter((artifactPath): artifactPath is string => Boolean(artifactPath));
    const cacheIndexPath = path.resolve(channelFolderPath, ".cache", "index.json");
    ensureInsideRoot(exportsRoot, cacheIndexPath);
    const cacheArtifacts = (await fileExists(cacheIndexPath)) ? [cacheIndexPath] : [];
    const artifactPaths = [
      channelFilePath,
      ...thumbnailArtifactPaths,
      ...rawPack.artifactPaths,
      ...derivedArtifactPaths,
      channelModelsArtifactPath,
      ...cacheArtifacts,
      ...orchestratorArtifactPaths
    ];
    const artifactSet = new Set(
      artifactPaths.map((artifactPath) => toSafeRelativePath(channelFolderPath, artifactPath))
    );

    const manifest: ExportManifestV1 = {
      jobId,
      channelId: request.channelId,
      channelFolder: toSafeRelativePath(exportsRoot, channelFolderPath),
      exportVersion: EXPORT_VERSION,
      exportedAt,
      counts: {
        totalVideosSelected: selectedVideoCount,
        transcriptsOk: transcriptCounts.ok,
        transcriptsMissing: transcriptCounts.missing,
        transcriptsError: transcriptCounts.error,
        thumbnailsOk: thumbnailAvailability.okCount,
        thumbnailsFailed: thumbnailAvailability.failedCount
      },
      warnings: [...persistedProjectWarnings],
      artifacts: Array.from(artifactSet).sort()
    };

    const manifestPath = path.resolve(channelFolderPath, "manifest.json");
    ensureInsideRoot(exportsRoot, manifestPath);
    manifest.artifacts = [...manifest.artifacts, toSafeRelativePath(channelFolderPath, manifestPath)].sort();
    const manifestWriteStartedAt = Date.now();
    logEvent(callbacks, {
      scope: "fs",
      action: "raw_write_start",
      stage: "writing_json",
      msg: "Writing manifest",
      data: {
        path: toRelativeExportPath(channelFolderPath, manifestPath)
      }
    });
    await scheduler.run("fs", () => fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8"));
    logEvent(callbacks, {
      scope: "fs",
      action: "raw_write_done",
      stage: "writing_json",
      msg: "Manifest written",
      data: {
        path: toRelativeExportPath(channelFolderPath, manifestPath),
        ms: elapsedMs(manifestWriteStartedAt)
      }
    });

    let completed = 0;
    const total = processedVideos.length;
    for (const item of processedVideos) {
      const finalStage: ExportVideoStage = item.warnings.length > 0 ? "warning" : "done";
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: finalStage
      });
      completed += 1;
      callbacks.onJobProgress?.({ completed, total });
    }

    logEvent(callbacks, {
      scope: "exportService",
      action: "export_done",
      msg: "Export finished",
      data: {
        exportedCount: exportVideos.length,
        warningsCount: warnings.length
      }
    });

    return {
      folderPath: channelFolderPath,
      warnings: persistedProjectWarnings,
      exportedCount: exportVideos.length
    };
  } catch (error) {
    logErrorAndWarn(callbacks, {
      scope: "exportService",
      action: "export_failed",
      err: error,
      msg: "Export failed"
    });
    throw error;
  } finally {
    const cleanupStartedAt = Date.now();
    await scheduler.run("fs", () => fs.rm(tempRootPath, { recursive: true, force: true }));
    logEvent(callbacks, {
      scope: "fs",
      action: "cleanup_done",
      msg: "Temporary files cleaned",
      data: {
        path: toRelativeExportPath(exportsRoot, tempRootPath),
        ms: elapsedMs(cleanupStartedAt)
      }
    });
    projectOperationLockService.release({
      projectId: folderName,
      ownerId: jobId
    });
  }
}
