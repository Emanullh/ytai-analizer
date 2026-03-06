import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { collectExemplarVideoIds } from "./exportBundleService.js";
import { createScheduler } from "./taskScheduler.js";
import { ProjectLockError, projectOperationLockService } from "./projectOperationLockService.js";
import {
  rerunVideoFeature,
  type VideoFeatureKind,
  type VideoFeatureRerunMode
} from "./videoFeatureRerunService.js";

export type ProjectFeatureRerunScope = "all" | "exemplars" | "selected";
export type BatchProjectFeatureKind = VideoFeatureKind;
export type ProjectFeatureRerunJobStatus = "queued" | "running" | "done" | "failed";

export interface ProjectFeatureRerunRequest {
  projectId: string;
  feature: BatchProjectFeatureKind;
  mode: VideoFeatureRerunMode;
  scope: ProjectFeatureRerunScope;
  videoIds?: string[];
}

export type ProjectFeatureRerunEvent =
  | {
      event: "job_started";
      data: {
        jobId: string;
        projectId: string;
        feature: BatchProjectFeatureKind;
        mode: VideoFeatureRerunMode;
        total: number;
        scope: ProjectFeatureRerunScope;
      };
    }
  | {
      event: "video_progress";
      data: {
        videoId: string;
        status: "processing" | "done" | "failed";
        message?: string;
      };
    }
  | {
      event: "job_progress";
      data: {
        completed: number;
        total: number;
        processed: number;
        failed: number;
      };
    }
  | { event: "warning"; data: { videoId?: string; message: string } }
  | {
      event: "job_done";
      data: {
        projectId: string;
        feature: BatchProjectFeatureKind;
        mode: VideoFeatureRerunMode;
        completed: number;
        total: number;
        processed: number;
        failed: number;
        auditArtifactPath: string;
      };
    }
  | { event: "job_failed"; data: { message: string } };

export interface ProjectFeatureRerunJobState {
  jobId: string;
  projectId: string;
  feature: BatchProjectFeatureKind;
  mode: VideoFeatureRerunMode;
  status: ProjectFeatureRerunJobStatus;
  total: number;
  completed: number;
  processed: number;
  failed: number;
  warnings: string[];
  error?: string;
  auditArtifactPath?: string;
}

interface ProjectFeatureRerunJobRecord extends ProjectFeatureRerunJobState {
  request: ProjectFeatureRerunRequest;
  events: ProjectFeatureRerunEvent[];
  listeners: Set<(event: ProjectFeatureRerunEvent) => void>;
  startedAt?: string;
  finishedAt?: string;
  videoErrors: Array<{ videoId: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid project path");
  }
}

function getExportsRoot(): string {
  return path.resolve(process.cwd(), "exports");
}

function nowIso(): string {
  return new Date().toISOString();
}

function toTimestampToken(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJsonlRecords(filePath: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) {
        records.push(parsed);
      }
    } catch {
      // Ignore malformed rows.
    }
  }
  return records;
}

async function readProjectInventory(projectId: string): Promise<{ projectRoot: string; inventoryVideoIds: Set<string> }> {
  const normalizedProjectId = projectId.trim();
  if (
    !normalizedProjectId ||
    normalizedProjectId.includes("/") ||
    normalizedProjectId.includes("\\") ||
    normalizedProjectId.includes("..") ||
    path.isAbsolute(normalizedProjectId)
  ) {
    throw new Error("Invalid projectId");
  }

  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, normalizedProjectId);
  ensureInsideRoot(exportsRoot, projectRoot);

  if (!(await fileExists(projectRoot))) {
    throw new Error(`Project not found: ${normalizedProjectId}`);
  }

  const [rawVideoRows, channelJson] = await Promise.all([
    readJsonlRecords(path.resolve(projectRoot, "raw", "videos.jsonl")),
    readJson(path.resolve(projectRoot, "channel.json"))
  ]);

  const rawVideoIds = rawVideoRows.map((row) => toString(row.videoId)).filter((item): item is string => Boolean(item));
  const channelVideoIds = Array.isArray(channelJson?.videos)
    ? channelJson.videos
        .map((row) => (isRecord(row) ? toString(row.videoId) : null))
        .filter((item): item is string => Boolean(item))
    : [];

  const inventoryVideoIds = new Set(rawVideoIds.length > 0 ? rawVideoIds : channelVideoIds);
  if (inventoryVideoIds.size === 0) {
    throw new Error("No videos found in project inventory");
  }

  return {
    projectRoot,
    inventoryVideoIds
  };
}

async function resolveScopeVideoIds(input: {
  projectRoot: string;
  scope: ProjectFeatureRerunScope;
  selectedVideoIds?: string[];
  inventoryVideoIds: Set<string>;
}): Promise<string[]> {
  if (input.scope === "all") {
    return Array.from(input.inventoryVideoIds);
  }

  if (input.scope === "selected") {
    const selected = (input.selectedVideoIds ?? []).map((item) => item.trim()).filter(Boolean);
    if (selected.length === 0) {
      throw new Error("scope=selected requires at least one videoId");
    }
    return Array.from(new Set(selected.filter((videoId) => input.inventoryVideoIds.has(videoId))));
  }

  const orchestratorInput = await readJson(path.resolve(input.projectRoot, "analysis", "orchestrator_input.json"));
  if (!orchestratorInput) {
    throw new Error("scope=exemplars requires analysis/orchestrator_input.json");
  }

  return Array.from(new Set(collectExemplarVideoIds(orchestratorInput).filter((videoId) => input.inventoryVideoIds.has(videoId))));
}

function cloneJobState(record: ProjectFeatureRerunJobRecord): ProjectFeatureRerunJobState {
  return {
    jobId: record.jobId,
    projectId: record.projectId,
    feature: record.feature,
    mode: record.mode,
    status: record.status,
    total: record.total,
    completed: record.completed,
    processed: record.processed,
    failed: record.failed,
    warnings: [...record.warnings],
    error: record.error,
    auditArtifactPath: record.auditArtifactPath
  };
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

class RerunProjectFeaturesJobService {
  private readonly jobs = new Map<string, ProjectFeatureRerunJobRecord>();

  createJob(request: ProjectFeatureRerunRequest): { jobId: string } {
    const jobId = randomUUID();
    projectOperationLockService.acquireOrThrow({
      projectId: request.projectId,
      operation: `rerun_feature_batch:${request.feature}`,
      ownerId: jobId
    });

    const record: ProjectFeatureRerunJobRecord = {
      jobId,
      projectId: request.projectId,
      feature: request.feature,
      mode: request.mode,
      request,
      status: "queued",
      total: 0,
      completed: 0,
      processed: 0,
      failed: 0,
      warnings: [],
      videoErrors: [],
      events: [],
      listeners: new Set()
    };

    this.jobs.set(jobId, record);
    void this.runJob(record);
    return { jobId };
  }

  getJob(jobId: string): ProjectFeatureRerunJobState | null {
    const record = this.jobs.get(jobId);
    if (!record) {
      return null;
    }
    return cloneJobState(record);
  }

  getJobEvents(jobId: string): ProjectFeatureRerunEvent[] {
    const record = this.jobs.get(jobId);
    return record ? [...record.events] : [];
  }

  subscribe(jobId: string, listener: (event: ProjectFeatureRerunEvent) => void): () => void {
    const record = this.jobs.get(jobId);
    if (!record) {
      return () => undefined;
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private emit(record: ProjectFeatureRerunJobRecord, event: ProjectFeatureRerunEvent): void {
    record.events.push(event);
    for (const listener of record.listeners) {
      listener(event);
    }
  }

  private emitProgress(record: ProjectFeatureRerunJobRecord): void {
    this.emit(record, {
      event: "job_progress",
      data: {
        completed: record.completed,
        total: record.total,
        processed: record.processed,
        failed: record.failed
      }
    });
  }

  private pushWarning(record: ProjectFeatureRerunJobRecord, message: string, videoId?: string): void {
    record.warnings.push(message);
    this.emit(record, {
      event: "warning",
      data: {
        ...(videoId ? { videoId } : {}),
        message
      }
    });
  }

  private async runJob(record: ProjectFeatureRerunJobRecord): Promise<void> {
    record.status = "running";
    record.startedAt = nowIso();

    try {
      const project = await readProjectInventory(record.projectId);
      const requestedVideoIds = await resolveScopeVideoIds({
        projectRoot: project.projectRoot,
        scope: record.request.scope,
        selectedVideoIds: record.request.videoIds,
        inventoryVideoIds: project.inventoryVideoIds
      });

      if (requestedVideoIds.length === 0) {
        throw new Error("No videos selected for this rerun scope");
      }

      record.total = requestedVideoIds.length;
      this.emit(record, {
        event: "job_started",
        data: {
          jobId: record.jobId,
          projectId: record.projectId,
          feature: record.feature,
          mode: record.mode,
          total: record.total,
          scope: record.request.scope
        }
      });

      const scheduler = createScheduler({
        video: Math.max(1, env.exportVideoConcurrency),
        http: 1,
        asr: 1,
        ocr: 1,
        llm: 1,
        embeddings: 1,
        fs: Math.max(1, env.exportFsConcurrency)
      });

      const startedAtMs = Date.now();
      await Promise.all(
        requestedVideoIds.map((videoId) =>
          scheduler.runVideo(videoId, async () => {
            this.emit(record, {
              event: "video_progress",
              data: {
                videoId,
                status: "processing"
              }
            });

            try {
              const result = await rerunVideoFeature(
                {
                  projectId: record.projectId,
                  videoId,
                  feature: record.feature,
                  mode: record.mode
                },
                {
                  bypassProjectLock: true
                }
              );

              for (const warning of result.warnings) {
                this.pushWarning(record, warning, videoId);
              }

              record.processed += 1;
              record.completed += 1;
              this.emit(record, {
                event: "video_progress",
                data: {
                  videoId,
                  status: "done",
                  message:
                    record.mode === "collect_assets"
                      ? `${record.feature} assets collected`
                      : record.mode === "prepare"
                        ? `${record.feature} prepared`
                        : `${record.feature} refreshed`
                }
              });
              this.emitProgress(record);
            } catch (error) {
              const message = error instanceof Error ? error.message : "unknown rerun error";
              record.failed += 1;
              record.completed += 1;
              record.videoErrors.push({ videoId, message });
              this.pushWarning(record, `Rerun failed for ${videoId}: ${message}`, videoId);
              this.emit(record, {
                event: "video_progress",
                data: {
                  videoId,
                  status: "failed",
                  message
                }
              });
              this.emitProgress(record);
            }
          })
        )
      );

      const finishedAt = nowIso();
      record.finishedAt = finishedAt;
      const auditArtifactPath = path.posix.join(
        "operations",
        "reruns",
        `${record.feature}_${toTimestampToken(finishedAt)}.json`
      );
      const auditAbsolutePath = path.resolve(project.projectRoot, auditArtifactPath);
      ensureInsideRoot(project.projectRoot, auditAbsolutePath);
      await fs.mkdir(path.dirname(auditAbsolutePath), { recursive: true });
      await writeJsonAtomic(auditAbsolutePath, {
        schemaVersion: "operations.rerun_project_feature.v1",
        projectId: record.projectId,
        jobId: record.jobId,
        feature: record.feature,
        mode: record.mode,
        scope: record.request.scope,
        startedAt: record.startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.now() - startedAtMs),
        videoIds: requestedVideoIds,
        counts: {
          total: record.total,
          completed: record.completed,
          processed: record.processed,
          failed: record.failed
        },
        warnings: [...record.warnings],
        errors: [...record.videoErrors]
      });

      record.auditArtifactPath = auditArtifactPath;
      record.status = "done";
      this.emit(record, {
        event: "job_done",
        data: {
          projectId: record.projectId,
          feature: record.feature,
          mode: record.mode,
          completed: record.completed,
          total: record.total,
          processed: record.processed,
          failed: record.failed,
          auditArtifactPath
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "project feature rerun failed";
      record.status = "failed";
      record.error = message;
      this.emit(record, {
        event: "job_failed",
        data: { message }
      });
    } finally {
      projectOperationLockService.release({
        projectId: record.projectId,
        ownerId: record.jobId
      });
    }
  }
}

export const rerunProjectFeaturesJobService = new RerunProjectFeaturesJobService();

export function isProjectFeatureRerunLockError(error: unknown): error is ProjectLockError {
  return error instanceof ProjectLockError;
}
