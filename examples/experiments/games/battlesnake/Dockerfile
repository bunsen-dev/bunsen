# Battlesnake experiment image — multi-stage.
#
# Stage 1 builds the official Battlesnake rules engine CLI from a pinned upstream
# tag. The engine is AGPL-3.0; we ship it UNMODIFIED and invoke it only as a
# subprocess (mere aggregation), so none of Bunsen's own code is AGPL-licensed.
# See THIRD_PARTY.md. The final image bakes only permissive (MIT/our own) code
# plus that unmodified binary.
#
# Builds for both linux/amd64 and linux/arm64 (pure-Go, CGO_ENABLED=0; Pillow
# ships manylinux wheels for both, so no compiler in the final image).

# ---- stage 1: build the engine from pinned source ----
FROM golang:1.21-bookworm AS engine
# Pinned to an immutable commit. RULES_SHA is the source of truth; the clone uses
# the tag for speed but FAILS the build if upstream ever moves the tag off this
# commit (so the binary always corresponds to RULES_SHA — the AGPL §6(d) source).
ARG RULES_VERSION=v1.2.3
ARG RULES_SHA=1940f03d40a2bf17fdd2643030e8518023c7471d
RUN git clone --depth 1 --branch ${RULES_VERSION} \
        https://github.com/BattlesnakeOfficial/rules.git /src \
    && test "$(git -C /src rev-parse HEAD)" = "${RULES_SHA}"
WORKDIR /src
RUN CGO_ENABLED=0 go build -trimpath -o /out/battlesnake ./cli/battlesnake \
    && /out/battlesnake --help >/dev/null

# ---- final image ----
FROM python:3.12-slim-bookworm

# Pillow (pinned) for the GIF renderer — wheels only, never compile.
RUN pip install --no-cache-dir --only-binary=:all: pillow==11.1.0

# Unmodified engine binary (AGPL-3.0, mere aggregation). Ship the AGPL license
# text AND a corresponding-source pointer INSIDE the image, traveling with the
# binary — required by AGPL §4/§6(d) for anyone who pulls the image without ever
# seeing the repo. (THIRD_PARTY.md alone does not discharge this for a pull-only
# recipient.)
COPY --from=engine /out/battlesnake /opt/battlesnake/bin/battlesnake
COPY --from=engine /src/LICENSE /opt/battlesnake/licenses/battlesnake-rules.AGPL-3.0.txt
RUN printf '%s\n' \
  'The /opt/battlesnake/bin/battlesnake binary is the official Battlesnake game' \
  'engine, built UNMODIFIED from upstream source:' \
  '' \
  '  repository: https://github.com/BattlesnakeOfficial/rules' \
  '  tag:        v1.2.3' \
  '  commit:     1940f03d40a2bf17fdd2643030e8518023c7471d' \
  '  build:      CGO_ENABLED=0 go build -trimpath -o battlesnake ./cli/battlesnake' \
  '' \
  'License: GNU AGPL-3.0 (full text in battlesnake-rules.AGPL-3.0.txt next to' \
  'this file). The Corresponding Source for this binary is the unmodified' \
  'upstream tree at the commit above. The engine is invoked only as a separate' \
  'subprocess; the rest of this image (Bunsen experiment code, Pillow) is' \
  'independently licensed and is not a derivative of the engine.' \
  > /opt/battlesnake/licenses/battlesnake-rules.SOURCE.txt

# Our runtime: shared lib, the VISIBLE sparring bots, and the self-test tool.
# (The HIDDEN scored ladder lives in verifiers/, mounted only in the scorer.)
COPY runtime/ /opt/battlesnake/

RUN chmod +x /opt/battlesnake/bin/battlesnake /opt/battlesnake/bin/* \
    && ln -s /opt/battlesnake/bin/battlesnake-selftest /usr/local/bin/battlesnake-selftest

ENV PATH="/opt/battlesnake/bin:${PATH}" \
    PYTHONPATH="/opt/battlesnake/lib" \
    BATTLESNAKE_BIN="/opt/battlesnake/bin/battlesnake" \
    BATTLESNAKE_SPARRING="/opt/battlesnake/sparring"

# AGPL-3.0 corresponding-source pointer for the bundled engine (immutable commit;
# in-image notices live under /opt/battlesnake/licenses/). See THIRD_PARTY.md.
LABEL org.battlesnake.rules.version="v1.2.3" \
      org.battlesnake.rules.commit="1940f03d40a2bf17fdd2643030e8518023c7471d" \
      org.battlesnake.rules.license="AGPL-3.0" \
      org.battlesnake.rules.source="https://github.com/BattlesnakeOfficial/rules/tree/1940f03d40a2bf17fdd2643030e8518023c7471d"
