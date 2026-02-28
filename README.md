# ytai-analizer

Monorepo con `pnpm workspaces` para analizar canales de YouTube y exportar `channel.json` con transcript completo usando pipeline:

1. Captions (`youtube-transcript`)
2. Fallback local ASR (`yt-dlp` + `faster-whisper`)

## Stack

- `apps/web`: Vite + React + TypeScript
- `apps/api`: Node.js + TypeScript + Fastify
- Worker local ASR: Python 3.10+ (`faster-whisper`, `yt-dlp`)

## Requisitos

- Node.js 20+
- pnpm 10+
- API key de YouTube Data API v3
- Python 3.10+
- `ffmpeg` en PATH
- Opcional (GPU): CUDA drivers + runtime compatibles con `ctranslate2`

## Setup

1. Instalar dependencias JS:

```bash
pnpm install
```

2. Configurar variables API:

```bash
cp apps/api/.env.example apps/api/.env
```

3. Preparar ASR local (recomendado):

```bash
pnpm asr:setup
pnpm asr:check
```

## ASR local (Whisper)

Este proyecto **no instala paquetes Python globales**. Todo va en un `venv` local del repo (`.venv-asr`) para evitar errores PEP 668 en macOS/Homebrew.

### macOS

1. Instalar `ffmpeg`:

```bash
brew install ffmpeg
```

2. Setup recomendado (automático):

```bash
pnpm asr:setup
pnpm asr:check
```

3. Setup manual equivalente:

```bash
python3 -m venv .venv-asr
source .venv-asr/bin/activate
python -m pip install --upgrade pip
python -m pip install -r apps/api/scripts/requirements-asr.txt
```

### Windows

1. Instalar Python 3.10+ y `ffmpeg` (por ejemplo con `winget` o `choco`).
2. Setup recomendado (automático):

```powershell
pnpm asr:setup
pnpm asr:check
```

3. Setup manual equivalente:

```powershell
python -m venv .venv-asr
.\.venv-asr\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r apps/api/scripts/requirements-asr.txt
```

4. CUDA opcional (RTX):
- Si tienes GPU NVIDIA, instala drivers/CUDA compatibles con `ctranslate2`.
- Usa `LOCAL_ASR_COMPUTE_TYPE=auto` (recomendado): selecciona tipo según dispositivo y aplica fallback.
- Si quieres forzar GPU, puedes usar `LOCAL_ASR_COMPUTE_TYPE=int8_float16`.

### Troubleshooting (PEP 668 en macOS)

Si ves `error: externally-managed-environment`, significa que `pip` está intentando instalar en el Python administrado por Homebrew/sistema.

Solución en este repo:
- usar `pnpm asr:setup` o
- crear/activar `.venv-asr` y luego instalar requirements dentro de ese venv.

No uses `--break-system-packages`.

## Variables de entorno (ASR local)

```bash
LOCAL_ASR_ENABLED=true
LOCAL_ASR_MODEL=large-v3-turbo
LOCAL_ASR_COMPUTE_TYPE=auto
LOCAL_ASR_LANGUAGE=auto
LOCAL_ASR_BEAM_SIZE=5
LOCAL_ASR_MAX_CONCURRENCY=1
LOCAL_ASR_TIMEOUT_SEC=900
YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC=300
ASR_PYTHON_PATH=
```

Resolución de Python para el worker ASR:
1. `ASR_PYTHON_PATH` (si está seteado)
2. Python del venv del repo (`.venv-asr`)
3. fallback por SO (`python3` en macOS/Linux, `python` en Windows)

Si `faster_whisper` no está disponible, la API emite warning y continúa en modo captions-only (no rompe `pnpm dev` ni el export).

## Desarrollo

```bash
pnpm dev
```

Servicios:

- Web: `http://localhost:5173`
- API health: `http://localhost:3001/health`

## Export asíncrono con progreso (SSE)

### Endpoints

- `POST /export/jobs` -> crea job y devuelve `{ jobId }`
- `GET /export/jobs/:jobId` -> estado actual del job
- `GET /export/jobs/:jobId/events` -> stream SSE

Eventos SSE:

- `job_started { total }`
- `video_progress { videoId, stage, percent? }`
- `job_progress { completed, total }`
- `warning { videoId?, message }`
- `job_done { exportPath }`
- `job_failed { message }`

Stages por video:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

## Transcript pipeline

- Si hay captions: se usan y `transcript` queda poblado.
- Si captions faltan o fallan y `LOCAL_ASR_ENABLED=true`:
  - worker Python descarga solo audio (`bestaudio` -> mp3)
  - transcribe local con `faster-whisper`
- Si fallback local falla:
  - `transcript` queda como `""`
  - se emite warning explícito
  - el export no se rompe

El JSON final siempre escribe `transcript` como string.

## Comandos de verificación

```bash
pnpm install
pnpm asr:setup
pnpm asr:check
pnpm dev
pnpm test
```
