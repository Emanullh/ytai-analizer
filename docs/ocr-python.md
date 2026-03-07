# OCR Python (thumbnails)

Este proyecto soporta OCR moderno para thumbnails con worker Python (`apps/api/scripts/ocr_worker.py`) usando:

- `paddleocr` + `opencv-python-headless` (preferido)
- fallback a `easyocr` solo si está instalado

Para thumbnails, el worker desactiva el preprocesado documental de Paddle (`doc orientation`, `unwarping`, `textline orientation`) porque no aporta valor en miniaturas y agrega rutas de inferencia más frágiles.

## Instalación

Con el venv del repo (`.venv-asr`):

```bash
source .venv-asr/bin/activate
python -m pip install -r apps/api/scripts/requirements-ocr.txt
```

## Variables de entorno (API)

```bash
THUMB_OCR_ENABLED=true
THUMB_OCR_ENGINE=python
THUMB_OCR_LANGS=eng
THUMB_VISION_DOWNSCALE_WIDTH=960
OCR_PYTHON_PATH=
```

Resolución de Python para OCR:

1. `OCR_PYTHON_PATH`
2. `ASR_PYTHON_PATH`
3. `.venv-asr` del repo
4. `python3`/`python` por plataforma

## Health check rápido

```bash
python -c "import cv2; import importlib.util as u; assert (u.find_spec('paddleocr') or u.find_spec('easyocr'))"
```

## Comportamiento de fallback

Si `PaddleOCR` falla en runtime y `easyocr` está instalado, el worker intenta `easyocr` antes de devolver error.

Si el engine Python no está disponible o ambos backends fallan, el pipeline usa fallback a `tesseract.js` para no romper el export.

## Nota de Windows

En Windows, `PaddleOCR 3.x` habilita `MKLDNN/oneDNN` por defecto. Eso puede romper OCR de thumbnails con errores como:

`ConvertPirAttribute2RuntimeAttribute not support [pir::ArrayAttribute<pir::DoubleAttribute>]`

Por eso el worker desactiva `enable_mkldnn` en Windows al crear `PaddleOCR`.
