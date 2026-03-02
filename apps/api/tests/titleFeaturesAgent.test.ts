import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestAutoGenTaskMock = vi.fn();

vi.mock("../src/services/autogenRuntime.js", () => ({
  requestAutoGenTask: requestAutoGenTaskMock,
  startAutoGenWorker: vi.fn(),
  stopAutoGenWorker: vi.fn()
}));

describe("titleFeaturesAgent", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    requestAutoGenTaskMock.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-title-features-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns deterministic output and warnings when AutoGen is disabled", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    const { computeTitleFeaturesBundle } = await import("../src/derived/titleFeaturesAgent.js");

    const result = await computeTitleFeaturesBundle({
      videoId: "video-disabled",
      title: "My Title",
      transcript: "My transcript"
    });

    expect(result.bundle.schemaVersion).toBe("derived.video_features.v1");
    expect(result.bundle.titleFeatures.deterministic.title_len_chars).toBeGreaterThan(0);
    expect(result.bundle.titleFeatures.llm).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("AUTO_GEN_ENABLED=false"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("OPENAI_API_KEY"))).toBe(true);
  });

  it("writes derived artifact with mocked AutoGen output", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AUTO_GEN_TIMEOUT_SEC = "5";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            embedding: [1, 0, 0]
          }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    requestAutoGenTaskMock.mockResolvedValue({
      schemaVersion: "derived.title_llm.v1",
      promise_type: [
        {
          label: "news",
          score: 0.82,
          confidence: 0.76,
          evidence: [{ charStart: 0, charEnd: 5, snippet: "BREAK" }]
        }
      ],
      curiosity_gap_type: [
        {
          label: "mystery",
          score: 0.65,
          confidence: 0.61,
          evidence: [{ charStart: 6, charEnd: 12, snippet: "SECRET" }]
        }
      ],
      headline_claim_strength: {
        label: "high",
        confidence: 0.7,
        evidence: [{ charStart: 0, charEnd: 12, snippet: "BREAKING SECRET" }]
      }
    });

    const { persistTitleFeaturesArtifact } = await import("../src/derived/titleFeaturesAgent.js");

    const channelFolderPath = path.join(tempDir, "MyChannel");
    await fs.mkdir(channelFolderPath, { recursive: true });

    const result = await persistTitleFeaturesArtifact({
      exportsRoot: tempDir,
      channelFolderPath,
      videoId: "video123",
      title: "BREAKING SECRET NEWS",
      transcript: "breaking secret news explained",
      languageHint: "en"
    });

    expect(requestAutoGenTaskMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.artifactRelativePath).toBe("derived/video_features/video123.json");

    const writtenRaw = await fs.readFile(result.artifactAbsolutePath, "utf-8");
    const written = JSON.parse(writtenRaw) as {
      schemaVersion: string;
      titleFeatures: {
        deterministic: { title_transcript_sim_cosine: number | null };
        llm: { promise_type: Array<{ label: string }> } | null;
      };
    };

    expect(written.schemaVersion).toBe("derived.video_features.v1");
    expect(written.titleFeatures.deterministic.title_transcript_sim_cosine).toBe(1);
    expect(written.titleFeatures.llm?.promise_type[0]?.label).toBe("news");
  });
});
