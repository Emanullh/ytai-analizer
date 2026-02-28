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

function isSafeRelativeArtifact(artifactPath: string): boolean {
  if (!artifactPath || path.isAbsolute(artifactPath)) {
    return false;
  }

  const normalized = artifactPath.replace(/\\/g, "/");
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    return false;
  }

  return true;
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
      exportVersion: string;
      exportedAt: string;
      timeframeResolved: { publishedAfter: string; publishedBefore: string };
      videos: Array<{ videoId: string; transcript: string }>;
    };

    expect(exportedJson.exportVersion).toBe("1.1");
    expect(new Date(exportedJson.exportedAt).toISOString()).toBe(exportedJson.exportedAt);
    expect(new Date(exportedJson.timeframeResolved.publishedAfter).toISOString()).toBe(
      exportedJson.timeframeResolved.publishedAfter
    );
    expect(new Date(exportedJson.timeframeResolved.publishedBefore).toISOString()).toBe(
      exportedJson.timeframeResolved.publishedBefore
    );
    expect(exportedJson.videos).toHaveLength(2);
    expect(exportedJson.videos[0]?.transcript).toBe("transcript captions video uno");
    expect(exportedJson.videos[1]?.transcript).toBe("");

    const manifestRaw = await fs.readFile(path.join(statusBody.exportPath as string, "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as {
      jobId: string;
      channelFolder: string;
      exportVersion: string;
      counts: {
        totalVideosSelected: number;
        transcriptsOk: number;
        transcriptsMissing: number;
        transcriptsError: number;
        thumbnailsOk: number;
        thumbnailsFailed: number;
      };
      artifacts: string[];
    };
    expect(manifest.jobId).toBe(createJobPayload.jobId);
    expect(manifest.channelFolder).toBe(path.basename(statusBody.exportPath as string));
    expect(manifest.exportVersion).toBe("1.1");
    expect(manifest.counts).toMatchObject({
      totalVideosSelected: 2,
      transcriptsOk: 1,
      transcriptsMissing: 0,
      transcriptsError: 1,
      thumbnailsOk: 2,
      thumbnailsFailed: 0
    });
    expect(manifest.artifacts).toEqual(expect.arrayContaining(["raw/channel.json", "raw/videos.jsonl", "manifest.json"]));
    for (const artifact of manifest.artifacts) {
      expect(isSafeRelativeArtifact(artifact)).toBe(true);
      const resolvedArtifactPath = path.resolve(statusBody.exportPath as string, artifact);
      const exportPathRoot = path.resolve(statusBody.exportPath as string);
      expect(resolvedArtifactPath === exportPathRoot || resolvedArtifactPath.startsWith(`${exportPathRoot}${path.sep}`)).toBe(true);
    }

    const rawChannelRaw = await fs.readFile(path.join(statusBody.exportPath as string, "raw", "channel.json"), "utf-8");
    const rawChannel = JSON.parse(rawChannelRaw) as {
      exportVersion: string;
      jobId: string;
      provenance: {
        dataSources: string[];
        env: {
          LOCAL_ASR_ENABLED: boolean;
          TRANSCRIPT_LANG: string | null;
        };
      };
    };
    expect(rawChannel.exportVersion).toBe("1.1");
    expect(rawChannel.jobId).toBe(createJobPayload.jobId);
    expect(rawChannel.provenance.dataSources.length).toBeGreaterThan(0);
    expect(typeof rawChannel.provenance.env.LOCAL_ASR_ENABLED).toBe("boolean");
    expect(rawChannel.provenance.env.TRANSCRIPT_LANG === null || typeof rawChannel.provenance.env.TRANSCRIPT_LANG === "string").toBe(true);

    const rawVideosRaw = await fs.readFile(path.join(statusBody.exportPath as string, "raw", "videos.jsonl"), "utf-8");
    const rawVideos = rawVideosRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { videoId: string; transcriptPath: string });
    expect(rawVideos).toHaveLength(2);
    expect(rawVideos.map((entry) => entry.videoId)).toEqual(["video0000011", "video0000022"]);
    expect(rawVideos[0]?.transcriptPath).toBe("raw/transcripts/video0000011.jsonl");

    const transcriptVideoOneRaw = await fs.readFile(
      path.join(statusBody.exportPath as string, "raw", "transcripts", "video0000011.jsonl"),
      "utf-8"
    );
    const transcriptVideoOne = JSON.parse(transcriptVideoOneRaw.trim()) as { transcriptStatus: string; transcript: string };
    expect(transcriptVideoOne.transcriptStatus).toBe("ok");
    expect(transcriptVideoOne.transcript).toBe("transcript captions video uno");
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
