# AI Context Pack — ytai-analizer

Guía operativa para otras IAs. Enfocada en código real, contratos y runbook reproducible.

## 1) Scope rápido

- Monorepo `pnpm` con workspace `apps/*` (`pnpm-workspace.yaml`).
- Backend: Fastify + TypeScript (`apps/api`).
- Frontend: React + Vite + TypeScript (`apps/web`).
- Export principal: genera `exports/<canal>/channel.json` + artifacts `raw/`, `derived/`, `logs/`.

## 2) Comandos exactos

Desde raíz del repo:

```bash
pnpm install
pnpm dev
pnpm test
```

Setup/check de ASR local:

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

## 3) Entry points y archivos clave

Backend:

- `apps/api/src/server.ts`
- `apps/api/src/config/env.ts`
- `apps/api/src/services/exportService.ts`
- `apps/api/src/services/exportJobService.ts`
- `apps/api/src/services/transcriptPipeline.ts`
- `apps/api/src/services/localAsrService.ts`
- `apps/api/src/services/projectsService.ts`

Frontend:

- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/src/pages/AnalyzePage.tsx`
- `apps/web/src/pages/ProjectsList.tsx`
- `apps/web/src/pages/ProjectDetail.tsx`
- `apps/web/src/components/playbook/PlaybookView.tsx`
- `apps/web/src/components/templates/TemplatesView.tsx`
- `apps/web/src/components/model/ChannelModelView.tsx`
- `apps/web/src/components/Tooltip.tsx`
- `apps/web/src/lib/getByPath.ts`
- `apps/web/src/exportJobState.ts`
- `apps/web/src/types.ts`
- `apps/web/vite.config.ts`

ASR:

- `scripts/setup_asr.mjs`
- `scripts/setup_asr.sh`
- `scripts/setup_asr.ps1`
- `scripts/check_asr.mjs`
- `apps/api/scripts/asr_worker.py`
- `apps/api/scripts/requirements-asr.txt`

## 4) Entorno y dependencias

Fuente de verdad:

- `apps/api/.env.example`
- parser/defaults: `apps/api/src/config/env.ts`

Requeridas:

- `YOUTUBE_API_KEY` (sin esto falla `/analyze` y export).

Opcionales (núcleo):

- `PORT` (default `3001`)
- `TRANSCRIPT_LANG`
- `OPENAI_API_KEY` (habilita partes LLM/embeddings cuando `AUTO_GEN_ENABLED=true`)

Opcionales ASR:

- `LOCAL_ASR_ENABLED`
- `LOCAL_ASR_MODEL`
- `LOCAL_ASR_COMPUTE_TYPE`
- `LOCAL_ASR_LANGUAGE`
- `LOCAL_ASR_BEAM_SIZE`
- `LOCAL_ASR_MAX_CONCURRENCY`
- `LOCAL_ASR_TIMEOUT_SEC`
- `YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC`
- `ASR_PYTHON_PATH`

Opcionales de scheduler/export:

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

Requisitos runtime externos:

- Node.js `>=20`
- pnpm `10.x`
- Python `3.10+` para ASR local
- `ffmpeg` en `PATH`

## 5) Flujo del sistema

### 5.1 Analyze

1. UI en `apps/web/src/pages/AnalyzePage.tsx` llama `POST /api/analyze`.
2. API valida body en `apps/api/src/server.ts`.
3. Resolución de canal/videos en `apps/api/src/services/youtubeService.ts`.
4. Respuesta: `AnalyzeResult` (`apps/api/src/types.ts`).

### 5.2 Export async + progreso SSE

1. UI llama `POST /api/export/jobs`.
2. UI abre `EventSource('/api/export/jobs/:jobId/events')`.
3. Estado modal se reduce en `apps/web/src/exportJobState.ts`.
4. API crea y ejecuta job en `apps/api/src/services/exportJobService.ts`.
5. Trabajo real de export en `apps/api/src/services/exportService.ts`.

Eventos SSE soportados:

- `job_started`
- `video_progress`
- `job_progress`
- `warning`
- `job_done`
- `job_failed`

Stages de video:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

### 5.3 Transcript pipeline

Orquestador: `apps/api/src/services/transcriptPipeline.ts`

Orden:

1. intenta captions (`apps/api/src/services/transcriptService.ts`)
2. fallback ASR local si aplica (`apps/api/src/services/localAsrService.ts`)
3. si falla todo, export sigue; transcript queda vacío con warning

Worker ASR:

- proceso Python persistente (`apps/api/scripts/asr_worker.py`)
- eventos internos: `downloading_audio`, `transcribing`
- usa `yt-dlp` + `faster-whisper`

## 6) Formato de export (versión + schema)

- Versión actual en runtime: `EXPORT_VERSION = "1.1"` (`apps/api/src/services/exportService.ts`).
- Archivo principal: `exports/<canal>/channel.json`.
- Manifest: `exports/<canal>/manifest.json`.
- Contratos completos: ver `docs/DATA_CONTRACTS.md`.

## 7) Notas Windows

- Python del venv local: `.venv-asr\\Scripts\\python.exe`.
- Activación manual: `.\\.venv-asr\\Scripts\\Activate.ps1`.
- Si usas override: setear `ASR_PYTHON_PATH=C:\\ruta\\ytai-analizer\\.venv-asr\\Scripts\\python.exe`.
- `ffmpeg.exe` debe estar en `PATH`.

## 8) Troubleshooting operativo

- `Missing YOUTUBE_API_KEY`: revisar `apps/api/.env`.
- `ffmpeg not found`: instalar ffmpeg y validar `ffmpeg --version`.
- `faster_whisper import failed`: correr `pnpm asr:setup` y `pnpm asr:check`.
- SSE se corta en dev:
  - verificar API en `http://localhost:3001/health`
  - verificar proxy en `apps/web/vite.config.ts`

## 9) Dónde ampliar contexto

- Contratos HTTP/SSE y schemas de archivos: `docs/DATA_CONTRACTS.md`
- Mapa de módulos y responsabilidades: `docs/REPO_MAP.md`
- evitar recomputar trabajo pesado por video (captions/ASR, OCR, embeddings, AutoGen)
- soportar reuse parcial por subset de videos

## 10) Dashboard semántico de Projects

- `ProjectDetail` ya no depende de JSON dump por defecto para artifacts de canal.
- Render semántico por tabs:
  - `Overview`: KPIs, warnings y top videos.
  - `Playbook`: insights/rules/keys/evidence con hints.
  - `Templates`: title/thumbnail/script templates con hints.
  - `Model`: baseline + coeficientes + fit del modelo de canal.
  - `Jobs`: historial de jobs.
- Los artifacts (`playbook`, `templates`, `channel_models`) se cargan lazy al abrir cada tab.
- Hay fallback `Raw JSON` colapsable en modo debug (`import.meta.env.DEV`) para compatibilidad futura de schema.
- `evidence_fields` soporta drill-down auditable:
  - click en campo de evidencia -> panel lateral
  - resolución de path con `getByPath`
  - valores por `videoId` usando `/projects/:projectId/videos/:videoId` cacheado en frontend

Reglas operativas:

- cache key por `channelId + exportVersion + timeframe + videoId`
- fingerprints de input/config por video:
  - hashes de `title`, `description`, `transcript`, `thumbnail`
  - `transcriptSource`
  - `asrConfigHash` (`model/computeType/language/beam`)
  - `ocrConfigHash` (`langs/downscaleWidth`)
  - modelos (`embeddingModel`, `llmModels`)
- si falta `OPENAI_API_KEY` o `AUTO_GEN_ENABLED=false`, no invalida LLM cacheado
- si antes `llm=null` y ahora hay API key, hace upgrade solo de subcampos LLM faltantes
- seguridad de paths:
  - paths relativos solamente en cache index
  - validación de root con `ensureInsideRoot(...)`
  - escritura atómica para `index.json`

## 6) Archivos generados y side effects

Export (`apps/api/src/services/exportService.ts`) escribe en:

- `exports/<channel_sanitizado>/channel.json`
- `exports/<channel_sanitizado>/logs/job_<jobId>.events.jsonl`
- `exports/<channel_sanitizado>/logs/job_<jobId>.errors.jsonl`
- `exports/<channel_sanitizado>/logs/job_<jobId>.summary.json`
- `exports/<channel_sanitizado>/logs/job_<jobId>.debug_bundle.json` (solo si `job_failed`)
- `exports/<channel_sanitizado>/thumbnails/<videoId>.jpg`
- `exports/<channel_sanitizado>/raw/channel.json`
- `exports/<channel_sanitizado>/raw/videos.jsonl`
- `exports/<channel_sanitizado>/raw/transcripts/<videoId>.jsonl`
- `exports/<channel_sanitizado>/analysis/orchestrator_input.json`
- `exports/<channel_sanitizado>/analysis/playbook.json`
- `exports/<channel_sanitizado>/derived/video_features/<videoId>.json`
- `exports/<channel_sanitizado>/derived/channel_models.json`
- `exports/<channel_sanitizado>/derived/templates.json`
- `exports/<channel_sanitizado>/.cache/index.json`

Temporal de ASR:

- `exports/.tmp/<jobId>/audio/*.mp3`
- se limpia al final (`fs.rm(..., { recursive: true, force: true })`)

Protección de path traversal:

- `ensureInsideRoot(...)` en `exportService.ts` para garantizar escritura bajo `exports/`.
- logs JSONL redaccionan secretos; no incluyen API keys ni prompts completos.

## 7) Formato de export (resumen)

Contrato detallado: ver `docs/DATA_CONTRACTS.md`.

Resumen rápido:

- archivo final: `channel.json`
- estructura base: canal + `videos[]`
- por video incluye `transcript` (string, nunca `null`)
- `transcriptStatus` puede venir como `ok|missing|error`

Versionado:

- el runtime escribe `exportVersion: "1.1"` en `channel.json`, `manifest.json` y `raw/channel.json`.
- contratos deben tratar `exportVersion` como campo fuente de compatibilidad forward/backward.
- el cache persistente también versiona por `exportVersion` para invalidación segura.

Recomputación cruzada (siempre fresh por corrida):

- `performanceNormalization` por conjunto exportado (afecta `performance.*` y `derived/channel_models.json`)
- `orchestratorDeterministic` y `orchestratorService` (`analysis/orchestrator_input.json`, `analysis/playbook.json`, `derived/templates.json`)

Regla de barrera cross-video:

- `performanceNormalization` + `orchestrator*` arrancan solo cuando termina el subset completo de videos del job.

## 8) Frontend: estado y modal de progreso

Puntos clave:

- Reducer central: `apps/web/src/exportJobState.ts`
- Estados modal: `idle | starting | running | done | failed`
- Render de modal/progreso/warnings: `apps/web/src/App.tsx`
- Pruebas reducer: `apps/web/src/exportJobState.test.ts`

Comportamiento:

- al iniciar export, inicializa todos los videos en `queue`
- cada evento SSE muta estado incremental
- al evento terminal (`job_done`/`job_failed`) cierra stream y libera estado global de export

## 8.1 Projects Dashboard (nuevo)

Objetivo:

- agregar exploración de exports históricos sin tocar el flujo de analyze/export actual.
- navegación principal:
  - `/` -> `Analyze`
  - `/projects` -> lista de proyectos
  - `/projects/:projectId` -> detalle de proyecto

Frontend (`apps/web`):

- router con `react-router-dom` en `src/main.tsx` + `src/App.tsx`.
- páginas:
  - `src/pages/AnalyzePage.tsx` (misma lógica SSE/reducer, UI Tailwind)
  - `src/pages/ProjectsList.tsx`
  - `src/pages/ProjectDetail.tsx`
- Tailwind configurado en:
  - `tailwind.config.cjs`
  - `postcss.config.cjs`
  - `src/index.css` (`@tailwind base/components/utilities`)

Backend (`apps/api`):

- servicio read-only: `src/services/projectsService.ts`
- endpoints:
  - `GET /projects`
  - `GET /projects/:projectId`
  - `GET /projects/:projectId/videos`
  - `GET /projects/:projectId/videos/:videoId`
  - `GET /projects/:projectId/artifacts/playbook`
  - `GET /projects/:projectId/artifacts/templates`
  - `GET /projects/:projectId/artifacts/channel_models`
  - `GET /projects/:projectId/thumb/:videoId`

Seguridad:

- `projectId` y `videoId` se validan como segmentos simples (sin `..`, `/`, `\\`, paths absolutos).
- validación `ensureInsideRoot(...)` sobre root `exports/`.
- endpoints nuevos son solo lectura.

## 9) Runbook rápido para contribuir

1. Instalar deps JS:
   - `pnpm install`
2. Configurar API key:
   - copiar `apps/api/.env.example` a `apps/api/.env`
3. (Opcional recomendado) preparar ASR:
   - `pnpm asr:setup`
   - `pnpm asr:check`
4. Levantar stack:
   - `pnpm dev`
5. Validar cambios:
   - `pnpm test`

## 10) Troubleshooting operativo

### Error: `Missing YOUTUBE_API_KEY`

- Revisar `apps/api/.env` y que `YOUTUBE_API_KEY` exista.

### Error ASR import (`faster_whisper`)

- Ejecutar `pnpm asr:setup` y `pnpm asr:check`.
- Si no quieres ASR, setear `LOCAL_ASR_ENABLED=false`.

### `ffmpeg not found in PATH`

- Instalar `ffmpeg` y asegurar PATH en terminal donde corre API/worker.

### SSE se corta en UI

- Revisar proxy en `apps/web/vite.config.ts`.
- Verificar que API esté viva en `http://localhost:3001/health`.

## 11) Notas Windows

`venv` y Python:

- venv recomendado: `.venv-asr\Scripts\python.exe`
- setup automático: `pnpm asr:setup`
- setup manual PowerShell:

```powershell
python -m venv .venv-asr
.\.venv-asr\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r apps/api/scripts/requirements-asr.txt
```

`ASR_PYTHON_PATH` ejemplo Windows:

```powershell
$env:ASR_PYTHON_PATH = "C:\\ruta\\a\\ytai-analizer\\.venv-asr\\Scripts\\python.exe"
```

`ffmpeg`:

- instalar y dejar `ffmpeg.exe` en PATH del sistema/usuario.

## 12) Dónde está el detalle extendido

- Contratos HTTP/SSE + schema export: `docs/DATA_CONTRACTS.md`
- Mapa del repo y ownership técnico: `docs/REPO_MAP.md`
