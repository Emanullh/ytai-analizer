import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { persistDescriptionFeaturesArtifact } from "../derived/descriptionFeaturesAgent.js";
import { persistThumbnailFeaturesArtifact } from "../derived/thumbnailFeaturesAgent.js";
import { persistTitleFeaturesArtifact } from "../derived/titleFeaturesAgent.js";
import { loadTranscriptJsonl } from "../derived/transcriptArtifacts.js";
import { persistTranscriptFeaturesArtifact } from "../derived/transcriptFeaturesAgent.js";
import type { Timeframe } from "../types.js";
import { HttpError } from "../utils/errors.js";
import { fileExists } from "../utils/fileExists.js";
import {
  buildCacheEntry,
  computeHashes,
  loadCacheIndex,
  resolveCacheArtifactRelativePath,
  saveCacheIndex,
  updateVideoCacheEntry
} from "./exportCacheService.js";
import { ProjectLockError, projectOperationLockService } from "./projectOperationLockService.js";

export type VideoFeatureKind = "thumbnail" | "title" | "description" | "transcript";

export interface RerunVideoFeatureRequest {
  projectId: string;
  videoId: string;
  feature: VideoFeatureKind;
}

export interface RerunVideoFeatureResult {
  ok: true;
  projectId: string;
  videoId: string;
  feature: VideoFeatureKind;
  warnings: string[];
  artifactPath: string;
}

interface RerunVideoFeatureOptions {
  bypassProjectLock?: boolean;
}

interface ChannelContext {
  projectRoot: string;
  exportsRoot: string;
  channelId: string;
  exportVersion: string;
  timeframe: Timeframe;
}

interface RawVideoTranscriptRef {
  transcriptPath: string;
  transcriptSource: "captions" | "asr" | "none";
  transcriptStatus: "ok" | "missing" | "error";
}

interface RawVideoRecord {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationSec: number | undefined;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  thumbnailLocalPath?: string;
  transcriptRef: RawVideoTranscriptRef;
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

function getExportsRoot(): string {
  return path.resolve(process.cwd(), "exports");
}

function toString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function normalizeTimeframe(value: unknown): Timeframe {
  if (value === "1m" || value === "6m" || value === "1y") {
    return value;
  }
  throw new HttpError(409, "Project timeframe is missing or invalid");
}

function normalizeTranscriptSource(value: unknown): RawVideoTranscriptRef["transcriptSource"] {
  if (value === "captions" || value === "asr" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeTranscriptStatus(value: unknown): RawVideoTranscriptRef["transcriptStatus"] {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function normalizeLanguageHint(...values: unknown[]): "auto" | "en" | "es" {
  for (const value of values) {
    const normalized = toString(value)?.toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith("en")) {
      return "en";
    }
    if (normalized.startsWith("es")) {
      return "es";
    }
  }
  return "auto";
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings.map((warning) => warning.trim()).filter(Boolean)));
}

async function readChannelContext(projectId: string): Promise<ChannelContext> {
  validatePathSegment(projectId, "projectId");
  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, projectId);
  ensureInsideRoot(exportsRoot, projectRoot);

  if (!(await fileExists(projectRoot))) {
    throw new HttpError(404, "Project not found");
  }

  const channelPath = path.resolve(projectRoot, "channel.json");
  ensureInsideRoot(projectRoot, channelPath);
  const raw = await fs.readFile(channelPath, "utf-8").catch(() => null);
  if (!raw) {
    throw new HttpError(409, "channel.json is missing for this project");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(409, "channel.json is invalid");
  }

  if (!isRecord(parsed)) {
    throw new HttpError(409, "channel.json is invalid");
  }

  const channelId = toString(parsed.channelId);
  const exportVersion = toString(parsed.exportVersion) ?? "1.1";
  if (!channelId) {
    throw new HttpError(409, "channel.json is missing channelId");
  }

  return {
    projectRoot,
    exportsRoot,
    channelId,
    exportVersion,
    timeframe: normalizeTimeframe(parsed.timeframe)
  };
}

async function readRawVideo(projectRoot: string, videoId: string): Promise<RawVideoRecord> {
  validatePathSegment(videoId, "videoId");
  const rawVideosPath = path.resolve(projectRoot, "raw", "videos.jsonl");
  ensureInsideRoot(projectRoot, rawVideosPath);

  const rawVideos = await fs.readFile(rawVideosPath, "utf-8").catch(() => null);
  if (!rawVideos) {
    throw new HttpError(409, "raw/videos.jsonl is missing for this project");
  }

  for (const line of rawVideos.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || toString(parsed.videoId) !== videoId) {
      continue;
    }

    const transcriptRef = isRecord(parsed.transcriptRef) ? parsed.transcriptRef : {};
    return {
      videoId,
      title: toString(parsed.title) ?? videoId,
      description: toString(parsed.description) ?? "",
      publishedAt: toString(parsed.publishedAt),
      durationSec: toFiniteNumber(parsed.durationSec),
      defaultLanguage: toString(parsed.defaultLanguage) ?? undefined,
      defaultAudioLanguage: toString(parsed.defaultAudioLanguage) ?? undefined,
      thumbnailLocalPath: toString(parsed.thumbnailLocalPath) ?? undefined,
      transcriptRef: {
        transcriptPath: normalizeRelativePath(
          toString(transcriptRef.transcriptPath),
          path.posix.join("raw", "transcripts", `${videoId}.jsonl`)
        ),
        transcriptSource: normalizeTranscriptSource(transcriptRef.transcriptSource),
        transcriptStatus: normalizeTranscriptStatus(transcriptRef.transcriptStatus)
      }
    };
  }

  throw new HttpError(404, `Video not found in raw/videos.jsonl: ${videoId}`);
}

async function resolveThumbnailPaths(projectRoot: string, video: RawVideoRecord): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const preferredRelative = path.posix.join("thumbnails", `${video.videoId}.jpg`);
  const preferredAbsolute = path.resolve(projectRoot, preferredRelative);
  ensureInsideRoot(projectRoot, preferredAbsolute);
  if (await fileExists(preferredAbsolute)) {
    return {
      absolutePath: preferredAbsolute,
      relativePath: preferredRelative
    };
  }

  const fallbackRelative = normalizeRelativePath(video.thumbnailLocalPath ?? null, preferredRelative);
  const fallbackAbsolute = path.resolve(projectRoot, fallbackRelative);
  ensureInsideRoot(projectRoot, fallbackAbsolute);
  return {
    absolutePath: fallbackAbsolute,
    relativePath: fallbackRelative
  };
}

async function runFeatureRerun(input: {
  context: ChannelContext;
  video: RawVideoRecord;
  feature: VideoFeatureKind;
}): Promise<{
  warnings: string[];
  artifactPath: string;
  transcriptText: string;
  transcriptPath: string;
  transcriptSource: RawVideoTranscriptRef["transcriptSource"];
  transcriptStatus: RawVideoTranscriptRef["transcriptStatus"];
  thumbnailPath: string;
}> {
  const { context, video, feature } = input;
  const { projectRoot, exportsRoot } = context;

  const transcriptRelativePath = normalizeRelativePath(
    video.transcriptRef.transcriptPath,
    path.posix.join("raw", "transcripts", `${video.videoId}.jsonl`)
  );
  const transcriptAbsolutePath = path.resolve(projectRoot, transcriptRelativePath);
  ensureInsideRoot(projectRoot, transcriptAbsolutePath);

  const transcriptArtifact = await loadTranscriptJsonl(transcriptAbsolutePath, { videoId: video.videoId });
  const transcriptText = transcriptArtifact.segments.map((segment) => segment.text).join(" ").trim();
  const transcriptSegments = transcriptArtifact.segments.map((segment) => ({
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    confidence: segment.confidence
  }));
  const transcriptSource = normalizeTranscriptSource(transcriptArtifact.meta?.source ?? video.transcriptRef.transcriptSource);
  const transcriptStatus = normalizeTranscriptStatus(transcriptArtifact.meta?.status ?? video.transcriptRef.transcriptStatus);
  const languageHint = normalizeLanguageHint(video.defaultLanguage, video.defaultAudioLanguage, transcriptArtifact.meta?.language);
  const thumbnail = await resolveThumbnailPaths(projectRoot, video);

  let warnings: string[] = [];
  let artifactPath = path.posix.join("derived", "video_features", `${video.videoId}.json`);

  if (feature === "thumbnail") {
    if (!(await fileExists(thumbnail.absolutePath))) {
      throw new HttpError(404, `Thumbnail not found for video ${video.videoId}`);
    }
    const result = await persistThumbnailFeaturesArtifact({
      exportsRoot,
      channelFolderPath: projectRoot,
      videoId: video.videoId,
      title: video.title,
      thumbnailAbsPath: thumbnail.absolutePath,
      thumbnailLocalPath: thumbnail.relativePath,
      compute: {
        deterministic: true,
        deterministicMode: "full",
        llm: true
      }
    });
    warnings = result.warnings;
    artifactPath = result.artifactRelativePath;
  } else if (feature === "title") {
    const result = await persistTitleFeaturesArtifact({
      exportsRoot,
      channelFolderPath: projectRoot,
      videoId: video.videoId,
      title: video.title,
      transcript: transcriptText,
      transcriptSegments,
      languageHint,
      compute: {
        deterministic: true,
        embeddings: true,
        llm: true
      }
    });
    warnings = result.warnings;
    artifactPath = result.artifactRelativePath;
  } else if (feature === "description") {
    const result = await persistDescriptionFeaturesArtifact({
      exportsRoot,
      channelFolderPath: projectRoot,
      videoId: video.videoId,
      title: video.title,
      description: video.description,
      languageHint,
      compute: {
        deterministic: true,
        llm: true
      }
    });
    warnings = result.warnings;
    artifactPath = result.artifactRelativePath;
  } else {
    const result = await persistTranscriptFeaturesArtifact({
      exportsRoot,
      channelFolderPath: projectRoot,
      videoId: video.videoId,
      title: video.title,
      transcriptArtifactPath: transcriptAbsolutePath,
      durationSec: video.durationSec,
      publishedAt: video.publishedAt ?? undefined,
      nowISO: new Date().toISOString(),
      languageHint,
      compute: {
        deterministic: true,
        llm: true
      }
    });
    warnings = result.warnings;
    artifactPath = result.artifactRelativePath;
  }

  return {
    warnings: dedupeWarnings([...warnings, ...transcriptArtifact.warnings]),
    artifactPath,
    transcriptText,
    transcriptPath: transcriptRelativePath,
    transcriptSource,
    transcriptStatus,
    thumbnailPath: thumbnail.relativePath
  };
}

export async function rerunVideoFeature(
  request: RerunVideoFeatureRequest,
  options: RerunVideoFeatureOptions = {}
): Promise<RerunVideoFeatureResult> {
  const ownerId = randomUUID();
  const context = await readChannelContext(request.projectId);
  const operation = `rerun_video_feature:${request.feature}:${request.videoId}`;

  if (!options.bypassProjectLock) {
    projectOperationLockService.acquireOrThrow({
      projectId: request.projectId,
      operation,
      ownerId
    });
  }

  try {
    const video = await readRawVideo(context.projectRoot, request.videoId);
    const featureResult = await runFeatureRerun({
      context,
      video,
      feature: request.feature
    });

    const thumbnailAbsolutePath = path.resolve(context.projectRoot, featureResult.thumbnailPath);
    ensureInsideRoot(context.projectRoot, thumbnailAbsolutePath);
    const finalHashes = await computeHashes({
      title: video.title,
      description: video.description,
      transcriptText: featureResult.transcriptText,
      transcriptSource: featureResult.transcriptSource,
      thumbnailFilePath: await fileExists(thumbnailAbsolutePath) ? thumbnailAbsolutePath : undefined
    });

    const cacheIndex = await loadCacheIndex({
      exportsRoot: context.exportsRoot,
      channelFolderPath: context.projectRoot,
      channelId: context.channelId,
      exportVersion: context.exportVersion
    });

    const artifactAbsolutePath = path.resolve(context.projectRoot, featureResult.artifactPath);
    ensureInsideRoot(context.projectRoot, artifactAbsolutePath);
    const [thumbnailExists, derivedExists] = await Promise.all([
      fileExists(thumbnailAbsolutePath),
      fileExists(artifactAbsolutePath)
    ]);

    updateVideoCacheEntry({
      index: cacheIndex,
      timeframe: context.timeframe,
      videoId: request.videoId,
      entry: buildCacheEntry({
        videoId: request.videoId,
        hashes: finalHashes,
        artifacts: {
          rawTranscriptPath: featureResult.transcriptPath,
          thumbnailPath: featureResult.thumbnailPath,
          derivedVideoFeaturesPath: resolveCacheArtifactRelativePath({
            channelFolderPath: context.projectRoot,
            artifactAbsolutePath
          })
        },
        status: {
          rawTranscript: featureResult.transcriptStatus,
          thumbnail: thumbnailExists ? "ok" : "failed",
          derived: derivedExists ? (featureResult.warnings.length > 0 ? "partial" : "ok") : "error",
          warnings: [...featureResult.warnings]
        }
      })
    });

    await saveCacheIndex({
      exportsRoot: context.exportsRoot,
      channelFolderPath: context.projectRoot,
      index: cacheIndex
    });

    return {
      ok: true,
      projectId: request.projectId,
      videoId: request.videoId,
      feature: request.feature,
      warnings: featureResult.warnings,
      artifactPath: featureResult.artifactPath
    };
  } finally {
    if (!options.bypassProjectLock) {
      projectOperationLockService.release({
        projectId: request.projectId,
        ownerId
      });
    }
  }
}

export function isVideoFeatureRerunLockError(error: unknown): error is ProjectLockError {
  return error instanceof ProjectLockError;
}
