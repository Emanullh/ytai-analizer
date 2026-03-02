import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeterministicOrchestratorInput } from "../src/analysis/orchestratorDeterministic.js";

async function seedSyntheticExport(exportPath: string): Promise<void> {
  const videoFeaturesPath = path.join(exportPath, "derived", "video_features");
  await fs.mkdir(videoFeaturesPath, { recursive: true });
  await fs.mkdir(path.join(exportPath, "raw"), { recursive: true });

  const rawLines: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const videoId = `video-${String(i + 1).padStart(2, "0")}`;
    const residual = Number((i * 0.1).toFixed(6));
    const percentile = Number(((i + 1) / 10).toFixed(6));
    const textAreaRatio = Number((0.05 + i * 0.05).toFixed(6));
    const durationSec = i < 3 ? 45 : i < 6 ? 180 : i < 8 ? 480 : 1_500;

    const artifact = {
      schemaVersion: "derived.video_features.v1",
      videoId,
      computedAt: "2026-03-02T00:00:00.000Z",
      performance: {
        viewsPerDay: 100 + i * 25,
        engagementRate: Number((0.02 + i * 0.01).toFixed(6)),
        residual,
        percentile
      },
      titleFeatures: {
        deterministic: {
          question_mark_count: i % 2,
          has_number: i % 3 === 0
        },
        llm: {
          promise_type: [
            { label: i % 2 === 0 ? "tutorial" : "news", score: 0.8, confidence: 0.8, evidence: [] }
          ]
        }
      },
      descriptionFeatures: {
        deterministic: {
          url_count: i % 4
        }
      },
      transcriptFeatures: {
        deterministic: {
          promise_delivery_30s_score: Number((0.2 + i * 0.05).toFixed(6)),
          wpm_overall: 120 + i * 2
        }
      },
      thumbnailFeatures: {
        deterministic: {
          textAreaRatio,
          hasBigText: i >= 5
        },
        llm: {
          archetype: { label: i % 2 === 0 ? "text-heavy" : "screenshot", confidence: 0.7 },
          faceSignals: { faceCountBucket: i % 3 === 0 ? "0" : "1" },
          clutterLevel: { label: i % 2 === 0 ? "medium" : "high" }
        }
      }
    };

    await fs.writeFile(path.join(videoFeaturesPath, `${videoId}.json`), JSON.stringify(artifact, null, 2), "utf-8");
    rawLines.push(
      JSON.stringify({
        videoId,
        title: `Synthetic title ${i + 1}`,
        publishedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        durationSec,
        description: `Description ${i + 1}`
      })
    );
  }

  await fs.writeFile(path.join(exportPath, "raw", "videos.jsonl"), `${rawLines.join("\n")}\n`, "utf-8");
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
}

describe("orchestratorDeterministic", () => {
  let tempDir = "";
  let exportPath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ytai-orchestrator-det-"));
    exportPath = path.join(tempDir, "MyChannel");
    await seedSyntheticExport(exportPath);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds cohorts, rankings and top drivers from synthetic dataset", async () => {
    const result = await buildDeterministicOrchestratorInput({
      exportPath,
      channelMeta: {
        channelId: "UC1234567890123456789012",
        channelName: "MyChannel",
        timeframe: "6m",
        jobId: "job-1"
      }
    });

    expect(result.orchestratorInput.rows).toHaveLength(10);
    expect(result.orchestratorInput.exemplars.top_videos).toHaveLength(10);
    expect(result.orchestratorInput.exemplars.bottom_videos).toHaveLength(5);
    expect(result.orchestratorInput.exemplars.mid_videos.length).toBeGreaterThan(0);

    const durationCohort = result.orchestratorInput.cohorts.find(
      (cohort) => cohort.dimension === "duration_bucket" && cohort.bucket === "short"
    );
    expect(durationCohort?.n).toBe(3);
    expect(durationCohort?.topExemplars.length).toBeGreaterThan(0);

    const topDriver = result.orchestratorInput.drivers[0];
    expect(topDriver).toBeDefined();
    expect(topDriver?.absEffect).toBeGreaterThan(0.7);
    expect(
      result.orchestratorInput.drivers.some(
        (driver) => driver.feature === "thumbnailFeatures.deterministic.textAreaRatio"
      )
    ).toBe(true);
  });
});
