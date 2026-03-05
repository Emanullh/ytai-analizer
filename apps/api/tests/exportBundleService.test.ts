import { describe, expect, it } from "vitest";
import { collectExemplarVideoIds, toVideosExtractRecord } from "../src/services/exportBundleService.js";

describe("exportBundleService helpers", () => {
  it("collects and deduplicates exemplar videoIds", () => {
    const result = collectExemplarVideoIds({
      exemplars: {
        top_videos: [{ videoId: "a" }, { videoId: "b" }],
        bottom_videos: [{ videoId: "b" }, { videoId: "c" }],
        mid_videos: [{ videoId: "c" }, { videoId: "a" }, { videoId: "d" }]
      }
    });

    expect(result).toEqual(["a", "b", "c", "d"]);
  });

  it("returns key fields for raw videos extract rows", () => {
    const row = toVideosExtractRecord({
      videoId: "vid-1",
      title: "Video",
      publishedAt: "2026-03-01T00:00:00.000Z",
      durationSec: 240,
      tags: ["tag-1"],
      categoryId: "27",
      defaultLanguage: "en",
      statistics: {
        viewCount: "1000",
        likeCount: 100,
        commentCount: "12"
      },
      transcriptRef: {
        transcriptStatus: "ok",
        transcriptSource: "captions"
      }
    });

    expect(row).toEqual({
      videoId: "vid-1",
      title: "Video",
      publishedAt: "2026-03-01T00:00:00.000Z",
      durationSec: 240,
      viewCount: 1000,
      likeCount: 100,
      commentCount: 12,
      tags: ["tag-1"],
      categoryId: "27",
      defaultLanguage: "en",
      transcriptStatus: "ok",
      transcriptSource: "captions"
    });
  });

  it("handles invalid orchestrator shape safely", () => {
    expect(collectExemplarVideoIds({ exemplars: { top_videos: [null, { x: "y" }, { videoId: "ok" }] } })).toEqual(["ok"]);
    expect(collectExemplarVideoIds(null)).toEqual([]);
  });
});
