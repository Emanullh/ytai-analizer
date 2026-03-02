import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";

export type AutoGenProvider = "openai" | "gemini";
export type AutoGenReasoningEffort = "low" | "medium" | "high";

interface AutoGenBaseTaskRequest {
  provider?: AutoGenProvider;
  model?: string;
  reasoningEffort?: AutoGenReasoningEffort;
}

interface AutoGenTitleTaskRequest extends AutoGenBaseTaskRequest {
  task: "title_classifier_v1";
  payload: {
    videoId: string;
    title: string;
    languageHint?: "auto" | "en" | "es";
  };
}

interface AutoGenDescriptionTaskRequest extends AutoGenBaseTaskRequest {
  task: "description_classifier_v1";
  payload: {
    videoId: string;
    title: string;
    description: string;
    urlsWithSpans: Array<{
      url: string;
      domain: string;
      charStart: number;
      charEnd: number;
      isShortener: boolean;
    }>;
    languageHint?: "auto" | "en" | "es";
  };
}

interface AutoGenTranscriptTaskRequest extends AutoGenBaseTaskRequest {
  task: "transcript_classifier_v1";
  payload: {
    videoId: string;
    title: string;
    languageHint?: "auto" | "en" | "es";
    segmentsSample: Array<{
      segmentIndex: number;
      startSec: number | null;
      endSec: number | null;
      text: string;
    }>;
    candidateSponsorSegments: Array<{
      segmentIndex: number;
      startSec: number | null;
      endSec: number | null;
      text: string;
    }>;
    candidateCTASegments: Array<{
      segmentIndex: number;
      startSec: number | null;
      endSec: number | null;
      text: string;
    }>;
  };
}

interface AutoGenThumbnailTaskRequest extends AutoGenBaseTaskRequest {
  task: "thumbnail_classifier_v1";
  payload: {
    videoId: string;
    title: string;
    thumbnailAbsPath: string;
    thumbMeta: Record<string, unknown>;
    ocrSummary: Record<string, unknown>;
    statsSummary: Record<string, unknown>;
  };
}

export type AutoGenTaskRequest =
  | AutoGenTitleTaskRequest
  | AutoGenDescriptionTaskRequest
  | AutoGenTranscriptTaskRequest
  | AutoGenThumbnailTaskRequest;

interface AutoGenInFlightTask {
  id: string;
  request: AutoGenTaskRequest;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface AutoGenWorkerResponse {
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
}

class AutoGenWorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutoGenWorkerCrashedError";
  }
}

function resolveAutoGenPythonPath(): string {
  const fromEnv = process.env.AUTOGEN_PYTHON_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const fromAsrEnv = process.env.ASR_PYTHON_PATH?.trim();
  if (fromAsrEnv) {
    return fromAsrEnv;
  }

  return process.platform === "win32" ? "python" : "python3";
}

function resolveAutoGenModel(request: AutoGenTaskRequest): string {
  if (request.model) {
    return request.model;
  }

  if (request.task === "title_classifier_v1") {
    return env.autoGenModelTitle;
  }
  if (request.task === "thumbnail_classifier_v1") {
    return env.autoGenModelThumbnail;
  }
  return env.autoGenModelDescription;
}

function normalizeAutoGenPayload(request: AutoGenTaskRequest): AutoGenTaskRequest["payload"] {
  if (request.task === "transcript_classifier_v1") {
    return {
      videoId: request.payload.videoId,
      title: request.payload.title,
      languageHint: request.payload.languageHint ?? "auto",
      segmentsSample: Array.isArray(request.payload.segmentsSample) ? request.payload.segmentsSample : [],
      candidateSponsorSegments: Array.isArray(request.payload.candidateSponsorSegments)
        ? request.payload.candidateSponsorSegments
        : [],
      candidateCTASegments: Array.isArray(request.payload.candidateCTASegments)
        ? request.payload.candidateCTASegments
        : []
    };
  }

  if (request.task === "description_classifier_v1") {
    return {
      videoId: request.payload.videoId,
      title: request.payload.title,
      description: request.payload.description,
      urlsWithSpans: Array.isArray(request.payload.urlsWithSpans) ? request.payload.urlsWithSpans : [],
      languageHint: request.payload.languageHint ?? "auto"
    };
  }

  if (request.task === "thumbnail_classifier_v1") {
    return {
      videoId: request.payload.videoId,
      title: request.payload.title,
      thumbnailAbsPath: request.payload.thumbnailAbsPath,
      thumbMeta:
        request.payload.thumbMeta && typeof request.payload.thumbMeta === "object" ? request.payload.thumbMeta : {},
      ocrSummary:
        request.payload.ocrSummary && typeof request.payload.ocrSummary === "object" ? request.payload.ocrSummary : {},
      statsSummary:
        request.payload.statsSummary && typeof request.payload.statsSummary === "object"
          ? request.payload.statsSummary
          : {}
    };
  }

  return {
    videoId: request.payload.videoId,
    title: request.payload.title,
    languageHint: request.payload.languageHint ?? "auto"
  };
}

class AutoGenWorkerClient {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private readonly queue: AutoGenInFlightTask[] = [];
  private readonly inFlight = new Map<string, AutoGenInFlightTask>();
  private readonly scriptPath = this.resolveWorkerScriptPath();
  private readonly pythonPath = resolveAutoGenPythonPath();
  private booting: Promise<void> | null = null;

  private resolveWorkerScriptPath(): string {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(process.cwd(), "scripts", "autogen_worker.py"),
      path.resolve(process.cwd(), "apps", "api", "scripts", "autogen_worker.py"),
      path.resolve(moduleDir, "..", "..", "scripts", "autogen_worker.py"),
      path.resolve(moduleDir, "..", "..", "..", "scripts", "autogen_worker.py")
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  }

  async start(): Promise<void> {
    await this.ensureWorker();
  }

  stop(): void {
    this.terminateWorker();
  }

  async requestWithRetry(request: AutoGenTaskRequest): Promise<unknown> {
    try {
      return await this.enqueue(request);
    } catch (error) {
      if (!(error instanceof AutoGenWorkerCrashedError)) {
        throw error;
      }

      await this.restartWorker();
      return this.enqueue(request);
    }
  }

  private async enqueue(request: AutoGenTaskRequest): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timeoutMs = env.autoGenTimeoutSec * 1_000;
      const timeout = setTimeout(() => {
        this.rejectTask(id, new Error(`AutoGen worker timeout after ${env.autoGenTimeoutSec}s`));
        this.terminateWorker();
      }, timeoutMs);

      this.queue.push({ id, request, resolve, reject, timeout });
      void this.pumpQueue();
    });
  }

  private async pumpQueue(): Promise<void> {
    if (!this.queue.length || this.inFlight.size > 0) {
      return;
    }

    await this.ensureWorker();

    const task = this.queue.shift();
    if (!task || !this.worker) {
      return;
    }

    this.inFlight.set(task.id, task);
    const requestPayload = {
      id: task.id,
      task: task.request.task,
      payload: normalizeAutoGenPayload(task.request),
      provider: task.request.provider ?? "openai",
      model: resolveAutoGenModel(task.request),
      reasoningEffort: task.request.reasoningEffort ?? env.autoGenReasoningEffort
    };

    this.worker.stdin.write(`${JSON.stringify(requestPayload)}\n`);
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker) {
      return;
    }

    if (this.booting) {
      return this.booting;
    }

    this.booting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.pythonPath, [this.scriptPath], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENAI_API_KEY: env.openAiApiKey,
          AUTO_GEN_MODEL_TITLE: env.autoGenModelTitle,
          AUTO_GEN_MODEL_DESCRIPTION: env.autoGenModelDescription,
          AUTO_GEN_MODEL_THUMBNAIL: env.autoGenModelThumbnail
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
          console.error(`[autogen] ${message}`);
        }
      });

      child.once("spawn", () => resolve());
      child.once("error", (error) => {
        this.worker = null;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const reason = `AutoGen worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.worker = null;
        this.rejectAllInFlight(new AutoGenWorkerCrashedError(reason));
      });
    }).finally(() => {
      this.booting = null;
    });

    return this.booting;
  }

  private handleWorkerLine(line: string): void {
    let payload: AutoGenWorkerResponse;
    try {
      payload = JSON.parse(line) as AutoGenWorkerResponse;
    } catch {
      return;
    }

    if (!payload.id) {
      return;
    }

    if (payload.ok) {
      this.resolveTask(payload.id, payload.result);
      return;
    }

    this.rejectTask(payload.id, new Error(payload.error ?? "unknown AutoGen worker error"));
  }

  private resolveTask(taskId: string, result: unknown): void {
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

  private async restartWorker(): Promise<void> {
    this.terminateWorker();
    await this.ensureWorker();
  }
}

const autoGenWorkerClient = new AutoGenWorkerClient();

export async function startAutoGenWorker(): Promise<void> {
  await autoGenWorkerClient.start();
}

export function stopAutoGenWorker(): void {
  autoGenWorkerClient.stop();
}

export async function requestAutoGenTask(request: AutoGenTaskRequest): Promise<unknown> {
  return autoGenWorkerClient.requestWithRetry(request);
}
