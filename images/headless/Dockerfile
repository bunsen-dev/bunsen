# Bunsen Headless Base Image
# Default base image for CLI agents with Python and Node.js
#
# This is the default image used when no base is specified in experiment.yaml.
# It includes Python 3.11 and Node.js 20 LTS for running most agents.

FROM ubuntu:22.04

LABEL maintainer="Bunsen"
LABEL description="Bunsen headless base image with Python and Node.js"

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install essential tools including tmux for recording
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    vim \
    jq \
    ca-certificates \
    build-essential \
    tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Python 3.11
RUN apt-get update && apt-get install -y \
    python3.11 \
    python3.11-venv \
    python3-pip \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Install asciinema 2.4.0 via pip (apt version is too old, lacks --cols/--rows flags)
RUN pip3 install asciinema==2.4.0

# Create standard directories
RUN mkdir -p /input /output /agent

# Set working directory
WORKDIR /input

# Default command
CMD ["/bin/bash"]
