#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${REPO_ROOT}/.venv-asr"
REQ_FILE="${REPO_ROOT}/apps/api/scripts/requirements-asr.txt"

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "[asr:setup] Missing requirements file: ${REQ_FILE}" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "[asr:setup] Python 3 is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "[asr:setup] Creating venv at ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
else
  echo "[asr:setup] Reusing existing venv at ${VENV_DIR}"
fi

VENV_PYTHON="${VENV_DIR}/bin/python"
if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "[asr:setup] Missing venv python binary: ${VENV_PYTHON}" >&2
  exit 1
fi

"${VENV_PYTHON}" -m pip install --upgrade pip
"${VENV_PYTHON}" -m pip install -r "${REQ_FILE}"

echo "[asr:setup] ASR dependencies installed in ${VENV_DIR}"
echo "[asr:setup] Python path: ${VENV_PYTHON}"
