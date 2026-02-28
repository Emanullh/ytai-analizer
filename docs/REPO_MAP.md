# REPO MAP — ytai-analizer

Mapa práctico de archivos y responsabilidades.

## 1) Estructura raíz

- `AGENTS.md`: reglas operativas del entorno (swarm, seguridad, estándares).
- `README.md`: guía de setup/uso para humanos.
- `package.json`: scripts globales (`dev`, `build`, `test`, `asr:setup`, `asr:check`).
- `pnpm-workspace.yaml`: define workspace `apps/*`.
- `scripts/`: wrappers de setup/check de ASR (`.mjs`, `.sh`, `.ps1`).
- `docs/`: documentación técnica del proyecto.

## 2) apps/api

### 2.1 Entry point

- `apps/api/src/server.ts`

Responsabilidades:

- inicializar Fastify + CORS
- declarar rutas REST + SSE
- validar payloads con `zod`
- enrutar a servicios de dominio

### 2.2 Config

- `apps/api/src/config/env.ts`

Responsabilidades:

- cargar `.env` con `dotenv`
- parsear/normalizar defaults de puerto, flags booleanos e ints positivos

### 2.3 Servicios de dominio

- `apps/api/src/services/youtubeService.ts`
  - resolución de canal desde input flexible
  - listado de videos por timeframe
  - lectura YouTube Data API v3

- `apps/api/src/services/exportService.ts`
  - orquesta export por videos seleccionados
  - descarga thumbnails
  - integra transcript/captions/ASR
  - escribe `channel.json`
  - controla rutas bajo `exports/` (anti traversal)

- `apps/api/src/services/exportJobService.ts`
  - job manager in-memory
  - eventos para SSE
  - estado de progreso por video y global

- `apps/api/src/services/transcriptService.ts`
  - captions vía `youtube-transcript`
  - timeout/retry/cache

- `apps/api/src/services/transcriptPipeline.ts`
  - fallback captions -> ASR local
  - normaliza warning/status final

- `apps/api/src/services/localAsrService.ts`
  - cliente del worker Python
  - cola de tareas y concurrencia
  - health-check y restart del worker

- `apps/api/src/services/asrRuntime.ts`
  - resuelve binario Python (env/venv/fallback)
  - health-check de import `faster_whisper`

### 2.4 Tipos y utilidades

- `apps/api/src/types.ts`: contratos `AnalyzeResult`, `ExportPayload`, etc.
- `apps/api/src/utils/http.ts`: fetch/download con timeout + `HttpError`.
- `apps/api/src/utils/sanitize.ts`: normaliza nombre de carpeta de export.
- `apps/api/src/utils/timeframe.ts`: convierte `1m|6m|1y` a ISO date.
- `apps/api/src/utils/cache.ts`: cache simple en memoria (TTL).
- `apps/api/src/utils/errors.ts`: error HTTP tipado.

### 2.5 Worker Python + deps

- `apps/api/scripts/asr_worker.py`
  - descarga audio con `yt-dlp`
  - extrae/transcribe con `faster-whisper`
  - reporta progreso por JSON-lines

- `apps/api/scripts/requirements-asr.txt`
  - `faster-whisper`
  - `yt-dlp`

### 2.6 Tests API

- `apps/api/tests/exportJobs.test.ts`
- `apps/api/tests/transcriptPipeline.test.ts`
- `apps/api/tests/transcriptService.test.ts`
- `apps/api/tests/asrRuntime.test.ts`

## 3) apps/web

### 3.1 Entry points

- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`

### 3.2 Estado de export

- `apps/web/src/exportJobState.ts`
  - reducer de estado para modal/progreso
  - consume eventos SSE tipados

- `apps/web/src/types.ts`
  - tipos compartidos de API/SSE para frontend

### 3.3 Build/dev infra

- `apps/web/vite.config.ts`
  - proxy `/api` a backend local

- `apps/web/src/index.css`
  - estilos de UI y modal

### 3.4 Tests Web

- `apps/web/src/exportJobState.test.ts`

## 4) scripts (raíz)

- `scripts/setup_asr.mjs`
  - wrapper cross-platform (`bash`/`powershell`)

- `scripts/setup_asr.sh`
  - crea/reusa `.venv-asr`
  - instala `apps/api/scripts/requirements-asr.txt`

- `scripts/setup_asr.ps1`
  - variante Windows del setup

- `scripts/check_asr.mjs`
  - valida `import faster_whisper` con python resuelto

## 5) Flujo end-to-end y puntos de salto

1. UI analiza canal (`apps/web/src/App.tsx` -> `POST /api/analyze`).
2. API resuelve canal/videos (`apps/api/src/services/youtubeService.ts`).
3. UI selecciona videos y crea job (`POST /api/export/jobs`).
4. API corre export (`apps/api/src/services/exportJobService.ts` -> `exportService.ts`).
5. Export pipeline por video:
   - transcript pipeline (`transcriptPipeline.ts`)
   - local ASR opcional (`localAsrService.ts` + `asr_worker.py`)
   - thumbnail download + escritura `channel.json`
6. UI consume SSE y actualiza modal (`exportJobState.ts`).

## 6) Hotspots para cambios futuros

### Si cambias contratos HTTP/SSE

Ajustar en:

- `apps/api/src/server.ts`
- `apps/api/src/services/exportJobService.ts`
- `apps/web/src/types.ts`
- `apps/web/src/exportJobState.ts`
- tests API/Web asociados

### Si cambias schema de `channel.json`

Ajustar en:

- `apps/api/src/types.ts`
- `apps/api/src/services/exportService.ts`
- `docs/DATA_CONTRACTS.md`
- consumidores externos del JSON

### Si cambias ASR local

Ajustar en:

- `apps/api/scripts/asr_worker.py`
- `apps/api/src/services/localAsrService.ts`
- `apps/api/src/services/asrRuntime.ts`
- `scripts/setup_asr.mjs`, `scripts/setup_asr.sh`, `scripts/setup_asr.ps1` y `scripts/check_asr.mjs`
- tests de runtime/pipeline

## 7) Dependencias y runtime mínimo

- Node.js `>=20` (root `package.json`)
- pnpm `10.x`
- Python `3.10+` para ASR local
- `ffmpeg` en PATH para extracción de audio
- API key YouTube para `analyze/export`
