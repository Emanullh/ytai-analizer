import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
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
import { getTranscriptWithFallback } from "./transcriptPipeline.js";
import type { TranscriptPipelineResult } from "./transcriptPipeline.js";
import type { TranscriptSegment } from "./transcriptModels.js";
import { resolveTimeframeRange } from "../utils/timeframe.js";
import { persistTitleFeaturesArtifact } from "../derived/titleFeaturesAgent.js";
import { persistDescriptionFeaturesArtifact } from "../derived/descriptionFeaturesAgent.js";
import { persistTranscriptFeaturesArtifact } from "../derived/transcriptFeaturesAgent.js";
import { persistThumbnailFeaturesArtifact } from "../derived/thumbnailFeaturesAgent.js";
import {
  computePerformancePerVideo,
  type ChannelModelSummary,
  type VideoPerformanceFeatures
} from "../derived/performanceNormalization.js";
import { runOrchestrator } from "../analysis/orchestratorService.js";

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

const EXPORT_VERSION = "1.1";
const TRANSCRIPT_CONCURRENCY = 4;

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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function fallbackTranscriptResult(videoId: string, error: unknown): TranscriptPipelineResult {
  return {
    transcript: "",
    status: "error",
    source: "none",
    warning: `Transcript pipeline failed for video ${videoId}: ${error instanceof Error ? error.message : "unknown error"}`
  };
}

export async function exportSelectedVideos(
  request: ExportRequest,
  callbacks: ExportProgressCallbacks = {},
  dependencies: ExportDependencies = defaultDependencies
): Promise<{ folderPath: string; warnings: string[]; exportedCount: number }> {
  const warnings: string[] = [];
  const addWarning = (message: string, videoId?: string) => {
    warnings.push(message);
    callbacks.onWarning?.({ videoId, message });
  };

  const details = await dependencies.getSelectedVideoDetails(request.channelId, request.timeframe, request.selectedVideoIds);
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

  await fs.mkdir(thumbnailsFolderPath, { recursive: true });
  await fs.mkdir(tempAudioPath, { recursive: true });
  await initializeRawPaths(exportsRoot, rawPaths);

  const [videoDetailsResult, channelDetailsResult] = await Promise.all([
    dependencies.getVideoDetails(details.videos.map((video) => video.videoId)),
    dependencies.getChannelDetails(request.channelId)
  ]);
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
    const processedVideos = await mapWithConcurrency(
      details.videos,
      TRANSCRIPT_CONCURRENCY,
      async (video): Promise<ProcessedVideo> => {
        const videoWarnings: string[] = [];
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

        let transcriptResult: TranscriptPipelineResult;
        try {
          transcriptResult = await dependencies.getTranscriptWithFallback(video.videoId, {
            outputMp3Path,
            language: env.localAsrLanguage,
            onLocalAsrStage: (stage) => {
              callbacks.onVideoProgress?.({
                videoId: video.videoId,
                stage
              });
            }
          });
        } catch (error) {
          transcriptResult = fallbackTranscriptResult(video.videoId, error);
        }

        if (transcriptResult.warning) {
          videoWarnings.push(transcriptResult.warning);
          addWarning(transcriptResult.warning, video.videoId);
        }

        callbacks.onVideoProgress?.({
          videoId: video.videoId,
          stage: "downloading_thumbnail"
        });

        const thumbnailOriginalUrl = enrichedVideo?.thumbnailOriginalUrl || video.thumbnailUrl;
        if (thumbnailOriginalUrl) {
          try {
            const image = await dependencies.downloadToBuffer(thumbnailOriginalUrl, 12_000);
            await fs.writeFile(thumbnailAbsolutePath, image);
          } catch (error) {
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

        let derivedVideoFeaturesArtifactPath: string | undefined;
        const titleForFeatures = enrichedVideo?.title || video.title;
        const descriptionForFeatures = enrichedVideo?.description ?? "";

        try {
          const derived = await persistThumbnailFeaturesArtifact({
            exportsRoot,
            channelFolderPath,
            videoId: video.videoId,
            title: titleForFeatures,
            thumbnailAbsPath: thumbnailAbsolutePath,
            thumbnailLocalPath: thumbnailRelativePath
          });
          derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;

          for (const warning of derived.warnings) {
            videoWarnings.push(warning);
            addWarning(warning, video.videoId);
          }
        } catch (error) {
          const warning = `Thumbnail features generation failed for ${video.videoId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`;
          videoWarnings.push(warning);
          addWarning(warning, video.videoId);
        }
        callbacks.onVideoProgress?.({
          videoId: video.videoId,
          stage: "writing_json",
          percent: 62
        });

        const transcriptStatus = toTranscriptStatus(transcriptResult.status);
        const sanitizedTranscriptResult = sanitizeTranscript(transcriptResult.transcript);
        const transcriptArtifactRecords = buildTranscriptArtifactRecords({
          videoId: video.videoId,
          result: transcriptResult,
          transcriptStatus,
          transcriptText: sanitizedTranscriptResult.transcript,
          transcriptCleaned: sanitizedTranscriptResult.cleaned,
          createdAt: exportedAt
        });
        await writeJsonLines(transcriptAbsolutePath, transcriptArtifactRecords);
        callbacks.onVideoProgress?.({
          videoId: video.videoId,
          stage: "writing_json",
          percent: 70
        });

        try {
          const derived = await persistTitleFeaturesArtifact({
            exportsRoot,
            channelFolderPath,
            videoId: video.videoId,
            title: titleForFeatures,
            transcript: sanitizedTranscriptResult.transcript,
            transcriptSegments: transcriptResult.segments,
            languageHint: toLanguageHint(resolveTranscriptLanguage(transcriptResult))
          });
          derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;

          for (const warning of derived.warnings) {
            videoWarnings.push(warning);
            addWarning(warning, video.videoId);
          }
        } catch (error) {
          const warning = `Title features generation failed for ${video.videoId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`;
          videoWarnings.push(warning);
          addWarning(warning, video.videoId);
        }
        callbacks.onVideoProgress?.({
          videoId: video.videoId,
          stage: "writing_json",
          percent: 82
        });

        try {
          const derived = await persistDescriptionFeaturesArtifact({
            exportsRoot,
            channelFolderPath,
            videoId: video.videoId,
            title: titleForFeatures,
            description: descriptionForFeatures,
            languageHint: toLanguageHint(resolveTranscriptLanguage(transcriptResult))
          });
          derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;

          for (const warning of derived.warnings) {
            videoWarnings.push(warning);
            addWarning(warning, video.videoId);
          }
        } catch (error) {
          const warning = `Description features generation failed for ${video.videoId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`;
          videoWarnings.push(warning);
          addWarning(warning, video.videoId);
        }
        callbacks.onVideoProgress?.({
          videoId: video.videoId,
          stage: "writing_json",
          percent: 90
        });

        try {
          const derived = await persistTranscriptFeaturesArtifact({
            exportsRoot,
            channelFolderPath,
            videoId: video.videoId,
            title: titleForFeatures,
            transcript: sanitizedTranscriptResult.transcript,
            transcriptArtifactPath: transcriptAbsolutePath,
            durationSec: enrichedVideo?.durationSec,
            publishedAt: enrichedVideo?.publishedAt ?? video.publishedAt,
            nowISO: exportedAt,
            languageHint: toLanguageHint(resolveTranscriptLanguage(transcriptResult))
          });
          derivedVideoFeaturesArtifactPath = derived.artifactAbsolutePath;

          for (const warning of derived.warnings) {
            videoWarnings.push(warning);
            addWarning(warning, video.videoId);
          }
        } catch (error) {
          const warning = `Transcript features generation failed for ${video.videoId}: ${
            error instanceof Error ? error.message : "unknown error"
          }`;
          videoWarnings.push(warning);
          addWarning(warning, video.videoId);
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
        await appendRawVideoRecord(rawVideoRecord);

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
      }
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

      const artifactAbsolutePath = await persistPerformanceFeaturesArtifact({
        exportsRoot,
        channelFolderPath,
        videoId: video.videoId,
        computedAt: exportedAt,
        performance
      });
      video.derivedVideoFeaturesArtifactPath = artifactAbsolutePath;

      callbacks.onVideoProgress?.({
        videoId: video.videoId,
        stage: "writing_json",
        percent: 92 + Math.floor(((index + 1) / performanceProgressDenominator) * 2)
      });
    }

    const channelModelsArtifactPath = await writeChannelModelsArtifact({
      exportsRoot,
      channelFolderPath,
      channelId: request.channelId,
      timeframe: request.timeframe,
      computedAt: exportedAt,
      model: performanceResult.modelSummary
    });

    const exportVideos: ExportPayload["videos"] = processedVideos.map(
      ({ warnings: _, rawTranscriptArtifactPath: __, derivedVideoFeaturesArtifactPath: ___, ...video }) => video
    );
    const thumbnailAvailability = await collectThumbnailAvailability(exportsRoot, channelFolderPath, processedVideos);
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
    await fs.writeFile(channelFilePath, JSON.stringify(channelJson, null, 2), "utf-8");

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
    try {
      const orchestratorResult = await runOrchestrator({
        exportRoot: exportsRoot,
        channelId: request.channelId,
        channelName: request.channelName,
        timeframe: request.timeframe,
        jobId
      });
      orchestratorArtifactPaths = orchestratorResult.artifactPaths;
      for (const warning of orchestratorResult.warnings) {
        addWarning(warning);
      }
    } catch (error) {
      addWarning(`Channel orchestrator failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json",
        percent: 100
      });
    }

    const rawPack = await writeRawPack({
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
    const artifactPaths = [
      channelFilePath,
      ...thumbnailArtifactPaths,
      ...rawPack.artifactPaths,
      ...derivedArtifactPaths,
      channelModelsArtifactPath,
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
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

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

    return {
      folderPath: channelFolderPath,
      warnings,
      exportedCount: exportVideos.length
    };
  } finally {
    await fs.rm(tempRootPath, { recursive: true, force: true });
  }
}
