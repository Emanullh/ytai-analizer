import { describe, expect, it } from "vitest";
import { buildVideoPlan, validatePlan, type VideoPlanTask } from "../src/services/exportPlan.js";

describe("exportPlan", () => {
  it("builds a valid DAG for partial cache with transcript + thumbnail work", () => {
    const tasks = buildVideoPlan({
      videoId: "video-1",
      cacheHit: "partial",
      cachePlan: {
        needThumbnailDownload: true,
        needTranscriptFetch: true,
        needDerivedParts: {
          titleDeterministic: true,
          titleLlm: false,
          descriptionDeterministic: true,
          descriptionLlm: false,
          transcriptDeterministic: true,
          transcriptLlm: false,
          thumbnailDeterministic: true,
          thumbnailDeterministicMode: "full",
          thumbnailLlm: false
        }
      },
      artifacts: {
        rawTranscriptExists: false,
        thumbnailExists: false
      },
      strategy: {
        titleWaitForTranscript: true
      }
    });

    const titleTask = tasks.find((task) => task.id === "title_derived");
    expect(titleTask).toBeTruthy();
    expect(titleTask?.deps).toContain("transcript_fetch");

    const validation = validatePlan({
      tasks,
      limits: {
        http: 6,
        asr: 1,
        ocr: 2,
        llm: 2,
        embeddings: 2,
        fs: 6
      }
    });

    expect(validation.ok).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(validation.summary.totalTasks).toBeGreaterThan(0);
  });

  it("detects cycles and missing dependencies", () => {
    const invalidTasks: VideoPlanTask[] = [
      {
        id: "a",
        type: "http",
        deps: ["missing"],
        consumes: [],
        produces: []
      },
      {
        id: "b",
        type: "fs",
        deps: ["a", "c"],
        consumes: [],
        produces: []
      },
      {
        id: "c",
        type: "fs",
        deps: ["b"],
        consumes: [],
        produces: []
      }
    ];

    const validation = validatePlan({
      tasks: invalidTasks,
      limits: {
        http: 4,
        asr: 1,
        ocr: 1,
        llm: 2,
        embeddings: 2,
        fs: 4
      }
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.some((error) => error.includes("missing task"))).toBe(true);
    expect(validation.errors.some((error) => error.includes("cycle"))).toBe(true);
  });
});
