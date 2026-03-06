import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestAutoGenTaskMock = vi.fn();
const recognizeWithLocalOcrMock = vi.fn();

vi.mock("../src/services/autogenRuntime.js", () => ({
  requestAutoGenTask: requestAutoGenTaskMock,
  startAutoGenWorker: vi.fn(),
  stopAutoGenWorker: vi.fn()
}));

vi.mock("../src/services/localOcrService.js", () => ({
  recognizeWithLocalOcr: recognizeWithLocalOcrMock,
  resetLocalOcrRuntime: vi.fn()
}));

describe("thumbnailFeaturesAgent", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    requestAutoGenTaskMock.mockReset();
    recognizeWithLocalOcrMock.mockReset();
    process.env = { ...originalEnv };
    process.env.THUMB_OCR_ENABLED = "true";
    process.env.THUMB_OCR_ENGINE = "python";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-thumbnail-features-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeThumbnail(filePath: string): Promise<void> {
    const buffer = Buffer.alloc(120 * 80 * 3);
    for (let i = 0; i < buffer.length; i += 3) {
      buffer[i] = 220;
      buffer[i + 1] = 80;
      buffer[i + 2] = 20;
    }
    await sharp(buffer, { raw: { width: 120, height: 80, channels: 3 } }).jpeg({ quality: 100 }).toFile(filePath);
  }

  it("returns deterministic output and llm=null when AutoGen is disabled", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    recognizeWithLocalOcrMock.mockResolvedValue({
      status: "ok",
      engine: "paddleocr",
      imageWidth: 120,
      imageHeight: 80,
      boxes: [{ x: 2, y: 3, w: 80, h: 20, conf: 0.9, text: "Huge" }]
    });

    const thumbnailPath = path.join(tempDir, "thumb-disabled.jpg");
    await writeThumbnail(thumbnailPath);

    const { computeThumbnailFeaturesBundle } = await import("../src/derived/thumbnailFeaturesAgent.js");

    const result = await computeThumbnailFeaturesBundle({
      videoId: "video-disabled",
      title: "Huge Text Video",
      thumbnailAbsPath: thumbnailPath,
      thumbnailLocalPath: "thumbnails/video-disabled.jpg"
    });

    expect(result.bundle.schemaVersion).toBe("derived.video_features.v1");
    expect(result.bundle.thumbnailFeatures.deterministic.imageWidth).toBe(120);
    expect(result.bundle.thumbnailFeatures.deterministic.hasBigText).toBe(true);
    expect(result.bundle.thumbnailFeatures.llm).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("AUTO_GEN_ENABLED=false"))).toBe(true);
  });

  it("uses hi-confidence OCR boxes for overlap/textAreaRatio/hasBigText metrics", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;
    recognizeWithLocalOcrMock.mockResolvedValue({
      status: "ok",
      engine: "paddleocr",
      imageWidth: 120,
      imageHeight: 80,
      boxes: [
        { x: 0, y: 0, w: 80, h: 20, conf: 0.95, text: "Alpha" },
        { x: 50, y: 0, w: 40, h: 10, conf: 0.7, text: "Beta" },
        { x: 0, y: 20, w: 80, h: 20, conf: 0.2, text: "garbage" }
      ]
    });

    const thumbnailPath = path.join(tempDir, "thumb-metrics.jpg");
    await writeThumbnail(thumbnailPath);
    const { computeDeterministic } = await import("../src/derived/thumbnailFeaturesAgent.js");

    const result = await computeDeterministic({
      title: "Alpha Beta review",
      thumbnailAbsPath: thumbnailPath,
      thumbnailLocalPath: "thumbnails/video-metrics.jpg"
    });

    expect(result.value.ocrText).toBe("Alpha Beta");
    expect(result.value.ocrWordCount).toBe(2);
    expect(result.value.ocrWordCountHiConf).toBe(2);
    expect(result.value.textAreaRatio).toBeCloseTo(0.208333, 5);
    expect(result.value.thumb_ocr_title_overlap_jaccard).toBeCloseTo(2 / 3, 5);
    expect(result.value.hasBigText).toBe(true);
  });

  it("fails when python OCR is unavailable", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;
    process.env.THUMB_OCR_ENGINE = "python";

    recognizeWithLocalOcrMock.mockResolvedValue({
      status: "error",
      warning: "Local OCR unavailable"
    });
    const thumbnailPath = path.join(tempDir, "thumb-fallback.jpg");
    await writeThumbnail(thumbnailPath);
    const { computeDeterministic } = await import("../src/derived/thumbnailFeaturesAgent.js");

    const result = await computeDeterministic({
      title: "Fallback OCR title",
      thumbnailAbsPath: thumbnailPath,
      thumbnailLocalPath: "thumbnails/video-fallback.jpg"
    });

    expect(recognizeWithLocalOcrMock).toHaveBeenCalledTimes(1);
    expect(result.warnings.some((warning) => warning.includes("Local OCR unavailable"))).toBe(true);
    expect(result.value.ocrText).toBe("");
  });

  it("merges thumbnail features and normalizes LLM output", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";

    recognizeWithLocalOcrMock.mockResolvedValue({
      status: "ok",
      engine: "paddleocr",
      imageWidth: 120,
      imageHeight: 80,
      boxes: [{ x: 5, y: 4, w: 50, h: 18, conf: 0.95, text: "Text" }]
    });

    requestAutoGenTaskMock.mockResolvedValue({
      schemaVersion: "derived.thumbnail_llm.v1",
      archetype: { label: "unknown-label", confidence: 1.4 },
      faceSignals: {
        faceCountBucket: "0",
        dominantFacePosition: { x: "left", y: "top" },
        faceEmotionTone: "neutral",
        hasEyeContact: true,
        confidence: 0.77
      },
      clutterLevel: { label: "high", confidence: 0.88 },
      styleTags: [
        { label: "face", confidence: 0.8 },
        { label: "colorful", confidence: 0.7 }
      ],
      evidenceRegions: [{ label: "face-box", x: -0.3, y: 0.2, w: 1.4, h: 2 }],
      evidenceSignals: [
        { fieldName: "imageStats.brightnessMean", value: 0.33 },
        { fieldName: "ocrSummary.hasBigText", value: true },
        { fieldName: "", value: 123 }
      ]
    });

    const { persistThumbnailFeaturesArtifact } = await import("../src/derived/thumbnailFeaturesAgent.js");

    const channelFolderPath = path.join(tempDir, "MyChannel");
    const derivedFolderPath = path.join(channelFolderPath, "derived", "video_features");
    await fs.mkdir(derivedFolderPath, { recursive: true });

    const thumbnailPath = path.join(channelFolderPath, "thumbnails", "video123.jpg");
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    await writeThumbnail(thumbnailPath);

    const existingArtifactPath = path.join(derivedFolderPath, "video123.json");
    await fs.writeFile(
      existingArtifactPath,
      JSON.stringify(
        {
          schemaVersion: "derived.video_features.v1",
          videoId: "video123",
          computedAt: "2026-01-01T00:00:00.000Z",
          titleFeatures: {
            deterministic: { title_len_chars: 9 },
            llm: null
          }
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await persistThumbnailFeaturesArtifact({
      exportsRoot: tempDir,
      channelFolderPath,
      videoId: "video123",
      title: "Video 123",
      thumbnailAbsPath: thumbnailPath,
      thumbnailLocalPath: "thumbnails/video123.jpg"
    });

    expect(requestAutoGenTaskMock).toHaveBeenCalledTimes(1);
    expect(requestAutoGenTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "thumbnail_classifier_v1",
        payload: expect.objectContaining({
          videoId: "video123",
          thumbnailAbsPath: thumbnailPath
        })
      })
    );

    const writtenRaw = await fs.readFile(result.artifactAbsolutePath, "utf-8");
    const written = JSON.parse(writtenRaw) as {
      titleFeatures?: { deterministic?: { title_len_chars?: number } };
      thumbnailFeatures?: {
        llm: {
          archetype: { label: string; confidence: number };
          faceSignals: {
            faceCountBucket: string;
            dominantFacePosition: { x: string; y: string };
            hasEyeContact: boolean | "unknown";
          };
          styleTags: Array<{ label: string }>;
          evidenceRegions: Array<{ x: number; y: number; w: number; h: number }>;
          evidenceSignals: Array<{ fieldName: string; value: number | string | boolean | null }>;
        } | null;
        warnings: string[];
      };
    };

    expect(written.titleFeatures?.deterministic?.title_len_chars).toBe(9);
    expect(written.thumbnailFeatures?.llm?.archetype.label).toBe("other");
    expect(written.thumbnailFeatures?.llm?.faceSignals.faceCountBucket).toBe("0");
    expect(written.thumbnailFeatures?.llm?.faceSignals.dominantFacePosition).toEqual({ x: "unknown", y: "unknown" });
    expect(written.thumbnailFeatures?.llm?.faceSignals.hasEyeContact).toBe("unknown");
    expect(written.thumbnailFeatures?.llm?.styleTags.some((tag) => tag.label === "face")).toBe(false);
    expect(written.thumbnailFeatures?.llm?.evidenceRegions[0]).toEqual({
      x: 0,
      y: 0.2,
      w: 1,
      h: 1,
      label: "face-box"
    });
    expect(written.thumbnailFeatures?.llm?.evidenceSignals).toEqual(
      expect.arrayContaining([
        { fieldName: "brightnessMean", value: 0.33 },
        { fieldName: "hasBigText", value: true }
      ])
    );
    expect(
      written.thumbnailFeatures?.warnings.some((warning) => warning.includes("Removed style tag 'face'"))
    ).toBe(true);
    expect(
      written.thumbnailFeatures?.warnings.some((warning) => warning.includes("Discarded evidence signal"))
    ).toBe(false);
  });

  it("drops stale thumbnail warnings when deterministic OCR is recomputed", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    recognizeWithLocalOcrMock.mockResolvedValue({
      status: "ok",
      engine: "paddleocr",
      imageWidth: 120,
      imageHeight: 80,
      boxes: [{ x: 5, y: 4, w: 50, h: 18, conf: 0.95, text: "Fresh OCR" }]
    });

    const { persistThumbnailFeaturesArtifact } = await import("../src/derived/thumbnailFeaturesAgent.js");
    const channelFolderPath = path.join(tempDir, "WarningsChannel");
    const derivedFolderPath = path.join(channelFolderPath, "derived", "video_features");
    await fs.mkdir(derivedFolderPath, { recursive: true });

    const thumbnailPath = path.join(channelFolderPath, "thumbnails", "video-stale.jpg");
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    await writeThumbnail(thumbnailPath);

    await fs.writeFile(
      path.join(derivedFolderPath, "video-stale.json"),
      JSON.stringify(
        {
          schemaVersion: "derived.video_features.v1",
          videoId: "video-stale",
          computedAt: "2026-01-01T00:00:00.000Z",
          thumbnailFeatures: {
            deterministic: { ocrWordCount: 1 },
            llm: null,
            warnings: ["Local OCR failed for image /tmp/thumb.jpg: Unknown argument: show_log"]
          }
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await persistThumbnailFeaturesArtifact({
      exportsRoot: tempDir,
      channelFolderPath,
      videoId: "video-stale",
      title: "Fresh OCR title",
      thumbnailAbsPath: thumbnailPath,
      thumbnailLocalPath: "thumbnails/video-stale.jpg",
      compute: {
        deterministic: true,
        llm: false
      }
    });

    expect(result.warnings).not.toContain(expect.stringContaining("show_log"));
  });
});
