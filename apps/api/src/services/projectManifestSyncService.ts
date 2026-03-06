import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid project path");
  }
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

export async function syncManifestThumbnailCounts(projectRoot: string): Promise<void> {
  const channelPath = path.resolve(projectRoot, "channel.json");
  const manifestPath = path.resolve(projectRoot, "manifest.json");
  ensureInsideRoot(projectRoot, channelPath);
  ensureInsideRoot(projectRoot, manifestPath);

  const [channelRaw, manifestRaw] = await Promise.all([
    fs.readFile(channelPath, "utf-8").catch(() => null),
    fs.readFile(manifestPath, "utf-8").catch(() => null)
  ]);

  if (!channelRaw || !manifestRaw) {
    return;
  }

  let channelJson: unknown;
  let manifestJson: unknown;
  try {
    channelJson = JSON.parse(channelRaw);
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    return;
  }

  if (!isRecord(channelJson) || !Array.isArray(channelJson.videos) || !isRecord(manifestJson)) {
    return;
  }

  let thumbnailsOk = 0;
  let thumbnailsFailed = 0;

  for (const video of channelJson.videos) {
    if (!isRecord(video)) {
      continue;
    }
    const videoId = toString(video.videoId);
    if (!videoId) {
      continue;
    }
    const thumbnailRelativePath = normalizeRelativePath(
      toString(video.thumbnailPath),
      path.posix.join("thumbnails", `${videoId}.jpg`)
    );
    const thumbnailAbsolutePath = path.resolve(projectRoot, thumbnailRelativePath);
    ensureInsideRoot(projectRoot, thumbnailAbsolutePath);
    if (await fileExists(thumbnailAbsolutePath)) {
      thumbnailsOk += 1;
    } else {
      thumbnailsFailed += 1;
    }
  }

  const counts = isRecord(manifestJson.counts) ? manifestJson.counts : {};
  await writeJsonAtomic(manifestPath, {
    ...manifestJson,
    counts: {
      ...counts,
      thumbnailsOk,
      thumbnailsFailed
    }
  });
}
