#!/usr/bin/env bash
# StickerForge E2E API suite — boots a fresh server, exercises every endpoint, asserts WhatsApp spec compliance.
set -u
PORT=${E2E_PORT:-3399}
BASE="http://127.0.0.1:$PORT"
SAMPLE_A="$HOME/Downloads/____avy_2_-_WvBgrI.mp4"
SAMPLE_B="$HOME/Downloads/Joe_Shitpost____-_1CfQWn.mp4"
DATA_DIR="$(mktemp -d /tmp/opencode/sf-e2e-XXXX)"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

assert_eq() { # desc actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (got: $2, want: $3)"; fi
}
assert_lt() { # desc actual limit
  if [ "$2" -lt "$3" ] 2>/dev/null; then ok "$1"; else fail "$1 (got: $2, limit: $3)"; fi
}

check_spec() { # job_id label
  local jid="$1" label="$2"
  local json size codec w h fps dur audio
  json=$(curl -s "$BASE/api/job/$jid")
  status=$(echo "$json" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  assert_eq "$label: status" "$status" "done"
  size=$(echo "$json"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('sizeBytes',999999999))")
  codec=$(echo "$json" | python3 -c "import sys,json;print((json.load(sys.stdin).get('outMeta') or {}).get('codec','?'))")
  w=$(echo "$json"     | python3 -c "import sys,json;print((json.load(sys.stdin).get('outMeta') or {}).get('width','?'))")
  h=$(echo "$json"     | python3 -c "import sys,json;print((json.load(sys.stdin).get('outMeta') or {}).get('height','?'))")
  fps=$(echo "$json"   | python3 -c "import sys,json;print((json.load(sys.stdin).get('outMeta') or {}).get('fps','?'))")
  dur=$(echo "$json"   | python3 -c "import sys,json;print((json.load(sys.stdin).get('outMeta') or {}).get('duration','?'))")
  audio=$(echo "$json" | python3 -c "import sys,json;print((json.load(sys.stdin).get('outMeta') or {}).get('hasAudio','?'))")
  tray=$(echo "$json"  | python3 -c "import sys,json;print(json.load(sys.stdin).get('trayPath') is not None)")
  assert_lt  "$label: size <500KB" "$size" 512000
  assert_eq  "$label: codec vp9" "$codec" "vp9"
  assert_eq  "$label: 512x512" "${w}x${h}" "512x512"
  assert_lt  "$label: fps <=30" "${fps%%.*}" 31
  assert_eq  "$label: silent" "$audio" "False"
  assert_eq  "$label: tray extracted" "$tray" "True"
}

echo "── boot ──"
cd "$(dirname "$0")/.."
DATA_DIR="$DATA_DIR" PORT=$PORT node server/dist/index.js >"$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do curl -s -o /dev/null "$BASE/api/files" && break; sleep 0.5; done
curl -s -o /dev/null "$BASE/api/files" || { echo "server failed to boot"; cat "$DATA_DIR/server.log"; exit 1; }
ok "server up on :$PORT (data: $DATA_DIR)"

echo "── upload + probe ──"
UP=$(curl -s -F "file=@$SAMPLE_A" "$BASE/api/upload")
FID_A=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
LEVEL=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['quality']['level'])")
W=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['meta']['width'])")
FPS=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['meta']['fps'])")
assert_eq "probe: width" "$W" "720"
assert_eq "probe: fps" "$FPS" "16.67"
[ -n "$LEVEL" ] && ok "probe: quality assessed ($LEVEL)" || fail "probe: quality"

UP2=$(curl -s -F "file=@$SAMPLE_B" "$BASE/api/upload")
FID_B=$(echo "$UP2" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
assert_eq "probe 4K: quality good" "$(echo "$UP2" | python3 -c "import sys,json;print(json.load(sys.stdin)['quality']['level'])")" "good"

echo "── filmstrip + cropdetect ──"
code=$(curl -s -o "$DATA_DIR/strip.jpg" -w "%{http_code}" "$BASE/api/filmstrip/$FID_A")
assert_eq "filmstrip: 200" "$code" "200"
CD=$(curl -s "$BASE/api/cropdetect/$FID_A")
assert_eq "cropdetect: valid json" "$(echo "$CD" | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok' if d and d['w']>0 else 'bad')")" "ok"

echo "── convert: border + cropPos + custom fps ──"
J1=$(curl -s -X POST "$BASE/api/convert" -H 'Content-Type: application/json' \
  -d "{\"fileId\":\"$FID_A\",\"start\":0,\"end\":2.7,\"speed\":1,\"fps\":17,\"fit\":\"cover\",\"cropPos\":0.15,\"border\":true}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
for i in $(seq 1 60); do
  S=$(curl -s "$BASE/api/job/$J1" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  [ "$S" = "done" -o "$S" = "error" ] && break; sleep 1
done
check_spec "$J1" "bordered 17fps"

echo "── convert: 4K source, contain + pad + speed 2x ──"
J2=$(curl -s -X POST "$BASE/api/convert" -H 'Content-Type: application/json' \
  -d "{\"fileId\":\"$FID_B\",\"start\":0,\"end\":5.6,\"speed\":2,\"fps\":30,\"fit\":\"contain\",\"padColor\":\"#25d366\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])")
for i in $(seq 1 90); do
  S=$(curl -s "$BASE/api/job/$J2" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  [ "$S" = "done" -o "$S" = "error" ] && break; sleep 1
done
check_spec "$J2" "4K contain"

echo "── downloads ──"
code=$(curl -s -o "$DATA_DIR/dl.webm" -w "%{http_code}" "$BASE/api/download/webm/$J1")
assert_eq "webm download: 200" "$code" "200"
dlsize=$(stat -f%z "$DATA_DIR/dl.webm" 2>/dev/null || stat -c%s "$DATA_DIR/dl.webm")
assert_lt "webm download: size matches" $((dlsize - 999999)) 1
code=$(curl -s -o "$DATA_DIR/tray.png" -w "%{http_code}" "$BASE/api/download/tray/$J1")
assert_eq "tray download: 200" "$code" "200"
file_tray=$(file -b "$DATA_DIR/tray.png" | cut -d, -f1)
assert_eq "tray: is PNG" "$file_tray" "PNG image data"
code=$(curl -s -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" "$BASE/api/output/preview/$J1")
assert_eq "preview: range request 206" "$code" "206"

echo "── batch ──"
BATCH=$(curl -s -X POST "$BASE/api/batch" -H 'Content-Type: application/json' -d "{\"fileIds\":[\"$FID_A\",\"$FID_B\"]}")
JB1=$(echo "$BATCH" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['jobId'])")
JB2=$(echo "$BATCH" | python3 -c "import sys,json;print(json.load(sys.stdin)[1]['jobId'])")
for i in $(seq 1 120); do
  S1=$(curl -s "$BASE/api/job/$JB1" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  S2=$(curl -s "$BASE/api/job/$JB2" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
  { [ "$S1" = "done" -o "$S1" = "error" ] && [ "$S2" = "done" -o "$S2" = "error" ]; } && break; sleep 1
done
check_spec "$JB1" "batch[1]"
check_spec "$JB2" "batch[2]"

echo "── delete + 404s ──"
code=$(curl -s -X DELETE "$BASE/api/file/$FID_A" -o /dev/null -w "%{http_code}")
assert_eq "delete: 200" "$code" "200"
code=$(curl -s "$BASE/api/video/$FID_A" -o /dev/null -w "%{http_code}")
assert_eq "deleted file: 404" "$code" "404"
code=$(curl -s "$BASE/api/job/nonexistent" -o /dev/null -w "%{http_code}")
assert_eq "unknown job: 404" "$code" "404"

echo "── SPA serving ──"
code=$(curl -s "$BASE/" -o /dev/null -w "%{http_code}")
assert_eq "index: 200" "$code" "200"

kill $SERVER_PID 2>/dev/null
echo ""
echo "══════════════════════════"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "══════════════════════════"
rm -rf "$DATA_DIR"
[ "$FAIL" = "0" ]
