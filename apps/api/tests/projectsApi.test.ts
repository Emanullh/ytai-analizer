import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { FastifyInstance } from "fastify";
import yauzl from "yauzl";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeThumbnail(filePath: string): Promise<void> {
  const buffer = Buffer.alloc(64 * 64 * 3, 220);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await sharp(buffer, { raw: { width: 64, height: 64, channels: 3 } }).jpeg({ quality: 90 }).toFile(filePath);
}

async function waitForRerunJob(app: FastifyInstance, projectId: string, jobId: string): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const response = await app.inject({
      method: "GET",
      url: `/projects/${encodeURIComponent(projectId)}/rerun/thumbnails/jobs/${jobId}`
    });
    if (response.statusCode !== 200) {
      throw new Error(`Unexpected status while polling rerun job: ${response.statusCode}`);
    }
    const payload = response.json() as Record<string, unknown>;
    const status = payload.status;
    if (status === "done" || status === "failed") {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting rerun job ${jobId}`);
}

async function readZipFiles(buffer: Buffer): Promise<Record<string, string>> {
  return await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error("Zip could not be opened"));
        return;
      }
      const files: Record<string, string> = {};
      zipFile.readEntry();

      zipFile.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, readStream) => {
          if (streamError || !readStream) {
            reject(streamError ?? new Error("Zip stream error"));
            return;
          }
          const chunks: Buffer[] = [];
          readStream.on("data", (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          readStream.on("error", (streamReadError) => {
            reject(streamReadError);
          });
          readStream.on("end", () => {
            files[entry.fileName] = Buffer.concat(chunks).toString("utf-8");
            zipFile.readEntry();
          });
        });
      });

      zipFile.on("error", (zipError) => {
        reject(zipError);
      });
      zipFile.on("end", () => {
        resolve(files);
      });
    });
  });
}

describe("projects API", () => {
  let app: FastifyInstance;
  let originalCwd = process.cwd();
  let tempDir = "";
  const originalThumbOcrEnabled = process.env.THUMB_OCR_ENABLED;
  const originalAutoGenEnabled = process.env.AUTO_GEN_ENABLED;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-projects-"));
    process.chdir(tempDir);
    process.env.THUMB_OCR_ENABLED = "false";
    process.env.AUTO_GEN_ENABLED = "false";

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
    await writeJson(path.resolve(projectA, "analysis", "orchestrator_input.json"), {
      schemaVersion: "analysis.orchestrator_input.v1",
      generatedAt: "2026-03-01T12:00:00.000Z",
      channel: {
        channelId: "UC1234567890123456789012",
        channelName: "Canal Demo",
        timeframe: "6m",
        jobId: "job-a1"
      },
      exemplars: {
        top_videos: [{ videoId: "videoA1" }],
        bottom_videos: [{ videoId: "videoA2" }],
        mid_videos: [{ videoId: "videoA3" }]
      },
      rows: [],
      summary: {
        totalVideos: 2,
        withResidual: 1,
        withPercentile: 1,
        warningsCount: 0
      },
      channelModel: null,
      cohorts: [],
      drivers: [],
      warnings: []
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
    await writeJson(path.resolve(projectA, "raw", "channel.json"), {
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      timeframe: "6m"
    });
    await fs.writeFile(
      path.resolve(projectA, "raw", "videos.jsonl"),
      JSON.stringify({ videoId: "videoA1", title: "Video A1", description: "desc" }) + "\n",
      "utf-8"
    );

    await writeThumbnail(path.resolve(projectA, "thumbnails", "videoA1.jpg"));

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
    if (typeof originalThumbOcrEnabled === "string") {
      process.env.THUMB_OCR_ENABLED = originalThumbOcrEnabled;
    } else {
      delete process.env.THUMB_OCR_ENABLED;
    }
    if (typeof originalAutoGenEnabled === "string") {
      process.env.AUTO_GEN_ENABLED = originalAutoGenEnabled;
    } else {
      delete process.env.AUTO_GEN_ENABLED;
    }
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

  it("returns bundle metadata resolving latest successful export", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/Canal_Demo/bundle/meta?export=latest" });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, unknown>;
    expect(payload.exportJobId).toBe("job-a1");
    expect(payload.rawVideosMode).toBe("full");
    expect(Array.isArray(payload.includedFiles)).toBe(true);
    expect(Array.isArray(payload.missingFiles)).toBe(true);
  });

  it("downloads bundle zip and reports missing optional files", async () => {
    const response = await app.inject({ method: "GET", url: "/projects/Canal_Demo/bundle?export=latest" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    const files = await readZipFiles(response.rawPayload);

    expect(files["bundle.json"]).toBeTruthy();
    expect(files["analysis/orchestrator_input.json"]).toBeTruthy();
    expect(files["primary/channel.json"]).toBeTruthy();
    expect(files["primary/manifest.json"]).toBeTruthy();
    expect(files["raw/channel.json"]).toBeTruthy();
    expect(files["raw/videos.jsonl"]).toBeTruthy();
    expect(files["derived/video_features/videoA1.json"]).toBeTruthy();
    expect(files["notes/missing_files.json"]).toBeTruthy();

    const bundleJson = JSON.parse(files["bundle.json"]) as Record<string, unknown>;
    expect(bundleJson.exportJobId).toBe("job-a1");

    const missingJson = JSON.parse(files["notes/missing_files.json"]) as Record<string, unknown>;
    const missingFiles = missingJson.files as Array<Record<string, unknown>>;
    const missingPaths = missingFiles.map((item) => item.path);
    expect(missingPaths).toContain("derived/video_features/videoA2.json");
    expect(missingPaths).toContain("derived/video_features/videoA3.json");
  });

  it("runs manual thumbnail rerun and updates derived thumbnailFeatures", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/projects/Canal_Demo/rerun/thumbnails",
      payload: {
        scope: "selected",
        videoIds: ["videoA1"],
        engine: "python",
        force: true
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const createPayload = createResponse.json() as { jobId: string };
    expect(createPayload.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const job = await waitForRerunJob(app, "Canal_Demo", createPayload.jobId);
    expect(job.status).toBe("done");
    expect(job.processed).toBe(1);
    expect(typeof job.auditArtifactPath).toBe("string");

    const derivedRaw = await fs.readFile(
      path.resolve(tempDir, "exports", "Canal_Demo", "derived", "video_features", "videoA1.json"),
      "utf-8"
    );
    const derived = JSON.parse(derivedRaw) as Record<string, unknown>;
    const thumbnailFeatures = derived.thumbnailFeatures as Record<string, unknown>;
    expect(thumbnailFeatures).toBeTruthy();
    expect(thumbnailFeatures.deterministic).toBeTruthy();
  });

  it("supports thumbnails-and-orchestrator chained rerun", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/projects/Canal_Demo/rerun/thumbnails-and-orchestrator",
      payload: {
        scope: "all",
        engine: "python",
        force: true
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const createPayload = createResponse.json() as { jobId: string };

    const job = await waitForRerunJob(app, "Canal_Demo", createPayload.jobId);
    expect(job.status).toBe("done");
    expect(job.orchestratorRebuilt).toBe(true);

    const orchestratorRaw = await fs.readFile(
      path.resolve(tempDir, "exports", "Canal_Demo", "analysis", "orchestrator_input.json"),
      "utf-8"
    );
    const orchestratorInput = JSON.parse(orchestratorRaw) as Record<string, unknown>;
    expect(orchestratorInput.schemaVersion).toBe("analysis.orchestrator_input.v1");
    expect(Array.isArray(orchestratorInput.cohorts)).toBe(true);
    expect(Array.isArray(orchestratorInput.drivers)).toBe(true);
  });
});
