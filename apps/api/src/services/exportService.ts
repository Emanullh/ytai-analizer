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
import { sanitizeTranscript } from "../utils/transcript.js";
import { fileExists } from "../utils/fileExists.js";
import { getTranscriptWithFallback } from "./transcriptPipeline.js";
import type { TranscriptPipelineResult } from "./transcriptPipeline.js";
import type { TranscriptSegment } from "./transcriptModels.js";
import { resolveTimeframeRange } from "../utils/timeframe.js";
import { persistTitleFeaturesArtifact } from "../derived/titleFeaturesAgent.js";
import { persistDescriptionFeaturesArtifact } from "../derived/descriptionFeaturesAgent.js";
import { persistTranscriptFeaturesArtifact } from "../derived/transcriptFeaturesAgent.js";
import { persistThumbnailFeaturesArtifact } from "../derived/thumbnailFeaturesAgent.js";
import { loadTranscriptJsonl } from "../derived/transcriptArtifacts.js";
import {
  computePerformancePerVideo,
  type ChannelModelSummary,
  type VideoPerformanceFeatures
} from "../derived/performanceNormalization.js";
import { runOrchestrator } from "../analysis/orchestratorService.js";
import {
  buildCacheEntry,
  checkVideoCache,
  computeHashes,
  loadCacheIndex,
  resolveCacheArtifactRelativePath,
  saveCacheIndex,
  updateVideoCacheEntry
} from "./exportCacheService.js";
import { buildVideoPlan, validatePlan } from "./exportPlan.js";
import { createScheduler } from "./taskScheduler.js";

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

interface RawTranscriptMetaRecordV1 {
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

interface RawTranscriptSegmentRecordV1 {
  type: "segment";
  i: number;
  startSec: number | null;
  endSec: number | null;
  text: string;
  confidence: number | null;
}

type RawTranscriptRecordV1 = RawTranscriptMetaRecordV1 | RawTranscriptSegmentRecordV1;

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

async function writeJsonLines(filePath: string, records: unknown[]): Promise<void> {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(filePath, `${content}\n`, "utf-8");
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

function resolveTranscriptLanguage(result: TranscriptPipelineResult): string {
  if (result.language?.trim()) {
    return result.language.trim();
  }
  if (result.source === "asr") {
    return env.localAsrLanguage || "auto";
  }
  return env.transcriptLang ?? "auto";
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

function buildTranscriptArtifactRecords(input: {
  videoId: string;
  result: TranscriptPipelineResult;
  transcriptStatus: "ok" | "missing" | "error";
  transcriptText: string;
  transcriptCleaned: boolean;
  createdAt: string;
}): RawTranscriptRecordV1[] {
  const meta: RawTranscriptMetaRecordV1 = {
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

  const segmentRecords: RawTranscriptSegmentRecordV1[] = effectiveSegments.map((segment, index) => ({
    type: "segment",
    i: index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    confidence: segment.confidence
  }));

  return [meta, ...segmentRecords];
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
      dataSources: ["youtube-data-api-v3", "youtube-transcript", "local-asr-fallback"],
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

  const exportsRoot = path.resolve(process.cwd(), "exports");
  const jobId = request.jobId ?? randomUUID();
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
  const folderName = sanitizeFolderName(request.channelName);
  const channelFolderPath = path.resolve(exportsRoot, folderName);
  const thumbnailsFolderPath = path.resolve(channelFolderPath, "thumbnails");
  const tempRootPath = path.resolve(exportsRoot, ".tmp", jobId);
  const tempAudioPath = path.resolve(tempRootPath, "audio");
  const rawPaths = createRawPaths(channelFolderPath);

  ensureInsideRoot(exportsRoot, channelFolderPath);
  ensureInsideRoot(exportsRoot, thumbnailsFolderPath);
  ensureInsideRoot(exportsRoot, tempRootPath);
  ensureInsideRoot(exportsRoot, tempAudioPath);

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
    await fs.mkdir(tempAudioPath, { recursive: true });
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

  callbacks.onJobStarted?.({ total: details.videos.length });
  for (const video of details.videos) {
    callbacks.onVideoProgress?.({
      videoId: video.videoId,
      stage: "queue"
    });
  }

  try {
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
        const outputMp3Path = path.resolve(tempAudioPath, `${video.videoId}.mp3`);
        const transcriptAbsolutePath = path.resolve(rawPaths.rawTranscriptsFolderPath, `${video.videoId}.jsonl`);
        const transcriptRelativePath = path.posix.join("raw", "transcripts", `${video.videoId}.jsonl`);

        ensureInsideRoot(exportsRoot, thumbnailAbsolutePath);
        ensureInsideRoot(exportsRoot, outputMp3Path);
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

          const needTranscriptFetch = cacheCheck.plan.needTranscriptFetch || !transcriptSnapshot;
          const runTranscriptTask = async (): Promise<TranscriptPipelineResult> => {
            if (!needTranscriptFetch) {
              return {
                transcript: transcriptSnapshot?.transcript ?? "",
                status: transcriptSnapshot?.status ?? "missing",
                source: transcriptSnapshot?.source ?? "none",
                warning: transcriptSnapshot?.warning,
                language: transcriptSnapshot?.language,
                segments: transcriptSnapshot?.segments
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
            let transcriptResult: TranscriptPipelineResult = {
              transcript: transcriptSnapshot?.transcript ?? "",
              status: transcriptSnapshot?.status ?? "missing",
              source: transcriptSnapshot?.source ?? "none",
              warning: transcriptSnapshot?.warning,
              language: transcriptSnapshot?.language,
              segments: transcriptSnapshot?.segments
            };

            logEvent(callbacks, {
              stepId: transcriptStepId,
              scope: "transcript",
              action: "captions_attempt",
              videoId: video.videoId,
              stage: "transcribing",
              msg: "Attempting transcript via captions/ASR fallback"
            });
            if (env.localAsrEnabled) {
              logEvent(callbacks, {
                scope: "asr",
                action: "asr_attempt",
                videoId: video.videoId,
                stage: "transcribing",
                msg: "ASR fallback may be used"
              });
            }
            let asrWorkerRequestId: string | null = null;
            try {
              const fetchTranscript = async () =>
                dependencies.getTranscriptWithFallback(video.videoId, {
                  outputMp3Path,
                  language: env.localAsrLanguage,
                  onLocalAsrStage: (stage) => {
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
                });
              transcriptResult = await (env.localAsrEnabled
                ? scheduler.run("asr", fetchTranscript)
                : scheduler.run("http", fetchTranscript));
              const captionsStatus = transcriptResult.source === "captions" ? "ok" : "miss";
              logEvent(callbacks, {
                stepId: transcriptStepId,
                scope: "transcript",
                action: "captions_result",
                videoId: video.videoId,
                stage: "transcribing",
                msg: "Captions result",
                data: {
                  status: captionsStatus,
                  transcriptSource: transcriptResult.source,
                  transcriptStatus: transcriptResult.status
                }
              });
              if (asrWorkerRequestId || transcriptResult.source === "asr" || env.localAsrEnabled) {
                logEvent(callbacks, {
                  scope: "asr",
                  action: "asr_result",
                  videoId: video.videoId,
                  stage: "transcribing",
                  msg: "ASR result",
                  data: {
                    workerRequestId: asrWorkerRequestId,
                    transcriptSource: transcriptResult.source,
                    transcriptStatus: transcriptResult.status,
                    model: transcriptResult.asrMeta?.model ?? null,
                    computeType: transcriptResult.asrMeta?.computeType ?? null
                  }
                });
              }
            } catch (error) {
              logErrorAndWarn(callbacks, {
                scope: "transcript",
                action: "transcript_fetch_failed",
                stage: "transcribing",
                videoId: video.videoId,
                err: error,
                msg: "Transcript pipeline failed",
                retry: {
                  attempt: 1,
                  max: 1,
                  willRetry: false
                }
              });
              if (env.exportFailFast) {
                throw error;
              }
              transcriptResult = fallbackTranscriptResult(video.videoId, error);
            }

            logEvent(callbacks, {
              stepId: transcriptStepId,
              scope: "transcript",
              action: "transcript_result",
              videoId: video.videoId,
              stage: "transcribing",
              msg: "Transcript stage finished",
              data: {
                transcriptSource: transcriptResult.source,
                transcriptStatus: transcriptResult.status,
                segmentsCount: Array.isArray(transcriptResult.segments) ? transcriptResult.segments.length : 0,
                transcriptLen: transcriptResult.transcript.length,
                ms: elapsedMs(transcriptStartedAtMs)
              }
            });
            markStageTiming("transcript", transcriptStartedAtMs);
            if (transcriptResult.warning) {
              videoWarnings.push(transcriptResult.warning);
              addWarning(transcriptResult.warning, video.videoId);
            }
            return transcriptResult;
          };

          const runThumbnailDownloadTask = async (): Promise<void> => {
            if (!cacheCheck.plan.needThumbnailDownload) {
              return;
            }
            const thumbnailStartedAtMs = Date.now();
            callbacks.onVideoProgress?.({
              videoId: video.videoId,
              stage: "downloading_thumbnail"
            });

            const thumbnailOriginalUrl = enrichedVideo?.thumbnailOriginalUrl || video.thumbnailUrl;
            if (thumbnailOriginalUrl) {
              const domain = extractDomain(thumbnailOriginalUrl);
              logEvent(callbacks, {
                scope: "youtube",
                action: "thumbnail_download_start",
                videoId: video.videoId,
                stage: "downloading_thumbnail",
                msg: "Downloading thumbnail",
                data: { urlDomain: domain }
              });
              try {
                const image = await scheduler.run("http", () => dependencies.downloadToBuffer(thumbnailOriginalUrl, 12_000));
                await scheduler.run("fs", () => fs.writeFile(thumbnailAbsolutePath, image));
                logEvent(callbacks, {
                  scope: "youtube",
                  action: "thumbnail_download_done",
                  videoId: video.videoId,
                  stage: "downloading_thumbnail",
                  msg: "Thumbnail downloaded",
                  data: {
                    urlDomain: domain,
                    bytes: image.byteLength,
                    ms: elapsedMs(thumbnailStartedAtMs),
                    path: toRelativeExportPath(channelFolderPath, thumbnailAbsolutePath)
                  }
                });
              } catch (error) {
                logErrorAndWarn(callbacks, {
                  scope: "youtube",
                  action: "download_thumbnail",
                  stage: "downloading_thumbnail",
                  videoId: video.videoId,
                  err: error,
                  msg: "Thumbnail download failed"
                });
                if (env.exportFailFast) {
                  throw error;
                }
                const warning = `Thumbnail download failed for ${video.videoId}: ${
                  error instanceof Error ? error.message : "unknown error"
                }`;
                videoWarnings.push(warning);
                addWarning(warning, video.videoId);
              }
            } else {
              const warning = `Missing thumbnail URL for ${video.videoId}`;
              videoWarnings.push(warning);
              addWarning(warning, video.videoId);
            }
            markStageTiming("thumbnail_download", thumbnailStartedAtMs);
          };

          const thumbnailDownloadPromise = runVideoPipelineInParallel ? runThumbnailDownloadTask() : null;
          let transcriptResult!: TranscriptPipelineResult;
          try {
            transcriptResult = await runTranscriptTask();
          } finally {
            if (thumbnailDownloadPromise) {
              await thumbnailDownloadPromise;
            } else {
              await runThumbnailDownloadTask();
            }
          }

          const transcriptStatus = toTranscriptStatus(transcriptResult.status);
          const sanitizedTranscriptResult = sanitizeTranscript(transcriptResult.transcript);
          if (needTranscriptFetch || !cacheCheck.artifacts.rawTranscriptExists) {
            const rawWriteStartedAt = Date.now();
            logEvent(callbacks, {
              scope: "fs",
              action: "raw_write_start",
              videoId: video.videoId,
              stage: "writing_json",
              msg: "Writing transcript artifact",
              data: {
                path: transcriptRelativePath
              }
            });
            const transcriptArtifactRecords = buildTranscriptArtifactRecords({
              videoId: video.videoId,
              result: transcriptResult,
              transcriptStatus,
              transcriptText: sanitizedTranscriptResult.transcript,
              transcriptCleaned: sanitizedTranscriptResult.cleaned,
              createdAt: exportedAt
            });
            await scheduler.run("fs", () => writeJsonLines(transcriptAbsolutePath, transcriptArtifactRecords));
            logEvent(callbacks, {
              scope: "fs",
              action: "raw_write_done",
              videoId: video.videoId,
              stage: "writing_json",
              msg: "Transcript artifact written",
              data: {
                path: transcriptRelativePath,
                lines: transcriptArtifactRecords.length,
                ms: elapsedMs(rawWriteStartedAt)
              }
            });
            markStageTiming("raw_write_transcript", rawWriteStartedAt);
          }

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
          const languageHint = toLanguageHint(resolveTranscriptLanguage(transcriptResult));

          if (cacheCheck.plan.needDerivedParts.thumbnailDeterministic || cacheCheck.plan.needDerivedParts.thumbnailLlm) {
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
                      thumbnailLocalPath: thumbnailRelativePath
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
                persistThumbnailFeaturesArtifact({
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  thumbnailAbsPath: thumbnailAbsolutePath,
                  thumbnailLocalPath: thumbnailRelativePath,
                  compute: {
                    deterministic: cacheCheck.plan.needDerivedParts.thumbnailDeterministic,
                    deterministicMode: cacheCheck.plan.needDerivedParts.thumbnailDeterministicMode,
                    llm: cacheCheck.plan.needDerivedParts.thumbnailLlm
                  },
                  trace: thumbnailTaskStepId
                    ? {
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
                    ocrWordCount:
                      (derived.mergedBundle.thumbnailFeatures as { deterministic?: { ocrWordCount?: number } })?.deterministic
                        ?.ocrWordCount ?? 0,
                    textAreaRatio:
                      (derived.mergedBundle.thumbnailFeatures as {
                        deterministic?: { textAreaRatio?: number };
                      })?.deterministic?.textAreaRatio ?? 0,
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
                      thumbnailLocalPath: thumbnailRelativePath
                    }),
                    outputBytes: estimateSizeBytes(derived.mergedBundle.thumbnailFeatures),
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
                      thumbnailLocalPath: thumbnailRelativePath
                    }),
                    outputBytes: 0,
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
                  inputChars: titleForFeatures.length + sanitizedTranscriptResult.transcript.length
                }
              });
            }
            try {
              const derived = await scheduler.run(titleTaskType, () =>
                persistTitleFeaturesArtifact({
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  transcript: sanitizedTranscriptResult.transcript,
                  transcriptSegments: transcriptResult.segments,
                  languageHint,
                  compute: {
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
                    inputChars: titleForFeatures.length + sanitizedTranscriptResult.transcript.length,
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
                persistDescriptionFeaturesArtifact({
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  description: descriptionForFeatures,
                  languageHint,
                  compute: {
                    deterministic: cacheCheck.plan.needDerivedParts.descriptionDeterministic,
                    llm: cacheCheck.plan.needDerivedParts.descriptionLlm
                  },
                  trace: descriptionTaskStepId
                    ? {
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
                    outputBytes: estimateSizeBytes(derived.mergedBundle.descriptionFeatures),
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
                    outputBytes: 0,
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
                    inputBytes: sanitizedTranscriptResult.transcript.length
                  }
                })
              : null;
            const transcriptTaskType = cacheCheck.plan.needDerivedParts.transcriptLlm ? "llm" : "fs";
            try {
              const derived = await scheduler.run(transcriptTaskType, () =>
                persistTranscriptFeaturesArtifact({
                  exportsRoot,
                  channelFolderPath,
                  videoId: video.videoId,
                  title: titleForFeatures,
                  transcript: sanitizedTranscriptResult.transcript,
                  transcriptArtifactPath: transcriptAbsolutePath,
                  durationSec: enrichedVideo?.durationSec,
                  publishedAt: enrichedVideo?.publishedAt ?? video.publishedAt,
                  nowISO: exportedAt,
                  languageHint,
                  compute: {
                    deterministic: cacheCheck.plan.needDerivedParts.transcriptDeterministic,
                    llm: cacheCheck.plan.needDerivedParts.transcriptLlm
                  },
                  trace: transcriptTaskStepId
                    ? {
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
                    inputBytes: sanitizedTranscriptResult.transcript.length,
                    outputBytes: estimateSizeBytes(derived.mergedBundle.transcriptFeatures),
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
                    inputBytes: sanitizedTranscriptResult.transcript.length,
                    outputBytes: 0,
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
            transcriptSource: transcriptResult.source,
            transcriptStatus
          };
          const rawVideoRecord = buildRawVideoRecord(video, enrichedVideo, transcriptRef, exportedAtDate, videoWarnings);
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
            transcriptText: sanitizedTranscriptResult.transcript,
            transcriptSource: transcriptResult.source,
            thumbnailFilePath: thumbnailAbsolutePath
          });
          const thumbnailExists = await fileExists(thumbnailAbsolutePath);
          const derivedExists = derivedVideoFeaturesArtifactPath ? await fileExists(derivedVideoFeaturesArtifactPath) : false;
          cacheEntryForPersist = buildCacheEntry({
            videoId: video.videoId,
            hashes: finalHashes,
            artifacts: {
              rawTranscriptPath: transcriptRelativePath,
              thumbnailPath: thumbnailRelativePath,
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
              derived: derivedExists ? (videoWarnings.length > 0 ? "partial" : "ok") : "error",
              warnings: [...videoWarnings]
            }
          });

          markStageTiming("video_total", videoStartedAtMs);
          logEvent(callbacks, {
            scope: "exportService",
            action: "video_done",
            videoId: video.videoId,
            stage: videoWarnings.length > 0 ? "warning" : "done",
            msg: "Video processing finished",
            data: {
              status: videoWarnings.length > 0 ? "warning" : "done",
              cacheHit: cacheCheck.hit,
              transcriptStatus,
              transcriptSource: transcriptResult.source,
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
            thumbnailPath: thumbnailRelativePath,
            transcript: sanitizedTranscriptResult.transcript,
            transcriptStatus: transcriptStatus,
            transcriptSource: transcriptResult.source,
            transcriptPath: transcriptRelativePath,
            warnings: videoWarnings,
            rawTranscriptArtifactPath: transcriptAbsolutePath,
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
      ({ warnings: _, rawTranscriptArtifactPath: __, derivedVideoFeaturesArtifactPath: ___, ...video }) => video
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
    const orchestratorStartedAt = Date.now();
    const orchestratorTaskStepId = logEvent(callbacks, {
      scope: "orchestrator",
      action: "orchestrator_start",
      msg: "Channel orchestrator started"
    });
    const autogenOrchestratorStepId = logEvent(callbacks, {
      scope: "autogen",
      action: "autogen_task_start",
      msg: "AutoGen orchestrator task started",
      data: {
        taskName: "orchestrator",
        model: env.autoGenModelOrchestrator,
        reasoningEffort: env.autoGenReasoningEffortOrchestrator,
        inputBytes: estimateSizeBytes({
          channelId: request.channelId,
          timeframe: request.timeframe,
          selectedVideos: processedVideos.length
        })
      }
    });
    try {
      const orchestratorResult = await scheduler.run("llm", () =>
        runOrchestrator({
          exportRoot: exportsRoot,
          channelId: request.channelId,
          channelName: request.channelName,
          timeframe: request.timeframe,
          jobId,
          onAutoGenWorkerRequestId: (workerRequestId) => {
            logEvent(callbacks, {
              scope: "autogen",
              action: "worker_request_map",
              msg: "Mapped AutoGen worker request",
              data: {
                workerRequestId,
                stepId: autogenOrchestratorStepId
              }
            });
          }
        })
      );
      orchestratorArtifactPaths = orchestratorResult.artifactPaths;
      logEvent(callbacks, {
        stepId: orchestratorTaskStepId,
        scope: "orchestrator",
        action: "orchestrator_done",
        msg: "Channel orchestrator finished",
        data: {
          usedLlm: orchestratorResult.usedLlm,
          artifacts: orchestratorResult.artifactPaths.map((artifactPath) =>
            toRelativeExportPath(channelFolderPath, artifactPath)
          ),
          ms: elapsedMs(orchestratorStartedAt)
        }
      });
      logEvent(callbacks, {
        stepId: autogenOrchestratorStepId,
        scope: "autogen",
        action: "autogen_task_done",
        msg: "AutoGen orchestrator task finished",
        data: {
          taskName: "orchestrator",
          model: env.autoGenModelOrchestrator,
          reasoningEffort: env.autoGenReasoningEffortOrchestrator,
          inputBytes: estimateSizeBytes({
            channelId: request.channelId,
            timeframe: request.timeframe,
            selectedVideos: processedVideos.length
          }),
          outputBytes: estimateSizeBytes(orchestratorResult.artifactPaths),
          ms: elapsedMs(orchestratorStartedAt),
          ok: orchestratorResult.usedLlm
        }
      });
      for (const warning of orchestratorResult.warnings) {
        addWarning(warning);
      }
    } catch (error) {
      logErrorAndWarn(callbacks, {
        scope: "orchestrator",
        action: "orchestrator_run",
        err: error,
        msg: "Channel orchestrator failed"
      });
      logEvent(callbacks, {
        stepId: autogenOrchestratorStepId,
        scope: "autogen",
        action: "autogen_task_done",
        msg: "AutoGen orchestrator task failed",
        data: {
          taskName: "orchestrator",
          model: env.autoGenModelOrchestrator,
          reasoningEffort: env.autoGenReasoningEffortOrchestrator,
          inputBytes: estimateSizeBytes({
            channelId: request.channelId,
            timeframe: request.timeframe,
            selectedVideos: processedVideos.length
          }),
          outputBytes: 0,
          ms: elapsedMs(orchestratorStartedAt),
          ok: false
        }
      });
      addWarning(`Channel orchestrator failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (env.exportFailFast) {
        throw error;
      }
    }
    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json",
        percent: 100
      });
    }

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
        warnings,
        channelStats: channelDetailsResult.channelStats,
        transcriptArtifactPaths: processedVideos.map((video) => video.rawTranscriptArtifactPath),
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
      warnings: [...warnings],
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
      warnings,
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
  }
}
