export type SchedulerTaskType = "video" | "http" | "asr" | "ocr" | "llm" | "embeddings" | "fs";

export interface SchedulerLimits {
  video: number;
  http: number;
  asr: number;
  ocr: number;
  llm: number;
  embeddings: number;
  fs: number;
}

export interface SchedulerQueueStats {
  limit: number;
  active: number;
  pending: number;
}

export interface SchedulerStats {
  video: SchedulerQueueStats;
  http: SchedulerQueueStats;
  asr: SchedulerQueueStats;
  ocr: SchedulerQueueStats;
  llm: SchedulerQueueStats;
  embeddings: SchedulerQueueStats;
  fs: SchedulerQueueStats;
}

interface QueueState {
  limit: number;
  active: number;
  queue: Array<() => void>;
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

function createQueue(limit: number): QueueState {
  return {
    limit: normalizeLimit(limit),
    active: 0,
    queue: []
  };
}

async function runInQueue<T>(queue: QueueState, fn: () => Promise<T>): Promise<T> {
  if (queue.active >= queue.limit) {
    await new Promise<void>((resolve) => {
      queue.queue.push(resolve);
    });
  }

  queue.active += 1;
  try {
    return await fn();
  } finally {
    queue.active -= 1;
    const next = queue.queue.shift();
    next?.();
  }
}

function queueToStats(queue: QueueState): SchedulerQueueStats {
  return {
    limit: queue.limit,
    active: queue.active,
    pending: queue.queue.length
  };
}

export interface TaskScheduler {
  readonly limits: SchedulerLimits;
  run<T>(type: Exclude<SchedulerTaskType, "video">, fn: () => Promise<T>): Promise<T>;
  runVideo<T>(videoId: string, fn: () => Promise<T>): Promise<T>;
  stats(): SchedulerStats;
}

export function createScheduler(limits: SchedulerLimits): TaskScheduler {
  const normalizedLimits: SchedulerLimits = {
    video: normalizeLimit(limits.video),
    http: normalizeLimit(limits.http),
    asr: normalizeLimit(limits.asr),
    ocr: normalizeLimit(limits.ocr),
    llm: normalizeLimit(limits.llm),
    embeddings: normalizeLimit(limits.embeddings),
    fs: normalizeLimit(limits.fs)
  };

  const queues: Record<SchedulerTaskType, QueueState> = {
    video: createQueue(normalizedLimits.video),
    http: createQueue(normalizedLimits.http),
    asr: createQueue(normalizedLimits.asr),
    ocr: createQueue(normalizedLimits.ocr),
    llm: createQueue(normalizedLimits.llm),
    embeddings: createQueue(normalizedLimits.embeddings),
    fs: createQueue(normalizedLimits.fs)
  };

  return {
    limits: normalizedLimits,
    run<T>(type: Exclude<SchedulerTaskType, "video">, fn: () => Promise<T>): Promise<T> {
      return runInQueue(queues[type], fn);
    },
    runVideo<T>(_videoId: string, fn: () => Promise<T>): Promise<T> {
      return runInQueue(queues.video, fn);
    },
    stats(): SchedulerStats {
      return {
        video: queueToStats(queues.video),
        http: queueToStats(queues.http),
        asr: queueToStats(queues.asr),
        ocr: queueToStats(queues.ocr),
        llm: queueToStats(queues.llm),
        embeddings: queueToStats(queues.embeddings),
        fs: queueToStats(queues.fs)
      };
    }
  };
}
