#!/usr/bin/env bash
# Order matters: ALTER ROLE first (the DB is the source of truth), only then
# the secret file, then pg_terminate_backend so the pool is forced to open
# new connections that pick up the new password via the pg.Pool callback.
set -euo pipefail

DB_USER="${DB_USER:-marketplace}"
DB_NAME="${DB_NAME:-marketplace}"
SECRET_FILE="${DB_PASSWORD_FILE:-./secrets/db_password}"
COMPOSE_SERVICE="${POSTGRES_SERVICE:-postgres}"

psql_in_container() {
  docker compose exec -T "$COMPOSE_SERVICE" env PGPASSWORD="$1" \
    psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "$2"
}

if [ ! -f "$SECRET_FILE" ]; then
  echo "Secret file not found: $SECRET_FILE (did you copy secrets/db_password.example?)" >&2
  exit 1
fi

CURRENT_PASSWORD="$(cat "$SECRET_FILE")"
NEW_PASSWORD="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-32)"

echo "Rotating password for role \"$DB_USER\" (service: $COMPOSE_SERVICE) ..."

psql_in_container "$CURRENT_PASSWORD" "ALTER ROLE ${DB_USER} WITH PASSWORD '${NEW_PASSWORD}';"

printf '%s' "$NEW_PASSWORD" > "$SECRET_FILE"
echo "Secret file updated: $SECRET_FILE"

psql_in_container "$NEW_PASSWORD" \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${DB_USER}' AND pid <> pg_backend_pid();"

echo "Rotation complete. The app does not need to be restarted."
