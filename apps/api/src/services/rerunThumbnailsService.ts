import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { runOrchestrator } from "../analysis/orchestratorService.js";
import { collectExemplarVideoIds } from "./exportBundleService.js";
import { createScheduler } from "./taskScheduler.js";
import {
  buildCacheEntry,
  computeOcrConfigHash,
  loadCacheIndex,
  resolveCacheArtifactRelativePath,
  saveCacheIndex,
  updateVideoCacheEntry,
  type CacheEntry
} from "./exportCacheService.js";
import {
  recomputeThumbnailFeaturesForVideo,
  type ThumbnailDeterministicFeatures,
  type ThumbnailOcrEngine
} from "../derived/thumbnailFeaturesAgent.js";
import { hashFileSha1 } from "../utils/hash.js";
import { projectOperationLockService, ProjectLockError } from "./projectOperationLockService.js";

const RERUN_AUDIT_SCHEMA = "operations.rerun_thumbnails.v1";
const VALID_TIMEFRAMES = new Set(["1m", "6m", "1y"] as const);

export type RerunThumbnailsScope = "all" | "exemplars" | "selected";
export type RerunThumbnailsEngine = ThumbnailOcrEngine;
export type RerunThumbnailsJobStatus = "queued" | "running" | "done" | "failed";

export interface RerunThumbnailsRequest {
  projectId: string;
  scope: RerunThumbnailsScope;
  videoIds?: string[];
  engine: RerunThumbnailsEngine;
  force: boolean;
  rebuildAnalysis?: boolean;
}

export type RerunThumbnailsEvent =
  | {
      event: "job_started";
      data: {
        jobId: string;
        projectId: string;
        total: number;
        scope: RerunThumbnailsScope;
        engine: RerunThumbnailsEngine;
        force: boolean;
      };
    }
  | {
      event: "video_progress";
      data: {
        videoId: string;
        status: "processing" | "done" | "skipped" | "failed";
        message?: string;
      };
    }
  | {
      event: "job_progress";
      data: {
        completed: number;
        total: number;
        processed: number;
        skipped: number;
        failed: number;
      };
    }
  | { event: "warning"; data: { videoId?: string; message: string } }
  | {
      event: "job_done";
      data: {
        projectId: string;
        completed: number;
        total: number;
        processed: number;
        skipped: number;
        failed: number;
        auditArtifactPath: string;
        rebuildAnalysisRecommended: boolean;
        orchestratorRebuilt: boolean;
        orchestratorWarnings: string[];
      };
    }
  | { event: "job_failed"; data: { message: string } };

export interface RerunThumbnailsJobState {
  jobId: string;
  projectId: string;
  status: RerunThumbnailsJobStatus;
  total: number;
  completed: number;
  processed: number;
  skipped: number;
  failed: number;
  warnings: string[];
  error?: string;
  auditArtifactPath?: string;
  orchestratorRebuilt: boolean;
  orchestratorWarnings: string[];
}

interface RerunVideoInventoryItem {
  videoId: string;
  title: string;
  description: string;
  thumbnailLocalPath: string;
}

interface RerunProjectContext {
  projectRoot: string;
  channelId: string;
  channelName: string;
  timeframe: "1m" | "6m" | "1y";
  videos: RerunVideoInventoryItem[];
}

interface RerunVideoAuditRecord {
  videoId: string;
  status: "processed" | "skipped" | "failed";
  durationMs: number;
  reason?: string;
  error?: string;
  changedDeterministicFields?: string[];
}

interface RerunThumbnailsJobRecord extends RerunThumbnailsJobState {
  request: RerunThumbnailsRequest;
  events: RerunThumbnailsEvent[];
  listeners: Set<(event: RerunThumbnailsEvent) => void>;
  startedAt?: string;
  finishedAt?: string;
  videoErrors: Array<{ videoId: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeRelativePath(value: string | null, fallback: string): string {
  const candidate = (value ?? "").replace(/\\/g, "/").trim();
  if (!candidate) {
    return fallback;
  }
  if (path.isAbsolute(candidate)) {
    return fallback;
  }
  if (candidate === "." || candidate === ".." || candidate.startsWith("../") || candidate.includes("/../")) {
    return fallback;
  }
  return candidate;
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid project path");
  }
}

function getExportsRoot(): string {
  return path.resolve(process.cwd(), "exports");
}

function nowIso(): string {
  return new Date().toISOString();
}

function toTimestampToken(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readJsonlRecords(filePath: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(parsed)) {
      records.push(parsed);
    }
  }
  return records;
}

function extractTranscriptSnapshot(rows: Record<string, unknown>[]): { transcript: string; source: "captions" | "asr" | "none" } {
  let source: "captions" | "asr" | "none" = "none";
  const segments: string[] = [];

  for (const row of rows) {
    const type = toString(row.type);
    if (type === "meta") {
      const rowSource = toString(row.source);
      if (rowSource === "captions" || rowSource === "asr" || rowSource === "none") {
        source = rowSource;
      }
      continue;
    }

    if (type === "segment") {
      const text = toString(row.text);
      if (text) {
        segments.push(text);
      }
    }
  }

  return {
    transcript: segments.join(" ").trim(),
    source
  };
}

function extractDeterministicFeatures(source: Record<string, unknown> | null): ThumbnailDeterministicFeatures | null {
  if (!source) {
    return null;
  }
  const thumbnailFeatures = source.thumbnailFeatures;
  if (!isRecord(thumbnailFeatures)) {
    return null;
  }
  const deterministic = thumbnailFeatures.deterministic;
  if (!isRecord(deterministic)) {
    return null;
  }
  return deterministic as unknown as ThumbnailDeterministicFeatures;
}

function listChangedDeterministicFields(
  previous: ThumbnailDeterministicFeatures | null,
  next: ThumbnailDeterministicFeatures | null
): string[] {
  if (!previous || !next) {
    return [];
  }

  const prevRecord = previous as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  const allKeys = new Set<string>([...Object.keys(prevRecord), ...Object.keys(nextRecord)]);
  const changed: string[] = [];

  for (const key of allKeys) {
    const before = prevRecord[key];
    const after = nextRecord[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push(key);
    }
  }

  return changed.sort();
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

async function readProjectContext(projectId: string): Promise<RerunProjectContext> {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) {
    throw new Error("Invalid projectId");
  }
  if (
    normalizedProjectId.includes("/") ||
    normalizedProjectId.includes("\\") ||
    normalizedProjectId.includes("..") ||
    path.isAbsolute(normalizedProjectId)
  ) {
    throw new Error("Invalid projectId");
  }

  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, normalizedProjectId);
  ensureInsideRoot(exportsRoot, projectRoot);

  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stats = await fs.stat(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Project not found: ${normalizedProjectId}`);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`Project not found: ${normalizedProjectId}`);
  }

  const [channelJson, rawChannelJson, rawVideoRows] = await Promise.all([
    readJson(path.resolve(projectRoot, "channel.json")),
    readJson(path.resolve(projectRoot, "raw", "channel.json")),
    readJsonlRecords(path.resolve(projectRoot, "raw", "videos.jsonl"))
  ]);

  const channelId = toString(channelJson?.channelId) ?? toString(rawChannelJson?.channelId);
  const channelName = toString(channelJson?.channelName) ?? toString(rawChannelJson?.channelName);
  const timeframeRaw = toString(rawChannelJson?.timeframe) ?? toString(channelJson?.timeframe);

  if (!channelId) {
    throw new Error("Missing channelId in channel metadata");
  }
  if (!channelName) {
    throw new Error("Missing channelName in channel metadata");
  }
  if (!timeframeRaw || !VALID_TIMEFRAMES.has(timeframeRaw as "1m" | "6m" | "1y")) {
    throw new Error(`Invalid timeframe in channel metadata: ${String(timeframeRaw)}`);
  }

  const fromRaw = rawVideoRows
    .map((row) => {
      const videoId = toString(row.videoId);
      if (!videoId) {
        return null;
      }
      return {
        videoId,
        title: toString(row.title) ?? videoId,
        description: toString(row.description) ?? "",
        thumbnailLocalPath: normalizeRelativePath(
          toString(row.thumbnailLocalPath),
          path.posix.join("thumbnails", `${videoId}.jpg`)
        )
      } satisfies RerunVideoInventoryItem;
    })
    .filter((item): item is RerunVideoInventoryItem => item !== null);

  const channelVideos = Array.isArray(channelJson?.videos) ? channelJson.videos : [];
  const fromChannel = channelVideos
    .map((row) => {
      if (!isRecord(row)) {
        return null;
      }
      const videoId = toString(row.videoId);
      if (!videoId) {
        return null;
      }
      return {
        videoId,
        title: toString(row.title) ?? videoId,
        description: "",
        thumbnailLocalPath: normalizeRelativePath(toString(row.thumbnailPath), path.posix.join("thumbnails", `${videoId}.jpg`))
      } satisfies RerunVideoInventoryItem;
    })
    .filter((item): item is RerunVideoInventoryItem => item !== null);

  const unique = new Map<string, RerunVideoInventoryItem>();
  for (const item of fromRaw.length > 0 ? fromRaw : fromChannel) {
    if (!unique.has(item.videoId)) {
      unique.set(item.videoId, item);
    }
  }

  if (unique.size === 0) {
    throw new Error("No videos found in project inventory (raw/videos.jsonl or channel.json)");
  }

  return {
    projectRoot,
    channelId,
    channelName,
    timeframe: timeframeRaw as "1m" | "6m" | "1y",
    videos: Array.from(unique.values())
  };
}

async function resolveScopeVideoIds(input: {
  projectRoot: string;
  scope: RerunThumbnailsScope;
  selectedVideoIds?: string[];
  inventoryVideoIds: Set<string>;
}): Promise<string[]> {
  if (input.scope === "all") {
    return Array.from(input.inventoryVideoIds);
  }

  if (input.scope === "selected") {
    const selected = (input.selectedVideoIds ?? []).map((item) => item.trim()).filter(Boolean);
    if (selected.length === 0) {
      throw new Error("scope=selected requires at least one videoId");
    }
    return Array.from(new Set(selected.filter((videoId) => input.inventoryVideoIds.has(videoId))));
  }

  const orchestratorInput = await readJson(path.resolve(input.projectRoot, "analysis", "orchestrator_input.json"));
  if (!orchestratorInput) {
    throw new Error("scope=exemplars requires analysis/orchestrator_input.json");
  }

  const exemplars = collectExemplarVideoIds(orchestratorInput).filter((videoId) => input.inventoryVideoIds.has(videoId));
  return Array.from(new Set(exemplars));
}

function cloneJobState(record: RerunThumbnailsJobRecord): RerunThumbnailsJobState {
  return {
    jobId: record.jobId,
    projectId: record.projectId,
    status: record.status,
    total: record.total,
    completed: record.completed,
    processed: record.processed,
    skipped: record.skipped,
    failed: record.failed,
    warnings: [...record.warnings],
    error: record.error,
    auditArtifactPath: record.auditArtifactPath,
    orchestratorRebuilt: record.orchestratorRebuilt,
    orchestratorWarnings: [...record.orchestratorWarnings]
  };
}

class RerunThumbnailsJobService {
  private readonly jobs = new Map<string, RerunThumbnailsJobRecord>();

  createJob(request: RerunThumbnailsRequest): { jobId: string } {
    const jobId = randomUUID();
    try {
      projectOperationLockService.acquireOrThrow({
        projectId: request.projectId,
        operation: "rerun_thumbnails",
        ownerId: jobId
      });
    } catch (error) {
      if (error instanceof ProjectLockError) {
        throw error;
      }
      throw error;
    }

    const record: RerunThumbnailsJobRecord = {
      jobId,
      projectId: request.projectId,
      request,
      status: "queued",
      total: 0,
      completed: 0,
      processed: 0,
      skipped: 0,
      failed: 0,
      warnings: [],
      orchestratorRebuilt: false,
      orchestratorWarnings: [],
      videoErrors: [],
      events: [],
      listeners: new Set()
    };

    this.jobs.set(jobId, record);
    void this.runJob(record);
    return { jobId };
  }

  getJob(jobId: string): RerunThumbnailsJobState | null {
    const record = this.jobs.get(jobId);
    if (!record) {
      return null;
    }
    return cloneJobState(record);
  }

  getJobEvents(jobId: string): RerunThumbnailsEvent[] {
    const record = this.jobs.get(jobId);
    if (!record) {
      return [];
    }
    return [...record.events];
  }

  subscribe(jobId: string, listener: (event: RerunThumbnailsEvent) => void): () => void {
    const record = this.jobs.get(jobId);
    if (!record) {
      return () => undefined;
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private emit(record: RerunThumbnailsJobRecord, event: RerunThumbnailsEvent): void {
    record.events.push(event);
    for (const listener of record.listeners) {
      listener(event);
    }
  }

  private pushWarning(record: RerunThumbnailsJobRecord, message: string, videoId?: string): void {
    record.warnings.push(message);
    this.emit(record, {
      event: "warning",
      data: {
        ...(videoId ? { videoId } : {}),
        message
      }
    });
  }

  private emitProgress(record: RerunThumbnailsJobRecord): void {
    this.emit(record, {
      event: "job_progress",
      data: {
        completed: record.completed,
        total: record.total,
        processed: record.processed,
        skipped: record.skipped,
        failed: record.failed
      }
    });
  }

  private async runJob(record: RerunThumbnailsJobRecord): Promise<void> {
    record.status = "running";
    record.startedAt = nowIso();

    try {
      const project = await readProjectContext(record.request.projectId);
      const videoById = new Map(project.videos.map((video) => [video.videoId, video]));
      const inventoryVideoIds = new Set(project.videos.map((video) => video.videoId));

      const requestedVideoIds = await resolveScopeVideoIds({
        projectRoot: project.projectRoot,
        scope: record.request.scope,
        selectedVideoIds: record.request.videoIds,
        inventoryVideoIds
      });

      if (requestedVideoIds.length === 0) {
        throw new Error("No videos selected for this rerun scope");
      }

      const resolvedEngine: "python" | "tesseractjs" =
        record.request.engine === "auto" ? (env.thumbOcrEngine === "tesseractjs" ? "tesseractjs" : "python") : record.request.engine;
      const ocrConfigHash = computeOcrConfigHash({
        engine: resolvedEngine,
        langs: env.thumbOcrLangs,
        downscaleWidth: env.thumbVisionDownscaleWidth
      });

      const scheduler = createScheduler({
        video: Math.max(1, env.exportVideoConcurrency),
        http: 1,
        asr: 1,
        ocr: Math.max(1, env.exportOcrConcurrency),
        llm: 1,
        embeddings: 1,
        fs: Math.max(1, env.exportFsConcurrency)
      });

      record.total = requestedVideoIds.length;
      this.emit(record, {
        event: "job_started",
        data: {
          jobId: record.jobId,
          projectId: record.projectId,
          total: record.total,
          scope: record.request.scope,
          engine: record.request.engine,
          force: record.request.force
        }
      });

      const cacheIndex = await loadCacheIndex({
        exportsRoot: getExportsRoot(),
        channelFolderPath: project.projectRoot,
        channelId: project.channelId,
        exportVersion: "1.1"
      });

      const rerunStartedAtMs = Date.now();
      const backupFolderRoot = path.resolve(
        project.projectRoot,
        "derived",
        "video_features",
        "_backup",
        toTimestampToken(record.startedAt)
      );
      ensureInsideRoot(project.projectRoot, backupFolderRoot);

      const videoAudits: RerunVideoAuditRecord[] = [];
      let cacheSaveChain = Promise.resolve();

      const enqueueCacheUpdate = async (videoId: string, entry: CacheEntry) => {
        cacheSaveChain = cacheSaveChain.then(async () => {
          updateVideoCacheEntry({
            index: cacheIndex,
            timeframe: project.timeframe,
            videoId,
            entry
          });
          await saveCacheIndex({
            exportsRoot: getExportsRoot(),
            channelFolderPath: project.projectRoot,
            index: cacheIndex
          });
        });
        await cacheSaveChain;
      };

      await Promise.all(
        requestedVideoIds.map((videoId) =>
          scheduler.runVideo(videoId, async () => {
            const startedAtMs = Date.now();
            this.emit(record, {
              event: "video_progress",
              data: { videoId, status: "processing" }
            });

            const video = videoById.get(videoId);
            if (!video) {
              const message = "Video missing from inventory";
              record.failed += 1;
              record.completed += 1;
              record.videoErrors.push({ videoId, message });
              videoAudits.push({
                videoId,
                status: "failed",
                durationMs: Date.now() - startedAtMs,
                error: message
              });
              this.pushWarning(record, message, videoId);
              this.emit(record, {
                event: "video_progress",
                data: { videoId, status: "failed", message }
              });
              this.emitProgress(record);
              return;
            }

            const thumbnailRelativePath = normalizeRelativePath(
              video.thumbnailLocalPath,
              path.posix.join("thumbnails", `${video.videoId}.jpg`)
            );
            const thumbnailAbsPath = path.resolve(project.projectRoot, thumbnailRelativePath);
            ensureInsideRoot(project.projectRoot, thumbnailAbsPath);

            const derivedArtifactAbsPath = path.resolve(
              project.projectRoot,
              "derived",
              "video_features",
              `${video.videoId}.json`
            );
            ensureInsideRoot(project.projectRoot, derivedArtifactAbsPath);

            if (!(await fileExists(thumbnailAbsPath))) {
              const message = `Thumbnail not found at ${thumbnailRelativePath}`;
              record.failed += 1;
              record.completed += 1;
              record.videoErrors.push({ videoId, message });
              videoAudits.push({
                videoId,
                status: "failed",
                durationMs: Date.now() - startedAtMs,
                error: message
              });
              this.pushWarning(record, message, videoId);
              this.emit(record, {
                event: "video_progress",
                data: { videoId, status: "failed", message }
              });
              this.emitProgress(record);
              return;
            }

            const [existingArtifact, thumbnailHash] = await Promise.all([
              readJson(derivedArtifactAbsPath),
              hashFileSha1(thumbnailAbsPath)
            ]);
            const existingDeterministic = extractDeterministicFeatures(existingArtifact);
            const existingEntry = cacheIndex.timeframes[project.timeframe]?.videos?.[video.videoId];

            const hasDerivedThumbnail = Boolean(existingDeterministic);
            const unchangedByCache =
              !record.request.force &&
              hasDerivedThumbnail &&
              Boolean(existingEntry) &&
              existingEntry?.inputs.thumbnailHash === thumbnailHash &&
              existingEntry?.inputs.ocrConfigHash === ocrConfigHash;

            if (unchangedByCache) {
              record.skipped += 1;
              record.completed += 1;
              videoAudits.push({
                videoId,
                status: "skipped",
                durationMs: Date.now() - startedAtMs,
                reason: "thumbnailHash and ocrConfigHash unchanged"
              });
              this.emit(record, {
                event: "video_progress",
                data: {
                  videoId,
                  status: "skipped",
                  message: "Cache unchanged (thumbnailHash + ocrConfigHash)"
                }
              });
              this.emitProgress(record);
              return;
            }

            try {
              if (existingArtifact) {
                const backupPath = path.resolve(backupFolderRoot, `${video.videoId}.json`);
                ensureInsideRoot(project.projectRoot, backupPath);
                await scheduler.run("fs", async () => {
                  await fs.mkdir(path.dirname(backupPath), { recursive: true });
                  await fs.copyFile(derivedArtifactAbsPath, backupPath);
                });
              }

              const derived = await scheduler.run("ocr", () =>
                recomputeThumbnailFeaturesForVideo({
                  exportsRoot: getExportsRoot(),
                  channelFolderPath: project.projectRoot,
                  videoId: video.videoId,
                  title: video.title,
                  thumbnailAbsPath,
                  thumbnailLocalPath: thumbnailRelativePath,
                  engine: record.request.engine,
                  deterministicMode: "full",
                  recomputeLlm: false
                })
              );

              const nextDeterministic = extractDeterministicFeatures(derived.mergedBundle as unknown as Record<string, unknown>);
              const changedDeterministicFields = listChangedDeterministicFields(existingDeterministic, nextDeterministic);

              if (existingEntry) {
                const updatedEntry: CacheEntry = {
                  ...existingEntry,
                  lastUpdatedAt: nowIso(),
                  inputs: {
                    ...existingEntry.inputs,
                    thumbnailHash,
                    ocrConfigHash
                  },
                  artifacts: {
                    ...existingEntry.artifacts,
                    derivedVideoFeaturesPath: resolveCacheArtifactRelativePath({
                      channelFolderPath: project.projectRoot,
                      artifactAbsolutePath: derived.artifactAbsolutePath
                    })
                  },
                  status: {
                    ...existingEntry.status,
                    thumbnail: "ok",
                    derived: record.request.force ? "partial" : existingEntry.status.derived,
                    warnings: Array.from(new Set([...(existingEntry.status.warnings ?? []), ...derived.warnings]))
                  }
                };
                await enqueueCacheUpdate(video.videoId, updatedEntry);
              } else {
                const transcriptRows = await readJsonlRecords(
                  path.resolve(project.projectRoot, "raw", "transcripts", `${video.videoId}.jsonl`)
                );
                const transcriptSnapshot = extractTranscriptSnapshot(transcriptRows);
                const createdEntry = buildCacheEntry({
                  videoId: video.videoId,
                  hashes: {
                    titleHash: "",
                    descriptionHash: "",
                    thumbnailHash,
                    transcriptHash: "",
                    transcriptSource: transcriptSnapshot.source,
                    asrConfigHash: "",
                    ocrConfigHash,
                    embeddingModel: "text-embedding-3-small",
                    llmModels: {
                      title: "",
                      description: "",
                      transcript: "",
                      thumbnail: ""
                    }
                  },
                  artifacts: {
                    rawTranscriptPath: path.posix.join("raw", "transcripts", `${video.videoId}.jsonl`),
                    thumbnailPath: thumbnailRelativePath,
                    derivedVideoFeaturesPath: resolveCacheArtifactRelativePath({
                      channelFolderPath: project.projectRoot,
                      artifactAbsolutePath: derived.artifactAbsolutePath
                    })
                  },
                  status: {
                    rawTranscript: transcriptRows.length > 0 ? "ok" : "missing",
                    thumbnail: "ok",
                    derived: "partial",
                    warnings: [...derived.warnings]
                  }
                });
                await enqueueCacheUpdate(video.videoId, createdEntry);
              }

              for (const warning of derived.warnings) {
                this.pushWarning(record, warning, videoId);
              }

              record.processed += 1;
              record.completed += 1;
              videoAudits.push({
                videoId,
                status: "processed",
                durationMs: Date.now() - startedAtMs,
                changedDeterministicFields
              });
              this.emit(record, {
                event: "video_progress",
                data: {
                  videoId,
                  status: "done",
                  message:
                    changedDeterministicFields.length > 0
                      ? `Updated deterministic fields: ${changedDeterministicFields.join(", ")}`
                      : "thumbnailFeatures refreshed"
                }
              });
              this.emitProgress(record);
            } catch (error) {
              const message = error instanceof Error ? error.message : "unknown thumbnail rerun error";
              record.failed += 1;
              record.completed += 1;
              record.videoErrors.push({ videoId, message });
              videoAudits.push({
                videoId,
                status: "failed",
                durationMs: Date.now() - startedAtMs,
                error: message
              });
              this.pushWarning(record, `Rerun failed for ${videoId}: ${message}`, videoId);
              this.emit(record, {
                event: "video_progress",
                data: { videoId, status: "failed", message }
              });
              this.emitProgress(record);
            }
          })
        )
      );

      const orchestratorWarnings: string[] = [];
      let orchestratorRebuilt = false;
      if (record.request.rebuildAnalysis) {
        try {
          const orchestratorResult = await runOrchestrator({
            exportRoot: getExportsRoot(),
            channelId: project.channelId,
            channelName: project.channelName,
            timeframe: project.timeframe,
            jobId: randomUUID()
          });
          orchestratorRebuilt = true;
          orchestratorWarnings.push(...orchestratorResult.warnings);
        } catch (error) {
          const warning = `Rebuild analysis failed: ${error instanceof Error ? error.message : "unknown error"}`;
          orchestratorWarnings.push(warning);
          this.pushWarning(record, warning);
        }
      }

      record.orchestratorRebuilt = orchestratorRebuilt;
      record.orchestratorWarnings = orchestratorWarnings;

      const finishedAt = nowIso();
      record.finishedAt = finishedAt;
      const auditRelativePath = path.posix.join("operations", "reruns", `thumbnails_${toTimestampToken(finishedAt)}.json`);
      const auditAbsPath = path.resolve(project.projectRoot, auditRelativePath);
      ensureInsideRoot(project.projectRoot, auditAbsPath);
      await fs.mkdir(path.dirname(auditAbsPath), { recursive: true });

      const audit = {
        schemaVersion: RERUN_AUDIT_SCHEMA,
        projectId: record.projectId,
        jobId: record.jobId,
        startedAt: record.startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.now() - rerunStartedAtMs),
        scope: record.request.scope,
        engine: {
          requested: record.request.engine,
          resolved: resolvedEngine
        },
        ocrConfigHash,
        force: record.request.force,
        videoIds: requestedVideoIds,
        counts: {
          total: record.total,
          completed: record.completed,
          processed: record.processed,
          skipped: record.skipped,
          failed: record.failed,
          success: Math.max(0, record.processed + record.skipped)
        },
        orchestrator: {
          requested: Boolean(record.request.rebuildAnalysis),
          rebuilt: orchestratorRebuilt,
          warnings: orchestratorWarnings
        },
        errors: [...record.videoErrors],
        warnings: [...record.warnings],
        videos: videoAudits
      };

      await writeJsonAtomic(auditAbsPath, audit);
      record.auditArtifactPath = auditRelativePath;
      record.status = "done";

      this.emit(record, {
        event: "job_done",
        data: {
          projectId: record.projectId,
          completed: record.completed,
          total: record.total,
          processed: record.processed,
          skipped: record.skipped,
          failed: record.failed,
          auditArtifactPath: auditRelativePath,
          rebuildAnalysisRecommended: !orchestratorRebuilt,
          orchestratorRebuilt,
          orchestratorWarnings
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "thumbnail rerun failed";
      record.status = "failed";
      record.error = message;
      this.emit(record, {
        event: "job_failed",
        data: { message }
      });
    } finally {
      projectOperationLockService.release({
        projectId: record.projectId,
        ownerId: record.jobId
      });
    }
  }
}

export const rerunThumbnailsJobService = new RerunThumbnailsJobService();

export function toRerunLockHttpError(error: unknown): { statusCode: number; message: string } | null {
  if (error instanceof ProjectLockError) {
    return {
      statusCode: 409,
      message: `Project is busy with ${error.conflict.currentOperation} (${error.conflict.currentOwnerId}). Try again later.`
    };
  }
  return null;
}
