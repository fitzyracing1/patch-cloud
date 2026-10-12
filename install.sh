#!/usr/bin/env bash
# install.sh — thin wrapper: npm install via patch-cloud registry
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PATCH_CLOUD_PORT:-4873}"
HOST="${PATCH_CLOUD_HOST:-127.0.0.1}"
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <package> [extra npm args...]" >&2
  exit 1
fi
exec node "$ROOT/install-with-cloud.mjs" "$@"
