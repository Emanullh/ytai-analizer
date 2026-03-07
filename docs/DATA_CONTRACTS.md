# DATA CONTRACTS — ytai-analizer

Fuente de verdad para esta hoja:

- `apps/api/src/server.ts`
- `apps/api/src/types.ts`
- `apps/api/src/services/exportJobService.ts`
- `apps/api/src/services/exportService.ts`
- `apps/api/src/services/transcriptArtifactService.ts`
- `apps/api/src/services/projectsService.ts`
- `apps/api/src/services/exportBundleService.ts`
- `apps/api/src/services/videoFeatureRerunService.ts`
- `apps/api/src/services/rerunProjectFeaturesService.ts`
- `apps/api/src/services/rerunThumbnailsService.ts`
- `apps/api/src/analysis/orchestratorService.ts`
- `apps/web/src/types.ts`

## 1. Runtime y base URL

- API dev: `http://localhost:3001`
- Web dev: `http://localhost:5173`
- Proxy web: `/api/* -> http://localhost:3001/*` en `apps/web/vite.config.ts`
- Root efectivo de exports con los scripts del repo: `apps/api/exports/`

## 2. Reglas de validación repetidas

- `timeframe`: `"1m" | "6m" | "1y"`
- `channelId`: regex `^UC[\\w-]{22}$`
- `jobId` en export jobs: UUID
- `projectId` y `videoId` no aceptan `/`, `\\`, `..` ni paths absolutos cuando pasan por `projectsService.ts` / `exportBundleService.ts`
- `maxSegments`: entero `1..2000`
- `truncateChars`: entero `1..10000`

## 3. HTTP Endpoints

### 3.1 `GET /health`

Response `200`:

```json
{ "ok": true }
```

### 3.2 `POST /analyze`

Source files:

- `apps/api/src/server.ts`
- `apps/api/src/services/youtubeService.ts`
- `apps/api/src/types.ts`

Request:

```json
{
  "sourceInput": "https://www.youtube.com/@midudev",
  "timeframe": "6m"
}
```

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

### 3.3 `POST /export`

Notas:

- Es síncrono.
- La UI normal usa `POST /export/jobs`; este endpoint sigue existiendo para callers directos.

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

Response `200`:

```json
{
  "folderPath": "/abs/path/to/apps/api/exports/Canal_Demo",
  "warnings": [],
  "exportedCount": 2
}
```

### 3.4 `POST /export/jobs`

Request body: igual a `POST /export`.

Response `200`:

```json
{ "jobId": "uuid-v4" }
```

### 3.5 `GET /export/jobs/:jobId`

Response `200` (`ExportJobState`):

```json
{
  "jobId": "uuid-v4",
  "status": "running",
  "completed": 1,
  "total": 3,
  "warnings": [],
  "exportPath": "/abs/path/to/apps/api/exports/Canal_Demo",
  "error": "optional",
  "videoStages": {
    "video1": "transcribing",
    "video2": "queue"
  }
}
```

`status`: `queued | running | done | failed`

### 3.6 `GET /export/jobs/:jobId/events` (SSE)

Headers:

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`

Comportamiento:

- Reproduce historial del job.
- Luego empuja eventos live.
- Cierra en `job_done` o `job_failed`.

Wire format:

```text
event: <event_name>
data: <json>

```

Eventos emitidos por `apps/api/src/services/exportJobService.ts`:

- `job_started`

```json
{ "total": 12 }
```

- `video_progress`

```json
{ "videoId": "abc123", "stage": "transcribing", "percent": 35 }
```

- `job_progress`

```json
{ "completed": 4, "total": 12 }
```

- `warning`

```json
{ "videoId": "abc123", "message": "..." }
```

- `job_done`

```json
{ "exportPath": "/abs/path/to/apps/api/exports/Canal_Demo" }
```

- `job_failed`

```json
{ "message": "..." }
```

Stages válidos por video:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

### 3.7 `POST /export/rerun-orchestrator`

Source files:

- `apps/api/src/server.ts`
- `apps/api/src/services/rerunOrchestratorService.ts`
- `apps/api/src/analysis/orchestratorService.ts`

Request:

```json
{ "channelName": "Canal Demo" }
```

Prerequisitos validados:

- `apps/api/exports/<channelFolder>/channel.json`
- `apps/api/exports/<channelFolder>/raw/videos.jsonl`
- al menos un `apps/api/exports/<channelFolder>/derived/video_features/*.json`

Response `200`:

```json
{
  "ok": true,
  "exportPath": "/abs/path/to/apps/api/exports/Canal_Demo",
  "warnings": [],
  "usedLlm": true,
  "artifactPaths": [
    "/abs/path/to/apps/api/exports/Canal_Demo/analysis/orchestrator_input.json",
    "/abs/path/to/apps/api/exports/Canal_Demo/analysis/playbook.json",
    "/abs/path/to/apps/api/exports/Canal_Demo/derived/templates.json"
  ]
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

### 3.8 `GET /projects`

Response `200` (`ProjectsListItem[]`):

- `projectId`
- `channelId | null`
- `channelName | null`
- `exportVersion | null`
- `lastExportedAt | null`
- `lastJobId | null`
- `counts`
- `warningsCount`
- `status`: `ok | partial | failed | unknown`
- `warnings: string[]`

`counts`:

```json
{
  "totalVideosSelected": 12,
  "transcriptsOk": 10,
  "transcriptsMissing": 1,
  "transcriptsError": 1,
  "thumbnailsOk": 12,
  "thumbnailsFailed": 0
}
```

### 3.9 `GET /projects/:projectId`

Response `200` (`ProjectDetailResponse`):

- `projectId`
- `channel`
  - `channelId`
  - `channelName`
  - `sourceInput`
  - `timeframe`
  - `exportedAt`
  - `timeframeResolved`
- `manifest`: objeto completo o `null`
- `latestJob`: resumen o `null`
- `jobs[]`
  - `jobId`
  - `status`
  - `startedAt`
  - `finishedAt`
  - `durationMs`
  - `warningsCount`
  - `errorsCount`
  - `summaryPath`
  - `eventsPath`
  - `errorsPath`
  - `debugBundlePath`
- `artifacts`
  - `playbook`
  - `templates`
  - `channelModels`
- `warnings: string[]`

### 3.10 `GET /projects/:projectId/videos`

Response `200` (`ProjectVideoSummaryItem[]`):

- `videoId`
- `title`
- `publishedAt | null`
- `thumbnailPath | null`
- `transcriptStatus`: `ok | missing | error`
- `transcriptSource`: `captions | asr | none`
- `performance`
  - `viewsPerDay`
  - `engagementRate`
  - `residual`
  - `percentile`
- `hasLLM`
  - `title`
  - `description`
  - `transcript`
  - `thumbnail`
- `cacheHit`: `full | partial | miss | unknown | null`

### 3.11 `GET /projects/:projectId/videos/:videoId`

Query opcional:

- `maxSegments`
- `truncateChars`

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

### 3.12 `GET /projects/:projectId/artifacts/playbook`

Devuelve `analysis/playbook.json` o `404`.

### 3.13 `GET /projects/:projectId/artifacts/templates`

Devuelve `derived/templates.json` o `404`.

### 3.14 `GET /projects/:projectId/artifacts/channel_models`

Devuelve `derived/channel_models.json` o `404`.

### 3.15 `GET /projects/:projectId/thumb/:videoId`

Response:

- `Content-Type: image/jpeg`
- `Cache-Control: public, max-age=3600, immutable`

### 3.16 `GET /projects/:projectId/bundle/meta`

Query opcional:

- `export=latest`
- `export=<jobId>`

Response `200` (`ProjectBundleMetaResponse`):

- `projectId`
- `channelId`
- `exportJobId`
- `exportedAt`
- `timeframe`
- `timeframeResolved`
- `rawVideosMode`: `full | extract | missing`
- `rawVideosEntryPath`: `raw/videos.jsonl | raw/videos.extract.jsonl | null`
- `exemplarVideoIds: string[]`
- `includedFiles[]`
- `missingFiles[]`
- `estimatedSizeBytes`
- `estimatedSizeMb`
- `confirmationThresholdMb`
- `confirmationRequired`
- `availableSuccessfulExportJobIds`

### 3.17 `GET /projects/:projectId/bundle`

Descarga zip del último export o del export pedido por query `export`.

Headers:

- `Content-Type: application/zip`
- `Cache-Control: no-store`
- `Content-Disposition: attachment; filename="bundle_<project>_<jobId>_<timestamp>.zip"`

### 3.18 `GET /projects/:projectId/exports/:exportJobId/bundle`

Igual a `GET /projects/:projectId/bundle`, pero fijando el job explícitamente en la ruta.

### 3.19 `POST /projects/:projectId/videos/:videoId/rerun/:feature`

`feature`:

- `thumbnail`
- `title`
- `description`
- `transcript`

Request body:

```json
{ "mode": "full" }
```

`mode`:

- `collect_assets`
- `prepare`
- `full`

Response `200` (`RerunVideoFeatureResult`):

```json
{
  "ok": true,
  "projectId": "Canal_Demo",
  "videoId": "abc123",
  "feature": "title",
  "mode": "full",
  "warnings": [],
  "artifactPath": "derived/video_features/abc123.json",
  "stepsExecuted": ["collect_assets", "prepare", "full"],
  "preparedAssets": {}
}
```

### 3.20 `POST /projects/:projectId/rerun/features`

Request:

```json
{
  "feature": "title",
  "mode": "full",
  "scope": "all",
  "videoIds": ["abc123"]
}
```

`scope`:

- `all`
- `exemplars`
- `selected`

Response `200`:

```json
{ "jobId": "uuid-v4" }
```

### 3.21 `GET /projects/:projectId/rerun/features/jobs/:jobId`

Response `200` (`ProjectFeatureRerunJobState`):

```json
{
  "jobId": "uuid-v4",
  "projectId": "Canal_Demo",
  "feature": "title",
  "mode": "full",
  "status": "running",
  "total": 12,
  "completed": 4,
  "processed": 3,
  "failed": 1,
  "warnings": [],
  "auditArtifactPath": "logs/rerun_title_full_20260306T....json"
}
```

### 3.22 `GET /projects/:projectId/rerun/features/jobs/:jobId/events` (SSE)

Eventos:

- `job_started`

```json
{
  "jobId": "uuid-v4",
  "projectId": "Canal_Demo",
  "feature": "title",
  "mode": "full",
  "total": 12,
  "scope": "all"
}
```

- `video_progress`

```json
{
  "videoId": "abc123",
  "status": "processing"
}
```

`status`: `processing | done | failed`

- `job_progress`

```json
{
  "completed": 4,
  "total": 12,
  "processed": 3,
  "failed": 1
}
```

- `warning`

```json
{ "videoId": "abc123", "message": "..." }
```

- `job_done`

```json
{
  "projectId": "Canal_Demo",
  "feature": "title",
  "mode": "full",
  "completed": 12,
  "total": 12,
  "processed": 11,
  "failed": 1,
  "auditArtifactPath": "logs/rerun_title_full_20260306T....json"
}
```

- `job_failed`

```json
{ "message": "..." }
```

### 3.23 `POST /projects/:projectId/rerun/thumbnails`

Request:

```json
{
  "scope": "all",
  "videoIds": ["abc123"],
  "engine": "python",
  "force": false,
  "redownloadMissingThumbnails": false
}
```

`engine`: `python | auto`

Response `200`:

```json
{ "jobId": "uuid-v4" }
```

### 3.24 `GET /projects/:projectId/rerun/thumbnails/jobs/:jobId`

Response `200` (`RerunThumbnailsJobState`):

```json
{
  "jobId": "uuid-v4",
  "projectId": "Canal_Demo",
  "status": "running",
  "total": 12,
  "completed": 4,
  "processed": 2,
  "skipped": 1,
  "failed": 1,
  "warnings": [],
  "auditArtifactPath": "logs/rerun_thumbnails_20260306T....json"
}
```

### 3.25 `GET /projects/:projectId/rerun/thumbnails/jobs/:jobId/events` (SSE)

Eventos:

- `job_started`

```json
{
  "jobId": "uuid-v4",
  "projectId": "Canal_Demo",
  "total": 12,
  "scope": "all",
  "engine": "python",
  "force": false
}
```

- `video_progress`

```json
{
  "videoId": "abc123",
  "status": "skipped",
  "message": "..."
}
```

`status`: `processing | done | skipped | failed`

- `job_progress`

```json
{
  "completed": 4,
  "total": 12,
  "processed": 2,
  "skipped": 1,
  "failed": 1
}
```

- `warning`
- `job_done`
- `job_failed`

`job_done` incluye `auditArtifactPath`.

## 4. Export schema y filesystem contract

## 4.1 Root de salida

Con los comandos del repo:

```text
apps/api/exports/<channelFolder>/
```

`<channelFolder>` sale de `sanitizeFolderName(channelName)`.

## 4.2 `channel.json`

Source:

- `apps/api/src/types.ts::ExportPayload`
- `apps/api/src/services/exportService.ts`

Campos:

- `exportVersion`
- `exportedAt`
- `channelName`
- `channelId`
- `sourceInput`
- `timeframe`
- `timeframeResolved`
- `videos[]`

Cada `videos[]` (`ExportVideoRecord`) incluye:

- `videoId`
- `title`
- `viewCount`
- `publishedAt`
- `thumbnailPath`
- `transcript`
- `transcriptStatus`
- `transcriptSource`
- `transcriptPath`

Versión:

```text
exportVersion = "1.1"
```

## 4.3 `manifest.json`

Type local:

- `apps/api/src/services/exportService.ts::ExportManifestV1`

Campos:

- `jobId`
- `channelId`
- `channelFolder`
- `exportVersion`
- `exportedAt`
- `counts`
- `warnings`
- `artifacts`

`counts`:

- `totalVideosSelected`
- `transcriptsOk`
- `transcriptsMissing`
- `transcriptsError`
- `thumbnailsOk`
- `thumbnailsFailed`

## 4.4 `raw/channel.json`

Type local:

- `apps/api/src/services/exportService.ts::RawChannelExportV1`

Campos:

- `exportVersion`
- `exportedAt`
- `jobId`
- `channelId`
- `channelName`
- `sourceInput`
- `timeframe`
- `timeframeResolved`
- `channelStats`
- `provenance`

`provenance` incluye:

- `dataSources`
- `warnings`
- `env.LOCAL_ASR_ENABLED`
- `env.TRANSCRIPT_LANG`

## 4.5 `raw/videos.jsonl`

Cada línea es un `RawVideoRecordV1` desde `apps/api/src/services/exportService.ts`.

Campos relevantes:

- `videoId`
- `title`
- `description`
- `publishedAt`
- `durationSec`
- `categoryId`
- `tags`
- `defaultLanguage`
- `defaultAudioLanguage`
- `madeForKids`
- `liveBroadcastContent`
- `statistics`
- `thumbnails`
- `audioLocalPath`
- `thumbnailLocalPath`
- `thumbnailOriginalUrl`
- `transcriptRef`
- `daysSincePublish`
- `viewsPerDay`
- `likeRate`
- `commentRate`
- `warnings`

`transcriptRef`:

```json
{
  "transcriptPath": "raw/transcripts/<videoId>.jsonl",
  "transcriptSource": "asr",
  "transcriptStatus": "ok"
}
```

## 4.6 `raw/transcripts/<videoId>.jsonl`

Source:

- `apps/api/src/services/transcriptArtifactService.ts`

Registros permitidos:

- Meta record:

```json
{
  "type": "meta",
  "videoId": "abc123",
  "source": "asr",
  "status": "ok",
  "language": "es",
  "model": "large-v3-turbo",
  "computeType": "int8",
  "createdAt": "2026-03-06T00:00:00.000Z",
  "transcriptCleaned": true,
  "warning": "optional"
}
```

- Segment record:

```json
{
  "type": "segment",
  "i": 0,
  "startSec": 0,
  "endSec": 4.3,
  "text": "...",
  "confidence": 0.87
}
```

## 4.7 `raw/audio/<videoId>.mp3`

- Se escribe cuando el pipeline transcript descarga/reutiliza audio.
- Puede faltar si el transcript falló antes o si no se necesitó regenerar.

## 4.8 `raw/thumbnails/`

- Intenta ser symlink a `thumbnails/`.
- Si el symlink falla, el export copia los JPG.

## 4.9 `derived/video_features/<videoId>.json`

Source:

- `apps/api/src/services/exportService.ts`

Campos base:

```json
{
  "schemaVersion": "derived.video_features.v1",
  "videoId": "abc123",
  "computedAt": "2026-03-06T00:00:00.000Z",
  "performance": {}
}
```

El resto del objeto puede incluir `thumbnailFeatures`, `titleFeatures`, `descriptionFeatures`, `transcriptFeatures`.

## 4.10 `derived/channel_models.json`

Campos base:

```json
{
  "schemaVersion": "derived.channel_models.v1",
  "computedAt": "2026-03-06T00:00:00.000Z",
  "channelId": "UC...",
  "timeframe": "6m",
  "model": {}
}
```

## 4.11 `analysis/playbook.json`

Source:

- `apps/api/src/analysis/orchestratorService.ts::PlaybookArtifactV1`

Schema:

```text
analysis.playbook.v1
```

Se genera sólo cuando corre el orquestador manual.

## 4.12 `derived/templates.json`

Source:

- `apps/api/src/analysis/orchestratorService.ts::TemplatesArtifactV1`

Schema:

```text
derived.templates.v1
```

Se genera sólo cuando corre el orquestador manual.

## 4.13 `analysis/orchestrator_input.json`

- Lo genera `apps/api/src/analysis/orchestratorService.ts`.
- Es requerido por `apps/api/src/services/exportBundleService.ts` para armar el bundle.

## 4.14 `bundle.json`

Source:

- `apps/api/src/services/exportBundleService.ts`

Schema:

```text
analysis.cross_channel_bundle.v1
```

Campos:

- `schemaVersion`
- `generatedAt`
- `projectId`
- `channelId`
- `exportJobId`
- `exportedAt`
- `timeframe`
- `timeframeResolved`
- `rawVideosMode`
- `rawVideosEntryPath`
- `thresholds`
- `exemplarVideoIds`
- `filesIncluded`
- `filesMissing`

Notas:

- `rawVideosMode` puede ser `full`, `extract` o `missing`.
- Si `raw/videos.jsonl` pesa más que `EXPORT_BUNDLE_RAW_VIDEOS_MAX_BYTES`, el bundle usa `raw/videos.extract.jsonl`.
- Si faltan artifacts opcionales, el zip agrega `notes/missing_files.json`.

## 4.15 Logs de job

Ubicación:

```text
apps/api/exports/<channelFolder>/logs/
```

Archivos:

- `job_<jobId>.events.jsonl`
- `job_<jobId>.errors.jsonl`
- `job_<jobId>.summary.json`
- `job_<jobId>.debug_bundle.json` (opcional)

## 5. Notas de compatibilidad y huecos actuales

- El export principal no ejecuta el orquestador; deja un warning explícito y los artifacts `analysis/*` pueden no existir.
- El tipo `transcriptSource` en proyectos todavía acepta `captions`, pero el pipeline de export actual usa ASR local como camino efectivo.
- El backend expone rerun batch de thumbnails con SSE, pero la UI principal no lo consume hoy.
