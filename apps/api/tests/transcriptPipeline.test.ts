import { describe, expect, it, vi } from "vitest";
import { getTranscriptWithFallback } from "../src/services/transcriptPipeline.js";

describe("transcriptPipeline", () => {
  it("uses local ASR and does not consult captions providers anymore", async () => {
    const captionsProvider = vi.fn().mockResolvedValue({
      transcript: "hola desde captions",
      status: "ok"
    });
    const localAsrProvider = vi.fn().mockResolvedValue({
      transcript: "texto local",
      status: "ok"
    });

    const result = await getTranscriptWithFallback(
      "video-1",
      { outputMp3Path: "/tmp/video-1.mp3", language: "es" },
      {
        captionsProvider,
        localAsrProvider,
        localAsrEnabled: true
      }
    );

    expect(captionsProvider).not.toHaveBeenCalled();
    expect(localAsrProvider).toHaveBeenCalledTimes(1);
    expect(localAsrProvider).toHaveBeenCalledWith({
      videoId: "video-1",
      outputMp3Path: "/tmp/video-1.mp3",
      language: "es",
      onStage: undefined,
      onWorkerRequestId: undefined
    });
    expect(result).toEqual({
      transcript: "texto local",
      status: "ok",
      source: "asr"
    });
  });

  it("propagates ASR segments and provenance when available", async () => {
    const localAsrProvider = vi.fn().mockResolvedValue({
      transcript: "texto local",
      status: "ok",
      language: "es",
      model: "large-v3-turbo",
      computeType: "int8",
      segments: [
        {
          startSec: 0,
          endSec: 2.5,
          text: "texto local",
          confidence: null
        }
      ]
    });

    const result = await getTranscriptWithFallback(
      "video-2",
      { outputMp3Path: "/tmp/video-2.mp3", language: "es" },
      {
        captionsProvider: vi.fn(),
        localAsrProvider,
        localAsrEnabled: true
      }
    );

    expect(result).toEqual({
      transcript: "texto local",
      status: "ok",
      source: "asr",
      language: "es",
      asrMeta: {
        model: "large-v3-turbo",
        computeType: "int8"
      },
      segments: [
        {
          startSec: 0,
          endSec: 2.5,
          text: "texto local",
          confidence: null
        }
      ]
    });
  });

  it("returns empty transcript and warning when local ASR fails", async () => {
    const result = await getTranscriptWithFallback(
      "video-3",
      { outputMp3Path: "/tmp/video-3.mp3" },
      {
        captionsProvider: vi.fn(),
        localAsrProvider: vi.fn().mockResolvedValue({
          transcript: "",
          status: "error",
          warning: "gpu unavailable"
        }),
        localAsrEnabled: true
      }
    );

    expect(result.transcript).toBe("");
    expect(result.status).toBe("error");
    expect(result.source).toBe("none");
    expect(result.warning).toContain("gpu unavailable");
    expect(result.warning).not.toContain("captions");
  });

  it("returns an error when local ASR is disabled at runtime", async () => {
    const localAsrProvider = vi.fn();

    const result = await getTranscriptWithFallback(
      "video-4",
      { outputMp3Path: "/tmp/video-4.mp3" },
      {
        captionsProvider: vi.fn(),
        localAsrProvider,
        localAsrEnabled: () => false
      }
    );

    expect(localAsrProvider).not.toHaveBeenCalled();
    expect(result.transcript).toBe("");
    expect(result.status).toBe("error");
    expect(result.source).toBe("none");
    expect(result.warning).toContain("Local ASR disabled");
  });

  it("returns an error when the ASR output path is missing", async () => {
    const localAsrProvider = vi.fn();

    const result = await getTranscriptWithFallback(
      "video-5",
      {},
      {
        captionsProvider: vi.fn(),
        localAsrProvider,
        localAsrEnabled: true
      }
    );

    expect(localAsrProvider).not.toHaveBeenCalled();
    expect(result.transcript).toBe("");
    expect(result.status).toBe("error");
    expect(result.source).toBe("none");
    expect(result.warning).toContain("output path missing");
  });
});
