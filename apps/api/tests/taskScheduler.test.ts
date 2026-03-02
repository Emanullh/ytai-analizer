import { describe, expect, it } from "vitest";
import { createScheduler } from "../src/services/taskScheduler.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("taskScheduler", () => {
  it("respects per-type concurrency limits", async () => {
    const scheduler = createScheduler({
      video: 10,
      http: 2,
      asr: 1,
      ocr: 1,
      llm: 2,
      embeddings: 2,
      fs: 4
    });

    let activeHttp = 0;
    let maxHttp = 0;

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        scheduler.run("http", async () => {
          activeHttp += 1;
          maxHttp = Math.max(maxHttp, activeHttp);
          await sleep(20 + (index % 2) * 5);
          activeHttp -= 1;
          return index;
        })
      )
    );

    expect(maxHttp).toBe(2);
  });

  it("respects video-level concurrency when running runVideo", async () => {
    const scheduler = createScheduler({
      video: 3,
      http: 6,
      asr: 1,
      ocr: 1,
      llm: 2,
      embeddings: 2,
      fs: 6
    });

    let activeVideos = 0;
    let maxActiveVideos = 0;

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        scheduler.runVideo(`video-${index}`, async () => {
          activeVideos += 1;
          maxActiveVideos = Math.max(maxActiveVideos, activeVideos);
          await sleep(15);
          activeVideos -= 1;
          return index;
        })
      )
    );

    expect(maxActiveVideos).toBe(3);
  });
});
