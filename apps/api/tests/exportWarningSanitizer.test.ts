import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPerformanceWarning,
  isTranscriptArtifactFallbackWarning,
  sanitizeProjectWarnings,
  sanitizeVideoWarnings
} from "../src/services/exportWarningSanitizer.js";

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

describe("exportWarningSanitizer", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("removes transcript fallback warnings once the artifact exists", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-warning-sanitize-"));
    tempDirs.push(projectRoot);

    const transcriptPath = path.resolve(projectRoot, "raw", "transcripts", "video1.jsonl");
    await writeText(transcriptPath, '{"type":"meta","videoId":"video1","status":"ok","source":"captions"}\n');

    const result = await sanitizeVideoWarnings({
      projectRoot,
      videoId: "video1",
      transcriptPath: "raw/transcripts/video1.jsonl",
      warnings: [
        "Transcript artifact missing at C:\\temp\\stale\\video1.jsonl; used in-memory fallback segment",
        "Embeddings similarity used truncated transcript input to stay within model context limits"
      ]
    });

    expect(result).toEqual(["Embeddings similarity used truncated transcript input to stay within model context limits"]);
  });

  it("normalizes transcript fallback warnings to the current project path when the artifact is still missing", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-warning-sanitize-"));
    tempDirs.push(projectRoot);

    const result = await sanitizeVideoWarnings({
      projectRoot,
      videoId: "video2",
      transcriptPath: "raw/transcripts/video2.jsonl",
      warnings: ["Transcript artifact missing at C:\\temp\\old\\video2.jsonl; used in-memory fallback segment"]
    });

    expect(result).toEqual([
      `Transcript artifact missing at ${path.resolve(projectRoot, "raw", "transcripts", "video2.jsonl")}; used in-memory fallback segment`
    ]);
  });

  it("rebuilds project warnings from current transcript state and current performance warnings", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-warning-sanitize-"));
    tempDirs.push(projectRoot);

    await writeText(
      path.resolve(projectRoot, "raw", "transcripts", "video-ok.jsonl"),
      '{"type":"meta","videoId":"video-ok","status":"ok","source":"captions"}\n'
    );

    const result = await sanitizeProjectWarnings({
      projectRoot,
      rows: [
        {
          videoId: "video-ok",
          transcriptPath: "raw/transcripts/video-ok.jsonl",
          warnings: ["Transcript artifact missing at C:\\temp\\stale\\video-ok.jsonl; used in-memory fallback segment"]
        },
        {
          videoId: "video-missing",
          transcriptPath: "raw/transcripts/video-missing.jsonl",
          warnings: ["Transcript artifact missing at C:\\temp\\stale\\video-missing.jsonl; used in-memory fallback segment"]
        }
      ],
      warnings: [
        "Transcript artifact missing at C:\\temp\\stale\\video-ok.jsonl; used in-memory fallback segment",
        "Performance model skipped: requires at least 5 videos, received 3",
        "Channel orchestrator skipped during export; run it manually from the Projects tab if needed."
      ],
      performanceWarnings: ["Some videos are missing durationSec; duration term imputed as 0 for those rows"]
    });

    expect(result).toEqual([
      "Channel orchestrator skipped during export; run it manually from the Projects tab if needed.",
      `Transcript artifact missing at ${path.resolve(projectRoot, "raw", "transcripts", "video-missing.jsonl")}; used in-memory fallback segment`,
      "Some videos are missing durationSec; duration term imputed as 0 for those rows"
    ]);
    expect(isTranscriptArtifactFallbackWarning(result[1] ?? "")).toBe(true);
    expect(isPerformanceWarning(result[2] ?? "")).toBe(true);
  });
});
