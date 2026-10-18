#!/usr/bin/env bash
# Install dependencies (if needed) and start Marble Lab.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm install
fi
npm start
