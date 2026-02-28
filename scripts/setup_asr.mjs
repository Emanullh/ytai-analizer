#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isWindows = process.platform === "win32";

const command = isWindows ? "powershell" : "bash";
const args = isWindows
  ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "setup_asr.ps1")]
  : [path.join(__dirname, "setup_asr.sh")];

const result = spawnSync(command, args, {
  cwd: path.resolve(__dirname, ".."),
  stdio: "inherit"
});

if (result.error) {
  // eslint-disable-next-line no-console
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
