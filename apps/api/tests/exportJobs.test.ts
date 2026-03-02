import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const getSelectedVideoDetailsMock = vi.fn();
const getVideoDetailsMock = vi.fn();
const getChannelDetailsMock = vi.fn();
const analyzeChannelMock = vi.fn();
const downloadToBufferMock = vi.fn();
const getTranscriptWithFallbackMock = vi.fn();

vi.mock("../src/services/youtubeService.js", () => ({
  getSelectedVideoDetails: getSelectedVideoDetailsMock,
  getVideoDetails: getVideoDetailsMock,
  getChannelDetails: getChannelDetailsMock,
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
  const originalAutoGenEnabled = process.env.AUTO_GEN_ENABLED;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalThumbOcrEnabled = process.env.THUMB_OCR_ENABLED;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-export-job-"));
    process.chdir(tempDir);
    process.env.AUTO_GEN_ENABLED = "false";
    process.env.THUMB_OCR_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    getSelectedVideoDetailsMock.mockReset();
    getVideoDetailsMock.mockReset();
    getChannelDetailsMock.mockReset();
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
    if (typeof originalAutoGenEnabled === "string") {
      process.env.AUTO_GEN_ENABLED = originalAutoGenEnabled;
    } else {
      delete process.env.AUTO_GEN_ENABLED;
    }
    if (typeof originalOpenAiApiKey === "string") {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    if (typeof originalThumbOcrEnabled === "string") {
      process.env.THUMB_OCR_ENABLED = originalThumbOcrEnabled;
    } else {
      delete process.env.THUMB_OCR_ENABLED;
    }
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
    getVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video0000011",
          title: "Video 1",
          description: "Descripcion completa video 1",
          publishedAt: "2025-01-01T00:00:00.000Z",
          durationSec: 125,
          categoryId: "22",
          tags: ["tag-1", "tag-2"],
          defaultLanguage: "es",
          defaultAudioLanguage: "es",
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 10,
            likeCount: 2,
            commentCount: 1
          },
          thumbnails: {
            default: { url: "https://img.example/video1-default.jpg", width: 120, height: 90 },
            high: { url: "https://img.example/video1.jpg", width: 480, height: 360 }
          },
          thumbnailOriginalUrl: "https://img.example/video1.jpg"
        },
        {
          videoId: "video0000022",
          title: "Video 2",
          description: "Descripcion completa video 2",
          publishedAt: "2025-01-02T00:00:00.000Z",
          durationSec: 245,
          categoryId: "24",
          tags: [],
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 20,
            likeCount: 4,
            commentCount: 2
          },
          thumbnails: {
            high: { url: "https://img.example/video2.jpg", width: 480, height: 360 }
          },
          thumbnailOriginalUrl: "https://img.example/video2.jpg"
        }
      ]
    });
    getChannelDetailsMock.mockResolvedValue({
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo Jobs",
      channelStats: {
        subscriberCount: 999,
        viewCount: 123456,
        videoCount: 321,
        country: "US",
        publishedAt: "2020-01-01T00:00:00.000Z",
        customUrl: "@demo",
        handle: "@demo"
      },
      warnings: []
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
            source: "none",
            warning: "Local ASR fallback failed for video video0000022: mock error"
          };
        }

        return {
          transcript: "transcript captions video uno",
          status: "ok",
          source: "captions"
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
    expect(
      events.some(
        (event) =>
          event.event === "warning" &&
          typeof event.data.message === "string" &&
          event.data.message.includes("Performance model skipped")
      )
    ).toBe(true);
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
      videos: Array<{
        videoId: string;
        transcript: string;
        transcriptSource?: "captions" | "asr" | "none";
        transcriptPath?: string;
      }>;
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
    expect(exportedJson.videos[0]?.transcriptSource).toBe("captions");
    expect(exportedJson.videos[0]?.transcriptPath).toBe("raw/transcripts/video0000011.jsonl");
    expect(exportedJson.videos[1]?.transcriptSource).toBe("none");
    expect(exportedJson.videos[1]?.transcriptPath).toBe("raw/transcripts/video0000022.jsonl");

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
    expect(manifest.artifacts).toEqual(
      expect.arrayContaining([
        "raw/channel.json",
        "raw/videos.jsonl",
        "manifest.json",
        "derived/channel_models.json",
        "derived/video_features/video0000011.json",
        "derived/video_features/video0000022.json"
      ])
    );
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
      channelStats?: {
        subscriberCount?: number;
        handle?: string;
      };
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
    expect(rawChannel.channelStats?.subscriberCount).toBe(999);
    expect(rawChannel.channelStats?.handle).toBe("@demo");
    expect(rawChannel.provenance.dataSources.length).toBeGreaterThan(0);
    expect(typeof rawChannel.provenance.env.LOCAL_ASR_ENABLED).toBe("boolean");
    expect(rawChannel.provenance.env.TRANSCRIPT_LANG === null || typeof rawChannel.provenance.env.TRANSCRIPT_LANG === "string").toBe(true);

    const rawVideosRaw = await fs.readFile(path.join(statusBody.exportPath as string, "raw", "videos.jsonl"), "utf-8");
    const rawVideos = rawVideosRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            videoId: string;
            description: string;
            durationSec: number;
            statistics: { viewCount: number; likeCount: number; commentCount: number };
            transcriptRef: {
              transcriptPath: string;
              transcriptSource: "captions" | "asr" | "none";
              transcriptStatus: "ok" | "missing" | "error";
            };
            thumbnailLocalPath: string;
            thumbnailOriginalUrl: string;
            daysSincePublish: number;
            viewsPerDay: number;
            likeRate: number;
            commentRate: number;
          }
      );
    expect(rawVideos).toHaveLength(2);
    expect(new Set(rawVideos.map((entry) => entry.videoId))).toEqual(new Set(["video0000011", "video0000022"]));
    const firstVideo = rawVideos.find((entry) => entry.videoId === "video0000011");
    expect(firstVideo?.description).toBe("Descripcion completa video 1");
    expect(firstVideo?.durationSec).toBe(125);
    expect(firstVideo?.statistics.viewCount).toBe(10);
    expect(firstVideo?.transcriptRef.transcriptPath).toBe("raw/transcripts/video0000011.jsonl");
    expect(firstVideo?.transcriptRef.transcriptSource).toBe("captions");
    expect(firstVideo?.thumbnailLocalPath).toBe("raw/thumbnails/video0000011.jpg");
    expect(firstVideo?.thumbnailOriginalUrl).toBe("https://img.example/video1.jpg");
    expect(typeof firstVideo?.daysSincePublish).toBe("number");
    expect(typeof firstVideo?.viewsPerDay).toBe("number");
    expect(typeof firstVideo?.likeRate).toBe("number");
    expect(typeof firstVideo?.commentRate).toBe("number");

    const transcriptVideoOneRaw = await fs.readFile(
      path.join(statusBody.exportPath as string, "raw", "transcripts", "video0000011.jsonl"),
      "utf-8"
    );
    const transcriptVideoOneLines = transcriptVideoOneRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(transcriptVideoOneLines.length).toBeGreaterThanOrEqual(2);

    const transcriptMeta = transcriptVideoOneLines[0] as {
      type: "meta";
      status: string;
      source: string;
      language: string;
      transcriptCleaned: boolean;
      model: string | null;
      computeType: string | null;
    };
    expect(transcriptMeta.type).toBe("meta");
    expect(transcriptMeta.status).toBe("ok");
    expect(transcriptMeta.source).toBe("captions");
    expect(typeof transcriptMeta.language).toBe("string");
    expect(transcriptMeta.transcriptCleaned).toBe(false);
    expect(transcriptMeta.model).toBe(null);
    expect(transcriptMeta.computeType).toBe(null);

    const transcriptSegments = transcriptVideoOneLines.filter((line) => line.type === "segment");
    expect(transcriptSegments).toHaveLength(1);
    expect(transcriptSegments[0]).toMatchObject({
      type: "segment",
      i: 0,
      startSec: null,
      endSec: null,
      text: "transcript captions video uno",
      confidence: null
    });

    const derivedVideoOneRaw = await fs.readFile(
      path.join(statusBody.exportPath as string, "derived", "video_features", "video0000011.json"),
      "utf-8"
    );
    await fs.access(path.join(statusBody.exportPath as string, "derived", "video_features", "video0000022.json"));
    const channelModelsRaw = await fs.readFile(
      path.join(statusBody.exportPath as string, "derived", "channel_models.json"),
      "utf-8"
    );
    const channelModels = JSON.parse(channelModelsRaw) as {
      schemaVersion: string;
      channelId: string;
      timeframe: string;
      model: {
        type: string;
        fit: {
          n: number;
          notes: string[];
        };
      };
    };
    expect(channelModels.schemaVersion).toBe("derived.channel_models.v1");
    expect(channelModels.channelId).toBe("UC1234567890123456789012");
    expect(channelModels.timeframe).toBe("6m");
    expect(channelModels.model.type).toBe("robust-linear");
    expect(channelModels.model.fit.n).toBe(2);
    expect(channelModels.model.fit.notes.some((note) => note.includes("requires at least 5 videos"))).toBe(true);

    const derivedVideoOne = JSON.parse(derivedVideoOneRaw) as {
      schemaVersion: string;
      videoId: string;
      titleFeatures: {
        deterministic: {
          title_len_chars: number;
          title_keyword_coverage: number;
        };
        llm: unknown;
      };
      descriptionFeatures: {
        deterministic: {
          desc_len_chars: number;
          url_count: number;
        };
        llm: unknown;
        warnings: string[];
      };
      transcriptFeatures: {
        deterministic: {
          title_keyword_coverage: number;
          promise_delivery_30s_score: number | null;
        };
        llm: unknown;
        warnings: string[];
      };
      thumbnailFeatures: {
        deterministic: {
          imageWidth: number;
          imageHeight: number;
          hasBigText: boolean;
        };
        llm: unknown;
        warnings: string[];
      };
      performance: {
        daysSincePublish: number;
        viewsPerDay: number;
        likeRate: number | null;
        commentRate: number | null;
        engagementRate: number | null;
        logViews: number;
        residual: number | null;
        percentile: number | null;
      };
    };
    expect(derivedVideoOne.schemaVersion).toBe("derived.video_features.v1");
    expect(derivedVideoOne.videoId).toBe("video0000011");
    expect(derivedVideoOne.titleFeatures.deterministic.title_len_chars).toBeGreaterThan(0);
    expect(typeof derivedVideoOne.titleFeatures.deterministic.title_keyword_coverage).toBe("number");
    expect(derivedVideoOne.titleFeatures.llm).toBeNull();
    expect(derivedVideoOne.descriptionFeatures.deterministic.desc_len_chars).toBeGreaterThan(0);
    expect(typeof derivedVideoOne.descriptionFeatures.deterministic.url_count).toBe("number");
    expect(Array.isArray(derivedVideoOne.descriptionFeatures.warnings)).toBe(true);
    expect(typeof derivedVideoOne.transcriptFeatures.deterministic.title_keyword_coverage).toBe("number");
    expect(derivedVideoOne.transcriptFeatures.deterministic.promise_delivery_30s_score).toBeNull();
    expect(Array.isArray(derivedVideoOne.transcriptFeatures.warnings)).toBe(true);
    expect(derivedVideoOne.thumbnailFeatures.deterministic.imageWidth).toBeGreaterThanOrEqual(0);
    expect(derivedVideoOne.thumbnailFeatures.deterministic.imageHeight).toBeGreaterThanOrEqual(0);
    expect(typeof derivedVideoOne.thumbnailFeatures.deterministic.hasBigText).toBe("boolean");
    expect(derivedVideoOne.thumbnailFeatures.llm).toBeNull();
    expect(Array.isArray(derivedVideoOne.thumbnailFeatures.warnings)).toBe(true);
    expect(typeof derivedVideoOne.performance.daysSincePublish).toBe("number");
    expect(typeof derivedVideoOne.performance.viewsPerDay).toBe("number");
    expect(typeof derivedVideoOne.performance.logViews).toBe("number");
    expect(derivedVideoOne.performance.residual).toBeNull();
    expect(derivedVideoOne.performance.percentile).toBeNull();
  });

  it("writes transcript artifact with meta only when transcript is missing", async () => {
    getSelectedVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video0000088",
          title: "Video Missing Transcript",
          publishedAt: "2025-01-04T00:00:00.000Z",
          viewCount: 40,
          thumbnailUrl: "https://img.example/video88.jpg"
        }
      ]
    });
    getVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video0000088",
          title: "Video Missing Transcript",
          description: "Descripcion 88",
          publishedAt: "2025-01-04T00:00:00.000Z",
          durationSec: 180,
          categoryId: "22",
          tags: [],
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 40,
            likeCount: 0,
            commentCount: 0
          },
          thumbnails: {
            high: { url: "https://img.example/video88.jpg", width: 480, height: 360 }
          },
          thumbnailOriginalUrl: "https://img.example/video88.jpg"
        }
      ]
    });
    getChannelDetailsMock.mockResolvedValue({
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo Jobs",
      channelStats: {
        subscriberCount: 1000
      },
      warnings: []
    });
    downloadToBufferMock.mockResolvedValue(Buffer.from("thumbnail"));
    getTranscriptWithFallbackMock.mockResolvedValue({
      transcript: "",
      status: "missing",
      source: "none",
      warning: "Transcript unavailable for video video0000088 (captions missing/disabled)"
    });

    const createJobResponse = await app.inject({
      method: "POST",
      url: "/export/jobs",
      payload: {
        channelId: "UC1234567890123456789012",
        channelName: "Canal Demo Jobs",
        sourceInput: "https://www.youtube.com/@demo",
        timeframe: "6m",
        selectedVideoIds: ["video0000088"]
      }
    });
    expect(createJobResponse.statusCode).toBe(200);

    const { jobId } = createJobResponse.json() as { jobId: string };
    const eventsResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${jobId}/events`
    });
    expect(eventsResponse.statusCode).toBe(200);
    const events = parseSsePayload(eventsResponse.body);
    expect(events.at(-1)?.event).toBe("job_done");

    const jobStatusResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${jobId}`
    });
    expect(jobStatusResponse.statusCode).toBe(200);
    const statusBody = jobStatusResponse.json() as {
      status: string;
      exportPath?: string;
    };
    expect(statusBody.status).toBe("done");

    const transcriptArtifactRaw = await fs.readFile(
      path.join(statusBody.exportPath as string, "raw", "transcripts", "video0000088.jsonl"),
      "utf-8"
    );
    const transcriptArtifactLines = transcriptArtifactRaw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(transcriptArtifactLines).toHaveLength(1);
    expect(transcriptArtifactLines[0]).toMatchObject({
      type: "meta",
      videoId: "video0000088",
      source: "none",
      status: "missing"
    });
    expect(typeof transcriptArtifactLines[0]?.warning).toBe("string");
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
    getVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video0000099",
          title: "Video Health Fail",
          description: "Descripcion 99",
          publishedAt: "2025-01-03T00:00:00.000Z",
          durationSec: 180,
          categoryId: "22",
          tags: [],
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 30,
            likeCount: 0,
            commentCount: 0
          },
          thumbnails: {
            high: { url: "https://img.example/video99.jpg", width: 480, height: 360 }
          },
          thumbnailOriginalUrl: "https://img.example/video99.jpg"
        }
      ]
    });
    getChannelDetailsMock.mockResolvedValue({
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo Jobs",
      channelStats: {
        subscriberCount: 1000
      },
      warnings: []
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
