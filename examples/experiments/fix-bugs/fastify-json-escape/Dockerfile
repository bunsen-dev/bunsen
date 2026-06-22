# Example: Custom Dockerfile for an experiment
# Use this pattern when you need more control than base: + setup: provides

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI (required for claude-sdk-agent)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

# Note: The workspace directory will be mounted with the experiment's workspace/
# The agent code will be mounted at /agent/
