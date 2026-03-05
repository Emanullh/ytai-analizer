# DATA CONTRACTS — ytai-analizer

Fuente de verdad: `apps/api/src/server.ts`, `apps/api/src/types.ts`, `apps/api/src/services/exportJobService.ts`, `apps/api/src/services/exportService.ts`, `apps/api/src/services/projectsService.ts`, `apps/api/src/services/exportBundleService.ts`, `apps/web/src/types.ts`.

## 1) Runtime y base URL

- API dev: `http://localhost:3001`
- Web usa proxy Vite: `/api/*` -> `http://localhost:3001/*` (`apps/web/vite.config.ts`)

## 2) HTTP Endpoints

## 2.1 `GET /health`

Response `200`:

```json
{ "ok": true }
```

## 2.2 `POST /analyze`

Request:

```json
{
  "sourceInput": "https://www.youtube.com/@midudev",
  "timeframe": "6m"
}
```

Validación:

- `sourceInput`: string no vacío
- `timeframe`: `"1m" | "6m" | "1y"`

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
      "title": "Video",
      "publishedAt": "2026-02-01T00:00:00.000Z",
      "viewCount": 12345,
      "thumbnailUrl": "https://..."
    }
  ]
}
```

## 2.3 `POST /export`

Request:

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
- `channelName`: string no vacío
- `sourceInput`: string no vacío
- `timeframe`: `"1m" | "6m" | "1y"`
- `selectedVideoIds`: array no vacío de strings no vacíos

Response `200`:

```json
{
  "folderPath": "/abs/path/exports/Canal_Demo",
  "warnings": [],
  "exportedCount": 2
}
```

## 2.4 `POST /export/jobs`

Request: mismo body de `POST /export`.

Response `200`:

```json
{ "jobId": "uuid-v4" }
```

## 2.5 `GET /export/jobs/:jobId`

Validación params:

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

- Reproduce historial del job y luego eventos live.
- Cierra stream en `job_done` o `job_failed`.

Wire format:

```text
event: <event_name>
data: <json>

```

## 2.7 `POST /export/rerun-orchestrator`

Request:

```json
{ "channelName": "Canal Demo" }
```

Prerequisitos (si faltan, responde `409`):

- `exports/<channelFolder>/channel.json`
- `exports/<channelFolder>/raw/videos.jsonl`
- `exports/<channelFolder>/derived/video_features/*.json` (al menos 1)

Response `200`:

```json
{
  "ok": true,
  "exportPath": "/abs/path/exports/Canal_Demo",
  "warnings": [],
  "usedLlm": true,
  "artifactPaths": ["/abs/path/exports/Canal_Demo/analysis/orchestrator_input.json"]
}
```

Error `409`:

```json
{
  "error": "Cannot re-run orchestrator: missing prerequisites: ...",
  "checks": [
    { "artifact": "channel.json", "exists": true, "detail": "optional" }
  ]
}
```

## 2.8 `GET /projects`

Response `200` (`ProjectsListItem[]`):

- `projectId`
- `channelId | null`
- `channelName | null`
- `exportVersion | null`
- `lastExportedAt | null`
- `lastJobId | null`
- `counts`: `{ totalVideosSelected, transcriptsOk, transcriptsMissing, transcriptsError, thumbnailsOk, thumbnailsFailed }`
- `warningsCount`
- `status`: `ok | partial | failed | unknown`
- `warnings: string[]`

## 2.9 `GET /projects/:projectId`

Validación params:

- `projectId` sin `/`, `\\`, `..`, ni path absoluto

Response `200` (`ProjectDetailResponse`):

- `projectId`
- `channel`: metadata del canal
- `manifest`: objeto manifest o `null`
- `latestJob`: resumen último job o `null`
- `jobs[]`: incluye rutas relativas de logs (`summaryPath`, `eventsPath`, `errorsPath`, `debugBundlePath`)
- `artifacts`: `{ playbook, templates, channelModels }` con path relativo o `null`
- `warnings: string[]`

## 2.10 `GET /projects/:projectId/videos`

Response `200` (`ProjectVideoSummaryItem[]`):

- `videoId`, `title`, `publishedAt`, `thumbnailPath`
- `transcriptStatus`: `ok | missing | error`
- `transcriptSource`: `captions | asr | none`
- `performance`: `{ viewsPerDay, engagementRate, residual, percentile } | null`
- `hasLLM`: `{ description, transcript, thumbnail }`
- `cacheHit`: `full | partial | miss | unknown | null`

## 2.11 `GET /projects/:projectId/videos/:videoId`

Query opcional:

- `maxSegments`: int `1..2000` (default interno `200`)
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

## 2.12 Artifacts JSON

- `GET /projects/:projectId/artifacts/playbook`
- `GET /projects/:projectId/artifacts/templates`
- `GET /projects/:projectId/artifacts/channel_models`

Response: JSON del artifact solicitado. `404` si no existe.

## 2.13 Thumbnail proxy

`GET /projects/:projectId/thumb/:videoId`

- `Content-Type: image/jpeg`
- `Cache-Control: public, max-age=3600, immutable`

## 2.14 Bundle meta

`GET /projects/:projectId/bundle/meta?export=latest|<jobId>`

Response `200` (`ProjectBundleMetaResponse`):

- `projectId`, `channelId`, `exportJobId`, `exportedAt`, `timeframe`, `timeframeResolved`
- `rawVideosMode`: `full | extract | missing`
- `rawVideosEntryPath`: `raw/videos.jsonl | raw/videos.extract.jsonl | null`
- `exemplarVideoIds: string[]`
- `includedFiles[]`: `{ path, sizeBytes, source }`
- `missingFiles[]`: `{ path, reason }`
- `estimatedSizeBytes`, `estimatedSizeMb`
- `confirmationThresholdMb`, `confirmationRequired`
- `availableSuccessfulExportJobIds: string[]`

## 2.15 Bundle download

- `GET /projects/:projectId/bundle?export=latest|<jobId>`
- `GET /projects/:projectId/exports/:exportJobId/bundle`

Response `200`:

- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="bundle_<...>.zip"`

Entradas del zip:

- `bundle.json`
- `analysis/orchestrator_input.json` (required)
- `primary/channel.json` (si existe)
- `primary/manifest.json` (si existe)
- `raw/channel.json` (si existe)
- `raw/videos.jsonl` o `raw/videos.extract.jsonl`
- `derived/video_features/<videoId>.json` (solo exemplars)
- `notes/missing_files.json` (si faltan archivos opcionales)

## 3) SSE Contract

Eventos (`ExportJobEvent`) y payload:

- `job_started` -> `{ total: number }`
- `video_progress` -> `{ videoId: string, stage: ExportVideoStage, percent?: number }`
- `job_progress` -> `{ completed: number, total: number }`
- `warning` -> `{ videoId?: string, message: string }`
- `job_done` -> `{ exportPath: string }`
- `job_failed` -> `{ message: string }`

`ExportVideoStage`:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

## 4) File Schemas (export)

## 4.1 `channel.json`

- Path: `exports/<channelFolder>/channel.json`
- Tipo: `ExportPayload` (`apps/api/src/types.ts`)
- Campos clave: `exportVersion`, `exportedAt`, `channelName`, `channelId`, `sourceInput`, `timeframe`, `timeframeResolved`, `videos[]`

## 4.2 `manifest.json`

- Path: `exports/<channelFolder>/manifest.json`
- Versión actual de export: `exportVersion: "1.1"` (const `EXPORT_VERSION`)
- Campos clave: `jobId`, `channelId`, `channelFolder`, `counts`, `warnings`, `artifacts[]`

## 4.3 `raw/channel.json`

- Incluye metadatos de export + `provenance`.
- `provenance.dataSources`: `youtube-data-api-v3`, `youtube-transcript`, `local-asr-fallback`.

## 4.4 `raw/videos.jsonl`

Cada línea es `RawVideoRecordV1` con:

- metadata básica de video
- `statistics`
- `thumbnailLocalPath`, `thumbnailOriginalUrl`
- `transcriptRef`: `{ transcriptPath, transcriptSource, transcriptStatus }`
- métricas derivadas simples (`viewsPerDay`, `likeRate`, `commentRate`)

## 4.5 `raw/transcripts/<videoId>.jsonl`

Formato jsonl mixto:

1. Línea meta (`type: "meta"`):

```json
{
  "type": "meta",
  "videoId": "abc123",
  "source": "captions",
  "status": "ok",
  "language": "es",
  "model": null,
  "computeType": null,
  "createdAt": "2026-03-05T00:00:00.000Z",
  "transcriptCleaned": true,
  "warning": "optional"
}
```

2. Líneas segmento (`type: "segment"`):

```json
{
  "type": "segment",
  "i": 0,
  "startSec": 0,
  "endSec": 3.2,
  "text": "...",
  "confidence": null
}
```

## 4.6 Derived artifacts

- `derived/video_features/<videoId>.json` -> `schemaVersion: "derived.video_features.v1"`
- `derived/channel_models.json` -> `schemaVersion: "derived.channel_models.v1"`
- `derived/templates.json` -> generado por pipeline/orchestrator (si disponible)

## 4.7 Bundle schema

- `bundle.json` contiene `schemaVersion: "analysis.cross_channel_bundle.v1"`.
- Incluye `thresholds.rawVideosExtractThresholdBytes` y `thresholds.confirmationThresholdMb`.
- Expone `filesIncluded` y `filesMissing` como inventario explícito del zip.

## 5) Seguridad de paths (contractual)

En servicios de export/projects/bundle se usa validación de path (`ensureInsideRoot`, `validatePathSegment`) para evitar traversal fuera de `exports/`.
