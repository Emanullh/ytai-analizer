import { persistDescriptionFeaturesArtifact } from "../derived/descriptionFeaturesAgent.js";
import type { PersistDescriptionFeaturesArgs } from "../derived/descriptionFeaturesAgent.js";
import { persistThumbnailFeaturesArtifact } from "../derived/thumbnailFeaturesAgent.js";
import type { PersistThumbnailFeaturesArgs } from "../derived/thumbnailFeaturesAgent.js";
import { persistTitleFeaturesArtifact } from "../derived/titleFeaturesAgent.js";
import type { PersistTitleFeaturesArgs } from "../derived/titleFeaturesAgent.js";
import { persistTranscriptFeaturesArtifact } from "../derived/transcriptFeaturesAgent.js";
import type { PersistTranscriptFeaturesArgs } from "../derived/transcriptFeaturesAgent.js";
import type { VideoFeatureKind } from "./videoFeaturePreparationService.js";

export interface ComputeVideoFeatureInput {
  feature: VideoFeatureKind;
  exportsRoot: string;
  channelFolderPath: string;
  videoId: string;
  title: string;
  description?: string;
  transcriptText?: string;
  transcriptSegments?: PersistTitleFeaturesArgs["transcriptSegments"];
  transcriptArtifactPath?: string;
  durationSec?: number;
  publishedAt?: string;
  nowISO?: string;
  languageHint?: "auto" | "en" | "es";
  thumbnailAbsPath?: string;
  thumbnailLocalPath?: string;
  thumbnailCompute?: PersistThumbnailFeaturesArgs["compute"];
  titleCompute?: PersistTitleFeaturesArgs["compute"];
  descriptionCompute?: PersistDescriptionFeaturesArgs["compute"];
  transcriptCompute?: PersistTranscriptFeaturesArgs["compute"];
  trace?: {
    thumbnail?: PersistThumbnailFeaturesArgs["trace"];
    description?: PersistDescriptionFeaturesArgs["trace"];
    transcript?: PersistTranscriptFeaturesArgs["trace"];
  };
}

export interface ComputeVideoFeatureResult {
  warnings: string[];
  artifactAbsolutePath: string;
  artifactRelativePath: string;
}

export async function computeVideoFeatureArtifact(
  input: ComputeVideoFeatureInput
): Promise<ComputeVideoFeatureResult> {
  if (input.feature === "thumbnail") {
    if (!input.thumbnailAbsPath || !input.thumbnailLocalPath) {
      throw new Error(`Missing thumbnail asset input for ${input.videoId}`);
    }

    const result = await persistThumbnailFeaturesArtifact({
      exportsRoot: input.exportsRoot,
      channelFolderPath: input.channelFolderPath,
      videoId: input.videoId,
      title: input.title,
      thumbnailAbsPath: input.thumbnailAbsPath,
      thumbnailLocalPath: input.thumbnailLocalPath,
      compute: input.thumbnailCompute,
      trace: input.trace?.thumbnail
    });

    return {
      warnings: result.warnings,
      artifactAbsolutePath: result.artifactAbsolutePath,
      artifactRelativePath: result.artifactRelativePath
    };
  }

  if (input.feature === "title") {
    const result = await persistTitleFeaturesArtifact({
      exportsRoot: input.exportsRoot,
      channelFolderPath: input.channelFolderPath,
      videoId: input.videoId,
      title: input.title,
      transcript: input.transcriptText,
      transcriptSegments: input.transcriptSegments,
      languageHint: input.languageHint,
      compute: input.titleCompute
    });

    return {
      warnings: result.warnings,
      artifactAbsolutePath: result.artifactAbsolutePath,
      artifactRelativePath: result.artifactRelativePath
    };
  }

  if (input.feature === "description") {
    const result = await persistDescriptionFeaturesArtifact({
      exportsRoot: input.exportsRoot,
      channelFolderPath: input.channelFolderPath,
      videoId: input.videoId,
      title: input.title,
      description: input.description ?? "",
      languageHint: input.languageHint,
      compute: input.descriptionCompute,
      trace: input.trace?.description
    });

    return {
      warnings: result.warnings,
      artifactAbsolutePath: result.artifactAbsolutePath,
      artifactRelativePath: result.artifactRelativePath
    };
  }

  if (!input.transcriptArtifactPath) {
    throw new Error(`Missing transcript artifact path for ${input.videoId}`);
  }

  const result = await persistTranscriptFeaturesArtifact({
    exportsRoot: input.exportsRoot,
    channelFolderPath: input.channelFolderPath,
    videoId: input.videoId,
    title: input.title,
    transcript: input.transcriptText,
    transcriptArtifactPath: input.transcriptArtifactPath,
    durationSec: input.durationSec,
    publishedAt: input.publishedAt,
    nowISO: input.nowISO,
    languageHint: input.languageHint,
    compute: input.transcriptCompute,
    trace: input.trace?.transcript
  });

  return {
    warnings: result.warnings,
    artifactAbsolutePath: result.artifactAbsolutePath,
    artifactRelativePath: result.artifactRelativePath
  };
}
