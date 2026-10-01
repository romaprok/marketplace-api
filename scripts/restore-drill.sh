#!/usr/bin/env bash
# Usage: bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
# Restores the newest dump into a throwaway postgres container and compares
# the control value stored next to the dump with the one from the restored copy.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
IMAGE="${DRILL_IMAGE:-postgres:16-alpine}"
NAME="marketplace-restore-drill-$$"

# perl instead of `date +%s%N`: bash 3.2 and BSD date on macOS have neither
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time() * 1000'; }

dump="$(ls -1 "$BACKUP_DIR"/*.dump 2>/dev/null | sort | tail -1 || true)"
if [ -z "$dump" ]; then
  echo "no dumps in $BACKUP_DIR, run scripts/backup.sh first" >&2
  exit 1
fi
if [ ! -f "$dump.control" ]; then
  echo "control file $dump.control is missing, can't verify this dump" >&2
  exit 1
fi
expected="$(cat "$dump.control")"

cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "dump: $dump ($(wc -c < "$dump" | tr -d ' ') bytes)"

t_start=$(now_ms)
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=drill \
  -v "$dump:/restore/backup.dump:ro" \
  "$IMAGE" >/dev/null

# the entrypoint runs a temporary server on the unix socket first; only the
# final one listens on TCP, so probe 127.0.0.1
ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d drill; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "drill container did not become ready in 60s" >&2
  exit 1
fi

tables="$(docker exec "$NAME" psql -U postgres -d drill -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [ "$tables" != "0" ]; then
  echo "fresh database already has $tables tables, drill makes no sense" >&2
  exit 1
fi
echo "clean container up, tables in public: $tables"

t_restore=$(now_ms)
docker exec "$NAME" pg_restore -U postgres -d drill --no-owner /restore/backup.dump
t_done=$(now_ms)

actual="$(docker exec -i "$NAME" psql -U postgres -d drill -Atq -v ON_ERROR_STOP=1 -f - < scripts/control.sql)"

echo "control before (users|products|orders|order_items|sum): $expected"
echo "control after:                                          $actual"
echo "pg_restore: $(( t_done - t_restore )) ms, whole drill until verified: $(( $(now_ms) - t_start )) ms"

if [ "$expected" = "$actual" ]; then
  [ "$expected" = "empty-database" ] && echo "warning: the dump has no orders table, so there was nothing to compare"
  echo "MATCH"
else
  echo "MISMATCH" >&2
  exit 1
fi
