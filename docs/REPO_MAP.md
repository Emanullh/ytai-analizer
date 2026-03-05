# REPO MAP — ytai-analizer

Mapa práctico de módulos, ownership técnico y puntos de cambio.

## 1) Root

- `AGENTS.md`: reglas de colaboración para agentes.
- `README.md`: setup y flujo operativo.
- `package.json`: scripts root (`dev`, `build`, `test`, `asr:setup`, `asr:check`).
- `pnpm-workspace.yaml`: workspace `apps/*`.
- `scripts/`: bootstrap/check ASR cross-platform.
- `docs/`: Context Pack (`AI_CONTEXT`, `DATA_CONTRACTS`, `REPO_MAP`).

## 2) apps/api

## 2.1 Arranque y rutas

- `apps/api/src/server.ts`: registra endpoints y valida request params/body con zod.
- `apps/api/src/config/env.ts`: parseo de env + defaults.

Rutas actuales en `server.ts`:

- `GET /health`
- `POST /analyze`
- `POST /export`
- `POST /export/jobs`
- `GET /export/jobs/:jobId`
- `GET /export/jobs/:jobId/events` (SSE)
- `POST /export/rerun-orchestrator`
- `GET /projects`
- `GET /projects/:projectId`
- `GET /projects/:projectId/videos`
- `GET /projects/:projectId/videos/:videoId`
- `GET /projects/:projectId/bundle/meta`
- `GET /projects/:projectId/bundle`
- `GET /projects/:projectId/exports/:exportJobId/bundle`
- `GET /projects/:projectId/artifacts/playbook`
- `GET /projects/:projectId/artifacts/templates`
- `GET /projects/:projectId/artifacts/channel_models`
- `GET /projects/:projectId/thumb/:videoId`

## 2.2 Servicios de dominio

- `apps/api/src/services/youtubeService.ts`: resolución de canal y fetch metadata de videos.
- `apps/api/src/services/transcriptService.ts`: captions (`youtube-transcript`).
- `apps/api/src/services/transcriptPipeline.ts`: fallback policy captions -> ASR.
- `apps/api/src/services/localAsrService.ts`: cola de tareas y lifecycle del worker ASR.
- `apps/api/src/services/asrRuntime.ts`: resuelve Python (`ASR_PYTHON_PATH`, `.venv-asr`, fallback).
- `apps/api/src/services/exportService.ts`: pipeline central de export, escritura de artifacts y manifest.
- `apps/api/src/services/exportJobService.ts`: jobs async + buffer de eventos SSE + estado.
- `apps/api/src/services/exportBundleService.ts`: meta + zip bundle para cross-channel.
- `apps/api/src/services/projectsService.ts`: lectura de exports para dashboard y detalles de video.
- `apps/api/src/services/rerunOrchestratorService.ts`: rerun manual con prerequisitos.
- `apps/api/src/services/exportCacheService.ts`: cache persistente por video en `.cache/index.json`.
- `apps/api/src/services/taskScheduler.ts`: límites de concurrencia por tipo de tarea.

## 2.3 Lógica derivada/orquestación

- `apps/api/src/derived/*.ts`: title/description/transcript/thumbnail features.
- `apps/api/src/analysis/orchestratorService.ts`: genera artifacts de orquestación (`analysis/*`).
- `apps/api/src/services/autogenRuntime.ts`: bridge de runtime para worker AutoGen.

Assets:

- `apps/api/src/derived/assets/transcript-stopwords.json`
- `apps/api/src/derived/assets/transcript-sentiment-lexicon.json`
- `apps/api/src/derived/assets/transcript-emotions.json`

## 2.4 Scripts Python del API

- `apps/api/scripts/asr_worker.py`
- `apps/api/scripts/autogen_worker.py`
- `apps/api/scripts/requirements-asr.txt`
- `apps/api/scripts/requirements-autogen.txt`

## 2.5 Tests API

- `apps/api/tests/exportJobs.test.ts`
- `apps/api/tests/exportBundleService.test.ts`
- `apps/api/tests/projectsApi.test.ts`
- `apps/api/tests/transcriptPipeline.test.ts`
- `apps/api/tests/asrRuntime.test.ts`
- `apps/api/tests/taskScheduler.test.ts`

## 3) apps/web

## 3.1 Entry points y rutas

- `apps/web/src/main.tsx`: bootstrap React + `BrowserRouter`.
- `apps/web/src/App.tsx`: layout principal y rutas.

Rutas frontend:

- `/` -> `apps/web/src/pages/AnalyzePage.tsx`
- `/projects` -> `apps/web/src/pages/ProjectsList.tsx`
- `/projects/:projectId` -> `apps/web/src/pages/ProjectDetail.tsx`

## 3.2 Flujo Analyze/export

- `apps/web/src/pages/AnalyzePage.tsx`: submit de analyze, selección de videos, creación de export job, `EventSource` SSE y modal de progreso.
- `apps/web/src/exportJobState.ts`: reducer de estados del modal (`starting`, `running`, `done`, `failed`).
- `apps/web/src/types.ts`: tipos de API/SSE usados por UI.

## 3.3 Flujo Projects

- `apps/web/src/pages/ProjectsList.tsx`: lista proyectos + botón `Export bundle`.
- `apps/web/src/pages/ProjectDetail.tsx`: tabs de artifacts, lista videos, detalle por video, rerun orchestrator.
- `apps/web/src/components/playbook/PlaybookView.tsx`
- `apps/web/src/components/templates/TemplatesView.tsx`
- `apps/web/src/components/model/ChannelModelView.tsx`
- `apps/web/src/lib/getByPath.ts`
- `apps/web/src/lib/artifactUtils.ts`

Infra web:

- `apps/web/vite.config.ts`: proxy `/api` a API local.
- `apps/web/src/index.css`: estilos base.

## 3.4 Tests web

- `apps/web/src/exportJobState.test.ts`
- `apps/web/src/pages/projectsPages.test.tsx`
- `apps/web/src/lib/getByPath.test.ts`
- `apps/web/src/components/Tooltip.test.tsx`
- `apps/web/src/components/playbook/PlaybookView.test.tsx`
- `apps/web/src/components/model/ChannelModelView.test.tsx`

## 4) scripts (root)

- `scripts/setup_asr.mjs`: dispatcher (bash/powershell según OS).
- `scripts/setup_asr.sh`: crea/reusa `.venv-asr` e instala requirements.
- `scripts/setup_asr.ps1`: equivalente para Windows.
- `scripts/check_asr.mjs`: valida imports Python (`faster_whisper`, `autogen_agentchat`, `autogen_ext`).

## 5) Exported filesystem map

Raíz de salida:

- `exports/<channelFolder>/`

Artifacts principales generados por `exportService.ts`:

- `channel.json`
- `manifest.json`
- `raw/channel.json`
- `raw/videos.jsonl`
- `raw/transcripts/<videoId>.jsonl`
- `raw/thumbnails/` (symlink o copia de `thumbnails/`)
- `thumbnails/<videoId>.jpg`
- `derived/video_features/<videoId>.json`
- `derived/channel_models.json`
- `analysis/orchestrator_input.json` (si existe del pipeline/orchestrator)
- `analysis/playbook.json` (si existe)
- `derived/templates.json` (si existe)
- `.cache/index.json`
- `logs/job_<jobId>.events.jsonl`
- `logs/job_<jobId>.errors.jsonl`
- `logs/job_<jobId>.summary.json`
- `logs/job_<jobId>.debug_bundle.json` (opcional)

Temporales:

- `exports/.tmp/<jobId>/audio/*.mp3`

## 6) Dónde tocar según cambio

Si cambias API/SSE:

- `apps/api/src/server.ts`
- `apps/api/src/services/exportJobService.ts`
- `apps/web/src/types.ts`
- `apps/web/src/exportJobState.ts`

Si cambias schema export/filesystem:

- `apps/api/src/types.ts`
- `apps/api/src/services/exportService.ts`
- `apps/api/src/services/projectsService.ts`
- `apps/api/src/services/exportBundleService.ts`
- `docs/DATA_CONTRACTS.md`

Si cambias ASR local:

- `apps/api/scripts/asr_worker.py`
- `apps/api/src/services/localAsrService.ts`
- `apps/api/src/services/asrRuntime.ts`
- `scripts/setup_asr.*`
- `scripts/check_asr.mjs`
