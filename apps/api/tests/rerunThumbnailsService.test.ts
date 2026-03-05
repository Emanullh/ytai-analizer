import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeThumbnail(filePath: string): Promise<void> {
  const buffer = Buffer.alloc(64 * 64 * 3, 180);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(buffer, { raw: { width: 64, height: 64, channels: 3 } }).jpeg({ quality: 90 }).toFile(filePath);
}

async function waitForJobDone(service: {
  getJob: (jobId: string) => { status: "queued" | "running" | "done" | "failed" } | null;
}, jobId: string): Promise<{ status: "queued" | "running" | "done" | "failed" } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const job = service.getJob(jobId);
    if (!job) {
      return null;
    }
    if (job.status === "done" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job did not finish in time: ${jobId}`);
}

describe("rerunThumbnailsService", () => {
  const originalEnv = { ...process.env };
  let originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-rerun-thumb-"));
    process.chdir(tempDir);

    process.env = { ...originalEnv };
    process.env.THUMB_OCR_ENABLED = "false";
    process.env.AUTO_GEN_ENABLED = "false";
    process.env.THUMB_OCR_ENGINE = "python";
    process.env.THUMB_OCR_LANGS = "eng";
    process.env.THUMB_VISION_DOWNSCALE_WIDTH = "256";
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves scope=exemplars from analysis/orchestrator_input.json", async () => {
    const projectRoot = path.resolve(tempDir, "exports", "Canal_Demo");
    await writeJson(path.resolve(projectRoot, "channel.json"), {
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      timeframe: "6m"
    });
    await writeJson(path.resolve(projectRoot, "raw", "channel.json"), {
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      timeframe: "6m"
    });

    await fs.mkdir(path.resolve(projectRoot, "derived", "video_features"), { recursive: true });
    for (const videoId of ["videoA1", "videoA2", "videoA3"]) {
      await writeThumbnail(path.resolve(projectRoot, "thumbnails", `${videoId}.jpg`));
      await writeJson(path.resolve(projectRoot, "derived", "video_features", `${videoId}.json`), {
        schemaVersion: "derived.video_features.v1",
        videoId,
        titleFeatures: {
          deterministic: {
            title_len_chars: 10
          }
        },
        thumbnailFeatures: {
          deterministic: {
            ocrWordCount: 99
          }
        }
      });
    }

    await fs.mkdir(path.resolve(projectRoot, "raw"), { recursive: true });
    await fs.writeFile(
      path.resolve(projectRoot, "raw", "videos.jsonl"),
      [
        JSON.stringify({ videoId: "videoA1", title: "A1", thumbnailLocalPath: "thumbnails/videoA1.jpg" }),
        JSON.stringify({ videoId: "videoA2", title: "A2", thumbnailLocalPath: "thumbnails/videoA2.jpg" }),
        JSON.stringify({ videoId: "videoA3", title: "A3", thumbnailLocalPath: "thumbnails/videoA3.jpg" })
      ].join("\n") + "\n",
      "utf-8"
    );

    await writeJson(path.resolve(projectRoot, "analysis", "orchestrator_input.json"), {
      schemaVersion: "analysis.orchestrator_input.v1",
      exemplars: {
        top_videos: [{ videoId: "videoA1" }],
        bottom_videos: [{ videoId: "videoA2" }],
        mid_videos: [{ videoId: "videoA3" }]
      }
    });

    const { rerunThumbnailsJobService } = await import("../src/services/rerunThumbnailsService.js");
    const { jobId } = rerunThumbnailsJobService.createJob({
      projectId: "Canal_Demo",
      scope: "exemplars",
      engine: "python",
      force: true
    });

    const completed = await waitForJobDone(rerunThumbnailsJobService, jobId);
    expect(completed?.status).toBe("done");

    const state = rerunThumbnailsJobService.getJob(jobId);
    expect(state?.processed).toBe(3);
    expect(state?.failed).toBe(0);

    const videoA2Raw = await fs.readFile(
      path.resolve(projectRoot, "derived", "video_features", "videoA2.json"),
      "utf-8"
    );
    const videoA2 = JSON.parse(videoA2Raw) as Record<string, unknown>;
    const thumbnailFeatures = videoA2.thumbnailFeatures as Record<string, unknown>;
    expect(thumbnailFeatures.deterministic).toBeTruthy();
    expect((videoA2.titleFeatures as Record<string, unknown>)?.deterministic).toBeTruthy();
  });

  it("force recompute ignores cache unchanged signals", async () => {
    const projectRoot = path.resolve(tempDir, "exports", "Canal_Demo");
    await writeJson(path.resolve(projectRoot, "channel.json"), {
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      timeframe: "6m"
    });
    await writeJson(path.resolve(projectRoot, "raw", "channel.json"), {
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      timeframe: "6m"
    });

    await writeThumbnail(path.resolve(projectRoot, "thumbnails", "videoA1.jpg"));
    await fs.mkdir(path.resolve(projectRoot, "derived", "video_features"), { recursive: true });
    await writeJson(path.resolve(projectRoot, "derived", "video_features", "videoA1.json"), {
      schemaVersion: "derived.video_features.v1",
      videoId: "videoA1",
      thumbnailFeatures: {
        deterministic: {
          ocrWordCount: 0
        }
      }
    });

    await fs.mkdir(path.resolve(projectRoot, "raw"), { recursive: true });
    await fs.writeFile(
      path.resolve(projectRoot, "raw", "videos.jsonl"),
      JSON.stringify({ videoId: "videoA1", title: "A1", thumbnailLocalPath: "thumbnails/videoA1.jpg" }) + "\n",
      "utf-8"
    );

    const { hashFileSha1 } = await import("../src/utils/hash.js");
    const { computeOcrConfigHash } = await import("../src/services/exportCacheService.js");

    const thumbnailHash = await hashFileSha1(path.resolve(projectRoot, "thumbnails", "videoA1.jpg"));
    const ocrConfigHash = computeOcrConfigHash({
      engine: "python",
      langs: "eng",
      downscaleWidth: 256
    });

    await writeJson(path.resolve(projectRoot, ".cache", "index.json"), {
      schemaVersion: "cache.index.v1",
      channelId: "UC1234567890123456789012",
      channelFolder: "Canal_Demo",
      updatedAt: new Date().toISOString(),
      exportVersion: "1.1",
      timeframes: {
        "1m": { videos: {} },
        "6m": {
          videos: {
            videoA1: {
              videoId: "videoA1",
              lastUpdatedAt: new Date().toISOString(),
              inputs: {
                titleHash: "",
                descriptionHash: "",
                thumbnailHash,
                transcriptHash: "",
                transcriptSource: "none",
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
                rawTranscriptPath: "raw/transcripts/videoA1.jsonl",
                thumbnailPath: "thumbnails/videoA1.jpg",
                derivedVideoFeaturesPath: "derived/video_features/videoA1.json"
              },
              status: {
                rawTranscript: "missing",
                thumbnail: "ok",
                derived: "partial",
                warnings: []
              }
            }
          }
        },
        "1y": { videos: {} }
      }
    });

    const { rerunThumbnailsJobService } = await import("../src/services/rerunThumbnailsService.js");

    const first = rerunThumbnailsJobService.createJob({
      projectId: "Canal_Demo",
      scope: "selected",
      videoIds: ["videoA1"],
      engine: "python",
      force: false
    });
    const firstDone = await waitForJobDone(rerunThumbnailsJobService, first.jobId);
    expect(firstDone?.status).toBe("done");
    const firstState = rerunThumbnailsJobService.getJob(first.jobId);
    expect(firstState?.processed).toBe(0);
    expect(firstState?.skipped).toBe(1);

    const second = rerunThumbnailsJobService.createJob({
      projectId: "Canal_Demo",
      scope: "selected",
      videoIds: ["videoA1"],
      engine: "python",
      force: true
    });
    const secondDone = await waitForJobDone(rerunThumbnailsJobService, second.jobId);
    expect(secondDone?.status).toBe("done");
    const secondState = rerunThumbnailsJobService.getJob(second.jobId);
    expect(secondState?.processed).toBe(1);
    expect(secondState?.skipped).toBe(0);
  });
});
