import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function writePatternJpeg(
  filePath: string,
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => [number, number, number]
): Promise<void> {
  const buffer = Buffer.alloc(width * height * 3);

  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      buffer[cursor] = r;
      buffer[cursor + 1] = g;
      buffer[cursor + 2] = b;
      cursor += 3;
    }
  }

  await sharp(buffer, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toFile(filePath);
}

describe("imageStats", () => {
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-image-stats-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("computes low contrast and low edge density for a uniform thumbnail", async () => {
    const filePath = path.join(tempDir, "uniform.jpg");
    await writePatternJpeg(filePath, 80, 60, () => [128, 128, 128]);

    const { decodeThumbnailToRgb, computeBrightnessContrast, computeColorfulness, computeEdgeDensity } =
      await import("../src/derived/vision/imageStats.js");

    const decoded = await decodeThumbnailToRgb(filePath);
    const brightnessContrast = computeBrightnessContrast(decoded.rgbBuffer);

    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    expect(brightnessContrast.brightnessMean).toBeGreaterThan(0.45);
    expect(brightnessContrast.brightnessMean).toBeLessThan(0.55);
    expect(brightnessContrast.contrastStd).toBeLessThan(0.03);
    expect(computeColorfulness(decoded.rgbBuffer)).toBeLessThan(0.08);
    expect(computeEdgeDensity(decoded.rgbBuffer, decoded.width, decoded.height)).toBeLessThan(0.05);
  });

  it("computes higher colorfulness and sharpness for textured colorful image", async () => {
    const colorfulPath = path.join(tempDir, "colorful.jpg");
    const grayPath = path.join(tempDir, "gray.jpg");

    await writePatternJpeg(colorfulPath, 96, 64, (x, y) => {
      if ((x + y) % 4 === 0) {
        return [255, 20, 20];
      }
      if ((x + y) % 4 === 1) {
        return [20, 255, 20];
      }
      if ((x + y) % 4 === 2) {
        return [20, 20, 255];
      }
      return [255, 230, 30];
    });

    await writePatternJpeg(grayPath, 96, 64, (x, y) => {
      const value = (x + y) % 2 === 0 ? 220 : 30;
      return [value, value, value];
    });

    const { decodeThumbnailToRgb, computeColorfulness, computeSharpnessLaplacianVar } =
      await import("../src/derived/vision/imageStats.js");

    const colorful = await decodeThumbnailToRgb(colorfulPath);
    const gray = await decodeThumbnailToRgb(grayPath);

    const colorfulMetric = computeColorfulness(colorful.rgbBuffer);
    const grayMetric = computeColorfulness(gray.rgbBuffer);

    expect(colorfulMetric).toBeGreaterThan(grayMetric);
    expect(colorfulMetric).toBeGreaterThan(0.2);
    expect(computeSharpnessLaplacianVar(colorful.rgbBuffer, colorful.width, colorful.height)).toBeGreaterThan(0.05);
  });
});
