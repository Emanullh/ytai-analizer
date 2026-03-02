import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptArtifact } from "../src/derived/transcriptArtifacts.js";

function buildArtifact(segments: TranscriptArtifact["segments"]): TranscriptArtifact {
  return {
    meta: {
      type: "meta",
      videoId: "video1",
      status: "ok",
      source: "captions",
      language: "en"
    },
    segments,
    warnings: [],
    sourcePath: "raw/transcripts/video1.jsonl",
    usedFallback: false
  };
}

describe("transcriptDeterministic", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.OPENAI_API_KEY = "";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("computes hook keyword hit time with timestamp evidence", async () => {
    const { computeTranscriptDeterministicFeatures } = await import("../src/derived/transcriptDeterministic.js");

    const result = await computeTranscriptDeterministicFeatures({
      title: "Amazing Docker Tutorial",
      transcriptArtifact: buildArtifact([
        { type: "segment", i: 0, startSec: 0, endSec: 8, text: "Welcome everyone", confidence: null },
        {
          type: "segment",
          i: 1,
          startSec: 12,
          endSec: 25,
          text: "Today this docker tutorial will save you time",
          confidence: null
        }
      ])
    });

    expect(result.features.hook_keyword_hit_time_sec).toBe(12);
    expect(result.features.hook_keyword_hit_evidence?.matchedToken).toMatch(/docker|tutorial/);
    expect(result.features.hook_keyword_hit_evidence?.segmentIndex).toBe(1);
    expect(result.features.title_keyword_coverage).toBeGreaterThan(0);
  });

  it("computes WPM windows when timestamps and duration are available", async () => {
    const { computeTranscriptDeterministicFeatures } = await import("../src/derived/transcriptDeterministic.js");

    const result = await computeTranscriptDeterministicFeatures({
      title: "Pacing test",
      durationSec: 180,
      transcriptArtifact: buildArtifact([
        { type: "segment", i: 0, startSec: 5, endSec: 12, text: "one two three four five six", confidence: null },
        {
          type: "segment",
          i: 1,
          startSec: 40,
          endSec: 70,
          text: "one two three four five six seven eight nine ten",
          confidence: null
        },
        {
          type: "segment",
          i: 2,
          startSec: 155,
          endSec: 170,
          text: "one two three four five six",
          confidence: null
        }
      ])
    });

    expect(result.features.wpm_overall).toBe(7.333333);
    expect(result.features.wpm_0_30).toBe(12);
    expect(result.features.wpm_30_120).toBe(6.666667);
    expect(result.features.wpm_last_30).toBe(12);
    expect(result.features.wpm_variance).toBeGreaterThan(0);
  });

  it("counts rhetorical markers and stores evidence", async () => {
    const { computeTranscriptDeterministicFeatures } = await import("../src/derived/transcriptDeterministic.js");

    const result = await computeTranscriptDeterministicFeatures({
      title: "Markers",
      durationSec: 120,
      transcriptArtifact: buildArtifact([
        {
          type: "segment",
          i: 0,
          startSec: 0,
          endSec: 20,
          text: "Step 1 primero hacemos esto, then seguimos con el plan",
          confidence: null
        },
        {
          type: "segment",
          i: 1,
          startSec: 21,
          endSec: 45,
          text: "Top 3 reasons to switch, however there is one caveat",
          confidence: null
        },
        {
          type: "segment",
          i: 2,
          startSec: 46,
          endSec: 70,
          text: "Sin embargo, al final funciona aunque tome tiempo",
          confidence: null
        }
      ])
    });

    expect(result.features.step_markers_count).toBeGreaterThan(0);
    expect(result.features.list_markers_count).toBeGreaterThan(0);
    expect(result.features.contrast_markers_count).toBeGreaterThan(0);
    expect(result.features.story_markers_count).toBeGreaterThan(0);
    expect(result.features.marker_evidence.step_topMatches.length).toBeGreaterThan(0);
    expect(result.features.marker_evidence.list_topMatches.length).toBeGreaterThan(0);
  });

  it("scores sentiment deterministically with lexicon and computes trend", async () => {
    const { computeTranscriptDeterministicFeatures } = await import("../src/derived/transcriptDeterministic.js");

    const result = await computeTranscriptDeterministicFeatures({
      title: "Sentiment",
      transcriptArtifact: buildArtifact([
        {
          type: "segment",
          i: 0,
          startSec: 0,
          endSec: 15,
          text: "I love this amazing tool, excelente and very helpful",
          confidence: null
        },
        {
          type: "segment",
          i: 1,
          startSec: 20,
          endSec: 40,
          text: "This is awful, terrible, horrible and a fracaso",
          confidence: null
        }
      ])
    });

    expect(result.features.sentiment_mean).not.toBeNull();
    expect(result.features.sentiment_std).toBeGreaterThan(0);
    expect(result.features.sentiment_trend).toBeLessThan(0);
    expect(result.features.emotion_peaks.length).toBeGreaterThan(0);
    expect(result.features.promise_delivery_30s_score).toBeNull();
    expect(result.features.topic_shift_count).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("OPENAI_API_KEY"))).toBe(true);
  });
});
