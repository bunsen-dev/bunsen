#!/usr/bin/env bash
# Run after building the image: bash images/visual/test.sh [image:tag]
set -euo pipefail

test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
image=${1:-bunsen/visual:latest}

docker run --rm \
  --mount "type=bind,source=$test_dir/test.cjs,target=/visual-image-test.cjs,readonly" \
  "$image" bash -euc '
    useradd --create-home --uid 1000 bunsen
    for scorer_user in bunsen root; do
      runuser -u "$scorer_user" -- node /visual-image-test.cjs
    done
  '
