import { describe, expect, it } from "vitest";
import { iso8601DurationToSeconds } from "../src/services/youtubeService.js";

describe("iso8601DurationToSeconds", () => {
  it("parses standard YouTube durations", () => {
    expect(iso8601DurationToSeconds("PT15M33S")).toBe(933);
    expect(iso8601DurationToSeconds("PT2H")).toBe(7200);
    expect(iso8601DurationToSeconds("PT0S")).toBe(0);
  });

  it("supports day and week components", () => {
    expect(iso8601DurationToSeconds("P1DT2H3M4S")).toBe(93784);
    expect(iso8601DurationToSeconds("P2W")).toBe(1209600);
  });

  it("returns 0 for invalid or empty values", () => {
    expect(iso8601DurationToSeconds("")).toBe(0);
    expect(iso8601DurationToSeconds(undefined)).toBe(0);
    expect(iso8601DurationToSeconds("not-a-duration")).toBe(0);
  });
});
