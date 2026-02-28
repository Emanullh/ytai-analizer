import { describe, expect, it, vi } from "vitest";
import { getTranscriptWithFallback } from "../src/services/transcriptPipeline.js";

describe("transcriptPipeline", () => {
  it("uses captions transcript and does not call local ASR when captions are available", async () => {
    const captionsProvider = vi.fn().mockResolvedValue({
      transcript: "hola desde captions",
      status: "ok"
    });
    const localAsrProvider = vi.fn();

    const result = await getTranscriptWithFallback(
      "video-1",
      { outputMp3Path: "/tmp/video-1.mp3" },
      {
        captionsProvider,
        localAsrProvider,
        localAsrEnabled: true
      }
    );

    expect(result).toEqual({
      transcript: "hola desde captions",
      status: "ok",
      warning: undefined
    });
    expect(localAsrProvider).not.toHaveBeenCalled();
  });

  it("calls local ASR when captions are missing", async () => {
    const captionsProvider = vi.fn().mockResolvedValue({
      transcript: "",
      status: "missing",
      warning: "captions missing"
    });
    const localAsrProvider = vi.fn().mockResolvedValue({
      transcript: "texto local",
      status: "ok"
    });

    const result = await getTranscriptWithFallback(
      "video-2",
      { outputMp3Path: "/tmp/video-2.mp3", language: "es" },
      {
        captionsProvider,
        localAsrProvider,
        localAsrEnabled: true
      }
    );

    expect(localAsrProvider).toHaveBeenCalledTimes(1);
    expect(localAsrProvider).toHaveBeenCalledWith({
      videoId: "video-2",
      outputMp3Path: "/tmp/video-2.mp3",
      language: "es",
      onStage: undefined
    });
    expect(result).toEqual({
      transcript: "texto local",
      status: "ok"
    });
  });

  it("returns empty transcript and warning when local ASR fails", async () => {
    const captionsProvider = vi.fn().mockResolvedValue({
      transcript: "",
      status: "missing",
      warning: "captions missing"
    });
    const localAsrProvider = vi.fn().mockResolvedValue({
      transcript: "",
      status: "error",
      warning: "gpu unavailable"
    });

    const result = await getTranscriptWithFallback(
      "video-3",
      { outputMp3Path: "/tmp/video-3.mp3" },
      {
        captionsProvider,
        localAsrProvider,
        localAsrEnabled: true
      }
    );

    expect(localAsrProvider).toHaveBeenCalledTimes(1);
    expect(result.transcript).toBe("");
    expect(result.status).toBe("error");
    expect(result.warning).toContain("captions missing");
    expect(result.warning).toContain("gpu unavailable");
  });

  it("degrades to captions-only mode when local ASR is disabled at runtime", async () => {
    const captionsProvider = vi.fn().mockResolvedValue({
      transcript: "",
      status: "missing",
      warning: "captions missing"
    });
    const localAsrProvider = vi.fn();

    const result = await getTranscriptWithFallback(
      "video-4",
      { outputMp3Path: "/tmp/video-4.mp3" },
      {
        captionsProvider,
        localAsrProvider,
        localAsrEnabled: () => false
      }
    );

    expect(localAsrProvider).not.toHaveBeenCalled();
    expect(result.transcript).toBe("");
    expect(result.status).toBe("missing");
    expect(result.warning).toContain("captions missing");
    expect(result.warning).toContain("Local ASR disabled");
  });
});
