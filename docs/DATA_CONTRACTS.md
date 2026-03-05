# DATA CONTRACTS — ytai-analizer

Fuente de verdad: `apps/api/src/server.ts`, `apps/api/src/types.ts`, `apps/api/src/services/exportJobService.ts`, `apps/api/src/services/exportService.ts`, `apps/api/src/services/projectsService.ts`, `apps/web/src/types.ts`.

## 1) Runtime base

- API local: `http://localhost:3001`
- Web dev proxy: `/api/*` -> `http://localhost:3001/*` (`apps/web/vite.config.ts`)

## 2) HTTP endpoints

## 2.1 `GET /health`

Response `200`:

```json
{
  "ok": true
}
```

## 2.2 `POST /analyze`

Request body:

```json
{
  "sourceInput": "https://www.youtube.com/@midudev",
  "timeframe": "6m"
}
```

Validación:

- `sourceInput`: `string` no vacío
- `timeframe`: enum `1m | 6m | 1y`

Response `200` (`AnalyzeResult`):

```json
{
  "channelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "channelName": "Canal",
  "sourceInput": "https://www.youtube.com/@midudev",
  "timeframe": "6m",
  "warnings": [],
  "videos": [
    {
      "videoId": "abc123",
      "title": "Video title",
      "publishedAt": "2026-01-01T00:00:00.000Z",
      "viewCount": 12345,
      "thumbnailUrl": "https://...jpg"
    }
  ]
}
```

Errores típicos:

- `400`: body inválido
- `500`: falta `YOUTUBE_API_KEY`

## 2.3 `POST /export` (sincrónico)

Request body:

```json
{
  "channelId": "UC1234567890123456789012",
  "channelName": "Canal Demo",
  "sourceInput": "https://www.youtube.com/@demo",
  "timeframe": "6m",
  "selectedVideoIds": ["video1", "video2"]
}
```

Validación:

- `channelId`: regex `^UC[\w-]{22}$`
- `channelName`: `string` no vacío
- `sourceInput`: `string` no vacío
- `timeframe`: enum `1m | 6m | 1y`
- `selectedVideoIds`: array no vacío de strings no vacíos

Response `200`:

```json
{
  "folderPath": "/abs/path/exports/Canal_Demo",
  "warnings": [],
  "exportedCount": 2
}
```

## 2.4 `POST /export/jobs` (async)

Mismo body que `/export`.

Response `200`:

```json
{
  "jobId": "uuid-v4"
}
```

## 2.5 `GET /export/jobs/:jobId`

Params:

- `jobId`: UUID válido

Response `200` (`ExportJobState`):

```json
{
  "jobId": "uuid-v4",
  "status": "running",
  "completed": 1,
  "total": 3,
  "warnings": [],
  "exportPath": "/abs/path/exports/Canal_Demo",
  "error": "optional",
  "videoStages": {
    "video1": "transcribing",
    "video2": "queue"
  }
}
```

`status`: `queued | running | done | failed`

## 2.6 `GET /export/jobs/:jobId/events` (SSE)

Headers:

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`

Comportamiento:

- stream de historial + eventos nuevos
- cierre automático en `job_done` o `job_failed`

Formato wire:

```text
event: <event_name>
data: <json>

```

## 2.7 `GET /projects`

Lista proyectos detectados en `exports/*`.

Response `200` (`ProjectsListItem[]`):

```json
[
  {
    "projectId": "Canal_Demo",
    "channelId": "UC1234567890123456789012",
    "channelName": "Canal Demo",
    "exportVersion": "1.1",
    "lastExportedAt": "2026-03-01T12:00:00.000Z",
    "lastJobId": "uuid-v4",
    "counts": {
      "totalVideosSelected": 2,
      "transcriptsOk": 1,
      "transcriptsMissing": 1,
      "transcriptsError": 0,
      "thumbnailsOk": 2,
      "thumbnailsFailed": 0
    },
    "warningsCount": 1,
    "status": "partial",
    "warnings": []
  }
]
```

`status`: `ok | partial | failed | unknown`

## 2.8 `GET /projects/:projectId`

Params:

- `projectId`: nombre de carpeta de proyecto (`exports/<projectId>`)

Response `200` (`ProjectDetailResponse`):

```json
{
  "projectId": "Canal_Demo",
  "channel": {
    "channelId": "UC1234567890123456789012",
    "channelName": "Canal Demo",
    "sourceInput": "https://www.youtube.com/@demo",
    "timeframe": "6m",
    "exportedAt": "2026-03-01T12:00:00.000Z",
    "timeframeResolved": {
      "publishedAfter": "2025-09-01T00:00:00.000Z",
      "publishedBefore": "2026-03-01T00:00:00.000Z"
    }
  },
  "manifest": {},
  "latestJob": {
    "jobId": "uuid-v4",
    "status": "done",
    "startedAt": "2026-03-01T11:58:00.000Z",
    "finishedAt": "2026-03-01T12:00:00.000Z",
    "durationMs": 120000,
    "warningsCount": 0,
    "errorsCount": 0
  },
  "jobs": [
    {
      "jobId": "uuid-v4",
      "status": "done",
      "startedAt": "2026-03-01T11:58:00.000Z",
      "finishedAt": "2026-03-01T12:00:00.000Z",
      "durationMs": 120000,
      "warningsCount": 0,
      "errorsCount": 0,
      "summaryPath": "logs/job_<id>.summary.json",
      "eventsPath": "logs/job_<id>.events.jsonl",
      "errorsPath": "logs/job_<id>.errors.jsonl",
      "debugBundlePath": null
    }
  ],
  "artifacts": {
    "playbook": "analysis/playbook.json",
    "templates": "derived/templates.json",
    "channelModels": "derived/channel_models.json"
  },
  "warnings": []
}
```

## 2.9 `GET /projects/:projectId/videos`

Response `200` (`ProjectVideoSummaryItem[]`):

```json
[
  {
    "videoId": "abc123",
    "title": "Video title",
    "publishedAt": "2026-01-01T00:00:00.000Z",
    "thumbnailPath": "thumbnails/abc123.jpg",
    "transcriptStatus": "ok",
    "transcriptSource": "captions",
    "performance": {
      "viewsPerDay": 1200,
      "engagementRate": 0.08,
      "residual": 0.35,
      "percentile": 0.91
    },
    "hasLLM": {
      "description": true,
      "transcript": false,
      "thumbnail": true
    },
    "cacheHit": "full"
  }
]
```

## 2.10 `GET /projects/:projectId/videos/:videoId`

Query params opcionales:

- `maxSegments`: int `1..2000` (default efectivo `200`)
- `truncateChars`: int `1..10000`

Response `200`:

```json
{
  "videoId": "abc123",
  "derived": {},
  "transcriptJsonl": [
    { "type": "meta", "videoId": "abc123" },
    { "type": "segment", "i": 0, "text": "..." }
  ],
  "rawVideo": {}
}
```

## 2.11 `GET /projects/:projectId/artifacts/playbook`

Response `200`: JSON de `analysis/playbook.json`.

## 2.12 `GET /projects/:projectId/artifacts/templates`

Response `200`: JSON de `derived/templates.json`.

## 2.13 `GET /projects/:projectId/artifacts/channel_models`

Response `200`: JSON de `derived/channel_models.json`.

## 2.14 `GET /projects/:projectId/thumb/:videoId`

Response `200`:

- `Content-Type: image/jpeg`
- stream del archivo `thumbnails/<videoId>.jpg`
- `Cache-Control: public, max-age=3600, immutable`

## 2.15 `GET /projects/:projectId/bundle/meta`

Query params opcionales:

- `export`: `latest` o `jobId` específico

Response `200`:

```json
{
  "projectId": "Canal_Demo",
  "channelId": "UC1234567890123456789012",
  "exportJobId": "job-a1",
  "rawVideosMode": "full",
  "estimatedSizeBytes": 123456,
  "estimatedSizeMb": 0.12,
  "confirmationThresholdMb": 80,
  "confirmationRequired": false,
  "includedFiles": [],
  "missingFiles": [],
  "availableSuccessfulExportJobIds": ["job-a1"]
}
```

## 2.16 `GET /projects/:projectId/bundle`

Query params opcionales:

- `export`: `latest` o `jobId` específico

Response `200`:

- `Content-Type: application/zip`
- Descarga bundle cross-channel con:
  - `bundle.json`
  - `analysis/orchestrator_input.json` (obligatorio)
  - `primary/channel.json`
  - `primary/manifest.json`
  - `raw/channel.json`
  - `raw/videos.jsonl` o `raw/videos.extract.jsonl`
  - `derived/video_features/<videoId>.json` (solo exemplars)
  - `notes/missing_files.json` (si aplica)

Alias explícito por job:

- `GET /projects/:projectId/exports/:exportJobId/bundle`

## 3) SSE events

Todos definidos en `apps/api/src/services/exportJobService.ts` y `apps/web/src/types.ts`.

## 3.1 `job_started`

```json
{ "total": 10 }
```

## 3.2 `video_progress`

```json
{ "videoId": "abc123", "stage": "transcribing", "percent": 40 }
```

## 3.3 `job_progress`

```json
{ "completed": 4, "total": 10 }
```

## 3.4 `warning`

```json
{ "videoId": "abc123", "message": "warning text" }
```

`videoId` es opcional.

## 3.5 `job_done`

```json
{ "exportPath": "/abs/path/exports/Canal_Demo" }
```

## 3.6 `job_failed`

```json
{ "message": "error text" }
```

## 4) Export filesystem contracts

Root de salida: `exports/<channelFolder>/`

`channelFolder` se deriva de `sanitizeFolderName(channelName)` (`apps/api/src/utils/sanitize.ts`).

## 4.1 `channel.json` (schema principal)

Definido por `ExportPayload` (`apps/api/src/types.ts`).

```json
{
  "exportVersion": "1.1",
  "exportedAt": "2026-03-01T12:00:00.000Z",
  "channelName": "Canal Demo",
  "channelId": "UC1234567890123456789012",
  "sourceInput": "https://www.youtube.com/@demo",
  "timeframe": "6m",
  "timeframeResolved": {
    "publishedAfter": "2025-09-01T00:00:00.000Z",
    "publishedBefore": "2026-03-01T00:00:00.000Z"
  },
  "videos": [
    {
      "videoId": "abc123",
      "title": "Video title",
      "viewCount": 12345,
      "publishedAt": "2026-01-01T00:00:00.000Z",
      "thumbnailPath": "thumbnails/abc123.jpg",
      "transcript": "texto completo",
      "transcriptStatus": "ok",
      "transcriptSource": "captions",
      "transcriptPath": "raw/transcripts/abc123.jsonl"
    }
  ]
}
```

## 4.2 `manifest.json`

Definido por `ExportManifestV1` en `apps/api/src/services/exportService.ts`.

```json
{
  "jobId": "uuid-v4",
  "channelId": "UC1234567890123456789012",
  "channelFolder": "Canal_Demo",
  "exportVersion": "1.1",
  "exportedAt": "2026-03-01T12:00:00.000Z",
  "counts": {
    "totalVideosSelected": 2,
    "transcriptsOk": 1,
    "transcriptsMissing": 1,
    "transcriptsError": 0,
    "thumbnailsOk": 2,
    "thumbnailsFailed": 0
  },
  "warnings": [],
  "artifacts": [
    "channel.json",
    "manifest.json",
    "raw/channel.json",
    "raw/videos.jsonl"
  ]
}
```

## 4.3 `raw/channel.json`

Definido por `RawChannelExportV1`.

Campos clave:

- `exportVersion`, `exportedAt`, `jobId`
- `channelId`, `channelName`, `sourceInput`, `timeframe`, `timeframeResolved`
- `channelStats` (opcional)
- `provenance.dataSources[]`
- `provenance.warnings[]`
- `provenance.env.LOCAL_ASR_ENABLED`
- `provenance.env.TRANSCRIPT_LANG`

## 4.4 `raw/videos.jsonl`

Cada línea es `RawVideoRecordV1`.

Campos clave:

- metadata YouTube (`title`, `description`, `durationSec`, `statistics`, `thumbnails`)
- `thumbnailLocalPath`, `thumbnailOriginalUrl`
- `transcriptRef.transcriptPath`
- `transcriptRef.transcriptSource`
- `transcriptRef.transcriptStatus`
- `daysSincePublish`, `viewsPerDay`, `likeRate`, `commentRate`
- `warnings[]`

## 4.5 `raw/transcripts/<videoId>.jsonl`

Union de registros:

1. `meta` (`RawTranscriptMetaRecordV1`)
2. `segment` (`RawTranscriptSegmentRecordV1`)

Ejemplo:

```json
{"type":"meta","videoId":"abc123","source":"captions","status":"ok","language":"en","model":null,"computeType":null,"createdAt":"...","transcriptCleaned":true}
{"type":"segment","i":0,"startSec":0.0,"endSec":2.1,"text":"Hello","confidence":null}
```

## 4.6 `derived/video_features/<videoId>.json`

Esquema base `derived.video_features.v1`.

Secciones esperadas:

- `schemaVersion`, `videoId`, `computedAt`
- `titleFeatures` (deterministic + llm opcional)
- `descriptionFeatures` (deterministic + llm opcional)
- `transcriptFeatures` (deterministic + llm opcional)
- `thumbnailFeatures` (deterministic + llm opcional)
- `performance` (`viewsPerDay`, `likeRate`, `commentRate`, `engagementRate`, `residual`, `percentile`, etc.)

## 4.7 `derived/channel_models.json`

Esquema `derived.channel_models.v1` con:

- `computedAt`
- `channelId`
- `timeframe`
- `model` (baseline/performance normalization)

## 4.8 `.cache/index.json`

Esquema `cache.index.v1` (`apps/api/src/services/exportCacheService.ts`).

Campos clave:

- `schemaVersion`, `channelId`, `channelFolder`, `updatedAt`, `exportVersion`
- `timeframes[1m|6m|1y].videos[videoId]`
- hashes de entrada (`titleHash`, `descriptionHash`, `thumbnailHash`, `transcriptHash`)
- fingerprints de config/modelos
- estado de artifacts (`rawTranscript`, `thumbnail`, `derived`)

## 4.9 `logs/`

Por job:

- `logs/job_<jobId>.events.jsonl`
- `logs/job_<jobId>.errors.jsonl`
- `logs/job_<jobId>.summary.json`
- `logs/job_<jobId>.debug_bundle.json` (si aplica)

## 5) Enums de referencia

`timeframe`:

- `1m`
- `6m`
- `1y`

`ExportVideoStage`:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

`ExportJobStatus`:

- `queued`
- `running`
- `done`
- `failed`

`transcriptStatus`:

- `ok`
- `missing`
- `error`

`transcriptSource`:

- `captions`
- `asr`
- `none`

## 6) Versionado y compatibilidad

- Versión actual de export runtime: `1.1` (`apps/api/src/services/exportService.ts`).
- Consumidores deben validar `exportVersion` antes de parsear campos opcionales.
- `channel.json` es el contrato estable para integraciones externas.
- `raw/*`, `derived/*`, `.cache/*` están orientados a diagnóstico/procesamiento interno.

## 7) Invariantes de seguridad de rutas

`exportService` y `projectsService` validan path traversal con `ensureInsideRoot(...)` y validación de segmentos.

Esto aplica a:

- escritura de exports
- lectura de artifacts de proyectos
- resolución de miniaturas por `projectId/videoId`
