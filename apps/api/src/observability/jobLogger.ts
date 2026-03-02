import { once } from "node:events";
import { createWriteStream, promises as fs, fsync as fsyncCallback } from "node:fs";
import path from "node:path";
import type { WriteStream } from "node:fs";
import { env } from "../config/env.js";
import { hashStringSha256 } from "../utils/hash.js";
import { classifyError, type ClassifiedError } from "./errorClassifier.js";
import { newStepId } from "./ids.js";

export type JobLogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type JobLogScope =
  | "exportJob"
  | "exportService"
  | "youtube"
  | "transcript"
  | "asr"
  | "autogen"
  | "ocr"
  | "embeddings"
  | "cache"
  | "orchestrator"
  | "fs";

export interface JobLogRetry {
  attempt: number;
  max: number;
  willRetry: boolean;
}

export interface JobLogEventInput {
  level?: JobLogLevel;
  stepId?: string;
  scope: JobLogScope;
  action: string;
  stage?: string;
  videoId?: string;
  msg?: string;
  data?: Record<string, unknown>;
  requestId?: string;
}

export interface JobLogErrorInput {
  stepId?: string;
  scope: JobLogScope;
  action: string;
  stage?: string;
  videoId?: string;
  err: unknown;
  msg?: string;
  data?: Record<string, unknown>;
  retry?: JobLogRetry;
  requestId?: string;
}

interface JobErrorPayload {
  name: string;
  message: string;
  stack: string;
  code?: string;
  cause?: string;
  kind: ClassifiedError["kind"];
}

interface JobEventRecord {
  ts: string;
  level: JobLogLevel;
  jobId: string;
  requestId: string;
  stepId: string;
  scope: JobLogScope;
  action: string;
  videoId?: string;
  stage?: string;
  msg: string;
  data?: Record<string, unknown>;
}

interface JobErrorRecord extends JobEventRecord {
  error: JobErrorPayload;
  retry?: JobLogRetry;
}

interface JobSummaryVideoEntry {
  status: "running" | "done" | "warning" | "failed";
  timingsMs: Record<string, number>;
  cacheHit: "full" | "partial" | "miss" | "unknown";
  transcriptStatus: "ok" | "missing" | "error" | "unknown";
  llmUsed: {
    description: boolean;
    transcript: boolean;
    thumbnail: boolean;
    orchestrator: boolean;
  };
}

export interface JobSummaryInput {
  status: "done" | "failed";
  startedAt: string;
  finishedAt: string;
  exportedCount?: number;
  warningsCount?: number;
  errorsCount?: number;
  perStageTimingsMs?: Record<string, number>;
  perVideo?: Record<string, JobSummaryVideoEntry>;
  lastError?: {
    scope: JobLogScope;
    action: string;
    stepId: string;
    videoId?: string;
    code?: string;
    kind?: ClassifiedError["kind"];
    message: string;
  };
}

export interface JobLogger {
  event(input: JobLogEventInput): { stepId: string };
  error(input: JobLogErrorInput): { stepId: string; code: string; kind: ClassifiedError["kind"] };
  flush(): Promise<void>;
  close(): Promise<void>;
  summary(input: JobSummaryInput): Promise<void>;
  getLogPaths(): {
    eventsPath: string;
    errorsPath: string;
    summaryPath: string;
  };
}

interface CreateJobLoggerInput {
  exportRootAbs: string;
  channelFolder: string;
  jobId: string;
  requestId: string;
}

interface VideoSummaryMutable extends JobSummaryVideoEntry {}

const MAX_RECENT_EVENTS = 220;
const MAX_RECENT_ERRORS = 70;

function nowIso(): string {
  return new Date().toISOString();
}

function trimRecent<T>(items: T[], maxItems: number): void {
  while (items.length > maxItems) {
    items.shift();
  }
}

function toStringSafe(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sanitizeValue(value: unknown, keyHint = ""): unknown {
  const keyLower = keyHint.toLowerCase();
  if (
    keyLower.includes("api_key") ||
    keyLower.includes("apikey") ||
    keyLower.includes("authorization") ||
    keyLower.includes("token") ||
    keyLower.includes("secret")
  ) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    if (keyLower.includes("prompt")) {
      return {
        promptHash: hashStringSha256(value),
        promptChars: value.length
      };
    }
    if (value.length > 4_000) {
      return `${value.slice(0, 4_000)}…`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, keyHint));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sanitizeValue(item, key);
  }
  return output;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }
  return sanitizeValue(data) as Record<string, unknown>;
}

function normalizeError(error: unknown): { error: JobErrorPayload; classified: ClassifiedError } {
  const normalized = error instanceof Error ? error : new Error(toStringSafe(error) || "unknown error");
  const classified = classifyError(error);
  const causeRaw = (normalized as { cause?: unknown }).cause;
  const cause = causeRaw ? toStringSafe(causeRaw) : undefined;

  return {
    classified,
    error: {
      name: normalized.name || "Error",
      message: normalized.message || "unknown error",
      stack: normalized.stack || normalized.message || "unknown stack",
      ...(classified.code !== "unknown" ? { code: classified.code } : {}),
      ...(cause ? { cause } : {}),
      kind: classified.kind
    }
  };
}

function emptyVideoSummary(): VideoSummaryMutable {
  return {
    status: "running",
    timingsMs: {},
    cacheHit: "unknown",
    transcriptStatus: "unknown",
    llmUsed: {
      description: false,
      transcript: false,
      thumbnail: false,
      orchestrator: false
    }
  };
}

function mergeTimings(target: Record<string, number>, source: unknown): void {
  if (!source || typeof source !== "object") {
    return;
  }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    target[key] = Number(((target[key] ?? 0) + value).toFixed(3));
  }
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) {
    await once(stream, "drain");
  }
}

async function fsyncFd(fd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fsyncCallback(fd, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

class JobLoggerImpl implements JobLogger {
  private readonly channelRootAbs: string;
  private readonly logsRootAbs: string;
  private readonly eventsPath: string;
  private readonly errorsPath: string;
  private readonly summaryPath: string;
  private readonly debugBundlePath: string;
  private readonly initPromise: Promise<void>;
  private eventStream: WriteStream | null = null;
  private errorStream: WriteStream | null = null;
  private eventFd: number | null = null;
  private errorFd: number | null = null;
  private eventChain: Promise<void> = Promise.resolve();
  private errorChain: Promise<void> = Promise.resolve();
  private closed = false;
  private warningCount = 0;
  private errorCount = 0;
  private readonly perStageTimingsMs: Record<string, number> = {};
  private readonly perVideo = new Map<string, VideoSummaryMutable>();
  private readonly recentEvents: JobEventRecord[] = [];
  private readonly recentErrors: JobErrorRecord[] = [];
  private lastError: JobSummaryInput["lastError"] | undefined;

  constructor(
    private readonly jobId: string,
    private readonly requestId: string,
    exportRootAbs: string,
    channelFolder: string
  ) {
    this.channelRootAbs = path.resolve(exportRootAbs, channelFolder);
    this.logsRootAbs = path.resolve(this.channelRootAbs, "logs");
    this.eventsPath = path.resolve(this.logsRootAbs, `job_${jobId}.events.jsonl`);
    this.errorsPath = path.resolve(this.logsRootAbs, `job_${jobId}.errors.jsonl`);
    this.summaryPath = path.resolve(this.logsRootAbs, `job_${jobId}.summary.json`);
    this.debugBundlePath = path.resolve(this.logsRootAbs, `job_${jobId}.debug_bundle.json`);
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    await fs.mkdir(this.logsRootAbs, { recursive: true });
    this.eventStream = createWriteStream(this.eventsPath, { flags: "a", encoding: "utf-8" });
    this.errorStream = createWriteStream(this.errorsPath, { flags: "a", encoding: "utf-8" });
    const [[eventFd], [errorFd]] = await Promise.all([
      once(this.eventStream, "open") as Promise<[number]>,
      once(this.errorStream, "open") as Promise<[number]>
    ]);
    this.eventFd = eventFd;
    this.errorFd = errorFd;
  }

  private getOrCreateVideoSummary(videoId: string): VideoSummaryMutable {
    const existing = this.perVideo.get(videoId);
    if (existing) {
      return existing;
    }
    const created = emptyVideoSummary();
    this.perVideo.set(videoId, created);
    return created;
  }

  private trackEvent(event: JobEventRecord): void {
    if (event.level === "warn") {
      this.warningCount += 1;
    }

    this.recentEvents.push(event);
    trimRecent(this.recentEvents, MAX_RECENT_EVENTS);

    if (!event.videoId) {
      return;
    }

    const perVideo = this.getOrCreateVideoSummary(event.videoId);
    if (event.action === "video_start") {
      perVideo.status = "running";
      return;
    }
    if (event.action === "cache_hit_full") {
      perVideo.cacheHit = "full";
      return;
    }
    if (event.action === "cache_hit_partial") {
      perVideo.cacheHit = "partial";
      return;
    }
    if (event.action === "cache_miss") {
      perVideo.cacheHit = "miss";
      return;
    }
    if (event.action === "transcript_result" || event.action === "asr_result" || event.action === "captions_result") {
      const transcriptStatus =
        event.data && typeof event.data.transcriptStatus === "string"
          ? event.data.transcriptStatus
          : event.data && typeof event.data.status === "string"
            ? event.data.status
            : undefined;
      if (transcriptStatus === "ok" || transcriptStatus === "missing" || transcriptStatus === "error") {
        perVideo.transcriptStatus = transcriptStatus;
      }
      return;
    }
    if (event.action === "autogen_task_done") {
      const taskName = event.data && typeof event.data.taskName === "string" ? event.data.taskName : "";
      const ok = Boolean(event.data && event.data.ok);
      if (taskName === "description") {
        perVideo.llmUsed.description = ok;
      } else if (taskName === "transcript") {
        perVideo.llmUsed.transcript = ok;
      } else if (taskName === "thumbnail") {
        perVideo.llmUsed.thumbnail = ok;
      } else if (taskName === "orchestrator") {
        perVideo.llmUsed.orchestrator = ok;
      }
      return;
    }
    if (event.action === "video_done") {
      mergeTimings(perVideo.timingsMs, event.data?.timingsMs);
      mergeTimings(this.perStageTimingsMs, event.data?.timingsMs);
      const status = event.data && typeof event.data.status === "string" ? event.data.status : "done";
      if (status === "warning") {
        perVideo.status = "warning";
      } else if (status === "failed") {
        perVideo.status = "failed";
      } else {
        perVideo.status = "done";
      }
    }
  }

  private appendEventRecord(record: JobEventRecord): void {
    this.trackEvent(record);
    this.eventChain = this.eventChain.then(async () => {
      await this.initPromise;
      if (!this.eventStream) {
        return;
      }
      await writeLine(this.eventStream, JSON.stringify(record));
    });
  }

  private appendErrorRecord(record: JobErrorRecord): void {
    this.errorCount += 1;
    this.lastError = {
      scope: record.scope,
      action: record.action,
      stepId: record.stepId,
      ...(record.videoId ? { videoId: record.videoId } : {}),
      ...(record.error.code ? { code: record.error.code } : {}),
      kind: record.error.kind,
      message: record.error.message
    };

    this.recentErrors.push(record);
    trimRecent(this.recentErrors, MAX_RECENT_ERRORS);

    this.errorChain = this.errorChain.then(async () => {
      await this.initPromise;
      if (!this.errorStream) {
        return;
      }
      await writeLine(this.errorStream, JSON.stringify(record));
    });
  }

  event(input: JobLogEventInput): { stepId: string } {
    const stepId = input.stepId ?? newStepId();
    const record: JobEventRecord = {
      ts: nowIso(),
      level: input.level ?? "info",
      jobId: this.jobId,
      requestId: input.requestId ?? this.requestId,
      stepId,
      scope: input.scope,
      action: input.action,
      ...(input.videoId ? { videoId: input.videoId } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      msg: input.msg ?? input.action,
      ...(input.data ? { data: sanitizeData(input.data) } : {})
    };
    this.appendEventRecord(record);
    return { stepId };
  }

  error(input: JobLogErrorInput): { stepId: string; code: string; kind: ClassifiedError["kind"] } {
    const stepId = input.stepId ?? newStepId();
    const normalized = normalizeError(input.err);
    const eventRecord: JobEventRecord = {
      ts: nowIso(),
      level: "error",
      jobId: this.jobId,
      requestId: input.requestId ?? this.requestId,
      stepId,
      scope: input.scope,
      action: input.action,
      ...(input.videoId ? { videoId: input.videoId } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
      msg: input.msg ?? normalized.error.message,
      ...(input.data ? { data: sanitizeData(input.data) } : {})
    };
    const errorRecord: JobErrorRecord = {
      ...eventRecord,
      error: normalized.error,
      ...(input.retry ? { retry: input.retry } : {})
    };

    this.appendEventRecord(eventRecord);
    this.appendErrorRecord(errorRecord);
    return {
      stepId,
      code: normalized.classified.code,
      kind: normalized.classified.kind
    };
  }

  private async maybeWriteDebugBundle(summary: Record<string, unknown>): Promise<void> {
    const manifestPath = path.resolve(this.channelRootAbs, "manifest.json");
    const rawManifest = await fs.readFile(manifestPath, "utf-8").catch(() => "");
    let artifacts: string[] = [];
    if (rawManifest) {
      try {
        const parsed = JSON.parse(rawManifest) as { artifacts?: unknown };
        if (Array.isArray(parsed.artifacts)) {
          artifacts = parsed.artifacts.filter((item): item is string => typeof item === "string");
        }
      } catch {
        artifacts = [];
      }
    }

    const envSnapshot = {
      LOCAL_ASR_ENABLED: env.localAsrEnabled,
      LOCAL_ASR_MODEL: env.localAsrModel,
      LOCAL_ASR_COMPUTE_TYPE: env.localAsrComputeType,
      LOCAL_ASR_LANGUAGE: env.localAsrLanguage,
      AUTO_GEN_ENABLED: env.autoGenEnabled,
      AUTO_GEN_MODEL_TITLE: env.autoGenModelTitle,
      AUTO_GEN_MODEL_DESCRIPTION: env.autoGenModelDescription,
      AUTO_GEN_MODEL_THUMBNAIL: env.autoGenModelThumbnail,
      AUTO_GEN_MODEL_ORCHESTRATOR: env.autoGenModelOrchestrator,
      AUTO_GEN_REASONING_EFFORT: env.autoGenReasoningEffort,
      THUMB_OCR_ENABLED: env.thumbOcrEnabled,
      THUMB_OCR_LANGS: env.thumbOcrLangs,
      OPENAI_API_KEY_CONFIGURED: Boolean(env.openAiApiKey),
      YOUTUBE_API_KEY_CONFIGURED: Boolean(env.youtubeApiKey)
    };

    const payload = {
      jobId: this.jobId,
      generatedAt: nowIso(),
      manifestPath: rawManifest ? "manifest.json" : null,
      artifacts,
      summary,
      lastEvents: this.recentEvents.slice(-200),
      lastErrors: this.recentErrors.slice(-50),
      env: envSnapshot
    };
    await fs.writeFile(this.debugBundlePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  }

  async summary(input: JobSummaryInput): Promise<void> {
    await this.flush();
    const perVideo: Record<string, JobSummaryVideoEntry> = {};
    for (const [videoId, value] of this.perVideo.entries()) {
      perVideo[videoId] = {
        status: value.status,
        timingsMs: { ...value.timingsMs },
        cacheHit: value.cacheHit,
        transcriptStatus: value.transcriptStatus,
        llmUsed: { ...value.llmUsed }
      };
    }

    const mergedPerVideo = {
      ...perVideo,
      ...(input.perVideo ?? {})
    };
    const mergedStageTimings: Record<string, number> = {
      ...this.perStageTimingsMs
    };
    mergeTimings(mergedStageTimings, input.perStageTimingsMs);
    const durationMs = Math.max(0, new Date(input.finishedAt).getTime() - new Date(input.startedAt).getTime());

    const summary = {
      jobId: this.jobId,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs,
      status: input.status,
      exportedCount: input.exportedCount ?? Object.keys(mergedPerVideo).length,
      warningsCount: input.warningsCount ?? this.warningCount,
      errorsCount: input.errorsCount ?? this.errorCount,
      perStageTimingsMs: mergedStageTimings,
      perVideo: mergedPerVideo,
      lastError: input.lastError ?? this.lastError ?? null
    };
    await fs.writeFile(this.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

    if (input.status === "failed") {
      await this.maybeWriteDebugBundle(summary);
    }
  }

  async flush(): Promise<void> {
    await this.initPromise;
    await Promise.all([this.eventChain, this.errorChain]);
    if (this.eventFd !== null) {
      await fsyncFd(this.eventFd);
    }
    if (this.errorFd !== null) {
      await fsyncFd(this.errorFd);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.flush();

    const streams = [this.eventStream, this.errorStream].filter((stream): stream is WriteStream => Boolean(stream));
    await Promise.all(
      streams.map(
        async (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          })
      )
    );
  }

  getLogPaths(): { eventsPath: string; errorsPath: string; summaryPath: string } {
    return {
      eventsPath: this.eventsPath,
      errorsPath: this.errorsPath,
      summaryPath: this.summaryPath
    };
  }
}

export function createJobLogger(input: CreateJobLoggerInput): JobLogger {
  return new JobLoggerImpl(input.jobId, input.requestId, input.exportRootAbs, input.channelFolder);
}
