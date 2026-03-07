# REPO MAP — ytai-analizer

Mapa práctico del repo. Prioriza puntos de entrada, ownership técnico y zonas de cambio.

## 1. Root

- `AGENTS.md`
  - reglas operativas del entorno multi-agent.
- `package.json`
  - scripts root:
    - `dev`
    - `build`
    - `test`
    - `python:setup`
    - `python:check`
    - aliases `asr:*` y `ocr:*`
- `pnpm-workspace.yaml`
  - workspace `apps/*`.
- `README.md`
  - setup para humanos; útil, pero no es la fuente de verdad para transcript/export.
- `scripts/`
  - bootstrap/check del venv Python compartido.
- `docs/`
  - este context pack.
- `.venv-asr/`
  - venv local reutilizado por ASR, OCR y AutoGen.

## 2. `apps/api`

## 2.1 Arranque y configuración

- `apps/api/src/server.ts`
  - registra todas las rutas Fastify.
  - valida request body/params/query con `zod`.
  - implementa SSE para export jobs, batch rerun de features y batch rerun de thumbnails.
- `apps/api/src/config/env.ts`
  - parsea defaults de API, ASR, OCR, AutoGen, bundle y concurrencia.
- `apps/api/package.json`
  - `dev`: `tsx watch src/server.ts`
  - `build`: `tsc -p tsconfig.build.json`
  - `start`: `node dist/server.js`
  - `test`: `vitest run`

## 2.2 Servicios core de dominio

- `apps/api/src/services/youtubeService.ts`
  - resolve channel input, lista videos, metadata enriquecida.
- `apps/api/src/services/exportService.ts`
  - pipeline central de export.
  - escribe `channel.json`, `manifest.json`, raw pack, derived artifacts y logs.
  - usa `process.cwd()` para resolver `exports/`.
- `apps/api/src/services/exportPlan.ts`
  - define el plan de ejecución por video.
- `apps/api/src/services/taskScheduler.ts`
  - límites por colas `http`, `asr`, `ocr`, `llm`, `embeddings`, `fs`.
- `apps/api/src/services/exportCacheService.ts`
  - `.cache/index.json`, hashes, cache hit/miss.
- `apps/api/src/services/projectOperationLockService.ts`
  - locks para evitar operaciones concurrentes incompatibles sobre un proyecto.

## 2.3 Transcript / ASR / OCR

- `apps/api/src/services/transcriptPipeline.ts`
  - pipeline transcript efectivo.
  - hoy funciona como ASR local con fallback a warning, no como captions-first.
- `apps/api/src/services/localAsrService.ts`
  - cola, lifecycle y retry del worker ASR.
- `apps/api/src/services/asrRuntime.ts`
  - resuelve `ASR_PYTHON_PATH`, `/.venv-asr`, luego `python3|python`.
- `apps/api/src/services/transcriptArtifactService.ts`
  - construye `raw/transcripts/<videoId>.jsonl`.
- `apps/api/src/services/transcriptService.ts`
  - código legado/compatibilidad para captions; ya no es la ruta dominante del export.
- `apps/api/src/services/localOcrService.ts`
  - runtime OCR local.
- `apps/api/src/services/ocrRuntime.ts`
  - resuelve `OCR_PYTHON_PATH` con fallback a `ASR_PYTHON_PATH` o `/.venv-asr`.

## 2.4 Projects, bundle y lectura de artifacts

- `apps/api/src/services/projectsService.ts`
  - lista proyectos desde `apps/api/exports/*`
  - resuelve artifacts y thumbnails
  - resume jobs y videos para el dashboard
- `apps/api/src/services/exportBundleService.ts`
  - construye el plan del bundle
  - genera `bundle.json`
  - decide entre `raw/videos.jsonl` y `raw/videos.extract.jsonl`
- `apps/api/src/services/projectManifestSyncService.ts`
  - sincroniza counts del manifest cuando se recalculan thumbnails/features

## 2.5 Reruns y operaciones manuales

- `apps/api/src/services/rerunOrchestratorService.ts`
  - prerequisitos + ejecución del orquestador manual.
- `apps/api/src/services/videoFeatureRerunService.ts`
  - rerun individual por `thumbnail|title|description|transcript`.
- `apps/api/src/services/rerunProjectFeaturesService.ts`
  - rerun batch por feature con estado y SSE.
- `apps/api/src/services/rerunThumbnailsService.ts`
  - rerun batch de thumbnails con estado y SSE.
- `apps/api/src/services/videoFeaturePreparationService.ts`
  - `collect_assets` y `prepare` para features.
- `apps/api/src/services/videoFeatureComputeService.ts`
  - cálculo final de artifacts por feature.

## 2.6 Lógica derivada / análisis

- `apps/api/src/derived/thumbnailFeaturesAgent.ts`
- `apps/api/src/derived/titleFeaturesAgent.ts`
- `apps/api/src/derived/descriptionFeaturesAgent.ts`
- `apps/api/src/derived/transcriptFeaturesAgent.ts`
- `apps/api/src/analysis/orchestratorService.ts`
  - genera:
    - `analysis/orchestrator_input.json`
    - `analysis/playbook.json`
    - `derived/templates.json`
- `apps/api/src/analysis/orchestratorDeterministic.ts`
  - input y fallback determinístico.

## 2.7 Observabilidad y utilidades

- `apps/api/src/observability/jobLogger.ts`
  - `logs/job_<jobId>.events.jsonl`
  - `logs/job_<jobId>.errors.jsonl`
  - `logs/job_<jobId>.summary.json`
  - `logs/job_<jobId>.debug_bundle.json`
- `apps/api/src/observability/errorClassifier.ts`
- `apps/api/src/utils/errors.ts`
- `apps/api/src/utils/http.ts`
- `apps/api/src/utils/sanitize.ts`
- `apps/api/src/utils/fileExists.ts`
- `apps/api/src/utils/timeframe.ts`

## 2.8 Python workers y requirements

- `apps/api/scripts/asr_worker.py`
  - descarga audio + `faster-whisper`.
- `apps/api/scripts/ocr_worker.py`
  - OCR local.
- `apps/api/scripts/autogen_worker.py`
  - ejecución LLM.
- `apps/api/scripts/requirements-asr.txt`
- `apps/api/scripts/requirements-ocr.txt`
- `apps/api/scripts/requirements-autogen.txt`

## 2.9 Tests API

Cobertura relevante:

- `apps/api/tests/exportJobs.test.ts`
- `apps/api/tests/exportBundleService.test.ts`
- `apps/api/tests/projectsApi.test.ts`
- `apps/api/tests/transcriptPipeline.test.ts`
- `apps/api/tests/asrRuntime.test.ts`
- `apps/api/tests/taskScheduler.test.ts`
- `apps/api/tests/orchestratorService.test.ts`
- `apps/api/tests/transcriptService.test.ts`

## 3. `apps/web`

## 3.1 Router y páginas

- `apps/web/src/main.tsx`
  - arranque React.
- `apps/web/src/App.tsx`
  - rutas:
    - `/`
    - `/projects`
    - `/projects/:projectId`
- `apps/web/src/pages/AnalyzePage.tsx`
  - analyze channel
  - selección de videos
  - `POST /api/export/jobs`
  - `EventSource('/api/export/jobs/:jobId/events')`
  - modal de progreso
- `apps/web/src/pages/ProjectsList.tsx`
  - `GET /api/projects`
  - `GET /api/projects/:projectId/bundle/meta`
  - `GET /api/projects/:projectId/bundle`
- `apps/web/src/pages/ProjectDetail.tsx`
  - `GET /api/projects/:projectId`
  - `GET /api/projects/:projectId/videos`
  - `GET /api/projects/:projectId/videos/:videoId`
  - `GET /api/projects/:projectId/artifacts/*`
  - `POST /api/export/rerun-orchestrator`
  - rerun individual por video
  - rerun batch por feature con SSE

## 3.2 Estado y tipos compartidos

- `apps/web/src/exportJobState.ts`
  - reducer del modal de export.
- `apps/web/src/types.ts`
  - tipos para analyze/export/projects.
- `apps/web/src/lib/getByPath.ts`
  - lectura segura de paths dentro de artifacts JSON.
- `apps/web/src/lib/artifactUtils.ts`
  - helpers de normalización para UI.

## 3.3 Componentes importantes

- `apps/web/src/components/project/VideoFeaturePanels.tsx`
  - inspección de feature data y rerun individual.
- `apps/web/src/components/playbook/PlaybookView.tsx`
  - render de `analysis/playbook.json`.
- `apps/web/src/components/templates/TemplatesView.tsx`
  - render de `derived/templates.json`.
- `apps/web/src/components/model/ChannelModelView.tsx`
  - render de `derived/channel_models.json`.
- `apps/web/src/components/charts/*`
  - gráficos del dashboard de proyecto.

## 3.4 Infra web

- `apps/web/vite.config.ts`
  - proxy `/api` a `http://localhost:3001`.
- `apps/web/src/index.css`
  - estilos base y utilidades compartidas.

## 3.5 Tests web

- `apps/web/src/exportJobState.test.ts`
- `apps/web/src/pages/projectsPages.test.tsx`
- `apps/web/src/lib/getByPath.test.ts`
- `apps/web/src/components/playbook/PlaybookView.test.tsx`
- `apps/web/src/components/model/ChannelModelView.test.tsx`

## 4. `scripts/` en root

- `scripts/setup_asr.mjs`
  - decide entre `bash` y `powershell`.
- `scripts/setup_asr.sh`
  - crea/reusa `/.venv-asr`
  - instala:
    - `apps/api/scripts/requirements-asr.txt`
    - `apps/api/scripts/requirements-autogen.txt`
    - `apps/api/scripts/requirements-ocr.txt`
- `scripts/setup_asr.ps1`
  - equivalente Windows.
- `scripts/check_asr.mjs`
  - valida imports:
    - `faster_whisper`
    - `autogen_agentchat`
    - `autogen_ext`
    - `cv2`
    - `paddleocr` o `easyocr`

## 5. Output filesystem map

Ubicación efectiva con los scripts del repo:

```text
apps/api/exports/<channelFolder>/
```

Estructura principal:

```text
apps/api/exports/<channelFolder>/
  channel.json
  manifest.json
  thumbnails/<videoId>.jpg
  raw/
    channel.json
    videos.jsonl
    audio/<videoId>.mp3
    transcripts/<videoId>.jsonl
    thumbnails/               # symlink o copia
  derived/
    channel_models.json
    templates.json            # sólo tras rerun orchestrator
    video_features/<videoId>.json
  analysis/
    orchestrator_input.json   # sólo tras rerun orchestrator
    playbook.json             # sólo tras rerun orchestrator
  .cache/
    index.json
  logs/
    job_<jobId>.events.jsonl
    job_<jobId>.errors.jsonl
    job_<jobId>.summary.json
    job_<jobId>.debug_bundle.json
```

Temporales del export:

```text
apps/api/exports/.tmp/<jobId>/
```

## 6. Qué tocar según el cambio

Si cambias API de analyze/export:

- `apps/api/src/server.ts`
- `apps/api/src/types.ts`
- `apps/web/src/types.ts`
- `apps/web/src/pages/AnalyzePage.tsx`
- `docs/DATA_CONTRACTS.md`

Si cambias progreso SSE:

- `apps/api/src/services/exportJobService.ts`
- `apps/web/src/exportJobState.ts`
- `apps/web/src/pages/AnalyzePage.tsx`
- `docs/DATA_CONTRACTS.md`

Si cambias transcript/ASR:

- `apps/api/src/services/transcriptPipeline.ts`
- `apps/api/src/services/localAsrService.ts`
- `apps/api/src/services/asrRuntime.ts`
- `apps/api/src/services/transcriptArtifactService.ts`
- `apps/api/scripts/asr_worker.py`
- `scripts/setup_asr.*`
- `scripts/check_asr.mjs`
- `docs/AI_CONTEXT.md`

Si cambias export schema o filesystem:

- `apps/api/src/services/exportService.ts`
- `apps/api/src/services/projectsService.ts`
- `apps/api/src/services/exportBundleService.ts`
- `apps/api/src/analysis/orchestratorService.ts`
- `docs/DATA_CONTRACTS.md`
- `docs/REPO_MAP.md`

Si cambias reruns:

- `apps/api/src/services/videoFeatureRerunService.ts`
- `apps/api/src/services/rerunProjectFeaturesService.ts`
- `apps/api/src/services/rerunThumbnailsService.ts`
- `apps/web/src/pages/ProjectDetail.tsx`
- `apps/web/src/components/project/VideoFeaturePanels.tsx`
- `docs/DATA_CONTRACTS.md`
