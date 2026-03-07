import { randomUUID } from "node:crypto";
import { ProjectLockError, projectOperationLockService } from "./projectOperationLockService.js";
import { extendProject, type ProjectExtendRequest } from "./projectExtendService.js";

export type ProjectExtendJobStatus = "queued" | "running" | "done" | "failed";

export type ProjectExtendJobEvent =
  | {
      event: "job_started";
      data: {
        jobId: string;
        projectId: string;
        total: number;
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
        jobId: string;
        addedCount: number;
        refreshedCount: number;
        reprocessedCount: number;
      };
    }
  | { event: "job_failed"; data: { message: string } };

export interface ProjectExtendJobState {
  jobId: string;
  projectId: string;
  status: ProjectExtendJobStatus;
  total: number;
  completed: number;
  processed: number;
  failed: number;
  warnings: string[];
  error?: string;
  addedCount?: number;
  refreshedCount?: number;
  reprocessedCount?: number;
}

interface ProjectExtendJobRecord extends ProjectExtendJobState {
  request: ProjectExtendRequest;
  events: ProjectExtendJobEvent[];
  listeners: Set<(event: ProjectExtendJobEvent) => void>;
}

function cloneState(record: ProjectExtendJobRecord): ProjectExtendJobState {
  return {
    jobId: record.jobId,
    projectId: record.projectId,
    status: record.status,
    total: record.total,
    completed: record.completed,
    processed: record.processed,
    failed: record.failed,
    warnings: [...record.warnings],
    error: record.error,
    addedCount: record.addedCount,
    refreshedCount: record.refreshedCount,
    reprocessedCount: record.reprocessedCount
  };
}

class ProjectExtendJobService {
  private readonly jobs = new Map<string, ProjectExtendJobRecord>();

  createJob(request: ProjectExtendRequest): { jobId: string } {
    const jobId = randomUUID();
    projectOperationLockService.acquireOrThrow({
      projectId: request.projectId,
      operation: "extend",
      ownerId: jobId
    });

    const record: ProjectExtendJobRecord = {
      jobId,
      projectId: request.projectId,
      request: {
        ...request,
        jobId
      },
      status: "queued",
      total: 0,
      completed: 0,
      processed: 0,
      failed: 0,
      warnings: [],
      events: [],
      listeners: new Set()
    };

    this.jobs.set(jobId, record);
    void this.runJob(record);
    return { jobId };
  }

  getJob(jobId: string): ProjectExtendJobState | null {
    const record = this.jobs.get(jobId);
    return record ? cloneState(record) : null;
  }

  getJobEvents(jobId: string): ProjectExtendJobEvent[] {
    return this.jobs.get(jobId)?.events ?? [];
  }

  subscribe(jobId: string, listener: (event: ProjectExtendJobEvent) => void): () => void {
    const record = this.jobs.get(jobId);
    if (!record) {
      return () => undefined;
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private emit(record: ProjectExtendJobRecord, event: ProjectExtendJobEvent): void {
    record.events.push(event);
    for (const listener of record.listeners) {
      listener(event);
    }
  }

  private async runJob(record: ProjectExtendJobRecord): Promise<void> {
    record.status = "running";

    try {
      const result = await extendProject(record.request, {
        onJobStarted: ({ total }) => {
          record.total = total;
          this.emit(record, {
            event: "job_started",
            data: {
              jobId: record.jobId,
              projectId: record.projectId,
              total
            }
          });
        },
        onVideoProgress: ({ videoId, status, message }) => {
          this.emit(record, {
            event: "video_progress",
            data: {
              videoId,
              status,
              ...(message ? { message } : {})
            }
          });
        },
        onJobProgress: ({ completed, total, processed, failed }) => {
          record.completed = completed;
          record.total = total;
          record.processed = processed;
          record.failed = failed;
          this.emit(record, {
            event: "job_progress",
            data: {
              completed,
              total,
              processed,
              failed
            }
          });
        },
        onWarning: ({ videoId, message }) => {
          record.warnings.push(message);
          this.emit(record, {
            event: "warning",
            data: {
              ...(videoId ? { videoId } : {}),
              message
            }
          });
        }
      });

      record.status = "done";
      record.completed = Math.max(record.completed, record.total);
      record.processed = Math.max(record.processed, result.addedCount + result.reprocessedCount);
      record.addedCount = result.addedCount;
      record.refreshedCount = result.refreshedCount;
      record.reprocessedCount = result.reprocessedCount;
      this.emit(record, {
        event: "job_done",
        data: {
          projectId: result.projectId,
          jobId: record.jobId,
          addedCount: result.addedCount,
          refreshedCount: result.refreshedCount,
          reprocessedCount: result.reprocessedCount
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "extend job failed";
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

export const projectExtendJobService = new ProjectExtendJobService();

export function isProjectExtendLockError(error: unknown): error is ProjectLockError {
  return error instanceof ProjectLockError;
}
