#!/usr/bin/env bash
# Nightly backup of data/ to OCI Object Storage. Setup + restore: docs/backups.md.
# Config comes from ./.backup.env (gitignored) or the environment:
#   SF_BACKUP_NS      Object Storage namespace (required)
#   SF_BACKUP_BUCKET  bucket name (default: stickerforge-backups)
#   SF_BACKUP_KEEP    how many to retain (default: 7)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .backup.env ] && source .backup.env

NS="${SF_BACKUP_NS:-}"
BUCKET="${SF_BACKUP_BUCKET:-stickerforge-backups}"
KEEP="${SF_BACKUP_KEEP:-7}"
if [ -z "$NS" ]; then echo "SF_BACKUP_NS not set — see docs/backups.md"; exit 1; fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# 1. consistent SQLite snapshot (safe while the service runs)
sqlite3 data/stickerforge.db ".backup '$TMP/stickerforge.db'"

# 2. archive media (excluding the live db) + the snapshot
tar czf "$TMP/data-$STAMP.tgz" -C data --exclude=stickerforge.db . -C "$TMP" stickerforge.db

# 3. upload
oci os object put --auth instance_principal --namespace "$NS" \
  --bucket-name "$BUCKET" --file "$TMP/data-$STAMP.tgz" --name "data-$STAMP.tgz"

# 4. prune — keep newest $KEEP
oci os object list --auth instance_principal --namespace "$NS" --bucket-name "$BUCKET" \
  --query 'sort_by(data,&"time-created")[].name' --raw-output 2>/dev/null \
  | grep '^data-' | head -n "-$KEEP" \
  | while read -r old; do
      oci os object delete --auth instance_principal --namespace "$NS" \
        --bucket-name "$BUCKET" --object-name "$old" --force
    done

echo "$(date -u) backed up data-$STAMP.tgz (keep $KEEP)"
