import { createReadStream, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

type ProjectStatus = "ok" | "partial" | "failed" | "unknown";

type TranscriptStatus = "ok" | "missing" | "error";
type TranscriptSource = "captions" | "asr" | "none";

interface ManifestCounts {
  totalVideosSelected: number;
  transcriptsOk: number;
  transcriptsMissing: number;
  transcriptsError: number;
  thumbnailsOk: number;
  thumbnailsFailed: number;
}

interface JobSummaryRecord {
  jobId: string;
  status: "done" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  warningsCount: number;
  errorsCount: number;
  perVideo?: Record<
    string,
    {
      cacheHit?: "full" | "partial" | "miss" | "unknown";
      transcriptStatus?: "ok" | "missing" | "error" | "unknown";
      llmUsed?: {
        description?: boolean;
        transcript?: boolean;
        thumbnail?: boolean;
        orchestrator?: boolean;
      };
    }
  >;
}

interface ChannelVideoRecord {
  videoId?: unknown;
  title?: unknown;
  publishedAt?: unknown;
  thumbnailPath?: unknown;
  transcriptStatus?: unknown;
  transcriptSource?: unknown;
}

interface ChannelExportRecord {
  exportVersion?: unknown;
  exportedAt?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  sourceInput?: unknown;
  timeframe?: unknown;
  timeframeResolved?: unknown;
  videos?: unknown;
}

interface ManifestRecord {
  exportVersion?: unknown;
  channelId?: unknown;
  channelFolder?: unknown;
  exportedAt?: unknown;
  warnings?: unknown;
  counts?: unknown;
  artifacts?: unknown;
}

interface VideoDerivedRecord {
  titleFeatures?: {
    llm?: unknown;
  };
  performance?: unknown;
  descriptionFeatures?: {
    llm?: unknown;
  };
  transcriptFeatures?: {
    llm?: unknown;
  };
  thumbnailFeatures?: {
    llm?: unknown;
  };
  [key: string]: unknown;
}

export interface ProjectsListItem {
  projectId: string;
  channelId: string | null;
  channelName: string | null;
  exportVersion: string | null;
  lastExportedAt: string | null;
  lastJobId: string | null;
  counts: ManifestCounts;
  warningsCount: number;
  status: ProjectStatus;
  warnings: string[];
}

export interface ProjectDetailJobItem {
  jobId: string;
  status: "done" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  warningsCount: number;
  errorsCount: number;
  summaryPath: string;
  eventsPath: string;
  errorsPath: string;
  debugBundlePath: string | null;
}

export interface ProjectDetailResponse {
  projectId: string;
  channel: {
    channelId: string | null;
    channelName: string | null;
    sourceInput: string | null;
    timeframe: string | null;
    exportedAt: string | null;
    timeframeResolved: Record<string, unknown> | null;
  };
  manifest: Record<string, unknown> | null;
  latestJob: {
    jobId: string;
    status: "done" | "failed";
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    warningsCount: number;
    errorsCount: number;
  } | null;
  jobs: ProjectDetailJobItem[];
  artifacts: {
    playbook: string | null;
    templates: string | null;
    channelModels: string | null;
  };
  warnings: string[];
}

export interface ProjectVideoSummaryItem {
  videoId: string;
  title: string;
  publishedAt: string | null;
  thumbnailPath: string | null;
  transcriptStatus: TranscriptStatus;
  transcriptSource: TranscriptSource;
  performance: {
    viewsPerDay: number | null;
    engagementRate: number | null;
    residual: number | null;
    percentile: number | null;
  } | null;
  hasLLM: {
    title: boolean;
    description: boolean;
    transcript: boolean;
    thumbnail: boolean;
  };
  cacheHit: "full" | "partial" | "miss" | "unknown" | null;
}

export interface ProjectVideoDetailOptions {
  maxSegments?: number;
  truncateChars?: number;
}

const DEFAULT_COUNTS: ManifestCounts = {
  totalVideosSelected: 0,
  transcriptsOk: 0,
  transcriptsMissing: 0,
  transcriptsError: 0,
  thumbnailsOk: 0,
  thumbnailsFailed: 0
};

const ARTIFACT_PATHS = {
  playbook: path.join("analysis", "playbook.json"),
  templates: path.join("derived", "templates.json"),
  channel_models: path.join("derived", "channel_models.json")
} as const;

const MAX_SEGMENTS_UPPER_BOUND = 2_000;
const TRUNCATE_CHARS_UPPER_BOUND = 10_000;

function getExportsRoot(): string {
  return path.resolve(process.cwd(), "exports");
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);

  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new HttpError(400, "Invalid export path");
  }
}

function toPosixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

function toSafeRelativePath(rootPath: string, targetPath: string): string {
  ensureInsideRoot(rootPath, targetPath);
  const relativePath = toPosixPath(path.relative(rootPath, targetPath));
  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new HttpError(400, "Invalid relative path");
  }
  return relativePath;
}

function validatePathSegment(value: string, label: string): void {
  if (!value || value === ".") {
    throw new HttpError(400, `Invalid ${label}`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("..") || path.isAbsolute(value)) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseManifestCounts(value: unknown): ManifestCounts {
  if (!isRecord(value)) {
    return { ...DEFAULT_COUNTS };
  }

  return {
    totalVideosSelected: toFiniteNumberOrNull(value.totalVideosSelected) ?? 0,
    transcriptsOk: toFiniteNumberOrNull(value.transcriptsOk) ?? 0,
    transcriptsMissing: toFiniteNumberOrNull(value.transcriptsMissing) ?? 0,
    transcriptsError: toFiniteNumberOrNull(value.transcriptsError) ?? 0,
    thumbnailsOk: toFiniteNumberOrNull(value.thumbnailsOk) ?? 0,
    thumbnailsFailed: toFiniteNumberOrNull(value.thumbnailsFailed) ?? 0
  };
}

function normalizeTranscriptStatus(value: unknown): TranscriptStatus {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function normalizeTranscriptSource(value: unknown): TranscriptSource {
  if (value === "captions" || value === "asr" || value === "none") {
    return value;
  }
  return "none";
}

function deriveProjectStatus(input: {
  latestSummary: JobSummaryRecord | null;
  manifest: ManifestRecord | null;
  warnings: string[];
}): ProjectStatus {
  const { latestSummary, manifest, warnings } = input;
  if (warnings.length > 0 && !latestSummary && !manifest) {
    return "unknown";
  }
  if (latestSummary?.status === "failed") {
    return "failed";
  }

  const manifestWarnings = Array.isArray(manifest?.warnings) ? manifest?.warnings.length : 0;
  const hasManifestFailures = Boolean(
    isRecord(manifest?.counts) &&
      ((toFiniteNumberOrNull((manifest?.counts as Record<string, unknown>).transcriptsError) ?? 0) > 0 ||
        (toFiniteNumberOrNull((manifest?.counts as Record<string, unknown>).thumbnailsFailed) ?? 0) > 0)
  );

  if (
    warnings.length > 0 ||
    manifestWarnings > 0 ||
    hasManifestFailures ||
    (latestSummary !== null && (latestSummary.warningsCount > 0 || latestSummary.errorsCount > 0))
  ) {
    return "partial";
  }

  if (latestSummary?.status === "done") {
    return "ok";
  }

  if (manifest || warnings.length === 0) {
    return manifest ? "ok" : "unknown";
  }

  return "unknown";
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readProjectRoot(projectId: string): Promise<{ exportsRoot: string; projectRoot: string }> {
  validatePathSegment(projectId, "projectId");

  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, projectId);
  ensureInsideRoot(exportsRoot, projectRoot);

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Project not found");
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new HttpError(404, "Project not found");
  }

  return { exportsRoot, projectRoot };
}

async function readJobSummaries(projectRoot: string, warnings: string[]): Promise<JobSummaryRecord[]> {
  const logsRoot = path.resolve(projectRoot, "logs");
  let entries: Dirent[] = [];

  try {
    entries = await fs.readdir(logsRoot, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    warnings.push(`Could not read logs folder: ${(error as Error).message}`);
    return [];
  }

  const summaries: JobSummaryRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(/^job_(.+)\.summary\.json$/);
    if (!match) {
      continue;
    }

    const summaryPath = path.resolve(logsRoot, entry.name);
    try {
      const raw = await readJsonFile<Record<string, unknown>>(summaryPath);
      if (!raw || !isRecord(raw)) {
        warnings.push(`Invalid summary file: logs/${entry.name}`);
        continue;
      }
      const status = raw.status;
      if (status !== "done" && status !== "failed") {
        warnings.push(`Unknown summary status in logs/${entry.name}`);
        continue;
      }

      summaries.push({
        jobId: toStringOrNull(raw.jobId) ?? match[1],
        status,
        startedAt: toStringOrNull(raw.startedAt) ?? "",
        finishedAt: toStringOrNull(raw.finishedAt) ?? "",
        durationMs: toFiniteNumberOrNull(raw.durationMs) ?? 0,
        warningsCount: toFiniteNumberOrNull(raw.warningsCount) ?? 0,
        errorsCount: toFiniteNumberOrNull(raw.errorsCount) ?? 0,
        perVideo: isRecord(raw.perVideo)
          ? (raw.perVideo as JobSummaryRecord["perVideo"])
          : undefined
      });
    } catch (error) {
      warnings.push(`Could not parse logs/${entry.name}: ${(error as Error).message}`);
    }
  }

  summaries.sort((a, b) => {
    const timeA = new Date(a.finishedAt || a.startedAt || 0).getTime();
    const timeB = new Date(b.finishedAt || b.startedAt || 0).getTime();
    return timeB - timeA;
  });

  return summaries;
}

function extractChannelVideoRecords(channel: ChannelExportRecord | null): ChannelVideoRecord[] {
  if (!channel || !Array.isArray(channel.videos)) {
    return [];
  }

  return channel.videos.filter((item): item is ChannelVideoRecord => isRecord(item));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let index = 0;

  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        break;
      }
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

async function loadManifestAndChannel(projectRoot: string, warnings: string[]): Promise<{
  manifest: ManifestRecord | null;
  channel: ChannelExportRecord | null;
}> {
  const manifestPath = path.resolve(projectRoot, "manifest.json");
  const channelPath = path.resolve(projectRoot, "channel.json");

  let manifest: ManifestRecord | null = null;
  let channel: ChannelExportRecord | null = null;

  try {
    manifest = await readJsonFile<ManifestRecord>(manifestPath);
  } catch (error) {
    warnings.push(`Could not read manifest.json: ${(error as Error).message}`);
  }

  try {
    channel = await readJsonFile<ChannelExportRecord>(channelPath);
  } catch (error) {
    warnings.push(`Could not read channel.json: ${(error as Error).message}`);
  }

  return { manifest, channel };
}

export async function listProjects(): Promise<ProjectsListItem[]> {
  const exportsRoot = getExportsRoot();

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(exportsRoot, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const projects: ProjectsListItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".tmp") {
      continue;
    }

    const projectWarnings: string[] = [];
    const projectRoot = path.resolve(exportsRoot, entry.name);
    ensureInsideRoot(exportsRoot, projectRoot);

    try {
      const { manifest, channel } = await loadManifestAndChannel(projectRoot, projectWarnings);
      const summaries = await readJobSummaries(projectRoot, projectWarnings);
      const latestSummary = summaries[0] ?? null;
      const counts = parseManifestCounts(manifest?.counts);
      const manifestWarningsCount = Array.isArray(manifest?.warnings) ? manifest.warnings.length : 0;

      const warningCount = manifestWarningsCount + (latestSummary?.warningsCount ?? 0) + projectWarnings.length;
      const lastExportedAt =
        toStringOrNull(manifest?.exportedAt) ??
        latestSummary?.finishedAt ??
        toStringOrNull(channel?.exportedAt) ??
        latestSummary?.startedAt ??
        null;

      projects.push({
        projectId: entry.name,
        channelId: toStringOrNull(manifest?.channelId) ?? toStringOrNull(channel?.channelId),
        channelName: toStringOrNull(channel?.channelName),
        exportVersion: toStringOrNull(manifest?.exportVersion) ?? toStringOrNull(channel?.exportVersion),
        lastExportedAt,
        lastJobId: latestSummary?.jobId ?? null,
        counts,
        warningsCount: warningCount,
        status: deriveProjectStatus({
          latestSummary,
          manifest,
          warnings: projectWarnings
        }),
        warnings: projectWarnings
      });
    } catch (error) {
      projects.push({
        projectId: entry.name,
        channelId: null,
        channelName: null,
        exportVersion: null,
        lastExportedAt: null,
        lastJobId: null,
        counts: { ...DEFAULT_COUNTS },
        warningsCount: 1,
        status: "unknown",
        warnings: [`Project read failure: ${(error as Error).message}`]
      });
    }
  }

  projects.sort((a, b) => {
    const timeA = a.lastExportedAt ? new Date(a.lastExportedAt).getTime() : 0;
    const timeB = b.lastExportedAt ? new Date(b.lastExportedAt).getTime() : 0;
    return timeB - timeA;
  });

  return projects;
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetailResponse> {
  const warnings: string[] = [];
  const { projectRoot } = await readProjectRoot(projectId);
  const { manifest, channel } = await loadManifestAndChannel(projectRoot, warnings);
  const summaries = await readJobSummaries(projectRoot, warnings);
  const latestSummary = summaries[0] ?? null;

  const artifacts = await Promise.all([
    fileExists(path.resolve(projectRoot, ARTIFACT_PATHS.playbook)),
    fileExists(path.resolve(projectRoot, ARTIFACT_PATHS.templates)),
    fileExists(path.resolve(projectRoot, ARTIFACT_PATHS.channel_models))
  ]);

  return {
    projectId,
    channel: {
      channelId: toStringOrNull(channel?.channelId) ?? toStringOrNull(manifest?.channelId),
      channelName: toStringOrNull(channel?.channelName),
      sourceInput: toStringOrNull(channel?.sourceInput),
      timeframe: toStringOrNull(channel?.timeframe),
      exportedAt:
        toStringOrNull(channel?.exportedAt) ?? toStringOrNull(manifest?.exportedAt) ?? latestSummary?.finishedAt ?? null,
      timeframeResolved: isRecord(channel?.timeframeResolved)
        ? (channel?.timeframeResolved as Record<string, unknown>)
        : null
    },
    manifest: isRecord(manifest) ? manifest : null,
    latestJob: latestSummary
      ? {
          jobId: latestSummary.jobId,
          status: latestSummary.status,
          startedAt: latestSummary.startedAt,
          finishedAt: latestSummary.finishedAt,
          durationMs: latestSummary.durationMs,
          warningsCount: latestSummary.warningsCount,
          errorsCount: latestSummary.errorsCount
        }
      : null,
    jobs: await Promise.all(
      summaries.map(async (summary) => {
      const logsRoot = path.resolve(projectRoot, "logs");
      const debugBundlePath = path.resolve(logsRoot, `job_${summary.jobId}.debug_bundle.json`);
      const hasDebugBundle = await fileExists(debugBundlePath);
      return {
        jobId: summary.jobId,
        status: summary.status,
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        durationMs: summary.durationMs,
        warningsCount: summary.warningsCount,
        errorsCount: summary.errorsCount,
        summaryPath: toSafeRelativePath(projectRoot, path.resolve(logsRoot, `job_${summary.jobId}.summary.json`)),
        eventsPath: toSafeRelativePath(projectRoot, path.resolve(logsRoot, `job_${summary.jobId}.events.jsonl`)),
        errorsPath: toSafeRelativePath(projectRoot, path.resolve(logsRoot, `job_${summary.jobId}.errors.jsonl`)),
        debugBundlePath: hasDebugBundle ? toSafeRelativePath(projectRoot, debugBundlePath) : null
      } as ProjectDetailJobItem;
      })
    ),
    artifacts: {
      playbook: artifacts[0] ? toPosixPath(ARTIFACT_PATHS.playbook) : null,
      templates: artifacts[1] ? toPosixPath(ARTIFACT_PATHS.templates) : null,
      channelModels: artifacts[2] ? toPosixPath(ARTIFACT_PATHS.channel_models) : null
    },
    warnings
  };
}

export async function listProjectVideos(projectId: string): Promise<ProjectVideoSummaryItem[]> {
  const warnings: string[] = [];
  const { projectRoot } = await readProjectRoot(projectId);
  const { channel } = await loadManifestAndChannel(projectRoot, warnings);
  const summaries = await readJobSummaries(projectRoot, warnings);
  const latestSummary = summaries[0] ?? null;

  const cacheHitByVideo = new Map<string, "full" | "partial" | "miss" | "unknown">();
  if (latestSummary?.perVideo) {
    for (const [videoId, item] of Object.entries(latestSummary.perVideo)) {
      const cacheHit = item?.cacheHit;
      if (cacheHit === "full" || cacheHit === "partial" || cacheHit === "miss" || cacheHit === "unknown") {
        cacheHitByVideo.set(videoId, cacheHit);
      }
    }
  }

  const baseVideos = extractChannelVideoRecords(channel);
  const fsConcurrency = Math.max(1, env.exportFsConcurrency);

  return mapWithConcurrency(baseVideos, fsConcurrency, async (video): Promise<ProjectVideoSummaryItem> => {
    const videoId = toStringOrNull(video.videoId) ?? "";
    const derivedPath = path.resolve(projectRoot, "derived", "video_features", `${videoId}.json`);

    let derived: VideoDerivedRecord | null = null;
    try {
      derived = await readJsonFile<VideoDerivedRecord>(derivedPath);
    } catch {
      derived = null;
    }

    const performanceCandidate = isRecord(derived?.performance)
      ? {
          viewsPerDay: toFiniteNumberOrNull((derived?.performance as Record<string, unknown>).viewsPerDay),
          engagementRate: toFiniteNumberOrNull((derived?.performance as Record<string, unknown>).engagementRate),
          residual: toFiniteNumberOrNull((derived?.performance as Record<string, unknown>).residual),
          percentile: toFiniteNumberOrNull((derived?.performance as Record<string, unknown>).percentile)
        }
      : null;

    const performance =
      performanceCandidate && Object.values(performanceCandidate).some((value) => value !== null)
        ? performanceCandidate
        : null;

    return {
      videoId,
      title: toStringOrNull(video.title) ?? videoId,
      publishedAt: toStringOrNull(video.publishedAt),
      thumbnailPath: toStringOrNull(video.thumbnailPath) ?? `thumbnails/${videoId}.jpg`,
      transcriptStatus: normalizeTranscriptStatus(video.transcriptStatus),
      transcriptSource: normalizeTranscriptSource(video.transcriptSource),
      performance,
      hasLLM: {
        title: isRecord(derived?.titleFeatures) && derived?.titleFeatures?.llm != null,
        description: isRecord(derived?.descriptionFeatures) && derived?.descriptionFeatures?.llm != null,
        transcript: isRecord(derived?.transcriptFeatures) && derived?.transcriptFeatures?.llm != null,
        thumbnail: isRecord(derived?.thumbnailFeatures) && derived?.thumbnailFeatures?.llm != null
      },
      cacheHit: cacheHitByVideo.get(videoId) ?? null
    };
  });
}

export async function getProjectVideoDetail(projectId: string, videoId: string, options: ProjectVideoDetailOptions = {}) {
  validatePathSegment(videoId, "videoId");
  const { projectRoot } = await readProjectRoot(projectId);

  const maxSegments = Math.max(1, Math.min(options.maxSegments ?? 200, MAX_SEGMENTS_UPPER_BOUND));
  const truncateChars = options.truncateChars
    ? Math.max(1, Math.min(options.truncateChars, TRUNCATE_CHARS_UPPER_BOUND))
    : null;

  const derivedPath = path.resolve(projectRoot, "derived", "video_features", `${videoId}.json`);
  const transcriptPath = path.resolve(projectRoot, "raw", "transcripts", `${videoId}.jsonl`);
  const rawVideosPath = path.resolve(projectRoot, "raw", "videos.jsonl");

  const [derived, transcriptRaw, rawVideosRaw] = await Promise.all([
    readJsonFile<Record<string, unknown>>(derivedPath),
    fs.readFile(transcriptPath, "utf-8").catch(() => null),
    fs.readFile(rawVideosPath, "utf-8").catch(() => null)
  ]);

  let transcriptJsonl: Array<Record<string, unknown>> | null = null;
  if (typeof transcriptRaw === "string") {
    transcriptJsonl = [];
    let segmentCount = 0;
    const lines = transcriptRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }

      if (parsed.type === "segment") {
        if (segmentCount >= maxSegments) {
          continue;
        }
        segmentCount += 1;
      }

      if (truncateChars && typeof parsed.text === "string" && parsed.text.length > truncateChars) {
        parsed.text = `${parsed.text.slice(0, truncateChars)}...`;
      }

      transcriptJsonl.push(parsed);
    }
  }

  let rawVideo: Record<string, unknown> | null = null;
  if (typeof rawVideosRaw === "string" && rawVideosRaw.trim()) {
    const lines = rawVideosRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (toStringOrNull(parsed.videoId) === videoId) {
          rawVideo = parsed;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return {
    videoId,
    derived,
    transcriptJsonl,
    rawVideo
  };
}

export async function readProjectArtifact(
  projectId: string,
  artifact: keyof typeof ARTIFACT_PATHS
): Promise<Record<string, unknown>> {
  const { projectRoot } = await readProjectRoot(projectId);
  const artifactPath = path.resolve(projectRoot, ARTIFACT_PATHS[artifact]);

  ensureInsideRoot(projectRoot, artifactPath);

  const artifactJson = await readJsonFile<Record<string, unknown>>(artifactPath);
  if (!artifactJson) {
    throw new HttpError(404, "Artifact not found");
  }

  return artifactJson;
}

export async function resolveProjectThumbnail(projectId: string, videoId: string): Promise<string> {
  validatePathSegment(videoId, "videoId");
  const { projectRoot } = await readProjectRoot(projectId);
  const thumbnailPath = path.resolve(projectRoot, "thumbnails", `${videoId}.jpg`);

  ensureInsideRoot(projectRoot, thumbnailPath);

  if (!(await fileExists(thumbnailPath))) {
    throw new HttpError(404, "Thumbnail not found");
  }

  return thumbnailPath;
}

export function createThumbnailStream(filePath: string) {
  return createReadStream(filePath);
}
