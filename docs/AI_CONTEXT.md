# AI Context Pack — ytai-analizer

Contexto operativo para otras IAs. Basado en código actual del repo.

## 1) Snapshot rápido

- Monorepo `pnpm` con workspace `apps/*` (`pnpm-workspace.yaml`).
- API: Fastify + TypeScript (`apps/api`).
- Web: React + Vite + TypeScript (`apps/web`).
- Export principal: escribe artifacts bajo `exports/<channelFolder>/`.

## 2) Comandos exactos

Desde la raíz:

```bash
pnpm install
pnpm dev
pnpm test
```

ASR local (worker Python):

```bash
pnpm asr:setup
pnpm asr:check
```

Comandos por app:

```bash
pnpm -C apps/api dev
pnpm -C apps/web dev
pnpm -C apps/api test
pnpm -C apps/web test
```

## 3) Entry points reales

Backend:

- `apps/api/src/server.ts` (rutas HTTP + SSE)
- `apps/api/src/config/env.ts` (env parser + defaults)
- `apps/api/src/services/exportService.ts` (pipeline export)
- `apps/api/src/services/exportJobService.ts` (jobs async + eventos)
- `apps/api/src/services/transcriptPipeline.ts` (captions -> ASR fallback)
- `apps/api/src/services/localAsrService.ts` (cliente worker Python)
- `apps/api/src/services/asrRuntime.ts` (resolución de Python + health check)
- `apps/api/src/services/projectsService.ts` (dashboard sobre `exports/*`)
- `apps/api/src/services/exportBundleService.ts` (bundle zip cross-channel)
- `apps/api/src/services/rerunOrchestratorService.ts` (re-run manual)

Frontend:

- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/pages/AnalyzePage.tsx`
- `apps/web/src/exportJobState.ts`
- `apps/web/src/pages/ProjectsList.tsx`
- `apps/web/src/pages/ProjectDetail.tsx`
- `apps/web/src/types.ts`
- `apps/web/vite.config.ts` (proxy `/api` -> `http://localhost:3001`)

ASR/scripts:

- `scripts/setup_asr.mjs`
- `scripts/setup_asr.sh`
- `scripts/setup_asr.ps1`
- `scripts/check_asr.mjs`
- `apps/api/scripts/asr_worker.py`
- `apps/api/scripts/requirements-asr.txt`

## 4) Variables de entorno

Fuente base: `apps/api/.env.example`.

Requerida:

- `YOUTUBE_API_KEY`

Opcionales de API:

- `PORT` (default `3001`)
- `TRANSCRIPT_LANG`
- `OPENAI_API_KEY`

Opcionales ASR local:

- `LOCAL_ASR_ENABLED`
- `LOCAL_ASR_MODEL`
- `LOCAL_ASR_COMPUTE_TYPE`
- `LOCAL_ASR_LANGUAGE`
- `LOCAL_ASR_BEAM_SIZE`
- `LOCAL_ASR_MAX_CONCURRENCY`
- `LOCAL_ASR_TIMEOUT_SEC`
- `YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC`
- `ASR_PYTHON_PATH`

Opcionales de concurrencia/export:

- `EXPORT_VIDEO_CONCURRENCY`
- `EXPORT_HTTP_CONCURRENCY`
- `EXPORT_ASR_CONCURRENCY`
- `EXPORT_OCR_CONCURRENCY`
- `EXPORT_LLM_CONCURRENCY`
- `EXPORT_EMBEDDINGS_CONCURRENCY`
- `EXPORT_FS_CONCURRENCY`
- `EXPORT_FAIL_FAST`

Opcionales AutoGen/OCR:

- `AUTO_GEN_ENABLED`
- `AUTO_GEN_MODEL_TITLE`
- `AUTO_GEN_MODEL_DESCRIPTION`
- `AUTO_GEN_MODEL_THUMBNAIL`
- `AUTO_GEN_MODEL_ORCHESTRATOR`
- `AUTO_GEN_REASONING_EFFORT`
- `AUTO_GEN_REASONING_EFFORT_ORCHESTRATOR`
- `AUTO_GEN_TIMEOUT_SEC`
- `AUTO_GEN_TIMEOUT_ORCHESTRATOR_SEC`
- `THUMB_OCR_ENABLED`
- `THUMB_OCR_LANGS`
- `THUMB_VISION_DOWNSCALE_WIDTH`

Dependencias externas:

- Node `>=20`
- pnpm `10.x`
- Python `3.10+`
- `ffmpeg` en PATH

## 5) Flujos clave

### 5.1 Analyze

1. UI (`AnalyzePage`) llama `POST /api/analyze`.
2. API valida body (`server.ts`) y ejecuta `analyzeChannel(...)`.
3. Devuelve `AnalyzeResult` (ver `apps/api/src/types.ts`).

### 5.2 Export async + SSE + modal de progreso

1. UI llama `POST /api/export/jobs`.
2. Recibe `{ jobId }` y abre `EventSource('/api/export/jobs/:jobId/events')`.
3. Reducer `apps/web/src/exportJobState.ts` procesa eventos.
4. `ExportJobService` emite estado/eventos y ejecuta `exportSelectedVideos(...)`.
5. `exportService.ts` escribe artifacts en `exports/<channelFolder>/`.

Eventos SSE usados por web:

- `job_started`
- `video_progress`
- `job_progress`
- `warning`
- `job_done`
- `job_failed`

Estados/stages por video en modal:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

### 5.3 Pipeline transcript (captions + ASR)

1. `transcriptPipeline.ts` intenta captions (`transcriptService.ts`).
2. Si falta transcript y `LOCAL_ASR_ENABLED=true`, usa `localAsrService.ts`.
3. Worker Python (`asr_worker.py`) usa `yt-dlp` + `faster-whisper`.
4. Si todo falla, export continúa con warning (no tumba todo el job).

### 5.4 Projects + bundle + rerun orchestrator

- Projects list/detail salen de `projectsService.ts`, leyendo `exports/*`.
- Bundle zip se arma en `exportBundleService.ts` (`/projects/:projectId/bundle*`).
- Rerun manual: `POST /export/rerun-orchestrator` (requiere artifacts previos).

## 6) Export format y schema

Fuente: `apps/api/src/services/exportService.ts`.

- `EXPORT_VERSION = "1.1"`.
- `channel.json` usa `ExportPayload` (`apps/api/src/types.ts`).
- `manifest.json` usa estructura interna `ExportManifestV1`.
- `raw/transcripts/<videoId>.jsonl` mezcla:
  - línea meta `type: "meta"`
  - líneas de segmento `type: "segment"`
- `derived/video_features/<videoId>.json` incluye `schemaVersion: "derived.video_features.v1"`.
- `derived/channel_models.json` incluye `schemaVersion: "derived.channel_models.v1"`.

Bundle cross-channel (`apps/api/src/services/exportBundleService.ts`):

- `bundle.json` con `schemaVersion: "analysis.cross_channel_bundle.v1"`.
- Incluye `analysis/orchestrator_input.json` como requerido.
- `raw/videos.jsonl` puede reemplazarse por `raw/videos.extract.jsonl` si supera umbral.

## 7) Notas Windows

- Venv Python esperado: `.venv-asr\Scripts\python.exe`.
- Activación manual: `.\.venv-asr\Scripts\Activate.ps1`.
- Override opcional: `ASR_PYTHON_PATH=C:\...\ytai-analizer\.venv-asr\Scripts\python.exe`.
- `ffmpeg.exe` debe estar en `PATH`.

## 8) Troubleshooting corto

- `/analyze` falla por API key: revisar `YOUTUBE_API_KEY` en `apps/api/.env`.
- ASR falla por imports: correr `pnpm asr:setup` y `pnpm asr:check`.
- `ffmpeg not found`: instalar ffmpeg y validar `ffmpeg --version`.
- UI sin progreso SSE: verificar API (`http://localhost:3001/health`) y proxy (`apps/web/vite.config.ts`).
- `rerun-orchestrator` con `409`: faltan artifacts previos (`channel.json`, `raw/videos.jsonl`, `derived/video_features/*.json`).

## 9) Dónde profundizar

- Contratos HTTP/SSE + schemas: `docs/DATA_CONTRACTS.md`
- Mapa de módulos y responsabilidades: `docs/REPO_MAP.md`
