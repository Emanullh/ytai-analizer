# Estado actual del step OCR

Fecha de análisis: 2026-03-05

## Skills de Claude Flow utilizadas

- `agent-code-analyzer`: para mapear implementación real del step OCR en código.
- `verification-quality`: para validar consistencia del flujo y evidencias (archivos/líneas) antes del reporte.

## 1) Librerías utilizadas en el step OCR

### OCR core

- `tesseract.js` (`^7.0.0`): motor OCR principal.
  - Evidencia: `apps/api/package.json`, `apps/api/src/derived/ocr/tesseractOcr.ts:113`.

### Preprocesado/estadística de imagen que acompaña al OCR

- `sharp` (`^0.34.5`): lectura de metadata y procesamiento RGB/downscale para señales visuales que se guardan junto a OCR.
  - Evidencia: `apps/api/package.json`, `apps/api/src/derived/vision/imageStats.ts:1`, `apps/api/src/derived/thumbnailFeaturesAgent.ts:4`.

### Infraestructura interna relevante

- `node:crypto` (`sha1`) para cache de resultados OCR por hash de imagen.
  - Evidencia: `apps/api/src/derived/ocr/tesseractOcr.ts:1`, `apps/api/src/derived/ocr/tesseractOcr.ts:166`.
- `node:fs` para lectura de imagen y persistencia de artefactos derivados.
  - Evidencia: `apps/api/src/derived/ocr/tesseractOcr.ts:2`, `apps/api/src/derived/thumbnailFeaturesAgent.ts:1`.

## 2) Flujo actual del OCR (end-to-end)

1. Se configura el scheduler con cola dedicada `ocr` usando `EXPORT_OCR_CONCURRENCY`.
   - Evidencia: `apps/api/src/config/env.ts:80`, `apps/api/src/services/exportService.ts:926`.

2. En planeación por video, `thumbnail_derived` se tipa como `ocr` cuando hay thumbnail deterministic sin LLM.
   - Evidencia: `apps/api/src/services/exportPlan.ts:160`.

3. El cache calcula `ocrConfigHash` con `THUMB_OCR_LANGS` y `THUMB_VISION_DOWNSCALE_WIDTH`; si cambia, fuerza recomputación `ocr_only`.
   - Evidencia: `apps/api/src/services/exportCacheService.ts:509`, `apps/api/src/services/exportCacheService.ts:759`.

4. Al ejecutar features de thumbnail, el servicio emite eventos `ocr_start`/`ocr_done` y corre la tarea bajo tipo `ocr` (o `llm`/`fs` según plan).
   - Evidencia: `apps/api/src/services/exportService.ts:1553`, `apps/api/src/services/exportService.ts:1620`.

5. Persistencia de features:
   - `persistThumbnailFeaturesArtifact()` decide `full` vs `ocr_only`.
   - llama `computeDeterministic()` o `computeDeterministicOcrOnly()`.
   - Evidencia: `apps/api/src/derived/thumbnailFeaturesAgent.ts:904`.

6. En deterministic:
   - obtiene metadata con `sharp`.
   - calcula señales visuales (`brightness`, `contrast`, `edgeDensity`, etc.).
   - ejecuta OCR con `runOcr()` si `THUMB_OCR_ENABLED=true`.
   - Evidencia: `apps/api/src/derived/thumbnailFeaturesAgent.ts:404`, `apps/api/src/derived/thumbnailFeaturesAgent.ts:431`.

7. `runOcr()`:
   - respeta flag `THUMB_OCR_ENABLED`.
   - hace hash de imagen y usa cache local + dedupe in-flight.
   - reutiliza worker por idioma (`THUMB_OCR_LANGS`).
   - carga `tesseract.js` dinámicamente y ejecuta `createWorker(...).recognize(...)`.
   - normaliza texto, cajas, confianza media.
   - Evidencia: `apps/api/src/derived/ocr/tesseractOcr.ts:113`, `apps/api/src/derived/ocr/tesseractOcr.ts:131`, `apps/api/src/derived/ocr/tesseractOcr.ts:157`, `apps/api/src/derived/ocr/tesseractOcr.ts:211`.

8. Post-proceso OCR:
   - limita `ocrBoxes` a 50 por prioridad de confianza/área.
   - calcula `ocrWordCount`, `textAreaRatio`, overlap título vs OCR (jaccard), `hasBigText`.
   - Evidencia: `apps/api/src/derived/thumbnailFeaturesAgent.ts:431`, `apps/api/src/derived/thumbnailFeaturesAgent.ts:447`.

9. Se guarda en `derived/video_features/<videoId>.json` dentro de `thumbnailFeatures.deterministic`.
   - Evidencia: `apps/api/src/derived/thumbnailFeaturesAgent.ts:893`.

10. La UI muestra OCR en tooltip del thumbnail (`ocrText`, `hasBigText`, `archetype`).
    - Evidencia: `apps/web/src/pages/ProjectDetail.tsx:907`, `apps/web/src/pages/ProjectDetail.tsx:922`.

## 3) Design system implementado para esta parte (OCR en UI)

### Estado actual

- No hay un design system formal dedicado al OCR (no se ve librería tipo MUI/Chakra/Ant ni token system extendido en Tailwind).
- Sí hay un UI system liviano basado en Tailwind + componentes propios reutilizables.

### Base visual/técnica usada

- `tailwindcss` como capa de estilos utilitaria.
  - Evidencia: `apps/web/package.json:27`, `apps/web/src/index.css:1`.
- Primitivos CSS propios:
  - `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.panel`.
  - Evidencia: `apps/web/src/index.css:33`.
- Componentes reutilizables:
  - `Badge`, `Tooltip`, `Section`, `StatCard`.
  - Evidencia: `apps/web/src/components/Badge.tsx:18`, `apps/web/src/components/Tooltip.tsx:52`, `apps/web/src/components/Section.tsx:10`.

### Aplicación específica en OCR

- El OCR se presenta en un `Tooltip` custom (portal + posicionamiento manual) dentro de `ProjectDetail`.
- Estilos por utilidades (`text-slate-*`, `rounded-*`, `border-*`) sin componente OCR específico ni tokens semánticos para OCR states.
- Conclusión: hay un design system utilitario y consistente a nivel general, pero para OCR la UI está implementada como composición ad hoc dentro de la página.

## 4) Resumen corto

- OCR actual: funcional, cacheado por hash, controlado por flags/env y con cola dedicada de concurrencia.
- Librería OCR: `tesseract.js`.
- Complementos del step: `sharp` + métricas visuales determinísticas.
- UI OCR: visible en tooltip de thumbnail; no existe un componente o patrón de design system específico para OCR.
