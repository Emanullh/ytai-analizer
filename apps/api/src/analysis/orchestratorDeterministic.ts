import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ChannelMetaInput,
  CohortSummary,
  CorrelationCategoricalDriver,
  CorrelationDriver,
  CorrelationNumericDriver,
  CorrelationSummary,
  FlatVideoRow,
  OrchestratorExemplars,
  OrchestratorInputV1
} from "./orchestratorDeterministicTypes.js";
import { durationBucket, median, percentile, rankedRows, spearmanRho } from "./orchestratorDeterministicMath.js";

type Scalar = string | number | boolean | null;

export type {
  ChannelMetaInput,
  CohortSummary,
  CorrelationCategoricalDriver,
  CorrelationDriver,
  CorrelationNumericDriver,
  CorrelationSummary,
  FlatVideoRow,
  OrchestratorExemplars,
  OrchestratorInputV1
} from "./orchestratorDeterministicTypes.js";

interface RawVideoFeaturesArtifact {
  videoId?: unknown;
  performance?: Record<string, unknown>;
  titleFeatures?: Record<string, unknown>;
  descriptionFeatures?: Record<string, unknown>;
  transcriptFeatures?: Record<string, unknown>;
  thumbnailFeatures?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RawChannelModelsArtifact {
  schemaVersion?: unknown;
  model?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RawVideoJsonlRecord {
  videoId?: unknown;
  title?: unknown;
  publishedAt?: unknown;
  durationSec?: unknown;
  description?: unknown;
}

interface ChannelJsonVideoRecord {
  videoId?: unknown;
  title?: unknown;
  publishedAt?: unknown;
}

interface ChannelJsonArtifact {
  videos?: unknown;
}

interface LoadedDerivedFeatures {
  videoFeatures: RawVideoFeaturesArtifact[];
  channelModel: RawChannelModelsArtifact | null;
  rawVideosById: Map<string, RawVideoJsonlRecord>;
  channelVideosById: Map<string, ChannelJsonVideoRecord>;
  warnings: string[];
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toScalarRecord(value: unknown): Record<string, Scalar> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const out: Record<string, Scalar> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean" || nested === null) {
      out[key] = nested;
    }
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toTopPromiseType(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  let topLabel: string | null = null;
  let topScore = Number.NEGATIVE_INFINITY;
  for (const item of value) {
    if (!isObject(item)) {
      continue;
    }
    const label = toStringOrNull(item.label);
    const score = toFiniteNumber(item.score) ?? 0;
    if (label && score > topScore) {
      topScore = score;
      topLabel = label;
    }
  }
  return topLabel;
}

function traverseScalars(obj: Record<string, unknown>, prefix: string, acc: Map<string, Scalar>): void {
  for (const [key, value] of Object.entries(obj)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      acc.set(nextPath, value);
      continue;
    }
    if (isObject(value)) {
      traverseScalars(value, nextPath, acc);
    }
  }
}

export async function loadDerivedFeatures(exportPath: string): Promise<LoadedDerivedFeatures> {
  const warnings: string[] = [];
  const derivedFeaturesPath = path.resolve(exportPath, "derived", "video_features");
  const channelModelsPath = path.resolve(exportPath, "derived", "channel_models.json");
  const rawVideosPath = path.resolve(exportPath, "raw", "videos.jsonl");
  const channelJsonPath = path.resolve(exportPath, "channel.json");

  const entries = await fs.readdir(derivedFeaturesPath, { withFileTypes: true }).catch(() => []);
  const videoFeatures = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const absolute = path.resolve(derivedFeaturesPath, entry.name);
          try {
            return JSON.parse(await fs.readFile(absolute, "utf-8")) as RawVideoFeaturesArtifact;
          } catch {
            warnings.push(`Invalid JSON skipped in derived/video_features: ${entry.name}`);
            return null;
          }
        })
    )
  ).filter((item): item is RawVideoFeaturesArtifact => item !== null);

  const channelModel = await fs
    .readFile(channelModelsPath, "utf-8")
    .then((raw) => JSON.parse(raw) as RawChannelModelsArtifact)
    .catch(() => null);
  if (!channelModel) {
    warnings.push("Missing or invalid derived/channel_models.json");
  }

  const rawVideosById = new Map<string, RawVideoJsonlRecord>();
  const rawVideosContent = await fs.readFile(rawVideosPath, "utf-8").catch(() => "");
  if (rawVideosContent.trim()) {
    for (const line of rawVideosContent.split("\n").map((item) => item.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as RawVideoJsonlRecord;
        const videoId = toStringOrNull(parsed.videoId);
        if (videoId) {
          rawVideosById.set(videoId, parsed);
        }
      } catch {
        warnings.push("Invalid line skipped in raw/videos.jsonl");
      }
    }
  }

  const channelVideosById = new Map<string, ChannelJsonVideoRecord>();
  const channelJson = await fs
    .readFile(channelJsonPath, "utf-8")
    .then((raw) => JSON.parse(raw) as ChannelJsonArtifact)
    .catch(() => null);
  if (channelJson && Array.isArray(channelJson.videos)) {
    for (const rawVideo of channelJson.videos) {
      if (!isObject(rawVideo)) {
        continue;
      }
      const videoId = toStringOrNull(rawVideo.videoId);
      if (videoId) {
        channelVideosById.set(videoId, rawVideo as ChannelJsonVideoRecord);
      }
    }
  }

  return { videoFeatures, channelModel, rawVideosById, channelVideosById, warnings };
}

export function buildFlatRows(data: LoadedDerivedFeatures): FlatVideoRow[] {
  const rows: FlatVideoRow[] = [];
  for (const feature of data.videoFeatures) {
    const videoId = toStringOrNull(feature.videoId);
    if (!videoId) {
      continue;
    }
    const rawVideo = data.rawVideosById.get(videoId);
    const channelVideo = data.channelVideosById.get(videoId);
    const performance = isObject(feature.performance) ? feature.performance : {};

    const titleFeatures = isObject(feature.titleFeatures) ? feature.titleFeatures : {};
    const titleDet = toScalarRecord((titleFeatures as { deterministic?: unknown }).deterministic);
    const titleLlm = isObject((titleFeatures as { llm?: unknown }).llm) ? (titleFeatures as { llm?: Record<string, unknown> }).llm : null;

    const descriptionFeatures = isObject(feature.descriptionFeatures) ? feature.descriptionFeatures : {};
    const transcriptFeatures = isObject(feature.transcriptFeatures) ? feature.transcriptFeatures : {};
    const thumbnailFeatures = isObject(feature.thumbnailFeatures) ? feature.thumbnailFeatures : {};
    const thumbnailLlm = isObject((thumbnailFeatures as { llm?: unknown }).llm)
      ? ((thumbnailFeatures as { llm?: Record<string, unknown> }).llm ?? null)
      : null;

    const hasBigTextValue = toScalarRecord((thumbnailFeatures as { deterministic?: unknown }).deterministic).hasBigText;
    const row: FlatVideoRow = {
      videoId,
      title: toStringOrNull(rawVideo?.title) ?? toStringOrNull(channelVideo?.title) ?? "",
      publishedAt: toStringOrNull(rawVideo?.publishedAt) ?? toStringOrNull(channelVideo?.publishedAt) ?? "",
      durationSec: toFiniteNumber(rawVideo?.durationSec),
      description: toStringOrNull(rawVideo?.description),
      performance: {
        viewsPerDay: toFiniteNumber(performance.viewsPerDay),
        engagementRate: toFiniteNumber(performance.engagementRate),
        residual: toFiniteNumber(performance.residual),
        percentile: toFiniteNumber(performance.percentile)
      },
      titleFeatures: {
        deterministic: titleDet,
        llm: {
          promiseTypePrimary: toTopPromiseType(titleLlm?.promise_type)
        }
      },
      descriptionFeatures: {
        deterministic: toScalarRecord((descriptionFeatures as { deterministic?: unknown }).deterministic)
      },
      transcriptFeatures: {
        deterministic: toScalarRecord((transcriptFeatures as { deterministic?: unknown }).deterministic)
      },
      thumbnailFeatures: {
        deterministic: toScalarRecord((thumbnailFeatures as { deterministic?: unknown }).deterministic),
        llm: {
          archetype: toStringOrNull((thumbnailLlm?.archetype as { label?: unknown } | undefined)?.label),
          faceCountBucket: toStringOrNull((thumbnailLlm?.faceSignals as { faceCountBucket?: unknown } | undefined)?.faceCountBucket),
          clutterLevel: toStringOrNull((thumbnailLlm?.clutterLevel as { label?: unknown } | undefined)?.label)
        }
      },
      buckets: {
        duration_bucket: durationBucket(toFiniteNumber(rawVideo?.durationSec)),
        promise_type_primary: toTopPromiseType(titleLlm?.promise_type) ?? "unknown",
        thumbnail_archetype: toStringOrNull((thumbnailLlm?.archetype as { label?: unknown } | undefined)?.label) ?? "unknown",
        hasBigText:
          typeof hasBigTextValue === "boolean" ? (hasBigTextValue ? "true" : "false") : "unknown",
        faceCountBucket:
          toStringOrNull((thumbnailLlm?.faceSignals as { faceCountBucket?: unknown } | undefined)?.faceCountBucket) ??
          "unknown"
      }
    };
    rows.push(row);
  }
  return rows;
}

export function computeCohorts(rows: FlatVideoRow[]): CohortSummary[] {
  const dimensions: Array<keyof FlatVideoRow["buckets"]> = [
    "duration_bucket",
    "promise_type_primary",
    "thumbnail_archetype",
    "hasBigText",
    "faceCountBucket"
  ];
  const cohorts: CohortSummary[] = [];
  for (const dimension of dimensions) {
    const grouped = new Map<string, FlatVideoRow[]>();
    for (const row of rows) {
      const bucket = row.buckets[dimension] ?? "unknown";
      const existing = grouped.get(bucket) ?? [];
      existing.push(row);
      grouped.set(bucket, existing);
    }
    for (const [bucket, bucketRows] of grouped.entries()) {
      const residuals = bucketRows.map((row) => row.performance.residual).filter((v): v is number => v !== null);
      const viewsPerDay = bucketRows.map((row) => row.performance.viewsPerDay).filter((v): v is number => v !== null);
      const engagement = bucketRows.map((row) => row.performance.engagementRate).filter((v): v is number => v !== null);
      const topExemplars = rankedRows(bucketRows, true).slice(0, 3).map((row) => ({
        videoId: row.videoId,
        title: row.title,
        residual: row.performance.residual,
        percentile: row.performance.percentile,
        viewsPerDay: row.performance.viewsPerDay
      }));
      cohorts.push({
        dimension,
        bucket,
        n: bucketRows.length,
        medianResidual: median(residuals),
        p25Residual: percentile(residuals, 0.25),
        p75Residual: percentile(residuals, 0.75),
        medianViewsPerDay: median(viewsPerDay),
        medianEngagementRate: median(engagement),
        topExemplars
      });
    }
  }
  return cohorts.sort((a, b) => a.dimension.localeCompare(b.dimension) || b.n - a.n || a.bucket.localeCompare(b.bucket));
}

export function computeCorrelations(rows: FlatVideoRow[]): CorrelationSummary {
  const targets = rows.map((row) => row.performance.residual);
  const baseRows = rows.filter((_, index) => targets[index] !== null);
  const numeric: CorrelationNumericDriver[] = [];
  const categorical: CorrelationCategoricalDriver[] = [];

  if (!baseRows.length) {
    return { numeric, categorical, topDrivers: [] };
  }

  const featureMatrix = baseRows.map((row) => {
    const map = new Map<string, Scalar>();
    traverseScalars(row as unknown as Record<string, unknown>, "", map);
    map.delete("performance.residual");
    return map;
  });
  const features = new Set<string>();
  for (const rowFeatures of featureMatrix) {
    for (const key of rowFeatures.keys()) {
      features.add(key);
    }
  }

  const residuals = baseRows.map((row) => row.performance.residual as number);
  for (const feature of features) {
    const numericPairs: Array<{ x: number; y: number }> = [];
    const byCategory = new Map<string, number[]>();
    const restPool: number[] = [];
    for (let i = 0; i < baseRows.length; i += 1) {
      const value = featureMatrix[i].get(feature);
      const target = residuals[i];
      if (typeof value === "number" && Number.isFinite(value)) {
        numericPairs.push({ x: value, y: target });
        continue;
      }
      if (typeof value === "string" || typeof value === "boolean") {
        const key = String(value);
        const entries = byCategory.get(key) ?? [];
        entries.push(target);
        byCategory.set(key, entries);
        continue;
      }
      restPool.push(target);
    }

    if (numericPairs.length >= 8) {
      const rho = spearmanRho(
        numericPairs.map((item) => item.x),
        numericPairs.map((item) => item.y)
      );
      if (rho !== null) {
        numeric.push({
          kind: "numeric",
          feature,
          n: numericPairs.length,
          rho,
          pValueApprox: null,
          absEffect: Math.abs(rho)
        });
      }
    }

    for (const [category, categoryResiduals] of byCategory.entries()) {
      const nCategory = categoryResiduals.length;
      const nRest = residuals.length - nCategory;
      if (nCategory < 4 || nRest < 4) {
        continue;
      }
      const restResiduals = residuals.filter((value, index) => {
        const sourceValue = featureMatrix[index].get(feature);
        return String(sourceValue) !== category;
      });
      const categoryMedian = median(categoryResiduals);
      const restMedian = median(restResiduals);
      if (categoryMedian === null || restMedian === null) {
        continue;
      }
      const delta = Number((categoryMedian - restMedian).toFixed(6));
      categorical.push({
        kind: "categorical",
        feature,
        category,
        nCategory,
        nRest,
        medianCategoryResidual: categoryMedian,
        medianRestResidual: restMedian,
        deltaMedianResidual: delta,
        absEffect: Math.abs(delta)
      });
    }
  }

  const topDrivers = [...numeric, ...categorical]
    .sort((a, b) => b.absEffect - a.absEffect)
    .slice(0, 10);

  return {
    numeric: numeric.sort((a, b) => b.absEffect - a.absEffect),
    categorical: categorical.sort((a, b) => b.absEffect - a.absEffect),
    topDrivers
  };
}

export function buildOrchestratorInput(input: {
  channelMeta: ChannelMetaInput;
  rows: FlatVideoRow[];
  cohorts: CohortSummary[];
  drivers: CorrelationDriver[];
  exemplars: OrchestratorExemplars;
  channelModel: RawChannelModelsArtifact | null;
  warnings: string[];
}): OrchestratorInputV1 {
  const withResidual = input.rows.filter((row) => row.performance.residual !== null).length;
  const withPercentile = input.rows.filter((row) => row.performance.percentile !== null).length;

  return {
    schemaVersion: "analysis.orchestrator_input.v1",
    generatedAt: new Date().toISOString(),
    channel: input.channelMeta,
    summary: {
      totalVideos: input.rows.length,
      withResidual,
      withPercentile,
      warningsCount: input.warnings.length
    },
    channelModel: input.channelModel,
    cohorts: input.cohorts,
    drivers: input.drivers,
    exemplars: input.exemplars,
    rows: input.rows,
    warnings: input.warnings
  };
}

function pickMidVideos(rows: FlatVideoRow[]): FlatVideoRow[] {
  const ranked = rankedRows(rows, false);
  if (!ranked.length) {
    return [];
  }
  const center = Math.floor(ranked.length / 2);
  const start = Math.max(0, center - 2);
  return ranked.slice(start, start + 5);
}

export async function buildDeterministicOrchestratorInput(input: {
  exportPath: string;
  channelMeta: ChannelMetaInput;
}): Promise<{ orchestratorInput: OrchestratorInputV1; warnings: string[] }> {
  const loaded = await loadDerivedFeatures(input.exportPath);
  const rows = buildFlatRows(loaded);
  const cohorts = computeCohorts(rows);
  const correlations = computeCorrelations(rows);
  const exemplars: OrchestratorExemplars = {
    top_videos: rankedRows(rows, true).slice(0, 10),
    bottom_videos: rankedRows(rows, false).slice(0, 5),
    mid_videos: pickMidVideos(rows)
  };
  const warnings = [...loaded.warnings];
  if (!rows.length) {
    warnings.push("No rows found in derived/video_features for orchestrator input");
  }
  const orchestratorInput = buildOrchestratorInput({
    channelMeta: input.channelMeta,
    rows,
    cohorts,
    drivers: correlations.topDrivers,
    exemplars,
    channelModel: loaded.channelModel,
    warnings
  });
  return { orchestratorInput, warnings };
}
