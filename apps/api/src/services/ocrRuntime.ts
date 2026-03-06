import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ResolveOcrPythonPathOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (candidatePath: string) => boolean;
}

interface OcrImportHealthCheckOptions {
  pythonPath: string;
  cwd?: string;
  execFileFn?: ExecFileFn;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { cwd?: string },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void
) => void;

export interface OcrImportHealthCheckResult {
  ok: boolean;
  error?: string;
}

function getVenvRelativePythonPath(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.join(".venv-asr", "Scripts", "python.exe")
    : path.join(".venv-asr", "bin", "python");
}

function buildRootCandidates(cwd: string): string[] {
  return [cwd, path.resolve(cwd, ".."), path.resolve(cwd, "..", "..")] as const;
}

function normalizeFromEnv(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

export function resolveOcrPythonPath(options: ResolveOcrPythonPathOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const envPythonPath = normalizeFromEnv(env.OCR_PYTHON_PATH) ?? normalizeFromEnv(env.ASR_PYTHON_PATH);
  if (envPythonPath) {
    return envPythonPath;
  }

  const relativeVenvPythonPath = getVenvRelativePythonPath(platform);
  const rootCandidates = buildRootCandidates(cwd);
  for (const rootCandidate of rootCandidates) {
    const venvPythonPath = path.resolve(rootCandidate, relativeVenvPythonPath);
    if (exists(venvPythonPath)) {
      return venvPythonPath;
    }
  }

  return platform === "win32" ? "python" : "python3";
}

export async function runOcrImportHealthCheck(
  options: OcrImportHealthCheckOptions
): Promise<OcrImportHealthCheckResult> {
  const execFileFn = options.execFileFn ?? execFile;
  const checkScript = [
    "import importlib.util as u",
    'has_cv2 = u.find_spec("cv2") is not None',
    'has_paddleocr = u.find_spec("paddleocr") is not None',
    'has_paddle = u.find_spec("paddle") is not None',
    'has_easy = u.find_spec("easyocr") is not None',
    'assert has_cv2, "missing module: cv2"',
    'assert (has_paddleocr or has_easy), "missing module: paddleocr or easyocr"',
    'assert (has_easy or has_paddle), "missing module: paddle (required by paddleocr)"'
  ].join("; ");

  return new Promise<OcrImportHealthCheckResult>((resolve) => {
    execFileFn(
      options.pythonPath,
      ["-c", checkScript],
      {
        cwd: options.cwd ?? process.cwd()
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true });
          return;
        }

        const detail = stderr.trim() || stdout.trim() || error.message || "unknown health check error";
        resolve({ ok: false, error: detail });
      }
    );
  });
}
