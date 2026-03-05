import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { resolveOcrPythonPath, runOcrImportHealthCheck } from "./ocrRuntime.js";

const LOCAL_OCR_TIMEOUT_SEC = 120;

export interface LocalOcrBox {
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
  text: string;
}

export interface LocalOcrRequest {
  imagePath: string;
  langs: string[];
  downscaleWidth: number;
  onWorkerRequestId?: (workerRequestId: string) => void;
}

export interface LocalOcrSuccessResult {
  status: "ok";
  engine: string;
  imageWidth: number;
  imageHeight: number;
  boxes: LocalOcrBox[];
  timingMs?: {
    load?: number;
    ocr?: number;
  };
}

export interface LocalOcrErrorResult {
  status: "error";
  warning: string;
}

export type LocalOcrResult = LocalOcrSuccessResult | LocalOcrErrorResult;

interface WorkerTask extends LocalOcrRequest {
  id: string;
  resolve: (result: LocalOcrResult) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface WorkerResponse {
  id?: string;
  ok?: boolean;
  engine?: unknown;
  imageWidth?: unknown;
  imageHeight?: unknown;
  boxes?: unknown;
  timingMs?: unknown;
  error?: unknown;
}

class WorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCrashedError";
  }
}

const resolvedOcrPythonPath = resolveOcrPythonPath();
let runtimeLocalOcrEnabled = true;
let runtimeLocalOcrDisabledReason: string | undefined;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function toFinitePositiveInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function getLocalOcrDisabledWarning(imagePath: string): string {
  if (runtimeLocalOcrDisabledReason) {
    return `Local OCR disabled for image ${imagePath}: ${runtimeLocalOcrDisabledReason}`;
  }
  return `Local OCR disabled for image ${imagePath}`;
}

function disableRuntimeLocalOcr(reason: string): void {
  if (runtimeLocalOcrEnabled) {
    // eslint-disable-next-line no-console
    console.warn(`[local-ocr] ${reason}`);
  }
  runtimeLocalOcrEnabled = false;
  runtimeLocalOcrDisabledReason = reason;
}

function normalizeLocalOcrWarning(imagePath: string, error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Local OCR failed for image ${imagePath}: ${error.message}`;
  }
  return `Local OCR failed for image ${imagePath}: unknown error`;
}

function normalizeWorkerBoxes(raw: unknown): LocalOcrBox[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const source = item as Record<string, unknown>;
      const text = typeof source.text === "string" ? source.text.replace(/\s+/g, " ").trim() : "";
      if (!text) {
        return null;
      }

      const x = toFinitePositiveInt(source.x);
      const y = toFinitePositiveInt(source.y);
      const w = toFinitePositiveInt(source.w);
      const h = toFinitePositiveInt(source.h);
      if (w <= 0 || h <= 0) {
        return null;
      }

      const confidence = typeof source.conf === "number" ? source.conf : 0;

      return {
        x,
        y,
        w,
        h,
        conf: clamp01(confidence),
        text
      } satisfies LocalOcrBox;
    })
    .filter((box): box is LocalOcrBox => box !== null);
}

class LocalOcrWorkerClient {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private readonly queue: WorkerTask[] = [];
  private readonly inFlight = new Map<string, WorkerTask>();
  private readonly maxConcurrency = Math.max(1, env.exportOcrConcurrency);
  private readonly scriptPath = this.resolveWorkerScriptPath();
  private booting: Promise<void> | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private healthCheckPassed = false;

  private resolveWorkerScriptPath(): string {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(process.cwd(), "scripts", "ocr_worker.py"),
      path.resolve(process.cwd(), "apps", "api", "scripts", "ocr_worker.py"),
      path.resolve(moduleDir, "..", "..", "scripts", "ocr_worker.py"),
      path.resolve(moduleDir, "..", "..", "..", "scripts", "ocr_worker.py")
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  async runTaskWithRetry(request: LocalOcrRequest): Promise<LocalOcrResult> {
    if (!runtimeLocalOcrEnabled) {
      return {
        status: "error",
        warning: getLocalOcrDisabledWarning(request.imagePath)
      };
    }

    try {
      return await this.enqueue(request);
    } catch (error) {
      if (!(error instanceof WorkerCrashedError)) {
        return {
          status: "error",
          warning: normalizeLocalOcrWarning(request.imagePath, error)
        };
      }

      try {
        await this.restart();
      } catch (restartError) {
        return {
          status: "error",
          warning: runtimeLocalOcrEnabled
            ? normalizeLocalOcrWarning(request.imagePath, restartError)
            : getLocalOcrDisabledWarning(request.imagePath)
        };
      }

      try {
        return await this.enqueue(request);
      } catch (retryError) {
        return {
          status: "error",
          warning: normalizeLocalOcrWarning(request.imagePath, retryError)
        };
      }
    }
  }

  private async enqueue(request: LocalOcrRequest): Promise<LocalOcrResult> {
    return new Promise<LocalOcrResult>((resolve, reject) => {
      const id = randomUUID();
      request.onWorkerRequestId?.(id);
      const timeoutMs = LOCAL_OCR_TIMEOUT_SEC * 1_000;
      const timeout = setTimeout(() => {
        this.rejectTask(id, new Error(`Local OCR timeout after ${LOCAL_OCR_TIMEOUT_SEC}s`));
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
    if (this.inFlight.size >= this.maxConcurrency || this.queue.length === 0) {
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
          status: "error",
          warning: runtimeLocalOcrEnabled
            ? normalizeLocalOcrWarning(task.imagePath, error)
            : getLocalOcrDisabledWarning(task.imagePath)
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
        imagePath: task.imagePath,
        langs: task.langs,
        downscaleWidth: task.downscaleWidth
      };
      this.worker.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  }

  private async ensureRuntimeHealthCheck(): Promise<void> {
    if (!runtimeLocalOcrEnabled) {
      throw new Error(runtimeLocalOcrDisabledReason ?? "local OCR disabled");
    }

    if (this.healthCheckPassed) {
      return;
    }

    if (this.healthCheckPromise) {
      return this.healthCheckPromise;
    }

    this.healthCheckPromise = (async () => {
      const health = await runOcrImportHealthCheck({
        pythonPath: resolvedOcrPythonPath,
        cwd: process.cwd()
      });

      if (!health.ok) {
        const reason = `Local OCR disabled: unable to import OCR dependencies with ${resolvedOcrPythonPath}. ${
          health.error ?? "unknown error"
        }`;
        disableRuntimeLocalOcr(reason);
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
      const child = spawn(resolvedOcrPythonPath, [this.scriptPath], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
          PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8"
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
          console.error(`[local-ocr] ${message}`);
        }
      });

      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.worker = null;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const reason = `Local OCR worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
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

    if (payload.ok) {
      const engine = typeof payload.engine === "string" && payload.engine.trim() ? payload.engine.trim() : "unknown";
      const imageWidth = toFinitePositiveInt(payload.imageWidth);
      const imageHeight = toFinitePositiveInt(payload.imageHeight);
      const boxes = normalizeWorkerBoxes(payload.boxes);
      const timing = payload.timingMs && typeof payload.timingMs === "object" ? (payload.timingMs as Record<string, unknown>) : null;

      this.resolveTask(payload.id, {
        status: "ok",
        engine,
        imageWidth,
        imageHeight,
        boxes,
        timingMs: {
          load: timing ? toFinitePositiveInt(timing.load) : undefined,
          ocr: timing ? toFinitePositiveInt(timing.ocr) : undefined
        }
      });
      return;
    }

    const message = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "unknown local OCR error";
    this.resolveTask(payload.id, {
      status: "error",
      warning: normalizeLocalOcrWarning(task.imagePath, new Error(message))
    });
  }

  private resolveTask(taskId: string, result: LocalOcrResult): void {
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

const localOcrWorkerClient = new LocalOcrWorkerClient();

export async function recognizeWithLocalOcr(request: LocalOcrRequest): Promise<LocalOcrResult> {
  return localOcrWorkerClient.runTaskWithRetry(request);
}
