import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { ExportPayload, Timeframe } from "../types.js";
import { getSelectedVideoDetails } from "./youtubeService.js";
import { HttpError } from "../utils/errors.js";
import { downloadToBuffer } from "../utils/http.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { getTranscriptWithFallback, TranscriptPipelineResult } from "./transcriptPipeline.js";

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
    for (const item of processedVideos) {
      callbacks.onVideoProgress?.({
        videoId: item.videoId,
        stage: "writing_json"
      });
    }

    const channelJson: ExportPayload = {
      channelName: request.channelName,
      channelId: request.channelId,
      sourceInput: request.sourceInput,
      timeframe: request.timeframe,
      videos: exportVideos
    };

    const channelFilePath = path.resolve(channelFolderPath, "channel.json");
    ensureInsideRoot(exportsRoot, channelFilePath);
    await fs.writeFile(channelFilePath, JSON.stringify(channelJson, null, 2), "utf-8");

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
