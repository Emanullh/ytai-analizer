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
const runOcrMock = vi.fn();
const requestAutoGenTaskMock = vi.fn();

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

vi.mock("../src/derived/ocr/tesseractOcr.js", () => ({
  runOcr: runOcrMock,
  clearOcrCache: vi.fn(),
  terminateOcrWorkers: vi.fn()
}));

vi.mock("../src/services/autogenRuntime.js", () => ({
  requestAutoGenTask: requestAutoGenTaskMock,
  startAutoGenWorker: vi.fn(),
  stopAutoGenWorker: vi.fn()
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
    runOcrMock.mockReset();
    requestAutoGenTaskMock.mockReset();

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
        "analysis/orchestrator_input.json",
        "analysis/playbook.json",
        "derived/channel_models.json",
        "derived/templates.json",
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
    const playbookRaw = await fs.readFile(path.join(statusBody.exportPath as string, "analysis", "playbook.json"), "utf-8");
    const templatesRaw = await fs.readFile(path.join(statusBody.exportPath as string, "derived", "templates.json"), "utf-8");
    await fs.access(path.join(statusBody.exportPath as string, "analysis", "orchestrator_input.json"));

    const playbook = JSON.parse(playbookRaw) as {
      schemaVersion: string;
      warnings: string[];
      insights: unknown[];
    };
    const templates = JSON.parse(templatesRaw) as {
      schemaVersion: string;
      warnings: string[];
      titleTemplates: unknown[];
    };

    expect(playbook.schemaVersion).toBe("analysis.playbook.v1");
    expect(templates.schemaVersion).toBe("derived.templates.v1");
    expect(Array.isArray(playbook.insights)).toBe(true);
    expect(Array.isArray(templates.titleTemplates)).toBe(true);
    expect(playbook.warnings.some((warning) => warning.includes("Channel orchestrator LLM skipped"))).toBe(true);
    expect(templates.warnings.some((warning) => warning.includes("Channel orchestrator LLM skipped"))).toBe(true);

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

  it("reuses cached per-video artifacts on second export and only recomputes cross-video outputs", async () => {
    process.env.THUMB_OCR_ENABLED = "true";
    process.env.AUTO_GEN_ENABLED = "false";
    runOcrMock.mockResolvedValue({
      text: "Big cache text",
      confidenceMean: 0.9,
      boxes: [{ x: 2, y: 2, w: 80, h: 24, confidence: 0.9, text: "Big" }]
    });

    const selectedVideos = [
      {
        videoId: "video0000411",
        title: "Video Cache 1",
        publishedAt: "2025-01-01T00:00:00.000Z",
        viewCount: 10,
        thumbnailUrl: "https://img.example/cache-1.jpg"
      },
      {
        videoId: "video0000422",
        title: "Video Cache 2",
        publishedAt: "2025-01-02T00:00:00.000Z",
        viewCount: 20,
        thumbnailUrl: "https://img.example/cache-2.jpg"
      }
    ];
    const detailedVideos = [
      {
        videoId: "video0000411",
        title: "Video Cache 1",
        description: "Descripcion cache 1",
        publishedAt: "2025-01-01T00:00:00.000Z",
        durationSec: 125,
        categoryId: "22",
        tags: ["cache"],
        madeForKids: false,
        liveBroadcastContent: "none",
        statistics: {
          viewCount: 10,
          likeCount: 2,
          commentCount: 1
        },
        thumbnails: {
          high: { url: "https://img.example/cache-1.jpg", width: 480, height: 360 }
        },
        thumbnailOriginalUrl: "https://img.example/cache-1.jpg"
      },
      {
        videoId: "video0000422",
        title: "Video Cache 2",
        description: "Descripcion cache 2",
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
          high: { url: "https://img.example/cache-2.jpg", width: 480, height: 360 }
        },
        thumbnailOriginalUrl: "https://img.example/cache-2.jpg"
      }
    ];

    getSelectedVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: selectedVideos
    });
    getVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: detailedVideos
    });
    getChannelDetailsMock.mockResolvedValue({
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo Jobs",
      channelStats: {
        subscriberCount: 999
      },
      warnings: []
    });
    downloadToBufferMock.mockImplementation(async (url: string) => Buffer.from(`thumbnail-${url}`));
    getTranscriptWithFallbackMock.mockImplementation(async (videoId: string) => ({
      transcript: `cached transcript ${videoId}`,
      status: "ok",
      source: "captions"
    }));

    const firstJob = await app.inject({
      method: "POST",
      url: "/export/jobs",
      payload: {
        channelId: "UC1234567890123456789012",
        channelName: "Canal Demo Jobs",
        sourceInput: "https://www.youtube.com/@demo",
        timeframe: "6m",
        selectedVideoIds: selectedVideos.map((video) => video.videoId)
      }
    });
    expect(firstJob.statusCode).toBe(200);
    const firstJobId = (firstJob.json() as { jobId: string }).jobId;
    const firstEventsResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${firstJobId}/events`
    });
    const firstEvents = parseSsePayload(firstEventsResponse.body);
    expect(firstEvents.at(-1)?.event).toBe("job_done");
    const firstStatusResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${firstJobId}`
    });
    const firstStatus = firstStatusResponse.json() as { status: string; exportPath?: string };
    expect(firstStatus.status).toBe("done");
    const exportPath = firstStatus.exportPath as string;

    const firstChannelModelsRaw = await fs.readFile(path.join(exportPath, "derived", "channel_models.json"), "utf-8");
    const firstPlaybookRaw = await fs.readFile(path.join(exportPath, "analysis", "playbook.json"), "utf-8");
    const firstTemplatesRaw = await fs.readFile(path.join(exportPath, "derived", "templates.json"), "utf-8");
    const transcriptBefore = await fs.readFile(path.join(exportPath, "raw", "transcripts", "video0000411.jsonl"), "utf-8");

    const firstChannelModels = JSON.parse(firstChannelModelsRaw) as { computedAt: string };
    const firstPlaybook = JSON.parse(firstPlaybookRaw) as { generatedAt: string };
    const firstTemplates = JSON.parse(firstTemplatesRaw) as { generatedAt: string };

    expect(getTranscriptWithFallbackMock).toHaveBeenCalledTimes(2);
    expect(downloadToBufferMock).toHaveBeenCalledTimes(2);

    getTranscriptWithFallbackMock.mockClear();
    downloadToBufferMock.mockClear();
    runOcrMock.mockClear();
    requestAutoGenTaskMock.mockClear();

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondJob = await app.inject({
      method: "POST",
      url: "/export/jobs",
      payload: {
        channelId: "UC1234567890123456789012",
        channelName: "Canal Demo Jobs",
        sourceInput: "https://www.youtube.com/@demo",
        timeframe: "6m",
        selectedVideoIds: selectedVideos.map((video) => video.videoId)
      }
    });
    expect(secondJob.statusCode).toBe(200);
    const secondJobId = (secondJob.json() as { jobId: string }).jobId;

    const secondEventsResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${secondJobId}/events`
    });
    const secondEvents = parseSsePayload(secondEventsResponse.body);
    expect(secondEvents.at(-1)?.event).toBe("job_done");
    expect(
      secondEvents.some(
        (event) =>
          event.event === "warning" &&
          typeof event.data.message === "string" &&
          event.data.message.includes("cache hit: reused transcript/thumbnail/derived")
      )
    ).toBe(true);

    const secondStatusResponse = await app.inject({
      method: "GET",
      url: `/export/jobs/${secondJobId}`
    });
    const secondStatus = secondStatusResponse.json() as { status: string; exportPath?: string };
    expect(secondStatus.status).toBe("done");

    expect(getTranscriptWithFallbackMock).toHaveBeenCalledTimes(0);
    expect(downloadToBufferMock).toHaveBeenCalledTimes(0);
    expect(runOcrMock).toHaveBeenCalledTimes(0);
    expect(requestAutoGenTaskMock).toHaveBeenCalledTimes(0);

    const secondChannelModelsRaw = await fs.readFile(path.join(exportPath, "derived", "channel_models.json"), "utf-8");
    const secondPlaybookRaw = await fs.readFile(path.join(exportPath, "analysis", "playbook.json"), "utf-8");
    const secondTemplatesRaw = await fs.readFile(path.join(exportPath, "derived", "templates.json"), "utf-8");
    const transcriptAfter = await fs.readFile(path.join(exportPath, "raw", "transcripts", "video0000411.jsonl"), "utf-8");

    const secondChannelModels = JSON.parse(secondChannelModelsRaw) as { computedAt: string };
    const secondPlaybook = JSON.parse(secondPlaybookRaw) as { generatedAt: string };
    const secondTemplates = JSON.parse(secondTemplatesRaw) as { generatedAt: string };

    expect(new Date(secondChannelModels.computedAt).getTime()).toBeGreaterThan(
      new Date(firstChannelModels.computedAt).getTime()
    );
    expect(new Date(secondPlaybook.generatedAt).getTime()).toBeGreaterThan(
      new Date(firstPlaybook.generatedAt).getTime()
    );
    expect(new Date(secondTemplates.generatedAt).getTime()).toBeGreaterThan(
      new Date(firstTemplates.generatedAt).getTime()
    );
    expect(transcriptAfter).toBe(transcriptBefore);

    const cacheIndexRaw = await fs.readFile(path.join(exportPath, ".cache", "index.json"), "utf-8");
    const cacheIndex = JSON.parse(cacheIndexRaw) as {
      schemaVersion: string;
      timeframes: { "6m": { videos: Record<string, unknown> } };
    };
    expect(cacheIndex.schemaVersion).toBe("cache.index.v1");
    expect(Object.keys(cacheIndex.timeframes["6m"].videos)).toEqual(
      expect.arrayContaining(["video0000411", "video0000422"])
    );
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
