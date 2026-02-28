import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { ExportPayload, Timeframe, TimeframeResolved } from "../types.js";
import { getSelectedVideoDetails } from "./youtubeService.js";
import { HttpError } from "../utils/errors.js";
import { downloadToBuffer } from "../utils/http.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { getTranscriptWithFallback, TranscriptPipelineResult } from "./transcriptPipeline.js";
import { resolveTimeframeRange } from "../utils/timeframe.js";

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
  getSelectedVideoDetails: typeof getSelectedVideoDetails;
  downloadToBuffer: typeof downloadToBuffer;
  getTranscriptWithFallback: typeof getTranscriptWithFallback;
}

type ProcessedVideo = ExportPayload["videos"][number] & {
  warnings: string[];
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
  viewCount: number;
  publishedAt: string;
  transcriptStatus: "ok" | "missing" | "error";
  transcriptPath: string;
  thumbnailPath: string;
  warnings: string[];
}

interface RawTranscriptRecordV1 {
  videoId: string;
  transcript: string;
  transcriptStatus: "ok" | "missing" | "error";
  exportedAt: string;
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

interface RawPackInput {
  exportsRoot: string;
  channelFolderPath: string;
  thumbnailsFolderPath: string;
  processedVideos: ProcessedVideo[];
  request: ExportRequest;
  jobId: string;
  exportVersion: string;
  exportedAt: string;
  timeframeResolved: TimeframeResolved;
  warnings: string[];
  existingThumbnailVideoIds: Set<string>;
}

interface RawPackOutput {
  artifactPaths: string[];
}

const EXPORT_VERSION = "1.1";
const TRANSCRIPT_CONCURRENCY = 4;

const defaultDependencies: ExportDependencies = {
  getSelectedVideoDetails,
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

async function writeJsonLines(filePath: string, records: unknown[]): Promise<void> {
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(filePath, `${content}\n`, "utf-8");
}

function toTranscriptStatus(value: ProcessedVideo["transcriptStatus"]): "ok" | "missing" | "error" {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
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
  const rawFolderPath = path.resolve(input.channelFolderPath, "raw");
  const rawChannelFilePath = path.resolve(rawFolderPath, "channel.json");
  const rawVideosFilePath = path.resolve(rawFolderPath, "videos.jsonl");
  const rawTranscriptsFolderPath = path.resolve(rawFolderPath, "transcripts");

  ensureInsideRoot(input.exportsRoot, rawFolderPath);
  ensureInsideRoot(input.exportsRoot, rawChannelFilePath);
  ensureInsideRoot(input.exportsRoot, rawVideosFilePath);
  ensureInsideRoot(input.exportsRoot, rawTranscriptsFolderPath);

  await fs.mkdir(rawTranscriptsFolderPath, { recursive: true });
  await ensureRawThumbnailsPath(
    input.exportsRoot,
    rawFolderPath,
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
    provenance: {
      dataSources: ["youtube-data-api-v3", "youtube-transcript", "local-asr-fallback"],
      warnings: [...input.warnings],
      env: {
        LOCAL_ASR_ENABLED: env.localAsrEnabled,
        TRANSCRIPT_LANG: env.transcriptLang ?? null
      }
    }
  };

  await fs.writeFile(rawChannelFilePath, JSON.stringify(rawChannel, null, 2), "utf-8");

  const rawVideoRecords: RawVideoRecordV1[] = [];
  const rawTranscriptArtifacts: string[] = [];
  for (const video of input.processedVideos) {
    const transcriptPath = path.resolve(rawTranscriptsFolderPath, `${video.videoId}.jsonl`);
    ensureInsideRoot(input.exportsRoot, transcriptPath);
    const transcriptStatus = toTranscriptStatus(video.transcriptStatus);

    const transcriptRecord: RawTranscriptRecordV1 = {
      videoId: video.videoId,
      transcript: video.transcript,
      transcriptStatus,
      exportedAt: input.exportedAt,
      warnings: [...video.warnings]
    };
    await writeJsonLines(transcriptPath, [transcriptRecord]);
    rawTranscriptArtifacts.push(transcriptPath);

    rawVideoRecords.push({
      videoId: video.videoId,
      title: video.title,
      viewCount: video.viewCount,
      publishedAt: video.publishedAt,
      transcriptStatus,
      transcriptPath: path.posix.join("raw", "transcripts", `${video.videoId}.jsonl`),
      thumbnailPath: path.posix.join("raw", "thumbnails", `${video.videoId}.jpg`),
      warnings: [...video.warnings]
    });
  }

  await writeJsonLines(rawVideosFilePath, rawVideoRecords);

  const rawThumbnailArtifacts = Array.from(input.existingThumbnailVideoIds, (videoId) =>
    path.resolve(rawFolderPath, "thumbnails", `${videoId}.jpg`)
  );

  return {
    artifactPaths: [rawChannelFilePath, rawVideosFilePath, ...rawTranscriptArtifacts, ...rawThumbnailArtifacts]
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
  const timeframeResolved = resolveTimeframeRange(request.timeframe);
  const folderName = sanitizeFolderName(request.channelName);
  const channelFolderPath = path.resolve(exportsRoot, folderName);
  const thumbnailsFolderPath = path.resolve(channelFolderPath, "thumbnails");
  const tempRootPath = path.resolve(exportsRoot, ".tmp", jobId);
  const tempAudioPath = path.resolve(tempRootPath, "audio");

  ensureInsideRoot(exportsRoot, channelFolderPath);
  ensureInsideRoot(exportsRoot, thumbnailsFolderPath);
  ensureInsideRoot(exportsRoot, tempRootPath);
  ensureInsideRoot(exportsRoot, tempAudioPath);

  await fs.mkdir(thumbnailsFolderPath, { recursive: true });
  await fs.mkdir(tempAudioPath, { recursive: true });

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
        const thumbnailRelativePath = path.posix.join("thumbnails", `${video.videoId}.jpg`);
        const thumbnailAbsolutePath = path.resolve(channelFolderPath, thumbnailRelativePath);
        const outputMp3Path = path.resolve(tempAudioPath, `${video.videoId}.mp3`);
        ensureInsideRoot(exportsRoot, thumbnailAbsolutePath);
        ensureInsideRoot(exportsRoot, outputMp3Path);

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

        if (video.thumbnailUrl) {
          try {
            const image = await dependencies.downloadToBuffer(video.thumbnailUrl, 12_000);
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

        return {
          videoId: video.videoId,
          title: video.title,
          viewCount: video.viewCount,
          publishedAt: video.publishedAt,
          thumbnailPath: thumbnailRelativePath,
          transcript: transcriptResult.transcript,
          transcriptStatus: transcriptResult.status,
          warnings: videoWarnings
        };
      }
    );

    const exportVideos: ExportPayload["videos"] = processedVideos.map(({ warnings: _, ...video }) => video);
    const thumbnailAvailability = await collectThumbnailAvailability(exportsRoot, channelFolderPath, processedVideos);
    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json"
      });
    }

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

    const rawPack = await writeRawPack({
      exportsRoot,
      channelFolderPath,
      thumbnailsFolderPath,
      processedVideos,
      request,
      jobId,
      exportVersion: EXPORT_VERSION,
      exportedAt,
      timeframeResolved,
      warnings,
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
    const artifactPaths = [channelFilePath, ...thumbnailArtifactPaths, ...rawPack.artifactPaths];
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
