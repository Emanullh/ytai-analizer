# REPO MAP — ytai-analizer

Mapa operativo de archivos, entry points y ownership técnico.

## 1) Root

- `AGENTS.md`: reglas de trabajo para agentes.
- `README.md`: setup funcional del repo.
- `package.json`: scripts root (`dev`, `build`, `test`, `asr:setup`, `asr:check`).
- `pnpm-workspace.yaml`: workspace `apps/*`.
- `scripts/`: bootstrap/check cross-platform para ASR.
- `docs/`: Context Pack y documentación técnica.

## 2) apps/api

## 2.1 Arranque y routing

- `apps/api/src/server.ts`: Fastify app + rutas HTTP/SSE + validación zod.
- `apps/api/src/config/env.ts`: carga `.env` y defaults.

Rutas definidas en `server.ts`:

- `GET /health`
- `POST /analyze`
- `POST /export`
- `POST /export/jobs`
- `GET /export/jobs/:jobId`
- `GET /export/jobs/:jobId/events`
- `GET /projects`
- `GET /projects/:projectId`
- `GET /projects/:projectId/videos`
- `GET /projects/:projectId/videos/:videoId`
- `GET /projects/:projectId/artifacts/playbook`
- `GET /projects/:projectId/artifacts/templates`
- `GET /projects/:projectId/artifacts/channel_models`
- `GET /projects/:projectId/thumb/:videoId`

## 2.2 Servicios principales

- `apps/api/src/services/youtubeService.ts`:
  - resolución de canal desde `sourceInput`
  - listado de videos y enriquecimiento metadata

- `apps/api/src/services/exportJobService.ts`:
  - crea/gestiona jobs async
  - mantiene estado y eventos para SSE

- `apps/api/src/services/exportService.ts`:
  - pipeline completo de export
  - escribe `channel.json`, `manifest.json`, `raw/*`, `derived/*`, `logs/*`
  - limpieza temporal en `exports/.tmp/<jobId>`

- `apps/api/src/services/transcriptService.ts`:
  - captions por `youtube-transcript`
  - timeout/retry/cache en memoria

- `apps/api/src/services/transcriptPipeline.ts`:
  - captions-first + fallback ASR

- `apps/api/src/services/localAsrService.ts`:
  - cliente del worker Python
  - cola, timeouts, restart

- `apps/api/src/services/asrRuntime.ts`:
  - resolución de python (`ASR_PYTHON_PATH` / `.venv-asr` / fallback)
  - health-check `import faster_whisper`

- `apps/api/src/services/projectsService.ts`:
  - lectura de `exports/*` para dashboard de proyectos

- `apps/api/src/services/exportCacheService.ts`:
  - cache persistente por video en `.cache/index.json`

- `apps/api/src/services/taskScheduler.ts`:
  - límites de concurrencia por tipo (`video/http/asr/ocr/llm/embeddings/fs`)

## 2.3 Lógica derivada y orquestación

- `apps/api/src/derived/*.ts`: features por título/description/transcript/thumbnail.
- `apps/api/src/analysis/orchestratorService.ts`: artifacts de orquestación de canal.
- `apps/api/src/services/autogenRuntime.ts`: bridge Node <-> worker AutoGen.

Assets:

- `apps/api/src/derived/assets/transcript-stopwords.json`
- `apps/api/src/derived/assets/transcript-sentiment-lexicon.json`
- `apps/api/src/derived/assets/transcript-emotions.json`

## 2.4 Scripts Python en API

- `apps/api/scripts/asr_worker.py`
- `apps/api/scripts/autogen_worker.py`
- `apps/api/scripts/requirements-asr.txt`
- `apps/api/scripts/requirements-autogen.txt`

## 2.5 Tests API

- `apps/api/tests/exportJobs.test.ts`
- `apps/api/tests/transcriptPipeline.test.ts`
- `apps/api/tests/transcriptService.test.ts`
- `apps/api/tests/asrRuntime.test.ts`
- `apps/api/tests/projectsApi.test.ts`

## 3) apps/web

## 3.1 Entry points

- `apps/web/src/main.tsx`: bootstrap React + router.
- `apps/web/src/App.tsx`: layout + rutas.

Rutas frontend:

- `/` -> `apps/web/src/pages/AnalyzePage.tsx`
- `/projects` -> `apps/web/src/pages/ProjectsList.tsx`
- `/projects/:projectId` -> `apps/web/src/pages/ProjectDetail.tsx`

## 3.2 Estado cliente export

- `apps/web/src/exportJobState.ts`: reducer del modal de progreso.
- `apps/web/src/types.ts`: contratos compartidos de API/SSE.

## 3.3 Infra web

- `apps/web/vite.config.ts`: proxy `/api` hacia `http://localhost:3001`.
- `apps/web/src/index.css`: estilos base.

## 3.4 Tests web

- `apps/web/src/exportJobState.test.ts`
- `apps/web/src/pages/projectsPages.test.tsx`

## 4) scripts (root)

- `scripts/setup_asr.mjs`: dispatcher Bash/PowerShell.
- `scripts/setup_asr.sh`: setup Unix de `.venv-asr` + pip install requirements.
- `scripts/setup_asr.ps1`: setup Windows equivalente.
- `scripts/check_asr.mjs`: chequeo de imports Python (`faster_whisper`, `autogen_agentchat`, `autogen_ext`).

## 5) Export output map

Root generado:

- `exports/<channelFolder>/`

Archivos esperados:

- `channel.json`
- `manifest.json`
- `raw/channel.json`
- `raw/videos.jsonl`
- `raw/transcripts/<videoId>.jsonl`
- `raw/thumbnails/` (symlink o copia de `thumbnails/`)
- `thumbnails/<videoId>.jpg`
- `derived/video_features/<videoId>.json`
- `derived/channel_models.json`
- `derived/templates.json` (si existe)
- `analysis/playbook.json` (si existe)
- `.cache/index.json`
- `logs/job_<jobId>.events.jsonl`
- `logs/job_<jobId>.errors.jsonl`
- `logs/job_<jobId>.summary.json`
- `logs/job_<jobId>.debug_bundle.json` (opcional)

## 6) Puntos de cambio típicos

Si cambias contratos de API/SSE:

- `apps/api/src/server.ts`
- `apps/api/src/services/exportJobService.ts`
- `apps/web/src/types.ts`
- `apps/web/src/exportJobState.ts`

Si cambias schema de export:

- `apps/api/src/types.ts`
- `apps/api/src/services/exportService.ts`
- `apps/api/src/services/projectsService.ts`
- `docs/DATA_CONTRACTS.md`

Si cambias ASR local:

- `apps/api/scripts/asr_worker.py`
- `apps/api/src/services/localAsrService.ts`
- `apps/api/src/services/asrRuntime.ts`
- `scripts/setup_asr.mjs`
- `scripts/setup_asr.sh`
- `scripts/setup_asr.ps1`
- `scripts/check_asr.mjs`
