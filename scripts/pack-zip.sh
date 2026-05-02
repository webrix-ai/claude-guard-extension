#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
DIST_DIR="dist"
ZIP_NAME="webrix-guard-v${VERSION}.zip"

mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/$ZIP_NAME"

zip -r "$DIST_DIR/$ZIP_NAME" \
  manifest.json \
  background.js \
  content.js \
  interceptor.js \
  rules.js \
  storage.js \
  popup.html \
  popup.css \
  popup.js \
  dashboard.html \
  dashboard.css \
  dashboard.js \
  FullLogoW.svg \
  FullLogoB.svg \
  icons/

echo "Packed $DIST_DIR/$ZIP_NAME"
