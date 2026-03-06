import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recognizeWithLocalOcrMock = vi.fn();

vi.mock("../src/services/localOcrService.js", () => ({
  recognizeWithLocalOcr: recognizeWithLocalOcrMock
}));

describe("thumbnail OCR integration math", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    recognizeWithLocalOcrMock.mockReset();
    process.env = { ...originalEnv };
    process.env.THUMB_OCR_ENABLED = "true";
    process.env.THUMB_OCR_ENGINE = "python";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-thumb-ocr-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("computes textAreaRatio and limits evidence boxes without running real OCR", async () => {
    const imagePath = path.join(tempDir, "thumb.jpg");
    const image = Buffer.alloc(100 * 50 * 3, 120);
    await sharp(image, { raw: { width: 100, height: 50, channels: 3 } }).jpeg({ quality: 100 }).toFile(imagePath);

    const boxes = Array.from({ length: 60 }, (_, index) => ({
      x: index,
      y: 1,
      w: 2,
      h: 5,
      confidence: 1 - index / 100,
      text: `w${index}`
    }));

    recognizeWithLocalOcrMock.mockResolvedValue({
      status: "ok",
      engine: "paddleocr",
      imageWidth: 100,
      imageHeight: 50,
      boxes: boxes.map((box) => ({
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        conf: box.confidence,
        text: box.text
      }))
    });

    const { computeDeterministic } = await import("../src/derived/thumbnailFeaturesAgent.js");

    const result = await computeDeterministic({
      title: "Big title demo",
      thumbnailAbsPath: imagePath,
      thumbnailLocalPath: "thumbnails/video123.jpg"
    });

    expect(recognizeWithLocalOcrMock).toHaveBeenCalledTimes(1);
    expect(result.value.textAreaRatio).toBeGreaterThan(0);
    expect(result.value.ocrBoxes).toHaveLength(50);
    expect(result.value.ocrWordCount).toBeGreaterThan(0);
    expect(typeof result.value.hasBigText).toBe("boolean");
  });
});
