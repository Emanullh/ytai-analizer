import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { resolveAsrPythonPath, runAsrImportHealthCheck } from "./asrRuntime.js";
import type { TranscriptSegment } from "./transcriptModels.js";

export type LocalAsrStage = "downloading_audio" | "transcribing";
export type LocalAsrStatus = "ok" | "error";
type LocalAsrWorkerMode = "download_and_transcribe" | "download_only";

export interface LocalAsrRequest {
  videoId: string;
  outputMp3Path: string;
  language?: string;
  onStage?: (stage: LocalAsrStage) => void;
  onWorkerRequestId?: (workerRequestId: string) => void;
}

export interface LocalAsrDownloadRequest {
  videoId: string;
  outputMp3Path: string;
  onStage?: (stage: LocalAsrStage) => void;
  onWorkerRequestId?: (workerRequestId: string) => void;
}

export interface LocalAsrResult {
  transcript: string;
  status: LocalAsrStatus;
  warning?: string;
  language?: string;
  model?: string;
  computeType?: string;
  segments?: TranscriptSegment[];
}

export interface LocalAsrDownloadResult {
  status: LocalAsrStatus;
  warning?: string;
  outputMp3Path?: string;
}

interface WorkerTask {
  id: string;
  mode: LocalAsrWorkerMode;
  videoId: string;
  outputMp3Path: string;
  language?: string;
  onStage?: (stage: LocalAsrStage) => void;
  onWorkerRequestId?: (workerRequestId: string) => void;
  resolve: (result: LocalAsrResult | LocalAsrDownloadResult) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface WorkerResponse {
  id?: string;
  event?: string;
  ok?: boolean;
  transcript?: string;
  error?: string;
  language?: string;
  model?: string;
  computeType?: string;
  downloadedPath?: string;
  segments?: Array<{
    startSec?: unknown;
    endSec?: unknown;
    text?: unknown;
    confidence?: unknown;
  }>;
}

class WorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCrashedError";
  }
}

const resolvedAsrPythonPath = resolveAsrPythonPath();
let runtimeLocalAsrEnabled = env.localAsrEnabled;
let runtimeLocalAsrDisabledReason: string | undefined;

if (!runtimeLocalAsrEnabled) {
  runtimeLocalAsrDisabledReason = "disabled by LOCAL_ASR_ENABLED=false";
}

function getLocalAsrDisabledWarning(videoId: string): string {
  if (runtimeLocalAsrDisabledReason) {
    return `Local ASR disabled for video ${videoId}: ${runtimeLocalAsrDisabledReason}`;
  }
  return `Local ASR disabled for video ${videoId}`;
}

function disableRuntimeLocalAsr(reason: string): void {
  if (runtimeLocalAsrEnabled) {
    // eslint-disable-next-line no-console
    console.warn(`[local-asr] ${reason}`);
  }
  runtimeLocalAsrEnabled = false;
  process.env.LOCAL_ASR_ENABLED = "false";
  runtimeLocalAsrDisabledReason = reason;
}

function normalizeLocalAsrWarning(videoId: string, error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Local ASR fallback failed for video ${videoId}: ${error.message}`;
  }
  return `Local ASR fallback failed for video ${videoId}: unknown error`;
}

export function isLocalAsrEnabled(): boolean {
  return runtimeLocalAsrEnabled;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeWorkerSegments(segments: WorkerResponse["segments"]): TranscriptSegment[] | undefined {
  if (!Array.isArray(segments)) {
    return undefined;
  }

  const normalized = segments
    .map((segment) => {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
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

  return normalized.length ? normalized : undefined;
}

class LocalAsrWorkerClient {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private readonly queue: WorkerTask[] = [];
  private readonly inFlight = new Map<string, WorkerTask>();
  private readonly maxConcurrency = Math.max(1, env.localAsrMaxConcurrency);
  private readonly scriptPath = this.resolveWorkerScriptPath();
  private booting: Promise<void> | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private healthCheckPassed = false;

  private resolveWorkerScriptPath(): string {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(process.cwd(), "scripts", "asr_worker.py"),
      path.resolve(process.cwd(), "apps", "api", "scripts", "asr_worker.py"),
      path.resolve(moduleDir, "..", "..", "scripts", "asr_worker.py"),
      path.resolve(moduleDir, "..", "..", "..", "scripts", "asr_worker.py")
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  async runTaskWithRetry(request: LocalAsrRequest): Promise<LocalAsrResult> {
    return this.executeWithRetry(
      {
        ...request,
        mode: "download_and_transcribe"
      },
      (warning) => ({
        transcript: "",
        status: "error",
        warning
      })
    );
  }

  async runDownloadTaskWithRetry(request: LocalAsrDownloadRequest): Promise<LocalAsrDownloadResult> {
    return this.executeWithRetry(
      {
        ...request,
        mode: "download_only"
      },
      (warning) => ({
        status: "error",
        warning
      })
    );
  }

  private async executeWithRetry<T extends LocalAsrResult | LocalAsrDownloadResult>(
    request: Omit<WorkerTask, "id" | "resolve" | "reject" | "timeout">,
    buildErrorResult: (warning: string) => T
  ): Promise<T> {
    if (!runtimeLocalAsrEnabled) {
      return buildErrorResult(getLocalAsrDisabledWarning(request.videoId));
    }

    try {
      return (await this.enqueue(request)) as T;
    } catch (error) {
      if (!(error instanceof WorkerCrashedError)) {
        return buildErrorResult(normalizeLocalAsrWarning(request.videoId, error));
      }

      try {
        await this.restart();
      } catch (restartError) {
        return buildErrorResult(
          runtimeLocalAsrEnabled
            ? normalizeLocalAsrWarning(request.videoId, restartError)
            : getLocalAsrDisabledWarning(request.videoId)
        );
      }

      try {
        return (await this.enqueue(request)) as T;
      } catch (retryError) {
        return buildErrorResult(normalizeLocalAsrWarning(request.videoId, retryError));
      }
    }
  }

  private async enqueue(
    request: Omit<WorkerTask, "id" | "resolve" | "reject" | "timeout">
  ): Promise<LocalAsrResult | LocalAsrDownloadResult> {
    return new Promise<LocalAsrResult | LocalAsrDownloadResult>((resolve, reject) => {
      const id = randomUUID();
      request.onWorkerRequestId?.(id);
      const timeoutMs = env.localAsrTimeoutSec * 1_000;
      const timeout = setTimeout(() => {
        this.rejectTask(id, new Error(`Local ASR timeout after ${env.localAsrTimeoutSec}s`));
        this.terminateWorker();
      }, timeoutMs);

      this.queue.push({
        ...request,
        id,
        resolve,
        reject,
        timeout
      });
      void this.pumpQueue();
    });
  }

  private async pumpQueue(): Promise<void> {
    if (this.inFlight.size >= this.maxConcurrency) {
      return;
    }

    if (!this.queue.length) {
      return;
    }

    try {
      await this.ensureWorker();
    } catch (error) {
      while (this.queue.length) {
        const task = this.queue.shift();
        if (!task) {
          continue;
        }

        clearTimeout(task.timeout);
        task.resolve(
          task.mode === "download_only"
            ? {
                status: "error",
                warning: runtimeLocalAsrEnabled
                  ? normalizeLocalAsrWarning(task.videoId, error)
                  : getLocalAsrDisabledWarning(task.videoId)
              }
            : {
                transcript: "",
                status: "error",
                warning: runtimeLocalAsrEnabled
                  ? normalizeLocalAsrWarning(task.videoId, error)
                  : getLocalAsrDisabledWarning(task.videoId)
              }
        );
      }
      return;
    }

    while (this.inFlight.size < this.maxConcurrency && this.queue.length) {
      const task = this.queue.shift();
      if (!task || !this.worker) {
        break;
      }

      this.inFlight.set(task.id, task);
      const payload = {
        id: task.id,
        mode: task.mode,
        videoId: task.videoId,
        outputMp3Path: task.outputMp3Path,
        language: task.language ?? env.localAsrLanguage
      };
      this.worker.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  }

  private async ensureRuntimeHealthCheck(): Promise<void> {
    if (!runtimeLocalAsrEnabled) {
      throw new Error(runtimeLocalAsrDisabledReason ?? "local ASR disabled");
    }

    if (this.healthCheckPassed) {
      return;
    }

    if (this.healthCheckPromise) {
      return this.healthCheckPromise;
    }

    this.healthCheckPromise = (async () => {
      const health = await runAsrImportHealthCheck({
        pythonPath: resolvedAsrPythonPath,
        cwd: process.cwd()
      });

      if (!health.ok) {
        const reason = `Local ASR disabled: unable to import faster_whisper with ${resolvedAsrPythonPath}. ${
          health.error ?? "unknown error"
        }`;
        disableRuntimeLocalAsr(reason);
        throw new Error(reason);
      }

      this.healthCheckPassed = true;
    })().finally(() => {
      this.healthCheckPromise = null;
    });

    return this.healthCheckPromise;
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker) {
      return;
    }

    await this.ensureRuntimeHealthCheck();

    if (this.booting) {
      return this.booting;
    }

    this.booting = new Promise<void>((resolve, reject) => {
      const child = spawn(resolvedAsrPythonPath, [this.scriptPath], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
          PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
          LOCAL_ASR_MODEL: env.localAsrModel,
          LOCAL_ASR_COMPUTE_TYPE: env.localAsrComputeType,
          LOCAL_ASR_LANGUAGE: env.localAsrLanguage,
          LOCAL_ASR_BEAM_SIZE: String(env.localAsrBeamSize),
          YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC: String(env.youtubeAudioDownloadTimeoutSec)
        }
      });

      this.worker = child;

      const stdoutReader = createInterface({ input: child.stdout });
      stdoutReader.on("line", (line) => {
        this.handleWorkerLine(line);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString("utf-8").trim();
        if (message) {
          // eslint-disable-next-line no-console
          console.error(`[local-asr] ${message}`);
        }
      });

      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.worker = null;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const reason = `Local ASR worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.worker = null;
        this.rejectAllInFlight(new WorkerCrashedError(reason));
      });
    }).finally(() => {
      this.booting = null;
    });

    return this.booting;
  }

  private handleWorkerLine(line: string): void {
    let payload: WorkerResponse;
    try {
      payload = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }

    if (!payload.id) {
      return;
    }

    const task = this.inFlight.get(payload.id);
    if (!task) {
      return;
    }

    if (payload.event === "downloading_audio" || payload.event === "transcribing") {
      task.onStage?.(payload.event);
      return;
    }

    if (payload.ok) {
      if (task.mode === "download_only") {
        this.resolveTask(payload.id, {
          status: "ok",
          outputMp3Path:
            typeof payload.downloadedPath === "string" && payload.downloadedPath.trim()
              ? payload.downloadedPath.trim()
              : task.outputMp3Path
        });
        return;
      }

      const language = typeof payload.language === "string" && payload.language.trim() ? payload.language.trim() : undefined;
      const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : undefined;
      const computeType =
        typeof payload.computeType === "string" && payload.computeType.trim() ? payload.computeType.trim() : undefined;
      const segments = normalizeWorkerSegments(payload.segments);

      this.resolveTask(payload.id, {
        transcript: payload.transcript?.trim() ?? "",
        status: "ok",
        ...(language ? { language } : {}),
        ...(model ? { model } : {}),
        ...(computeType ? { computeType } : {}),
        ...(segments ? { segments } : {})
      });
      return;
    }

    const message = payload.error ?? "unknown local ASR error";
    this.resolveTask(
      payload.id,
      task.mode === "download_only"
        ? {
            status: "error",
            warning: normalizeLocalAsrWarning(task.videoId, new Error(message))
          }
        : {
            transcript: "",
            status: "error",
            warning: normalizeLocalAsrWarning(task.videoId, new Error(message))
          }
    );
  }

  private resolveTask(taskId: string, result: LocalAsrResult | LocalAsrDownloadResult): void {
    const task = this.inFlight.get(taskId);
    if (!task) {
      return;
    }

    clearTimeout(task.timeout);
    this.inFlight.delete(taskId);
    task.resolve(result);
    void this.pumpQueue();
  }

  private rejectTask(taskId: string, error: unknown): void {
    const task = this.inFlight.get(taskId);
    if (!task) {
      return;
    }

    clearTimeout(task.timeout);
    this.inFlight.delete(taskId);
    task.reject(error);
    void this.pumpQueue();
  }

  private rejectAllInFlight(error: unknown): void {
    for (const task of this.inFlight.values()) {
      clearTimeout(task.timeout);
      task.reject(error);
    }
    this.inFlight.clear();
    void this.pumpQueue();
  }

  private terminateWorker(): void {
    if (!this.worker) {
      return;
    }
    this.worker.kill("SIGKILL");
    this.worker = null;
  }

  private async restart(): Promise<void> {
    this.terminateWorker();
    await this.ensureWorker();
  }
}

const localAsrWorkerClient = new LocalAsrWorkerClient();

export async function transcribeWithLocalAsr(request: LocalAsrRequest): Promise<LocalAsrResult> {
  return localAsrWorkerClient.runTaskWithRetry(request);
}

export async function downloadAudioWithLocalAsr(
  request: LocalAsrDownloadRequest
): Promise<LocalAsrDownloadResult> {
  return localAsrWorkerClient.runDownloadTaskWithRetry(request);
}
