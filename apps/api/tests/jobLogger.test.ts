import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJobLogger } from "../src/observability/jobLogger.js";

describe("jobLogger", () => {
  let tempDir = "";
  let exportRoot = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-job-logger-"));
    exportRoot = path.join(tempDir, "exports");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes valid JSONL events/errors", async () => {
    const jobId = "00000000-0000-4000-8000-000000000001";
    const logger = createJobLogger({
      exportRootAbs: exportRoot,
      channelFolder: "canal_demo",
      jobId,
      requestId: "req-test-1"
    });

    logger.event({
      scope: "exportService",
      action: "video_start",
      videoId: "video-a",
      msg: "video started"
    });
    logger.error({
      scope: "transcript",
      action: "transcript_fetch_failed",
      videoId: "video-a",
      err: new Error("timeout test")
    });

    await logger.close();

    const eventsPath = path.join(exportRoot, "canal_demo", "logs", `job_${jobId}.events.jsonl`);
    const errorsPath = path.join(exportRoot, "canal_demo", "logs", `job_${jobId}.errors.jsonl`);

    const eventsRaw = await fs.readFile(eventsPath, "utf-8");
    const errorsRaw = await fs.readFile(errorsPath, "utf-8");

    const events = eventsRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const errors = errorsRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.jobId).toBe(jobId);
    expect(typeof events[0]?.stepId).toBe("string");
    expect(typeof events[0]?.ts).toBe("string");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.scope).toBe("transcript");
    expect(errors[0]?.action).toBe("transcript_fetch_failed");
    expect((errors[0]?.error as { message?: string })?.message).toContain("timeout");
  });

  it("writes summary.json with aggregate status", async () => {
    const jobId = "00000000-0000-4000-8000-000000000002";
    const logger = createJobLogger({
      exportRootAbs: exportRoot,
      channelFolder: "canal_demo_summary",
      jobId,
      requestId: "req-test-2"
    });

    logger.event({
      scope: "exportService",
      action: "video_start",
      videoId: "video-b",
      msg: "video started"
    });
    logger.event({
      scope: "exportService",
      action: "cache_hit_full",
      videoId: "video-b",
      msg: "cache hit full"
    });
    logger.event({
      scope: "exportService",
      action: "video_done",
      videoId: "video-b",
      msg: "video done",
      data: {
        status: "done",
        timingsMs: {
          transcript: 120,
          video_total: 320
        }
      }
    });

    await logger.summary({
      status: "done",
      startedAt: "2026-03-02T00:00:00.000Z",
      finishedAt: "2026-03-02T00:00:01.000Z",
      exportedCount: 1
    });
    await logger.close();

    const summaryPath = path.join(exportRoot, "canal_demo_summary", "logs", `job_${jobId}.summary.json`);
    const summaryRaw = await fs.readFile(summaryPath, "utf-8");
    const summary = JSON.parse(summaryRaw) as {
      status: string;
      exportedCount: number;
      perStageTimingsMs: { transcript?: number };
      perVideo: Record<string, { cacheHit?: string; status?: string }>;
    };

    expect(summary.status).toBe("done");
    expect(summary.exportedCount).toBe(1);
    expect((summary.perStageTimingsMs.transcript ?? 0) > 0).toBe(true);
    expect(summary.perVideo["video-b"]?.cacheHit).toBe("full");
    expect(summary.perVideo["video-b"]?.status).toBe("done");
  });
});

