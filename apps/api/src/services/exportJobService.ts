import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { createJobLogger, type JobLogger } from "../observability/jobLogger.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { newStepId } from "../observability/ids.js";
import { EXPORT_VERSION, ExportRequest, ExportVideoStage, exportSelectedVideos } from "./exportService.js";

export type ExportJobStatus = "queued" | "running" | "done" | "failed";

export type ExportJobEvent =
  | { event: "job_started"; data: { total: number } }
  | { event: "video_progress"; data: { videoId: string; stage: ExportVideoStage; percent?: number } }
  | { event: "job_progress"; data: { completed: number; total: number } }
  | { event: "warning"; data: { videoId?: string; message: string } }
  | { event: "job_done"; data: { exportPath: string } }
  | { event: "job_failed"; data: { message: string } };

export interface ExportJobState {
  jobId: string;
  status: ExportJobStatus;
  completed: number;
  total: number;
  warnings: string[];
  exportPath?: string;
  error?: string;
  videoStages: Record<string, ExportVideoStage>;
}

interface ExportJobRecord extends ExportJobState {
  requestId: string;
  startedAt?: string;
  logger: JobLogger;
  request: ExportRequest;
  events: ExportJobEvent[];
  listeners: Set<(event: ExportJobEvent) => void>;
}

function cloneJobState(record: ExportJobRecord): ExportJobState {
  return {
    jobId: record.jobId,
    status: record.status,
    completed: record.completed,
    total: record.total,
    warnings: [...record.warnings],
    exportPath: record.exportPath,
    error: record.error,
    videoStages: { ...record.videoStages }
  };
}

export class ExportJobService {
  private readonly jobs = new Map<string, ExportJobRecord>();

  createJob(request: ExportRequest, options: { requestId?: string } = {}): { jobId: string } {
    const jobId = randomUUID();
    const requestId = options.requestId ?? randomUUID();
    const channelFolder = sanitizeFolderName(request.channelName);
    const logger = createJobLogger({
      exportRootAbs: path.resolve(process.cwd(), "exports"),
      channelFolder,
      jobId,
      requestId
    });
    const record: ExportJobRecord = {
      jobId,
      requestId,
      status: "queued",
      completed: 0,
      total: 0,
      warnings: [],
      videoStages: {},
      logger,
      request: {
        ...request,
        jobId
      },
      events: [],
      listeners: new Set()
    };
    this.jobs.set(jobId, record);
    record.logger.event({
      level: "info",
      scope: "exportJob",
      action: "job_created",
      msg: "Export job created",
      data: {
        channelId: request.channelId,
        timeframe: request.timeframe,
        selectedVideos: request.selectedVideoIds.length
      }
    });
    void this.runJob(record);
    return { jobId };
  }

  getJob(jobId: string): ExportJobState | null {
    const record = this.jobs.get(jobId);
    if (!record) {
      return null;
    }
    return cloneJobState(record);
  }

  getJobEvents(jobId: string): ExportJobEvent[] {
    const record = this.jobs.get(jobId);
    if (!record) {
      return [];
    }
    return [...record.events];
  }

  subscribe(jobId: string, listener: (event: ExportJobEvent) => void): () => void {
    const record = this.jobs.get(jobId);
    if (!record) {
      return () => undefined;
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private emit(record: ExportJobRecord, event: ExportJobEvent): void {
    record.events.push(event);
    for (const listener of record.listeners) {
      listener(event);
    }
  }

  private async runJob(record: ExportJobRecord): Promise<void> {
    record.status = "running";
    record.startedAt = new Date().toISOString();
    record.logger.event({
      scope: "exportJob",
      action: "job_started",
      msg: "Export job started",
      data: {
        exportVersion: EXPORT_VERSION,
        timeframe: record.request.timeframe,
        AUTO_GEN_ENABLED: env.autoGenEnabled,
        LOCAL_ASR_ENABLED: env.localAsrEnabled,
        THUMB_OCR_ENABLED: env.thumbOcrEnabled,
        THUMB_OCR_ENGINE: env.thumbOcrEngine,
        embeddingModel: "text-embedding-3-small",
        llmModels: {
          title: env.autoGenModelTitle,
          description: env.autoGenModelDescription,
          thumbnail: env.autoGenModelThumbnail,
          orchestrator: env.autoGenModelOrchestrator
        },
        cacheEnabled: true
      }
    });

    try {
      const result = await exportSelectedVideos(record.request, {
        jobId: record.jobId,
        jobLogger: record.logger,
        requestId: record.requestId,
        onJobStarted: ({ total }) => {
          record.total = total;
          this.emit(record, {
            event: "job_started",
            data: { total }
          });
        },
        onVideoProgress: ({ videoId, stage, percent }) => {
          record.videoStages[videoId] = stage;
          this.emit(record, {
            event: "video_progress",
            data: { videoId, stage, percent }
          });
        },
        onJobProgress: ({ completed, total }) => {
          record.completed = completed;
          record.total = total;
          this.emit(record, {
            event: "job_progress",
            data: { completed, total }
          });
        },
        onWarning: ({ videoId, message }) => {
          record.warnings.push(message);
          record.logger.event({
            level: "warn",
            scope: "exportJob",
            action: "job_warning",
            ...(videoId ? { videoId } : {}),
            msg: message
          });
          this.emit(record, {
            event: "warning",
            data: { videoId, message }
          });
        }
      });

      record.status = "done";
      record.completed = record.total;
      record.exportPath = result.folderPath;
      record.logger.event({
        scope: "exportJob",
        action: "job_done",
        msg: "Export job completed",
        data: {
          exportPath: result.folderPath,
          exportedCount: result.exportedCount
        }
      });
      await record.logger.summary({
        status: "done",
        startedAt: record.startedAt,
        finishedAt: new Date().toISOString(),
        exportedCount: result.exportedCount,
        warningsCount: record.warnings.length
      });
      this.emit(record, {
        event: "job_done",
        data: { exportPath: result.folderPath }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown export job error";
      const errorLog = record.logger.error({
        stepId: newStepId(),
        scope: "exportJob",
        action: "job_failed",
        err: error,
        msg: message
      });
      record.status = "failed";
      record.error = message;
      const warningMessage = `ERR exportJob/job_failed stepId=${errorLog.stepId} (see logs/job_${record.jobId}.errors.jsonl)`;
      record.warnings.push(warningMessage);
      this.emit(record, {
        event: "warning",
        data: { message: warningMessage }
      });

      await record.logger.summary({
        status: "failed",
        startedAt: record.startedAt,
        finishedAt: new Date().toISOString(),
        warningsCount: record.warnings.length,
        errorsCount: 1
      });

      this.emit(record, {
        event: "job_failed",
        data: { message }
      });
    } finally {
      await record.logger.close();
    }
  }
}

export const exportJobService = new ExportJobService();
