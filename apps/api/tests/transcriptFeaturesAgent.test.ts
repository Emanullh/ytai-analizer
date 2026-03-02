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

describe("transcriptFeaturesAgent", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";

  beforeEach(async () => {
    vi.resetModules();
    requestAutoGenTaskMock.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-transcript-features-"));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns deterministic output and llm=null when AutoGen is disabled", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    const { computeTranscriptFeaturesBundle } = await import("../src/derived/transcriptFeaturesAgent.js");

    const result = await computeTranscriptFeaturesBundle({
      videoId: "video-disabled",
      title: "My Transcript Video",
      transcript: "simple transcript without timestamps"
    });

    expect(result.bundle.schemaVersion).toBe("derived.video_features.v1");
    expect(result.bundle.transcriptFeatures.deterministic.title_keyword_coverage).toBeGreaterThanOrEqual(0);
    expect(result.bundle.transcriptFeatures.llm).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("AUTO_GEN_ENABLED=false"))).toBe(true);
  });

  it("merges transcript features and validates llm evidence", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";

    requestAutoGenTaskMock.mockResolvedValue({
      schemaVersion: "derived.transcript_llm.v1",
      story_arc: {
        label: "tutorial",
        confidence: 0.88,
        evidenceSegments: [{ segmentIndex: 0, snippet: "Welcome to this tutorial" }]
      },
      sponsor_segments: [
        {
          startSec: 61,
          endSec: 86,
          brand: "Acme",
          confidence: 0.91,
          evidenceSegments: [{ segmentIndex: 1, snippet: "sponsored by Acme" }]
        },
        {
          startSec: 90,
          endSec: 100,
          brand: "GhostBrand",
          confidence: 0.7,
          evidenceSegments: [{ segmentIndex: 1, snippet: "sponsored by Acme" }]
        }
      ],
      cta_segments: [
        {
          type: "subscribe",
          confidence: 0.8,
          evidenceSegments: [{ segmentIndex: 2, snippet: "subscribe for more" }]
        },
        {
          type: "like",
          confidence: 0.4,
          evidenceSegments: [{ segmentIndex: 999, snippet: "like this" }]
        }
      ]
    });

    const { persistTranscriptFeaturesArtifact } = await import("../src/derived/transcriptFeaturesAgent.js");

    const channelFolderPath = path.join(tempDir, "MyChannel");
    const derivedFolderPath = path.join(channelFolderPath, "derived", "video_features");
    const rawTranscriptsPath = path.join(channelFolderPath, "raw", "transcripts");
    await fs.mkdir(derivedFolderPath, { recursive: true });
    await fs.mkdir(rawTranscriptsPath, { recursive: true });

    const transcriptArtifactPath = path.join(rawTranscriptsPath, "video123.jsonl");
    await fs.writeFile(
      transcriptArtifactPath,
      [
        JSON.stringify({
          type: "meta",
          videoId: "video123",
          source: "captions",
          status: "ok",
          language: "en",
          model: null,
          computeType: null,
          createdAt: "2026-03-02T00:00:00.000Z",
          transcriptCleaned: false
        }),
        JSON.stringify({
          type: "segment",
          i: 0,
          startSec: 0,
          endSec: 20,
          text: "Welcome to this tutorial where we explain the setup",
          confidence: null
        }),
        JSON.stringify({
          type: "segment",
          i: 1,
          startSec: 65,
          endSec: 80,
          text: "This part is sponsored by Acme and includes a discount",
          confidence: null
        }),
        JSON.stringify({
          type: "segment",
          i: 2,
          startSec: 150,
          endSec: 170,
          text: "Please subscribe for more and comment your questions",
          confidence: null
        })
      ].join("\n") + "\n",
      "utf-8"
    );

    const existingArtifactPath = path.join(derivedFolderPath, "video123.json");
    await fs.writeFile(
      existingArtifactPath,
      JSON.stringify(
        {
          schemaVersion: "derived.video_features.v1",
          videoId: "video123",
          computedAt: "2026-01-01T00:00:00.000Z",
          titleFeatures: {
            deterministic: { title_len_chars: 10 },
            llm: null
          },
          descriptionFeatures: {
            deterministic: { desc_len_chars: 10 },
            llm: null,
            warnings: []
          }
        },
        null,
        2
      ),
      "utf-8"
    );

    const result = await persistTranscriptFeaturesArtifact({
      exportsRoot: tempDir,
      channelFolderPath,
      videoId: "video123",
      title: "Acme Tutorial",
      transcriptArtifactPath,
      transcript: "fallback transcript",
      durationSec: 180,
      languageHint: "en"
    });

    expect(requestAutoGenTaskMock).toHaveBeenCalledTimes(1);
    expect(requestAutoGenTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "transcript_classifier_v1",
        payload: expect.objectContaining({
          videoId: "video123",
          segmentsSample: expect.any(Array)
        })
      })
    );

    const writtenRaw = await fs.readFile(result.artifactAbsolutePath, "utf-8");
    const written = JSON.parse(writtenRaw) as {
      titleFeatures?: { deterministic?: { title_len_chars?: number } };
      transcriptFeatures?: {
        llm: {
          story_arc: { label: string } | null;
          sponsor_segments: Array<{ brand: string }>;
          cta_segments: Array<{ type: string; evidenceSegments: Array<{ segmentIndex: number }> }>;
        } | null;
        warnings: string[];
      };
    };

    expect(written.titleFeatures?.deterministic?.title_len_chars).toBe(10);
    expect(written.transcriptFeatures?.llm?.story_arc?.label).toBe("tutorial");
    expect(written.transcriptFeatures?.llm?.sponsor_segments).toHaveLength(1);
    expect(written.transcriptFeatures?.llm?.sponsor_segments[0]?.brand).toBe("Acme");
    expect(written.transcriptFeatures?.llm?.cta_segments[0]?.type).toBe("subscribe");
    expect(
      written.transcriptFeatures?.warnings.some((warning) => warning.includes("GhostBrand"))
    ).toBe(true);
  });
});
