import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const getSelectedVideoDetailsMock = vi.fn();
const analyzeChannelMock = vi.fn();
const downloadToBufferMock = vi.fn();
const getTranscriptWithFallbackMock = vi.fn();

vi.mock("../src/services/youtubeService.js", () => ({
  getSelectedVideoDetails: getSelectedVideoDetailsMock,
  analyzeChannel: analyzeChannelMock
}));

vi.mock("../src/utils/http.js", () => ({
  fetchJson: vi.fn(),
  downloadToBuffer: downloadToBufferMock
}));

vi.mock("../src/services/transcriptPipeline.js", () => ({
  getTranscriptWithFallback: getTranscriptWithFallbackMock
}));

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSsePayload(payload: string): SseEvent[] {
  const chunks = payload
    .split("\n\n")
    .map((item) => item.trim())
    .filter(Boolean);

  return chunks.map((chunk) => {
    const eventLine = chunk
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("event:"));
    const dataLine = chunk
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));

    return {
      event: eventLine ? eventLine.replace("event:", "").trim() : "message",
      data: dataLine ? (JSON.parse(dataLine.replace("data:", "").trim()) as Record<string, unknown>) : {}
    };
  });
}

describe("export jobs + SSE progress", () => {
  let app: FastifyInstance;
  let originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-export-job-"));
    process.chdir(tempDir);

    getSelectedVideoDetailsMock.mockReset();
    analyzeChannelMock.mockReset();
    downloadToBufferMock.mockReset();
    getTranscriptWithFallbackMock.mockReset();

    const { buildServer } = await import("../src/server.js");
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("emits progress events in SSE and completes with completed=total", async () => {
    getSelectedVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video0000011",
          title: "Video 1",
          publishedAt: "2025-01-01T00:00:00.000Z",
          viewCount: 10,
          thumbnailUrl: "https://img.example/video1.jpg"
        },
        {
          videoId: "video0000022",
          title: "Video 2",
          publishedAt: "2025-01-02T00:00:00.000Z",
          viewCount: 20,
          thumbnailUrl: "https://img.example/video2.jpg"
        }
      ]
    });
    downloadToBufferMock.mockResolvedValue(Buffer.from("thumbnail"));
    getTranscriptWithFallbackMock.mockImplementation(
      async (
        videoId: string,
        options: { onLocalAsrStage?: (stage: "downloading_audio" | "transcribing") => void }
      ) => {
        if (videoId === "video0000022") {
          options.onLocalAsrStage?.("downloading_audio");
          options.onLocalAsrStage?.("transcribing");
          return {
            transcript: "",
            status: "error",
            warning: "Local ASR fallback failed for video video0000022: mock error"
          };
        }

        return {
          transcript: "transcript captions video uno",
          status: "ok"
        };
      }
    );

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/export/jobs",
      payload: {
        channelId: "UC1234567890123456789012",
        channelName: "Canal Demo Jobs",
        sourceInput: "https://www.youtube.com/@demo",
        timeframe: "6m",
        selectedVideoIds: ["video0000011", "video0000022"]
      }
    });

    expect(createJobResponse.statusCode).toBe(200);
    const createJobPayload = createJobResponse.json() as { jobId: string };
    expect(createJobPayload.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    const eventsResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${createJobPayload.jobId}/events`
    });
    expect(eventsResponse.statusCode).toBe(200);
    const events = parseSsePayload(eventsResponse.body);

    expect(events[0]?.event).toBe("job_started");
    expect(events.some((event) => event.event === "video_progress")).toBe(true);
    expect(
      events.some((event) => event.event === "video_progress" && event.data.stage === "downloading_audio")
    ).toBe(true);
    expect(events.some((event) => event.event === "warning")).toBe(true);
    expect(events.at(-1)?.event).toBe("job_done");

    const lastProgressEvent = [...events]
      .reverse()
      .find((event) => event.event === "job_progress");
    expect(lastProgressEvent?.data).toMatchObject({
      completed: 2,
      total: 2
    });

    const jobStatusResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${createJobPayload.jobId}`
    });
    expect(jobStatusResponse.statusCode).toBe(200);
    const statusBody = jobStatusResponse.json() as {
      status: string;
      exportPath?: string;
      completed: number;
      total: number;
    };
    expect(statusBody.status).toBe("done");
    expect(statusBody.completed).toBe(statusBody.total);
    expect(statusBody.exportPath).toBeTruthy();

    const exportedJsonRaw = await fs.readFile(path.join(statusBody.exportPath as string, "channel.json"), "utf-8");
    const exportedJson = JSON.parse(exportedJsonRaw) as {
      videos: Array<{ videoId: string; transcript: string }>;
    };

    expect(exportedJson.videos).toHaveLength(2);
    expect(exportedJson.videos[0]?.transcript).toBe("transcript captions video uno");
    expect(exportedJson.videos[1]?.transcript).toBe("");
  });

  it("continues export with warning when transcript pipeline throws (ASR health-check failure)", async () => {
    getSelectedVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video0000099",
          title: "Video Health Fail",
          publishedAt: "2025-01-03T00:00:00.000Z",
          viewCount: 30,
          thumbnailUrl: "https://img.example/video99.jpg"
        }
      ]
    });
    downloadToBufferMock.mockResolvedValue(Buffer.from("thumbnail"));
    getTranscriptWithFallbackMock.mockRejectedValue(new Error("Local ASR disabled: unable to import faster_whisper"));

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/export/jobs",
      payload: {
        channelId: "UC1234567890123456789012",
        channelName: "Canal Demo Jobs",
        sourceInput: "https://www.youtube.com/@demo",
        timeframe: "6m",
        selectedVideoIds: ["video0000099"]
      }
    });

    expect(createJobResponse.statusCode).toBe(200);
    const createJobPayload = createJobResponse.json() as { jobId: string };

    const eventsResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${createJobPayload.jobId}/events`
    });

    expect(eventsResponse.statusCode).toBe(200);
    const events = parseSsePayload(eventsResponse.body);
    expect(events.some((event) => event.event === "warning")).toBe(true);
    expect(events.at(-1)?.event).toBe("job_done");

    const warningEvent = events.find((event) => event.event === "warning");
    expect(warningEvent?.data.message).toContain("Transcript pipeline failed");

    const jobStatusResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${createJobPayload.jobId}`
    });
    expect(jobStatusResponse.statusCode).toBe(200);
    const statusBody = jobStatusResponse.json() as { status: string; completed: number; total: number };
    expect(statusBody.status).toBe("done");
    expect(statusBody.completed).toBe(1);
    expect(statusBody.total).toBe(1);
  });
});
