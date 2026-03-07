import { randomUUID } from "node:crypto";
import path from "node:path";
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
import { syncManifestThumbnailCounts } from "./projectManifestSyncService.js";
import { computeVideoFeatureArtifact } from "./videoFeatureComputeService.js";
import {
  prepareVideoFeatureInputs,
  readChannelContext,
  readRawVideo,
  type PreparedFeatureAssets,
  type VideoFeatureKind,
  type VideoFeatureRerunMode
} from "./videoFeaturePreparationService.js";

export type { VideoFeatureKind, VideoFeatureRerunMode } from "./videoFeaturePreparationService.js";

export interface RerunVideoFeatureRequest {
  projectId: string;
  videoId: string;
  feature: VideoFeatureKind;
  mode?: VideoFeatureRerunMode;
}

export interface RerunVideoFeatureResult {
  ok: true;
  projectId: string;
  videoId: string;
  feature: VideoFeatureKind;
  mode: VideoFeatureRerunMode;
  warnings: string[];
  artifactPath: string | null;
  stepsExecuted: string[];
  preparedAssets: PreparedFeatureAssets;
}

interface RerunVideoFeatureOptions {
  bypassProjectLock?: boolean;
  reusePreparedAssets?: boolean;
}

function resolveDerivedArtifactRelativePath(videoId: string): string {
  return path.posix.join("derived", "video_features", `${videoId}.json`);
}

async function runFeatureComputation(input: {
  projectRoot: string;
  exportsRoot: string;
  videoId: string;
  feature: VideoFeatureKind;
  title: string;
  description: string;
  durationSec: number | undefined;
  publishedAt: string | null;
  languageHint: "auto" | "en" | "es";
  transcriptText: string;
  transcriptSegments: Array<{
    startSec: number | null;
    endSec: number | null;
    text: string;
    confidence: number | null;
  }>;
  transcriptArtifactPath: string;
  thumbnailRelativePath: string;
}): Promise<{ warnings: string[]; artifactPath: string }> {
  const thumbnailAbsolutePath = path.resolve(input.projectRoot, input.thumbnailRelativePath);
  if (input.feature === "thumbnail" && !(await fileExists(thumbnailAbsolutePath))) {
    throw new HttpError(404, `Thumbnail not found for video ${input.videoId}`);
  }

  const result = await computeVideoFeatureArtifact({
    feature: input.feature,
    exportsRoot: input.exportsRoot,
    channelFolderPath: input.projectRoot,
    videoId: input.videoId,
    title: input.title,
    description: input.description,
    transcriptText: input.transcriptText,
    transcriptSegments: input.transcriptSegments,
    transcriptArtifactPath: input.transcriptArtifactPath,
    durationSec: input.durationSec,
    publishedAt: input.publishedAt ?? undefined,
    nowISO: new Date().toISOString(),
    languageHint: input.languageHint,
    thumbnailAbsPath: input.feature === "thumbnail" ? thumbnailAbsolutePath : undefined,
    thumbnailLocalPath: input.feature === "thumbnail" ? input.thumbnailRelativePath : undefined,
    thumbnailCompute:
      input.feature === "thumbnail"
        ? {
            deterministic: true,
            deterministicMode: "full",
            llm: true
          }
        : undefined,
    titleCompute:
      input.feature === "title"
        ? {
            deterministic: true,
            embeddings: true,
            llm: true
          }
        : undefined,
    descriptionCompute:
      input.feature === "description"
        ? {
            deterministic: true,
            llm: true
          }
        : undefined,
    transcriptCompute:
      input.feature === "transcript"
        ? {
            deterministic: true,
            llm: true
          }
        : undefined
  });

  return {
    warnings: result.warnings,
    artifactPath: result.artifactRelativePath
  };
}

export async function rerunVideoFeature(
  request: RerunVideoFeatureRequest,
  options: RerunVideoFeatureOptions = {}
): Promise<RerunVideoFeatureResult> {
  const ownerId = randomUUID();
  const mode = request.mode ?? "full";
  const context = await readChannelContext(request.projectId);
  const operation = `rerun_video_feature:${request.feature}:${request.videoId}:${mode}`;

  if (!options.bypassProjectLock) {
    projectOperationLockService.acquireOrThrow({
      projectId: request.projectId,
      operation,
      ownerId
    });
  }

  try {
    const video = await readRawVideo(context.projectRoot, request.videoId);
    const prepared = await prepareVideoFeatureInputs({
      context,
      video,
      feature: request.feature,
      mode,
      reuseExistingTranscriptArtifact: options.reusePreparedAssets
    });

    const featureResult =
      mode === "full"
        ? await runFeatureComputation({
            projectRoot: context.projectRoot,
            exportsRoot: context.exportsRoot,
            videoId: request.videoId,
            feature: request.feature,
            title: video.title,
            description: video.description,
            durationSec: video.durationSec,
            publishedAt: video.publishedAt,
            languageHint: prepared.languageHint,
            transcriptText: prepared.transcriptText,
            transcriptSegments: prepared.transcriptSegments,
            transcriptArtifactPath: path.resolve(context.projectRoot, prepared.transcriptPath),
            thumbnailRelativePath: prepared.thumbnailPath
          })
        : {
            warnings: [] as string[],
            artifactPath: (await fileExists(path.resolve(context.projectRoot, resolveDerivedArtifactRelativePath(request.videoId))))
              ? resolveDerivedArtifactRelativePath(request.videoId)
              : null
          };

    const thumbnailAbsolutePath = path.resolve(context.projectRoot, prepared.thumbnailPath);
    const finalHashes = await computeHashes({
      title: video.title,
      description: video.description,
      transcriptText: prepared.transcriptText,
      transcriptSource: prepared.transcriptSource,
      thumbnailFilePath: (await fileExists(thumbnailAbsolutePath)) ? thumbnailAbsolutePath : undefined
    });

    const cacheIndex = await loadCacheIndex({
      exportsRoot: context.exportsRoot,
      channelFolderPath: context.projectRoot,
      channelId: context.channelId,
      exportVersion: context.exportVersion
    });

    const defaultDerivedArtifactPath = resolveDerivedArtifactRelativePath(request.videoId);
    const artifactAbsolutePath = path.resolve(context.projectRoot, featureResult.artifactPath ?? defaultDerivedArtifactPath);
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
          rawTranscriptPath: prepared.transcriptPath,
          thumbnailPath: prepared.thumbnailPath,
          ...(derivedExists
            ? {
                derivedVideoFeaturesPath: resolveCacheArtifactRelativePath({
                  channelFolderPath: context.projectRoot,
                  artifactAbsolutePath
                })
              }
            : {})
        },
        status: {
          rawTranscript: prepared.transcriptStatus,
          thumbnail: thumbnailExists ? "ok" : "failed",
          derived: derivedExists ? ([...prepared.warnings, ...featureResult.warnings].length > 0 ? "partial" : "ok") : "error",
          warnings: [...prepared.warnings, ...featureResult.warnings]
        }
      })
    });

    await saveCacheIndex({
      exportsRoot: context.exportsRoot,
      channelFolderPath: context.projectRoot,
      index: cacheIndex
    });

    if (request.feature === "thumbnail") {
      await syncManifestThumbnailCounts(context.projectRoot);
    }

    return {
      ok: true,
      projectId: request.projectId,
      videoId: request.videoId,
      feature: request.feature,
      mode,
      warnings: Array.from(new Set([...prepared.warnings, ...featureResult.warnings])),
      artifactPath: featureResult.artifactPath,
      stepsExecuted: prepared.stepsExecuted,
      preparedAssets: prepared.preparedAssets
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
