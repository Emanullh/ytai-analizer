# AI Context Pack — ytai-analizer

Este documento es una guía operativa para otras IAs que vayan a modificar el repo.  
Foco: arquitectura real, contratos y runbook reproducible.

## 1) Qué es este repo

Monorepo `pnpm` con 2 apps:

- `apps/api`: API Fastify + pipeline de transcript/captions/ASR local.
- `apps/web`: UI React/Vite para analizar canal y lanzar export asíncrono con progreso SSE.

Workspace:

- `pnpm-workspace.yaml`
- `package.json` (scripts raíz)

## 2) Comandos base (exactos)

Desde la raíz del repo:

```bash
pnpm install
pnpm dev
pnpm test
```

Comandos ASR local:

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

- `apps/api/src/server.ts`
- `apps/api/src/config/env.ts`

Frontend:

- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`
- `apps/web/vite.config.ts` (proxy `/api` -> `http://localhost:3001`)

Scripts ASR:

- `scripts/setup_asr.mjs`
- `scripts/setup_asr.sh`
- `scripts/setup_asr.ps1`
- `scripts/check_asr.mjs`
- `apps/api/scripts/asr_worker.py`
- `apps/api/scripts/requirements-asr.txt`
- `apps/api/scripts/autogen_worker.py`
- `apps/api/scripts/requirements-autogen.txt`

## 4) Variables de entorno

Fuente de verdad:

- `apps/api/.env.example`
- parsing/config: `apps/api/src/config/env.ts`

### Requerida

- `YOUTUBE_API_KEY`: obligatoria para llamadas YouTube Data API (`/analyze`, `/export`, `/export/jobs`).

### Opcionales API

- `PORT` (default `3001`)
- `TRANSCRIPT_LANG` (si se setea, intenta captions en ese idioma)

### Opcionales ASR local

- `LOCAL_ASR_ENABLED` (default `true`)
- `LOCAL_ASR_MODEL` (default `large-v3-turbo`)
- `LOCAL_ASR_COMPUTE_TYPE` (default `auto`)
- `LOCAL_ASR_LANGUAGE` (default `auto`)
- `LOCAL_ASR_BEAM_SIZE` (default `5`)
- `LOCAL_ASR_MAX_CONCURRENCY` (default `1`)
- `LOCAL_ASR_TIMEOUT_SEC` (default `900`)
- `YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC` (default `300`)
- `ASR_PYTHON_PATH` (override explícito del binario python del worker)

### Opcionales AutoGen / Title Features

- `OPENAI_API_KEY` (OpenAI API para embeddings y clasificación de título)
- `AUTO_GEN_ENABLED` (default `true`)
- `AUTO_GEN_MODEL_TITLE` (default `gpt-5.2`)
- `AUTO_GEN_REASONING_EFFORT` (default `low`)
- `AUTO_GEN_TIMEOUT_SEC` (default `60`)

Resolución de Python ASR (`apps/api/src/services/asrRuntime.ts`):

1. `ASR_PYTHON_PATH`
2. `./.venv-asr/bin/python` (Unix) o `./.venv-asr/Scripts/python.exe` (Windows)
3. fallback: `python3` (Unix) / `python` (Windows)

## 5) Flujos críticos

### 5.1 Analyze flow

UI (`apps/web/src/App.tsx`) hace `POST /api/analyze`.

API (`apps/api/src/server.ts`):

- valida body (`sourceInput`, `timeframe: 1m|6m|1y`)
- llama `analyzeChannel` (`apps/api/src/services/youtubeService.ts`)
- devuelve `AnalyzeResult` (canal, warnings, lista de videos)

Notas:

- Soporta input: `UC...`, `@handle`, `/user/...`, `/c/...`, URL de canal, o handle suelto.
- Usa fallback de resolución por HTML + búsqueda API si no resuelve directo.

### 5.2 Export flow asíncrono con SSE

UI (`apps/web/src/App.tsx`) hace:

1. `POST /api/export/jobs`
2. abre `EventSource('/api/export/jobs/:jobId/events')`
3. reduce estado en `apps/web/src/exportJobState.ts`

API (`apps/api/src/server.ts` + `apps/api/src/services/exportJobService.ts`):

1. crea job (`queued` -> `running`)
2. ejecuta `exportSelectedVideos` (`apps/api/src/services/exportService.ts`)
3. emite eventos SSE y guarda historial para replay
4. finaliza con `job_done` o `job_failed`

Eventos SSE emitidos:

- `job_started`
- `video_progress`
- `job_progress`
- `warning`
- `job_done`
- `job_failed`

Stages por video:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

### 5.3 Transcript pipeline (captions + fallback local ASR)

Orquestación: `apps/api/src/services/transcriptPipeline.ts`

1. intenta captions (`apps/api/src/services/transcriptService.ts`)
2. si faltan/fallan y ASR local habilitado -> llama ASR (`apps/api/src/services/localAsrService.ts`)
3. si ASR también falla -> no rompe export; transcript queda `""` y se agrega warning

Detalles útiles:

- `transcriptService.ts` tiene timeout, retry corto y cache in-memory.
- `localAsrService.ts` usa worker Python persistente (`apps/api/scripts/asr_worker.py`) con cola y reintento al crash.
- si falla health-check de `faster_whisper`, desactiva ASR en runtime y sigue en modo captions-only.

### 5.4 Title Features Agent (deterministic + AutoGen opcional)

Orquestación en `apps/api/src/services/exportService.ts`:

1. termina transcript por video
2. escribe `raw/transcripts/<videoId>.jsonl`
3. genera `derived/video_features/<videoId>.json` via `apps/api/src/derived/titleFeaturesAgent.ts`

Detalles:

- features deterministas siempre activas (`apps/api/src/derived/titleDeterministic.ts`)
- embeddings (`text-embedding-3-small`) opcionales si hay `OPENAI_API_KEY`
- AutoGen worker opcional (`apps/api/src/services/autogenRuntime.ts` + `apps/api/scripts/autogen_worker.py`)
- fallos de LLM/embeddings no rompen el export; quedan como warning y `llm: null`

## 6) Archivos generados y side effects

Export (`apps/api/src/services/exportService.ts`) escribe en:

- `exports/<channel_sanitizado>/channel.json`
- `exports/<channel_sanitizado>/thumbnails/<videoId>.jpg`
- `exports/<channel_sanitizado>/derived/video_features/<videoId>.json`

Temporal de ASR:

- `exports/.tmp/<jobId>/audio/*.mp3`
- se limpia al final (`fs.rm(..., { recursive: true, force: true })`)

Protección de path traversal:

- `ensureInsideRoot(...)` en `exportService.ts` para garantizar escritura bajo `exports/`.

## 7) Formato de export (resumen)

Contrato detallado: ver `docs/DATA_CONTRACTS.md`.

Resumen rápido:

- archivo final: `channel.json`
- estructura base: canal + `videos[]`
- por video incluye `transcript` (string, nunca `null`)
- `transcriptStatus` puede venir como `ok|missing|error`

Versionado:

- el runtime actual no escribe `exportVersion` explícito.
- para consumidores, tratarlo como versión implícita `1.0`.
- recomendado: agregar `exportVersion` en próximos cambios para compatibilidad hacia adelante.

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
