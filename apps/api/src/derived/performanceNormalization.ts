export interface PerformanceVideoInput {
  videoId: string;
  publishedAt: string;
  viewCount: number;
  likeCount?: number | null;
  commentCount?: number | null;
  durationSec?: number | null;
}

export interface VideoPerformanceFeatures {
  daysSincePublish: number;
  viewsPerDay: number;
  likeRate: number | null;
  commentRate: number | null;
  engagementRate: number | null;
  logViews: number;
  residual: number | null;
  percentile: number | null;
}

export interface ChannelModelSummary {
  type: "robust-linear";
  formula: string;
  coefficients: Record<string, number>;
  intercept: number;
  fit: {
    n: number;
    r2Approx: number | null;
    madResidual: number;
    notes: string[];
  };
}

export interface ComputePerformancePerVideoResult {
  perVideoMap: Record<string, VideoPerformanceFeatures>;
  modelSummary: ChannelModelSummary;
  warnings: string[];
}

interface PreparedVideoRow {
  videoId: string;
  daysSincePublish: number;
  viewsPerDay: number;
  likeRate: number | null;
  commentRate: number | null;
  engagementRate: number | null;
  logViews: number;
  logDays: number;
  logDuration: number | null;
  weekday: number;
  isShort: boolean;
}

interface PreparedRowsResult {
  rows: PreparedVideoRow[];
  invalidPublishedAtVideoIds: string[];
  missingDurationVideoIds: string[];
}

interface IrResult {
  beta: number[];
  yPred: number[];
  residuals: number[];
  converged: boolean;
  iterations: number;
}

const DAY_MS = 86_400_000;
const MIN_VIDEOS_FOR_MODEL = 5;
const HUBER_K = 1.345;
const IRLS_ITERATIONS = 20;
const IRLS_TOLERANCE = 1e-8;
const RIDGE_LAMBDA = 1e-6;
const FORMULA = "log1p(viewCount) ~ log1p(daysSincePublish) + log1p(durationSec) + weekday + isShort";

function roundTo(value: number, decimals = 6): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  return roundTo(value);
}

function toFiniteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function toDurationSeconds(value: unknown): number | null {
  const numeric = toFiniteNonNegative(value);
  if (numeric === null || numeric <= 0) {
    return null;
  }
  return numeric;
}

function safePublishedAtMs(value: string): number | null {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return ms;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function mad(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const med = median(values);
  const absoluteDeviations = values.map((value) => Math.abs(value - med));
  return median(absoluteDeviations);
}

function dot(row: number[], beta: number[]): number {
  let total = 0;
  for (let i = 0; i < row.length; i += 1) {
    total += row[i] * beta[i];
  }
  return total;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = matrix.length;
  if (n === 0 || vector.length !== n) {
    return null;
  }

  const a = matrix.map((row) => [...row]);
  const b = [...vector];
  const eps = 1e-12;

  for (let pivotIndex = 0; pivotIndex < n; pivotIndex += 1) {
    let maxRow = pivotIndex;
    let maxAbs = Math.abs(a[pivotIndex][pivotIndex]);
    for (let rowIndex = pivotIndex + 1; rowIndex < n; rowIndex += 1) {
      const candidate = Math.abs(a[rowIndex][pivotIndex]);
      if (candidate > maxAbs) {
        maxAbs = candidate;
        maxRow = rowIndex;
      }
    }

    if (maxAbs <= eps) {
      return null;
    }

    if (maxRow !== pivotIndex) {
      const tempRow = a[pivotIndex];
      a[pivotIndex] = a[maxRow];
      a[maxRow] = tempRow;

      const tempB = b[pivotIndex];
      b[pivotIndex] = b[maxRow];
      b[maxRow] = tempB;
    }

    const pivot = a[pivotIndex][pivotIndex];
    for (let rowIndex = pivotIndex + 1; rowIndex < n; rowIndex += 1) {
      const factor = a[rowIndex][pivotIndex] / pivot;
      if (!Number.isFinite(factor) || Math.abs(factor) <= eps) {
        continue;
      }

      for (let colIndex = pivotIndex; colIndex < n; colIndex += 1) {
        a[rowIndex][colIndex] -= factor * a[pivotIndex][colIndex];
      }
      b[rowIndex] -= factor * b[pivotIndex];
    }
  }

  const result = new Array<number>(n).fill(0);
  for (let rowIndex = n - 1; rowIndex >= 0; rowIndex -= 1) {
    let rhs = b[rowIndex];
    for (let colIndex = rowIndex + 1; colIndex < n; colIndex += 1) {
      rhs -= a[rowIndex][colIndex] * result[colIndex];
    }
    const denominator = a[rowIndex][rowIndex];
    if (Math.abs(denominator) <= eps) {
      return null;
    }
    result[rowIndex] = rhs / denominator;
  }

  return result;
}

function solveWeightedLeastSquares(
  x: number[][],
  y: number[],
  weights: number[],
  lambda: number
): number[] | null {
  if (x.length === 0 || x.length !== y.length || y.length !== weights.length) {
    return null;
  }

  const p = x[0].length;
  const xtwx = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xtwy = new Array<number>(p).fill(0);

  for (let i = 0; i < x.length; i += 1) {
    const w = Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 0;
    if (w <= 0) {
      continue;
    }

    const row = x[i];
    const target = y[i];
    for (let col = 0; col < p; col += 1) {
      xtwy[col] += w * row[col] * target;
      for (let col2 = 0; col2 < p; col2 += 1) {
        xtwx[col][col2] += w * row[col] * row[col2];
      }
    }
  }

  for (let col = 0; col < p; col += 1) {
    if (col === 0) {
      continue;
    }
    xtwx[col][col] += lambda;
  }

  return solveLinearSystem(xtwx, xtwy);
}

function fitRobustLinearModel(x: number[][], y: number[]): IrResult | null {
  const n = x.length;
  if (n === 0 || n !== y.length) {
    return null;
  }

  const p = x[0].length;
  const initialWeights = new Array<number>(n).fill(1);
  let beta = solveWeightedLeastSquares(x, y, initialWeights, RIDGE_LAMBDA);
  if (!beta) {
    return null;
  }

  let converged = false;
  let iterations = 0;

  for (let iter = 0; iter < IRLS_ITERATIONS; iter += 1) {
    iterations = iter + 1;
    const residuals = y.map((target, index) => target - dot(x[index], beta as number[]));
    const scaledMad = Math.max(mad(residuals) * 1.4826, 1e-6);
    const weights = residuals.map((residual) => {
      const u = Math.abs(residual) / scaledMad;
      if (u <= HUBER_K) {
        return 1;
      }
      return HUBER_K / Math.max(u, 1e-12);
    });

    const betaNext = solveWeightedLeastSquares(x, y, weights, RIDGE_LAMBDA);
    if (!betaNext) {
      return null;
    }

    let delta = 0;
    for (let col = 0; col < p; col += 1) {
      delta = Math.max(delta, Math.abs(betaNext[col] - beta[col]));
    }
    beta = betaNext;

    if (delta <= IRLS_TOLERANCE) {
      converged = true;
      break;
    }
  }

  const yPred = x.map((row) => dot(row, beta as number[]));
  const residuals = y.map((target, index) => target - yPred[index]);

  return {
    beta,
    yPred,
    residuals,
    converged,
    iterations
  };
}

function computePercentiles(values: number[]): number[] {
  const n = values.length;
  if (n === 0) {
    return [];
  }

  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => {
    if (a.value === b.value) {
      return a.index - b.index;
    }
    return a.value - b.value;
  });

  const percentiles = new Array<number>(n).fill(0);
  let cursor = 0;
  while (cursor < n) {
    let end = cursor;
    while (end + 1 < n && Math.abs(indexed[end + 1].value - indexed[cursor].value) <= 1e-12) {
      end += 1;
    }

    const startRank = cursor + 1;
    const endRank = end + 1;
    const averageRank = (startRank + endRank) / 2;
    const percentile = averageRank / n;

    for (let i = cursor; i <= end; i += 1) {
      percentiles[indexed[i].index] = percentile;
    }
    cursor = end + 1;
  }

  return percentiles.map((value) => roundTo(value));
}

function toWeekdayUtc(publishedAt: string): number {
  const date = new Date(publishedAt);
  const day = date.getUTCDay();
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return 0;
  }
  return day;
}

function prepareVideoRows(videos: PerformanceVideoInput[], nowMs: number): PreparedRowsResult {
  const invalidPublishedAtVideoIds: string[] = [];
  const missingDurationVideoIds: string[] = [];

  const rows = videos.map((video) => {
    const publishedMs = safePublishedAtMs(video.publishedAt);
    if (publishedMs === null) {
      invalidPublishedAtVideoIds.push(video.videoId);
    }

    const effectivePublished = publishedMs ?? nowMs;
    const deltaMs = nowMs - effectivePublished;
    const daysSincePublish = Math.max(1, Math.floor(Math.max(0, deltaMs) / DAY_MS));

    const viewCount = Math.max(0, toFiniteNonNegative(video.viewCount) ?? 0);
    const likeCount = toFiniteNonNegative(video.likeCount);
    const commentCount = toFiniteNonNegative(video.commentCount);
    const durationSec = toDurationSeconds(video.durationSec);

    if (video.durationSec == null || durationSec === null) {
      missingDurationVideoIds.push(video.videoId);
    }

    const denominator = Math.max(1, viewCount);
    const likeRate = likeCount === null ? null : clampRate(likeCount / denominator);
    const commentRate = commentCount === null ? null : clampRate(commentCount / denominator);

    let engagementRate: number | null = null;
    if (likeCount !== null || commentCount !== null) {
      engagementRate = clampRate(((likeCount ?? 0) + (commentCount ?? 0)) / denominator);
    }

    return {
      videoId: video.videoId,
      daysSincePublish,
      viewsPerDay: roundTo(viewCount / daysSincePublish),
      likeRate,
      commentRate,
      engagementRate,
      logViews: roundTo(Math.log1p(viewCount)),
      logDays: Math.log1p(daysSincePublish),
      logDuration: durationSec === null ? null : Math.log1p(durationSec),
      weekday: toWeekdayUtc(video.publishedAt),
      isShort: durationSec !== null && durationSec <= 60
    };
  });

  return {
    rows,
    invalidPublishedAtVideoIds,
    missingDurationVideoIds
  };
}

function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings));
}

function buildDesignMatrix(rows: PreparedVideoRow[]): {
  x: number[][];
  y: number[];
  predictorNames: string[];
  includesDurationTerm: boolean;
} {
  const includesDurationTerm = rows.some((row) => row.logDuration !== null);
  const predictorNames = ["logDaysSincePublish"];
  if (includesDurationTerm) {
    predictorNames.push("logDurationSec");
  }
  predictorNames.push("weekday_1", "weekday_2", "weekday_3", "weekday_4", "weekday_5", "weekday_6", "isShort");

  const x = rows.map((row) => {
    const features: number[] = [1, row.logDays];
    if (includesDurationTerm) {
      features.push(row.logDuration ?? 0);
    }

    for (let weekday = 1; weekday <= 6; weekday += 1) {
      features.push(row.weekday === weekday ? 1 : 0);
    }
    features.push(row.isShort ? 1 : 0);
    return features;
  });

  const y = rows.map((row) => row.logViews);
  return { x, y, predictorNames, includesDurationTerm };
}

function buildModelSummary(args: {
  n: number;
  predictorNames: string[];
  beta: number[] | null;
  residuals: number[];
  y: number[];
  notes: string[];
}): ChannelModelSummary {
  const coefficients: Record<string, number> = {};
  let intercept = 0;

  if (args.beta && args.beta.length > 0) {
    intercept = roundTo(args.beta[0]);
    for (let i = 0; i < args.predictorNames.length; i += 1) {
      coefficients[args.predictorNames[i]] = roundTo(args.beta[i + 1] ?? 0);
    }
  }

  let r2Approx: number | null = null;
  if (args.beta && args.y.length > 0 && args.residuals.length === args.y.length) {
    const meanY = args.y.reduce((acc, value) => acc + value, 0) / args.y.length;
    let sst = 0;
    let sse = 0;
    for (let i = 0; i < args.y.length; i += 1) {
      const centered = args.y[i] - meanY;
      sst += centered * centered;
      sse += args.residuals[i] * args.residuals[i];
    }
    if (sst > 1e-12) {
      r2Approx = roundTo(1 - sse / sst);
    }
  }

  return {
    type: "robust-linear",
    formula: FORMULA,
    coefficients,
    intercept,
    fit: {
      n: args.n,
      r2Approx,
      madResidual: roundTo(mad(args.residuals)),
      notes: [...args.notes]
    }
  };
}

export function computePerformancePerVideo(
  videos: PerformanceVideoInput[],
  nowDateISO: string
): ComputePerformancePerVideoResult {
  const warnings: string[] = [];
  const nowMs = new Date(nowDateISO).getTime();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : 0;
  if (!Number.isFinite(nowMs)) {
    warnings.push("Invalid nowDateISO received; unix epoch used as deterministic fallback");
  }

  const preparedRows = prepareVideoRows(videos, safeNowMs);
  const rows = preparedRows.rows;
  if (preparedRows.invalidPublishedAtVideoIds.length > 0) {
    warnings.push(
      `Invalid publishedAt detected for ${preparedRows.invalidPublishedAtVideoIds.length} videos; daysSincePublish set to 1`
    );
  }
  if (preparedRows.missingDurationVideoIds.length > 0) {
    warnings.push(
      `Missing or invalid durationSec for ${preparedRows.missingDurationVideoIds.length} videos; isShort=false and duration term omitted`
    );
  }
  const perVideoMap: Record<string, VideoPerformanceFeatures> = {};
  for (const row of rows) {
    perVideoMap[row.videoId] = {
      daysSincePublish: row.daysSincePublish,
      viewsPerDay: row.viewsPerDay,
      likeRate: row.likeRate,
      commentRate: row.commentRate,
      engagementRate: row.engagementRate,
      logViews: row.logViews,
      residual: null,
      percentile: null
    };
  }

  if (rows.length < MIN_VIDEOS_FOR_MODEL) {
    const thresholdWarning = `Performance model skipped: requires at least ${MIN_VIDEOS_FOR_MODEL} videos, received ${rows.length}`;
    warnings.push(thresholdWarning);
    const modelSummary = buildModelSummary({
      n: rows.length,
      predictorNames: [],
      beta: null,
      residuals: [],
      y: [],
      notes: [thresholdWarning]
    });
    return {
      perVideoMap,
      modelSummary,
      warnings: dedupeWarnings(warnings)
    };
  }

  const { x, y, predictorNames, includesDurationTerm } = buildDesignMatrix(rows);
  if (!includesDurationTerm) {
    warnings.push("All videos are missing durationSec; duration predictor excluded from model");
  } else if (rows.some((row) => row.logDuration === null)) {
    warnings.push("Some videos are missing durationSec; duration term imputed as 0 for those rows");
  }

  const robustFit = fitRobustLinearModel(x, y);
  if (!robustFit) {
    const fitWarning = "Performance model fit failed due to numerical instability";
    warnings.push(fitWarning);
    const modelSummary = buildModelSummary({
      n: rows.length,
      predictorNames,
      beta: null,
      residuals: [],
      y,
      notes: [fitWarning]
    });
    return {
      perVideoMap,
      modelSummary,
      warnings: dedupeWarnings(warnings)
    };
  }

  const percentiles = computePercentiles(robustFit.residuals);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    perVideoMap[row.videoId] = {
      ...perVideoMap[row.videoId],
      residual: roundTo(robustFit.residuals[i]),
      percentile: percentiles[i]
    };
  }

  const notes: string[] = [];
  if (robustFit.converged) {
    notes.push(`IRLS converged in ${robustFit.iterations} iterations`);
  } else {
    notes.push(`IRLS reached max iterations (${IRLS_ITERATIONS}) without strict convergence`);
  }

  for (const warning of warnings) {
    notes.push(warning);
  }

  const modelSummary = buildModelSummary({
    n: rows.length,
    predictorNames,
    beta: robustFit.beta,
    residuals: robustFit.residuals,
    y,
    notes: dedupeWarnings(notes)
  });

  return {
    perVideoMap,
    modelSummary,
    warnings: dedupeWarnings(warnings)
  };
}
