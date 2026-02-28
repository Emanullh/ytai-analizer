import { describe, expect, it } from "vitest";
import { createInitialExportModalState, reduceExportModalState } from "./exportJobState";

describe("exportJobState reducer", () => {
  it("updates modal state from SSE events", () => {
    let state = createInitialExportModalState();
    state = reduceExportModalState(state, {
      type: "start",
      videoIds: ["v1", "v2"]
    });

    expect(state.isOpen).toBe(true);
    expect(state.status).toBe("starting");
    expect(state.total).toBe(2);
    expect(state.videoStages.v1).toBe("queue");
    expect(state.videoStages.v2).toBe("queue");

    state = reduceExportModalState(state, {
      type: "event",
      payload: {
        event: "job_started",
        data: { total: 2 }
      }
    });
    state = reduceExportModalState(state, {
      type: "event",
      payload: {
        event: "video_progress",
        data: { videoId: "v1", stage: "transcribing" }
      }
    });
    state = reduceExportModalState(state, {
      type: "event",
      payload: {
        event: "job_progress",
        data: { completed: 1, total: 2 }
      }
    });
    state = reduceExportModalState(state, {
      type: "event",
      payload: {
        event: "warning",
        data: { message: "warning test" }
      }
    });
    state = reduceExportModalState(state, {
      type: "event",
      payload: {
        event: "job_done",
        data: { exportPath: "/tmp/export/channel" }
      }
    });

    expect(state.status).toBe("done");
    expect(state.completed).toBe(2);
    expect(state.exportPath).toBe("/tmp/export/channel");
    expect(state.videoStages.v1).toBe("transcribing");
    expect(state.warnings).toContain("warning test");
  });
});

