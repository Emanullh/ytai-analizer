import type { Timeframe } from "../types.js";

type NullableNumber = number | null;
type Scalar = string | number | boolean | null;

export interface ChannelMetaInput {
  channelId: string;
  channelName: string;
  timeframe: Timeframe;
  jobId: string;
}

export interface FlatVideoRow {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSec: NullableNumber;
  description: string | null;
  performance: {
    viewsPerDay: NullableNumber;
    engagementRate: NullableNumber;
    residual: NullableNumber;
    percentile: NullableNumber;
  };
  titleFeatures: {
    deterministic: Record<string, Scalar>;
    llm: {
      promiseTypePrimary: string | null;
    };
  };
  descriptionFeatures: {
    deterministic: Record<string, Scalar>;
  };
  transcriptFeatures: {
    deterministic: Record<string, Scalar>;
  };
  thumbnailFeatures: {
    deterministic: Record<string, Scalar>;
    llm: {
      archetype: string | null;
      faceCountBucket: string | null;
      clutterLevel: string | null;
    };
  };
  buckets: {
    duration_bucket: "short" | "1-4m" | "4-10m" | "10-20m" | "20m+" | "unknown";
    promise_type_primary: string;
    thumbnail_archetype: string;
    hasBigText: "true" | "false" | "unknown";
    faceCountBucket: string;
  };
}

export interface CohortSummary {
  dimension: keyof FlatVideoRow["buckets"];
  bucket: string;
  n: number;
  medianResidual: NullableNumber;
  p25Residual: NullableNumber;
  p75Residual: NullableNumber;
  medianViewsPerDay: NullableNumber;
  medianEngagementRate: NullableNumber;
  topExemplars: Array<{
    videoId: string;
    title: string;
    residual: NullableNumber;
    percentile: NullableNumber;
    viewsPerDay: NullableNumber;
  }>;
}

export interface CorrelationNumericDriver {
  kind: "numeric";
  feature: string;
  n: number;
  rho: number;
  pValueApprox: number | null;
  absEffect: number;
}

export interface CorrelationCategoricalDriver {
  kind: "categorical";
  feature: string;
  category: string;
  nCategory: number;
  nRest: number;
  medianCategoryResidual: NullableNumber;
  medianRestResidual: NullableNumber;
  deltaMedianResidual: number;
  absEffect: number;
}

export type CorrelationDriver = CorrelationNumericDriver | CorrelationCategoricalDriver;

export interface CorrelationSummary {
  numeric: CorrelationNumericDriver[];
  categorical: CorrelationCategoricalDriver[];
  topDrivers: CorrelationDriver[];
}

export interface OrchestratorExemplars {
  top_videos: FlatVideoRow[];
  bottom_videos: FlatVideoRow[];
  mid_videos: FlatVideoRow[];
}

export interface OrchestratorInputV1 {
  schemaVersion: "analysis.orchestrator_input.v1";
  generatedAt: string;
  channel: ChannelMetaInput;
  summary: {
    totalVideos: number;
    withResidual: number;
    withPercentile: number;
    warningsCount: number;
  };
  channelModel: Record<string, unknown> | null;
  cohorts: CohortSummary[];
  drivers: CorrelationDriver[];
  exemplars: OrchestratorExemplars;
  rows: FlatVideoRow[];
  warnings: string[];
}
