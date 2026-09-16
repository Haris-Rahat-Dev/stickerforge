#!/usr/bin/env bash
# Deploy StickerForge to the hosted VM (rsync-based — the VM is not a git checkout).
# Builds locally, syncs build output + source, restarts the systemd service.
# data/ is never synced, so processed stickers/packs on the VM persist.
#
# Usage:  ./deploy.sh            (uses default VM host below)
#         STICKERFORGE_VM=ubuntu@1.2.3.4 ./deploy.sh
set -euo pipefail

VM="${STICKERFORGE_VM:-ubuntu@100.112.48.57}"   # OCI Always Free box, over Tailscale
REMOTE_DIR="~/stickerforge"

echo "→ typecheck"
npm run typecheck

echo "→ build (server/dist + web/dist)"
npm run build

echo "→ rsync to $VM"
rsync -az server/dist/ "$VM:$REMOTE_DIR/server/dist/"
rsync -az web/dist/    "$VM:$REMOTE_DIR/web/dist/"
rsync -az server/src/  "$VM:$REMOTE_DIR/server/src/"
rsync -az web/src/     "$VM:$REMOTE_DIR/web/src/"
rsync -az package.json package-lock.json "$VM:$REMOTE_DIR/"

echo "→ restart service"
ssh "$VM" 'sudo systemctl restart stickerforge && sleep 2 && systemctl is-active stickerforge'

echo "✓ deployed to $VM (data/ untouched)"
