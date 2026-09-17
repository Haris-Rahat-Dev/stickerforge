# VM data backups — plan (not yet implemented)

Goal: nightly, off-VM backup of `~/stickerforge/data/` to **OCI Object Storage**,
keep the **last 7**. Off-VM so it survives the Always-Free instance being reclaimed
(Object Storage is a separate service from the compute instance's block volume).

What's backed up: `data/uploads`, `data/outputs`, `data/packs`, `data/trays`, and a
**consistent snapshot** of `data/stickerforge.db` (the live SQLite file must not be
copied mid-write — take a `.backup` snapshot first).

## Current state
- VM: OCI Always Free, `ap-mumbai-1`, reachable at `ubuntu@100.112.48.57` (Tailscale).
- **No OCI CLI installed, no `~/.oci/config`** — the prerequisites below are required first.

## One-time prerequisites (needs OCI console / tenancy admin)

1. **Create a bucket** (Object Storage → Buckets, region `ap-mumbai-1`):
   `stickerforge-backups`. Note the **namespace** (Object Storage → shown at top).

2. **Install OCI CLI on the VM:**
   ```bash
   bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults
   ```

3. **Auth — use instance principals (no secrets on the VM):**
   In the OCI console:
   - Create a **Dynamic Group** `stickerforge-vm` matching the instance OCID:
     `ANY {instance.id = '<VM_OCID>'}`
   - Add an **IAM Policy** (root or the backups compartment):
     ```
     Allow dynamic-group stickerforge-vm to manage objects in compartment <compartment> where target.bucket.name='stickerforge-backups'
     Allow dynamic-group stickerforge-vm to read buckets in compartment <compartment>
     ```
   Then every `oci` call below uses `--auth instance_principal` — no API keys to rotate.
   (Alternative: `oci setup config` with a user API key written to `~/.oci/config`, but
   that puts a private key on the VM — instance principals is cleaner.)

## Backup script — `~/stickerforge/backup.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd ~/stickerforge
BUCKET=stickerforge-backups
NS=<namespace>                       # from prereq 1
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d)

# 1. consistent SQLite snapshot (safe while the service runs)
sqlite3 data/stickerforge.db ".backup '$TMP/stickerforge.db'"

# 2. archive media (exclude the live db) + the snapshot
tar czf "$TMP/data-$STAMP.tgz" \
  -C data --exclude=stickerforge.db . \
  -C "$TMP" stickerforge.db

# 3. upload
oci os object put --auth instance_principal --namespace "$NS" \
  --bucket-name "$BUCKET" --file "$TMP/data-$STAMP.tgz" --name "data-$STAMP.tgz"

# 4. prune — keep newest 7
oci os object list --auth instance_principal --namespace "$NS" --bucket-name "$BUCKET" \
  --query 'sort_by(data,&"time-created")[].name' --raw-output 2>/dev/null \
  | grep '^data-' | head -n -7 \
  | while read -r old; do
      oci os object delete --auth instance_principal --namespace "$NS" \
        --bucket-name "$BUCKET" --object-name "$old" --force
    done

rm -rf "$TMP"
echo "$(date -u) backed up data-$STAMP.tgz"
```
`chmod +x ~/stickerforge/backup.sh`

## Schedule — nightly cron on the VM

```cron
# 03:15 daily (VM time). Log to ~/backup.log
15 3 * * * /home/ubuntu/stickerforge/backup.sh >> /home/ubuntu/backup.log 2>&1
```
`crontab -e` on the VM. (Cron on the VM > a Mac-side job here: it runs even when the
Mac is off.)

## Restore

```bash
cd ~/stickerforge
oci os object get --auth instance_principal --namespace "$NS" \
  --bucket-name stickerforge-backups --name data-<STAMP>.tgz --file /tmp/restore.tgz
sudo systemctl stop stickerforge
rm -rf data && mkdir data
tar xzf /tmp/restore.tgz -C data
sudo systemctl start stickerforge
```

## Notes
- Storage: fits the Always-Free **20GB** Object Storage; total ≈ 7 × (media size).
  If media grows large, drop retention or exclude `data/outputs` (re-derivable from uploads).
- Verify after setup: run `backup.sh` once by hand, confirm the object appears and
  `tar tzf` lists the contents; check `~/backup.log` after the first cron run.
- This backs up **data only**, not code — code lives in git + `deploy.sh`.
