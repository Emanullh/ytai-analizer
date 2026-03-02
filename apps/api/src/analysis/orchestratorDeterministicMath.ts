import type { FlatVideoRow } from "./orchestratorDeterministicTypes.js";

export function percentile(values: number[], p: number): number | null {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, p));
  const rank = (sorted.length - 1) * clamped;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) {
    return Number(sorted[lo].toFixed(6));
  }
  const w = rank - lo;
  return Number((sorted[lo] * (1 - w) + sorted[hi] * w).toFixed(6));
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5);
}

export function durationBucket(
  durationSec: number | null
): FlatVideoRow["buckets"]["duration_bucket"] {
  if (durationSec === null || durationSec < 0) {
    return "unknown";
  }
  if (durationSec <= 60) {
    return "short";
  }
  if (durationSec <= 240) {
    return "1-4m";
  }
  if (durationSec <= 600) {
    return "4-10m";
  }
  if (durationSec <= 1_200) {
    return "10-20m";
  }
  return "20m+";
}

function rankWithTies(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array<number>(values.length).fill(0);

  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) {
      j += 1;
    }
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k += 1) {
      ranks[indexed[k].index] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

export function spearmanRho(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) {
    return null;
  }
  const rx = rankWithTies(x);
  const ry = rankWithTies(y);
  const meanRx = rx.reduce((acc, value) => acc + value, 0) / rx.length;
  const meanRy = ry.reduce((acc, value) => acc + value, 0) / ry.length;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < rx.length; i += 1) {
    const dx = rx[i] - meanRx;
    const dy = ry[i] - meanRy;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX <= 0 || denomY <= 0) {
    return null;
  }
  return Number((numerator / Math.sqrt(denomX * denomY)).toFixed(6));
}

function toRankScore(row: FlatVideoRow): number | null {
  if (row.performance.percentile !== null) {
    return row.performance.percentile;
  }
  if (row.performance.residual !== null) {
    return row.performance.residual;
  }
  return row.performance.viewsPerDay;
}

export function rankedRows(rows: FlatVideoRow[], descending: boolean): FlatVideoRow[] {
  return [...rows].sort((a, b) => {
    const aScore = toRankScore(a);
    const bScore = toRankScore(b);
    const aValue = aScore ?? Number.NEGATIVE_INFINITY;
    const bValue = bScore ?? Number.NEGATIVE_INFINITY;
    if (aValue === bValue) {
      return a.videoId.localeCompare(b.videoId);
    }
    return descending ? bValue - aValue : aValue - bValue;
  });
}
