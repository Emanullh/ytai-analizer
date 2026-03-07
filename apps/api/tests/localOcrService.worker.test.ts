import os from "node:os";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const repoPythonPath = resolveRepoPythonPath();

function resolveRepoPythonPath(): string | null {
  const candidate = path.resolve(
    process.cwd(),
    "..",
    "..",
    ".venv-asr",
    process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python")
  );
  return existsSync(candidate) ? candidate : null;
}

function buildPythonPath(stubDir: string): string {
  const current = originalEnv.PYTHONPATH?.trim();
  return current ? `${stubDir}${path.delimiter}${current}` : stubDir;
}

async function writeFixtureImage(tempDir: string): Promise<string> {
  const imagePath = path.join(tempDir, "worker-thumb.jpg");
  const svg = `
<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#121212" />
  <text x="120" y="280" font-size="88" fill="#ffffff" font-family="Arial">WORKER OCR</text>
</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 100 }).toFile(imagePath);
  return imagePath;
}

async function writePythonStubs(tempDir: string, modules: Record<string, string>): Promise<string> {
  const stubDir = path.join(tempDir, "py-stubs");
  await fs.mkdir(stubDir, { recursive: true });

  await Promise.all(
    Object.entries(modules).map(([name, source]) => fs.writeFile(path.join(stubDir, `${name}.py`), source, "utf-8"))
  );

  return stubDir;
}

describe("localOcrService worker", () => {
  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.resetModules();

    try {
      const { resetLocalOcrRuntime } = await import("../src/services/localOcrService.js");
      resetLocalOcrRuntime();
    } catch {
      // Ignore reset failures when the module was never imported in a test.
    }
  });

  it.skipIf(!repoPythonPath)("initializes PaddleOCR in thumbnail-safe mode", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-local-ocr-worker-"));

    try {
      const stubDir = await writePythonStubs(tempDir, {
        paddleocr: `
import sys

class _Result:
    def __init__(self):
        self._data = {
            "dt_polys": [[[0, 0], [180, 0], [180, 48], [0, 48]]],
            "rec_texts": ["SAFE OCR"],
            "rec_scores": [0.97],
        }

    def __getitem__(self, key):
        return self._data[key]


class PaddleOCR:
    def __init__(
        self,
        lang=None,
        use_doc_orientation_classify=None,
        use_doc_unwarping=None,
        use_textline_orientation=None,
        enable_mkldnn=None,
        **kwargs,
    ):
        if lang != "en":
            raise RuntimeError(f"unexpected lang: {lang!r}")
        if use_doc_orientation_classify is not False:
            raise RuntimeError(f"use_doc_orientation_classify must be False: {use_doc_orientation_classify!r}")
        if use_doc_unwarping is not False:
            raise RuntimeError(f"use_doc_unwarping must be False: {use_doc_unwarping!r}")
        if use_textline_orientation is not False:
            raise RuntimeError(f"use_textline_orientation must be False: {use_textline_orientation!r}")
        if sys.platform == "win32" and enable_mkldnn is not False:
            raise RuntimeError(f"enable_mkldnn must be False on Windows: {enable_mkldnn!r}")

    def predict(self, image):
        return [_Result()]
`
      });

      const imagePath = await writeFixtureImage(tempDir);
      process.env = {
        ...originalEnv,
        OCR_PYTHON_PATH: repoPythonPath!,
        PYTHONPATH: buildPythonPath(stubDir),
        EXPORT_OCR_CONCURRENCY: "1"
      };

      vi.resetModules();
      const { recognizeWithLocalOcr, resetLocalOcrRuntime } = await import("../src/services/localOcrService.js");
      resetLocalOcrRuntime();

      const result = await recognizeWithLocalOcr({
        imagePath,
        langs: ["eng"],
        downscaleWidth: 960
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.engine).toBe("paddleocr");
        expect(result.boxes[0]?.text).toBe("SAFE OCR");
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!repoPythonPath)("falls back to EasyOCR when PaddleOCR fails at runtime", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-local-ocr-worker-"));

    try {
      const stubDir = await writePythonStubs(tempDir, {
        paddleocr: `
class PaddleOCR:
    def __init__(
        self,
        lang=None,
        use_doc_orientation_classify=None,
        use_doc_unwarping=None,
        use_textline_orientation=None,
        enable_mkldnn=None,
        **kwargs,
    ):
        self.lang = lang

    def predict(self, image):
        raise RuntimeError(
            "(Unimplemented) ConvertPirAttribute2RuntimeAttribute not support [pir::ArrayAttribute<pir::DoubleAttribute>]"
        )
`,
        easyocr: `
class Reader:
    def __init__(self, langs, gpu=False):
        if langs != ["en"]:
            raise RuntimeError(f"unexpected langs: {langs!r}")
        if gpu is not False:
            raise RuntimeError(f"unexpected gpu flag: {gpu!r}")

    def readtext(self, image, detail=1, paragraph=False):
        return [
            (
                [[0, 0], [220, 0], [220, 60], [0, 60]],
                "EASY FALLBACK",
                0.88,
            )
        ]
`
      });

      const imagePath = await writeFixtureImage(tempDir);
      process.env = {
        ...originalEnv,
        OCR_PYTHON_PATH: repoPythonPath!,
        PYTHONPATH: buildPythonPath(stubDir),
        EXPORT_OCR_CONCURRENCY: "1"
      };

      vi.resetModules();
      const { recognizeWithLocalOcr, resetLocalOcrRuntime } = await import("../src/services/localOcrService.js");
      resetLocalOcrRuntime();

      const result = await recognizeWithLocalOcr({
        imagePath,
        langs: ["eng"],
        downscaleWidth: 960
      });

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.engine).toBe("easyocr");
        expect(result.boxes[0]?.text).toBe("EASY FALLBACK");
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
