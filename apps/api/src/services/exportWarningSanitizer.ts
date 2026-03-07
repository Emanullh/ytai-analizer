import path from "node:path";
import { fileExists } from "../utils/fileExists.js";

export interface WarningVideoContext {
  videoId: string;
  transcriptPath?: string;
  warnings: string[];
}

interface SanitizeVideoWarningsArgs extends WarningVideoContext {
  projectRoot: string;
}

interface SanitizeProjectWarningsArgs {
  projectRoot: string;
  rows: WarningVideoContext[];
  warnings: string[];
  performanceWarnings: string[];
}

const TRANSCRIPT_ARTIFACT_FALLBACK_WARNING_PATTERN =
  /^Transcript artifact missing at .+; used in-memory fallback segment$/;
const PERFORMANCE_WARNING_PATTERNS: RegExp[] = [
  /^Invalid nowDateISO received; unix epoch used as deterministic fallback$/,
  /^Invalid publishedAt detected for \d+ videos; daysSincePublish set to 1$/,
  /^Missing or invalid durationSec for \d+ videos; isShort=false and duration term omitted$/,
  /^Performance model skipped: requires at least \d+ videos, received \d+$/,
  /^All videos are missing durationSec; duration predictor excluded from model$/,
  /^Some videos are missing durationSec; duration term imputed as 0 for those rows$/,
  /^Performance model fit failed due to numerical instability$/
];

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid warning sanitization path");
  }
}

function normalizeRelativePath(value: string | undefined, fallbackPath: string): string {
  const candidate = (value ?? "").replace(/\\/g, "/").trim();
  if (!candidate || path.isAbsolute(candidate)) {
    return fallbackPath;
  }
  if (candidate === "." || candidate === ".." || candidate.startsWith("../") || candidate.includes("/../")) {
    return fallbackPath;
  }
  return candidate;
}

function dedupeWarnings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function resolveTranscriptArtifactAbsolutePath(args: {
  projectRoot: string;
  videoId: string;
  transcriptPath?: string;
}): string {
  const relativePath = normalizeRelativePath(
    args.transcriptPath,
    path.posix.join("raw", "transcripts", `${args.videoId}.jsonl`)
  );
  const absolutePath = path.resolve(args.projectRoot, relativePath);
  ensureInsideRoot(args.projectRoot, absolutePath);
  return absolutePath;
}

async function buildCurrentTranscriptFallbackWarning(args: {
  projectRoot: string;
  videoId: string;
  transcriptPath?: string;
}): Promise<string | null> {
  const transcriptAbsolutePath = resolveTranscriptArtifactAbsolutePath(args);
  if (await fileExists(transcriptAbsolutePath)) {
    return null;
  }
  return `Transcript artifact missing at ${transcriptAbsolutePath}; used in-memory fallback segment`;
}

export function isTranscriptArtifactFallbackWarning(value: string): boolean {
  return TRANSCRIPT_ARTIFACT_FALLBACK_WARNING_PATTERN.test(value.trim());
}

export function isPerformanceWarning(value: string): boolean {
  const warning = value.trim();
  return PERFORMANCE_WARNING_PATTERNS.some((pattern) => pattern.test(warning));
}

export async function sanitizeVideoWarnings(args: SanitizeVideoWarningsArgs): Promise<string[]> {
  const preserved: string[] = [];
  let sawTranscriptFallbackWarning = false;

  for (const warning of args.warnings) {
    const trimmed = warning.trim();
    if (!trimmed) {
      continue;
    }
    if (isTranscriptArtifactFallbackWarning(trimmed)) {
      sawTranscriptFallbackWarning = true;
      continue;
    }
    preserved.push(trimmed);
  }

  if (sawTranscriptFallbackWarning) {
    const currentWarning = await buildCurrentTranscriptFallbackWarning(args);
    if (currentWarning) {
      preserved.unshift(currentWarning);
    }
  }

  return dedupeWarnings(preserved);
}

export async function sanitizeProjectWarnings(args: SanitizeProjectWarningsArgs): Promise<string[]> {
  const transcriptWarnings = (
    await Promise.all(
      args.rows.map(async (row) => {
        const sanitizedWarnings = await sanitizeVideoWarnings({
          projectRoot: args.projectRoot,
          videoId: row.videoId,
          transcriptPath: row.transcriptPath,
          warnings: row.warnings
        });
        return sanitizedWarnings.filter((warning) => isTranscriptArtifactFallbackWarning(warning));
      })
    )
  ).flat();

  const preservedWarnings = args.warnings.filter((warning) => {
    const trimmed = warning.trim();
    if (!trimmed) {
      return false;
    }
    if (isTranscriptArtifactFallbackWarning(trimmed)) {
      return false;
    }
    if (isPerformanceWarning(trimmed)) {
      return false;
    }
    return true;
  });

  return dedupeWarnings([...preservedWarnings, ...transcriptWarnings, ...args.performanceWarnings]);
}
