const TIMESTAMP_REGEX = /(\d{1,2}:)?\d{1,2}:\d{2}/;
const URL_REGEX = /(?:https?:\/\/|www\.)[^\s<>"]+/gi;

const SHORTENER_DOMAINS = new Set([
  "bit.ly",
  "t.co",
  "youtu.be",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "lnkd.in",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "rb.gy"
]);

const SPONSOR_DISCLOSURE_PATTERNS = ["sponsor", "sponsored", "patrocinado", "patrocinio", "ad", "paid promotion"];
const AFFILIATE_DISCLOSURE_PATTERNS = ["affiliate", "afiliado", "affiliate link", "enlace afiliado"];
const CREDITS_SOURCES_PATTERNS = ["sources", "fuentes", "references", "creditos", "créditos", "credit", "further reading"];

const CTA_PATTERNS: Record<string, string[]> = {
  subscribe: ["subscribe", "suscribete", "suscríbete", "suscribe", "subscribete"],
  like: ["like", "me gusta", "dale like"],
  comment: ["comment", "comenta", "deja tu comentario"],
  link: ["link", "enlace", "links in bio", "link in bio"],
  follow: ["follow", "sigueme", "sígueme", "seguir"],
  newsletter: ["newsletter", "boletin", "boletín"],
  patreon: ["patreon"]
};

const EN_STOPWORDS = new Set([
  "the",
  "and",
  "to",
  "of",
  "in",
  "for",
  "with",
  "this",
  "that",
  "you",
  "your",
  "is",
  "on",
  "it"
]);

const ES_STOPWORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "de",
  "y",
  "que",
  "en",
  "para",
  "con",
  "tu",
  "es",
  "un",
  "una"
]);

export interface EvidenceSpan {
  charStart: number;
  charEnd: number;
  snippet: string;
}

export interface UrlWithSpan {
  url: string;
  domain: string;
  charStart: number;
  charEnd: number;
  isShortener: boolean;
}

export interface DomainCount {
  domain: string;
  count: number;
}

export interface ReadabilityResult {
  metric: "fernandez_huerta" | "flesch_reading_ease" | "unknown";
  score: number | null;
}

export interface DescriptionDeterministicFeatures {
  desc_len_chars: number;
  desc_len_words: number;
  line_count: number;
  has_timestamps: boolean;
  url_count: number;
  urls: UrlWithSpan[];
  domain_counts: DomainCount[];
  hashtag_count: number;
  mentions_count: number;
  cta_count: Record<string, number>;
  cta_in_first_200_chars: boolean;
  title_desc_overlap_jaccard: number;
  title_desc_overlap_tokens: {
    titleTokens: string[];
    hitTokens: string[];
  };
  has_sponsor_disclosure: boolean;
  has_affiliate_disclosure: boolean;
  has_credits_sources: boolean;
  readability: ReadabilityResult;
}

export interface DescriptionDeterministicEvidence {
  sponsorDisclosureMatches: EvidenceSpan[];
  affiliateDisclosureMatches: EvidenceSpan[];
  creditsSourcesMatches: EvidenceSpan[];
}

export interface ComputeDescriptionDeterministicFeaturesArgs {
  title: string;
  description: string;
}

export interface ComputeDescriptionDeterministicFeaturesResult {
  features: DescriptionDeterministicFeatures;
  evidence: DescriptionDeterministicEvidence;
  warnings: string[];
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

function normalizeText(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function tokenize(raw: string): string[] {
  const normalized = normalizeText(raw);
  const matches = normalized.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.filter(Boolean) : [];
}

function normalizeUrl(rawUrl: string): string {
  if (/^https?:\/\//i.test(rawUrl)) {
    return rawUrl;
  }
  return `https://${rawUrl}`;
}

function trimUrlTrailingPunctuation(raw: string): string {
  return raw.replace(/[),.;!?]+$/g, "");
}

function resolveDomain(url: string): string {
  try {
    const parsed = new URL(normalizeUrl(url));
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

export function extractUrlsWithSpans(description: string): UrlWithSpan[] {
  const spans: UrlWithSpan[] = [];

  for (const match of description.matchAll(URL_REGEX)) {
    const raw = match[0] ?? "";
    const index = match.index ?? -1;
    if (!raw || index < 0) {
      continue;
    }

    const cleaned = trimUrlTrailingPunctuation(raw);
    if (!cleaned) {
      continue;
    }

    const charStart = index;
    const charEnd = index + cleaned.length;
    const domain = resolveDomain(cleaned);

    spans.push({
      url: normalizeUrl(cleaned),
      domain,
      charStart,
      charEnd,
      isShortener: SHORTENER_DOMAINS.has(domain)
    });
  }

  return spans;
}

export function domainCounts(urls: UrlWithSpan[]): DomainCount[] {
  const counts = new Map<string, number>();
  for (const url of urls) {
    counts.set(url.domain, (counts.get(url.domain) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern: string): RegExp {
  const patternBody = escapeRegExp(pattern.trim()).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${patternBody}\\b`, "giu");
}

function collectPatternMatches(input: { text: string; patterns: string[] }): EvidenceSpan[] {
  const matches: EvidenceSpan[] = [];

  for (const pattern of input.patterns) {
    const regex = patternToRegex(pattern);
    for (const match of input.text.matchAll(regex)) {
      const snippet = match[0] ?? "";
      const index = match.index ?? -1;
      if (!snippet || index < 0) {
        continue;
      }

      const charStart = index;
      const charEnd = index + snippet.length;
      matches.push({
        charStart,
        charEnd,
        snippet: input.text.slice(charStart, charEnd)
      });
    }
  }

  matches.sort((a, b) => a.charStart - b.charStart || a.charEnd - b.charEnd);
  return matches;
}

function countCtas(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let total = 0;

  for (const [category, patterns] of Object.entries(CTA_PATTERNS)) {
    let categoryCount = 0;
    for (const pattern of patterns) {
      const regex = patternToRegex(pattern);
      for (const _ of text.matchAll(regex)) {
        categoryCount += 1;
      }
    }
    counts[category] = categoryCount;
    total += categoryCount;
  }

  counts.total = total;
  return counts;
}

function hasAnyCta(text: string): boolean {
  for (const patterns of Object.values(CTA_PATTERNS)) {
    for (const pattern of patterns) {
      if (patternToRegex(pattern).test(text)) {
        return true;
      }
    }
  }
  return false;
}

function detectLanguage(text: string): "en" | "es" | "unknown" {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "unknown";
  }

  const tokens = tokenize(normalized);
  if (tokens.length === 0) {
    return "unknown";
  }

  let enCount = 0;
  let esCount = 0;

  for (const token of tokens) {
    if (EN_STOPWORDS.has(token)) {
      enCount += 1;
    }
    if (ES_STOPWORDS.has(token)) {
      esCount += 1;
    }
  }

  const hasSpanishMarkers = /[áéíóúñ¿¡]/i.test(text);
  if (hasSpanishMarkers && esCount >= enCount) {
    return "es";
  }
  if (esCount >= enCount + 2) {
    return "es";
  }
  if (enCount >= esCount + 2) {
    return "en";
  }

  return "unknown";
}

function countSentences(text: string): number {
  const matches = text.match(/[.!?]+/g) ?? [];
  return Math.max(1, matches.length);
}

function countSyllablesEnglishWord(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) {
    return 0;
  }

  const vowelGroups = word.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = /e$/.test(word) && vowelGroups > 1 ? 1 : 0;
  return Math.max(1, vowelGroups - silentE);
}

function countSyllablesSpanishWord(rawWord: string): number {
  const word = rawWord.toLowerCase().replace(/[^a-záéíóúüñ]/g, "");
  if (!word) {
    return 0;
  }

  const vowelGroups = word.match(/[aeiouáéíóúü]+/g)?.length ?? 0;
  return Math.max(1, vowelGroups);
}

function computeReadability(text: string): { readability: ReadabilityResult; warning: string | null } {
  const language = detectLanguage(text);
  const tokens = tokenize(text);
  const words = tokens.length;

  if (words === 0) {
    return {
      readability: {
        metric: "unknown",
        score: null
      },
      warning: "Readability skipped: description has no words"
    };
  }

  const sentences = countSentences(text);

  if (language === "en") {
    const syllables = tokens.reduce((acc, token) => acc + countSyllablesEnglishWord(token), 0);
    const score = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
    return {
      readability: {
        metric: "flesch_reading_ease",
        score: Number(score.toFixed(6))
      },
      warning: null
    };
  }

  if (language === "es") {
    const syllables = tokens.reduce((acc, token) => acc + countSyllablesSpanishWord(token), 0);
    const score = 206.84 - 0.6 * ((syllables * 100) / words) - 1.02 * ((sentences * 100) / words);
    return {
      readability: {
        metric: "fernandez_huerta",
        score: Number(score.toFixed(6))
      },
      warning: null
    };
  }

  return {
    readability: {
      metric: "unknown",
      score: null
    },
    warning: "Readability language detection failed: unable to infer ES/EN"
  };
}

function computeTitleDescriptionOverlap(title: string, description: string): {
  jaccard: number;
  titleTokens: string[];
  hitTokens: string[];
} {
  const titleTokens = Array.from(new Set(tokenize(title).filter((token) => token.length >= 2)));
  const descriptionTokens = new Set(tokenize(description).filter((token) => token.length >= 2));

  const hitTokens = titleTokens.filter((token) => descriptionTokens.has(token));
  const unionSize = new Set([...titleTokens, ...descriptionTokens]).size;

  return {
    jaccard: unionSize > 0 ? clamp01(hitTokens.length / unionSize) : 0,
    titleTokens,
    hitTokens
  };
}

export function computeDescriptionDeterministicFeatures(
  args: ComputeDescriptionDeterministicFeaturesArgs
): ComputeDescriptionDeterministicFeaturesResult {
  const title = args.title ?? "";
  const description = args.description ?? "";
  const warnings: string[] = [];

  const words = tokenize(description);
  const urls = extractUrlsWithSpans(description);
  const overlap = computeTitleDescriptionOverlap(title, description);

  const sponsorDisclosureMatches = collectPatternMatches({
    text: description,
    patterns: SPONSOR_DISCLOSURE_PATTERNS
  });
  const affiliateDisclosureMatches = collectPatternMatches({
    text: description,
    patterns: AFFILIATE_DISCLOSURE_PATTERNS
  });
  const creditsSourcesMatches = collectPatternMatches({
    text: description,
    patterns: CREDITS_SOURCES_PATTERNS
  });

  const readabilityResult = computeReadability(description);
  if (readabilityResult.warning) {
    warnings.push(readabilityResult.warning);
  }

  const lineCount = description.length === 0 ? 0 : description.split(/\r?\n/).length;

  return {
    features: {
      desc_len_chars: description.length,
      desc_len_words: words.length,
      line_count: lineCount,
      has_timestamps: TIMESTAMP_REGEX.test(description),
      url_count: urls.length,
      urls,
      domain_counts: domainCounts(urls),
      hashtag_count: (description.match(/#\w+/g) ?? []).length,
      mentions_count: (description.match(/@\w+/g) ?? []).length,
      cta_count: countCtas(description),
      cta_in_first_200_chars: hasAnyCta(description.slice(0, 200)),
      title_desc_overlap_jaccard: overlap.jaccard,
      title_desc_overlap_tokens: {
        titleTokens: overlap.titleTokens,
        hitTokens: overlap.hitTokens
      },
      has_sponsor_disclosure: sponsorDisclosureMatches.length > 0,
      has_affiliate_disclosure: affiliateDisclosureMatches.length > 0,
      has_credits_sources: creditsSourcesMatches.length > 0 && urls.length > 0,
      readability: readabilityResult.readability
    },
    evidence: {
      sponsorDisclosureMatches,
      affiliateDisclosureMatches,
      creditsSourcesMatches
    },
    warnings
  };
}
