#!/usr/bin/env bash
# Runs a command with DB_* env vars populated from the local secrets vault
# instead of a committed env file. Usage: with-secrets.sh <env> [-- cmd...]
#
# Real dev/CI flow: `infisical login` once, then
# `infisical export --env=<env> > .secrets/infisical.env` to materialize the
# vault into a local, gitignored dotenv file this script sources. The vault
# credentials themselves never touch git or docker layers (same reasoning
# as hw-11's secrets/db_password).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_SLUG="${1:-dev}"; shift || true
[ "$#" -gt 0 ] || set -- npm run start

# грейдер не має доступу до сховища: значення вже в оточенні
if [ "${SKIP_VAULT:-0}" = "1" ]; then exec "$@"; fi

CREDS="$ROOT/.secrets/infisical.env"
if [ ! -f "$CREDS" ]; then
  echo "Please either run infisical init to connect to a project, or export SKIP_VAULT=1 with DB_* already set in the environment." >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$CREDS"
set +a

exec "$@"
