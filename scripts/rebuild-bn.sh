#!/usr/bin/env bash
#
# Rebuild the local `bn` standalone binary from this repo and wire `bn` on PATH
# to it. Use this whenever you change runtime/CLI code and want the real
# standalone-binary UX (not `pnpm bn`) to pick it up.
#
# Why this is needed:
#   - The `bn` that ships globally (~/Library/pnpm/bn) is a SEPARATE stale install
#     pointing at another repo — it does NOT reflect changes built here.
#   - The standalone binary bundles @bunsen-dev/runtime, so a runtime change only
#     lands after `pnpm -r build` + rebuilding the binary.
#   - The binary caches its embedded assets under ~/.cache/bunsen/assets/<version>/
#     keyed by version, so a same-version rebuild won't refresh assets unless the
#     cache is cleared.
#
# This script does all of that, then symlinks ~/.local/bin/bn -> the fresh binary
# (~/.local/bin precedes ~/Library/pnpm on PATH, so it shadows the stale global bn).
#
# Usage:  scripts/rebuild-bn.sh [platform]
#   platform defaults to darwin-arm64 (also: darwin-x64, linux-x64, linux-arm64).

set -euo pipefail
cd "$(dirname "$0")/.."
PLATFORM="${1:-darwin-arm64}"

echo "==> pnpm -r build"
pnpm -r build

echo "==> building standalone binary ($PLATFORM)"
pnpm --filter @bunsen-dev/cli build:binary "$PLATFORM"

BIN="$PWD/packages/cli/dist/binaries/bn-$PLATFORM"
[ -x "$BIN" ] || { echo "error: $BIN not found/executable" >&2; exit 1; }

VERSION="$("$BIN" --version 2>/dev/null | tail -1)"
echo "==> clearing version-keyed asset cache for $VERSION (so same-version rebuilds take effect)"
rm -rf "$HOME/.cache/bunsen/assets/$VERSION" 2>/dev/null || true

mkdir -p "$HOME/.local/bin"
ln -sf "$BIN" "$HOME/.local/bin/bn"

echo
echo "✓ bn ($VERSION) -> $BIN"
echo "  which bn: $(command -v bn)"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "  ⚠ ~/.local/bin is not on PATH — add it (ahead of ~/Library/pnpm) so this 'bn' wins." ;;
esac
