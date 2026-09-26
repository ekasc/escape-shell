#!/usr/bin/env bash
# Installs the Escape desktop app into ~/Applications.
#
#   bun run install:app              # build, then install
#   bash scripts/install.sh --no-build  # install an existing build/Escape.app
#
# The bundle is ad-hoc signed so it launches locally without a Developer ID.
# For distribution to other machines, replace the ad-hoc signature with a real
# Developer ID and notarize (see the Packaging section of the README).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Escape"
BUILT_APP="$SHELL_DIR/build/$APP_NAME.app"
DEST="$HOME/Applications/$APP_NAME.app"

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

if [ "$BUILD" -eq 1 ]; then
  echo "==> building $APP_NAME.app"
  (cd "$SHELL_DIR" && bun run app)
fi

if [ ! -d "$BUILT_APP" ]; then
  echo "error: $BUILT_APP not found — run without --no-build" >&2
  exit 1
fi

echo "==> stopping any running $APP_NAME"
pkill -x "$APP_NAME" 2>/dev/null || true

mkdir -p "$HOME/Applications"

echo "==> installing to $DEST"
rm -rf "$DEST"
cp -R "$BUILT_APP" "$DEST"

# Ad-hoc sign so macOS (especially Apple Silicon) will launch a locally built,
# unsigned bundle. Sign the inner binaries first, then the outer bundle.
if command -v codesign >/dev/null 2>&1; then
  echo "==> ad-hoc signing"
  codesign --force --sign - "$DEST/Contents/Resources/bin/escape" >/dev/null 2>&1 || true
  codesign --force --sign - "$DEST/Contents/MacOS/escape-shell" >/dev/null 2>&1 || true
  codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true
fi

# Ask LaunchServices to forget any cached copy of the old app.
touch "$DEST"

echo "==> installed: $DEST"
echo "    launch with: open \"$DEST\""
