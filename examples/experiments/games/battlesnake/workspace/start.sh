#!/usr/bin/env bash
# Launch contract: the scorer and self-test start your bot with this script and
# expect it to serve the Battlesnake API on $PORT (default 8000). If you rewrite
# your bot in another language, change this command — nothing else depends on it.
set -e
cd "$(dirname "$0")"
exec python3 main.py
