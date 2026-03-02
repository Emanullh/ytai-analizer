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

async function seedExportFixture(exportPath: string): Promise<void> {
  await fs.mkdir(path.join(exportPath, "derived", "video_features"), { recursive: true });
  await fs.mkdir(path.join(exportPath, "raw"), { recursive: true });

  const videos = [
    {
      videoId: "video-a",
      title: "Alpha video",
      publishedAt: "2026-01-01T00:00:00.000Z",
      durationSec: 90,
      description: "Alpha desc"
    },
    {
      videoId: "video-b",
      title: "Beta video",
      publishedAt: "2026-01-02T00:00:00.000Z",
      durationSec: 420,
      description: "Beta desc"
    }
  ];

  await fs.writeFile(path.join(exportPath, "raw", "videos.jsonl"), `${videos.map((video) => JSON.stringify(video)).join("\n")}\n`, "utf-8");
  await fs.writeFile(
    path.join(exportPath, "derived", "channel_models.json"),
    JSON.stringify(
      {
        schemaVersion: "derived.channel_models.v1",
        model: {
          type: "robust-linear"
        }
      },
      null,
      2
    ),
    "utf-8"
  );

  await fs.writeFile(
    path.join(exportPath, "derived", "video_features", "video-a.json"),
    JSON.stringify(
      {
        schemaVersion: "derived.video_features.v1",
        videoId: "video-a",
        performance: { residual: 0.4, percentile: 0.9, viewsPerDay: 100, engagementRate: 0.05 },
        titleFeatures: {
          deterministic: { has_number: true, question_mark_count: 1 },
          llm: { promise_type: [{ label: "tutorial", score: 0.8 }] }
        },
        thumbnailFeatures: {
          deterministic: { textAreaRatio: 0.42, hasBigText: true },
          llm: {
            archetype: { label: "text-heavy" },
            faceSignals: { faceCountBucket: "1" },
            clutterLevel: { label: "medium" }
          }
        },
        transcriptFeatures: {
          deterministic: { promise_delivery_30s_score: 0.7 }
        },
        descriptionFeatures: {
          deterministic: { url_count: 1 }
        }
      },
      null,
      2
    ),
    "utf-8"
  );
  await fs.writeFile(
    path.join(exportPath, "derived", "video_features", "video-b.json"),
    JSON.stringify(
      {
        schemaVersion: "derived.video_features.v1",
        videoId: "video-b",
        performance: { residual: -0.2, percentile: 0.3, viewsPerDay: 30, engagementRate: 0.02 },
        titleFeatures: {
          deterministic: { has_number: false, question_mark_count: 0 },
          llm: { promise_type: [{ label: "news", score: 0.9 }] }
        },
        thumbnailFeatures: {
          deterministic: { textAreaRatio: 0.1, hasBigText: false },
          llm: {
            archetype: { label: "screenshot" },
            faceSignals: { faceCountBucket: "0" },
            clutterLevel: { label: "high" }
          }
        },
        transcriptFeatures: {
          deterministic: { promise_delivery_30s_score: 0.2 }
        },
        descriptionFeatures: {
          deterministic: { url_count: 0 }
        }
      },
      null,
      2
    ),
    "utf-8"
  );
}

describe("orchestratorService", () => {
  const originalEnv = { ...process.env };
  let tempDir = "";
  let exportRoot = "";
  let exportPath = "";

  beforeEach(async () => {
    vi.resetModules();
    requestAutoGenTaskMock.mockReset();
    process.env = { ...originalEnv };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-orchestrator-service-"));
    exportRoot = tempDir;
    exportPath = path.join(exportRoot, "My_Channel");
    await seedExportFixture(exportPath);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("generates fallback playbook/templates with warnings when AutoGen is disabled", async () => {
    process.env.AUTO_GEN_ENABLED = "false";
    delete process.env.OPENAI_API_KEY;

    const { runOrchestrator } = await import("../src/analysis/orchestratorService.js");
    const result = await runOrchestrator({
      exportRoot,
      channelId: "UC1234567890123456789012",
      channelName: "My Channel",
      timeframe: "6m",
      jobId: "job-1"
    });

    const playbook = JSON.parse(await fs.readFile(path.join(exportPath, "analysis", "playbook.json"), "utf-8")) as {
      schemaVersion: string;
      warnings: string[];
      insights: unknown[];
    };
    const templates = JSON.parse(await fs.readFile(path.join(exportPath, "derived", "templates.json"), "utf-8")) as {
      schemaVersion: string;
      warnings: string[];
    };

    await fs.access(path.join(exportPath, "analysis", "orchestrator_input.json"));
    expect(result.usedLlm).toBe(false);
    expect(playbook.schemaVersion).toBe("analysis.playbook.v1");
    expect(templates.schemaVersion).toBe("derived.templates.v1");
    expect(Array.isArray(playbook.insights)).toBe(true);
    expect(playbook.warnings.some((warning) => warning.includes("LLM skipped"))).toBe(true);
    expect(templates.warnings.some((warning) => warning.includes("LLM skipped"))).toBe(true);
  });

  it("persists LLM output when supported_by/evidence_fields are valid", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";

    requestAutoGenTaskMock.mockResolvedValue({
      playbook: {
        schemaVersion: "analysis.playbook.v1",
        generatedAt: "2026-03-02T00:00:00.000Z",
        channel: {
          channelId: "UC1234567890123456789012",
          channelName: "My Channel",
          timeframe: "6m",
          jobId: "job-2"
        },
        warnings: [],
        insights: [
          {
            id: "ins-1",
            title: "High text thumbnails perform better",
            summary: "Synthetic test insight",
            supported_by: ["video-a"],
            evidence_fields: ["thumbnailFeatures.deterministic.textAreaRatio", "performance.residual"]
          }
        ],
        rules: [],
        keys: [],
        evidence: { cohorts: [], drivers: [], exemplars: {} }
      },
      templates: {
        schemaVersion: "derived.templates.v1",
        generatedAt: "2026-03-02T00:00:00.000Z",
        channel: {
          channelId: "UC1234567890123456789012",
          channelName: "My Channel",
          timeframe: "6m",
          jobId: "job-2"
        },
        warnings: [],
        titleTemplates: [
          {
            id: "tpl-1",
            template: "How to {result} in {time}",
            supported_by: ["video-a"],
            evidence_fields: ["titleFeatures.deterministic.has_number"]
          }
        ],
        thumbnailTemplates: [],
        scriptTemplates: []
      }
    });

    const { runOrchestrator } = await import("../src/analysis/orchestratorService.js");
    const result = await runOrchestrator({
      exportRoot,
      channelId: "UC1234567890123456789012",
      channelName: "My Channel",
      timeframe: "6m",
      jobId: "job-2"
    });

    const playbook = JSON.parse(await fs.readFile(path.join(exportPath, "analysis", "playbook.json"), "utf-8")) as {
      insights: Array<{ id: string }>;
    };
    const templates = JSON.parse(await fs.readFile(path.join(exportPath, "derived", "templates.json"), "utf-8")) as {
      titleTemplates: Array<{ id: string }>;
    };

    expect(result.usedLlm).toBe(true);
    expect(requestAutoGenTaskMock).toHaveBeenCalledTimes(1);
    expect(playbook.insights[0]?.id).toBe("ins-1");
    expect(templates.titleTemplates[0]?.id).toBe("tpl-1");
  });

  it("falls back when LLM output fails supported_by/evidence_fields validation", async () => {
    process.env.AUTO_GEN_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";

    requestAutoGenTaskMock.mockResolvedValue({
      playbook: {
        schemaVersion: "analysis.playbook.v1",
        generatedAt: "2026-03-02T00:00:00.000Z",
        channel: {
          channelId: "UC1234567890123456789012",
          channelName: "My Channel",
          timeframe: "6m",
          jobId: "job-3"
        },
        warnings: [],
        insights: [
          {
            id: "ins-1",
            title: "Invalid support",
            supported_by: ["video-unknown"],
            evidence_fields: ["performance.residual"]
          }
        ],
        rules: [],
        keys: [],
        evidence: { cohorts: [], drivers: [], exemplars: {} }
      },
      templates: {
        schemaVersion: "derived.templates.v1",
        generatedAt: "2026-03-02T00:00:00.000Z",
        channel: {
          channelId: "UC1234567890123456789012",
          channelName: "My Channel",
          timeframe: "6m",
          jobId: "job-3"
        },
        warnings: [],
        titleTemplates: [],
        thumbnailTemplates: [],
        scriptTemplates: []
      }
    });

    const { runOrchestrator } = await import("../src/analysis/orchestratorService.js");
    const result = await runOrchestrator({
      exportRoot,
      channelId: "UC1234567890123456789012",
      channelName: "My Channel",
      timeframe: "6m",
      jobId: "job-3"
    });

    const playbook = JSON.parse(await fs.readFile(path.join(exportPath, "analysis", "playbook.json"), "utf-8")) as {
      insights: unknown[];
      warnings: string[];
    };

    expect(playbook.insights).toEqual([]);
    expect(playbook.warnings.some((warning) => warning.includes("supported_by contains unknown videoId"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("supported_by contains unknown videoId"))).toBe(true);
  });
});
