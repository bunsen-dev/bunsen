#!/bin/sh
# Bunsen CLI installer — https://bunsen.dev
#
#   curl -fsSL https://bunsen.dev/install.sh | sh
#
# Downloads the standalone `bn` binary for your OS/arch from GitHub Releases,
# verifies its sha256, and installs it onto your PATH. No Node, no `npm i` — the
# binary embeds its own runtime. You DO need a running Docker daemon for `bn run`
# (first run pulls a couple of container images); `bn doctor` checks for it.
#
# Env overrides:
#   BUNSEN_VERSION=v0.2.0   install a specific tag (default: latest)
#   BUNSEN_INSTALL_DIR=...  install dir (default: $HOME/.local/bin)
#
# SPDX-FileCopyrightText: 2026 Matthew Job Granmoe
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
set -eu

REPO="bunsen-dev/bunsen"
INSTALL_DIR="${BUNSEN_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${BUNSEN_VERSION:-latest}"

info()  { printf '\033[0;36m=>\033[0m %s\n' "$1"; }
warn()  { printf '\033[0;33m!\033[0m  %s\n' "$1" >&2; }
die()   { printf '\033[0;31mx\033[0m  %s\n' "$1" >&2; exit 1; }

# --- detect platform --------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Windows detected. Install via Scoop instead: scoop install bunsen (see https://bunsen.dev/docs)." ;;
  *) die "Unsupported OS: $os" ;;
esac

case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) die "Unsupported architecture: $arch" ;;
esac

asset="bn-${os}-${arch}"

# --- pick a downloader ------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
else
  die "Need curl or wget to download."
fi

# --- sha256 tool ------------------------------------------------------------
if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | awk '{print $1}'; }
else
  sha256() { echo ""; }  # verification skipped if no tool (warned below)
fi

# --- resolve release URLs ---------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

info "Downloading ${asset} (${VERSION})…"
dl "${base}/${asset}" "${tmp}/${asset}" \
  || die "Download failed. No ${asset} asset for ${VERSION} — see https://github.com/${REPO}/releases"

# --- verify checksum --------------------------------------------------------
if dl "${base}/SHA256SUMS" "${tmp}/SHA256SUMS" 2>/dev/null; then
  expected="$(awk -v a="$asset" '$2==a {print $1}' "${tmp}/SHA256SUMS")"
  actual="$(sha256 "${tmp}/${asset}")"
  if [ -z "$actual" ]; then
    warn "No sha256 tool found — skipping checksum verification."
  elif [ -z "$expected" ]; then
    warn "SHA256SUMS has no entry for ${asset} — skipping verification."
  elif [ "$expected" != "$actual" ]; then
    die "Checksum mismatch for ${asset} (expected ${expected}, got ${actual}). Aborting."
  else
    info "Checksum verified."
  fi
else
  warn "No SHA256SUMS published for ${VERSION} — skipping checksum verification."
fi

# --- install ----------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
chmod +x "${tmp}/${asset}"
# Strip the quarantine bit curl sets on macOS. Until the binary is notarized
# (Phase 2 / Homebrew cask), this is what lets the freshly-downloaded unsigned
# binary launch without a Gatekeeper prompt.
if [ "$os" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "${tmp}/${asset}" >/dev/null 2>&1 || true
fi
mv -f "${tmp}/${asset}" "${INSTALL_DIR}/bn"
info "Installed bn → ${INSTALL_DIR}/bn"

# --- PATH + prerequisite hints ---------------------------------------------
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *) warn "${INSTALL_DIR} is not on your PATH. Add this to your shell profile:"
     printf '       export PATH="%s:$PATH"\n' "$INSTALL_DIR" >&2 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker was not found. Bunsen runs experiments in containers — install Docker and start the daemon before 'bn run'."
fi

printf '\n'
info "Done. Next: run \033[1mbn doctor\033[0m to verify your environment."
