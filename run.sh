#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  uv venv --python 3.11 .venv
fi
if ! .venv/bin/python -c 'import fastapi, ultralytics, scipy' >/dev/null 2>&1; then
  uv pip install --python .venv/bin/python -r requirements.lock.txt
fi
exec .venv/bin/python -m uvicorn backend.server:app --host 127.0.0.1 --port "${CYCLONE_PORT:-4173}"
