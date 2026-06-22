# Bunsen Visual Base Image
# Extends headless with Playwright + Chromium for visual scoring
#
# Use this base image when your experiment includes visual scorers:
#   base: bunsen/visual
#
# Size: ~1GB (includes Chromium browser)

FROM ubuntu:22.04

LABEL maintainer="Bunsen"
LABEL description="Bunsen visual base image with Playwright for visual scoring"

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install essential tools including tmux for recording (same as headless)
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    vim \
    jq \
    ca-certificates \
    build-essential \
    tmux \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install asciinema 2.4.0 via pip (apt version is too old, lacks --cols/--rows flags)
RUN pip3 install asciinema==2.4.0

# Install Node.js 20.x (LTS)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright dependencies (required for Chromium)
# These are the system libraries Playwright needs
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    fonts-liberation \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright globally and download Chromium
# Using npx ensures we get the matching browser version
RUN npm install -g playwright \
    && npx playwright install chromium \
    && npx playwright install-deps chromium

# Set Playwright to run in headless mode by default
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# Create standard directories
RUN mkdir -p /input /output /agent

# Set working directory
WORKDIR /input

# Default command
CMD ["/bin/bash"]
