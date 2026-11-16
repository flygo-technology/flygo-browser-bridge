#!/bin/sh
# Build flygo-browser-bridge-<version>.zip from src/ (for manual install).
set -e
cd "$(dirname "$0")/.."
v=$(python3 -c "import json;print(json.load(open('src/manifest.json'))['version'])")
mkdir -p dist
rm -f "dist/flygo-browser-bridge-$v.zip"
(cd src && zip -qr "../dist/flygo-browser-bridge-$v.zip" . -x '.*')
echo "dist/flygo-browser-bridge-$v.zip"
