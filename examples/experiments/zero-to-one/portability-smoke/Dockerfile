FROM debian:bookworm-slim

# Deliberately spartan. No Node, no Python, no Bunsen conveniences.
# The asymmetric-ownership story says agents work here because they
# walk in self-contained via install.deps.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      ca-certificates \
      bash \
      tmux \
      curl \
      procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
