export type Timeframe = "1m" | "6m" | "1y";

export interface VideoSummary {
  videoId: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  thumbnailUrl: string;
}

export interface AnalyzeResult {
  channelId: string;
  channelName: string;
  sourceInput: string;
  timeframe: Timeframe;
  warnings: string[];
  videos: VideoSummary[];
}

export interface ExportVideoRecord {
  videoId: string;
  title: string;
  viewCount: number;
  publishedAt: string;
  thumbnailPath: string;
  transcript: string;
  transcriptStatus?: "ok" | "missing" | "error";
}

export interface TimeframeResolved {
  publishedAfter: string;
  publishedBefore: string;
}

export interface ExportPayload {
  exportVersion: string;
  exportedAt: string;
  channelName: string;
  channelId: string;
  sourceInput: string;
  timeframe: Timeframe;
  timeframeResolved: TimeframeResolved;
  videos: ExportVideoRecord[];
}
