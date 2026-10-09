#!/usr/bin/env bash
# Osama — one-command setup and run.
#
#   ./start.sh                 install → build → serve
#   ./start.sh --dev           dev mode (hot reload, no build)
#   ./start.sh --check         install + build + typecheck, then stop
#   ./start.sh --help          all options
#
# Fresh clone:
#   git clone https://github.com/mokmail/osama.git && cd osama && ./start.sh
#
# The actual work lives in scripts/start.mjs, so the same steps run on Windows
# (`node scripts/start.mjs`) and the logic can be linted as JavaScript. This
# wrapper only locates Node, gives a clear message when it is missing or too
# old, and then hands off.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed (or not on PATH)."
  echo
  echo "  Osama needs Node 20.10 or newer. Install it from https://nodejs.org"
  echo "  or, with nvm:  nvm install 22 && nvm use 22"
  exit 1
fi

# Check the major version here too, so an ancient Node fails with this message
# rather than a syntax error from start.mjs itself.
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${node_major:-0}" -lt 20 ] 2>/dev/null; then
  echo "✗ Node $(node -v) is too old — Osama needs 20.10 or newer."
  echo
  echo "  With nvm:  nvm install 22 && nvm use 22"
  exit 1
fi

exec node "$here/scripts/start.mjs" "$@"
