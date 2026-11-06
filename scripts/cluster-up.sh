#!/usr/bin/env bash
# npm run cluster:up — a one-node kind cluster plus the image loaded into it.
# An image built on the host does not exist inside the cluster until it is
# loaded; without this the pod hangs in ErrImagePull. Run it again after every
# image rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER=marketplace
IMAGE=${IMAGE:-marketplace-api:hw28}

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --config k8s/kind-config.yaml --wait 120s
fi

# docker save + image-archive: `kind load docker-image` trips over Docker's
# containerd image store, the archive path works with both stores
archive=$(mktemp -t marketplace-image.XXXXXX)
trap 'rm -f "$archive"' EXIT
docker save "$IMAGE" -o "$archive"
kind load image-archive "$archive" --name "$CLUSTER"
echo "cluster $CLUSTER is up, $IMAGE loaded"
