import { env } from "../config/env.js";
import { AnalyzeResult, Timeframe, VideoSummary } from "../types.js";
import { SimpleCache } from "../utils/cache.js";
import { HttpError } from "../utils/errors.js";
import { fetchJson } from "../utils/http.js";
import { getPublishedAfter } from "../utils/timeframe.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_VIDEOS_PER_ANALYSIS = 500;

const resolutionCache = new SimpleCache<string, ResolvedChannel>(15 * 60 * 1000);
const videoListCache = new SimpleCache<string, { videos: VideoSummary[]; warnings: string[] }>(8 * 60 * 1000);

interface YoutubeSearchVideoItem {
  id?: { videoId?: string; channelId?: string };
  snippet?: {
    title?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url: string }>;
    channelTitle?: string;
  };
}

interface YoutubeSearchResponse {
  nextPageToken?: string;
  items?: YoutubeSearchVideoItem[];
}

interface YoutubeVideoItem {
  id?: string;
  snippet?: {
    title?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url: string }>;
  };
  statistics?: {
    viewCount?: string;
  };
}

interface YoutubeVideosResponse {
  items?: YoutubeVideoItem[];
}

interface YoutubeChannelItem {
  id?: string;
  snippet?: {
    title?: string;
  };
}

interface YoutubeChannelsResponse {
  items?: YoutubeChannelItem[];
}

interface ResolvedChannel {
  channelId: string;
  channelName: string;
  warnings: string[];
}

function ensureApiKey(): void {
  if (!env.youtubeApiKey) {
    throw new HttpError(500, "Missing YOUTUBE_API_KEY in apps/api/.env");
  }
}

async function youtubeGet<T>(endpoint: string, params: Record<string, string | undefined>): Promise<T> {
  ensureApiKey();

  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      query.set(key, value);
    }
  });
  query.set("key", env.youtubeApiKey);

  const url = `${YOUTUBE_API_BASE}/${endpoint}?${query.toString()}`;
  return fetchJson<T>(url, { timeoutMs: 12_000 });
}

function pickBestThumbnail(thumbnails: Record<string, { url: string }> | undefined): string {
  if (!thumbnails) {
    return "";
  }

  const preferred = ["maxres", "standard", "high", "medium", "default"];
  for (const key of preferred) {
    const candidate = thumbnails[key];
    if (candidate?.url) {
      return candidate.url;
    }
  }

  const fallback = Object.values(thumbnails)[0];
  return fallback?.url ?? "";
}

async function fetchChannelById(channelId: string): Promise<ResolvedChannel | null> {
  const response = await youtubeGet<YoutubeChannelsResponse>("channels", {
    part: "snippet",
    id: channelId
  });

  const item = response.items?.[0];
  if (!item?.id) {
    return null;
  }

  return {
    channelId: item.id,
    channelName: item.snippet?.title ?? item.id,
    warnings: []
  };
}

async function resolveByHandle(handle: string): Promise<ResolvedChannel | null> {
  const candidates = [handle.replace(/^@/, ""), `@${handle.replace(/^@/, "")}`];

  for (const candidate of candidates) {
    const response = await youtubeGet<YoutubeChannelsResponse>("channels", {
      part: "snippet",
      forHandle: candidate
    });

    const item = response.items?.[0];
    if (item?.id) {
      return {
        channelId: item.id,
        channelName: item.snippet?.title ?? item.id,
        warnings: []
      };
    }
  }

  return null;
}

async function resolveByUsername(username: string): Promise<ResolvedChannel | null> {
  const response = await youtubeGet<YoutubeChannelsResponse>("channels", {
    part: "snippet",
    forUsername: username
  });

  const item = response.items?.[0];
  if (!item?.id) {
    return null;
  }

  return {
    channelId: item.id,
    channelName: item.snippet?.title ?? item.id,
    warnings: []
  };
}

async function tryExtractChannelIdFromHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const patterns = [/"channelId":"(UC[\w-]{22})"/, /\/channel\/(UC[\w-]{22})/];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function resolveByChannelSearch(query: string): Promise<ResolvedChannel | null> {
  const response = await youtubeGet<YoutubeSearchResponse>("search", {
    part: "snippet",
    q: query,
    type: "channel",
    maxResults: "5"
  });

  const items = response.items ?? [];
  if (!items.length) {
    return null;
  }

  const normalizedQuery = normalizeComparable(query);
  const bestMatch =
    items.find((item) => normalizeComparable(item.snippet?.title ?? "") === normalizedQuery) ?? items[0];
  const channelId = bestMatch.id?.channelId;

  if (!channelId) {
    return null;
  }

  return fetchChannelById(channelId);
}

function extractYoutubePathInfo(sourceInput: string): { kind: string; value: string; url?: string } | null {
  const trimmed = sourceInput.trim();
  if (!trimmed) {
    return null;
  }

  if (/^UC[\w-]{22}$/.test(trimmed)) {
    return { kind: "channel", value: trimmed };
  }

  const maybeDomainOnlyInput = /^(www\.|m\.)?youtube\.com\//i.test(trimmed);
  const candidateUrl = trimmed.includes("://")
    ? trimmed
    : maybeDomainOnlyInput
      ? `https://${trimmed}`
      : `https://www.youtube.com/${trimmed.replace(/^\//, "")}`;

  let parsed: URL | null = null;
  try {
    parsed = new URL(candidateUrl);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const host = parsed.hostname.toLowerCase();
    const youtubeHost = host.includes("youtube.com") || host === "youtu.be";
    if (!youtubeHost) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const first = parts[0] ?? "";
    const second = parts[1] ?? "";

    if (first === "channel" && /^UC[\w-]{22}$/.test(second)) {
      return { kind: "channel", value: second, url: parsed.toString() };
    }

    if (first.startsWith("@")) {
      return { kind: "handle", value: first.replace(/^@/, ""), url: parsed.toString() };
    }

    if (first === "user" && second) {
      return { kind: "user", value: second, url: parsed.toString() };
    }

    if (first === "c" && second) {
      return { kind: "custom", value: second, url: parsed.toString() };
    }
  }

  if (trimmed.startsWith("@")) {
    return { kind: "handle", value: trimmed.replace(/^@/, "") };
  }

  if (/^[a-zA-Z0-9._-]{3,40}$/.test(trimmed)) {
    return { kind: "unknown", value: trimmed };
  }

  return null;
}

export async function resolveChannelInput(sourceInput: string): Promise<ResolvedChannel> {
  const normalized = sourceInput.trim();
  if (!normalized) {
    throw new HttpError(400, "sourceInput is required");
  }

  const cacheKey = normalized.toLowerCase();
  const cached = resolutionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const info = extractYoutubePathInfo(normalized);
  if (!info) {
    throw new HttpError(400, "Unsupported channel input format");
  }

  const warnings: string[] = [];
  let resolved: ResolvedChannel | null = null;

  if (info.kind === "channel") {
    resolved = await fetchChannelById(info.value);
  }

  if (!resolved && info.kind === "handle") {
    resolved = await resolveByHandle(info.value);
  }

  if (!resolved && info.kind === "user") {
    resolved = await resolveByUsername(info.value);
  }

  if (!resolved && (info.kind === "custom" || info.kind === "unknown")) {
    const channelUrl = info.url ?? `https://www.youtube.com/c/${encodeURIComponent(info.value)}`;
    const channelIdFromHtml = await tryExtractChannelIdFromHtml(channelUrl);
    if (channelIdFromHtml) {
      resolved = await fetchChannelById(channelIdFromHtml);
    }
    if (!resolved) {
      resolved = await resolveByChannelSearch(info.value);
      if (resolved) {
        warnings.push(`Resolved by search fallback for "${info.value}"`);
      }
    }
  }

  if (!resolved && info.kind !== "handle") {
    resolved = await resolveByHandle(info.value);
  }

  if (!resolved && info.kind !== "user") {
    resolved = await resolveByUsername(info.value);
  }

  if (!resolved) {
    throw new HttpError(404, "Channel could not be resolved from the provided input");
  }

  const output = { ...resolved, warnings: [...resolved.warnings, ...warnings] };
  resolutionCache.set(cacheKey, output);
  return output;
}

function toVideoSummary(item: YoutubeVideoItem): VideoSummary | null {
  if (!item.id) {
    return null;
  }

  return {
    videoId: item.id,
    title: item.snippet?.title ?? item.id,
    publishedAt: item.snippet?.publishedAt ?? "",
    viewCount: Number.parseInt(item.statistics?.viewCount ?? "0", 10) || 0,
    thumbnailUrl: pickBestThumbnail(item.snippet?.thumbnails)
  };
}

async function fetchVideosByIds(videoIds: string[]): Promise<VideoSummary[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < videoIds.length; index += 50) {
    chunks.push(videoIds.slice(index, index + 50));
  }

  const videos: VideoSummary[] = [];
  for (const chunk of chunks) {
    const response = await youtubeGet<YoutubeVideosResponse>("videos", {
      part: "snippet,statistics",
      id: chunk.join(","),
      maxResults: "50"
    });

    for (const item of response.items ?? []) {
      const mapped = toVideoSummary(item);
      if (mapped) {
        videos.push(mapped);
      }
    }
  }

  return videos;
}

async function fetchVideosWithinTimeframe(channelId: string, timeframe: Timeframe): Promise<{ videos: VideoSummary[]; warnings: string[] }> {
  const warnings: string[] = [];
  const publishedAfter = getPublishedAfter(timeframe);
  const seenIds = new Set<string>();

  let pageToken: string | undefined;
  let pageCount = 0;

  while (pageCount < 20) {
    const response = await youtubeGet<YoutubeSearchResponse>("search", {
      part: "snippet",
      channelId,
      type: "video",
      order: "date",
      maxResults: "50",
      publishedAfter,
      pageToken
    });

    for (const item of response.items ?? []) {
      if (item.id?.videoId) {
        seenIds.add(item.id.videoId);
      }
    }

    if (seenIds.size >= MAX_VIDEOS_PER_ANALYSIS) {
      warnings.push(`Result truncated to ${MAX_VIDEOS_PER_ANALYSIS} videos`);
      break;
    }

    pageToken = response.nextPageToken;
    pageCount += 1;
    if (!pageToken) {
      break;
    }
  }

  if (pageCount >= 20 && pageToken) {
    warnings.push("Pagination limit reached while listing videos");
  }

  const videoIds = Array.from(seenIds).slice(0, MAX_VIDEOS_PER_ANALYSIS);
  if (videoIds.length === 0) {
    return { videos: [], warnings };
  }

  const videos = await fetchVideosByIds(videoIds);
  const sorted = videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return { videos: sorted, warnings };
}

export async function listVideosForChannel(channelId: string, timeframe: Timeframe): Promise<{ videos: VideoSummary[]; warnings: string[] }> {
  const cacheKey = `${channelId}:${timeframe}`;
  const cached = videoListCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const fresh = await fetchVideosWithinTimeframe(channelId, timeframe);
  videoListCache.set(cacheKey, fresh);
  return fresh;
}

export async function analyzeChannel(sourceInput: string, timeframe: Timeframe): Promise<AnalyzeResult> {
  const resolved = await resolveChannelInput(sourceInput);
  const listResult = await listVideosForChannel(resolved.channelId, timeframe);

  return {
    channelId: resolved.channelId,
    channelName: resolved.channelName,
    sourceInput,
    timeframe,
    warnings: [...resolved.warnings, ...listResult.warnings],
    videos: listResult.videos
  };
}

export async function getSelectedVideoDetails(
  channelId: string,
  timeframe: Timeframe,
  selectedVideoIds: string[]
): Promise<{ videos: VideoSummary[]; warnings: string[] }> {
  const warnings: string[] = [];
  const uniqueIds = Array.from(new Set(selectedVideoIds));
  if (!uniqueIds.length) {
    return { videos: [], warnings };
  }

  const fromTimeframe = await listVideosForChannel(channelId, timeframe);
  const videoMap = new Map(fromTimeframe.videos.map((video) => [video.videoId, video]));
  const missingIds = uniqueIds.filter((id) => !videoMap.has(id));

  if (missingIds.length) {
    const recovered = await fetchVideosByIds(missingIds);
    recovered.forEach((video) => videoMap.set(video.videoId, video));
    if (recovered.length !== missingIds.length) {
      warnings.push("Some selected videos could not be recovered");
    }
  }

  const ordered = uniqueIds
    .map((videoId) => videoMap.get(videoId))
    .filter((video): video is VideoSummary => Boolean(video));

  return { videos: ordered, warnings: [...fromTimeframe.warnings, ...warnings] };
}
