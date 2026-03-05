import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveOcrPythonPath, runOcrImportHealthCheck } from "../src/services/ocrRuntime.js";

describe("ocrRuntime.resolveOcrPythonPath", () => {
  it("uses OCR_PYTHON_PATH when it is set", () => {
    const resolved = resolveOcrPythonPath({
      env: {
        OCR_PYTHON_PATH: "/custom/ocr-python"
      } as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "darwin",
      exists: () => false
    });

    expect(resolved).toBe("/custom/ocr-python");
  });

  it("falls back to ASR_PYTHON_PATH when OCR_PYTHON_PATH is not set", () => {
    const resolved = resolveOcrPythonPath({
      env: {
        ASR_PYTHON_PATH: "/custom/asr-python"
      } as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "darwin",
      exists: () => false
    });

    expect(resolved).toBe("/custom/asr-python");
  });

  it("uses the repo venv python when .venv-asr exists", () => {
    const expected = path.resolve("/repo", ".venv-asr", "bin", "python");

    const resolved = resolveOcrPythonPath({
      env: {} as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "linux",
      exists: (candidatePath) => candidatePath === expected
    });

    expect(resolved).toBe(expected);
  });

  it("falls back to platform default when env var and venv are missing", () => {
    const linuxResolved = resolveOcrPythonPath({
      env: {} as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "linux",
      exists: () => false
    });

    const windowsResolved = resolveOcrPythonPath({
      env: {} as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "win32",
      exists: () => false
    });

    expect(linuxResolved).toBe("python3");
    expect(windowsResolved).toBe("python");
  });
});

describe("ocrRuntime.runOcrImportHealthCheck", () => {
  it("returns a failed health-check result when OCR module import fails", async () => {
    const execFileFn = vi.fn((_file, _args, _options, callback) => {
      callback(new Error("import failed") as never, "", "AssertionError: missing module: paddleocr or easyocr");
    });

    const result = await runOcrImportHealthCheck({
      pythonPath: "python3",
      cwd: "/repo",
      execFileFn
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("missing module");
  });
});
