#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "[test:live-agent] SKIP: OPENAI_API_KEY is not set."
  exit 0
fi

files=$(find tests/live -type f -name "*.test.ts" 2>/dev/null || true)
if [[ -z "${files}" ]]; then
  echo "[test:live-agent] SKIP: no live tests found under tests/live."
  exit 0
fi

echo "[test:live-agent] running live agent tests..."
node --import tsx --test ${files}
