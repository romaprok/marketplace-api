#!/usr/bin/env bash
# Usage: bash scripts/with-secrets.sh dev bash scripts/backup.sh
# pg_dump goes straight to the postgres service, not through PgBouncer: it is
# one long transaction, and the client has to match the server's major version
# (the host's pg_dump is often older).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"

# DB_URL is this project's name since hw-11; DATABASE_URL is what the
# course's grading template exports
URL="${DB_URL:-${DATABASE_URL:-}}"
: "${URL:?DB_URL (or DATABASE_URL) is not set, run this through scripts/with-secrets.sh}"

rest="${URL#*://}"
userinfo="${rest%%@*}"
DB_USER="${userinfo%%:*}"
DB_NAME="${rest#*/}"
DB_NAME="${DB_NAME%%\?*}"

# The vault keeps DB_URL without a password and the password in a file
# (hw-11). A dev URL with the password inline works too.
if [[ "$userinfo" == *:* ]]; then
  encoded="${userinfo#*:}"
  PASSWORD="$(printf '%b' "${encoded//%/\\x}")"
else
  : "${DB_PASSWORD_FILE:?DB_URL has no password, so DB_PASSWORD_FILE must be set}"
  PASSWORD="$(tr -d '\r\n' < "$DB_PASSWORD_FILE")"
fi

pg() { docker compose exec -T -e "PGPASSWORD=$PASSWORD" postgres "$@"; }

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/${DB_NAME}-$(date +%Y%m%d-%H%M%S).dump"
if [ -e "$out" ]; then
  echo "$out already exists (two backups in one second?), not overwriting it" >&2
  exit 1
fi

# Both files go under temporary names and are renamed only after the archive
# has been checked. A failed run must neither leave something that looks like
# the latest backup nor clobber the control file of an existing one.
trap 'rm -f "$out.partial" "$out.control.partial"' EXIT

pg psql -h postgres -U "$DB_USER" -d "$DB_NAME" -Atq -v ON_ERROR_STOP=1 -f - \
  < scripts/control.sql > "$out.control.partial"
pg pg_dump -h postgres -U "$DB_USER" -d "$DB_NAME" -Fc > "$out.partial"
if ! pg pg_restore --list < "$out.partial" > /dev/null; then
  echo "pg_dump produced an archive pg_restore can't read" >&2
  exit 1
fi
mv "$out.control.partial" "$out.control"
mv "$out.partial" "$out"

echo "backup created: $out ($(wc -c < "$out" | tr -d ' ') bytes)"
