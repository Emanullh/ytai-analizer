import { describe, expect, it } from "vitest";
import { computeTitleDeterministicFeatures } from "../src/derived/titleDeterministic.js";

describe("titleDeterministic", () => {
  it("computes length, caps, punctuation, and number features", () => {
    const result = computeTitleDeterministicFeatures({
      title: "7 WOW?! (Test) [AI-2026]:",
      transcript: "wow test ai 2026"
    });

    expect(result.title_len_chars).toBe(25);
    expect(result.title_len_words).toBe(4);
    expect(result.caps_ratio).toBeCloseTo(0.666667, 6);
    expect(result.question_mark_count).toBe(1);
    expect(result.exclamation_count).toBe(1);
    expect(result.colon_count).toBe(1);
    expect(result.dash_count).toBe(1);
    expect(result.paren_count).toBe(2);
    expect(result.bracket_count).toBe(2);
    expect(result.punct_count_total).toBeGreaterThanOrEqual(8);
    expect(result.has_number).toBe(true);
    expect(result.number_count).toBe(2);
    expect(result.leading_number).toBe(true);
  });

  it("computes pseudo-liwc counts with en/es variants", () => {
    const result = computeTitleDeterministicFeatures({
      title: "I think you should never do this, maybe we must",
      transcript: ""
    });

    expect(result.pronoun_count).toBe(3);
    expect(result.negation_count).toBe(1);
    expect(result.certainty_count).toBe(1);
    expect(result.hedging_count).toBe(1);
  });

  it("computes title/transcript coverage and early-window coverage using timestamps", () => {
    const result = computeTitleDeterministicFeatures({
      title: "Build AI Pipeline Fast",
      transcript: "This guide helps build ai pipeline fast today.",
      transcriptSegments: [
        { startSec: 0, endSec: 10, text: "build ai now", confidence: null },
        { startSec: 35, endSec: 45, text: "pipeline fast", confidence: null }
      ]
    });

    expect(result.title_keyword_audit.title_tokens).toEqual(["build", "pipeline", "fast"]);
    expect(result.title_keyword_coverage).toBe(1);
    expect(result.title_keyword_early_coverage_30s).toBeCloseTo(0.333333, 6);
    expect(result.title_keyword_audit.early_window_mode).toBe("timestamp_window_0_30s");
  });
});
