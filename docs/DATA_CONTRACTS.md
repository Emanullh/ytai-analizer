# DATA CONTRACTS — ytai-analizer

Fuente principal: código en `apps/api/src/*` y tipos en `apps/web/src/types.ts`.

## 1) API HTTP

Base local:

- API: `http://localhost:3001`
- Web dev proxy: `/api/*` -> `http://localhost:3001/*` (`apps/web/vite.config.ts`)

### 1.1 `GET /health`

Respuesta `200`:

```json
{
  "ok": true
}
```

Definición: `apps/api/src/server.ts`.

### 1.2 `POST /analyze`

Body:

```json
{
  "sourceInput": "https://www.youtube.com/@midudev",
  "timeframe": "6m"
}
```

Reglas de validación (`apps/api/src/server.ts`):

- `sourceInput`: string no vacío
- `timeframe`: enum `1m | 6m | 1y`

Respuesta `200` (`AnalyzeResult`, `apps/api/src/types.ts`):

```json
{
  "channelId": "UC...",
  "channelName": "Nombre canal",
  "sourceInput": "https://www.youtube.com/@midudev",
  "timeframe": "6m",
  "warnings": [],
  "videos": [
    {
      "videoId": "abc123",
      "title": "Video title",
      "publishedAt": "2025-01-01T00:00:00.000Z",
      "viewCount": 12345,
      "thumbnailUrl": "https://...jpg"
    }
  ]
}
```

Errores típicos:

- `400` body inválido / `sourceInput` inválido
- `404` canal no resoluble
- `500` falta `YOUTUBE_API_KEY`

### 1.3 `POST /export` (sincrónico)

Mismo body que `/export/jobs`.

Body:

```json
{
  "channelId": "UC1234567890123456789012",
  "channelName": "Canal Demo",
  "sourceInput": "https://www.youtube.com/@demo",
  "timeframe": "6m",
  "selectedVideoIds": ["video1", "video2"]
}
```

Validación (`apps/api/src/server.ts`):

- `channelId`: regex `^UC[\w-]{22}$`
- `channelName`: string no vacío
- `sourceInput`: string no vacío
- `timeframe`: `1m | 6m | 1y`
- `selectedVideoIds`: array no vacío de strings

Respuesta `200` (`apps/api/src/services/exportService.ts`):

```json
{
  "folderPath": "/abs/path/exports/Canal_Demo",
  "warnings": ["..."] ,
  "exportedCount": 2
}
```

### 1.4 `POST /export/jobs`

Crea job asíncrono y devuelve id.

Body: igual a `/export`.

Respuesta `200`:

```json
{
  "jobId": "uuid"
}
```

Implementación: `apps/api/src/services/exportJobService.ts`.

### 1.5 `GET /export/jobs/:jobId`

Parámetro:

- `jobId`: UUID válido

Respuesta `200` (`ExportJobState`):

```json
{
  "jobId": "uuid",
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

`status` enum: `queued | running | done | failed`.

### 1.6 `GET /export/jobs/:jobId/events` (SSE)

Headers de stream (`apps/api/src/server.ts`):

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `Connection: keep-alive`

Comportamiento:

- reenvía historial de eventos del job
- luego stream en vivo
- cierra en `job_done` o `job_failed`

Formato SSE por evento:

```text
event: <event_name>
data: <json>

```

## 2) Contrato SSE (eventos)

Definidos en:

- Backend: `apps/api/src/services/exportJobService.ts`
- Frontend: `apps/web/src/types.ts`

### 2.1 `job_started`

```json
{ "total": 10 }
```

### 2.2 `video_progress`

```json
{ "videoId": "abc123", "stage": "transcribing", "percent": 50 }
```

`percent` es opcional (hoy no siempre se usa).

Con pipeline concurrente, `percent` puede avanzar en saltos más granulares (sub-steps intercalados), pero sigue siendo opcional y no rompe contrato.

`stage` enum:

- `queue`
- `downloading_audio`
- `transcribing`
- `downloading_thumbnail`
- `writing_json`
- `done`
- `warning`
- `failed`

Política de stage cuando hay tareas simultáneas:

- `last-change-wins`: el backend emite el stage según el último cambio relevante.
- `transcribing` solo se emite cuando corre fetch de transcript real (captions/ASR), no en cache hit completo.

### 2.3 `job_progress`

```json
{ "completed": 4, "total": 10 }
```

### 2.4 `warning`

```json
{ "videoId": "abc123", "message": "..." }
```

`videoId` puede omitirse en warnings globales.

Notas de correlación:

- el backend puede emitir warnings técnicos con formato:
  - `ERR <scope>/<action> stepId=<id> (see logs/job_<jobId>.errors.jsonl)`
- `stepId` permite correlacionar SSE con logs persistentes del job.

### 2.5 `job_done`

```json
{ "exportPath": "/abs/path/exports/Canal_Demo" }
```

### 2.6 `job_failed`

```json
{ "message": "error detail" }
```

### 2.7 Variables ENV de concurrencia (backend)

Definidas en `apps/api/src/config/env.ts` y documentadas en `apps/api/.env.example`:

- `EXPORT_VIDEO_CONCURRENCY` (default `3`)
- `EXPORT_HTTP_CONCURRENCY` (default `6`)
- `EXPORT_ASR_CONCURRENCY` (default `LOCAL_ASR_MAX_CONCURRENCY`, típico `1`)
- `EXPORT_OCR_CONCURRENCY` (default `2`)
- `EXPORT_LLM_CONCURRENCY` (default `2`)
- `EXPORT_EMBEDDINGS_CONCURRENCY` (default `2`)
- `EXPORT_FS_CONCURRENCY` (default `6`)
- `EXPORT_FAIL_FAST` (default `false`)

## 3) Contrato `channel.json` (export)

Generado por: `apps/api/src/services/exportService.ts`.

Ruta final:

- `exports/<channel_folder>/channel.json`

### 3.1 Formato actual en runtime (`exportVersion: "1.1"`)

```json
{
  "exportVersion": "1.1",
  "exportedAt": "2026-02-28T16:00:00.000Z",
  "channelName": "Canal Demo",
  "channelId": "UC1234567890123456789012",
  "sourceInput": "https://www.youtube.com/@demo",
  "timeframe": "6m",
  "timeframeResolved": {
    "publishedAfter": "2025-08-28T16:00:00.000Z",
    "publishedBefore": "2026-02-28T16:00:00.000Z"
  },
  "videos": [
    {
      "videoId": "video1",
      "title": "Video 1",
      "viewCount": 1200,
      "publishedAt": "2025-01-01T00:00:00.000Z",
      "thumbnailPath": "thumbnails/video1.jpg",
      "transcript": "texto completo",
      "transcriptStatus": "ok",
      "transcriptSource": "captions",
      "transcriptPath": "raw/transcripts/video1.jsonl"
    }
  ]
}
```

### 3.2 Compatibilidad hacia atrás

- `channel.json` se mantiene en la misma ruta (`exports/<channel>/channel.json`).
- Se conservan todos los campos consumidos actualmente (`channelName`, `channelId`, `sourceInput`, `timeframe`, `videos[*]`).
- Se agregan campos no rompientes: `exportVersion`, `exportedAt`, `timeframeResolved`.
- En `videos[*]` se mantienen los campos previos y se agregan `transcriptSource` y `transcriptPath` como opcionales.
- Recomendación para consumidores tolerantes: ignorar campos desconocidos.

### 3.3 `manifest.json` (orquestación offline)

Ruta:

- `exports/<channel_folder>/manifest.json`

Formato:

```json
{
  "jobId": "uuid",
  "channelId": "UC1234567890123456789012",
  "channelFolder": "Canal_Demo",
  "exportVersion": "1.1",
  "exportedAt": "2026-02-28T16:00:00.000Z",
  "counts": {
    "totalVideosSelected": 2,
    "transcriptsOk": 1,
    "transcriptsMissing": 0,
    "transcriptsError": 1,
    "thumbnailsOk": 2,
    "thumbnailsFailed": 0
  },
  "warnings": ["..."],
  "artifacts": [
    "channel.json",
    "manifest.json",
    "raw/channel.json",
    "raw/videos.jsonl",
    "raw/transcripts/video1.jsonl",
    "raw/thumbnails/video1.jpg"
  ]
}
```

Reglas:

- `artifacts` contiene rutas **relativas** a `exports/<channel_folder>/`.
- No se permiten paths absolutos ni traversal (`..`).

### 3.4 Raw Pack v1

Estructura:

```text
exports/<channel_folder>/
  channel.json
  manifest.json
  logs/
    job_<jobId>.events.jsonl
    job_<jobId>.errors.jsonl
    job_<jobId>.summary.json
    job_<jobId>.debug_bundle.json (solo en failed)
  thumbnails/
    <videoId>.jpg
  raw/
    channel.json
    videos.jsonl
    transcripts/
      <videoId>.jsonl
    thumbnails/ -> ../thumbnails (symlink; fallback: copia)
```

### 3.5 Observabilidad de jobs (`logs/`)

Ruta:

- `exports/<channel_folder>/logs/`

Archivos:

- `job_<jobId>.events.jsonl`: timeline append-only de eventos.
- `job_<jobId>.errors.jsonl`: errores estructurados (con stacktrace + clasificación).
- `job_<jobId>.summary.json`: resumen final (`done|failed`).
- `job_<jobId>.debug_bundle.json`: bundle de debug cuando el job termina en `failed`.

Campos base por línea JSONL (`events/errors`):

- `ts` (ISO)
- `level` (`trace|debug|info|warn|error`)
- `jobId`
- `requestId`
- `stepId`
- `scope`
- `action`
- `videoId` (opcional)
- `stage` (opcional)
- `msg`
- `data` (opcional, redaccionada)

Campos extra en `errors.jsonl`:

- `error.name`
- `error.message`
- `error.stack`
- `error.code` (opcional)
- `error.kind` (clasificación: `network_timeout`, `rate_limited`, `fs_error`, etc.)
- `error.cause` (opcional)
- `retry` (opcional)

Privacidad:

- no se registran secretos (`YOUTUBE_API_KEY`, `OPENAI_API_KEY`, tokens, headers auth).
- prompts completos no se persisten; se permite hash + tamaño.

Búsqueda rápida:

```bash
# correlacionar warning SSE -> error log
rg "stepId=<id>" exports/<channel_folder>/logs/job_<jobId>.errors.jsonl

# filtrar por video
rg "\"videoId\":\"<videoId>\"" exports/<channel_folder>/logs/job_<jobId>.events.jsonl
```

#### 3.4.1 `raw/channel.json`

Campos:

- `channelId`, `channelName`, `sourceInput`, `timeframe`
- `timeframeResolved`
- `exportedAt`, `exportVersion`, `jobId`
- `channelStats` (si está disponible vía YouTube `channels.list`):
  - `subscriberCount`, `viewCount`, `videoCount`
  - `country`, `publishedAt`
  - `customUrl`, `handle` (si aplica)
- `provenance`:
  - `dataSources[]`
  - `warnings[]`
  - `env`: snapshot mínimo (`LOCAL_ASR_ENABLED`, `TRANSCRIPT_LANG`)

#### 3.4.2 `raw/videos.jsonl`

- Un JSON por línea con metadata cruda enriquecida por video (`videos.list` + pipeline local):
  - `videoId`
  - `title`
  - `description` (texto completo de YouTube; no truncado agresivo)
  - `publishedAt`
  - `durationSec` (derivado de `contentDetails.duration` ISO8601)
  - `categoryId`
  - `tags[]`
  - `defaultLanguage`, `defaultAudioLanguage`
  - `madeForKids`, `liveBroadcastContent`
  - `statistics`:
    - `viewCount`, `likeCount`, `commentCount`
  - `thumbnails`:
    - objeto por calidad (`default|medium|high|standard|maxres`) con `url`, `width`, `height` si viene
  - `thumbnailLocalPath` (`raw/thumbnails/<videoId>.jpg`)
  - `thumbnailOriginalUrl` (best thumbnail disponible)
  - `transcriptRef`:
    - `transcriptPath` (`raw/transcripts/<videoId>.jsonl`)
    - `transcriptSource` (`captions|asr|none`)
    - `transcriptStatus` (`ok|missing|error`)
  - Performance proxies deterministas:
    - `daysSincePublish` (calculado en export)
    - `viewsPerDay`
    - `likeRate`
    - `commentRate`
  - `warnings[]`

#### 3.4.3 `raw/transcripts/<videoId>.jsonl`

- JSONL multi-línea estable por video:
  - primera línea `meta`:
    - `type: "meta"`
    - `videoId`
    - `source` (`captions|asr|none`)
    - `status` (`ok|missing|error`)
    - `language` (`auto|es|en|...`)
    - `model` (`string|null`)
    - `computeType` (`string|null`)
    - `createdAt` (ISO)
    - `transcriptCleaned` (`boolean`)
    - `warning` (opcional)
  - líneas siguientes `segment` (0..n):
    - `type: "segment"`
    - `i`
    - `startSec` (`number|null`)
    - `endSec` (`number|null`)
    - `text`
    - `confidence` (`number|null`)
- Si transcript está `missing|error`, se escribe igualmente el archivo con la línea `meta` y sin segmentos.

### 3.5 Export Cache Index v1

Ruta:

- `exports/<channel_folder>/.cache/index.json`

Formato:

```json
{
  "schemaVersion": "cache.index.v1",
  "channelId": "UC1234567890123456789012",
  "channelFolder": "Canal_Demo",
  "updatedAt": "2026-03-02T12:00:00.000Z",
  "exportVersion": "1.1",
  "timeframes": {
    "1m": { "videos": {} },
    "6m": {
      "videos": {
        "video1": {
          "videoId": "video1",
          "lastUpdatedAt": "2026-03-02T12:00:00.000Z",
          "inputs": {
            "titleHash": "sha1",
            "descriptionHash": "sha1",
            "thumbnailHash": "sha1",
            "transcriptHash": "sha1",
            "transcriptSource": "captions",
            "asrConfigHash": "sha1",
            "ocrConfigHash": "sha1",
            "embeddingModel": "text-embedding-3-small",
            "llmModels": {
              "title": "gpt-5.2",
              "description": "gpt-5.2",
              "transcript": "gpt-5.2",
              "thumbnail": "gpt-5.2"
            }
          },
          "artifacts": {
            "rawTranscriptPath": "raw/transcripts/video1.jsonl",
            "thumbnailPath": "thumbnails/video1.jpg",
            "derivedVideoFeaturesPath": "derived/video_features/video1.json"
          },
          "status": {
            "rawTranscript": "ok",
            "thumbnail": "ok",
            "derived": "ok",
            "warnings": []
          }
        }
      }
    },
    "1y": { "videos": {} }
  }
}
```

Reglas de validez / invalidación:

- hit completo requiere existencia de:
  - `thumbnailPath`
  - `rawTranscriptPath`
  - `derivedVideoFeaturesPath`
- además, deben coincidir fingerprints (`titleHash`, `descriptionHash`, `transcriptHash`, `thumbnailHash`, configs/modelos).
- cambios de `ocrConfigHash` invalidan solo `thumbnailFeatures.deterministic` (modo parcial `ocr_only`).
- cambios de modelos LLM invalidan solo subcampos `*.llm` correspondientes.
- si `OPENAI_API_KEY` falta o `AUTO_GEN_ENABLED=false`, no invalida LLM cacheado existente.
- si antes `llm=null` y ahora hay API key, se permite upgrade de solo `*.llm` faltantes.
- seguridad:
  - paths en cache son siempre relativos
  - prohibidos paths absolutos o con `..`
  - validación anti-traversal sobre root `exports/`
  - escritura atómica de `index.json` (temp + rename)

### 3.6 Derived Features v1

Ruta:

- `exports/<channel_folder>/derived/video_features/<videoId>.json`

Formato mínimo estable:

```json
{
  "schemaVersion": "derived.video_features.v1",
  "videoId": "video1",
  "computedAt": "2026-03-02T12:00:00.000Z",
  "titleFeatures": {
    "deterministic": {
      "title_len_chars": 25,
      "title_len_words": 4,
      "caps_ratio": 0.66,
      "emoji_count": 0,
      "punct_count_total": 8,
      "question_mark_count": 1,
      "exclamation_count": 1,
      "colon_count": 1,
      "dash_count": 1,
      "paren_count": 2,
      "bracket_count": 2,
      "has_number": true,
      "number_count": 2,
      "leading_number": true,
      "pronoun_count": 0,
      "negation_count": 0,
      "certainty_count": 0,
      "hedging_count": 0,
      "title_keyword_coverage": 0.5,
      "title_keyword_early_coverage_30s": 0.33,
      "title_transcript_sim_cosine": null,
      "title_keyword_audit": {
        "title_tokens": ["token1", "token2"],
        "matched_in_transcript": ["token1"],
        "matched_in_early_window_30s": ["token1"],
        "early_window_mode": "timestamp_window_0_30s",
        "early_window_char_limit": null
      }
    },
    "llm": null
  },
  "descriptionFeatures": {
    "deterministic": {
      "desc_len_chars": 350,
      "desc_len_words": 62,
      "line_count": 8,
      "has_timestamps": true,
      "url_count": 3,
      "urls": [
        {
          "url": "https://example.com/resource",
          "domain": "example.com",
          "charStart": 120,
          "charEnd": 148,
          "isShortener": false
        }
      ],
      "domain_counts": [{ "domain": "example.com", "count": 2 }],
      "hashtag_count": 2,
      "mentions_count": 1,
      "cta_count": {
        "subscribe": 1,
        "like": 0,
        "comment": 0,
        "link": 1,
        "follow": 1,
        "newsletter": 0,
        "patreon": 0,
        "total": 3
      },
      "cta_in_first_200_chars": true,
      "title_desc_overlap_jaccard": 0.21,
      "title_desc_overlap_tokens": {
        "titleTokens": ["ai", "pipeline", "tutorial"],
        "hitTokens": ["ai", "tutorial"]
      },
      "has_sponsor_disclosure": true,
      "has_affiliate_disclosure": false,
      "has_credits_sources": true,
      "readability": {
        "metric": "fernandez_huerta",
        "score": 58.4
      },
      "evidence": {
        "sponsorDisclosureMatches": [{ "charStart": 200, "charEnd": 209, "snippet": "sponsored" }],
        "affiliateDisclosureMatches": [],
        "creditsSourcesMatches": [{ "charStart": 260, "charEnd": 267, "snippet": "Sources" }]
      }
    },
    "llm": null,
    "warnings": []
  },
  "transcriptFeatures": {
    "deterministic": {
      "hook_keyword_hit_time_sec": 12,
      "hook_keyword_hit_evidence": {
        "matchedToken": "tutorial",
        "segmentIndex": 3,
        "snippet": "this tutorial starts with"
      },
      "title_keyword_coverage": 0.66,
      "title_keyword_early_coverage_30s": 0.33,
      "promise_delivery_30s_score": null,
      "wpm_overall": 137.4,
      "wpm_0_30": 150,
      "wpm_30_120": 132.2,
      "wpm_last_30": 145.1,
      "wpm_variance": 58.15,
      "step_markers_count": 4,
      "list_markers_count": 2,
      "contrast_markers_count": 3,
      "story_markers_count": 5,
      "sentiment_mean": 0.12,
      "sentiment_std": 0.44,
      "sentiment_trend": -0.003,
      "emotion_peaks": [
        { "emotion": "joy", "segmentIndex": 5, "snippet": "amazing result", "score": 2 }
      ],
      "topic_shift_count": null
    },
    "llm": null,
    "warnings": []
  },
  "thumbnailFeatures": {
    "deterministic": {
      "thumbnailLocalPath": "thumbnails/video1.jpg",
      "fileSizeBytes": 45231,
      "imageWidth": 1280,
      "imageHeight": 720,
      "aspectRatio": 1.777778,
      "ocrText": "TOP 5 AI TOOLS",
      "ocrConfidenceMean": 0.86,
      "ocrBoxes": [
        { "x": 120, "y": 80, "w": 420, "h": 110, "confidence": 0.92, "text": "TOP 5" }
      ],
      "ocrCharCount": 14,
      "ocrWordCount": 4,
      "textAreaRatio": 0.12,
      "brightnessMean": 0.55,
      "contrastStd": 0.41,
      "colorfulness": 0.62,
      "sharpnessLaplacianVar": 0.29,
      "edgeDensity": 0.33,
      "thumb_ocr_title_overlap_jaccard": 0.5,
      "thumb_ocr_title_overlap_tokens": {
        "titleTokens": ["top", "5", "ai", "tools"],
        "ocrTokens": ["top", "5", "ai", "tools"],
        "overlapTokens": ["top", "5", "ai", "tools"]
      },
      "hasBigText": true
    },
    "llm": null,
    "warnings": []
  },
  "performance": {
    "daysSincePublish": 45,
    "viewsPerDay": 2143.25,
    "likeRate": 0.0412,
    "commentRate": 0.0038,
    "engagementRate": 0.045,
    "logViews": 11.477512,
    "residual": 0.183214,
    "percentile": 0.91
  }
}
```

Notas:

- `deterministic` se calcula siempre (sin LLM).
- `llm` puede ser `null` si `AUTO_GEN_ENABLED=false`, falta `OPENAI_API_KEY` o falla el worker.
- `descriptionFeatures.llm` se calcula con task AutoGen `description_classifier_v1`.
- `transcriptFeatures.llm` se calcula con task AutoGen `transcript_classifier_v1` sobre `segmentsSample` (no sobre transcript completo).
- `thumbnailFeatures.llm` se calcula con task AutoGen `thumbnail_classifier_v1` usando entrada multimodal (imagen + resumen determinista).
- `performance` se calcula de forma **100% determinista** sin llamadas de red:
  - proxies por video: `daysSincePublish`, `viewsPerDay`, `likeRate`, `commentRate`, `engagementRate`, `logViews`
  - score relativo por canal/timeframe: `residual`, `percentile`
- aunque haya cache por video, `performance.*` se recomputa en cada export porque depende del conjunto seleccionado/timeframe.
- cuando no hay suficientes videos (`n < 5`) no se ajusta modelo y `residual`/`percentile` quedan `null`.
- El archivo se genera durante el flujo normal de export (`POST /export` y `/export/jobs`) sin pasos extra en UI.
- Si no hay timestamps de transcript, `title_keyword_early_coverage_30s` usa fallback por prefijo de caracteres y lo documenta en `title_keyword_audit`.

### 3.7 Derived Channel Model v1

Ruta:

- `exports/<channel_folder>/derived/channel_models.json`

Formato:

```json
{
  "schemaVersion": "derived.channel_models.v1",
  "computedAt": "2026-03-02T12:00:00.000Z",
  "channelId": "UC1234567890123456789012",
  "timeframe": "6m",
  "model": {
    "type": "robust-linear",
    "formula": "log1p(viewCount) ~ log1p(daysSincePublish) + log1p(durationSec) + weekday + isShort",
    "coefficients": {
      "logDaysSincePublish": 0.61,
      "logDurationSec": 0.19,
      "weekday_1": 0.02,
      "weekday_2": -0.01,
      "weekday_3": 0.03,
      "weekday_4": 0.01,
      "weekday_5": -0.02,
      "weekday_6": -0.01,
      "isShort": 0.08
    },
    "intercept": 7.12,
    "fit": {
      "n": 42,
      "r2Approx": 0.58,
      "madResidual": 0.24,
      "notes": ["IRLS converged in 6 iterations"]
    }
  }
}
```

Reglas:

- modelo robusto por canal/timeframe (`IRLS + Huber`) sobre videos exportados.
- predictor `durationSec` se excluye o imputa conservadoramente cuando falta.
- `fit.notes` contiene warnings operativos (por ejemplo `n < 5` o missing duration).

### 3.8 Analysis Playbook v1

Ruta:

- `exports/<channel_folder>/analysis/playbook.json`

Formato:

```json
{
  "schemaVersion": "analysis.playbook.v1",
  "generatedAt": "2026-03-02T12:00:00.000Z",
  "channel": {
    "channelId": "UC1234567890123456789012",
    "channelName": "Canal Demo",
    "timeframe": "6m",
    "jobId": "uuid"
  },
  "warnings": [],
  "insights": [
    {
      "id": "insight-1",
      "title": "Texto en miniatura alto + residual positivo",
      "summary": "El cohorte con texto grande mostró mediana superior",
      "supported_by": ["video1", "video2"],
      "evidence_fields": [
        "thumbnailFeatures.deterministic.textAreaRatio",
        "thumbnailFeatures.deterministic.hasBigText",
        "performance.residual"
      ]
    }
  ],
  "rules": [],
  "keys": [],
  "evidence": {
    "cohorts": [],
    "drivers": [],
    "exemplars": {}
  }
}
```

Reglas de validación anti-alucinación:

- `schemaVersion` fijo: `analysis.playbook.v1`.
- todo `supported_by[]` debe existir en `rows[].videoId` del `orchestrator_input`.
- todo `evidence_fields[]` debe ser un path válido en el row plano (`performance.*`, `titleFeatures.*`, `thumbnailFeatures.*`, etc.).
- si falla validación de salida LLM, se degrada a fallback determinista (sin romper export).

### 3.9 Derived Templates v1

Ruta:

- `exports/<channel_folder>/derived/templates.json`

Formato:

```json
{
  "schemaVersion": "derived.templates.v1",
  "generatedAt": "2026-03-02T12:00:00.000Z",
  "channel": {
    "channelId": "UC1234567890123456789012",
    "channelName": "Canal Demo",
    "timeframe": "6m",
    "jobId": "uuid"
  },
  "warnings": [],
  "titleTemplates": [
    {
      "id": "title-1",
      "template": "How to {outcome} in {time}",
      "when_to_use": "Cuando el gancho se entrega en los primeros 30s",
      "supported_by": ["video1"],
      "evidence_fields": [
        "titleFeatures.deterministic.question_mark_count",
        "transcriptFeatures.deterministic.promise_delivery_30s_score"
      ]
    }
  ],
  "thumbnailTemplates": [],
  "scriptTemplates": []
}
```

Reglas:

- `schemaVersion` fijo: `derived.templates.v1`.
- mismas reglas anti-alucinación para `supported_by` y `evidence_fields`.
- con LLM deshabilitado/fallido: se escribe estructura vacía + `warnings`.

### 3.10 Orchestrator Input Audit v1 (opcional)

Ruta:

- `exports/<channel_folder>/analysis/orchestrator_input.json`

Contenido:

- payload reducido sin transcript completo (rows planos + cohorts + drivers + exemplars + channel model).
- `schemaVersion`: `analysis.orchestrator_input.v1`.
- fuente de evidencia para validar `supported_by`/`evidence_fields`.

## 4) Contratos internos de pipeline

`apps/api/src/services/taskScheduler.ts` aplica límites de concurrencia por tipo (`video/http/asr/ocr/llm/embeddings/fs`).
`apps/api/src/services/exportPlan.ts` construye/valida DAG por video antes de ejecutar tareas concurrentes.

### 4.1 Transcript pipeline

`apps/api/src/services/transcriptPipeline.ts`:

```ts
getTranscriptWithFallback(videoId, options?) => {
  transcript: string;
  status: "ok" | "missing" | "error";
  source: "captions" | "asr" | "none";
  warning?: string;
  language?: string;
  asrMeta?: { model?: string; computeType?: string };
  segments?: Array<{
    startSec: number | null;
    endSec: number | null;
    text: string;
    confidence: number | null;
  }>;
}
```

Garantía:

- siempre retorna `transcript` string (posible `""`)

### 4.1.1 DAG por video (export)

Dependencias explícitas (runtime + plan validator):

- `cache_check` primero.
- `transcript_fetch -> transcript_derived`.
- `transcript_fetch -> write_raw_transcript`.
- `thumbnail_download -> thumbnail_derived`.
- `description_derived` depende solo de metadata (`title/description`).
- estrategia de título fijada: `title_derived` espera transcript (`waitForTranscript=true`).

Fallback seguro:

- si `validatePlan(...)` detecta deps faltantes o ciclos, el video cae a ejecución secuencial y se emite warning.
- no se rompen endpoints ni contrato SSE.

### 4.2 ASR local

`apps/api/src/services/localAsrService.ts` + worker `apps/api/scripts/asr_worker.py`.

Eventos internos de stage:

- `downloading_audio`
- `transcribing`

Worker input (stdin JSON lines):

```json
{
  "id": "uuid",
  "videoId": "abc123",
  "outputMp3Path": "/abs/path/file.mp3",
  "language": "auto"
}
```

Worker output (stdout JSON lines):

- progreso:

```json
{ "id": "uuid", "event": "downloading_audio" }
```

```json
{ "id": "uuid", "event": "transcribing" }
```

- resultado ok:

```json
{
  "id": "uuid",
  "ok": true,
  "transcript": "...",
  "language": "es",
  "model": "large-v3-turbo",
  "computeType": "int8",
  "segments": [
    { "startSec": 0.0, "endSec": 4.2, "text": "hola", "confidence": null }
  ]
}
```

- resultado error:

```json
{ "id": "uuid", "ok": false, "error": "..." }
```

## 5) Side effects de filesystem

Desde `apps/api/src/services/exportService.ts`:

- crea `exports/`
- crea thumbnails en `exports/<canal>/thumbnails/`
- escribe `exports/<canal>/channel.json`
- escribe `exports/<canal>/manifest.json`
- escribe `exports/<canal>/logs/job_<jobId>.events.jsonl`
- escribe `exports/<canal>/logs/job_<jobId>.errors.jsonl`
- escribe `exports/<canal>/logs/job_<jobId>.summary.json`
- escribe `exports/<canal>/logs/job_<jobId>.debug_bundle.json` (si `job_failed`)
- escribe `exports/<canal>/analysis/orchestrator_input.json`
- escribe `exports/<canal>/analysis/playbook.json`
- escribe `exports/<canal>/derived/video_features/<videoId>.json`
- escribe `exports/<canal>/derived/channel_models.json`
- escribe `exports/<canal>/derived/templates.json`
- escribe `exports/<canal>/.cache/index.json`
- escribe `exports/<canal>/raw/channel.json`
- escribe `exports/<canal>/raw/videos.jsonl`
- escribe `exports/<canal>/raw/transcripts/<videoId>.jsonl`
- crea `exports/<canal>/raw/thumbnails` (symlink a `../thumbnails`, con fallback a copia)
- usa temporal `exports/.tmp/<jobId>/audio`
- limpia temporal al finalizar (success/error)

Sanitización de folder de canal:

- `apps/api/src/utils/sanitize.ts`

## 6) Cobertura de tests ligada a contratos

- `apps/api/tests/exportJobs.test.ts`: valida flujo jobs + SSE + `channel.json` + `manifest.json` + `raw/*`
- `apps/api/tests/exportCacheService.test.ts`: hit/miss/partial + upgrade LLM + invalidación granular por `ocrConfig`
- `apps/api/tests/orchestratorDeterministic.test.ts`: cohorts, rankings y drivers deterministas
- `apps/api/tests/orchestratorService.test.ts`: fallback + validación anti-alucinación + persistencia
- `apps/api/tests/transcriptPipeline.test.ts`: captions vs fallback ASR
- `apps/api/tests/transcriptService.test.ts`: retry/missing/error de captions
- `apps/api/tests/asrRuntime.test.ts`: resolución de python path (`ASR_PYTHON_PATH`, venv, fallback)
- `apps/web/src/exportJobState.test.ts`: reducer de modal con eventos SSE
