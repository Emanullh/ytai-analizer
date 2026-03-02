import type { VideoCachePlan } from "./exportCacheService.js";
import type { SchedulerLimits, SchedulerTaskType } from "./taskScheduler.js";

export type ExportPlanTaskType = Exclude<SchedulerTaskType, "video"> | "cache" | "compute";

export interface VideoPlanTask {
  id: string;
  type: ExportPlanTaskType;
  deps: string[];
  produces: string[];
  consumes: string[];
}

export interface BuildVideoPlanInput {
  videoId: string;
  cacheHit: "full" | "partial" | "miss";
  cachePlan: VideoCachePlan;
  artifacts: {
    rawTranscriptExists: boolean;
    thumbnailExists: boolean;
  };
  strategy?: {
    titleWaitForTranscript?: boolean;
  };
}

export interface ValidatePlanInput {
  tasks: VideoPlanTask[];
  limits: Pick<SchedulerLimits, "http" | "asr" | "ocr" | "llm" | "embeddings" | "fs">;
  exclusiveTypes?: Array<Extract<ExportPlanTaskType, "asr" | "ocr">>;
}

export interface PlanValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    totalTasks: number;
    totalEdges: number;
    byType: Record<string, number>;
  };
}

function addTask(tasks: VideoPlanTask[], task: VideoPlanTask): void {
  tasks.push({
    ...task,
    deps: Array.from(new Set(task.deps)),
    consumes: Array.from(new Set(task.consumes)),
    produces: Array.from(new Set(task.produces))
  });
}

function toTypeCounts(tasks: VideoPlanTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.type] = (counts[task.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Per-video DAG strategy:
 * - `title_derived` waits for transcript (single strategy, no partial upgrade branch).
 * - `description_derived` only depends on metadata (title/description), so it can run early.
 * - `thumbnail_derived` waits for thumbnail availability.
 */
export function buildVideoPlan(input: BuildVideoPlanInput): VideoPlanTask[] {
  const tasks: VideoPlanTask[] = [];
  const waitForTranscript = input.strategy?.titleWaitForTranscript ?? true;

  addTask(tasks, {
    id: "cache_check",
    type: "cache",
    deps: [],
    produces: ["cache_state"],
    consumes: []
  });

  if (input.cacheHit === "full") {
    addTask(tasks, {
      id: "cache_revalidate",
      type: "fs",
      deps: ["cache_check"],
      consumes: ["cache_state"],
      produces: ["video_ready"]
    });
    return tasks;
  }

  const transcriptTaskId = input.cachePlan.needTranscriptFetch ? "transcript_fetch" : "transcript_cached";
  addTask(tasks, {
    id: transcriptTaskId,
    type: input.cachePlan.needTranscriptFetch ? "asr" : "fs",
    deps: ["cache_check"],
    consumes: ["cache_state"],
    produces: ["transcript"]
  });

  const thumbnailTaskId = input.cachePlan.needThumbnailDownload ? "thumbnail_download" : "thumbnail_cached";
  addTask(tasks, {
    id: thumbnailTaskId,
    type: input.cachePlan.needThumbnailDownload ? "http" : "fs",
    deps: ["cache_check"],
    consumes: ["cache_state"],
    produces: ["thumbnail"]
  });

  if (input.cachePlan.needTranscriptFetch || !input.artifacts.rawTranscriptExists) {
    addTask(tasks, {
      id: "write_raw_transcript",
      type: "fs",
      deps: [transcriptTaskId],
      consumes: ["transcript"],
      produces: ["raw_transcript_artifact"]
    });
  }

  if (
    input.cachePlan.needDerivedParts.descriptionDeterministic ||
    input.cachePlan.needDerivedParts.descriptionLlm
  ) {
    addTask(tasks, {
      id: "description_derived",
      type: input.cachePlan.needDerivedParts.descriptionLlm ? "llm" : "compute",
      deps: ["cache_check"],
      consumes: ["cache_state", "title", "description"],
      produces: ["description_features"]
    });
  }

  if (input.cachePlan.needDerivedParts.titleDeterministic || input.cachePlan.needDerivedParts.titleLlm) {
    const type: ExportPlanTaskType = input.cachePlan.needDerivedParts.titleLlm
      ? "llm"
      : input.cachePlan.needDerivedParts.titleDeterministic
        ? "embeddings"
        : "compute";
    addTask(tasks, {
      id: "title_derived",
      type,
      deps: waitForTranscript ? [transcriptTaskId] : ["cache_check"],
      consumes: waitForTranscript ? ["title", "transcript"] : ["title"],
      produces: ["title_features"]
    });
  }

  if (input.cachePlan.needDerivedParts.transcriptDeterministic || input.cachePlan.needDerivedParts.transcriptLlm) {
    addTask(tasks, {
      id: "transcript_derived",
      type: input.cachePlan.needDerivedParts.transcriptLlm ? "llm" : "compute",
      deps: [transcriptTaskId],
      consumes: ["transcript"],
      produces: ["transcript_features"]
    });
  }

  if (input.cachePlan.needDerivedParts.thumbnailDeterministic || input.cachePlan.needDerivedParts.thumbnailLlm) {
    const type: ExportPlanTaskType = input.cachePlan.needDerivedParts.thumbnailLlm
      ? "llm"
      : input.cachePlan.needDerivedParts.thumbnailDeterministic
        ? "ocr"
        : "compute";
    addTask(tasks, {
      id: "thumbnail_derived",
      type,
      deps: [thumbnailTaskId],
      consumes: ["thumbnail"],
      produces: ["thumbnail_features"]
    });
  }

  addTask(tasks, {
    id: "write_raw_video",
    type: "fs",
    deps: [transcriptTaskId],
    consumes: ["transcript"],
    produces: ["raw_video_record"]
  });

  return tasks;
}

function collectPotentialParallelByType(tasks: VideoPlanTask[]): Record<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    indegree.set(task.id, 0);
    adjacency.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!byId.has(dep)) {
        continue;
      }
      adjacency.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const ready: string[] = [];
  for (const [taskId, value] of indegree.entries()) {
    if (value === 0) {
      ready.push(taskId);
    }
  }

  const maxByType: Record<string, number> = {};
  while (ready.length > 0) {
    const batch = [...ready];
    ready.length = 0;

    const batchTypeCount: Record<string, number> = {};
    for (const taskId of batch) {
      const task = byId.get(taskId);
      if (!task) {
        continue;
      }
      batchTypeCount[task.type] = (batchTypeCount[task.type] ?? 0) + 1;
    }

    for (const [type, count] of Object.entries(batchTypeCount)) {
      maxByType[type] = Math.max(maxByType[type] ?? 0, count);
    }

    for (const taskId of batch) {
      const neighbors = adjacency.get(taskId) ?? [];
      for (const neighbor of neighbors) {
        const next = (indegree.get(neighbor) ?? 0) - 1;
        indegree.set(neighbor, next);
        if (next === 0) {
          ready.push(neighbor);
        }
      }
    }
  }

  return maxByType;
}

export function validatePlan(input: ValidatePlanInput): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byType = toTypeCounts(input.tasks);
  const totalEdges = input.tasks.reduce((acc, task) => acc + task.deps.length, 0);

  const knownIds = new Set<string>();
  for (const task of input.tasks) {
    if (!task.id.trim()) {
      errors.push("Task id cannot be empty");
      continue;
    }
    if (knownIds.has(task.id)) {
      errors.push(`Duplicate task id: ${task.id}`);
      continue;
    }
    knownIds.add(task.id);

    if (task.deps.includes(task.id)) {
      errors.push(`Task ${task.id} has a self dependency`);
    }
  }

  for (const task of input.tasks) {
    for (const dep of task.deps) {
      if (!knownIds.has(dep)) {
        errors.push(`Task ${task.id} depends on missing task ${dep}`);
      }
    }
  }

  const indegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const task of input.tasks) {
    indegree.set(task.id, 0);
    adjacency.set(task.id, []);
  }
  for (const task of input.tasks) {
    for (const dep of task.deps) {
      if (!knownIds.has(dep)) {
        continue;
      }
      adjacency.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [taskId, degree] of indegree.entries()) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  let visited = 0;
  while (queue.length > 0) {
    const taskId = queue.shift();
    if (!taskId) {
      continue;
    }
    visited += 1;
    for (const nextTaskId of adjacency.get(taskId) ?? []) {
      const nextDegree = (indegree.get(nextTaskId) ?? 0) - 1;
      indegree.set(nextTaskId, nextDegree);
      if (nextDegree === 0) {
        queue.push(nextTaskId);
      }
    }
  }

  if (visited !== input.tasks.length) {
    errors.push("Plan contains a dependency cycle");
  }

  const limitByType: Record<string, number> = {
    http: input.limits.http,
    asr: input.limits.asr,
    ocr: input.limits.ocr,
    llm: input.limits.llm,
    embeddings: input.limits.embeddings,
    fs: input.limits.fs
  };

  for (const [type, limit] of Object.entries(limitByType)) {
    if (!Number.isFinite(limit) || limit < 1) {
      errors.push(`Invalid scheduler limit for ${type}: ${String(limit)}`);
    }
  }

  const potentialParallel = collectPotentialParallelByType(input.tasks);
  const exclusiveTypes = input.exclusiveTypes ?? ["asr", "ocr"];
  for (const type of exclusiveTypes) {
    const potential = potentialParallel[type] ?? 0;
    const configured = limitByType[type] ?? 1;
    if (potential > configured) {
      warnings.push(
        `Potential parallel tasks for ${type} (${potential}) exceed configured limit (${configured}); scheduler throttling required`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      totalTasks: input.tasks.length,
      totalEdges,
      byType
    }
  };
}
