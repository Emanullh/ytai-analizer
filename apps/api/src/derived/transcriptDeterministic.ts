import { env } from "../config/env.js";
import type { TranscriptArtifact, TranscriptArtifactSegment } from "./transcriptArtifacts.js";
import stopwordsAsset from "./assets/transcript-stopwords.json" with { type: "json" };
import sentimentLexiconAsset from "./assets/transcript-sentiment-lexicon.json" with { type: "json" };
import emotionsAsset from "./assets/transcript-emotions.json" with { type: "json" };

const EARLY_WINDOW_CHAR_LIMIT = 800;
const TOPIC_WINDOW_SEC = 20;
const TOPIC_WORD_CHUNK_SIZE = 120;
const TOPIC_SHIFT_DISTANCE_THRESHOLD = 0.22;

const STOPWORDS = new Set<string>(
  [...(stopwordsAsset.en ?? []), ...(stopwordsAsset.es ?? [])].map((token) => normalizeForLexicon(token))
);

const SENTIMENT_LEXICON = new Map<string, number>(
  Object.entries(sentimentLexiconAsset).map(([token, score]) => [normalizeForLexicon(token), Number(score)])
);

const EMOTION_WORDS = {
  joy: new Set((emotionsAsset.joy ?? []).map((token) => normalizeForLexicon(token))),
  sadness: new Set((emotionsAsset.sadness ?? []).map((token) => normalizeForLexicon(token))),
  anger: new Set((emotionsAsset.anger ?? []).map((token) => normalizeForLexicon(token))),
  fear: new Set((emotionsAsset.fear ?? []).map((token) => normalizeForLexicon(token))),
  surprise: new Set((emotionsAsset.surprise ?? []).map((token) => normalizeForLexicon(token)))
} as const;

const STEP_MARKER_PATTERNS = [
  /\bstep\s*\d+\b/giu,
  /\bpaso\s*\d+\b/giu,
  /\bprimero\b/giu,
  /\bsegundo\b/giu,
  /\bluego\b/giu,
  /\bpor\s+ultimo\b/giu,
  /\bpor\s+último\b/giu
];

const LIST_MARKER_PATTERNS = [
  /\btop\s*\d+\b/giu,
  /\b\d+\s+things\b/giu,
  /\b\d+\s+reasons\b/giu,
  /\b\d+\s+tips\b/giu,
  /\brazones\b/giu,
  /\blista\b/giu
];

const CONTRAST_MARKER_PATTERNS = [
  /\bbut\b/giu,
  /\bhowever\b/giu,
  /\balthough\b/giu,
  /\bsin\s+embargo\b/giu,
  /\baunque\b/giu,
  /\bpero\b/giu
];

const STORY_MARKER_PATTERNS = [
  /\bwhen\b/giu,
  /\bthen\b/giu,
  /\bfinally\b/giu,
  /\bal\s+final\b/giu,
  /\bentonces\b/giu,
  /\bdespues\b/giu,
  /\bdespués\b/giu
];

type EarlyWindowMode = "timestamp_window_0_30s" | "leading_chars_fallback";
type EmotionLabel = keyof typeof EMOTION_WORDS;

export interface TranscriptMarkerEvidence {
  segmentIndex: number;
  match: string;
  snippet: string;
}

export interface TranscriptEmotionPeak {
  emotion: EmotionLabel;
  segmentIndex: number;
  snippet: string;
  score: number;
}

export interface TopicShiftEvidence {
  fromWindow: number;
  toWindow: number;
  distance: number;
}

export interface TranscriptDeterministicFeatures {
  hook_keyword_hit_time_sec: number | null;
  hook_keyword_hit_evidence: {
    matchedToken: string;
    segmentIndex: number;
    snippet: string;
  } | null;
  title_keyword_coverage: number;
  title_keyword_coverage_evidence: {
    titleTokens: string[];
    hitTokens: string[];
  };
  title_keyword_early_coverage_30s: number;
  title_keyword_early_coverage_30s_evidence: {
    titleTokens: string[];
    hitTokens: string[];
    mode: EarlyWindowMode;
    charLimit: number | null;
  };
  promise_delivery_30s_score: number | null;
  wpm_overall: number | null;
  wpm_0_30: number | null;
  wpm_30_120: number | null;
  wpm_last_30: number | null;
  wpm_variance: number | null;
  segment_length_stats: {
    chars: { median: number | null; p90: number | null };
    words: { median: number | null; p90: number | null };
  };
  silence_gap_stats: {
    mean: number | null;
    p90: number | null;
    max: number | null;
  };
  step_markers_count: number;
  list_markers_count: number;
  contrast_markers_count: number;
  story_markers_count: number;
  marker_evidence: {
    step_topMatches: TranscriptMarkerEvidence[];
    list_topMatches: TranscriptMarkerEvidence[];
    contrast_topMatches: TranscriptMarkerEvidence[];
    story_topMatches: TranscriptMarkerEvidence[];
  };
  sentiment_mean: number | null;
  sentiment_std: number | null;
  sentiment_trend: number | null;
  emotion_peaks: TranscriptEmotionPeak[];
  topic_shift_count: number | null;
  topic_shift_evidence: TopicShiftEvidence[];
  topic_shift_windowing: "timestamp_20s" | "word_chunks_120" | null;
}

export interface ComputeTranscriptDeterministicFeaturesArgs {
  title: string;
  transcriptArtifact: TranscriptArtifact;
  durationSec?: number;
  publishedAt?: string;
  nowISO?: string;
}

export interface ComputeTranscriptDeterministicFeaturesResult {
  features: TranscriptDeterministicFeatures;
  warnings: string[];
}

interface NormalizedSegment {
  i: number;
  text: string;
  startSec: number | null;
  endSec: number | null;
  words: string[];
}

interface EarlyWindow {
  text: string;
  mode: EarlyWindowMode;
  charLimit: number | null;
}

interface MarkerCountResult {
  count: number;
  topMatches: TranscriptMarkerEvidence[];
}

interface TopicWindow {
  index: number;
  text: string;
}

function normalizeForLexicon(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function tokenize(raw: string): string[] {
  const normalized = normalizeForLexicon(raw);
  const matches = normalized.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.filter(Boolean) : [];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(value.toFixed(6));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function extractImportantTitleTokens(title: string): string[] {
  const deduped = new Set<string>();
  for (const token of tokenize(title)) {
    if (token.length < 3) {
      continue;
    }
    if (STOPWORDS.has(token)) {
      continue;
    }
    deduped.add(token);
  }
  return Array.from(deduped);
}

function normalizeSegments(segments: TranscriptArtifactSegment[]): NormalizedSegment[] {
  return segments
    .map((segment) => {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) {
        return null;
      }

      return {
        i: segment.i,
        text,
        startSec: toFiniteNumber(segment.startSec),
        endSec: toFiniteNumber(segment.endSec),
        words: tokenize(text)
      } satisfies NormalizedSegment;
    })
    .filter((segment): segment is NormalizedSegment => segment !== null)
    .sort((a, b) => {
      const aOrder = a.startSec ?? a.endSec ?? Number.POSITIVE_INFINITY;
      const bOrder = b.startSec ?? b.endSec ?? Number.POSITIVE_INFINITY;
      if (aOrder === bOrder) {
        return a.i - b.i;
      }
      return aOrder - bOrder;
    });
}

function getAllTranscriptText(segments: NormalizedSegment[]): string {
  return segments.map((segment) => segment.text).join(" ").trim();
}

function hasTimestamps(segments: NormalizedSegment[]): boolean {
  return segments.some((segment) => segment.startSec !== null || segment.endSec !== null);
}

function getEarlyWindowText(segments: NormalizedSegment[], transcriptText: string): EarlyWindow {
  if (hasTimestamps(segments)) {
    const text = segments
      .filter((segment) => {
        if (segment.startSec !== null) {
          return segment.startSec < 30;
        }
        return segment.endSec !== null && segment.endSec <= 30;
      })
      .map((segment) => segment.text)
      .join(" ")
      .trim();

    return {
      text,
      mode: "timestamp_window_0_30s",
      charLimit: null
    };
  }

  return {
    text: transcriptText.slice(0, EARLY_WINDOW_CHAR_LIMIT),
    mode: "leading_chars_fallback",
    charLimit: EARLY_WINDOW_CHAR_LIMIT
  };
}

function buildTitleKeywordCoverage(titleTokens: string[], text: string): { ratio: number; hitTokens: string[] } {
  if (titleTokens.length === 0) {
    return { ratio: 0, hitTokens: [] };
  }

  const tokenSet = new Set(tokenize(text));
  const hitTokens = titleTokens.filter((token) => tokenSet.has(token));
  return {
    ratio: clamp01(hitTokens.length / titleTokens.length),
    hitTokens
  };
}

function findSnippetForToken(text: string, token: string): string {
  const lowerText = text.toLowerCase();
  const lowerToken = token.toLowerCase();
  const index = lowerText.indexOf(lowerToken);
  if (index < 0) {
    return text.slice(0, 120);
  }

  const start = Math.max(0, index - 35);
  const end = Math.min(text.length, index + token.length + 35);
  return text.slice(start, end).trim();
}

function getFirstTitleTokenHit(
  segments: NormalizedSegment[],
  titleTokens: string[]
): { matchedToken: string; segmentIndex: number; snippet: string; startSec: number | null } | null {
  if (titleTokens.length === 0) {
    return null;
  }

  for (const segment of segments) {
    const segmentTokenSet = new Set(segment.words);
    for (const token of titleTokens) {
      if (!segmentTokenSet.has(token)) {
        continue;
      }

      return {
        matchedToken: token,
        segmentIndex: segment.i,
        snippet: findSnippetForToken(segment.text, token),
        startSec: segment.startSec
      };
    }
  }

  return null;
}

function percentile(values: number[], targetPercentile: number): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const clampedPercentile = Math.max(0, Math.min(1, targetPercentile));
  const rank = (sorted.length - 1) * clampedPercentile;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);

  if (lower === upper) {
    return roundMetric(sorted[lower]);
  }

  const weight = rank - lower;
  return roundMetric(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return roundMetric(values.reduce((acc, value) => acc + value, 0) / values.length);
}

function variance(values: number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const avg = values.reduce((acc, value) => acc + value, 0) / values.length;
  const sq = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length;
  return roundMetric(sq);
}

function std(values: number[]): number | null {
  const varValue = variance(values);
  if (varValue === null) {
    return null;
  }
  return roundMetric(Math.sqrt(varValue));
}

function linearSlope(points: Array<{ x: number; y: number }>): number | null {
  if (points.length < 2) {
    return null;
  }

  const avgX = points.reduce((acc, point) => acc + point.x, 0) / points.length;
  const avgY = points.reduce((acc, point) => acc + point.y, 0) / points.length;

  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    numerator += (point.x - avgX) * (point.y - avgY);
    denominator += (point.x - avgX) ** 2;
  }

  if (denominator <= 0) {
    return null;
  }

  return roundMetric(numerator / denominator);
}

function estimateDurationSec(segments: NormalizedSegment[], explicitDurationSec?: number): number | null {
  if (typeof explicitDurationSec === "number" && Number.isFinite(explicitDurationSec) && explicitDurationSec > 0) {
    return explicitDurationSec;
  }

  let maxEnd = 0;
  for (const segment of segments) {
    if (segment.endSec !== null) {
      maxEnd = Math.max(maxEnd, segment.endSec);
    }
  }

  return maxEnd > 0 ? maxEnd : null;
}

function getSegmentAnchorSec(segment: NormalizedSegment): number | null {
  if (segment.startSec !== null) {
    return segment.startSec;
  }
  if (segment.endSec !== null) {
    return segment.endSec;
  }
  return null;
}

function computeWpmFromWindow(
  segments: NormalizedSegment[],
  range: { start: number; end: number }
): number | null {
  if (range.end <= range.start) {
    return null;
  }

  let words = 0;
  for (const segment of segments) {
    const anchor = getSegmentAnchorSec(segment);
    if (anchor === null) {
      continue;
    }
    if (anchor >= range.start && anchor < range.end) {
      words += segment.words.length;
    }
  }

  const minutes = (range.end - range.start) / 60;
  if (minutes <= 0) {
    return null;
  }

  return roundMetric(words / minutes);
}

function markerRegexes(patterns: RegExp[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern.source, "giu"));
}

function collectMarkerCount(segments: NormalizedSegment[], patterns: RegExp[]): MarkerCountResult {
  let count = 0;
  const matches: TranscriptMarkerEvidence[] = [];

  for (const segment of segments) {
    for (const regex of markerRegexes(patterns)) {
      for (const match of segment.text.matchAll(regex)) {
        const value = match[0] ?? "";
        const index = match.index ?? -1;
        if (!value || index < 0) {
          continue;
        }
        count += 1;

        const start = Math.max(0, index - 30);
        const end = Math.min(segment.text.length, index + value.length + 30);
        matches.push({
          segmentIndex: segment.i,
          match: value,
          snippet: segment.text.slice(start, end).trim()
        });
      }
    }
  }

  return {
    count,
    topMatches: matches.slice(0, 8)
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] ** 2;
    normB += b[i] ** 2;
  }

  if (normA <= 0 || normB <= 0) {
    return 0;
  }

  const cosine = dot / Math.sqrt(normA * normB);
  return Math.max(-1, Math.min(1, cosine));
}

async function fetchEmbeddings(inputs: string[]): Promise<number[][]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openAiApiKey}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-large",
      input: inputs
    }),
    signal: AbortSignal.timeout(Math.max(5_000, env.autoGenTimeoutSec * 1_000))
  });

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: unknown }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }

  if (!Array.isArray(payload.data)) {
    throw new Error("Embeddings response did not return a data array");
  }

  const embeddings = payload.data.map((item) => item.embedding);
  if (
    embeddings.some(
      (embedding) =>
        !Array.isArray(embedding) ||
        embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
    )
  ) {
    throw new Error("Embeddings response contains invalid vectors");
  }

  return embeddings as number[][];
}

function buildTopicWindows(segments: NormalizedSegment[], transcriptText: string): {
  windows: TopicWindow[];
  mode: "timestamp_20s" | "word_chunks_120";
} {
  if (hasTimestamps(segments)) {
    const windowsMap = new Map<number, string[]>();

    for (const segment of segments) {
      const anchor = getSegmentAnchorSec(segment);
      if (anchor === null) {
        continue;
      }

      const index = Math.max(0, Math.floor(anchor / TOPIC_WINDOW_SEC));
      const bucket = windowsMap.get(index) ?? [];
      bucket.push(segment.text);
      windowsMap.set(index, bucket);
    }

    const windows = Array.from(windowsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([index, texts]) => ({ index, text: texts.join(" ").trim() }))
      .filter((window) => window.text.length > 0);

    if (windows.length > 0) {
      return { windows, mode: "timestamp_20s" };
    }
  }

  const words = tokenize(transcriptText);
  const windows: TopicWindow[] = [];

  for (let cursor = 0; cursor < words.length; cursor += TOPIC_WORD_CHUNK_SIZE) {
    const chunkWords = words.slice(cursor, cursor + TOPIC_WORD_CHUNK_SIZE);
    if (!chunkWords.length) {
      continue;
    }

    windows.push({
      index: windows.length,
      text: chunkWords.join(" ")
    });
  }

  return { windows, mode: "word_chunks_120" };
}

function scoreSegmentSentiment(segment: NormalizedSegment): number {
  let matchCount = 0;
  let totalScore = 0;

  for (const token of segment.words) {
    const score = SENTIMENT_LEXICON.get(token);
    if (typeof score !== "number") {
      continue;
    }
    matchCount += 1;
    totalScore += score;
  }

  if (matchCount === 0) {
    return 0;
  }

  return roundMetric(totalScore / matchCount);
}

function computeEmotionPeaks(segments: NormalizedSegment[]): TranscriptEmotionPeak[] {
  const peaks: TranscriptEmotionPeak[] = [];

  for (const segment of segments) {
    const tokenSet = segment.words;

    for (const [emotion, lexicon] of Object.entries(EMOTION_WORDS) as Array<[EmotionLabel, Set<string>]>) {
      let score = 0;
      for (const token of tokenSet) {
        if (lexicon.has(token)) {
          score += 1;
        }
      }

      if (score <= 0) {
        continue;
      }

      peaks.push({
        emotion,
        segmentIndex: segment.i,
        snippet: segment.text.slice(0, 160),
        score
      });
    }
  }

  return peaks.sort((a, b) => b.score - a.score || a.segmentIndex - b.segmentIndex).slice(0, 3);
}

async function computePromiseDeliveryScore(
  title: string,
  textFirst30s: string
): Promise<{ value: number | null; warning: string | null }> {
  if (!env.openAiApiKey) {
    return {
      value: null,
      warning: "Promise delivery score skipped: OPENAI_API_KEY is not configured"
    };
  }

  if (!title.trim() || !textFirst30s.trim()) {
    return {
      value: null,
      warning: "Promise delivery score skipped: missing title or first 30s transcript text"
    };
  }

  try {
    const embeddings = await fetchEmbeddings([title.trim(), textFirst30s.trim()]);
    if (embeddings.length < 2) {
      throw new Error("insufficient embedding vectors");
    }

    return {
      value: roundMetric(cosineSimilarity(embeddings[0], embeddings[1])),
      warning: null
    };
  } catch (error) {
    return {
      value: null,
      warning: `Promise delivery score failed: ${error instanceof Error ? error.message : "unknown error"}`
    };
  }
}

async function computeTopicShiftCount(
  segments: NormalizedSegment[],
  transcriptText: string
): Promise<{
  count: number | null;
  evidence: TopicShiftEvidence[];
  mode: "timestamp_20s" | "word_chunks_120" | null;
  warning: string | null;
}> {
  const { windows, mode } = buildTopicWindows(segments, transcriptText);

  if (windows.length < 2) {
    return {
      count: 0,
      evidence: [],
      mode,
      warning: null
    };
  }

  if (!env.openAiApiKey) {
    return {
      count: null,
      evidence: [],
      mode,
      warning: "Topic shift count skipped: OPENAI_API_KEY is not configured"
    };
  }

  try {
    const embeddings = await fetchEmbeddings(windows.map((window) => window.text));
    const evidence: TopicShiftEvidence[] = [];

    for (let i = 1; i < embeddings.length; i += 1) {
      const distance = 1 - cosineSimilarity(embeddings[i - 1], embeddings[i]);
      if (distance > TOPIC_SHIFT_DISTANCE_THRESHOLD) {
        evidence.push({
          fromWindow: windows[i - 1].index,
          toWindow: windows[i].index,
          distance: roundMetric(distance)
        });
      }
    }

    return {
      count: evidence.length,
      evidence,
      mode,
      warning: null
    };
  } catch (error) {
    return {
      count: null,
      evidence: [],
      mode,
      warning: `Topic shift count failed: ${error instanceof Error ? error.message : "unknown error"}`
    };
  }
}

export async function computeTranscriptDeterministicFeatures(
  args: ComputeTranscriptDeterministicFeaturesArgs
): Promise<ComputeTranscriptDeterministicFeaturesResult> {
  const warnings = [...args.transcriptArtifact.warnings];
  const segments = normalizeSegments(args.transcriptArtifact.segments);
  const transcriptText = getAllTranscriptText(segments);

  const titleTokens = extractImportantTitleTokens(args.title);
  const titleCoverage = buildTitleKeywordCoverage(titleTokens, transcriptText);

  const earlyWindow = getEarlyWindowText(segments, transcriptText);
  if (earlyWindow.mode === "leading_chars_fallback") {
    warnings.push("Early 30s coverage used char-based fallback: transcript segments have no timestamps");
  }

  const earlyCoverage = buildTitleKeywordCoverage(titleTokens, earlyWindow.text);

  const hookHit = getFirstTitleTokenHit(segments, titleTokens);
  if (hookHit && hookHit.startSec === null) {
    warnings.push("Hook keyword hit found but segment has no startSec; hook_keyword_hit_time_sec set to null");
  }

  const segmentWordTotal = segments.reduce((acc, segment) => acc + segment.words.length, 0);
  const segmentCharLengths = segments.map((segment) => segment.text.length);
  const segmentWordLengths = segments.map((segment) => segment.words.length);

  const hasAnyTimestamps = hasTimestamps(segments);
  const durationSec = estimateDurationSec(segments, args.durationSec);

  let wpmOverall: number | null = null;
  let wpm0_30: number | null = null;
  let wpm30_120: number | null = null;
  let wpmLast30: number | null = null;
  let wpmVariance: number | null = null;

  if (!hasAnyTimestamps) {
    warnings.push("WPM metrics set to null: transcript segments have no timestamps");
  } else if (durationSec === null) {
    warnings.push("WPM metrics set to null: durationSec unavailable and no segment endSec found");
  } else {
    wpmOverall = roundMetric(segmentWordTotal / (durationSec / 60));
    wpm0_30 = computeWpmFromWindow(segments, { start: 0, end: 30 });
    wpm30_120 = computeWpmFromWindow(segments, { start: 30, end: 120 });
    wpmLast30 = computeWpmFromWindow(segments, { start: Math.max(durationSec - 30, 0), end: durationSec });

    const windowValues = [wpm0_30, wpm30_120, wpmLast30].filter((value): value is number => value !== null);
    wpmVariance = variance(windowValues);
  }

  let silenceGapStats: TranscriptDeterministicFeatures["silence_gap_stats"] = {
    mean: null,
    p90: null,
    max: null
  };

  if (hasAnyTimestamps) {
    const gaps: number[] = [];
    for (let i = 1; i < segments.length; i += 1) {
      const previous = segments[i - 1];
      const current = segments[i];
      if (previous.endSec === null || current.startSec === null) {
        continue;
      }
      gaps.push(Math.max(0, current.startSec - previous.endSec));
    }

    if (gaps.length > 0) {
      silenceGapStats = {
        mean: mean(gaps),
        p90: percentile(gaps, 0.9),
        max: roundMetric(Math.max(...gaps))
      };
    }
  }

  const stepMarkers = collectMarkerCount(segments, STEP_MARKER_PATTERNS);
  const listMarkers = collectMarkerCount(segments, LIST_MARKER_PATTERNS);
  const contrastMarkers = collectMarkerCount(segments, CONTRAST_MARKER_PATTERNS);
  const storyMarkers = collectMarkerCount(segments, STORY_MARKER_PATTERNS);

  const sentimentScores = segments.map((segment) => scoreSegmentSentiment(segment));
  const sentimentMean = mean(sentimentScores);
  const sentimentStd = std(sentimentScores);

  const sentimentTrendPoints = segments.map((segment, index) => ({
    x: hasAnyTimestamps ? (getSegmentAnchorSec(segment) ?? index) : index,
    y: scoreSegmentSentiment(segment)
  }));

  const promiseResult = await computePromiseDeliveryScore(args.title, earlyWindow.text);
  if (promiseResult.warning) {
    warnings.push(promiseResult.warning);
  }

  const topicShiftResult = await computeTopicShiftCount(segments, transcriptText);
  if (topicShiftResult.warning) {
    warnings.push(topicShiftResult.warning);
  }

  return {
    features: {
      hook_keyword_hit_time_sec: hookHit && hookHit.startSec !== null ? roundMetric(hookHit.startSec) : null,
      hook_keyword_hit_evidence: hookHit
        ? {
            matchedToken: hookHit.matchedToken,
            segmentIndex: hookHit.segmentIndex,
            snippet: hookHit.snippet
          }
        : null,
      title_keyword_coverage: titleCoverage.ratio,
      title_keyword_coverage_evidence: {
        titleTokens,
        hitTokens: titleCoverage.hitTokens
      },
      title_keyword_early_coverage_30s: earlyCoverage.ratio,
      title_keyword_early_coverage_30s_evidence: {
        titleTokens,
        hitTokens: earlyCoverage.hitTokens,
        mode: earlyWindow.mode,
        charLimit: earlyWindow.charLimit
      },
      promise_delivery_30s_score: promiseResult.value,
      wpm_overall: wpmOverall,
      wpm_0_30: wpm0_30,
      wpm_30_120: wpm30_120,
      wpm_last_30: wpmLast30,
      wpm_variance: wpmVariance,
      segment_length_stats: {
        chars: {
          median: percentile(segmentCharLengths, 0.5),
          p90: percentile(segmentCharLengths, 0.9)
        },
        words: {
          median: percentile(segmentWordLengths, 0.5),
          p90: percentile(segmentWordLengths, 0.9)
        }
      },
      silence_gap_stats: silenceGapStats,
      step_markers_count: stepMarkers.count,
      list_markers_count: listMarkers.count,
      contrast_markers_count: contrastMarkers.count,
      story_markers_count: storyMarkers.count,
      marker_evidence: {
        step_topMatches: stepMarkers.topMatches,
        list_topMatches: listMarkers.topMatches,
        contrast_topMatches: contrastMarkers.topMatches,
        story_topMatches: storyMarkers.topMatches
      },
      sentiment_mean: sentimentMean,
      sentiment_std: sentimentStd,
      sentiment_trend: linearSlope(sentimentTrendPoints),
      emotion_peaks: computeEmotionPeaks(segments),
      topic_shift_count: topicShiftResult.count,
      topic_shift_evidence: topicShiftResult.evidence,
      topic_shift_windowing: topicShiftResult.mode
    },
    warnings
  };
}
