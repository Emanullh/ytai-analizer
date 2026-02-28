import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveAsrPythonPath, runAsrImportHealthCheck } from "../src/services/asrRuntime.js";

describe("asrRuntime.resolveAsrPythonPath", () => {
  it("uses ASR_PYTHON_PATH when it is set", () => {
    const resolved = resolveAsrPythonPath({
      env: {
        ASR_PYTHON_PATH: "/custom/python"
      } as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "darwin",
      exists: () => false
    });

    expect(resolved).toBe("/custom/python");
  });

  it("uses the repo venv python when .venv-asr exists", () => {
    const expected = path.resolve("/repo", ".venv-asr", "bin", "python");

    const resolved = resolveAsrPythonPath({
      env: {} as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "linux",
      exists: (candidatePath) => candidatePath === expected
    });

    expect(resolved).toBe(expected);
  });

  it("falls back to platform default when env var and venv are missing", () => {
    const linuxResolved = resolveAsrPythonPath({
      env: {} as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "linux",
      exists: () => false
    });

    const windowsResolved = resolveAsrPythonPath({
      env: {} as NodeJS.ProcessEnv,
      cwd: "/repo",
      platform: "win32",
      exists: () => false
    });

    expect(linuxResolved).toBe("python3");
    expect(windowsResolved).toBe("python");
  });
});

describe("asrRuntime.runAsrImportHealthCheck", () => {
  it("returns a failed health-check result when faster_whisper import fails", async () => {
    const execFileFn = vi.fn((_file, _args, _options, callback) => {
      callback(new Error("import failed") as never, "", "ModuleNotFoundError: faster_whisper");
    });

    const result = await runAsrImportHealthCheck({
      pythonPath: "python3",
      cwd: "/repo",
      execFileFn
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ModuleNotFoundError");
  });
});
