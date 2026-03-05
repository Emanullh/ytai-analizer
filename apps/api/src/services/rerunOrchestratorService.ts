import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Timeframe } from "../types.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { runOrchestrator, type RunOrchestratorResult } from "../analysis/orchestratorService.js";
import { projectOperationLockService } from "./projectOperationLockService.js";

const VALID_TIMEFRAMES = new Set<string>(["1m", "6m", "1y"]);
const EXPORTS_ROOT = path.resolve(process.cwd(), "exports");

interface ChannelJsonMeta {
  channelId: string;
  channelName: string;
  timeframe: Timeframe;
}

interface PrerequisiteCheck {
  artifact: string;
  path: string;
  exists: boolean;
  detail?: string;
}

export interface RerunOrchestratorRequest {
  channelName: string;
}

export interface RerunOrchestratorResponse {
  ok: boolean;
  exportPath: string;
  warnings: string[];
  usedLlm: boolean;
  artifactPaths: string[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countJsonFiles(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function readChannelJson(filePath: string): Promise<ChannelJsonMeta> {
  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const channelId = parsed.channelId;
  if (typeof channelId !== "string" || !channelId.trim()) {
    throw new Error("channel.json is missing a valid channelId");
  }

  const channelName = parsed.channelName;
  if (typeof channelName !== "string" || !channelName.trim()) {
    throw new Error("channel.json is missing a valid channelName");
  }

  const timeframe = parsed.timeframe;
  if (typeof timeframe !== "string" || !VALID_TIMEFRAMES.has(timeframe)) {
    throw new Error(`channel.json has invalid timeframe: ${String(timeframe)}`);
  }

  return {
    channelId: channelId.trim(),
    channelName: channelName.trim(),
    timeframe: timeframe as Timeframe
  };
}

export async function rerunOrchestrator(
  request: RerunOrchestratorRequest
): Promise<RerunOrchestratorResponse> {
  const folderName = sanitizeFolderName(request.channelName);
  const lockOwnerId = randomUUID();
  projectOperationLockService.acquireOrThrow({
    projectId: folderName,
    operation: "rerun_orchestrator",
    ownerId: lockOwnerId
  });

  try {
    const exportPath = path.resolve(EXPORTS_ROOT, folderName);

    const checks: PrerequisiteCheck[] = [];

    const exportDirExists = await fileExists(exportPath);
    checks.push({
      artifact: "export folder",
      path: exportPath,
      exists: exportDirExists
    });

    if (!exportDirExists) {
      throw new PrerequisiteError(
        `Export folder not found: "${folderName}". Run a full export first.`,
        checks
      );
    }

    const channelJsonPath = path.resolve(exportPath, "channel.json");
    const videosJsonlPath = path.resolve(exportPath, "raw", "videos.jsonl");
    const videoFeaturesDir = path.resolve(exportPath, "derived", "video_features");

    const [channelJsonExists, videosJsonlExists, videoFeaturesCount] = await Promise.all([
      fileExists(channelJsonPath),
      fileExists(videosJsonlPath),
      countJsonFiles(videoFeaturesDir)
    ]);

    checks.push(
      { artifact: "channel.json", path: channelJsonPath, exists: channelJsonExists },
      { artifact: "raw/videos.jsonl", path: videosJsonlPath, exists: videosJsonlExists },
      {
        artifact: "derived/video_features/*.json",
        path: videoFeaturesDir,
        exists: videoFeaturesCount > 0,
        detail: `${videoFeaturesCount} file(s) found`
      }
    );

    const missing = checks.filter((check) => !check.exists);
    if (missing.length > 0) {
      const missingNames = missing.map((m) => m.artifact).join(", ");
      throw new PrerequisiteError(
        `Cannot re-run orchestrator: missing prerequisites: ${missingNames}. Run a full export first.`,
        checks
      );
    }

    const channelMeta = await readChannelJson(channelJsonPath);

    const result: RunOrchestratorResult = await runOrchestrator({
      exportRoot: EXPORTS_ROOT,
      channelId: channelMeta.channelId,
      channelName: channelMeta.channelName,
      timeframe: channelMeta.timeframe,
      jobId: randomUUID()
    });

    return {
      ok: true,
      exportPath,
      warnings: result.warnings,
      usedLlm: result.usedLlm,
      artifactPaths: result.artifactPaths
    };
  } finally {
    projectOperationLockService.release({
      projectId: folderName,
      ownerId: lockOwnerId
    });
  }
}

export class PrerequisiteError extends Error {
  public readonly checks: PrerequisiteCheck[];

  constructor(message: string, checks: PrerequisiteCheck[]) {
    super(message);
    this.name = "PrerequisiteError";
    this.checks = checks;
  }
}
