# OCR Python (thumbnails)

Este proyecto soporta OCR moderno para thumbnails con worker Python (`apps/api/scripts/ocr_worker.py`) usando:

- `paddleocr` + `opencv-python-headless` (preferido)
- fallback a `easyocr` solo si está instalado

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

Si el engine Python no está disponible o falla, el pipeline usa fallback a `tesseract.js` para no romper el export.
