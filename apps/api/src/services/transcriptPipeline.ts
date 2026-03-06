import { isLocalAsrEnabled, LocalAsrStage, transcribeWithLocalAsr } from "./localAsrService.js";
import type { LocalAsrResult } from "./localAsrService.js";
import type { TranscriptResult } from "./transcriptService.js";
import type { TranscriptAsrMeta, TranscriptSegment } from "./transcriptModels.js";

export interface TranscriptPipelineOptions {
  outputMp3Path?: string;
  language?: string;
  onLocalAsrStage?: (stage: LocalAsrStage) => void;
  onLocalAsrWorkerRequestId?: (workerRequestId: string) => void;
}

export interface TranscriptPipelineDependencies {
  // Legacy hook kept for compatibility with tests and older callers. The pipeline is ASR-only now.
  captionsProvider: (videoId: string) => Promise<TranscriptResult>;
  localAsrProvider: (params: {
    videoId: string;
    outputMp3Path: string;
    language?: string;
    onStage?: (stage: LocalAsrStage) => void;
    onWorkerRequestId?: (workerRequestId: string) => void;
  }) => Promise<LocalAsrResult>;
  localAsrEnabled: boolean | (() => boolean);
}

export interface TranscriptPipelineResult {
  transcript: string;
  status: "ok" | "missing" | "error";
  source: "captions" | "asr" | "none";
  warning?: string;
  language?: string;
  asrMeta?: TranscriptAsrMeta;
  segments?: TranscriptSegment[];
}

const defaultDependencies: TranscriptPipelineDependencies = {
  captionsProvider: async () => ({
    transcript: "",
    status: "missing"
  }),
  localAsrProvider: async ({ videoId, outputMp3Path, language, onStage, onWorkerRequestId }) =>
    transcribeWithLocalAsr({
      videoId,
      outputMp3Path,
      language,
      onStage,
      onWorkerRequestId
    }),
  localAsrEnabled: isLocalAsrEnabled
};

function mergeWarnings(parts: Array<string | undefined>): string | undefined {
  const sanitized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  if (!sanitized.length) {
    return undefined;
  }
  return sanitized.join(" | ");
}

export async function getTranscriptWithFallback(
  videoId: string,
  options: TranscriptPipelineOptions = {},
  dependencies: TranscriptPipelineDependencies = defaultDependencies
): Promise<TranscriptPipelineResult> {
  const localAsrEnabled =
    typeof dependencies.localAsrEnabled === "function" ? dependencies.localAsrEnabled() : dependencies.localAsrEnabled;

  if (!localAsrEnabled) {
    return {
      transcript: "",
      status: "error",
      source: "none",
      warning: mergeWarnings([`Local ASR disabled for video ${videoId}`])
    };
  }

  if (!options.outputMp3Path) {
    return {
      transcript: "",
      status: "error",
      source: "none",
      warning: mergeWarnings([`Local ASR output path missing for video ${videoId}`])
    };
  }

  const localAsr = await dependencies.localAsrProvider({
    videoId,
    outputMp3Path: options.outputMp3Path,
    language: options.language,
    onStage: options.onLocalAsrStage,
    onWorkerRequestId: options.onLocalAsrWorkerRequestId
  });

  if (localAsr.status === "ok" && localAsr.transcript.trim()) {
    const result: TranscriptPipelineResult = {
      transcript: localAsr.transcript.trim(),
      status: "ok",
      source: "asr"
    };

    if (localAsr.language) {
      result.language = localAsr.language;
    }
    if (localAsr.model || localAsr.computeType) {
      result.asrMeta = {
        ...(localAsr.model ? { model: localAsr.model } : {}),
        ...(localAsr.computeType ? { computeType: localAsr.computeType } : {})
      };
    }
    if (localAsr.segments?.length) {
      result.segments = localAsr.segments;
    }
    return result;
  }

  return {
    transcript: "",
    status: "error",
    source: "none",
    warning: mergeWarnings([localAsr.warning ?? `Local ASR returned empty transcript for video ${videoId}`])
  };
}
