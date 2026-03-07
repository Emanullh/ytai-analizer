import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MockTaskPlan {
  delayMs: number;
  result: unknown;
}

function createMockWorker(plans: MockTaskPlan[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new PassThrough() as unknown as {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: Writable & { write: (chunk: string | Buffer, cb?: (error?: Error | null) => void) => boolean };
    once: (event: string, listener: (...args: unknown[]) => void) => unknown;
    emit: (event: string, ...args: unknown[]) => boolean;
    kill: (signal?: string) => boolean;
  };

  let taskIndex = 0;
  let processing = false;
  const queue: Array<{ line: string; callback?: (error?: Error | null) => void }> = [];

  const processNext = () => {
    if (processing || queue.length === 0) {
      return;
    }

    processing = true;
    const next = queue.shift();
    if (!next) {
      processing = false;
      return;
    }

    const payload = JSON.parse(next.line.trim()) as { id: string };
    const plan = plans[taskIndex] ?? { delayMs: 0, result: { ok: true } };
    taskIndex += 1;
    next.callback?.(null);

    setTimeout(() => {
      stdout.write(`${JSON.stringify({ id: payload.id, ok: true, result: plan.result })}\n`);
      processing = false;
      processNext();
    }, plan.delayMs);
  };

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      queue.push({ line: chunk.toString("utf-8"), callback });
      processNext();
    }
  }) as Writable & { write: (chunk: string | Buffer, cb?: (error?: Error | null) => void) => boolean };

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(() => true)
  });

  queueMicrotask(() => {
    child.emit("spawn");
  });

  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.AUTO_GEN_TIMEOUT_SEC;
});

describe("autogenRuntime", () => {
  it("starts the timeout when the task is dispatched, not while it is still queued", async () => {
    process.env.AUTO_GEN_TIMEOUT_SEC = "1";

    const worker = createMockWorker([
      { delayMs: 700, result: { task: "first" } },
      { delayMs: 500, result: { task: "second" } }
    ]);

    vi.doMock("node:child_process", () => ({
      spawn: vi.fn(() => worker)
    }));

    const runtime = await import("../src/services/autogenRuntime.js");

    const firstPromise = runtime.requestAutoGenTask({
      task: "description_classifier_v1",
      payload: {
        videoId: "video-1",
        title: "First",
        description: "desc",
        urlsWithSpans: [],
        languageHint: "en"
      }
    });

    const secondPromise = runtime.requestAutoGenTask({
      task: "description_classifier_v1",
      payload: {
        videoId: "video-2",
        title: "Second",
        description: "desc",
        urlsWithSpans: [],
        languageHint: "en"
      }
    });

    await expect(firstPromise).resolves.toEqual({ task: "first" });
    await expect(secondPromise).resolves.toEqual({ task: "second" });

    runtime.stopAutoGenWorker();
  });
});
