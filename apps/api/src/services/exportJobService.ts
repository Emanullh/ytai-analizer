import { randomUUID } from "node:crypto";
import { ExportRequest, ExportVideoStage, exportSelectedVideos } from "./exportService.js";

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

  createJob(request: ExportRequest): { jobId: string } {
    const jobId = randomUUID();
    const record: ExportJobRecord = {
      jobId,
      status: "queued",
      completed: 0,
      total: 0,
      warnings: [],
      videoStages: {},
      request: {
        ...request,
        jobId
      },
      events: [],
      listeners: new Set()
    };
    this.jobs.set(jobId, record);
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
    try {
      const result = await exportSelectedVideos(record.request, {
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
          this.emit(record, {
            event: "warning",
            data: { videoId, message }
          });
        }
      });

      record.status = "done";
      record.completed = record.total;
      record.exportPath = result.folderPath;
      this.emit(record, {
        event: "job_done",
        data: { exportPath: result.folderPath }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown export job error";
      record.status = "failed";
      record.error = message;
      this.emit(record, {
        event: "job_failed",
        data: { message }
      });
    }
  }
}

export const exportJobService = new ExportJobService();

