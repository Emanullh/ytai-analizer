# AI Context Pack — ytai-analizer

Contexto operativo para otras IAs. Todo lo de este archivo fue verificado contra el código actual del repo el 2026-03-06.

## 1. Snapshot útil

- Monorepo `pnpm` con workspace `apps/*` (`pnpm-workspace.yaml`).
- Backend: Fastify + TypeScript en `apps/api`.
- Frontend: React + Vite + TypeScript en `apps/web`.
- Setup Python compartido para ASR, OCR y AutoGen en `/.venv-asr`.
- El root efectivo de exports depende de `process.cwd()`. Con los comandos soportados del repo (`pnpm dev`, `pnpm -C apps/api dev`, `pnpm -C apps/api start`) el output cae en `apps/api/exports/`.

## 2. Comandos exactos

Desde la raíz del repo:

```bash
pnpm install
pnpm dev
pnpm test
```

Comandos por app:

```bash
pnpm -C apps/api dev
pnpm -C apps/api test
pnpm -C apps/web dev
pnpm -C apps/web test
```

Bootstrap/check del entorno Python:

```bash
pnpm asr:setup
pnpm asr:check
```

Alias equivalentes definidos en `package.json`:

```bash
pnpm python:setup
pnpm python:check
pnpm ocr:setup
pnpm ocr:check
```

Chequeos manuales útiles:

```bash
curl http://localhost:3001/health
ffmpeg --version
```

## 3. Entry points reales

Root:

- `package.json`: scripts del monorepo.
- `pnpm-workspace.yaml`: workspace `apps/*`.
- `README.md`: setup humano, parcialmente desactualizado respecto al pipeline transcript actual.
- `apps/api/.env.example`: valores de ejemplo.

API:

- `apps/api/src/server.ts`: rutas HTTP/SSE y validación con `zod`.
- `apps/api/src/config/env.ts`: parseo de envs con defaults.
- `apps/api/src/services/exportService.ts`: export principal, manifest, raw pack, derived artifacts.
- `apps/api/src/services/exportJobService.ts`: jobs async + buffer de eventos SSE.
- `apps/api/src/services/projectsService.ts`: lectura de `apps/api/exports/*`.
- `apps/api/src/services/exportBundleService.ts`: meta + zip bundle.
- `apps/api/src/services/rerunOrchestratorService.ts`: rerun manual del orquestador.
- `apps/api/src/services/rerunProjectFeaturesService.ts`: rerun batch por feature con SSE.
- `apps/api/src/services/rerunThumbnailsService.ts`: rerun batch de thumbnails con SSE.
- `apps/api/src/services/videoFeatureRerunService.ts`: rerun individual por video/feature.
- `apps/api/src/services/transcriptPipeline.ts`: pipeline transcript actual.
- `apps/api/src/services/localAsrService.ts`: worker client de ASR local.
- `apps/api/src/services/asrRuntime.ts`: resolución de `python` para ASR.
- `apps/api/src/services/ocrRuntime.ts`: resolución de `python` para OCR.

Web:

- `apps/web/src/main.tsx`: bootstrap React.
- `apps/web/src/App.tsx`: router.
- `apps/web/src/pages/AnalyzePage.tsx`: analyze + export async + modal de progreso.
- `apps/web/src/exportJobState.ts`: reducer del modal SSE.
- `apps/web/src/pages/ProjectsList.tsx`: dashboard + export bundle.
- `apps/web/src/pages/ProjectDetail.tsx`: artifacts, videos, reruns, charts.
- `apps/web/src/components/project/VideoFeaturePanels.tsx`: reruns individuales por feature.
- `apps/web/vite.config.ts`: proxy `/api` a `http://localhost:3001`.

Python/scripts:

- `scripts/setup_asr.mjs`: dispatcher cross-platform.
- `scripts/setup_asr.sh`: crea/reusa `/.venv-asr` e instala requirements.
- `scripts/setup_asr.ps1`: equivalente Windows.
- `scripts/check_asr.mjs`: valida imports Python de ASR + OCR + AutoGen.
- `apps/api/scripts/asr_worker.py`: descarga audio y transcribe.
- `apps/api/scripts/autogen_worker.py`: tareas LLM.
- `apps/api/scripts/ocr_worker.py`: OCR.

## 4. Runtime y variables de entorno

Requerida para analyze/export:

- `YOUTUBE_API_KEY`

Opcional, pero necesaria para features/orchestrator LLM:

- `OPENAI_API_KEY`

Core API (`apps/api/src/config/env.ts`):

- `PORT` default `3001`
- `TRANSCRIPT_LANG`
- `EXPORT_VIDEO_CONCURRENCY`
- `EXPORT_HTTP_CONCURRENCY`
- `EXPORT_ASR_CONCURRENCY`
- `EXPORT_OCR_CONCURRENCY`
- `EXPORT_LLM_CONCURRENCY`
- `EXPORT_EMBEDDINGS_CONCURRENCY`
- `EXPORT_FS_CONCURRENCY`
- `EXPORT_FAIL_FAST`

ASR local (`apps/api/src/config/env.ts`, `apps/api/src/services/localAsrService.ts`, `apps/api/scripts/asr_worker.py`):

- `LOCAL_ASR_ENABLED`
- `LOCAL_ASR_MODEL`
- `LOCAL_ASR_COMPUTE_TYPE`
- `LOCAL_ASR_LANGUAGE`
- `LOCAL_ASR_BEAM_SIZE`
- `LOCAL_ASR_MAX_CONCURRENCY`
- `LOCAL_ASR_TIMEOUT_SEC`
- `YOUTUBE_AUDIO_DOWNLOAD_TIMEOUT_SEC`
- `ASR_PYTHON_PATH`

OCR / runtime Python:

- `THUMB_OCR_ENABLED`
- `THUMB_OCR_ENGINE`
- `THUMB_OCR_LANGS`
- `THUMB_VISION_DOWNSCALE_WIDTH`
- `OCR_PYTHON_PATH`

AutoGen / orquestador:

- `AUTO_GEN_ENABLED`
- `AUTO_GEN_MODEL_TITLE`
- `AUTO_GEN_MODEL_DESCRIPTION`
- `AUTO_GEN_MODEL_THUMBNAIL`
- `AUTO_GEN_MODEL_ORCHESTRATOR`
- `AUTO_GEN_REASONING_EFFORT`
- `AUTO_GEN_REASONING_EFFORT_ORCHESTRATOR`
- `AUTO_GEN_TIMEOUT_SEC`
- `AUTO_GEN_TIMEOUT_ORCHESTRATOR_SEC`

Bundle:

- `EXPORT_BUNDLE_RAW_VIDEOS_MAX_BYTES`
- `EXPORT_BUNDLE_CONFIRM_THRESHOLD_MB`

Notas prácticas:

- `TRANSCRIPT_LANG` existe, pero el pipeline transcript usado por export ya no intenta captions primero. El idioma efectivo del transcript actual sale de `LOCAL_ASR_LANGUAGE` o del resultado del worker.
- `OCR_PYTHON_PATH` no pasa por `apps/api/src/config/env.ts`; lo lee directo `apps/api/src/services/ocrRuntime.ts`.
- `pnpm asr:setup` instala ASR + AutoGen + OCR en el mismo venv.

## 5. Flujos reales

### 5.1 Analyze

1. La UI de `apps/web/src/pages/AnalyzePage.tsx` hace `POST /api/analyze`.
2. `apps/api/src/server.ts` valida `{ sourceInput, timeframe }`.
3. `apps/api/src/services/youtubeService.ts` resuelve canal + videos.
4. La respuesta vuelve como `AnalyzeResult` (`apps/api/src/types.ts`).

### 5.2 Export async con SSE y modal

1. La UI selecciona videos y hace `POST /api/export/jobs`.
2. El backend crea el job en `apps/api/src/services/exportJobService.ts`.
3. La UI abre `EventSource('/api/export/jobs/:jobId/events')`.
4. `apps/web/src/exportJobState.ts` reduce eventos `job_started`, `video_progress`, `job_progress`, `warning`, `job_done`, `job_failed`.
5. `apps/api/src/services/exportService.ts` escribe:
   - `channel.json`
   - `manifest.json`
   - `raw/channel.json`
   - `raw/videos.jsonl`
   - `raw/transcripts/*.jsonl`
   - `raw/audio/*.mp3`
   - `raw/thumbnails/`
   - `thumbnails/*.jpg`
   - `derived/video_features/*.json`
   - `derived/channel_models.json`
   - `.cache/index.json`
   - `logs/job_<jobId>.*`

Stages por video:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

### 5.3 Transcript pipeline actual

Estado real del código:

- `apps/api/src/services/transcriptPipeline.ts` usa ASR local como pipeline efectivo.
- El hook de captions sigue en la interfaz por compatibilidad de tests, pero el default provider devuelve `missing`.
- Si `LOCAL_ASR_ENABLED=false` o el worker falla, el video puede terminar con transcript vacío y warning, sin romper todo el job.
- El transcript persistido va a `raw/transcripts/<videoId>.jsonl` y el raw video guarda `transcriptRef`.

### 5.4 Projects dashboard

1. `apps/web/src/pages/ProjectsList.tsx` llama `GET /api/projects`.
2. `apps/api/src/services/projectsService.ts` recorre `apps/api/exports/*` y arma tarjetas por proyecto.
3. `apps/web/src/pages/ProjectDetail.tsx` carga:
   - `GET /api/projects/:projectId`
   - `GET /api/projects/:projectId/videos`
   - `GET /api/projects/:projectId/videos/:videoId`
   - `GET /api/projects/:projectId/artifacts/*`
   - `GET /api/projects/:projectId/thumb/:videoId`

### 5.5 Bundle export

1. `ProjectsList.tsx` consulta `GET /api/projects/:projectId/bundle/meta?export=latest`.
2. Si el tamaño estimado supera el umbral, la UI pide confirmación.
3. Luego descarga `GET /api/projects/:projectId/bundle?export=latest`.
4. `apps/api/src/services/exportBundleService.ts` empaqueta `bundle.json` + archivos seleccionados.

Importante:

- El bundle requiere `analysis/orchestrator_input.json`.
- El export principal no lo genera; `exportService.ts` registra explícitamente `Channel orchestrator skipped during export (manual trigger only)`.
- Para que el bundle funcione hay que ejecutar antes `POST /export/rerun-orchestrator` desde Project Detail.

### 5.6 Reruns desde Project Detail

Disponibles hoy:

- Rerun manual del orquestador: `POST /api/export/rerun-orchestrator`
- Rerun individual por video/feature:
  - `POST /api/projects/:projectId/videos/:videoId/rerun/:feature`
  - features: `thumbnail | title | description | transcript`
  - modes: `collect_assets | prepare | full`
- Rerun batch por feature con SSE:
  - `POST /api/projects/:projectId/rerun/features`
  - `GET /api/projects/:projectId/rerun/features/jobs/:jobId`
  - `GET /api/projects/:projectId/rerun/features/jobs/:jobId/events`

Existe también un pipeline batch para thumbnails:

- `POST /api/projects/:projectId/rerun/thumbnails`
- `GET /api/projects/:projectId/rerun/thumbnails/jobs/:jobId`
- `GET /api/projects/:projectId/rerun/thumbnails/jobs/:jobId/events`

La UI actual usa rerun individual por feature y rerun batch por feature. El job batch de thumbnails existe en backend pero no está cableado en la UI principal.

## 6. Formato de export y artifacts

Versiones verificadas:

- `exportVersion = "1.1"` en `apps/api/src/services/exportService.ts`
- `derived/video_features/*.json` usa `schemaVersion: "derived.video_features.v1"`
- `derived/channel_models.json` usa `schemaVersion: "derived.channel_models.v1"`
- `analysis/playbook.json` usa `schemaVersion: "analysis.playbook.v1"`
- `derived/templates.json` usa `schemaVersion: "derived.templates.v1"`
- `bundle.json` usa `schemaVersion: "analysis.cross_channel_bundle.v1"`

Contrato práctico:

- `channel.json` es el payload principal que consume el dashboard.
- `manifest.json` resume counts, warnings y artifacts escritos.
- `raw/channel.json` guarda proveniencia y configuración relevante.
- `raw/videos.jsonl` es el inventario detallado por video.
- `raw/transcripts/<videoId>.jsonl` mezcla un registro `meta` y múltiples registros `segment`.
- `raw/thumbnails/` es symlink al directorio `thumbnails/` cuando el SO lo permite; si no, es copia física.
- `raw/audio/<videoId>.mp3` existe si se descargó/reutilizó audio para ASR.
- `analysis/orchestrator_input.json`, `analysis/playbook.json` y `derived/templates.json` aparecen sólo después de correr el orquestador.

## 7. Notas de Windows

- Venv esperado por default: `.venv-asr\\Scripts\\python.exe`
- Activación manual: `.\\.venv-asr\\Scripts\\Activate.ps1`
- Overrides útiles:
  - `ASR_PYTHON_PATH=C:\\path\\to\\ytai-analizer\\.venv-asr\\Scripts\\python.exe`
  - `OCR_PYTHON_PATH=C:\\path\\to\\ytai-analizer\\.venv-asr\\Scripts\\python.exe`
- `ffmpeg.exe` debe estar en `PATH`.
- `scripts/setup_asr.ps1` usa `py -3 -m venv` si `py` existe; si no, cae a `python -m venv`.

## 8. Troubleshooting corto

- `Missing YOUTUBE_API_KEY in apps/api/.env`: revisar `apps/api/.env` y reiniciar API.
- `Local ASR disabled`: revisar `LOCAL_ASR_ENABLED`, `ASR_PYTHON_PATH` y `pnpm asr:check`.
- `ffmpeg not found`: instalar `ffmpeg` y validar `ffmpeg --version`.
- El modal pierde SSE: revisar `http://localhost:3001/health` y el proxy de `apps/web/vite.config.ts`.
- `bundle/meta` o `bundle` devuelven `409`: falta `analysis/orchestrator_input.json`; ejecutar rerun del orquestador.
- `POST /export/rerun-orchestrator` devuelve `409`: faltan `channel.json`, `raw/videos.jsonl` o `derived/video_features/*.json`.
- Si cambias cómo se arranca la API y cambias `process.cwd()`, también cambias el root de exports.

## 9. Dónde seguir leyendo

- Contratos HTTP, SSE y schemas: `docs/DATA_CONTRACTS.md`
- Mapa de módulos y ownership técnico: `docs/REPO_MAP.md`
