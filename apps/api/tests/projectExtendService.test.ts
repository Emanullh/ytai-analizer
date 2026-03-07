import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listVideosForChannelMock = vi.fn();
const getVideoDetailsMock = vi.fn();
const getChannelDetailsMock = vi.fn();
const exportSelectedVideosMock = vi.fn();
const rerunVideoFeatureMock = vi.fn();

vi.mock("../src/services/youtubeService.js", () => ({
  listVideosForChannel: listVideosForChannelMock,
  getVideoDetails: getVideoDetailsMock,
  getChannelDetails: getChannelDetailsMock
}));

vi.mock("../src/services/exportService.js", () => ({
  exportSelectedVideos: exportSelectedVideosMock
}));

vi.mock("../src/services/videoFeatureRerunService.js", () => ({
  rerunVideoFeature: rerunVideoFeatureMock
}));

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf-8");
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

describe("projectExtendService", () => {
  let originalCwd = process.cwd();
  let tempDir = "";

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-extend-"));
    process.chdir(tempDir);

    listVideosForChannelMock.mockReset();
    getVideoDetailsMock.mockReset();
    getChannelDetailsMock.mockReset();
    exportSelectedVideosMock.mockReset();
    rerunVideoFeatureMock.mockReset();

    const projectRoot = path.resolve(tempDir, "exports", "Canal_Demo");

    await writeJson(path.resolve(projectRoot, "channel.json"), {
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
          videoId: "video1",
          title: "Video Uno",
          viewCount: 100,
          publishedAt: "2026-02-15T00:00:00.000Z",
          thumbnailPath: "thumbnails/video1.jpg",
          transcript: "texto uno",
          transcriptStatus: "ok",
          transcriptSource: "captions",
          transcriptPath: "raw/transcripts/video1.jsonl"
        }
      ]
    });

    await writeJson(path.resolve(projectRoot, "raw", "channel.json"), {
      exportVersion: "1.1",
      exportedAt: "2026-03-01T12:00:00.000Z",
      jobId: "job-a1",
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      sourceInput: "https://www.youtube.com/@demo",
      timeframe: "6m",
      timeframeResolved: {
        publishedAfter: "2025-09-01T00:00:00.000Z",
        publishedBefore: "2026-03-01T00:00:00.000Z"
      }
    });

    await writeJson(path.resolve(projectRoot, "manifest.json"), {
      jobId: "job-a1",
      channelId: "UC1234567890123456789012",
      channelFolder: "Canal_Demo",
      exportVersion: "1.1",
      exportedAt: "2026-03-01T12:00:00.000Z",
      counts: {
        totalVideosSelected: 1,
        transcriptsOk: 1,
        transcriptsMissing: 0,
        transcriptsError: 0,
        thumbnailsOk: 1,
        thumbnailsFailed: 0
      },
      warnings: [],
      artifacts: ["channel.json", "raw/channel.json", "raw/videos.jsonl", "derived/channel_models.json", "manifest.json"]
    });

    await writeJsonl(path.resolve(projectRoot, "raw", "videos.jsonl"), [
      {
        videoId: "video1",
        title: "Video Uno",
        description: "descripcion 1",
        publishedAt: "2026-02-15T00:00:00.000Z",
        durationSec: 120,
        categoryId: "27",
        tags: ["tag-1"],
        madeForKids: false,
        liveBroadcastContent: "none",
        statistics: {
          viewCount: 100,
          likeCount: 10,
          commentCount: 4
        },
        thumbnailLocalPath: "raw/thumbnails/video1.jpg",
        thumbnailOriginalUrl: "https://img.example/video1.jpg",
        transcriptRef: {
          transcriptPath: "raw/transcripts/video1.jsonl",
          transcriptSource: "captions",
          transcriptStatus: "ok"
        },
        daysSincePublish: 10,
        viewsPerDay: 10,
        likeRate: 0.1,
        commentRate: 0.04,
        warnings: []
      }
    ]);

    await writeText(
      path.resolve(projectRoot, "raw", "transcripts", "video1.jsonl"),
      [
        JSON.stringify({ type: "meta", videoId: "video1", status: "ok", source: "captions", language: "es" }),
        JSON.stringify({ type: "segment", i: 0, startSec: 0, endSec: 2, text: "texto uno", confidence: null })
      ].join("\n") + "\n"
    );
    await writeText(path.resolve(projectRoot, "thumbnails", "video1.jpg"), "thumb1");
    await writeText(path.resolve(projectRoot, "raw", "thumbnails", "video1.jpg"), "thumb1");
    await writeJson(path.resolve(projectRoot, "derived", "video_features", "video1.json"), {
      schemaVersion: "derived.video_features.v1",
      videoId: "video1",
      titleFeatures: {
        deterministic: {
          title_len_words: 2
        }
      }
    });
    await writeJson(path.resolve(projectRoot, "derived", "channel_models.json"), {
      schemaVersion: "derived.channel_models.v1",
      computedAt: "2026-03-01T12:00:00.000Z",
      channelId: "UC1234567890123456789012",
      timeframe: "6m",
      model: {
        type: "robust-linear",
        formula: "x",
        coefficients: {},
        intercept: 0,
        fit: {
          n: 1,
          r2Approx: null,
          madResidual: 0,
          notes: []
        }
      }
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists extend candidates with alreadyInProject flag", async () => {
    listVideosForChannelMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video1",
          title: "Video Uno",
          publishedAt: "2026-02-15T00:00:00.000Z",
          viewCount: 100,
          thumbnailUrl: "https://img.example/video1.jpg"
        },
        {
          videoId: "video2",
          title: "Video Dos",
          publishedAt: "2026-01-10T00:00:00.000Z",
          viewCount: 50,
          thumbnailUrl: "https://img.example/video2.jpg"
        }
      ]
    });

    const { getProjectExtendCandidates } = await import("../src/services/projectExtendService.js");
    const result = await getProjectExtendCandidates("Canal_Demo", "1y");

    expect(result.projectTimeframe).toBe("6m");
    expect(result.videos).toEqual([
      expect.objectContaining({ videoId: "video1", alreadyInProject: true }),
      expect.objectContaining({ videoId: "video2", alreadyInProject: false })
    ]);
  });

  it("extends incrementally, refreshes global metrics and recomputes performance", async () => {
    exportSelectedVideosMock.mockImplementation(async () => {
      const tempRoot = path.resolve(process.cwd(), "exports", "extend_temp_project");

      await writeJson(path.resolve(tempRoot, "channel.json"), {
        exportVersion: "1.1",
        exportedAt: "2026-03-06T12:00:00.000Z",
        channelName: "Temp Extend",
        channelId: "UC1234567890123456789012",
        sourceInput: "https://www.youtube.com/@demo",
        timeframe: "6m",
        timeframeResolved: null,
        videos: [
          {
            videoId: "video2",
            title: "Video Dos",
            viewCount: 40,
            publishedAt: "2026-01-10T00:00:00.000Z",
            thumbnailPath: "thumbnails/video2.jpg",
            transcript: "texto dos",
            transcriptStatus: "ok",
            transcriptSource: "asr",
            transcriptPath: "raw/transcripts/video2.jsonl"
          }
        ]
      });

      await writeJsonl(path.resolve(tempRoot, "raw", "videos.jsonl"), [
        {
          videoId: "video2",
          title: "Video Dos",
          description: "descripcion 2",
          publishedAt: "2026-01-10T00:00:00.000Z",
          durationSec: 240,
          categoryId: "27",
          tags: ["tag-2"],
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 40,
            likeCount: 5,
            commentCount: 2
          },
          thumbnailLocalPath: "raw/thumbnails/video2.jpg",
          thumbnailOriginalUrl: "https://img.example/video2.jpg",
          transcriptRef: {
            transcriptPath: "raw/transcripts/video2.jsonl",
            transcriptSource: "asr",
            transcriptStatus: "ok"
          },
          daysSincePublish: 20,
          viewsPerDay: 2,
          likeRate: 0.125,
          commentRate: 0.05,
          warnings: []
        }
      ]);

      await writeText(
        path.resolve(tempRoot, "raw", "transcripts", "video2.jsonl"),
        [
          JSON.stringify({ type: "meta", videoId: "video2", status: "ok", source: "asr", language: "es" }),
          JSON.stringify({ type: "segment", i: 0, startSec: 0, endSec: 2, text: "texto dos", confidence: null })
        ].join("\n") + "\n"
      );
      await writeText(path.resolve(tempRoot, "thumbnails", "video2.jpg"), "thumb2");
      await writeText(path.resolve(tempRoot, "raw", "thumbnails", "video2.jpg"), "thumb2");
      await writeJson(path.resolve(tempRoot, "derived", "video_features", "video2.json"), {
        schemaVersion: "derived.video_features.v1",
        videoId: "video2",
        titleFeatures: {
          deterministic: {
            title_len_words: 2
          }
        }
      });

      return {
        folderPath: tempRoot,
        warnings: [],
        exportedCount: 1
      };
    });

    rerunVideoFeatureMock.mockResolvedValue({
      ok: true,
      warnings: [],
      artifactPath: "derived/video_features/video1.json",
      stepsExecuted: ["reuse_transcript_asset"],
      preparedAssets: {
        audioPath: null,
        transcriptPath: "raw/transcripts/video1.jsonl",
        thumbnailPath: "thumbnails/video1.jpg"
      }
    });

    getVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: [
        {
          videoId: "video1",
          title: "Video Uno",
          description: "descripcion 1",
          publishedAt: "2026-02-15T00:00:00.000Z",
          durationSec: 120,
          categoryId: "27",
          tags: ["tag-1"],
          defaultLanguage: "es",
          defaultAudioLanguage: "es",
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 150,
            likeCount: 16,
            commentCount: 5
          },
          thumbnails: {},
          thumbnailOriginalUrl: "https://img.example/video1.jpg"
        },
        {
          videoId: "video2",
          title: "Video Dos",
          description: "descripcion 2",
          publishedAt: "2026-01-10T00:00:00.000Z",
          durationSec: 240,
          categoryId: "27",
          tags: ["tag-2"],
          defaultLanguage: "es",
          defaultAudioLanguage: "es",
          madeForKids: false,
          liveBroadcastContent: "none",
          statistics: {
            viewCount: 90,
            likeCount: 9,
            commentCount: 3
          },
          thumbnails: {},
          thumbnailOriginalUrl: "https://img.example/video2.jpg"
        }
      ]
    });

    getChannelDetailsMock.mockResolvedValue({
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      channelStats: {
        subscriberCount: 999,
        viewCount: 123456,
        videoCount: 42
      },
      warnings: []
    });

    const { extendProject } = await import("../src/services/projectExtendService.js");
    const result = await extendProject({
      projectId: "Canal_Demo",
      timeframe: "1y",
      selectedVideoIds: ["video1", "video2"],
      reprocessVideoIds: ["video1"],
      jobId: "extend-job-1"
    });

    expect(result).toEqual({
      projectId: "Canal_Demo",
      addedCount: 1,
      refreshedCount: 2,
      reprocessedCount: 1
    });

    expect(rerunVideoFeatureMock).toHaveBeenCalledTimes(4);
    for (const call of rerunVideoFeatureMock.mock.calls) {
      expect(call[0]).toMatchObject({ projectId: "Canal_Demo", videoId: "video1", mode: "full" });
      expect(call[1]).toMatchObject({ bypassProjectLock: true, reusePreparedAssets: true });
    }

    const projectRoot = path.resolve(tempDir, "exports", "Canal_Demo");
    const channelJson = JSON.parse(await fs.readFile(path.resolve(projectRoot, "channel.json"), "utf-8")) as {
      videos: Array<{ videoId: string; viewCount: number }>;
    };
    expect(channelJson.videos).toHaveLength(2);
    expect(channelJson.videos.find((video) => video.videoId === "video1")?.viewCount).toBe(150);
    expect(channelJson.videos.find((video) => video.videoId === "video2")?.viewCount).toBe(90);

    const rawRows = (await fs.readFile(path.resolve(projectRoot, "raw", "videos.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { videoId: string; statistics: { viewCount: number }; viewsPerDay: number });
    expect(rawRows).toHaveLength(2);
    expect(rawRows.find((row) => row.videoId === "video1")?.statistics.viewCount).toBe(150);
    expect(rawRows.find((row) => row.videoId === "video2")?.statistics.viewCount).toBe(90);
    expect(rawRows.every((row) => row.viewsPerDay > 0)).toBe(true);

    const featureVideo1 = JSON.parse(
      await fs.readFile(path.resolve(projectRoot, "derived", "video_features", "video1.json"), "utf-8")
    ) as { performance?: { viewsPerDay: number } };
    const featureVideo2 = JSON.parse(
      await fs.readFile(path.resolve(projectRoot, "derived", "video_features", "video2.json"), "utf-8")
    ) as { performance?: { viewsPerDay: number } };
    expect(featureVideo1.performance?.viewsPerDay).toBeGreaterThan(0);
    expect(featureVideo2.performance?.viewsPerDay).toBeGreaterThan(0);

    const channelModels = JSON.parse(
      await fs.readFile(path.resolve(projectRoot, "derived", "channel_models.json"), "utf-8")
    ) as { channelId: string; timeframe: string };
    expect(channelModels).toMatchObject({
      channelId: "UC1234567890123456789012",
      timeframe: "6m"
    });
  });

  it("cleans stale transcript and performance warnings across project artifacts after extend", async () => {
    const projectRoot = path.resolve(tempDir, "exports", "Canal_Demo");
    const videoIds = ["video1", "video2", "video3", "video4", "video5"];

    const staleTranscriptWarning = (videoId: string) =>
      `Transcript artifact missing at C:\\temp\\extend\\${videoId}.jsonl; used in-memory fallback segment`;

    await writeJson(path.resolve(projectRoot, "channel.json"), {
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
      videos: videoIds.map((videoId, index) => ({
        videoId,
        title: `Video ${index + 1}`,
        viewCount: 100 + index,
        publishedAt: `2026-02-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
        thumbnailPath: `thumbnails/${videoId}.jpg`,
        transcript: `texto ${index + 1}`,
        transcriptStatus: "ok",
        transcriptSource: "captions",
        transcriptPath: `raw/transcripts/${videoId}.jsonl`
      }))
    });

    await writeJson(path.resolve(projectRoot, "raw", "channel.json"), {
      exportVersion: "1.1",
      exportedAt: "2026-03-01T12:00:00.000Z",
      jobId: "job-a1",
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      sourceInput: "https://www.youtube.com/@demo",
      timeframe: "6m",
      timeframeResolved: {
        publishedAfter: "2025-09-01T00:00:00.000Z",
        publishedBefore: "2026-03-01T00:00:00.000Z"
      },
      provenance: {
        dataSources: ["youtube-data-api-v3"],
        warnings: [
          staleTranscriptWarning("video1"),
          "Performance model skipped: requires at least 5 videos, received 3"
        ],
        env: {
          LOCAL_ASR_ENABLED: true,
          TRANSCRIPT_LANG: null
        }
      }
    });

    await writeJson(path.resolve(projectRoot, "manifest.json"), {
      jobId: "job-a1",
      channelId: "UC1234567890123456789012",
      channelFolder: "Canal_Demo",
      exportVersion: "1.1",
      exportedAt: "2026-03-01T12:00:00.000Z",
      counts: {
        totalVideosSelected: 5,
        transcriptsOk: 5,
        transcriptsMissing: 0,
        transcriptsError: 0,
        thumbnailsOk: 5,
        thumbnailsFailed: 0
      },
      warnings: [
        staleTranscriptWarning("video1"),
        "Performance model skipped: requires at least 5 videos, received 3"
      ],
      artifacts: [
        ".cache/index.json",
        "channel.json",
        "raw/channel.json",
        "raw/videos.jsonl",
        "derived/channel_models.json",
        "manifest.json"
      ]
    });

    await writeJsonl(
      path.resolve(projectRoot, "raw", "videos.jsonl"),
      videoIds.map((videoId, index) => ({
        videoId,
        title: `Video ${index + 1}`,
        description: `descripcion ${index + 1}`,
        publishedAt: `2026-02-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
        durationSec: 120 + index * 10,
        categoryId: "27",
        tags: [`tag-${index + 1}`],
        madeForKids: false,
        liveBroadcastContent: "none",
        statistics: {
          viewCount: 100 + index * 25,
          likeCount: 10 + index,
          commentCount: 3 + index
        },
        thumbnailLocalPath: `raw/thumbnails/${videoId}.jpg`,
        thumbnailOriginalUrl: `https://img.example/${videoId}.jpg`,
        transcriptRef: {
          transcriptPath: `raw/transcripts/${videoId}.jsonl`,
          transcriptSource: "captions",
          transcriptStatus: "ok"
        },
        daysSincePublish: 10 + index,
        viewsPerDay: 10 + index,
        likeRate: 0.1,
        commentRate: 0.03,
        warnings: [staleTranscriptWarning(videoId)]
      }))
    );

    for (const [index, videoId] of videoIds.entries()) {
      await writeText(
        path.resolve(projectRoot, "raw", "transcripts", `${videoId}.jsonl`),
        [
          JSON.stringify({ type: "meta", videoId, status: "ok", source: "captions", language: "es" }),
          JSON.stringify({ type: "segment", i: 0, startSec: 0, endSec: 2, text: `texto ${index + 1}`, confidence: null })
        ].join("\n") + "\n"
      );
      await writeText(path.resolve(projectRoot, "thumbnails", `${videoId}.jpg`), `thumb-${videoId}`);
      await writeText(path.resolve(projectRoot, "raw", "thumbnails", `${videoId}.jpg`), `thumb-${videoId}`);
      await writeJson(path.resolve(projectRoot, "derived", "video_features", `${videoId}.json`), {
        schemaVersion: "derived.video_features.v1",
        videoId,
        titleFeatures: {
          deterministic: {
            title_len_words: 2
          }
        }
      });
    }

    await writeJson(path.resolve(projectRoot, ".cache", "index.json"), {
      schemaVersion: "cache.index.v1",
      channelId: "UC1234567890123456789012",
      channelFolder: "Canal_Demo",
      updatedAt: "2026-03-01T12:00:00.000Z",
      exportVersion: "1.1",
      timeframes: {
        "1m": { videos: {} },
        "6m": {
          videos: Object.fromEntries(
            videoIds.map((videoId) => [
              videoId,
              {
                videoId,
                lastUpdatedAt: "2026-03-01T12:00:00.000Z",
                inputs: {
                  titleHash: `title-${videoId}`,
                  descriptionHash: `description-${videoId}`,
                  thumbnailHash: `thumbnail-${videoId}`,
                  transcriptHash: `transcript-${videoId}`,
                  transcriptSource: "captions",
                  asrConfigHash: "asr-config",
                  ocrConfigHash: "ocr-config",
                  embeddingModel: "text-embedding-3-small",
                  llmModels: {
                    title: "gpt-5.2",
                    description: "gpt-5.2",
                    transcript: "gpt-5.2",
                    thumbnail: "gpt-5.2"
                  }
                },
                artifacts: {
                  rawTranscriptPath: `raw/transcripts/${videoId}.jsonl`,
                  thumbnailPath: `thumbnails/${videoId}.jpg`,
                  derivedVideoFeaturesPath: `derived/video_features/${videoId}.json`
                },
                status: {
                  rawTranscript: "ok",
                  thumbnail: "ok",
                  derived: "partial",
                  warnings: [staleTranscriptWarning(videoId)]
                }
              }
            ])
          )
        },
        "1y": { videos: {} },
        "2y": { videos: {} },
        "5y": { videos: {} }
      }
    });

    getVideoDetailsMock.mockResolvedValue({
      warnings: [],
      videos: videoIds.map((videoId, index) => ({
        videoId,
        title: `Video ${index + 1}`,
        description: `descripcion ${index + 1}`,
        publishedAt: `2026-02-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
        durationSec: 120 + index * 10,
        categoryId: "27",
        tags: [`tag-${index + 1}`],
        defaultLanguage: "es",
        defaultAudioLanguage: "es",
        madeForKids: false,
        liveBroadcastContent: "none",
        statistics: {
          viewCount: 100 + index * 25,
          likeCount: 10 + index,
          commentCount: 3 + index
        },
        thumbnails: {},
        thumbnailOriginalUrl: `https://img.example/${videoId}.jpg`
      }))
    });
    getChannelDetailsMock.mockResolvedValue({
      channelId: "UC1234567890123456789012",
      channelName: "Canal Demo",
      channelStats: {
        subscriberCount: 999,
        viewCount: 123456,
        videoCount: 42
      },
      warnings: []
    });

    const { extendProject } = await import("../src/services/projectExtendService.js");
    await extendProject({
      projectId: "Canal_Demo",
      timeframe: "1y",
      selectedVideoIds: videoIds,
      jobId: "extend-job-clean"
    });

    const manifestJson = JSON.parse(await fs.readFile(path.resolve(projectRoot, "manifest.json"), "utf-8")) as {
      warnings: string[];
    };
    expect(manifestJson.warnings).toEqual([]);

    const rawChannelJson = JSON.parse(await fs.readFile(path.resolve(projectRoot, "raw", "channel.json"), "utf-8")) as {
      provenance?: { warnings?: string[] };
    };
    expect(rawChannelJson.provenance?.warnings ?? []).toEqual([]);

    const rawRows = (await fs.readFile(path.resolve(projectRoot, "raw", "videos.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { videoId: string; warnings: string[] });
    expect(rawRows.every((row) => row.warnings.length === 0)).toBe(true);

    const cacheIndex = JSON.parse(await fs.readFile(path.resolve(projectRoot, ".cache", "index.json"), "utf-8")) as {
      timeframes: {
        "6m": {
          videos: Record<string, { status: { warnings: string[]; derived: string } }>;
        };
      };
    };
    for (const videoId of videoIds) {
      expect(cacheIndex.timeframes["6m"].videos[videoId]?.status.warnings ?? []).toEqual([]);
      expect(cacheIndex.timeframes["6m"].videos[videoId]?.status.derived).toBe("ok");
    }
  });
});
