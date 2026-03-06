export type Timeframe = "1m" | "6m" | "1y";

export interface VideoItem {
  videoId: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  thumbnailUrl: string;
}

export interface AnalyzeResponse {
  channelId: string;
  channelName: string;
  sourceInput: string;
  timeframe: Timeframe;
  warnings: string[];
  videos: VideoItem[];
}

export type ExportVideoStage =
  | "queue"
  | "downloading_audio"
  | "transcribing"
  | "downloading_thumbnail"
  | "writing_json"
  | "done"
  | "warning"
  | "failed";

export interface ExportJobCreateResponse {
  jobId: string;
}

export interface ExportJobStatusResponse {
  jobId: string;
  status: "queued" | "running" | "done" | "failed";
  completed: number;
  total: number;
  warnings: string[];
  exportPath?: string;
  error?: string;
  videoStages: Record<string, ExportVideoStage>;
}

export type ExportSseEvent =
  | { event: "job_started"; data: { total: number } }
  | { event: "video_progress"; data: { videoId: string; stage: ExportVideoStage; percent?: number } }
  | { event: "job_progress"; data: { completed: number; total: number } }
  | { event: "warning"; data: { videoId?: string; message: string } }
  | { event: "job_done"; data: { exportPath: string } }
  | { event: "job_failed"; data: { message: string } };

export type ProjectStatus = "ok" | "partial" | "failed" | "unknown";

export interface ProjectCounts {
  totalVideosSelected: number;
  transcriptsOk: number;
  transcriptsMissing: number;
  transcriptsError: number;
  thumbnailsOk: number;
  thumbnailsFailed: number;
}

export interface ProjectListItem {
  projectId: string;
  channelId: string | null;
  channelName: string | null;
  exportVersion: string | null;
  lastExportedAt: string | null;
  lastJobId: string | null;
  counts: ProjectCounts;
  warningsCount: number;
  status: ProjectStatus;
  warnings: string[];
}

export interface ProjectJob {
  jobId: string;
  status: "done" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  warningsCount: number;
  errorsCount: number;
  summaryPath: string;
  eventsPath: string;
  errorsPath: string;
  debugBundlePath: string | null;
}

export interface ProjectDetailResponse {
  projectId: string;
  channel: {
    channelId: string | null;
    channelName: string | null;
    sourceInput: string | null;
    timeframe: string | null;
    exportedAt: string | null;
    timeframeResolved: Record<string, unknown> | null;
  };
  manifest: {
    warnings?: string[];
    counts?: ProjectCounts;
    [key: string]: unknown;
  } | null;
  latestJob: {
    jobId: string;
    status: "done" | "failed";
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    warningsCount: number;
    errorsCount: number;
  } | null;
  jobs: ProjectJob[];
  artifacts: {
    playbook: string | null;
    templates: string | null;
    channelModels: string | null;
  };
  warnings: string[];
}

export interface ProjectVideoSummary {
  videoId: string;
  title: string;
  publishedAt: string | null;
  thumbnailPath: string | null;
  transcriptStatus: "ok" | "missing" | "error";
  transcriptSource: "captions" | "asr" | "none";
  performance: {
    viewsPerDay: number | null;
    engagementRate: number | null;
    residual: number | null;
    percentile: number | null;
  } | null;
  hasLLM: {
    title: boolean;
    description: boolean;
    transcript: boolean;
    thumbnail: boolean;
  };
  cacheHit: "full" | "partial" | "miss" | "unknown" | null;
}

export interface ProjectVideoDetail {
  videoId: string;
  derived: Record<string, unknown> | null;
  transcriptJsonl: Array<Record<string, unknown>> | null;
  rawVideo: Record<string, unknown> | null;
}
