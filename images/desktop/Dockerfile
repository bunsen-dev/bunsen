# Bunsen Desktop Base Image
# A full desktop environment for visual agents (Phase 7)

FROM ubuntu:22.04

LABEL maintainer="Bunsen"
LABEL description="Bunsen desktop base image for visual agents"

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install essential tools and desktop environment
RUN apt-get update && apt-get install -y \
    # Core tools
    curl \
    wget \
    git \
    vim \
    jq \
    ca-certificates \
    build-essential \
    # Terminal recording
    tmux \
    # X11 and desktop
    xvfb \
    xfce4 \
    xfce4-terminal \
    dbus-x11 \
    # Browser
    firefox \
    # Screen capture
    ffmpeg \
    # Python
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install common Python packages
# asciinema 2.4.0 installed via pip (apt version is too old, lacks --cols/--rows flags)
RUN pip3 install --no-cache-dir \
    requests \
    httpx \
    anthropic \
    openai \
    pytest \
    pyyaml \
    playwright \
    asciinema==2.4.0

# Install Playwright browsers
RUN playwright install chromium firefox

# Create standard directories
RUN mkdir -p /input /output /agent

# Set display for Xvfb
ENV DISPLAY=:99

# Set working directory
WORKDIR /input

# Start script that initializes Xvfb
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Default command
CMD ["/start.sh"]
