import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Timeframe } from "../types.js";
import { sanitizeFolderName } from "../utils/sanitize.js";
import { requestAutoGenTask } from "../services/autogenRuntime.js";
import {
  buildDeterministicOrchestratorInput,
  type FlatVideoRow,
  type OrchestratorInputV1
} from "./orchestratorDeterministic.js";

interface PlaybookInsightLike {
  supported_by?: unknown;
  evidence_fields?: unknown;
  [key: string]: unknown;
}

interface OrchestratorLlmOutput {
  playbook?: unknown;
  templates?: unknown;
}

export interface PlaybookArtifactV1 {
  schemaVersion: "analysis.playbook.v1";
  generatedAt: string;
  channel: {
    channelId: string;
    channelName: string;
    timeframe: Timeframe;
    jobId: string;
  };
  warnings: string[];
  insights: PlaybookInsightLike[];
  rules: PlaybookInsightLike[];
  keys: PlaybookInsightLike[];
  evidence: {
    cohorts: unknown[];
    drivers: unknown[];
    exemplars: unknown;
  };
  checklists?: {
    title: string[];
    thumbnail: string[];
    hook_0_30s: string[];
  };
  contentIdeationPrompt?: {
    systemPrompt: string;
    supported_by: string[];
  };
}

export interface TemplatesArtifactV1 {
  schemaVersion: "derived.templates.v1";
  generatedAt: string;
  channel: {
    channelId: string;
    channelName: string;
    timeframe: Timeframe;
    jobId: string;
  };
  warnings: string[];
  titleTemplates: PlaybookInsightLike[];
  thumbnailTemplates: PlaybookInsightLike[];
  scriptTemplates: PlaybookInsightLike[];
  titleGenerationPrompt?: {
    systemPrompt: string;
    exampleInputOutput: Array<{ topic: string; generatedTitle: string }>;
    supported_by: string[];
  };
  scriptGenerationPrompt?: {
    systemPrompt: string;
    supported_by: string[];
  };
}

export interface RunOrchestratorArgs {
  exportRoot: string;
  channelId: string;
  channelName: string;
  timeframe: Timeframe;
  jobId: string;
  onAutoGenWorkerRequestId?: (workerRequestId: string) => void;
}

export interface RunOrchestratorResult {
  warnings: string[];
  usedLlm: boolean;
  artifactPaths: string[];
}

export interface GenerateOrchestratorInputResult {
  warnings: string[];
  artifactPaths: string[];
}

function ensureInsideRoot(rootPath: string, targetPath: string): void {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error("Invalid export path for orchestrator artifact");
  }
}

function toSafeRelativePath(rootPath: string, targetPath: string): string {
  ensureInsideRoot(rootPath, targetPath);
  const relativePath = path.relative(rootPath, targetPath);
  const normalized = relativePath.split(path.sep).join(path.posix.sep);
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("Invalid relative artifact path");
  }
  return normalized;
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, targetPath);
}

function getPathValue(obj: unknown, dottedPath: string): unknown {
  if (!dottedPath.trim()) {
    return undefined;
  }
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function collectEvidenceItems(value: unknown, acc: PlaybookInsightLike[]): void {
  if (!value) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEvidenceItems(item, acc);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }

  const record = value as PlaybookInsightLike;
  if (Object.prototype.hasOwnProperty.call(record, "supported_by") || Object.prototype.hasOwnProperty.call(record, "evidence_fields")) {
    acc.push(record);
  }
  for (const nested of Object.values(record)) {
    collectEvidenceItems(nested, acc);
  }
}

function sanitizeSupportedBy(
  value: unknown,
  validVideoIds: Set<string>
): { sanitized: string[]; stripped: string[] } {
  if (!Array.isArray(value)) {
    return { sanitized: [], stripped: [] };
  }
  const sanitized: string[] = [];
  const stripped: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && validVideoIds.has(item)) {
      sanitized.push(item);
    } else {
      stripped.push(String(item));
    }
  }
  return { sanitized, stripped };
}

function sanitizeEvidenceFields(
  value: unknown,
  rows: FlatVideoRow[]
): { sanitized: string[]; stripped: string[] } {
  if (!Array.isArray(value)) {
    return { sanitized: [], stripped: [] };
  }
  const sanitized: string[] = [];
  const stripped: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      stripped.push(String(item));
      continue;
    }
    const pathIsValid = rows.some((row) => getPathValue(row, item) !== undefined);
    if (pathIsValid) {
      sanitized.push(item);
    } else {
      stripped.push(item);
    }
  }
  return { sanitized, stripped };
}

function validateLlmArtifacts(input: {
  playbook: unknown;
  templates: unknown;
  rows: FlatVideoRow[];
}): { ok: true; warnings: string[] } | { ok: false; warning: string } {
  if (!input.playbook || typeof input.playbook !== "object" || Array.isArray(input.playbook)) {
    return { ok: false, warning: "LLM output invalid: playbook missing or not an object" };
  }
  if (!input.templates || typeof input.templates !== "object" || Array.isArray(input.templates)) {
    return { ok: false, warning: "LLM output invalid: templates missing or not an object" };
  }
  const playbookSchema = (input.playbook as { schemaVersion?: unknown }).schemaVersion;
  const templatesSchema = (input.templates as { schemaVersion?: unknown }).schemaVersion;
  if (playbookSchema !== "analysis.playbook.v1") {
    return { ok: false, warning: "LLM output invalid: playbook.schemaVersion must be analysis.playbook.v1" };
  }
  if (templatesSchema !== "derived.templates.v1") {
    return { ok: false, warning: "LLM output invalid: templates.schemaVersion must be derived.templates.v1" };
  }

  const evidenceItems: PlaybookInsightLike[] = [];
  collectEvidenceItems(input.playbook, evidenceItems);
  collectEvidenceItems(input.templates, evidenceItems);

  const videoIds = new Set(input.rows.map((row) => row.videoId));
  for (const item of evidenceItems) {
    if (Object.prototype.hasOwnProperty.call(item, "supported_by")) {
      const { stripped } = sanitizeSupportedBy(item.supported_by, videoIds);
      if (stripped.length > 0) {
        return {
          ok: false,
          warning: `LLM output invalid: supported_by contains unknown videoId(s): ${stripped.join(", ")}`
        };
      }
    }
    if (Object.prototype.hasOwnProperty.call(item, "evidence_fields")) {
      const { stripped } = sanitizeEvidenceFields(item.evidence_fields, input.rows);
      if (stripped.length > 0) {
        return {
          ok: false,
          warning: `LLM output invalid: evidence_fields contains unknown path(s): ${stripped.join(", ")}`
        };
      }
    }
  }

  return { ok: true, warnings: [] };
}

function toFallbackPlaybook(args: {
  deterministic: OrchestratorInputV1;
  channel: RunOrchestratorArgs;
  warnings: string[];
}): PlaybookArtifactV1 {
  return {
    schemaVersion: "analysis.playbook.v1",
    generatedAt: new Date().toISOString(),
    channel: {
      channelId: args.channel.channelId,
      channelName: args.channel.channelName,
      timeframe: args.channel.timeframe,
      jobId: args.channel.jobId
    },
    warnings: [...args.warnings],
    insights: [],
    rules: [],
    keys: [],
    evidence: {
      cohorts: args.deterministic.cohorts,
      drivers: args.deterministic.drivers,
      exemplars: args.deterministic.exemplars
    }
  };
}

function toFallbackTemplates(args: { channel: RunOrchestratorArgs; warnings: string[] }): TemplatesArtifactV1 {
  return {
    schemaVersion: "derived.templates.v1",
    generatedAt: new Date().toISOString(),
    channel: {
      channelId: args.channel.channelId,
      channelName: args.channel.channelName,
      timeframe: args.channel.timeframe,
      jobId: args.channel.jobId
    },
    warnings: [...args.warnings],
    titleTemplates: [],
    thumbnailTemplates: [],
    scriptTemplates: []
  };
}

function normalizeLlmArtifacts(raw: unknown): OrchestratorLlmOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  return {
    playbook: source.playbook,
    templates: source.templates
  };
}

async function updateManifestArtifactsIfExists(args: {
  exportPath: string;
  artifactAbsolutePaths: string[];
  warnings: string[];
}): Promise<void> {
  const manifestPath = path.resolve(args.exportPath, "manifest.json");
  const rawManifest = await fs.readFile(manifestPath, "utf-8").catch(() => null);
  if (!rawManifest) {
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawManifest) as Record<string, unknown>;
  } catch {
    args.warnings.push("Orchestrator: manifest.json exists but is invalid JSON; skipped artifacts update");
    return;
  }

  const existingArtifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((item) => typeof item === "string") : [];
  const appended = args.artifactAbsolutePaths.map((artifactPath) => toSafeRelativePath(args.exportPath, artifactPath));
  const manifest = {
    ...parsed,
    artifacts: Array.from(new Set([...existingArtifacts, ...appended])).sort()
  };
  await writeJsonAtomic(manifestPath, manifest);
}

export async function runOrchestrator(args: RunOrchestratorArgs): Promise<RunOrchestratorResult> {
  const warnings: string[] = [];
  const exportPath = path.resolve(args.exportRoot, sanitizeFolderName(args.channelName));
  const analysisPath = path.resolve(exportPath, "analysis");
  const derivedPath = path.resolve(exportPath, "derived");
  const orchestratorInputPath = path.resolve(analysisPath, "orchestrator_input.json");
  const playbookPath = path.resolve(analysisPath, "playbook.json");
  const templatesPath = path.resolve(derivedPath, "templates.json");

  ensureInsideRoot(args.exportRoot, exportPath);
  ensureInsideRoot(args.exportRoot, analysisPath);
  ensureInsideRoot(args.exportRoot, derivedPath);
  ensureInsideRoot(args.exportRoot, orchestratorInputPath);
  ensureInsideRoot(args.exportRoot, playbookPath);
  ensureInsideRoot(args.exportRoot, templatesPath);

  await fs.mkdir(analysisPath, { recursive: true });
  await fs.mkdir(derivedPath, { recursive: true });

  const deterministic = await buildDeterministicOrchestratorInput({
    exportPath,
    channelMeta: {
      channelId: args.channelId,
      channelName: args.channelName,
      timeframe: args.timeframe,
      jobId: args.jobId
    }
  });
  warnings.push(...deterministic.warnings);
  await writeJsonAtomic(orchestratorInputPath, deterministic.orchestratorInput);

  const llmEnabled = env.autoGenEnabled && Boolean(env.openAiApiKey);
  if (!llmEnabled) {
    const reason = !env.autoGenEnabled ? "AUTO_GEN_ENABLED=false" : "OPENAI_API_KEY missing";
    warnings.push(`Channel orchestrator LLM skipped: ${reason}`);
    const fallbackPlaybook = toFallbackPlaybook({
      deterministic: deterministic.orchestratorInput,
      channel: args,
      warnings
    });
    const fallbackTemplates = toFallbackTemplates({ channel: args, warnings });
    await writeJsonAtomic(playbookPath, fallbackPlaybook);
    await writeJsonAtomic(templatesPath, fallbackTemplates);
    await updateManifestArtifactsIfExists({
      exportPath,
      artifactAbsolutePaths: [orchestratorInputPath, playbookPath, templatesPath],
      warnings
    });
    return {
      warnings,
      usedLlm: false,
      artifactPaths: [orchestratorInputPath, playbookPath, templatesPath]
    };
  }

  let llmOutput: OrchestratorLlmOutput = {};
  try {
    const requestPayload = {
      task: "channel_orchestrator_v1" as const,
      payload: deterministic.orchestratorInput as unknown as Record<string, unknown>,
      provider: "openai" as const,
      model: env.autoGenModelOrchestrator,
      reasoningEffort: env.autoGenReasoningEffortOrchestrator
    };
    const raw = args.onAutoGenWorkerRequestId
      ? await requestAutoGenTask(requestPayload, { onWorkerRequestId: args.onAutoGenWorkerRequestId })
      : await requestAutoGenTask(requestPayload);
    llmOutput = normalizeLlmArtifacts(raw);
  } catch (error) {
    warnings.push(`Channel orchestrator LLM failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  let playbook: PlaybookArtifactV1 = toFallbackPlaybook({
    deterministic: deterministic.orchestratorInput,
    channel: args,
    warnings
  });
  let templates: TemplatesArtifactV1 = toFallbackTemplates({ channel: args, warnings });

  if (llmOutput.playbook && llmOutput.templates) {
    const validation = validateLlmArtifacts({
      playbook: llmOutput.playbook,
      templates: llmOutput.templates,
      rows: deterministic.orchestratorInput.rows
    });
    if (validation.ok) {
      if (validation.warnings.length > 0) {
        warnings.push(...validation.warnings);
      }
      playbook = llmOutput.playbook as PlaybookArtifactV1;
      templates = llmOutput.templates as TemplatesArtifactV1;
      playbook.warnings = Array.from(new Set([...(Array.isArray(playbook.warnings) ? playbook.warnings : []), ...warnings]));
      templates.warnings = Array.from(new Set([...(Array.isArray(templates.warnings) ? templates.warnings : []), ...warnings]));
    } else {
      warnings.push(`${validation.warning}; using deterministic fallback`);
      playbook = toFallbackPlaybook({
        deterministic: deterministic.orchestratorInput,
        channel: args,
        warnings
      });
      templates = toFallbackTemplates({ channel: args, warnings });
    }
  } else {
    warnings.push("Channel orchestrator LLM returned incomplete payload; using deterministic fallback");
    playbook = toFallbackPlaybook({
      deterministic: deterministic.orchestratorInput,
      channel: args,
      warnings
    });
    templates = toFallbackTemplates({ channel: args, warnings });
  }

  await writeJsonAtomic(playbookPath, playbook);
  await writeJsonAtomic(templatesPath, templates);
  await updateManifestArtifactsIfExists({
    exportPath,
    artifactAbsolutePaths: [orchestratorInputPath, playbookPath, templatesPath],
    warnings
  });

  return {
    warnings,
    usedLlm: Boolean(llmOutput.playbook && llmOutput.templates),
    artifactPaths: [orchestratorInputPath, playbookPath, templatesPath]
  };
}

export async function generateOrchestratorInput(args: RunOrchestratorArgs): Promise<GenerateOrchestratorInputResult> {
  const warnings: string[] = [];
  const exportPath = path.resolve(args.exportRoot, sanitizeFolderName(args.channelName));
  const analysisPath = path.resolve(exportPath, "analysis");
  const orchestratorInputPath = path.resolve(analysisPath, "orchestrator_input.json");

  ensureInsideRoot(args.exportRoot, exportPath);
  ensureInsideRoot(args.exportRoot, analysisPath);
  ensureInsideRoot(args.exportRoot, orchestratorInputPath);

  await fs.mkdir(analysisPath, { recursive: true });

  const deterministic = await buildDeterministicOrchestratorInput({
    exportPath,
    channelMeta: {
      channelId: args.channelId,
      channelName: args.channelName,
      timeframe: args.timeframe,
      jobId: args.jobId
    }
  });

  warnings.push(...deterministic.warnings);
  await writeJsonAtomic(orchestratorInputPath, deterministic.orchestratorInput);
  await updateManifestArtifactsIfExists({
    exportPath,
    artifactAbsolutePaths: [orchestratorInputPath],
    warnings
  });

  return {
    warnings,
    artifactPaths: [orchestratorInputPath]
  };
}
