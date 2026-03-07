import { promises as fs } from "node:fs";
import path from "node:path";
import { computePerformancePerVideo, type ChannelModelSummary, type VideoPerformanceFeatures } from "../derived/performanceNormalization.js";
import { loadTranscriptJsonl } from "../derived/transcriptArtifacts.js";
import { env } from "../config/env.js";
import type { Timeframe } from "../types.js";
import { HttpError } from "../utils/errors.js";
import { fileExists } from "../utils/fileExists.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { loadCacheIndex, saveCacheIndex, type CacheEntry } from "./exportCacheService.js";
import { exportSelectedVideos } from "./exportService.js";
import { syncManifestThumbnailCounts } from "./projectManifestSyncService.js";
import { rerunVideoFeature } from "./videoFeatureRerunService.js";
import { sanitizeProjectWarnings, sanitizeVideoWarnings } from "./exportWarningSanitizer.js";
import {
  getChannelDetails,
  getVideoDetails,
  listVideosForChannel,
  type YoutubeChannelStats,
  type YoutubeVideoDetails
} from "./youtubeService.js";

type TranscriptStatus = "ok" | "missing" | "error";
type TranscriptSource = "captions" | "asr" | "none";
type ExtendVideoProgressStatus = "processing" | "done" | "failed";

interface NormalizedTranscriptRef {
  transcriptPath: string;
  transcriptSource: TranscriptSource;
  transcriptStatus: TranscriptStatus;
}

interface NormalizedRawVideoRecord {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  durationSec?: number;
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
  thumbnails: Record<string, unknown>;
  audioLocalPath?: string;
  thumbnailLocalPath: string;
  thumbnailOriginalUrl: string;
  transcriptRef: NormalizedTranscriptRef;
  daysSincePublish: number;
  viewsPerDay: number;
  likeRate: number;
  commentRate: number;
  warnings: string[];
}

interface NormalizedChannelVideoRecord {
  videoId: string;
  title: string;
  viewCount: number;
  publishedAt: string;
  thumbnailPath: string;
  transcript: string;
  transcriptStatus: TranscriptStatus;
  transcriptSource: TranscriptSource;
  transcriptPath: string;
}

interface ProjectDescriptor {
  projectId: string;
  exportsRoot: string;
  projectRoot: string;
  channelJson: Record<string, unknown>;
  rawChannelJson: Record<string, unknown> | null;
  manifestJson: Record<string, unknown> | null;
  channelId: string;
  channelName: string;
  sourceInput: string;
  projectTimeframe: Timeframe;
  exportVersion: string;
  rawRows: NormalizedRawVideoRecord[];
  channelVideos: NormalizedChannelVideoRecord[];
}

interface TempExportMergeResult {
  rawRows: NormalizedRawVideoRecord[];
  channelVideos: NormalizedChannelVideoRecord[];
}

export interface ProjectExtendCandidateItem {
  videoId: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  thumbnailUrl: string;
  alreadyInProject: boolean;
}

export interface ProjectExtendCandidatesResponse {
  projectId: string;
  projectTimeframe: Timeframe;
  timeframe: Timeframe;
  channelId: string;
  channelName: string;
  videos: ProjectExtendCandidateItem[];
}

export interface ProjectExtendRequest {
  projectId: string;
  timeframe: Timeframe;
  selectedVideoIds: string[];
  reprocessVideoIds?: string[];
  jobId?: string;
}

export interface ProjectExtendProgressCallbacks {
  onJobStarted?: (payload: { total: number }) => void;
  onVideoProgress?: (payload: { videoId: string; status: ExtendVideoProgressStatus; message?: string }) => void;
  onJobProgress?: (payload: { completed: number; total: number; processed: number; failed: number }) => void;
  onWarning?: (payload: { videoId?: string; message: string }) => void;
}

export interface ProjectExtendResult {
  projectId: string;
  addedCount: number;
  refreshedCount: number;
  reprocessedCount: number;
}

function getExportsRoot(): string {
  return path.resolve(process.cwd(), "exports");
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new HttpError(400, "Invalid project path");
  }
}

function validatePathSegment(value: string, label: string): void {
  if (!value || value === ".") {
    throw new HttpError(400, `Invalid ${label}`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..") || path.isAbsolute(value)) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function toSafeRelativePath(rootPath: string, targetPath: string): string {
  ensureInsideRoot(rootPath, targetPath);
  const relative = toPosixPath(path.relative(rootPath, targetPath));
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Invalid artifact path");
  }
  return relative;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toFiniteNonNegative(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric < 0) {
    return null;
  }
  return numeric;
}

function normalizeTimeframe(value: unknown, statusCode = 400): Timeframe {
  if (value === "1m" || value === "6m" || value === "1y" || value === "2y" || value === "5y") {
    return value;
  }
  throw new HttpError(statusCode, "Invalid timeframe");
}

function normalizeTranscriptStatus(value: unknown): TranscriptStatus {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function normalizeTranscriptSource(value: unknown): TranscriptSource {
  if (value === "captions" || value === "asr" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeRelativePath(value: string | null, fallback: string): string {
  const candidate = (value ?? "").replace(/\\/g, "/").trim();
  if (!candidate || path.isAbsolute(candidate)) {
    return fallback;
  }
  if (candidate === "." || candidate === ".." || candidate.startsWith("../") || candidate.includes("/../")) {
    return fallback;
  }
  return candidate;
}

function safeTimestamp(value: unknown): number {
  const raw = toString(value);
  if (!raw) {
    return 0;
  }
  const timestamp = new Date(raw).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return isRecord(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tempPath, targetPath);
}

async function writeJsonLinesAtomic(targetPath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${Date.now()}.tmp`;
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(tempPath, content ? `${content}\n` : "", "utf-8");
  await fs.rename(tempPath, targetPath);
}

function normalizeChannelVideoRecord(record: Record<string, unknown>): NormalizedChannelVideoRecord | null {
  const videoId = toString(record.videoId);
  if (!videoId) {
    return null;
  }

  return {
    videoId,
    title: toString(record.title) ?? videoId,
    viewCount: toFiniteNonNegative(record.viewCount) ?? 0,
    publishedAt: toString(record.publishedAt) ?? "",
    thumbnailPath: normalizeRelativePath(toString(record.thumbnailPath), path.posix.join("thumbnails", `${videoId}.jpg`)),
    transcript: toString(record.transcript) ?? "",
    transcriptStatus: normalizeTranscriptStatus(record.transcriptStatus),
    transcriptSource: normalizeTranscriptSource(record.transcriptSource),
    transcriptPath: normalizeRelativePath(
      toString(record.transcriptPath),
      path.posix.join("raw", "transcripts", `${videoId}.jsonl`)
    )
  };
}

function normalizeRawVideoRecord(
  record: Record<string, unknown>,
  fallbackChannelRecord?: NormalizedChannelVideoRecord | null
): NormalizedRawVideoRecord | null {
  const videoId = toString(record.videoId) ?? fallbackChannelRecord?.videoId ?? null;
  if (!videoId) {
    return null;
  }

  const statistics = isRecord(record.statistics) ? record.statistics : {};
  const transcriptRef = isRecord(record.transcriptRef) ? record.transcriptRef : {};

  const durationSec = toFiniteNonNegative(record.durationSec);
  const audioLocalPath = toString(record.audioLocalPath) ?? undefined;
  const defaultLanguage = toString(record.defaultLanguage) ?? undefined;
  const defaultAudioLanguage = toString(record.defaultAudioLanguage) ?? undefined;

  return {
    videoId,
    title: toString(record.title) ?? fallbackChannelRecord?.title ?? videoId,
    description: toString(record.description) ?? "",
    publishedAt: toString(record.publishedAt) ?? fallbackChannelRecord?.publishedAt ?? "",
    ...(durationSec !== null ? { durationSec } : {}),
    categoryId: toString(record.categoryId) ?? "",
    tags: toStringArray(record.tags),
    ...(defaultLanguage ? { defaultLanguage } : {}),
    ...(defaultAudioLanguage ? { defaultAudioLanguage } : {}),
    madeForKids: record.madeForKids === true,
    liveBroadcastContent: toString(record.liveBroadcastContent) ?? "none",
    statistics: {
      viewCount: toFiniteNonNegative(statistics.viewCount) ?? fallbackChannelRecord?.viewCount ?? 0,
      likeCount: toFiniteNonNegative(statistics.likeCount) ?? 0,
      commentCount: toFiniteNonNegative(statistics.commentCount) ?? 0
    },
    thumbnails: isRecord(record.thumbnails) ? record.thumbnails : {},
    ...(audioLocalPath ? { audioLocalPath } : {}),
    thumbnailLocalPath: normalizeRelativePath(
      toString(record.thumbnailLocalPath),
      path.posix.join("raw", "thumbnails", `${videoId}.jpg`)
    ),
    thumbnailOriginalUrl: toString(record.thumbnailOriginalUrl) ?? "",
    transcriptRef: {
      transcriptPath: normalizeRelativePath(
        toString(transcriptRef.transcriptPath) ?? fallbackChannelRecord?.transcriptPath ?? null,
        path.posix.join("raw", "transcripts", `${videoId}.jsonl`)
      ),
      transcriptSource: normalizeTranscriptSource(transcriptRef.transcriptSource ?? fallbackChannelRecord?.transcriptSource),
      transcriptStatus: normalizeTranscriptStatus(transcriptRef.transcriptStatus ?? fallbackChannelRecord?.transcriptStatus)
    },
    daysSincePublish: toFiniteNonNegative(record.daysSincePublish) ?? 0,
    viewsPerDay: toFiniteNonNegative(record.viewsPerDay) ?? 0,
    likeRate: toFiniteNonNegative(record.likeRate) ?? 0,
    commentRate: toFiniteNonNegative(record.commentRate) ?? 0,
    warnings: toStringArray(record.warnings)
  };
}

async function loadProjectDescriptor(projectId: string): Promise<ProjectDescriptor> {
  validatePathSegment(projectId, "projectId");
  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, projectId);
  ensureInsideRoot(exportsRoot, projectRoot);

  const projectStats = await fs.stat(projectRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Project not found");
    }
    throw error;
  });
  if (!projectStats.isDirectory()) {
    throw new HttpError(404, "Project not found");
  }

  const channelPath = path.resolve(projectRoot, "channel.json");
  ensureInsideRoot(projectRoot, channelPath);
  const channelJson = await readJsonFile(channelPath);
  if (!channelJson) {
    throw new HttpError(409, "channel.json is missing or invalid");
  }

  const channelId = toString(channelJson.channelId);
  const channelName = toString(channelJson.channelName);
  if (!channelId || !channelName) {
    throw new HttpError(409, "channel.json is missing channel metadata");
  }
  if (sanitizeFolderName(channelName) !== projectId) {
    throw new HttpError(409, "Project folder does not match channelName sanitization");
  }

  const channelVideos = Array.isArray(channelJson.videos)
    ? channelJson.videos
        .map((item) => (isRecord(item) ? normalizeChannelVideoRecord(item) : null))
        .filter((item): item is NormalizedChannelVideoRecord => Boolean(item))
    : [];

  const rawVideoRecords = await readJsonLines(path.resolve(projectRoot, "raw", "videos.jsonl"));
  const rawRows =
    rawVideoRecords.length > 0
      ? rawVideoRecords
          .map((item) => {
            const videoId = toString(item.videoId);
            const fallback = videoId ? channelVideos.find((candidate) => candidate.videoId === videoId) ?? null : null;
            return normalizeRawVideoRecord(item, fallback);
          })
          .filter((item): item is NormalizedRawVideoRecord => Boolean(item))
      : channelVideos
          .map((item) => normalizeRawVideoRecord({}, item))
          .filter((item): item is NormalizedRawVideoRecord => Boolean(item));

  return {
    projectId,
    exportsRoot,
    projectRoot,
    channelJson,
    rawChannelJson: await readJsonFile(path.resolve(projectRoot, "raw", "channel.json")),
    manifestJson: await readJsonFile(path.resolve(projectRoot, "manifest.json")),
    channelId,
    channelName,
    sourceInput: toString(channelJson.sourceInput) ?? channelId,
    projectTimeframe: normalizeTimeframe(channelJson.timeframe, 409),
    exportVersion: toString(channelJson.exportVersion) ?? "1.1",
    rawRows,
    channelVideos
  };
}

function sortByPublishedAtDesc<T extends { publishedAt: string }>(items: T[]): T[] {
  return items.slice().sort((a, b) => safeTimestamp(b.publishedAt) - safeTimestamp(a.publishedAt));
}

function toRawRowMap(rows: NormalizedRawVideoRecord[]): Map<string, NormalizedRawVideoRecord> {
  return new Map(rows.map((row) => [row.videoId, row]));
}

function toChannelVideoMap(rows: NormalizedChannelVideoRecord[]): Map<string, NormalizedChannelVideoRecord> {
  return new Map(rows.map((row) => [row.videoId, row]));
}

async function loadTranscriptText(projectRoot: string, row: NormalizedRawVideoRecord): Promise<string> {
  const transcriptPath = path.resolve(projectRoot, normalizeRelativePath(row.transcriptRef.transcriptPath, `raw/transcripts/${row.videoId}.jsonl`));
  ensureInsideRoot(projectRoot, transcriptPath);
  const transcriptArtifact = await loadTranscriptJsonl(transcriptPath, { videoId: row.videoId }).catch(() => null);
  if (!transcriptArtifact) {
    return "";
  }
  return transcriptArtifact.segments.map((segment) => segment.text.trim()).filter(Boolean).join(" ").trim();
}

async function buildChannelVideoRecord(
  projectRoot: string,
  row: NormalizedRawVideoRecord,
  existing?: NormalizedChannelVideoRecord
): Promise<NormalizedChannelVideoRecord> {
  const transcript = existing?.transcript?.trim() ? existing.transcript : await loadTranscriptText(projectRoot, row);
  return {
    videoId: row.videoId,
    title: existing?.title ?? row.title,
    viewCount: row.statistics.viewCount,
    publishedAt: existing?.publishedAt ?? row.publishedAt,
    thumbnailPath: existing?.thumbnailPath ?? path.posix.join("thumbnails", `${row.videoId}.jpg`),
    transcript,
    transcriptStatus: row.transcriptRef.transcriptStatus,
    transcriptSource: row.transcriptRef.transcriptSource,
    transcriptPath: row.transcriptRef.transcriptPath
  };
}

async function copyFileIfExists(sourcePath: string, targetPath: string): Promise<void> {
  if (!(await fileExists(sourcePath))) {
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

async function mergeNewVideoArtifacts(input: {
  descriptor: ProjectDescriptor;
  tempRoot: string;
  newVideoIds: string[];
}): Promise<TempExportMergeResult> {
  const tempChannelJson = await readJsonFile(path.resolve(input.tempRoot, "channel.json"));
  const tempChannelVideos = Array.isArray(tempChannelJson?.videos)
    ? tempChannelJson.videos
        .map((item) => (isRecord(item) ? normalizeChannelVideoRecord(item) : null))
        .filter((item): item is NormalizedChannelVideoRecord => Boolean(item))
    : [];
  const tempRawRows = (await readJsonLines(path.resolve(input.tempRoot, "raw", "videos.jsonl")))
    .map((item) => normalizeRawVideoRecord(item))
    .filter((item): item is NormalizedRawVideoRecord => Boolean(item));

  const rawRowMap = toRawRowMap(input.descriptor.rawRows);
  const channelVideoMap = toChannelVideoMap(input.descriptor.channelVideos);

  for (const videoId of input.newVideoIds) {
    const tempRawRow = tempRawRows.find((row) => row.videoId === videoId);
    const tempChannelVideo = tempChannelVideos.find((row) => row.videoId === videoId);
    if (!tempRawRow || !tempChannelVideo) {
      throw new HttpError(409, `Temp export missing artifacts for ${videoId}`);
    }

    const tempThumbnail = path.resolve(input.tempRoot, "thumbnails", `${videoId}.jpg`);
    const tempRawThumbnail = path.resolve(input.tempRoot, "raw", "thumbnails", `${videoId}.jpg`);
    const tempTranscript = path.resolve(input.tempRoot, "raw", "transcripts", `${videoId}.jsonl`);
    const tempAudio = path.resolve(input.tempRoot, "raw", "audio", `${videoId}.mp3`);
    const tempDerived = path.resolve(input.tempRoot, "derived", "video_features", `${videoId}.json`);

    const projectThumbnail = path.resolve(input.descriptor.projectRoot, "thumbnails", `${videoId}.jpg`);
    const projectRawThumbnail = path.resolve(input.descriptor.projectRoot, "raw", "thumbnails", `${videoId}.jpg`);
    const projectTranscript = path.resolve(input.descriptor.projectRoot, "raw", "transcripts", `${videoId}.jsonl`);
    const projectAudio = path.resolve(input.descriptor.projectRoot, "raw", "audio", `${videoId}.mp3`);
    const projectDerived = path.resolve(input.descriptor.projectRoot, "derived", "video_features", `${videoId}.json`);

    ensureInsideRoot(input.descriptor.exportsRoot, projectThumbnail);
    ensureInsideRoot(input.descriptor.exportsRoot, projectRawThumbnail);
    ensureInsideRoot(input.descriptor.exportsRoot, projectTranscript);
    ensureInsideRoot(input.descriptor.exportsRoot, projectAudio);
    ensureInsideRoot(input.descriptor.exportsRoot, projectDerived);

    await copyFileIfExists((await fileExists(tempThumbnail)) ? tempThumbnail : tempRawThumbnail, projectThumbnail);
    await copyFileIfExists(projectThumbnail, projectRawThumbnail);
    await copyFileIfExists(tempTranscript, projectTranscript);
    await copyFileIfExists(tempAudio, projectAudio);
    await copyFileIfExists(tempDerived, projectDerived);

    rawRowMap.set(videoId, tempRawRow);
    channelVideoMap.set(videoId, tempChannelVideo);
  }

  const existingCacheIndex = await loadCacheIndex({
    exportsRoot: input.descriptor.exportsRoot,
    channelFolderPath: input.descriptor.projectRoot,
    channelId: input.descriptor.channelId,
    exportVersion: input.descriptor.exportVersion
  });
  const tempCacheIndex = await loadCacheIndex({
    exportsRoot: input.descriptor.exportsRoot,
    channelFolderPath: input.tempRoot,
    channelId: input.descriptor.channelId,
    exportVersion: input.descriptor.exportVersion
  });

  const tempBucket = tempCacheIndex.timeframes[input.descriptor.projectTimeframe]?.videos ?? {};
  if (!existingCacheIndex.timeframes[input.descriptor.projectTimeframe]) {
    existingCacheIndex.timeframes[input.descriptor.projectTimeframe] = { videos: {} };
  }
  for (const videoId of input.newVideoIds) {
    const cacheEntry = tempBucket[videoId];
    if (cacheEntry) {
      existingCacheIndex.timeframes[input.descriptor.projectTimeframe].videos[videoId] = cacheEntry as CacheEntry;
    }
  }
  await saveCacheIndex({
    exportsRoot: input.descriptor.exportsRoot,
    channelFolderPath: input.descriptor.projectRoot,
    index: existingCacheIndex
  });

  return {
    rawRows: sortByPublishedAtDesc(Array.from(rawRowMap.values())),
    channelVideos: sortByPublishedAtDesc(Array.from(channelVideoMap.values()))
  };
}

async function writeIntermediateInventory(input: {
  descriptor: ProjectDescriptor;
  rawRows: NormalizedRawVideoRecord[];
  channelVideos: NormalizedChannelVideoRecord[];
}): Promise<void> {
  const rawVideosPath = path.resolve(input.descriptor.projectRoot, "raw", "videos.jsonl");
  ensureInsideRoot(input.descriptor.projectRoot, rawVideosPath);
  await writeJsonLinesAtomic(rawVideosPath, input.rawRows);

  const channelPath = path.resolve(input.descriptor.projectRoot, "channel.json");
  ensureInsideRoot(input.descriptor.projectRoot, channelPath);
  await writeJsonAtomic(channelPath, {
    ...input.descriptor.channelJson,
    videos: input.channelVideos
  });
}

function applyLatestVideoDetails(
  rawRows: NormalizedRawVideoRecord[],
  detailMap: Map<string, YoutubeVideoDetails>
): NormalizedRawVideoRecord[] {
  return rawRows.map((row) => {
    const latest = detailMap.get(row.videoId);
    if (!latest) {
      return row;
    }

    return {
      ...row,
      publishedAt: row.publishedAt || latest.publishedAt || "",
      ...(typeof row.durationSec === "number" && row.durationSec > 0 ? {} : { durationSec: latest.durationSec }),
      statistics: {
        viewCount: latest.statistics.viewCount,
        likeCount: latest.statistics.likeCount,
        commentCount: latest.statistics.commentCount
      }
    };
  });
}

async function reprocessExistingVideos(input: {
  projectId: string;
  videoIds: string[];
  callbacks: ProjectExtendProgressCallbacks;
  counters: { completed: number; total: number; processed: number; failed: number };
  warnings: string[];
}): Promise<void> {
  for (const videoId of input.videoIds) {
    input.callbacks.onVideoProgress?.({
      videoId,
      status: "processing",
      message: "reprocessing_features"
    });

    try {
      for (const feature of ["title", "description", "transcript", "thumbnail"] as const) {
        const result = await rerunVideoFeature(
          {
            projectId: input.projectId,
            videoId,
            feature,
            mode: "full"
          },
          {
            bypassProjectLock: true,
            reusePreparedAssets: true
          }
        );
        input.warnings.push(...result.warnings);
      }

      input.counters.processed += 1;
      input.counters.completed += 1;
      input.callbacks.onVideoProgress?.({
        videoId,
        status: "done",
        message: "reprocessed"
      });
      input.callbacks.onJobProgress?.({ ...input.counters });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown extend error";
      input.counters.failed += 1;
      input.counters.completed += 1;
      input.warnings.push(`Reprocess failed for ${videoId}: ${message}`);
      input.callbacks.onWarning?.({
        videoId,
        message
      });
      input.callbacks.onVideoProgress?.({
        videoId,
        status: "failed",
        message
      });
      input.callbacks.onJobProgress?.({ ...input.counters });
    }
  }
}

async function persistPerformanceArtifact(args: {
  projectRoot: string;
  exportsRoot: string;
  videoId: string;
  computedAt: string;
  performance: VideoPerformanceFeatures;
}): Promise<void> {
  const artifactPath = path.resolve(args.projectRoot, "derived", "video_features", `${args.videoId}.json`);
  ensureInsideRoot(args.exportsRoot, artifactPath);
  const existing = await readJsonFile(artifactPath);
  await writeJsonAtomic(artifactPath, {
    ...(existing ?? {}),
    schemaVersion: "derived.video_features.v1",
    videoId: args.videoId,
    computedAt: args.computedAt,
    performance: args.performance
  });
}

async function persistChannelModelsArtifact(args: {
  projectRoot: string;
  exportsRoot: string;
  channelId: string;
  timeframe: Timeframe;
  computedAt: string;
  model: ChannelModelSummary;
}): Promise<void> {
  const artifactPath = path.resolve(args.projectRoot, "derived", "channel_models.json");
  ensureInsideRoot(args.exportsRoot, artifactPath);
  await writeJsonAtomic(artifactPath, {
    schemaVersion: "derived.channel_models.v1",
    computedAt: args.computedAt,
    channelId: args.channelId,
    timeframe: args.timeframe,
    model: args.model
  });
}

async function collectManifestArtifacts(input: {
  descriptor: ProjectDescriptor;
  rawRows: NormalizedRawVideoRecord[];
}): Promise<string[]> {
  const previousArtifacts = Array.isArray(input.descriptor.manifestJson?.artifacts)
    ? input.descriptor.manifestJson?.artifacts.filter((item): item is string => typeof item === "string")
    : [];

  const candidatePaths = new Set<string>(previousArtifacts.map((item) => item.replace(/\\/g, "/").trim()).filter(Boolean));
  candidatePaths.add("channel.json");
  candidatePaths.add("raw/channel.json");
  candidatePaths.add("raw/videos.jsonl");
  candidatePaths.add("derived/channel_models.json");
  candidatePaths.add(".cache/index.json");

  for (const row of input.rawRows) {
    candidatePaths.add(path.posix.join("thumbnails", `${row.videoId}.jpg`));
    candidatePaths.add(path.posix.join("raw", "thumbnails", `${row.videoId}.jpg`));
    candidatePaths.add(normalizeRelativePath(row.transcriptRef.transcriptPath, path.posix.join("raw", "transcripts", `${row.videoId}.jsonl`)));
    candidatePaths.add(path.posix.join("derived", "video_features", `${row.videoId}.json`));
    if (row.audioLocalPath) {
      candidatePaths.add(normalizeRelativePath(row.audioLocalPath, path.posix.join("raw", "audio", `${row.videoId}.mp3`)));
    }
  }

  const existingArtifacts = await Promise.all(
    Array.from(candidatePaths).map(async (relativePath) => {
      const absolutePath = path.resolve(input.descriptor.projectRoot, relativePath);
      ensureInsideRoot(input.descriptor.projectRoot, absolutePath);
      return (await fileExists(absolutePath)) ? toSafeRelativePath(input.descriptor.projectRoot, absolutePath) : null;
    })
  );

  return existingArtifacts.filter((item): item is string => Boolean(item)).sort();
}

async function buildFinalChannelVideos(
  projectRoot: string,
  rawRows: NormalizedRawVideoRecord[],
  channelVideoMap: Map<string, NormalizedChannelVideoRecord>
): Promise<NormalizedChannelVideoRecord[]> {
  return sortByPublishedAtDesc(
    await Promise.all(rawRows.map((row) => buildChannelVideoRecord(projectRoot, row, channelVideoMap.get(row.videoId))))
  );
}

async function syncCurrentTimeframeCacheState(args: {
  descriptor: ProjectDescriptor;
  rawRows: NormalizedRawVideoRecord[];
}): Promise<void> {
  const cacheIndex = await loadCacheIndex({
    exportsRoot: args.descriptor.exportsRoot,
    channelFolderPath: args.descriptor.projectRoot,
    channelId: args.descriptor.channelId,
    exportVersion: args.descriptor.exportVersion
  });

  const timeframeBucket = cacheIndex.timeframes[args.descriptor.projectTimeframe];
  if (!timeframeBucket) {
    return;
  }

  for (const row of args.rawRows) {
    const entry = timeframeBucket.videos[row.videoId];
    if (!entry) {
      continue;
    }

    const rawTranscriptPath = normalizeRelativePath(
      row.transcriptRef.transcriptPath,
      path.posix.join("raw", "transcripts", `${row.videoId}.jsonl`)
    );
    const thumbnailPath = normalizeRelativePath(entry.artifacts.thumbnailPath, path.posix.join("thumbnails", `${row.videoId}.jpg`));
    const derivedPath = normalizeRelativePath(
      entry.artifacts.derivedVideoFeaturesPath,
      path.posix.join("derived", "video_features", `${row.videoId}.json`)
    );

    const rawTranscriptAbsolutePath = path.resolve(args.descriptor.projectRoot, rawTranscriptPath);
    const thumbnailAbsolutePath = path.resolve(args.descriptor.projectRoot, thumbnailPath);
    const derivedAbsolutePath = path.resolve(args.descriptor.projectRoot, derivedPath);
    ensureInsideRoot(args.descriptor.projectRoot, rawTranscriptAbsolutePath);
    ensureInsideRoot(args.descriptor.projectRoot, thumbnailAbsolutePath);
    ensureInsideRoot(args.descriptor.projectRoot, derivedAbsolutePath);

    const [rawTranscriptExists, thumbnailExists, derivedExists] = await Promise.all([
      fileExists(rawTranscriptAbsolutePath),
      fileExists(thumbnailAbsolutePath),
      fileExists(derivedAbsolutePath)
    ]);

    entry.artifacts = {
      ...entry.artifacts,
      rawTranscriptPath,
      thumbnailPath,
      derivedVideoFeaturesPath: derivedPath
    };
    entry.status = {
      ...entry.status,
      rawTranscript: rawTranscriptExists ? row.transcriptRef.transcriptStatus : "missing",
      thumbnail: thumbnailExists ? "ok" : "failed",
      derived: derivedExists ? (row.warnings.length > 0 ? "partial" : "ok") : "error",
      warnings: [...row.warnings]
    };
  }

  await saveCacheIndex({
    exportsRoot: args.descriptor.exportsRoot,
    channelFolderPath: args.descriptor.projectRoot,
    index: cacheIndex
  });
}

async function buildRawChannelPayload(args: {
  descriptor: ProjectDescriptor;
  channelStats?: YoutubeChannelStats;
  exportedAt: string;
  jobId: string;
  warnings: string[];
}): Promise<Record<string, unknown>> {
  return {
    ...(args.descriptor.rawChannelJson ?? {}),
    exportVersion: args.descriptor.exportVersion,
    exportedAt: args.exportedAt,
    jobId: args.jobId,
    channelId: args.descriptor.channelId,
    channelName: args.descriptor.channelName,
    sourceInput: args.descriptor.sourceInput,
    timeframe: args.descriptor.projectTimeframe,
    timeframeResolved: isRecord(args.descriptor.channelJson.timeframeResolved)
      ? args.descriptor.channelJson.timeframeResolved
      : null,
    ...(args.channelStats ? { channelStats: args.channelStats } : {}),
    provenance: {
      dataSources: ["youtube-data-api-v3", "youtube-thumbnail-http", "local-asr"],
      warnings: dedupeStrings(args.warnings),
      env: {
        LOCAL_ASR_ENABLED: env.localAsrEnabled,
        TRANSCRIPT_LANG: env.transcriptLang ?? null
      }
    }
  };
}

function buildManifestPayload(args: {
  descriptor: ProjectDescriptor;
  rawRows: NormalizedRawVideoRecord[];
  exportedAt: string;
  jobId: string;
  artifacts: string[];
  warnings: string[];
}): Record<string, unknown> {
  const transcriptCounts = args.rawRows.reduce(
    (acc, row) => {
      if (row.transcriptRef.transcriptStatus === "ok") {
        acc.ok += 1;
      } else if (row.transcriptRef.transcriptStatus === "error") {
        acc.error += 1;
      } else {
        acc.missing += 1;
      }
      return acc;
    },
    { ok: 0, missing: 0, error: 0 }
  );

  return {
    ...(args.descriptor.manifestJson ?? {}),
    jobId: args.jobId,
    channelId: args.descriptor.channelId,
    channelFolder: args.descriptor.projectId ?? path.basename(args.descriptor.projectRoot),
    exportVersion: args.descriptor.exportVersion,
    exportedAt: args.exportedAt,
    counts: {
      ...(isRecord(args.descriptor.manifestJson?.counts) ? args.descriptor.manifestJson?.counts : {}),
      totalVideosSelected: args.rawRows.length,
      transcriptsOk: transcriptCounts.ok,
      transcriptsMissing: transcriptCounts.missing,
      transcriptsError: transcriptCounts.error
    },
    warnings: dedupeStrings(args.warnings),
    artifacts: [...new Set([...args.artifacts, "manifest.json"])].sort()
  };
}

export async function getProjectExtendCandidates(
  projectId: string,
  timeframe: Timeframe
): Promise<ProjectExtendCandidatesResponse> {
  const descriptor = await loadProjectDescriptor(projectId);
  const existingVideoIds = new Set(descriptor.rawRows.map((row) => row.videoId));
  const result = await listVideosForChannel(descriptor.channelId, timeframe);

  return {
    projectId,
    projectTimeframe: descriptor.projectTimeframe,
    timeframe,
    channelId: descriptor.channelId,
    channelName: descriptor.channelName,
    videos: result.videos.map((video) => ({
      videoId: video.videoId,
      title: video.title,
      publishedAt: video.publishedAt,
      viewCount: video.viewCount,
      thumbnailUrl: video.thumbnailUrl,
      alreadyInProject: existingVideoIds.has(video.videoId)
    }))
  };
}

export async function extendProject(
  request: ProjectExtendRequest,
  callbacks: ProjectExtendProgressCallbacks = {}
): Promise<ProjectExtendResult> {
  const descriptor = await loadProjectDescriptor(request.projectId);
  const selectedVideoIds = dedupeStrings(request.selectedVideoIds ?? []);
  if (selectedVideoIds.length === 0) {
    throw new HttpError(400, "selectedVideoIds is required");
  }

  const existingVideoIds = new Set(descriptor.rawRows.map((row) => row.videoId));
  const newVideoIds = selectedVideoIds.filter((videoId) => !existingVideoIds.has(videoId));
  const reprocessVideoIds = dedupeStrings(request.reprocessVideoIds ?? []).filter(
    (videoId) => selectedVideoIds.includes(videoId) && existingVideoIds.has(videoId)
  );

  const counters = {
    completed: 0,
    total: Math.max(1, newVideoIds.length + reprocessVideoIds.length),
    processed: 0,
    failed: 0
  };
  callbacks.onJobStarted?.({ total: counters.total });

  const warnings: string[] = [];
  let rawRows = descriptor.rawRows;
  let channelVideos = descriptor.channelVideos;
  const extendJobId = request.jobId ?? `extend-${Date.now()}`;
  const tempExportName = `__extend_tmp_${request.projectId}_${extendJobId}`;
  const tempRoot = path.resolve(descriptor.exportsRoot, sanitizeFolderName(tempExportName));
  ensureInsideRoot(descriptor.exportsRoot, tempRoot);

  try {
    if (newVideoIds.length > 0) {
      const tempResult = await exportSelectedVideos(
        {
          channelId: descriptor.channelId,
          channelName: tempExportName,
          sourceInput: descriptor.sourceInput,
          timeframe: descriptor.projectTimeframe,
          selectedVideoIds: newVideoIds
        },
        {
          onVideoProgress: ({ videoId, stage }) => {
            callbacks.onVideoProgress?.({
              videoId,
              status: "processing",
              message: stage
            });
          },
          onWarning: ({ videoId, message }) => {
            warnings.push(message);
            callbacks.onWarning?.({ videoId, message });
          }
        }
      );

      const merged = await mergeNewVideoArtifacts({
        descriptor,
        tempRoot: tempResult.folderPath,
        newVideoIds
      });
      rawRows = merged.rawRows;
      channelVideos = merged.channelVideos;
      await writeIntermediateInventory({
        descriptor,
        rawRows,
        channelVideos
      });

      for (const videoId of newVideoIds) {
        counters.processed += 1;
        counters.completed += 1;
        callbacks.onVideoProgress?.({
          videoId,
          status: "done",
          message: "added_to_inventory"
        });
        callbacks.onJobProgress?.({ ...counters });
      }

      await fs.rm(tempResult.folderPath, { recursive: true, force: true });
    }

    await reprocessExistingVideos({
      projectId: request.projectId,
      videoIds: reprocessVideoIds,
      callbacks,
      counters,
      warnings
    });

    const persistedRawRows = (await readJsonLines(path.resolve(descriptor.projectRoot, "raw", "videos.jsonl")))
      .map((row) => normalizeRawVideoRecord(row))
      .filter((row): row is NormalizedRawVideoRecord => Boolean(row));
    rawRows = persistedRawRows.length > 0 ? persistedRawRows : rawRows;

    const allInventoryVideoIds = rawRows.map((row) => row.videoId);
    const [videoDetailsResult, channelDetailsResult] = await Promise.all([
      getVideoDetails(allInventoryVideoIds),
      getChannelDetails(descriptor.channelId)
    ]);
    warnings.push(...videoDetailsResult.warnings, ...channelDetailsResult.warnings);
    for (const message of [...videoDetailsResult.warnings, ...channelDetailsResult.warnings]) {
      callbacks.onWarning?.({ message });
    }

    const detailMap = new Map(videoDetailsResult.videos.map((video) => [video.videoId, video]));
    rawRows = applyLatestVideoDetails(rawRows, detailMap);
    rawRows = sortByPublishedAtDesc(rawRows);

    const exportedAt = new Date().toISOString();
    const performanceResult = computePerformancePerVideo(
      rawRows.map((row) => ({
        videoId: row.videoId,
        publishedAt: row.publishedAt,
        viewCount: row.statistics.viewCount,
        likeCount: row.statistics.likeCount,
        commentCount: row.statistics.commentCount,
        durationSec: row.durationSec ?? null
      })),
      exportedAt
    );
    warnings.push(...performanceResult.warnings);
    for (const message of performanceResult.warnings) {
      callbacks.onWarning?.({ message });
    }

    rawRows = rawRows.map((row) => {
      const performance = performanceResult.perVideoMap[row.videoId];
      if (!performance) {
        return row;
      }
      return {
        ...row,
        daysSincePublish: performance.daysSincePublish,
        viewsPerDay: performance.viewsPerDay,
        likeRate: performance.likeRate ?? 0,
        commentRate: performance.commentRate ?? 0
      };
    });
    rawRows = await Promise.all(
      rawRows.map(async (row) => ({
        ...row,
        warnings: await sanitizeVideoWarnings({
          projectRoot: descriptor.projectRoot,
          videoId: row.videoId,
          transcriptPath: row.transcriptRef.transcriptPath,
          warnings: row.warnings
        })
      }))
    );

    const persistedProjectWarnings = await sanitizeProjectWarnings({
      projectRoot: descriptor.projectRoot,
      rows: rawRows.map((row) => ({
        videoId: row.videoId,
        transcriptPath: row.transcriptRef.transcriptPath,
        warnings: row.warnings
      })),
      warnings,
      performanceWarnings: performanceResult.warnings
    });

    const channelVideoMap = toChannelVideoMap(channelVideos);
    channelVideos = await buildFinalChannelVideos(descriptor.projectRoot, rawRows, channelVideoMap);

    await writeJsonLinesAtomic(path.resolve(descriptor.projectRoot, "raw", "videos.jsonl"), rawRows);
    await writeJsonAtomic(path.resolve(descriptor.projectRoot, "channel.json"), {
      ...descriptor.channelJson,
      exportedAt,
      timeframe: descriptor.projectTimeframe,
      videos: channelVideos
    });
    await writeJsonAtomic(
      path.resolve(descriptor.projectRoot, "raw", "channel.json"),
      await buildRawChannelPayload({
        descriptor,
        channelStats: channelDetailsResult.channelStats,
        exportedAt,
        jobId: extendJobId,
        warnings: persistedProjectWarnings
      })
    );

    await Promise.all(
      rawRows.map((row) => {
        const performance = performanceResult.perVideoMap[row.videoId];
        if (!performance) {
          return Promise.resolve();
        }
        return persistPerformanceArtifact({
          projectRoot: descriptor.projectRoot,
          exportsRoot: descriptor.exportsRoot,
          videoId: row.videoId,
          computedAt: exportedAt,
          performance
        });
      })
    );
    await persistChannelModelsArtifact({
      projectRoot: descriptor.projectRoot,
      exportsRoot: descriptor.exportsRoot,
      channelId: descriptor.channelId,
      timeframe: descriptor.projectTimeframe,
      computedAt: exportedAt,
      model: performanceResult.modelSummary
    });

    const manifestArtifacts = await collectManifestArtifacts({
      descriptor,
      rawRows
    });
    await writeJsonAtomic(
      path.resolve(descriptor.projectRoot, "manifest.json"),
      buildManifestPayload({
        descriptor,
        rawRows,
        exportedAt,
        jobId: extendJobId,
        artifacts: manifestArtifacts,
        warnings: persistedProjectWarnings
      })
    );
    await syncManifestThumbnailCounts(descriptor.projectRoot);
    await syncCurrentTimeframeCacheState({
      descriptor,
      rawRows
    });

    if (newVideoIds.length === 0 && reprocessVideoIds.length === 0) {
      counters.completed = counters.total;
      counters.processed = counters.total;
      callbacks.onJobProgress?.({ ...counters });
    }

    return {
      projectId: request.projectId,
      addedCount: newVideoIds.length,
      refreshedCount: rawRows.length,
      reprocessedCount: reprocessVideoIds.length
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
