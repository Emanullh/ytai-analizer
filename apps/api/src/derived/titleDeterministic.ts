import type { TranscriptSegment } from "../services/transcriptModels.js";
import { CERTAINTY_WORDS, HEDGING_WORDS, NEGATION_WORDS, PRONOUN_WORDS, TITLE_STOPWORDS } from "./wordlists.js";

const DEFAULT_EARLY_WINDOW_CHAR_LIMIT = 800;

const PRONOUN_SET = new Set(PRONOUN_WORDS);
const NEGATION_SET = new Set(NEGATION_WORDS);
const CERTAINTY_SET = new Set(CERTAINTY_WORDS);
const HEDGING_SET = new Set(HEDGING_WORDS);
const STOPWORD_SET = new Set(TITLE_STOPWORDS);

type EarlyWindowMode = "timestamp_window_0_30s" | "leading_chars_fallback";

export interface DeterministicTitleFeatures {
  title_len_chars: number;
  title_len_words: number;
  caps_ratio: number;
  emoji_count: number;
  punct_count_total: number;
  question_mark_count: number;
  exclamation_count: number;
  colon_count: number;
  dash_count: number;
  paren_count: number;
  bracket_count: number;
  has_number: boolean;
  number_count: number;
  leading_number: boolean;
  pronoun_count: number;
  negation_count: number;
  certainty_count: number;
  hedging_count: number;
  title_keyword_coverage: number;
  title_keyword_early_coverage_30s: number;
  title_transcript_sim_cosine: number | null;
  title_keyword_audit: {
    title_tokens: string[];
    matched_in_transcript: string[];
    matched_in_early_window_30s: string[];
    early_window_mode: EarlyWindowMode;
    early_window_char_limit: number | null;
  };
}

export interface ComputeTitleDeterministicFeaturesArgs {
  title: string;
  transcript?: string;
  transcriptSegments?: TranscriptSegment[];
  earlyWindowCharLimit?: number;
}

interface EarlyTranscriptWindow {
  text: string;
  mode: EarlyWindowMode;
  charLimit: number | null;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(6));
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

function countByLexicon(tokens: string[], lexicon: ReadonlySet<string>): number {
  let count = 0;
  for (const token of tokens) {
    const normalized = token.replace(/'/g, "");
    if (lexicon.has(normalized)) {
      count += 1;
      continue;
    }

    const underscored = normalized.replace(/\s+/g, "_");
    if (lexicon.has(underscored)) {
      count += 1;
      continue;
    }

    if (normalized.endsWith("nt") && lexicon === NEGATION_SET) {
      count += 1;
    }
  }
  return count;
}

function extractTitleKeywords(title: string): string[] {
  const tokens = tokenize(title);
  const deduped = new Set<string>();

  for (const token of tokens) {
    if (STOPWORD_SET.has(token)) {
      continue;
    }

    const isNumeric = /\p{N}/u.test(token);
    if (!isNumeric && token.length <= 2) {
      continue;
    }

    deduped.add(token);
  }

  return Array.from(deduped);
}

function normalizeSegments(segments: TranscriptSegment[] | undefined): TranscriptSegment[] {
  if (!Array.isArray(segments)) {
    return [];
  }

  return segments
    .map((segment) => {
      const text = typeof segment.text === "string" ? segment.text.trim() : "";
      if (!text) {
        return null;
      }

      return {
        startSec: typeof segment.startSec === "number" && Number.isFinite(segment.startSec) ? segment.startSec : null,
        endSec: typeof segment.endSec === "number" && Number.isFinite(segment.endSec) ? segment.endSec : null,
        text,
        confidence: typeof segment.confidence === "number" && Number.isFinite(segment.confidence) ? segment.confidence : null
      } satisfies TranscriptSegment;
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

function getEarlyTranscriptWindow(input: {
  transcript: string;
  transcriptSegments?: TranscriptSegment[];
  earlyWindowCharLimit?: number;
}): EarlyTranscriptWindow {
  const segments = normalizeSegments(input.transcriptSegments);
  const hasTimeline = segments.some((segment) => segment.startSec !== null || segment.endSec !== null);

  if (hasTimeline) {
    const earlySegments = segments.filter((segment) => {
      const start = segment.startSec;
      const end = segment.endSec;
      if (start !== null) {
        return start < 30;
      }
      if (end !== null) {
        return end <= 30;
      }
      return false;
    });

    return {
      text: earlySegments.map((segment) => segment.text).join(" ").trim(),
      mode: "timestamp_window_0_30s",
      charLimit: null
    };
  }

  const charLimit = Math.max(64, input.earlyWindowCharLimit ?? DEFAULT_EARLY_WINDOW_CHAR_LIMIT);
  return {
    text: input.transcript.slice(0, charLimit),
    mode: "leading_chars_fallback",
    charLimit
  };
}

function keywordCoverage(keywords: string[], sourceText: string): { ratio: number; matched: string[] } {
  if (!keywords.length) {
    return { ratio: 0, matched: [] };
  }

  const sourceTokenSet = new Set(tokenize(sourceText));
  const matched = keywords.filter((keyword) => sourceTokenSet.has(keyword));
  return {
    ratio: clampRatio(matched.length / keywords.length),
    matched
  };
}

export function computeTitleDeterministicFeatures(
  args: ComputeTitleDeterministicFeaturesArgs
): DeterministicTitleFeatures {
  const title = args.title?.trim() ?? "";
  const transcript = args.transcript?.trim() ?? "";

  const tokens = tokenize(title);
  const letters = title.match(/\p{L}/gu) ?? [];
  const uppercaseLetters = title.match(/\p{Lu}/gu) ?? [];
  const numbers = title.match(/\p{N}+/gu) ?? [];

  const earlyWindow = getEarlyTranscriptWindow({
    transcript,
    transcriptSegments: args.transcriptSegments,
    earlyWindowCharLimit: args.earlyWindowCharLimit
  });

  const keywords = extractTitleKeywords(title);
  const transcriptCoverage = keywordCoverage(keywords, transcript);
  const earlyCoverage = keywordCoverage(keywords, earlyWindow.text);

  return {
    title_len_chars: title.length,
    title_len_words: tokens.length,
    caps_ratio: letters.length ? clampRatio(uppercaseLetters.length / letters.length) : 0,
    emoji_count: (title.match(/\p{Extended_Pictographic}/gu) ?? []).length,
    punct_count_total: (title.match(/\p{P}/gu) ?? []).length,
    question_mark_count: (title.match(/[?¿]/g) ?? []).length,
    exclamation_count: (title.match(/[!¡]/g) ?? []).length,
    colon_count: (title.match(/[:：]/g) ?? []).length,
    dash_count: (title.match(/[-‐‑‒–—―]/g) ?? []).length,
    paren_count: (title.match(/[()]/g) ?? []).length,
    bracket_count: (title.match(/[\[\]{}]/g) ?? []).length,
    has_number: numbers.length > 0,
    number_count: numbers.length,
    leading_number: /^\s*\p{N}+/u.test(title),
    pronoun_count: countByLexicon(tokens, PRONOUN_SET),
    negation_count: countByLexicon(tokens, NEGATION_SET),
    certainty_count: countByLexicon(tokens, CERTAINTY_SET),
    hedging_count: countByLexicon(tokens, HEDGING_SET),
    title_keyword_coverage: transcriptCoverage.ratio,
    title_keyword_early_coverage_30s: earlyCoverage.ratio,
    title_transcript_sim_cosine: null,
    title_keyword_audit: {
      title_tokens: keywords,
      matched_in_transcript: transcriptCoverage.matched,
      matched_in_early_window_30s: earlyCoverage.matched,
      early_window_mode: earlyWindow.mode,
      early_window_char_limit: earlyWindow.charLimit
    }
  };
}
