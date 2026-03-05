import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { env } from "./config/env.js";
import { exportSelectedVideos } from "./services/exportService.js";
import { ExportJobEvent, exportJobService } from "./services/exportJobService.js";
import {
  createThumbnailStream,
  getProjectDetail,
  getProjectVideoDetail,
  listProjectVideos,
  listProjects,
  readProjectArtifact,
  resolveProjectThumbnail
} from "./services/projectsService.js";
import { getProjectBundleMeta, prepareProjectBundleDownload } from "./services/exportBundleService.js";
import { analyzeChannel } from "./services/youtubeService.js";
import { HttpError } from "./utils/errors.js";
import { rerunOrchestrator, PrerequisiteError } from "./services/rerunOrchestratorService.js";

const timeframeSchema = z.enum(["1m", "6m", "1y"]);

const analyzeSchema = z.object({
  sourceInput: z.string().min(1),
  timeframe: timeframeSchema
});

const exportSchema = z.object({
  channelId: z.string().regex(/^UC[\w-]{22}$/, "Invalid channelId"),
  channelName: z.string().min(1),
  sourceInput: z.string().min(1),
  timeframe: timeframeSchema,
  selectedVideoIds: z.array(z.string().min(1)).min(1)
});

const exportJobParamsSchema = z.object({
  jobId: z.string().uuid("Invalid jobId")
});

const rerunOrchestratorSchema = z.object({
  channelName: z.string().min(1)
});

const projectParamsSchema = z.object({
  projectId: z.string().min(1)
});

const projectVideoParamsSchema = z.object({
  projectId: z.string().min(1),
  videoId: z.string().min(1)
});

const projectVideoDetailQuerySchema = z.object({
  maxSegments: z.coerce.number().int().positive().max(2000).optional(),
  truncateChars: z.coerce.number().int().positive().max(10000).optional()
});

const projectBundleQuerySchema = z.object({
  export: z.string().min(1).optional()
});

const projectExportBundleParamsSchema = z.object({
  projectId: z.string().min(1),
  exportJobId: z.string().min(1)
});

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({
    ok: true
  }));

  app.post("/analyze", async (request, reply) => {
    const payload = analyzeSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({ error: payload.error.issues[0]?.message ?? "Invalid request body" });
    }

    const result = await analyzeChannel(payload.data.sourceInput, payload.data.timeframe);
    return reply.send(result);
  });

  app.post("/export", async (request, reply) => {
    const payload = exportSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({ error: payload.error.issues[0]?.message ?? "Invalid request body" });
    }

    const result = await exportSelectedVideos(payload.data);
    return reply.send(result);
  });

  app.post("/export/jobs", async (request, reply) => {
    const payload = exportSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({ error: payload.error.issues[0]?.message ?? "Invalid request body" });
    }

    const result = exportJobService.createJob(payload.data, { requestId: request.id });
    return reply.send(result);
  });

  app.get("/export/jobs/:jobId", async (request, reply) => {
    const params = exportJobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const job = exportJobService.getJob(params.data.jobId);
    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }

    return reply.send(job);
  });

  app.get("/export/jobs/:jobId/events", async (request, reply) => {
    const params = exportJobParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const jobId = params.data.jobId;
    const job = exportJobService.getJob(jobId);
    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders?.();

    const sendEvent = (event: ExportJobEvent) => {
      reply.raw.write(`event: ${event.event}\n`);
      reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
    };

    const unsubscribe = exportJobService.subscribe(jobId, (event) => {
      sendEvent(event);
      if (event.event === "job_done" || event.event === "job_failed") {
        closeStream();
      }
    });

    const history = exportJobService.getJobEvents(jobId);
    for (const event of history) {
      sendEvent(event);
    }
    const postSubscribeEvents = exportJobService.getJobEvents(jobId).slice(history.length);
    for (const event of postSubscribeEvents) {
      sendEvent(event);
    }

    const closeStream = () => {
      unsubscribe();
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    request.raw.on("close", () => {
      unsubscribe();
    });

    const latestJob = exportJobService.getJob(jobId);
    if (latestJob?.status === "done" || latestJob?.status === "failed") {
      closeStream();
    }
  });

  app.post("/export/rerun-orchestrator", async (request, reply) => {
    const payload = rerunOrchestratorSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({ error: payload.error.issues[0]?.message ?? "Invalid request body" });
    }

    try {
      const result = await rerunOrchestrator(payload.data);
      return reply.send(result);
    } catch (error) {
      if (error instanceof PrerequisiteError) {
        return reply.status(409).send({
          error: error.message,
          checks: error.checks.map((c) => ({
            artifact: c.artifact,
            exists: c.exists,
            detail: c.detail
          }))
        });
      }
      throw error;
    }
  });

  app.get("/projects", async (_, reply) => {
    const projects = await listProjects();
    return reply.send(projects);
  });

  app.get("/projects/:projectId", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const detail = await getProjectDetail(params.data.projectId);
    return reply.send(detail);
  });

  app.get("/projects/:projectId/videos", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const videos = await listProjectVideos(params.data.projectId);
    return reply.send(videos);
  });

  app.get("/projects/:projectId/videos/:videoId", async (request, reply) => {
    const params = projectVideoParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const query = projectVideoDetailQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.issues[0]?.message ?? "Invalid query params" });
    }

    const detail = await getProjectVideoDetail(params.data.projectId, params.data.videoId, query.data);
    return reply.send(detail);
  });

  app.get("/projects/:projectId/bundle/meta", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }
    const query = projectBundleQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.issues[0]?.message ?? "Invalid query params" });
    }

    const metadata = await getProjectBundleMeta({
      projectId: params.data.projectId,
      exportSelector: query.data.export
    });
    return reply.send(metadata);
  });

  app.get("/projects/:projectId/exports/:exportJobId/bundle", async (request, reply) => {
    const params = projectExportBundleParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const startedAt = Date.now();
    const prepared = await prepareProjectBundleDownload({
      projectId: params.data.projectId,
      explicitExportJobId: params.data.exportJobId
    });

    const stream = prepared.stream;
    let sizeBytes = 0;
    stream.on("data", (chunk: Buffer | string) => {
      sizeBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    });
    stream.on("end", () => {
      app.log.info({
        scope: "bundleExport",
        projectId: prepared.projectId,
        exportJobId: prepared.exportJobId,
        includedCount: prepared.estimate.includedFiles.length,
        missingCount: prepared.estimate.missingFiles.length,
        durationMs: Date.now() - startedAt,
        sizeBytes
      });
    });
    stream.on("error", (error) => {
      app.log.error({
        scope: "bundleExport",
        projectId: prepared.projectId,
        exportJobId: prepared.exportJobId,
        msg: "Bundle stream failed",
        error: error instanceof Error ? error.message : "unknown error"
      });
    });
    request.raw.on("close", () => {
      void prepared.cleanup();
    });

    reply.header("Content-Type", "application/zip");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename=\"${prepared.fileName}\"`);
    return reply.send(stream);
  });

  app.get("/projects/:projectId/bundle", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }
    const query = projectBundleQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: query.error.issues[0]?.message ?? "Invalid query params" });
    }

    const startedAt = Date.now();
    const prepared = await prepareProjectBundleDownload({
      projectId: params.data.projectId,
      exportSelector: query.data.export
    });

    const stream = prepared.stream;
    let sizeBytes = 0;
    stream.on("data", (chunk: Buffer | string) => {
      sizeBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    });
    stream.on("end", () => {
      app.log.info({
        scope: "bundleExport",
        projectId: prepared.projectId,
        exportJobId: prepared.exportJobId,
        includedCount: prepared.estimate.includedFiles.length,
        missingCount: prepared.estimate.missingFiles.length,
        durationMs: Date.now() - startedAt,
        sizeBytes
      });
    });
    stream.on("error", (error) => {
      app.log.error({
        scope: "bundleExport",
        projectId: prepared.projectId,
        exportJobId: prepared.exportJobId,
        msg: "Bundle stream failed",
        error: error instanceof Error ? error.message : "unknown error"
      });
    });
    request.raw.on("close", () => {
      void prepared.cleanup();
    });

    reply.header("Content-Type", "application/zip");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename=\"${prepared.fileName}\"`);
    return reply.send(stream);
  });

  app.get("/projects/:projectId/artifacts/playbook", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const artifact = await readProjectArtifact(params.data.projectId, "playbook");
    return reply.send(artifact);
  });

  app.get("/projects/:projectId/artifacts/templates", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const artifact = await readProjectArtifact(params.data.projectId, "templates");
    return reply.send(artifact);
  });

  app.get("/projects/:projectId/artifacts/channel_models", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const artifact = await readProjectArtifact(params.data.projectId, "channel_models");
    return reply.send(artifact);
  });

  app.get("/projects/:projectId/thumb/:videoId", async (request, reply) => {
    const params = projectVideoParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: params.error.issues[0]?.message ?? "Invalid params" });
    }

    const thumbnailPath = await resolveProjectThumbnail(params.data.projectId, params.data.videoId);
    reply.header("Cache-Control", "public, max-age=3600, immutable");
    reply.type("image/jpeg");
    return reply.send(createThumbnailStream(thumbnailPath));
  });

  app.setErrorHandler((error, _, reply) => {
    const normalizedError = error instanceof Error ? error : new Error("Unknown server error");
    requestScopedLog(app, normalizedError);

    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }

    reply.status(500).send({ error: normalizedError.message || "Internal server error" });
  });

  return app;
}

function requestScopedLog(app: ReturnType<typeof Fastify>, error: Error): void {
  app.log.error(error);
}

async function start() {
  const app = await buildServer();
  await app.listen({ port: env.port, host: "0.0.0.0" });
}

const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFilePath = path.resolve(fileURLToPath(import.meta.url));

if (executedFilePath && currentFilePath === executedFilePath) {
  start().catch((error: unknown) => {
    const normalizedError = error instanceof Error ? error : new Error("Failed to start API server");
    // eslint-disable-next-line no-console
    console.error(normalizedError);
    process.exit(1);
  });
}
