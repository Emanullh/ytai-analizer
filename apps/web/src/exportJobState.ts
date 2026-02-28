import { ExportSseEvent, ExportVideoStage } from "./types";

export interface ExportModalState {
  isOpen: boolean;
  status: "idle" | "starting" | "running" | "done" | "failed";
  jobId?: string;
  completed: number;
  total: number;
  warnings: string[];
  videoStages: Record<string, ExportVideoStage>;
  exportPath?: string;
  error?: string;
}

export type ExportModalAction =
  | { type: "start"; videoIds: string[] }
  | { type: "job_created"; jobId: string }
  | { type: "event"; payload: ExportSseEvent }
  | { type: "request_failed"; message: string }
  | { type: "close" };

export function createInitialExportModalState(): ExportModalState {
  return {
    isOpen: false,
    status: "idle",
    completed: 0,
    total: 0,
    warnings: [],
    videoStages: {}
  };
}

function toQueueStages(videoIds: string[]): Record<string, ExportVideoStage> {
  const stages: Record<string, ExportVideoStage> = {};
  for (const videoId of videoIds) {
    stages[videoId] = "queue";
  }
  return stages;
}

function reduceWithSseEvent(state: ExportModalState, event: ExportSseEvent): ExportModalState {
  if (event.event === "job_started") {
    return {
      ...state,
      status: "running",
      total: event.data.total
    };
  }

  if (event.event === "video_progress") {
    return {
      ...state,
      videoStages: {
        ...state.videoStages,
        [event.data.videoId]: event.data.stage
      }
    };
  }

  if (event.event === "job_progress") {
    return {
      ...state,
      completed: event.data.completed,
      total: event.data.total
    };
  }

  if (event.event === "warning") {
    return {
      ...state,
      warnings: [...state.warnings, event.data.message]
    };
  }

  if (event.event === "job_done") {
    return {
      ...state,
      status: "done",
      isOpen: true,
      exportPath: event.data.exportPath,
      error: undefined,
      completed: state.total > 0 ? state.total : state.completed
    };
  }

  if (event.event === "job_failed") {
    return {
      ...state,
      status: "failed",
      isOpen: true,
      error: event.data.message
    };
  }

  return state;
}

export function reduceExportModalState(state: ExportModalState, action: ExportModalAction): ExportModalState {
  if (action.type === "start") {
    return {
      isOpen: true,
      status: "starting",
      completed: 0,
      total: action.videoIds.length,
      warnings: [],
      videoStages: toQueueStages(action.videoIds),
      exportPath: undefined,
      error: undefined
    };
  }

  if (action.type === "job_created") {
    return {
      ...state,
      jobId: action.jobId
    };
  }

  if (action.type === "event") {
    return reduceWithSseEvent(state, action.payload);
  }

  if (action.type === "request_failed") {
    return {
      ...state,
      isOpen: true,
      status: "failed",
      error: action.message
    };
  }

  return createInitialExportModalState();
}

