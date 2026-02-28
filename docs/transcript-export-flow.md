# Transcript Export Flow (SPARC SPEC + ARCH)

## SPEC

- `POST /analyze` (`apps/api/src/server.ts`) resuelve canal y lista videos, pero no descarga transcript.
- `POST /export` (`apps/api/src/server.ts`) llama `exportSelectedVideos` y ahí se construye `exports/<canal>/channel.json`.
- Integración correcta del transcript: dentro de `exportSelectedVideos`, por cada `selectedVideoId`, antes de persistir `channel.json`.
- Reglas de negocio:
  - nunca descargar video completo;
  - transcript es best effort;
  - el export nunca falla por transcript ausente o error recuperable;
  - `transcript` siempre string en JSON (si falla, `""`);
  - warning visible en UI vía `warnings` de la respuesta de `/export`.

## ARCH

Servicio dedicado: `apps/api/src/services/transcriptService.ts`

- API:
  - `getTranscript(videoId, opts?) -> { transcript, status, warning? }`
  - `status`: `"ok" | "missing" | "error"`
- Opciones:
  - `lang` (o `TRANSCRIPT_LANG` desde env)
  - `timeoutMs`
  - `maxRetries` (limitado para errores transitorios)
- Estrategia:
  - timeout por video;
  - retry corto para errores transitorios (429/network/timeout);
  - fallback de idioma si `TRANSCRIPT_LANG` no está disponible;
  - cache in-memory por `videoId + lang`.
- Integración en export:
  - concurrencia limitada (3 workers);
  - warnings agregados por video cuando `status !== "ok"`;
  - `channel.json` mantiene `transcript` (string) y agrega `transcriptStatus` opcional para diagnóstico.
