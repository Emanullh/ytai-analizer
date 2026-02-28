import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTranscriptMock = vi.fn();

vi.mock("youtube-transcript", () => {
  class YoutubeTranscriptDisabledError extends Error {}
  class YoutubeTranscriptNotAvailableError extends Error {}
  class YoutubeTranscriptNotAvailableLanguageError extends Error {}
  class YoutubeTranscriptTooManyRequestError extends Error {}
  class YoutubeTranscriptVideoUnavailableError extends Error {}

  return {
    YoutubeTranscript: {
      fetchTranscript: fetchTranscriptMock
    },
    YoutubeTranscriptDisabledError,
    YoutubeTranscriptNotAvailableError,
    YoutubeTranscriptNotAvailableLanguageError,
    YoutubeTranscriptTooManyRequestError,
    YoutubeTranscriptVideoUnavailableError
  };
});

describe("transcriptService", () => {
  beforeEach(async () => {
    fetchTranscriptMock.mockReset();
    const { __resetTranscriptCacheForTests } = await import("../src/services/transcriptService.js");
    __resetTranscriptCacheForTests();
  });

  it("returns transcript text when captions are available", async () => {
    fetchTranscriptMock.mockResolvedValue([{ text: " Hola " }, { text: "mundo" }]);
    const { getTranscript } = await import("../src/services/transcriptService.js");

    const result = await getTranscript("video1234567", { lang: "es" });

    expect(result).toEqual({
      transcript: "Hola mundo",
      status: "ok",
      language: "es",
      segments: [
        {
          startSec: null,
          endSec: null,
          text: "Hola",
          confidence: null
        },
        {
          startSec: null,
          endSec: null,
          text: "mundo",
          confidence: null
        }
      ]
    });
    expect(fetchTranscriptMock).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptMock).toHaveBeenCalledWith("video1234567", { lang: "es" });
  });

  it("returns missing status when transcript is not available", async () => {
    const { YoutubeTranscriptNotAvailableError } = await import("youtube-transcript");
    fetchTranscriptMock.mockRejectedValue(new YoutubeTranscriptNotAvailableError("missing"));
    const { getTranscript } = await import("../src/services/transcriptService.js");

    const result = await getTranscript("video-missing", { lang: "en" });

    expect(result.status).toBe("missing");
    expect(result.transcript).toBe("");
    expect(result.warning).toContain("Transcript unavailable for video video-missing");
    expect(fetchTranscriptMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors and degrades to empty transcript", async () => {
    vi.useFakeTimers();
    try {
      const { YoutubeTranscriptTooManyRequestError } = await import("youtube-transcript");
      fetchTranscriptMock.mockRejectedValue(new YoutubeTranscriptTooManyRequestError("429"));
      const { getTranscript } = await import("../src/services/transcriptService.js");

      const pending = getTranscript("video-transient", { lang: "en", maxRetries: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;

      expect(fetchTranscriptMock).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("error");
      expect(result.transcript).toBe("");
      expect(result.warning).toContain("Transcript fetch error for video video-transient");
    } finally {
      vi.useRealTimers();
    }
  });
});
