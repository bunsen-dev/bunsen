# syntax=docker/dockerfile:1
#
# Headless OpenTTD 15.3 + OpenGFX 8.0 for the Bunsen flagship game experiment.
#
# We build OpenTTD from its pinned, sha256-verified *source* tarball (rather than
# the prebuilt Linux binary, which ships amd64-only) so the image is native on
# both linux/amd64 and linux/arm64 — no QEMU emulation on Apple-silicon hosts —
# and so the GPL-2.0 source offer is satisfied trivially (the source is right
# here in the build). One small, reviewable engine patch (engine/) lets the
# headless null-video driver launch the agent's bot; see that directory for why.
#
# OpenTTD is GPL-2.0-only and OpenGFX is GPL-2.0; both are freely redistributable,
# so this image can be built and published openly. The proprietary original
# Transport Tycoon Deluxe assets are NEVER bundled. See NOTICE.md.

ARG OPENTTD_VERSION=15.3
ARG OPENGFX_VERSION=8.0

# --------------------------------------------------------------------------- #
# Build OpenTTD from source (native to the build arch).
# --------------------------------------------------------------------------- #
FROM debian:bookworm-slim AS builder
ARG OPENTTD_VERSION
ARG OPENTTD_SOURCE_SHA256=5ea21eea7d59c78a42071924ac18c6bc0116088f2e96b14cfee9369175973be7
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget xz-utils patch \
      cmake g++ make pkg-config \
      liblzma-dev zlib1g-dev libzstd-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN wget -qO openttd-src.tar.xz \
      "https://cdn.openttd.org/openttd-releases/${OPENTTD_VERSION}/openttd-${OPENTTD_VERSION}-source.tar.xz" \
  && echo "${OPENTTD_SOURCE_SHA256}  openttd-src.tar.xz" | sha256sum -c - \
  && tar -xJf openttd-src.tar.xz && rm openttd-src.tar.xz
COPY engine/null-startup-commands.patch /tmp/null-startup-commands.patch
WORKDIR /src/openttd-${OPENTTD_VERSION}
RUN patch -p1 < /tmp/null-startup-commands.patch
# A dedicated/headless build needs no GUI video libraries; the null + dedicated
# drivers are always compiled in. Install under /usr so the binary lands at
# /usr/games/openttd and its data + the OpenGFX baseset share /usr/share/games/openttd.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DOPTION_DEDICATED=ON -DOPTION_TOOLS=OFF \
      -DCMAKE_INSTALL_PREFIX=/usr
RUN cmake --build build -j "$(nproc)"
RUN DESTDIR=/staging cmake --install build

# --------------------------------------------------------------------------- #
# Fetch + verify the OpenGFX baseset (arch-independent).
# --------------------------------------------------------------------------- #
FROM debian:bookworm-slim AS opengfx
ARG OPENGFX_VERSION
ARG OPENGFX_SHA256=43a0c1dabf39cb865394f3a6cc36d4da5c10ecfaaf55652043104806810903be
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget unzip \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /dl
RUN wget -qO opengfx.zip \
      "https://cdn.openttd.org/opengfx-releases/${OPENGFX_VERSION}/opengfx-${OPENGFX_VERSION}-all.zip" \
  && echo "${OPENGFX_SHA256}  opengfx.zip" | sha256sum -c - \
  && mkdir -p /opengfx && unzip -q opengfx.zip -d /opengfx

# --------------------------------------------------------------------------- #
# Runtime image.
# --------------------------------------------------------------------------- #
FROM debian:bookworm-slim AS runtime
LABEL org.opencontainers.image.title="bunsen-openttd"
LABEL org.opencontainers.image.licenses="GPL-2.0-only"
RUN apt-get update && apt-get install -y --no-install-recommends \
      liblzma5 zlib1g libzstd1 ca-certificates tini procps python3 \
  && rm -rf /var/lib/apt/lists/*

# OpenTTD binary (/usr/games/openttd) + data tree (/usr/share/games/openttd/...)
COPY --from=builder /staging/usr /usr
# OpenGFX baseset (OpenTTD reads the bundled .tar directly).
COPY --from=opengfx /opengfx /usr/share/games/openttd/baseset

# Bunsen scoring substrate: the verifier-owned reporter, the pinned config
# template, and the run harness. The reporter is staged into each run's ai/ dir
# by the harness — it is never editable from the agent's /workspace.
COPY reporter /opt/bunsen/reporter
COPY config/openttd.cfg.tmpl /opt/bunsen/openttd.cfg.tmpl
COPY harness/run_openttd.py /opt/bunsen/run_openttd.py
RUN printf '#!/bin/sh\n# Playtest your bot: runs the same deterministic sim the scorer uses, and snapshots\n# your bot to .openttd/last-good/ whenever it works, so the scorer can fall back to the\n# last working version if your final edit is left broken.\nOPENTTD_CHECKPOINT=1 exec python3 /opt/bunsen/run_openttd.py "$@"\n' \
      > /usr/local/bin/openttd-playtest \
  && chmod +x /usr/local/bin/openttd-playtest /opt/bunsen/run_openttd.py

# tini reaps cleanly; the actual command is supplied per-run (agent or scorer).
ENTRYPOINT ["/usr/bin/tini", "--"]
