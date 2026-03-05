import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { ZipFile } from "yazl";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

type ExportJobStatus = "done" | "failed";

type RawVideosMode = "full" | "extract" | "missing";

interface JobSummary {
  jobId: string;
  status: ExportJobStatus;
  startedAt: string;
  finishedAt: string;
}

interface BundleFileRecord {
  path: string;
  sizeBytes: number;
  source: "export" | "generated";
}

interface MissingFileRecord {
  path: string;
  reason: string;
}

interface BundleDownloadEntry {
  sourceAbsolutePath: string;
  path: string;
  sizeBytes: number;
}

interface ChannelMetaRecord {
  channelId: string | null;
  exportedAt: string | null;
  timeframe: string | null;
  timeframeResolved: Record<string, unknown> | null;
}

interface PreparedBundlePlan {
  projectId: string;
  channelId: string | null;
  exportJobId: string;
  exportedAt: string | null;
  timeframe: string | null;
  timeframeResolved: Record<string, unknown> | null;
  rawVideosMode: RawVideosMode;
  rawVideosEntryPath: string | null;
  exemplarVideoIds: string[];
  downloadEntries: BundleDownloadEntry[];
  includedFiles: BundleFileRecord[];
  missingFiles: MissingFileRecord[];
  bundleJson: Record<string, unknown>;
  missingFilesNote: Record<string, unknown> | null;
  estimatedSizeBytes: number;
  successfulJobIds: string[];
  tempPaths: string[];
}

export interface ProjectBundleMetaResponse {
  projectId: string;
  channelId: string | null;
  exportJobId: string;
  exportedAt: string | null;
  timeframe: string | null;
  timeframeResolved: Record<string, unknown> | null;
  rawVideosMode: RawVideosMode;
  rawVideosEntryPath: string | null;
  exemplarVideoIds: string[];
  includedFiles: BundleFileRecord[];
  missingFiles: MissingFileRecord[];
  estimatedSizeBytes: number;
  estimatedSizeMb: number;
  confirmationThresholdMb: number;
  confirmationRequired: boolean;
  availableSuccessfulExportJobIds: string[];
}

export interface PreparedBundleDownload {
  projectId: string;
  exportJobId: string;
  channelId: string | null;
  fileName: string;
  stream: Readable;
  estimate: ProjectBundleMetaResponse;
  cleanup: () => Promise<void>;
}

interface BundleSelectorInput {
  projectId: string;
  exportSelector?: string | null;
  explicitExportJobId?: string | null;
}

interface BuildPlanOptions extends BundleSelectorInput {
  includeGeneratedFiles: boolean;
}

interface RawVideosExtractSummary {
  sizeBytes: number;
  rows: number;
  invalidLines: number;
}

interface VideosExtractRecord {
  videoId: string | null;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  tags: string[];
  categoryId: string | null;
  defaultLanguage: string | null;
  transcriptStatus: string | null;
  transcriptSource: string | null;
}

interface OrchestratorInputLike {
  exemplars?: {
    top_videos?: unknown;
    bottom_videos?: unknown;
    mid_videos?: unknown;
  };
}

const BUNDLE_SCHEMA_VERSION = "analysis.cross_channel_bundle.v1";

const STANDARD_SOURCE_FILES: Array<{
  sourcePath: string;
  bundlePath: string;
  required: boolean;
}> = [
  {
    sourcePath: path.join("analysis", "orchestrator_input.json"),
    bundlePath: path.posix.join("analysis", "orchestrator_input.json"),
    required: true
  },
  {
    sourcePath: "channel.json",
    bundlePath: path.posix.join("primary", "channel.json"),
    required: false
  },
  {
    sourcePath: "manifest.json",
    bundlePath: path.posix.join("primary", "manifest.json"),
    required: false
  },
  {
    sourcePath: path.join("raw", "channel.json"),
    bundlePath: path.posix.join("raw", "channel.json"),
    required: false
  }
];

const KEY_VIDEO_FEATURES_FOLDER = path.join("derived", "video_features");

function toPosixPath(input: string): string {
  return input.split(path.sep).join(path.posix.sep);
}

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

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
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

async function tryReadFileStats(filePath: string): Promise<{ exists: boolean; sizeBytes: number }> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return { exists: false, sizeBytes: 0 };
    }
    return { exists: true, sizeBytes: stats.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, sizeBytes: 0 };
    }
    throw error;
  }
}

async function resolveProjectRoot(projectId: string): Promise<string> {
  validatePathSegment(projectId, "projectId");
  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, projectId);
  ensureInsideRoot(exportsRoot, projectRoot);
  try {
    const stats = await fs.stat(projectRoot);
    if (!stats.isDirectory()) {
      throw new HttpError(404, "Project not found");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HttpError(404, "Project not found");
    }
    throw error;
  }
  return projectRoot;
}

async function readJobSummaries(projectRoot: string): Promise<JobSummary[]> {
  const logsRoot = path.resolve(projectRoot, "logs");
  let entries: Array<{ name: string; isFile: boolean }> = [];

  try {
    const dirEntries = await fs.readdir(logsRoot, { withFileTypes: true });
    entries = dirEntries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const summaries: JobSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile) {
      continue;
    }
    const match = entry.name.match(/^job_(.+)\.summary\.json$/);
    if (!match) {
      continue;
    }
    const summaryPath = path.resolve(logsRoot, entry.name);
    const parsed = await readJsonFile<Record<string, unknown>>(summaryPath);
    if (!parsed) {
      continue;
    }

    const status = parsed.status;
    if (status !== "done" && status !== "failed") {
      continue;
    }
    const jobId = toStringOrNull(parsed.jobId) ?? match[1];
    summaries.push({
      jobId,
      status,
      startedAt: toStringOrNull(parsed.startedAt) ?? "",
      finishedAt: toStringOrNull(parsed.finishedAt) ?? ""
    });
  }

  summaries.sort((a, b) => {
    const aTime = new Date(a.finishedAt || a.startedAt || 0).getTime();
    const bTime = new Date(b.finishedAt || b.startedAt || 0).getTime();
    return bTime - aTime;
  });
  return summaries;
}

function pickTargetJob(input: {
  summaries: JobSummary[];
  explicitExportJobId?: string | null;
  exportSelector?: string | null;
}): { targetJobId: string; successfulJobIds: string[] } {
  const successful = input.summaries.filter((summary) => summary.status === "done");
  const successfulJobIds = successful.map((summary) => summary.jobId);

  const requestedJobId = input.explicitExportJobId ?? input.exportSelector;
  if (requestedJobId && requestedJobId !== "latest") {
    validatePathSegment(requestedJobId, "exportJobId");
    const selected = input.summaries.find((summary) => summary.jobId === requestedJobId);
    if (!selected) {
      throw new HttpError(404, `Export job not found: ${requestedJobId}`);
    }
    if (selected.status !== "done") {
      throw new HttpError(409, `Export job is not successful: ${requestedJobId}`);
    }
    return {
      targetJobId: requestedJobId,
      successfulJobIds
    };
  }

  const latestSuccessful = successful[0];
  if (!latestSuccessful) {
    throw new HttpError(409, "No successful export job found for this project");
  }

  return {
    targetJobId: latestSuccessful.jobId,
    successfulJobIds
  };
}

function readChannelMeta(channelJson: Record<string, unknown> | null, manifestJson: Record<string, unknown> | null): ChannelMetaRecord {
  const timeframeResolved = channelJson?.timeframeResolved;
  return {
    channelId: toStringOrNull(channelJson?.channelId) ?? toStringOrNull(manifestJson?.channelId),
    exportedAt: toStringOrNull(channelJson?.exportedAt) ?? toStringOrNull(manifestJson?.exportedAt),
    timeframe: toStringOrNull(channelJson?.timeframe),
    timeframeResolved: isRecord(timeframeResolved) ? timeframeResolved : null
  };
}

export function collectExemplarVideoIds(orchestratorInput: unknown): string[] {
  if (!isRecord(orchestratorInput)) {
    return [];
  }
  const exemplars = (orchestratorInput as OrchestratorInputLike).exemplars;
  if (!exemplars || !isRecord(exemplars)) {
    return [];
  }

  const groups = [exemplars.top_videos, exemplars.bottom_videos, exemplars.mid_videos];
  const unique = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) {
      continue;
    }
    for (const item of group) {
      if (!isRecord(item)) {
        continue;
      }
      const videoId = toStringOrNull(item.videoId);
      if (videoId) {
        unique.add(videoId);
      }
    }
  }
  return Array.from(unique);
}

export function toVideosExtractRecord(input: unknown): VideosExtractRecord {
  const row = isRecord(input) ? input : {};
  const stats = isRecord(row.statistics) ? row.statistics : {};
  const transcriptRef = isRecord(row.transcriptRef) ? row.transcriptRef : {};

  return {
    videoId: toStringOrNull(row.videoId),
    title: toStringOrNull(row.title),
    publishedAt: toStringOrNull(row.publishedAt),
    durationSec: toNumberOrNull(row.durationSec),
    viewCount: toNumberOrNull(stats.viewCount),
    likeCount: toNumberOrNull(stats.likeCount),
    commentCount: toNumberOrNull(stats.commentCount),
    tags: asStringArray(row.tags),
    categoryId: toStringOrNull(row.categoryId),
    defaultLanguage: toStringOrNull(row.defaultLanguage),
    transcriptStatus: toStringOrNull(transcriptRef.transcriptStatus),
    transcriptSource: toStringOrNull(transcriptRef.transcriptSource)
  };
}

async function createVideosExtract(input: {
  rawVideosPath: string;
  outputPath?: string;
}): Promise<RawVideosExtractSummary> {
  const inputStream = createReadStream(input.rawVideosPath, { encoding: "utf-8" });
  const lineReader = createInterface({
    input: inputStream,
    crlfDelay: Infinity
  });
  const output = input.outputPath ? createWriteStream(input.outputPath, { encoding: "utf-8" }) : null;

  let sizeBytes = 0;
  let rows = 0;
  let invalidLines = 0;

  for await (const line of lineReader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      invalidLines += 1;
      continue;
    }
    const extract = toVideosExtractRecord(parsed);
    const jsonLine = `${JSON.stringify(extract)}\n`;
    sizeBytes += Buffer.byteLength(jsonLine);
    rows += 1;
    if (output && !output.write(jsonLine)) {
      await once(output, "drain");
    }
  }

  if (output) {
    output.end();
    await once(output, "finish");
  }

  return {
    sizeBytes,
    rows,
    invalidLines
  };
}

function buildMissingFilesNote(missingFiles: MissingFileRecord[]): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    missingCount: missingFiles.length,
    files: missingFiles
  };
}

async function buildPlan(options: BuildPlanOptions): Promise<PreparedBundlePlan> {
  const projectRoot = await resolveProjectRoot(options.projectId);
  const summaries = await readJobSummaries(projectRoot);
  const { targetJobId, successfulJobIds } = pickTargetJob({
    summaries,
    explicitExportJobId: options.explicitExportJobId,
    exportSelector: options.exportSelector
  });

  const includedFiles: BundleFileRecord[] = [];
  const missingFiles: MissingFileRecord[] = [];
  const downloadEntries: BundleDownloadEntry[] = [];
  const tempPaths: string[] = [];

  const rememberMissing = (filePath: string, reason: string) => {
    missingFiles.push({ path: filePath, reason });
  };

  const includeAbsoluteFile = (absolutePath: string, bundlePath: string, sizeBytes: number, source: "export" | "generated") => {
    includedFiles.push({
      path: bundlePath,
      sizeBytes,
      source
    });
    downloadEntries.push({
      sourceAbsolutePath: absolutePath,
      path: bundlePath,
      sizeBytes
    });
  };

  for (const item of STANDARD_SOURCE_FILES) {
    const sourceAbsPath = path.resolve(projectRoot, item.sourcePath);
    ensureInsideRoot(projectRoot, sourceAbsPath);
    const stats = await tryReadFileStats(sourceAbsPath);
    if (!stats.exists) {
      if (item.required) {
        throw new HttpError(409, `Required artifact missing for bundle: ${toPosixPath(item.sourcePath)}`);
      }
      rememberMissing(item.bundlePath, "source file not found");
      continue;
    }
    includeAbsoluteFile(sourceAbsPath, item.bundlePath, stats.sizeBytes, "export");
  }

  const orchestratorPath = path.resolve(projectRoot, "analysis", "orchestrator_input.json");
  const orchestratorContent = await readJsonFile<OrchestratorInputLike>(orchestratorPath);
  if (!orchestratorContent || !isRecord(orchestratorContent)) {
    throw new HttpError(409, "Required artifact analysis/orchestrator_input.json is missing or invalid");
  }
  const exemplarVideoIds = collectExemplarVideoIds(orchestratorContent);

  for (const videoId of exemplarVideoIds) {
    const sourceAbsPath = path.resolve(projectRoot, KEY_VIDEO_FEATURES_FOLDER, `${videoId}.json`);
    ensureInsideRoot(projectRoot, sourceAbsPath);
    const stats = await tryReadFileStats(sourceAbsPath);
    const bundlePath = path.posix.join("derived", "video_features", `${videoId}.json`);
    if (!stats.exists) {
      rememberMissing(bundlePath, `video feature missing for exemplar videoId=${videoId}`);
      continue;
    }
    includeAbsoluteFile(sourceAbsPath, bundlePath, stats.sizeBytes, "export");
  }

  const rawVideosPath = path.resolve(projectRoot, "raw", "videos.jsonl");
  const rawVideosStats = await tryReadFileStats(rawVideosPath);
  let rawVideosMode: RawVideosMode = "missing";
  let rawVideosEntryPath: string | null = null;

  if (!rawVideosStats.exists) {
    rememberMissing("raw/videos.jsonl", "source file not found");
  } else {
    const extractThresholdBytes = env.exportBundleRawVideosMaxBytes;
    if (rawVideosStats.sizeBytes <= extractThresholdBytes) {
      rawVideosMode = "full";
      rawVideosEntryPath = "raw/videos.jsonl";
      includeAbsoluteFile(rawVideosPath, rawVideosEntryPath, rawVideosStats.sizeBytes, "export");
    } else {
      rawVideosMode = "extract";
      rawVideosEntryPath = "raw/videos.extract.jsonl";
      if (options.includeGeneratedFiles) {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-bundle-"));
        const extractPath = path.resolve(tempDir, "videos.extract.jsonl");
        const summary = await createVideosExtract({
          rawVideosPath,
          outputPath: extractPath
        });
        tempPaths.push(tempDir);
        includeAbsoluteFile(extractPath, rawVideosEntryPath, summary.sizeBytes, "generated");
      } else {
        const summary = await createVideosExtract({
          rawVideosPath
        });
        includeAbsoluteFile("__estimate_only__", rawVideosEntryPath, summary.sizeBytes, "generated");
        downloadEntries.pop();
      }
    }
  }

  const channelJson = await readJsonFile<Record<string, unknown>>(path.resolve(projectRoot, "channel.json"));
  const manifestJson = await readJsonFile<Record<string, unknown>>(path.resolve(projectRoot, "manifest.json"));
  const channelMeta = readChannelMeta(channelJson, manifestJson);

  const missingFilesNote = missingFiles.length > 0 ? buildMissingFilesNote(missingFiles) : null;
  const bundleJson = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    projectId: options.projectId,
    channelId: channelMeta.channelId,
    exportJobId: targetJobId,
    exportedAt: channelMeta.exportedAt,
    timeframe: channelMeta.timeframe,
    timeframeResolved: channelMeta.timeframeResolved,
    rawVideosMode,
    rawVideosEntryPath,
    thresholds: {
      rawVideosExtractThresholdBytes: env.exportBundleRawVideosMaxBytes,
      confirmationThresholdMb: env.exportBundleConfirmThresholdMb
    },
    exemplarVideoIds,
    filesIncluded: includedFiles,
    filesMissing: missingFiles
  };

  const bundleJsonSizeBytes = Buffer.byteLength(`${JSON.stringify(bundleJson, null, 2)}\n`);
  const missingNoteSizeBytes = missingFilesNote ? Buffer.byteLength(`${JSON.stringify(missingFilesNote, null, 2)}\n`) : 0;

  const estimatedSizeBytes =
    includedFiles.reduce((acc, item) => acc + item.sizeBytes, 0) + bundleJsonSizeBytes + missingNoteSizeBytes;

  if (options.includeGeneratedFiles) {
    const filtered = downloadEntries.filter((entry) => entry.sourceAbsolutePath !== "__estimate_only__");
    downloadEntries.length = 0;
    downloadEntries.push(...filtered);
  }

  return {
    projectId: options.projectId,
    channelId: channelMeta.channelId,
    exportJobId: targetJobId,
    exportedAt: channelMeta.exportedAt,
    timeframe: channelMeta.timeframe,
    timeframeResolved: channelMeta.timeframeResolved,
    rawVideosMode,
    rawVideosEntryPath,
    exemplarVideoIds,
    downloadEntries,
    includedFiles,
    missingFiles,
    bundleJson,
    missingFilesNote,
    estimatedSizeBytes,
    tempPaths,
    successfulJobIds
  };
}

function toMetaResponse(plan: PreparedBundlePlan): ProjectBundleMetaResponse {
  const estimatedSizeMb = Number((plan.estimatedSizeBytes / (1024 * 1024)).toFixed(2));
  return {
    projectId: plan.projectId,
    channelId: plan.channelId,
    exportJobId: plan.exportJobId,
    exportedAt: plan.exportedAt,
    timeframe: plan.timeframe,
    timeframeResolved: plan.timeframeResolved,
    rawVideosMode: plan.rawVideosMode,
    rawVideosEntryPath: plan.rawVideosEntryPath,
    exemplarVideoIds: plan.exemplarVideoIds,
    includedFiles: plan.includedFiles,
    missingFiles: plan.missingFiles,
    estimatedSizeBytes: plan.estimatedSizeBytes,
    estimatedSizeMb,
    confirmationThresholdMb: env.exportBundleConfirmThresholdMb,
    confirmationRequired: estimatedSizeMb >= env.exportBundleConfirmThresholdMb,
    availableSuccessfulExportJobIds: plan.successfulJobIds
  };
}

async function cleanupPaths(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (targetPath) => {
      try {
        await fs.rm(targetPath, { recursive: true, force: true });
      } catch {
        // cleanup best effort
      }
    })
  );
}

function createBundleFileName(projectId: string, exportJobId: string): string {
  const safeProjectId = safeFileName(projectId);
  const safeJobId = safeFileName(exportJobId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `bundle_${safeProjectId}_${safeJobId}_${timestamp}.zip`;
}

export async function getProjectBundleMeta(input: BundleSelectorInput): Promise<ProjectBundleMetaResponse> {
  const plan = await buildPlan({
    ...input,
    includeGeneratedFiles: false
  });
  try {
    return toMetaResponse(plan);
  } finally {
    await cleanupPaths(plan.tempPaths);
  }
}

export async function prepareProjectBundleDownload(input: BundleSelectorInput): Promise<PreparedBundleDownload> {
  const plan = await buildPlan({
    ...input,
    includeGeneratedFiles: true
  });
  const zip = new ZipFile();
  const stream = new PassThrough();
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await cleanupPaths(plan.tempPaths);
  };

  zip.addBuffer(Buffer.from(`${JSON.stringify(plan.bundleJson, null, 2)}\n`, "utf-8"), "bundle.json");
  if (plan.missingFilesNote) {
    zip.addBuffer(Buffer.from(`${JSON.stringify(plan.missingFilesNote, null, 2)}\n`, "utf-8"), "notes/missing_files.json");
  }
  for (const entry of plan.downloadEntries) {
    zip.addFile(entry.sourceAbsolutePath, entry.path);
  }

  zip.outputStream.on("error", () => {
    void cleanup();
  });
  stream.on("close", () => {
    void cleanup();
  });
  stream.on("end", () => {
    void cleanup();
  });
  stream.on("error", () => {
    void cleanup();
  });

  zip.outputStream.pipe(stream);
  zip.end();

  return {
    projectId: plan.projectId,
    exportJobId: plan.exportJobId,
    channelId: plan.channelId,
    fileName: createBundleFileName(plan.projectId, plan.exportJobId),
    stream,
    estimate: toMetaResponse(plan),
    cleanup
  };
}
