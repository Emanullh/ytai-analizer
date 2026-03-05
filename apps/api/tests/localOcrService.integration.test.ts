import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

const hasOcrPythonPath = Boolean(process.env.OCR_PYTHON_PATH?.trim());

describe("localOcrService integration (opt-in)", () => {
  it.skipIf(!hasOcrPythonPath)("runs OCR worker roundtrip for one image", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-local-ocr-it-"));

    try {
      const imagePath = path.join(tempDir, "ocr-it-thumb.jpg");
      const svg = `
<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#101010" />
  <text x="80" y="280" font-size="96" fill="#ffffff" font-family="Arial">HELLO OCR</text>
</svg>`;
      await sharp(Buffer.from(svg)).jpeg({ quality: 100 }).toFile(imagePath);

      const { recognizeWithLocalOcr } = await import("../src/services/localOcrService.js");
      const result = await recognizeWithLocalOcr({
        imagePath,
        langs: ["eng"],
        downscaleWidth: 960
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.boxes.length).toBeGreaterThan(0);
        expect(result.imageWidth).toBeGreaterThan(0);
        expect(result.imageHeight).toBeGreaterThan(0);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  // Placeholder to make it explicit this suite is opt-in and should not leak failures when skipped.
});
