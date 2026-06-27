# Licensing notice — OpenTTD experiment image

This experiment builds a Docker image containing third-party, freely-redistributable software. None
of it is covered by Bunsen's PolyForm Shield license; each component keeps its own upstream license.

| Component | Version | License | Source |
|-----------|---------|---------|--------|
| **OpenTTD** engine | 15.3 | **GPL-2.0-only** | <https://github.com/OpenTTD/OpenTTD> · built from the pinned, sha256-verified `openttd-15.3-source.tar.xz` on `cdn.openttd.org` |
| **OpenGFX** baseset | 8.0 | **GPL-2.0** | <https://github.com/OpenTTD/OpenGFX> · `opengfx-8.0-all.zip` on `cdn.openttd.org` |

## GPL compliance

The image is built **from OpenTTD's published source tarball** (see [`Dockerfile`](./Dockerfile)), so
the corresponding source travels with the build — the GPL-2.0 source-offer obligation is satisfied
trivially. We apply **one small engine modification** (see [`engine/`](./engine/)); that patch is
included here in full as a unified diff, which is itself the offer of the modified source under
GPL-2.0. OpenGFX is bundled unmodified.

## What is deliberately NOT included

The **proprietary original Transport Tycoon Deluxe** graphics/sound/music (`TRG1.GRF`, `SAMPLE.CAT`,
etc.) are **never** bundled. The game runs fully on the free OpenGFX baseset. OpenMSX (music) and
OpenSFX (sound) are not installed — they are irrelevant to a headless run.

## Redistribution

OpenTTD (GPL-2.0) and OpenGFX (GPL-2.0) may be freely redistributed, so this image can be built and
published openly. If you publish the image, also make this source directory (including the engine
patch and Dockerfile) available to recipients to satisfy GPL-2.0 §3.
