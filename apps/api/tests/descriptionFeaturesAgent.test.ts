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

describe("descriptionFeaturesAgent", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    requestAutoGenTaskMock.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-description-features-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns deterministic output and warnings when AutoGen is disabled", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    const { computeDescriptionFeaturesBundle } = await import("../src/derived/descriptionFeaturesAgent.js");

    const result = await computeDescriptionFeaturesBundle({
      videoId: "video-disabled",
      title: "My AI Video",
      description: "Subscribe now and visit https://example.com"
    });

    expect(result.bundle.schemaVersion).toBe("derived.video_features.v1");
    expect(result.bundle.descriptionFeatures.deterministic.desc_len_chars).toBeGreaterThan(0);
    expect(result.bundle.descriptionFeatures.llm).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("AUTO_GEN_ENABLED=false"))).toBe(true);
  });

  it("merges description features into existing derived artifact with mocked AutoGen output", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AUTO_GEN_TIMEOUT_SEC = "5";

    requestAutoGenTaskMock.mockResolvedValue({
      schemaVersion: "derived.description_llm.v1",
      linkPurpose: [
        {
          url: "https://bit.ly/deal",
          label: "affiliate",
          confidence: 0.91,
          evidence: { charStart: 10, charEnd: 24, snippet: "https://bit.ly" }
        }
      ],
      sponsorBrandMentions: [
        {
          brand: "Acme",
          confidence: 0.87,
          evidence: [{ charStart: 35, charEnd: 39, snippet: "Acme" }]
        }
      ],
      primaryCTA: {
        label: "link",
        confidence: 0.8,
        evidence: [{ charStart: 0, charEnd: 9, snippet: "Subscribe" }]
      }
    });

    const { persistDescriptionFeaturesArtifact } = await import("../src/derived/descriptionFeaturesAgent.js");

    const channelFolderPath = path.join(tempDir, "MyChannel");
    const derivedFolderPath = path.join(channelFolderPath, "derived", "video_features");
    await fs.mkdir(derivedFolderPath, { recursive: true });

    const existingArtifactPath = path.join(derivedFolderPath, "video123.json");
    await fs.writeFile(
      existingArtifactPath,
      JSON.stringify(
        {
          schemaVersion: "derived.video_features.v1",
          videoId: "video123",
          computedAt: "2026-01-01T00:00:00.000Z",
          titleFeatures: {
            deterministic: { title_len_chars: 12 },
            llm: null
          }
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await persistDescriptionFeaturesArtifact({
      exportsRoot: tempDir,
      channelFolderPath,
      videoId: "video123",
      title: "Great AI Video",
      description: "Subscribe and check https://bit.ly/deal. Sponsored by Acme.",
      languageHint: "en"
    });

    expect(requestAutoGenTaskMock).toHaveBeenCalledTimes(1);
    expect(requestAutoGenTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "description_classifier_v1",
        payload: expect.objectContaining({
          videoId: "video123",
          languageHint: "en"
        })
      })
    );
    expect(result.artifactRelativePath).toBe("derived/video_features/video123.json");

    const writtenRaw = await fs.readFile(result.artifactAbsolutePath, "utf-8");
    const written = JSON.parse(writtenRaw) as {
      titleFeatures?: { deterministic?: { title_len_chars?: number } };
      descriptionFeatures?: {
        deterministic: { url_count: number };
        llm: { linkPurpose: Array<{ label: string }>; primaryCTA: { label: string } | null } | null;
      };
    };

    expect(written.titleFeatures?.deterministic?.title_len_chars).toBe(12);
    expect(written.descriptionFeatures?.deterministic.url_count).toBe(1);
    expect(written.descriptionFeatures?.llm?.linkPurpose[0]?.label).toBe("affiliate");
    expect(written.descriptionFeatures?.llm?.primaryCTA?.label).toBe("link");
  });
});
