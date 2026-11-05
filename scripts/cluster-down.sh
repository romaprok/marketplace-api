#!/usr/bin/env bash
# npm run cluster:down
set -euo pipefail
kind delete cluster --name marketplace
