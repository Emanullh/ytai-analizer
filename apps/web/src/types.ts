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
