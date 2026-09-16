#!/usr/bin/env bash
# Retry Always Free Ampere A1 until Mumbai has capacity.
#
# Local loop:  ./scripts/oci-retry-a1.sh
# One shot:    ONCE=1 ./scripts/oci-retry-a1.sh   # for Cursor Automations / cron
#
# Env:
#   ONCE=1              single attempt then exit (0 = success or capacity; 2 = hard fail)
#   INTERVAL_SEC        sleep between attempts in loop mode (default 300)
#   OCPUS MEMORY_GBS    shape (default 2 / 12)
#   OCI_AUTH            security_token | api_key (default security_token)
#   SSH_KEY             path to .pub (default ~/.ssh/id_ed25519.pub)
#   COMPARTMENT_ID SUBNET_ID AD IMAGE_ID DISPLAY_NAME LOG
set -euo pipefail

COMPARTMENT_ID="${COMPARTMENT_ID:-ocid1.tenancy.oc1..aaaaaaaach4z23c3kxhej7dp4shk2qbem3yjeqjmk557ub2hjvpu37bzf3gq}"
SUBNET_ID="${SUBNET_ID:-ocid1.subnet.oc1.ap-mumbai-1.aaaaaaaacoyfrhkx6siorz64l5f6pem74rus5crtjgatpuooktbn7hjndpea}"
AD="${AD:-oUAK:AP-MUMBAI-1-AD-1}"
IMAGE_ID="${IMAGE_ID:-ocid1.image.oc1.ap-mumbai-1.aaaaaaaavpkbfemaxi7gfzobc4qsc3p2m5szuswd7skrxvzo5teii6bfkd2a}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519.pub}"
DISPLAY_NAME="${DISPLAY_NAME:-stickerforge-a1}"
OCPUS="${OCPUS:-2}"
MEMORY_GBS="${MEMORY_GBS:-12}"
INTERVAL_SEC="${INTERVAL_SEC:-300}"
ONCE="${ONCE:-0}"
LOG="${LOG:-$HOME/.cache/stickerforge-oci-a1-retry.log}"
OCI_AUTH="${OCI_AUTH:-security_token}"

mkdir -p "$(dirname "$LOG")"
SSH_PUB=$(cat "$SSH_KEY")

if [[ "$OCI_AUTH" == "api_key" ]]; then
  AUTH=()
else
  AUTH=(--auth security_token)
fi

attempt() {
  local n=$1 ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local existing
  existing=$(oci "${AUTH[@]}" compute instance list \
    --compartment-id "$COMPARTMENT_ID" \
    --lifecycle-state RUNNING \
    --query "data[?shape=='VM.Standard.A1.Flex'].id | [0]" \
    --raw-output 2>/dev/null || true)
  if [[ -n "$existing" && "$existing" != "null" && "$existing" != "[]" ]]; then
    echo "$ts attempt=$n already have A1: $existing" | tee -a "$LOG"
    return 0
  fi

  local tmp rc body
  tmp=$(mktemp)
  set +e
  oci "${AUTH[@]}" compute instance launch \
    --compartment-id "$COMPARTMENT_ID" \
    --availability-domain "$AD" \
    --display-name "$DISPLAY_NAME" \
    --shape VM.Standard.A1.Flex \
    --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GBS}" \
    --image-id "$IMAGE_ID" \
    --subnet-id "$SUBNET_ID" \
    --assign-public-ip true \
    --metadata "{\"ssh_authorized_keys\":\"$SSH_PUB\"}" \
    --wait-for-state RUNNING \
    --wait-interval-seconds 15 \
    --max-wait-seconds 600 \
    >"$tmp" 2>&1
  rc=$?
  set -e
  body=$(cat "$tmp")
  rm -f "$tmp"

  if [[ $rc -eq 0 ]]; then
    echo "$ts attempt=$n SUCCESS" | tee -a "$LOG"
    echo "$body" | tee -a "$LOG"
    return 0
  fi

  if echo "$body" | grep -qiE 'Out of host capacity|InternalError|TooManyRequests|LimitExceeded'; then
    echo "$ts attempt=$n capacity/limit" | tee -a "$LOG"
    return 1
  fi

  echo "$ts attempt=$n FAIL rc=$rc" | tee -a "$LOG"
  echo "$body" | tee -a "$LOG"
  return 2
}

if [[ "$ONCE" == "1" ]]; then
  echo "one-shot A1 ${OCPUS}OCPU/${MEMORY_GBS}GB"
  set +e
  attempt 1
  rc=$?
  set -e
  # 0 success / already exists; 1 capacity → soft exit for scheduler; 2 hard fail
  [[ $rc -eq 2 ]] && exit 2
  exit 0
fi

echo "retrying A1 ${OCPUS}OCPU/${MEMORY_GBS}GB every ${INTERVAL_SEC}s → $LOG"
n=0
while true; do
  n=$((n + 1))
  set +e
  attempt "$n"
  rc=$?
  set -e
  [[ $rc -eq 0 ]] && exit 0
  if [[ $rc -eq 2 ]]; then
    sleep $((INTERVAL_SEC * 2))
  else
    sleep "$INTERVAL_SEC"
  fi
done
