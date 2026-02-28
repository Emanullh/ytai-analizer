import { isLocalAsrEnabled, LocalAsrStage, transcribeWithLocalAsr } from "./localAsrService.js";
import { TranscriptResult, getTranscript } from "./transcriptService.js";

export interface TranscriptPipelineOptions {
  outputMp3Path?: string;
  language?: string;
  onLocalAsrStage?: (stage: LocalAsrStage) => void;
}

export interface TranscriptPipelineDependencies {
  captionsProvider: (videoId: string) => Promise<TranscriptResult>;
  localAsrProvider: (params: {
    videoId: string;
    outputMp3Path: string;
    language?: string;
    onStage?: (stage: LocalAsrStage) => void;
  }) => Promise<{ transcript: string; status: "ok" | "error"; warning?: string }>;
  localAsrEnabled: boolean | (() => boolean);
}

export interface TranscriptPipelineResult {
  transcript: string;
  status: "ok" | "missing" | "error";
  warning?: string;
}

const defaultDependencies: TranscriptPipelineDependencies = {
  captionsProvider: async (videoId: string) =>
    getTranscript(videoId, {
      timeoutMs: 12_000,
      maxRetries: 1
    }),
  localAsrProvider: async ({ videoId, outputMp3Path, language, onStage }) =>
    transcribeWithLocalAsr({
      videoId,
      outputMp3Path,
      language,
      onStage
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
    return {
      transcript: captions.transcript.trim(),
      status: "ok",
      warning: captions.warning
    };
  }

  if (!localAsrEnabled) {
    return {
      transcript: "",
      status: captions.status === "missing" ? "missing" : "error",
      warning: mergeWarnings([captions.warning, `Local ASR disabled for video ${videoId}`])
    };
  }

  if (!options.outputMp3Path) {
    return {
      transcript: "",
      status: "error",
      warning: mergeWarnings([captions.warning, `Local ASR output path missing for video ${videoId}`])
    };
  }

  const localAsr = await dependencies.localAsrProvider({
    videoId,
    outputMp3Path: options.outputMp3Path,
    language: options.language,
    onStage: options.onLocalAsrStage
  });

  if (localAsr.status === "ok" && localAsr.transcript.trim()) {
    return {
      transcript: localAsr.transcript.trim(),
      status: "ok"
    };
  }

  return {
    transcript: "",
    status: "error",
    warning: mergeWarnings([
      captions.warning,
      localAsr.warning ?? `Local ASR returned empty transcript for video ${videoId}`
    ])
  };
}
