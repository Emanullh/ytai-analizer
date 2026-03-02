import { describe, expect, it } from "vitest";
import { computePerformancePerVideo } from "../src/derived/performanceNormalization.js";

describe("performanceNormalization", () => {
  it("computes deterministic proxy metrics", () => {
    const result = computePerformancePerVideo(
      [
        {
          videoId: "video-a",
          publishedAt: "2026-03-01T00:00:00.000Z",
          viewCount: 100,
          likeCount: 10,
          commentCount: 5,
          durationSec: 55
        },
        {
          videoId: "video-b",
          publishedAt: "2026-02-28T00:00:00.000Z",
          viewCount: 50,
          durationSec: 120
        },
        {
          videoId: "video-c",
          publishedAt: "2026-02-27T00:00:00.000Z",
          viewCount: 10,
          likeCount: null,
          commentCount: null,
          durationSec: null
        },
        {
          videoId: "video-d",
          publishedAt: "2026-02-26T00:00:00.000Z",
          viewCount: 1,
          likeCount: 0,
          commentCount: 0,
          durationSec: 80
        }
      ],
      "2026-03-02T00:00:00.000Z"
    );

    expect(result.perVideoMap["video-a"]).toMatchObject({
      daysSincePublish: 1,
      viewsPerDay: 100,
      likeRate: 0.1,
      commentRate: 0.05,
      engagementRate: 0.15
    });
    expect(result.perVideoMap["video-a"]?.logViews).toBeCloseTo(Math.log1p(100), 6);
    expect(result.perVideoMap["video-b"]).toMatchObject({
      likeRate: null,
      commentRate: null,
      engagementRate: null
    });
    expect(result.perVideoMap["video-c"]?.residual).toBeNull();
    expect(result.perVideoMap["video-c"]?.percentile).toBeNull();
  });

  it("fits robust model and returns residual percentiles for n>=5", () => {
    const nowIso = "2026-03-02T00:00:00.000Z";
    const nowMs = new Date(nowIso).getTime();
    const noise = [0.08, -0.05, 0.03, -0.01, 0.07, -0.04, 0.02, -0.03, 0.06, -0.02];
    const weekdayAdjustment = [0, 0.06, -0.03, 0.05, -0.02, 0.03, -0.04];

    const videos = Array.from({ length: 10 }, (_, index) => {
      const days = 3 + index * 4;
      const durationSec = index % 3 === 0 ? 50 : 120 + index * 15;
      const publishedAt = new Date(nowMs - days * 86_400_000).toISOString();
      const weekday = new Date(publishedAt).getUTCDay();
      const signal =
        2.5 +
        0.65 * Math.log1p(days) +
        0.24 * Math.log1p(durationSec) +
        (durationSec <= 60 ? 0.2 : 0) +
        weekdayAdjustment[weekday] +
        noise[index];
      const viewCount = Math.max(1, Math.round(Math.exp(signal) - 1));
      const likeCount = Math.round(viewCount * 0.07);
      const commentCount = Math.round(viewCount * 0.01);

      return {
        videoId: `video-${index + 1}`,
        publishedAt,
        viewCount,
        likeCount,
        commentCount,
        durationSec
      };
    });

    const result = computePerformancePerVideo(videos, nowIso);

    expect(result.modelSummary.fit.n).toBe(10);
    expect(Number.isFinite(result.modelSummary.intercept)).toBe(true);
    expect(Object.values(result.modelSummary.coefficients).every((value) => Number.isFinite(value))).toBe(true);
    expect(result.modelSummary.fit.madResidual).toBeGreaterThanOrEqual(0);

    for (const video of videos) {
      const metrics = result.perVideoMap[video.videoId];
      expect(metrics).toBeDefined();
      expect(metrics?.residual).not.toBeNull();
      expect(metrics?.percentile).toBeGreaterThanOrEqual(0);
      expect(metrics?.percentile).toBeLessThanOrEqual(1);
    }
  });

  it("does not fit model when less than five videos are provided", () => {
    const result = computePerformancePerVideo(
      [
        {
          videoId: "v1",
          publishedAt: "2026-03-01T00:00:00.000Z",
          viewCount: 100,
          likeCount: 10,
          commentCount: 1,
          durationSec: 120
        },
        {
          videoId: "v2",
          publishedAt: "2026-02-28T00:00:00.000Z",
          viewCount: 90,
          likeCount: 8,
          commentCount: 2,
          durationSec: 90
        },
        {
          videoId: "v3",
          publishedAt: "2026-02-27T00:00:00.000Z",
          viewCount: 110,
          likeCount: 9,
          commentCount: 2,
          durationSec: 180
        },
        {
          videoId: "v4",
          publishedAt: "2026-02-26T00:00:00.000Z",
          viewCount: 95,
          likeCount: 7,
          commentCount: 1,
          durationSec: 140
        }
      ],
      "2026-03-02T00:00:00.000Z"
    );

    expect(result.modelSummary.fit.n).toBe(4);
    expect(result.warnings.some((warning) => warning.includes("requires at least 5 videos"))).toBe(true);
    expect(result.modelSummary.fit.notes.some((note) => note.includes("requires at least 5 videos"))).toBe(true);
    for (const metrics of Object.values(result.perVideoMap)) {
      expect(metrics.residual).toBeNull();
      expect(metrics.percentile).toBeNull();
    }
  });
});
