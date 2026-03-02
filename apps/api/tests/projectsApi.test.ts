import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("projects API", () => {
  let app: FastifyInstance;
  let originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-projects-"));
    process.chdir(tempDir);

    const exportsRoot = path.resolve(tempDir, "exports");
    const projectA = path.resolve(exportsRoot, "Canal_Demo");
    const projectB = path.resolve(exportsRoot, "Otro_Canal");

    await writeJson(path.resolve(projectA, "channel.json"), {
      exportVersion: "1.1",
      exportedAt: "2026-03-01T12:00:00.000Z",
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      sourceInput: "https://www.youtube.com/@demo",
      timeframe: "6m",
      timeframeResolved: {
        publishedAfter: "2025-09-01T00:00:00.000Z",
        publishedBefore: "2026-03-01T00:00:00.000Z"
      },
      videos: [
        {
          videoId: "videoA1",
          title: "Video A1",
          publishedAt: "2026-02-20T00:00:00.000Z",
          thumbnailPath: "thumbnails/videoA1.jpg",
          transcriptStatus: "ok",
          transcriptSource: "captions"
        },
        {
          videoId: "videoA2",
          title: "Video A2",
          publishedAt: "2026-02-18T00:00:00.000Z",
          thumbnailPath: "thumbnails/videoA2.jpg",
          transcriptStatus: "missing",
          transcriptSource: "none"
        }
      ]
    });

    await writeJson(path.resolve(projectA, "manifest.json"), {
      jobId: "job-a1",
      channelId: "UC1234567890123456789012",
      channelFolder: "Canal_Demo",
      exportVersion: "1.1",
      exportedAt: "2026-03-01T12:00:00.000Z",
      counts: {
        totalVideosSelected: 2,
        transcriptsOk: 1,
        transcriptsMissing: 1,
        transcriptsError: 0,
        thumbnailsOk: 2,
        thumbnailsFailed: 0
      },
      warnings: [],
      artifacts: ["channel.json", "manifest.json", "analysis/playbook.json", "derived/templates.json"]
    });

    await writeJson(path.resolve(projectA, "logs", "job_job-a1.summary.json"), {
      jobId: "job-a1",
      status: "done",
      startedAt: "2026-03-01T11:58:00.000Z",
      finishedAt: "2026-03-01T12:00:00.000Z",
      durationMs: 120000,
      warningsCount: 1,
      errorsCount: 0,
      perVideo: {
        videoA1: {
          cacheHit: "full"
        },
        videoA2: {
          cacheHit: "miss"
        }
      }
    });

    await writeJson(path.resolve(projectA, "analysis", "playbook.json"), {
      summary: "playbook"
    });
    await writeJson(path.resolve(projectA, "derived", "templates.json"), {
      titleTemplates: ["template-a"]
    });
    await writeJson(path.resolve(projectA, "derived", "channel_models.json"), {
      schemaVersion: "derived.channel_models.v1"
    });

    await writeJson(path.resolve(projectA, "derived", "video_features", "videoA1.json"), {
      schemaVersion: "derived.video_features.v1",
      videoId: "videoA1",
      performance: {
        viewsPerDay: 12.5,
        engagementRate: 0.09,
        residual: 0.12,
        percentile: 78
      },
      descriptionFeatures: {
        llm: {
          label: "ok"
        }
      },
      transcriptFeatures: {
        llm: null
      },
      thumbnailFeatures: {
        llm: {
          label: "thumbnail"
        }
      }
    });

    await fs.mkdir(path.resolve(projectA, "raw", "transcripts"), { recursive: true });
    await fs.writeFile(
      path.resolve(projectA, "raw", "transcripts", "videoA1.jsonl"),
      [
        JSON.stringify({ type: "meta", videoId: "videoA1", status: "ok", source: "captions" }),
        JSON.stringify({ type: "segment", i: 0, text: "hola" }),
        JSON.stringify({ type: "segment", i: 1, text: "mundo" })
      ].join("\n") + "\n",
      "utf-8"
    );

    await fs.mkdir(path.resolve(projectA, "raw"), { recursive: true });
    await fs.writeFile(
      path.resolve(projectA, "raw", "videos.jsonl"),
      JSON.stringify({ videoId: "videoA1", title: "Video A1", description: "desc" }) + "\n",
      "utf-8"
    );

    await fs.mkdir(path.resolve(projectA, "thumbnails"), { recursive: true });
    await fs.writeFile(path.resolve(projectA, "thumbnails", "videoA1.jpg"), "fake-jpg", "utf-8");

    await writeJson(path.resolve(projectB, "channel.json"), {
      exportVersion: "1.1",
      exportedAt: "2026-02-20T12:00:00.000Z",
      channelId: "UC9999999999999999999999",
      channelName: "Otro Canal",
      sourceInput: "https://www.youtube.com/@otro",
      timeframe: "1m",
      videos: []
    });

    await writeJson(path.resolve(projectB, "manifest.json"), {
      jobId: "job-b1",
      channelId: "UC9999999999999999999999",
      channelFolder: "Otro_Canal",
      exportVersion: "1.1",
      exportedAt: "2026-02-20T12:00:00.000Z",
      counts: {
        totalVideosSelected: 0,
        transcriptsOk: 0,
        transcriptsMissing: 0,
        transcriptsError: 0,
        thumbnailsOk: 0,
        thumbnailsFailed: 0
      },
      warnings: [],
      artifacts: ["channel.json", "manifest.json"]
    });

    await writeJson(path.resolve(projectB, "logs", "job_job-b1.summary.json"), {
      jobId: "job-b1",
      status: "failed",
      startedAt: "2026-02-20T11:59:00.000Z",
      finishedAt: "2026-02-20T12:00:00.000Z",
      durationMs: 60000,
      warningsCount: 0,
      errorsCount: 1
    });

    const { buildServer } = await import("../src/server.js");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns projects list from exports root", async () => {
    const response = await app.inject({ method: "GET", url: "/projects" });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Array<Record<string, unknown>>;
    expect(payload).toHaveLength(2);

    const canalDemo = payload.find((item) => item.projectId === "Canal_Demo");
    const otroCanal = payload.find((item) => item.projectId === "Otro_Canal");

    expect(canalDemo?.status).toBe("partial");
    expect(canalDemo?.lastJobId).toBe("job-a1");
    expect((canalDemo?.counts as Record<string, unknown>).totalVideosSelected).toBe(2);

    expect(otroCanal?.status).toBe("failed");
    expect(otroCanal?.lastJobId).toBe("job-b1");
  });

  it("returns project detail with jobs and artifacts", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/Canal_Demo" });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, unknown>;

    expect(payload.projectId).toBe("Canal_Demo");
    expect((payload.latestJob as Record<string, unknown>).jobId).toBe("job-a1");
    expect((payload.artifacts as Record<string, unknown>).playbook).toBe("analysis/playbook.json");

    const jobs = payload.jobs as Array<Record<string, unknown>>;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].summaryPath).toContain("logs/job_job-a1.summary.json");
  });

  it("returns videos with derived performance and llm flags", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/Canal_Demo/videos" });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Array<Record<string, unknown>>;

    expect(payload).toHaveLength(2);
    const first = payload.find((item) => item.videoId === "videoA1") as Record<string, unknown>;
    const second = payload.find((item) => item.videoId === "videoA2") as Record<string, unknown>;

    expect((first.performance as Record<string, unknown>).percentile).toBe(78);
    expect((first.hasLLM as Record<string, unknown>).description).toBe(true);
    expect((first.hasLLM as Record<string, unknown>).transcript).toBe(false);
    expect(second.performance).toBeNull();
  });

  it("blocks path traversal in projectId", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/.." });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });
});
