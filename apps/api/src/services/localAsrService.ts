import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { resolveAsrPythonPath, runAsrImportHealthCheck } from "./asrRuntime.js";

export type LocalAsrStage = "downloading_audio" | "transcribing";
export type LocalAsrStatus = "ok" | "error";

export interface LocalAsrRequest {
  videoId: string;
  outputMp3Path: string;
  language?: string;
  onStage?: (stage: LocalAsrStage) => void;
}

export interface LocalAsrResult {
  transcript: string;
  status: LocalAsrStatus;
  warning?: string;
}

interface WorkerTask extends LocalAsrRequest {
  id: string;
  resolve: (result: LocalAsrResult) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface WorkerResponse {
  id?: string;
  event?: string;
  ok?: boolean;
  transcript?: string;
  error?: string;
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
    if (!runtimeLocalAsrEnabled) {
      return {
        transcript: "",
        status: "error",
        warning: getLocalAsrDisabledWarning(request.videoId)
      };
    }

    try {
      return await this.enqueue(request);
    } catch (error) {
      if (!(error instanceof WorkerCrashedError)) {
        return {
          transcript: "",
          status: "error",
          warning: normalizeLocalAsrWarning(request.videoId, error)
        };
      }

      try {
        await this.restart();
      } catch (restartError) {
        return {
          transcript: "",
          status: "error",
          warning: runtimeLocalAsrEnabled
            ? normalizeLocalAsrWarning(request.videoId, restartError)
            : getLocalAsrDisabledWarning(request.videoId)
        };
      }

      try {
        return await this.enqueue(request);
      } catch (retryError) {
        return {
          transcript: "",
          status: "error",
          warning: normalizeLocalAsrWarning(request.videoId, retryError)
        };
      }
    }
  }

  private async enqueue(request: LocalAsrRequest): Promise<LocalAsrResult> {
    return new Promise<LocalAsrResult>((resolve, reject) => {
      const id = randomUUID();
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
        task.resolve({
          transcript: "",
          status: "error",
          warning: runtimeLocalAsrEnabled
            ? normalizeLocalAsrWarning(task.videoId, error)
            : getLocalAsrDisabledWarning(task.videoId)
        });
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
      this.resolveTask(payload.id, {
        transcript: payload.transcript?.trim() ?? "",
        status: "ok"
      });
      return;
    }

    const message = payload.error ?? "unknown local ASR error";
    this.resolveTask(payload.id, {
      transcript: "",
      status: "error",
      warning: normalizeLocalAsrWarning(task.videoId, new Error(message))
    });
  }

  private resolveTask(taskId: string, result: LocalAsrResult): void {
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
