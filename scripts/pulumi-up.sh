#!/usr/bin/env bash
# npm run up — pulumi up for infra/, behind scripts/with-secrets.sh in
# package.json, so DB_PASSWORD and PULUMI_CONFIG_PASSPHRASE come from the vault.
# State lives in a local file backend: no Pulumi account, no `pulumi login`.
set -euo pipefail
cd "$(dirname "$0")/../infra"

: "${PULUMI_BACKEND_URL:?is required, e.g. file://\$PWD/.pulumi (README, Grading)}"
case "$PULUMI_BACKEND_URL" in file://*) mkdir -p "${PULUMI_BACKEND_URL#file://}" ;; esac

pulumi stack select "${PULUMI_STACK:-dev}" --create --non-interactive >/dev/null
pulumi up --yes --non-interactive --skip-preview --suppress-progress "$@"
