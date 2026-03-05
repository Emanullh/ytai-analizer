#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

function resolvePythonPath() {
  const fromEnv = process.env.ASR_PYTHON_PATH?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const venvPython = isWindows
    ? path.join(repoRoot, ".venv-asr", "Scripts", "python.exe")
    : path.join(repoRoot, ".venv-asr", "bin", "python");

  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  return isWindows ? "python" : "python3";
}

const pythonPath = resolvePythonPath();
const dependencySummary = "faster_whisper, autogen_agentchat, autogen_ext, cv2, paddleocr|easyocr";
const checkScript = [
  "import importlib.util as u",
  "import faster_whisper",
  "import autogen_agentchat",
  "import autogen_ext",
  'assert u.find_spec("cv2") is not None, "missing module: cv2"',
  'assert (u.find_spec("paddleocr") is not None) or (u.find_spec("easyocr") is not None), "missing module: paddleocr or easyocr"'
].join("; ");
const check = spawnSync(pythonPath, ["-c", checkScript], {
  cwd: repoRoot,
  encoding: "utf-8"
});

if (check.error) {
  // eslint-disable-next-line no-console
  console.error(`[asr:check] Failed to execute ${pythonPath}: ${check.error.message}`);
  process.exit(1);
}

if (check.status !== 0) {
  const stderr = check.stderr?.trim();
  const stdout = check.stdout?.trim();
  const message = stderr || stdout || "unknown error";
  // eslint-disable-next-line no-console
  console.error(`[asr:check] Python dependency import check failed using ${pythonPath}`);
  // eslint-disable-next-line no-console
  console.error(`[asr:check] ${message}`);
  process.exit(1);
}

// eslint-disable-next-line no-console
console.log(`[asr:check] OK using ${pythonPath} (${dependencySummary})`);
