#!/usr/bin/env bash
# npm run destroy — removes everything the program created; the stack stays
set -euo pipefail
cd "$(dirname "$0")/../infra"
: "${PULUMI_BACKEND_URL:?is required, e.g. file://\$PWD/.pulumi (README, Grading)}"
pulumi stack select "${PULUMI_STACK:-dev}" --non-interactive >/dev/null
pulumi destroy --yes --non-interactive --skip-preview --suppress-progress "$@"
