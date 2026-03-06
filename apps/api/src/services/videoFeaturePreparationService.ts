import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { loadTranscriptJsonl } from "../derived/transcriptArtifacts.js";
import type { Timeframe } from "../types.js";
import { HttpError } from "../utils/errors.js";
import { fileExists } from "../utils/fileExists.js";
import { downloadToBuffer } from "../utils/http.js";
import { sanitizeTranscript } from "../utils/transcript.js";
import { downloadAudioWithLocalAsr } from "./localAsrService.js";
import type { LocalAsrStage } from "./localAsrService.js";
import { buildTranscriptArtifactRecords } from "./transcriptArtifactService.js";
import { getTranscriptWithFallback } from "./transcriptPipeline.js";
import type { TranscriptPipelineResult } from "./transcriptPipeline.js";

export type VideoFeatureKind = "thumbnail" | "title" | "description" | "transcript";
export type VideoFeatureRerunMode = "collect_assets" | "prepare" | "full";

const THUMBNAIL_RESOLUTION_PRIORITY = ["maxres", "standard", "high", "medium", "default"] as const;
const THUMBNAIL_FILENAME_FALLBACKS = [
  "maxresdefault.jpg",
  "sddefault.jpg",
  "hqdefault.jpg",
  "mqdefault.jpg",
  "default.jpg"
] as const;

export interface ChannelContext {
  projectRoot: string;
  exportsRoot: string;
  channelId: string;
  exportVersion: string;
  timeframe: Timeframe;
}

export interface RawVideoTranscriptRef {
  transcriptPath: string;
  transcriptSource: "captions" | "asr" | "none";
  transcriptStatus: "ok" | "missing" | "error";
}

export interface RawVideoRecord {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationSec: number | undefined;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
  audioLocalPath?: string;
  thumbnailLocalPath?: string;
  thumbnailOriginalUrl?: string;
  thumbnails?: Partial<Record<(typeof THUMBNAIL_RESOLUTION_PRIORITY)[number], { url: string }>>;
  transcriptRef: RawVideoTranscriptRef;
}

export interface PreparedFeatureAssets {
  audioPath: string | null;
  transcriptPath: string;
  thumbnailPath: string;
}

export interface PreparedVideoFeatureInputs {
  warnings: string[];
  stepsExecuted: string[];
  languageHint: "auto" | "en" | "es";
  transcriptText: string;
  transcriptSegments: Array<{
    startSec: number | null;
    endSec: number | null;
    text: string;
    confidence: number | null;
  }>;
  transcriptPath: string;
  transcriptSource: RawVideoTranscriptRef["transcriptSource"];
  transcriptStatus: RawVideoTranscriptRef["transcriptStatus"];
  thumbnailPath: string;
  preparedAssets: PreparedFeatureAssets;
}

export interface VideoFeaturePreparationDependencies {
  downloadAudioWithLocalAsr?: typeof downloadAudioWithLocalAsr;
  downloadToBuffer?: typeof downloadToBuffer;
  getTranscriptWithFallback?: typeof getTranscriptWithFallback;
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new HttpError(400, "Invalid project path");
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

function getExportsRoot(): string {
  return path.resolve(process.cwd(), "exports");
}

function toString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeRelativePath(value: string | null, fallback: string): string {
  const candidate = (value ?? "").replace(/\\/g, "/").trim();
  if (!candidate || path.isAbsolute(candidate)) {
    return fallback;
  }
  if (candidate === "." || candidate === ".." || candidate.startsWith("../") || candidate.includes("/../")) {
    return fallback;
  }
  return candidate;
}

function normalizeTimeframe(value: unknown): Timeframe {
  if (value === "1m" || value === "6m" || value === "1y") {
    return value;
  }
  throw new HttpError(409, "Project timeframe is missing or invalid");
}

function normalizeTranscriptSource(value: unknown): RawVideoTranscriptRef["transcriptSource"] {
  if (value === "captions" || value === "asr" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeTranscriptStatus(value: unknown): RawVideoTranscriptRef["transcriptStatus"] {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function normalizeLanguageHint(...values: unknown[]): "auto" | "en" | "es" {
  for (const value of values) {
    const normalized = toString(value)?.toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith("en")) {
      return "en";
    }
    if (normalized.startsWith("es")) {
      return "es";
    }
  }
  return "auto";
}

function dedupeList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function pushUniqueThumbnailUrl(target: string[], seen: Set<string>, value: string | undefined): void {
  if (!value || !value.trim()) {
    return;
  }

  try {
    const normalized = new URL(value).toString();
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    target.push(normalized);
  } catch {
    // Ignore malformed URLs.
  }
}

function normalizeThumbnailMap(
  value: unknown
): Partial<Record<(typeof THUMBNAIL_RESOLUTION_PRIORITY)[number], { url: string }>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const normalized: Partial<Record<(typeof THUMBNAIL_RESOLUTION_PRIORITY)[number], { url: string }>> = {};
  for (const key of THUMBNAIL_RESOLUTION_PRIORITY) {
    const rawThumbnail = value[key];
    if (!isRecord(rawThumbnail)) {
      continue;
    }
    const url = toString(rawThumbnail.url);
    if (!url) {
      continue;
    }
    normalized[key] = { url };
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function buildThumbnailCandidateUrls(video: RawVideoRecord): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  pushUniqueThumbnailUrl(candidates, seen, video.thumbnailOriginalUrl);
  for (const key of THUMBNAIL_RESOLUTION_PRIORITY) {
    pushUniqueThumbnailUrl(candidates, seen, video.thumbnails?.[key]?.url);
  }
  for (const filename of THUMBNAIL_FILENAME_FALLBACKS) {
    pushUniqueThumbnailUrl(candidates, seen, `https://i.ytimg.com/vi/${video.videoId}/${filename}`);
  }

  return candidates;
}

function toTranscriptStatus(value: TranscriptPipelineResult["status"]): RawVideoTranscriptRef["transcriptStatus"] {
  if (value === "ok" || value === "missing" || value === "error") {
    return value;
  }
  return "missing";
}

function fallbackTranscriptResult(videoId: string, error: unknown): TranscriptPipelineResult {
  return {
    transcript: "",
    status: "error",
    source: "none",
    warning: `Transcript pipeline failed for video ${videoId}: ${error instanceof Error ? error.message : "unknown error"}`
  };
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

async function writeJsonLinesAtomic(targetPath: string, records: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(tmpPath, lines ? `${lines}\n` : "", "utf-8");
  await fs.rename(tmpPath, targetPath);
}

async function writeTextAtomic(targetPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

async function patchRawVideoRecord(
  projectRoot: string,
  videoId: string,
  updater: (record: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const rawVideosPath = path.resolve(projectRoot, "raw", "videos.jsonl");
  ensureInsideRoot(projectRoot, rawVideosPath);

  const raw = await fs.readFile(rawVideosPath, "utf-8");
  const updatedLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (toString(parsed.videoId) !== videoId) {
          return line;
        }
        return JSON.stringify(updater(parsed));
      } catch {
        return line;
      }
    });

  await writeTextAtomic(rawVideosPath, updatedLines.length ? `${updatedLines.join("\n")}\n` : "");
}

async function updateRawVideoTranscriptRef(input: {
  projectRoot: string;
  videoId: string;
  transcriptPath: string;
  transcriptSource: RawVideoTranscriptRef["transcriptSource"];
  transcriptStatus: RawVideoTranscriptRef["transcriptStatus"];
}): Promise<void> {
  await patchRawVideoRecord(input.projectRoot, input.videoId, (record) => {
    const transcriptRef = isRecord(record.transcriptRef) ? record.transcriptRef : {};
    return {
      ...record,
      transcriptRef: {
        ...transcriptRef,
        transcriptPath: input.transcriptPath,
        transcriptSource: input.transcriptSource,
        transcriptStatus: input.transcriptStatus
      }
    };
  });
}

async function updateRawVideoAudioLocalPath(input: {
  projectRoot: string;
  videoId: string;
  audioLocalPath: string;
}): Promise<void> {
  await patchRawVideoRecord(input.projectRoot, input.videoId, (record) => ({
    ...record,
    audioLocalPath: input.audioLocalPath
  }));
}

async function syncChannelAndManifestTranscriptState(input: {
  projectRoot: string;
  videoId: string;
  transcriptSource: RawVideoTranscriptRef["transcriptSource"];
  transcriptStatus: RawVideoTranscriptRef["transcriptStatus"];
}): Promise<void> {
  const channelPath = path.resolve(input.projectRoot, "channel.json");
  ensureInsideRoot(input.projectRoot, channelPath);

  const channelRaw = await fs.readFile(channelPath, "utf-8").catch(() => null);
  if (!channelRaw) {
    return;
  }

  let channelJson: unknown;
  try {
    channelJson = JSON.parse(channelRaw);
  } catch {
    throw new HttpError(409, "channel.json is invalid");
  }
  if (!isRecord(channelJson) || !Array.isArray(channelJson.videos)) {
    return;
  }

  const nextVideos = channelJson.videos.map((video) => {
    if (!isRecord(video) || toString(video.videoId) !== input.videoId) {
      return video;
    }
    return {
      ...video,
      transcriptSource: input.transcriptSource,
      transcriptStatus: input.transcriptStatus
    };
  });

  await writeJsonAtomic(channelPath, {
    ...channelJson,
    videos: nextVideos
  });

  const transcriptStatuses = nextVideos
    .map((video) => (isRecord(video) ? normalizeTranscriptStatus(video.transcriptStatus) : null))
    .filter((status): status is RawVideoTranscriptRef["transcriptStatus"] => status !== null);

  const manifestPath = path.resolve(input.projectRoot, "manifest.json");
  ensureInsideRoot(input.projectRoot, manifestPath);
  const manifestRaw = await fs.readFile(manifestPath, "utf-8").catch(() => null);
  if (!manifestRaw) {
    return;
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    throw new HttpError(409, "manifest.json is invalid");
  }
  if (!isRecord(manifestJson)) {
    return;
  }

  const counts = isRecord(manifestJson.counts) ? manifestJson.counts : {};
  await writeJsonAtomic(manifestPath, {
    ...manifestJson,
    counts: {
      ...counts,
      transcriptsOk: transcriptStatuses.filter((status) => status === "ok").length,
      transcriptsMissing: transcriptStatuses.filter((status) => status === "missing").length,
      transcriptsError: transcriptStatuses.filter((status) => status === "error").length
    }
  });
}

export async function readChannelContext(projectId: string): Promise<ChannelContext> {
  validatePathSegment(projectId, "projectId");
  const exportsRoot = getExportsRoot();
  const projectRoot = path.resolve(exportsRoot, projectId);
  ensureInsideRoot(exportsRoot, projectRoot);

  if (!(await fileExists(projectRoot))) {
    throw new HttpError(404, "Project not found");
  }

  const channelPath = path.resolve(projectRoot, "channel.json");
  ensureInsideRoot(projectRoot, channelPath);
  const raw = await fs.readFile(channelPath, "utf-8").catch(() => null);
  if (!raw) {
    throw new HttpError(409, "channel.json is missing for this project");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(409, "channel.json is invalid");
  }

  if (!isRecord(parsed)) {
    throw new HttpError(409, "channel.json is invalid");
  }

  const channelId = toString(parsed.channelId);
  const exportVersion = toString(parsed.exportVersion) ?? "1.1";
  if (!channelId) {
    throw new HttpError(409, "channel.json is missing channelId");
  }

  return {
    projectRoot,
    exportsRoot,
    channelId,
    exportVersion,
    timeframe: normalizeTimeframe(parsed.timeframe)
  };
}

export async function readRawVideo(projectRoot: string, videoId: string): Promise<RawVideoRecord> {
  validatePathSegment(videoId, "videoId");
  const rawVideosPath = path.resolve(projectRoot, "raw", "videos.jsonl");
  ensureInsideRoot(projectRoot, rawVideosPath);

  const rawVideos = await fs.readFile(rawVideosPath, "utf-8").catch(() => null);
  if (!rawVideos) {
    throw new HttpError(409, "raw/videos.jsonl is missing for this project");
  }

  for (const line of rawVideos.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || toString(parsed.videoId) !== videoId) {
      continue;
    }

    const transcriptRef = isRecord(parsed.transcriptRef) ? parsed.transcriptRef : {};
    return {
      videoId,
      title: toString(parsed.title) ?? videoId,
      description: toString(parsed.description) ?? "",
      publishedAt: toString(parsed.publishedAt),
      durationSec: toFiniteNumber(parsed.durationSec),
      defaultLanguage: toString(parsed.defaultLanguage) ?? undefined,
      defaultAudioLanguage: toString(parsed.defaultAudioLanguage) ?? undefined,
      audioLocalPath: toString(parsed.audioLocalPath) ?? undefined,
      thumbnailLocalPath: toString(parsed.thumbnailLocalPath) ?? undefined,
      thumbnailOriginalUrl: toString(parsed.thumbnailOriginalUrl) ?? undefined,
      thumbnails: normalizeThumbnailMap(parsed.thumbnails),
      transcriptRef: {
        transcriptPath: normalizeRelativePath(
          toString(transcriptRef.transcriptPath),
          path.posix.join("raw", "transcripts", `${videoId}.jsonl`)
        ),
        transcriptSource: normalizeTranscriptSource(transcriptRef.transcriptSource),
        transcriptStatus: normalizeTranscriptStatus(transcriptRef.transcriptStatus)
      }
    };
  }

  throw new HttpError(404, `Video not found in raw/videos.jsonl: ${videoId}`);
}

async function resolveAudioPaths(projectRoot: string, video: RawVideoRecord): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const preferredRelative = path.posix.join("raw", "audio", `${video.videoId}.mp3`);
  const preferredAbsolute = path.resolve(projectRoot, preferredRelative);
  ensureInsideRoot(projectRoot, preferredAbsolute);
  if (await fileExists(preferredAbsolute)) {
    return {
      absolutePath: preferredAbsolute,
      relativePath: preferredRelative
    };
  }

  const fallbackRelative = normalizeRelativePath(video.audioLocalPath ?? null, preferredRelative);
  const fallbackAbsolute = path.resolve(projectRoot, fallbackRelative);
  ensureInsideRoot(projectRoot, fallbackAbsolute);
  if (await fileExists(fallbackAbsolute)) {
    return {
      absolutePath: fallbackAbsolute,
      relativePath: fallbackRelative
    };
  }
  return {
    absolutePath: preferredAbsolute,
    relativePath: preferredRelative
  };
}

async function resolveThumbnailPaths(projectRoot: string, video: RawVideoRecord): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const preferredRelative = path.posix.join("thumbnails", `${video.videoId}.jpg`);
  const preferredAbsolute = path.resolve(projectRoot, preferredRelative);
  ensureInsideRoot(projectRoot, preferredAbsolute);
  if (await fileExists(preferredAbsolute)) {
    return {
      absolutePath: preferredAbsolute,
      relativePath: preferredRelative
    };
  }

  const fallbackRelative = normalizeRelativePath(video.thumbnailLocalPath ?? null, preferredRelative);
  const fallbackAbsolute = path.resolve(projectRoot, fallbackRelative);
  ensureInsideRoot(projectRoot, fallbackAbsolute);
  if (await fileExists(fallbackAbsolute)) {
    return {
      absolutePath: fallbackAbsolute,
      relativePath: fallbackRelative
    };
  }
  return {
    absolutePath: preferredAbsolute,
    relativePath: preferredRelative
  };
}

async function ensureAudioAsset(
  projectRoot: string,
  video: RawVideoRecord,
  dependencies?: VideoFeaturePreparationDependencies
): Promise<{
  absolutePath: string;
  relativePath: string;
  warnings: string[];
}> {
  const resolved = await resolveAudioPaths(projectRoot, video);
  if (await fileExists(resolved.absolutePath)) {
    await updateRawVideoAudioLocalPath({
      projectRoot,
      videoId: video.videoId,
      audioLocalPath: resolved.relativePath
    }).catch(() => undefined);
    return {
      ...resolved,
      warnings: []
    };
  }

  const preferredRelative = path.posix.join("raw", "audio", `${video.videoId}.mp3`);
  const preferredAbsolute = path.resolve(projectRoot, preferredRelative);
  ensureInsideRoot(projectRoot, preferredAbsolute);
  const result = await (dependencies?.downloadAudioWithLocalAsr ?? downloadAudioWithLocalAsr)({
    videoId: video.videoId,
    outputMp3Path: preferredAbsolute
  });

  if (await fileExists(preferredAbsolute)) {
    await updateRawVideoAudioLocalPath({
      projectRoot,
      videoId: video.videoId,
      audioLocalPath: preferredRelative
    });
    return {
      absolutePath: preferredAbsolute,
      relativePath: preferredRelative,
      warnings: result.warning ? [result.warning] : []
    };
  }

  return {
    absolutePath: preferredAbsolute,
    relativePath: preferredRelative,
    warnings: [result.warning ?? `Audio asset collection failed for ${video.videoId}`]
  };
}

async function ensureThumbnailAsset(
  projectRoot: string,
  video: RawVideoRecord,
  dependencies?: VideoFeaturePreparationDependencies
): Promise<{
  absolutePath: string;
  relativePath: string;
  warnings: string[];
}> {
  const resolved = await resolveThumbnailPaths(projectRoot, video);
  if (await fileExists(resolved.absolutePath)) {
    return {
      ...resolved,
      warnings: []
    };
  }

  const preferredRelative = path.posix.join("thumbnails", `${video.videoId}.jpg`);
  const preferredAbsolute = path.resolve(projectRoot, preferredRelative);
  ensureInsideRoot(projectRoot, preferredAbsolute);

  let lastDownloadError: unknown = null;
  for (const candidateUrl of buildThumbnailCandidateUrls(video)) {
    try {
      const image = await (dependencies?.downloadToBuffer ?? downloadToBuffer)(candidateUrl, 8_000);
      await fs.mkdir(path.dirname(preferredAbsolute), { recursive: true });
      await fs.writeFile(preferredAbsolute, image);
      return {
        absolutePath: preferredAbsolute,
        relativePath: preferredRelative,
        warnings: []
      };
    } catch (error) {
      lastDownloadError = error;
    }
  }

  return {
    absolutePath: preferredAbsolute,
    relativePath: preferredRelative,
    warnings: lastDownloadError
      ? [
          `Thumbnail recovery failed for ${video.videoId}: ${
            lastDownloadError instanceof Error ? lastDownloadError.message : "unknown error"
          }`
        ]
      : [`Thumbnail recovery failed for ${video.videoId}: no valid candidate URLs`]
  };
}

async function refreshTranscriptArtifact(input: {
  projectRoot: string;
  video: RawVideoRecord;
  transcriptAbsolutePath: string;
  transcriptRelativePath: string;
  audioAbsolutePath: string;
  audioRelativePath: string;
  createdAt?: string;
  language?: string;
  onLocalAsrStage?: (stage: LocalAsrStage) => void;
  onLocalAsrWorkerRequestId?: (workerRequestId: string) => void;
  dependencies?: VideoFeaturePreparationDependencies;
}): Promise<{ warnings: string[]; stepsExecuted: string[] }> {
  const audioExistedBefore = await fileExists(input.audioAbsolutePath);

  let transcriptResult: TranscriptPipelineResult;
  try {
    transcriptResult = await (input.dependencies?.getTranscriptWithFallback ?? getTranscriptWithFallback)(input.video.videoId, {
      outputMp3Path: input.audioAbsolutePath,
      language: input.language ?? env.localAsrLanguage,
      onLocalAsrStage: input.onLocalAsrStage,
      onLocalAsrWorkerRequestId: input.onLocalAsrWorkerRequestId
    });
  } catch (error) {
    transcriptResult = fallbackTranscriptResult(input.video.videoId, error);
  }

  const audioExistsAfter = await fileExists(input.audioAbsolutePath);
  if (audioExistsAfter) {
    await updateRawVideoAudioLocalPath({
      projectRoot: input.projectRoot,
      videoId: input.video.videoId,
      audioLocalPath: input.audioRelativePath
    }).catch(() => undefined);
  }

  const transcriptStatus = toTranscriptStatus(transcriptResult.status);
  const sanitizedTranscript = sanitizeTranscript(transcriptResult.transcript);
  const transcriptArtifactRecords = buildTranscriptArtifactRecords({
    videoId: input.video.videoId,
    result: transcriptResult,
      transcriptStatus,
      transcriptText: sanitizedTranscript.transcript,
      transcriptCleaned: sanitizedTranscript.cleaned,
      createdAt: input.createdAt ?? new Date().toISOString()
    });

  await writeJsonLinesAtomic(input.transcriptAbsolutePath, transcriptArtifactRecords);
  await updateRawVideoTranscriptRef({
    projectRoot: input.projectRoot,
    videoId: input.video.videoId,
    transcriptPath: input.transcriptRelativePath,
    transcriptSource: transcriptResult.source,
    transcriptStatus
  });
  await syncChannelAndManifestTranscriptState({
    projectRoot: input.projectRoot,
    videoId: input.video.videoId,
    transcriptSource: transcriptResult.source,
    transcriptStatus
  });

  return {
    warnings: transcriptResult.warning ? [transcriptResult.warning] : [],
    stepsExecuted: [
      ...(!audioExistedBefore && audioExistsAfter ? ["collect_audio_asset"] : []),
      "prepare_transcript_asset"
    ]
  };
}

export async function prepareVideoFeatureInputs(input: {
  context: ChannelContext;
  video: RawVideoRecord;
  feature: VideoFeatureKind;
  mode: VideoFeatureRerunMode;
  createdAt?: string;
  dependencies?: VideoFeaturePreparationDependencies;
  onLocalAsrStage?: (stage: LocalAsrStage) => void;
  onLocalAsrWorkerRequestId?: (workerRequestId: string) => void;
}): Promise<PreparedVideoFeatureInputs> {
  const transcriptRelativePath = normalizeRelativePath(
    input.video.transcriptRef.transcriptPath,
    path.posix.join("raw", "transcripts", `${input.video.videoId}.jsonl`)
  );
  const transcriptAbsolutePath = path.resolve(input.context.projectRoot, transcriptRelativePath);
  ensureInsideRoot(input.context.projectRoot, transcriptAbsolutePath);

  const audio = await resolveAudioPaths(input.context.projectRoot, input.video);
  const thumbnail =
    input.feature === "thumbnail"
      ? await ensureThumbnailAsset(input.context.projectRoot, input.video, input.dependencies)
      : { ...(await resolveThumbnailPaths(input.context.projectRoot, input.video)), warnings: [] as string[] };

  const stepsExecuted = ["resolve_metadata"];
  const warnings = [...thumbnail.warnings];

  if (input.feature === "thumbnail") {
    stepsExecuted.push("collect_thumbnail_asset");
  } else if (input.feature === "title" || input.feature === "transcript") {
    if (input.mode === "collect_assets") {
      const collectedAudio = await ensureAudioAsset(input.context.projectRoot, input.video, input.dependencies);
      warnings.push(...collectedAudio.warnings);
      audio.absolutePath = collectedAudio.absolutePath;
      audio.relativePath = collectedAudio.relativePath;
      stepsExecuted.push("collect_audio_asset");
    } else {
      const transcriptRefresh = await refreshTranscriptArtifact({
        projectRoot: input.context.projectRoot,
        video: input.video,
        transcriptAbsolutePath,
        transcriptRelativePath,
        audioAbsolutePath: audio.absolutePath,
        audioRelativePath: audio.relativePath,
        createdAt: input.createdAt,
        onLocalAsrStage: input.onLocalAsrStage,
        onLocalAsrWorkerRequestId: input.onLocalAsrWorkerRequestId,
        dependencies: input.dependencies
      });
      warnings.push(...transcriptRefresh.warnings);
      stepsExecuted.push(...transcriptRefresh.stepsExecuted);
    }
  }

  const transcriptArtifact = await loadTranscriptJsonl(transcriptAbsolutePath, { videoId: input.video.videoId });
  const transcriptText = transcriptArtifact.segments.map((segment) => segment.text).join(" ").trim();
  const transcriptSegments = transcriptArtifact.segments.map((segment) => ({
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text,
    confidence: segment.confidence
  }));
  const transcriptSource = normalizeTranscriptSource(transcriptArtifact.meta?.source ?? input.video.transcriptRef.transcriptSource);
  const transcriptStatus = normalizeTranscriptStatus(transcriptArtifact.meta?.status ?? input.video.transcriptRef.transcriptStatus);

  return {
    warnings: dedupeList([...warnings, ...transcriptArtifact.warnings]),
    stepsExecuted: dedupeList(stepsExecuted),
    languageHint: normalizeLanguageHint(
      input.video.defaultLanguage,
      input.video.defaultAudioLanguage,
      transcriptArtifact.meta?.language
    ),
    transcriptText,
    transcriptSegments,
    transcriptPath: transcriptRelativePath,
    transcriptSource,
    transcriptStatus,
    thumbnailPath: thumbnail.relativePath,
    preparedAssets: {
      audioPath: input.feature === "title" || input.feature === "transcript" ? audio.relativePath : null,
      transcriptPath: transcriptRelativePath,
      thumbnailPath: thumbnail.relativePath
    }
  };
}
