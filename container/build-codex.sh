#!/bin/bash
# Build the HappyClaw Codex container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BASE_IMAGE="${BASE_IMAGE:-happyclaw-agent:latest}"
IMAGE_NAME="${IMAGE_NAME:-happyclaw-codex}"
TAG="${1:-latest}"

if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Base image ${BASE_IMAGE} not found, building it first..."
  "$SCRIPT_DIR/build.sh"
fi

echo "Building HappyClaw Codex container image..."
echo "Base image: ${BASE_IMAGE}"
echo "Image: ${IMAGE_NAME}:${TAG}"

docker build \
  --progress=plain \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --build-arg CACHEBUST="$(date +%s)" \
  -f Dockerfile.codex \
  -t "${IMAGE_NAME}:${TAG}" \
  .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

touch "$SCRIPT_DIR/../.docker-build-codex-sentinel"
