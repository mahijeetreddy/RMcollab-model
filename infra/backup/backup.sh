#!/bin/sh
# Nightly database backups (docker-compose.prod.yml, service `backup`).
#
#   backup.sh         run for ever: one dump a day at BACKUP_HOUR_UTC
#   backup.sh now     one dump straight away, then exit
#
# Dumps are pg_dump's custom format: compressed, and restorable table by table.
# Each is written under a temporary name and renamed only once complete, so a
# dump cut off half way (a restart, a full disk) never sits among the good ones.
# The newest BACKUP_KEEP are kept. Connection settings come from PG* variables.
#
# Restore one (README, "Deploying"):
#   docker compose ... exec -T postgres pg_restore --clean --if-exists --no-owner \
#     -U rmcollab -d rmcollab < backups/rmcollab-YYYYMMDD-HHMMSS.dump
set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-14}"
HOUR="${BACKUP_HOUR_UTC:-3}"

dump() {
  stamp=$(date -u +%Y%m%d-%H%M%S)
  partial="$DIR/.rmcollab-$stamp.dump.partial"
  pg_dump --format=custom --no-owner --file="$partial"
  mv "$partial" "$DIR/rmcollab-$stamp.dump"
  # Oldest beyond the newest KEEP go; leftovers of an interrupted dump too.
  ls -1t "$DIR"/rmcollab-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
  find "$DIR" -name '.rmcollab-*.dump.partial' -mmin +60 -delete 2>/dev/null || true
  echo "[backup] wrote rmcollab-$stamp.dump ($(du -h "$DIR/rmcollab-$stamp.dump" | cut -f1))"
}

if [ "${1:-}" = "now" ]; then
  dump
  exit 0
fi

echo "[backup] daily at ${HOUR}:00 UTC, keeping ${KEEP}, into ${DIR}"
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "$(date -u +%Y-%m-%d) ${HOUR}:00:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  # A failure is reported and retried tomorrow, not fatal: the loop must live.
  dump || echo "[backup] FAILED - the previous dumps are untouched" >&2
done
