import { isLocalAsrEnabled, LocalAsrStage, transcribeWithLocalAsr } from "./localAsrService.js";
import type { LocalAsrResult } from "./localAsrService.js";
import { getTranscript } from "./transcriptService.js";
import type { TranscriptResult } from "./transcriptService.js";
import type { TranscriptAsrMeta, TranscriptSegment } from "./transcriptModels.js";

export interface TranscriptPipelineOptions {
  outputMp3Path?: string;
  language?: string;
  onLocalAsrStage?: (stage: LocalAsrStage) => void;
  onLocalAsrWorkerRequestId?: (workerRequestId: string) => void;
}

export interface TranscriptPipelineDependencies {
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
  captionsProvider: async (videoId: string) =>
    getTranscript(videoId, {
      timeoutMs: 12_000,
      maxRetries: 1
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
  const captions = await dependencies.captionsProvider(videoId);
  if (captions.status === "ok" && captions.transcript.trim()) {
    const result: TranscriptPipelineResult = {
      transcript: captions.transcript.trim(),
      status: "ok",
      source: "captions",
      warning: captions.warning
    };

    if (captions.language) {
      result.language = captions.language;
    }
    if (captions.segments?.length) {
      result.segments = captions.segments;
    }
    return result;
  }

  if (!localAsrEnabled) {
    return {
      transcript: "",
      status: captions.status === "missing" ? "missing" : "error",
      source: "none",
      warning: mergeWarnings([captions.warning, `Local ASR disabled for video ${videoId}`])
    };
  }

  if (!options.outputMp3Path) {
    return {
      transcript: "",
      status: "error",
      source: "none",
      warning: mergeWarnings([captions.warning, `Local ASR output path missing for video ${videoId}`])
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
    warning: mergeWarnings([
      captions.warning,
      localAsr.warning ?? `Local ASR returned empty transcript for video ${videoId}`
    ])
  };
}
