#!/usr/bin/env bash
# StickerForge E2E API suite — boots a fresh server, exercises every endpoint, asserts WhatsApp spec compliance.
set -u
PORT=${E2E_PORT:-3399}
BASE="http://127.0.0.1:$PORT"
SAMPLE_A="${SAMPLE_A:-$HOME/Downloads/____avy_2_-_WvBgrI.mp4}"
SAMPLE_B="${SAMPLE_B:-$HOME/Downloads/Joe_Shitpost____-_1CfQWn.mp4}"
DATA_DIR="$(mktemp -d /tmp/sf-e2e-XXXXXX)"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

assert_eq() { # desc actual expected
  if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (got: $2, want: $3)"; fi
}
assert_ne() { # desc actual notexpected
  if [ "$2" != "$3" ]; then ok "$1"; else fail "$1 (got: $2, must not be: $3)"; fi
}
assert_lt() { # desc actual limit
  if [ "$2" -lt "$3" ] 2>/dev/null; then ok "$1"; else fail "$1 (got: $2, limit: $3)"; fi
}

TOKEN="e2e:e2e-user"
api() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }

check_spec() { # job_id label
  local jid="$1" label="$2"
  local json size codec w h fps dur audio
  json=$(api "$BASE/api/job/$jid")
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
  assert_lt  "$label: size <500KB" "$size" 512001
  assert_eq  "$label: codec webp" "$codec" "webp"
  assert_eq  "$label: 512x512" "${w}x${h}" "512x512"
  assert_lt  "$label: fps <=30" "${fps%%.*}" 31
  assert_eq  "$label: silent" "$audio" "False"
  assert_eq  "$label: tray extracted" "$tray" "True"
}

convert_job() { # json → jobId
  api -X POST "$BASE/api/convert" -H 'Content-Type: application/json' -d "$1" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['jobId'])"
}
wait_job() { # jobId timeout_s
  for i in $(seq 1 "$2"); do
    S=$(api "$BASE/api/job/$1" | python3 -c "import sys,json;print(json.load(sys.stdin)['status'])")
    [ "$S" = "done" -o "$S" = "error" ] && return; sleep 1
  done
}

echo "── boot ──"
cd "$(dirname "$0")/.."
export FIREBASE_E2E_BYPASS=1
DATA_DIR="$DATA_DIR" PORT=$PORT FIREBASE_E2E_BYPASS=1 node server/dist/index.js >"$DATA_DIR/server.log" 2>&1 &
SERVER_PID=$!
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")" = "401" ] && break; sleep 0.5; done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")" = "401" ] || { echo "server failed to boot"; cat "$DATA_DIR/server.log"; exit 1; }
ok "server up on :$PORT (data: $DATA_DIR)"

echo "── auth ──"
assert_eq "auth: unauthenticated /api/files is 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/files")" "401"
assert_eq "auth: bad token is 401" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer garbage' "$BASE/api/files")" "401"
assert_eq "auth: valid e2e token is 200" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/files")" "200"
assert_ne "auth: pack GET bypasses auth for the phone" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pack/zzzznotreal")" "401"

echo "── upload + probe ──"
UP=$(api -F "file=@$SAMPLE_A" "$BASE/api/upload")
FID_A=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
LEVEL=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['quality']['level'])")
W=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['meta']['width'])")
FPS=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['meta']['fps'])")
assert_eq "probe: width" "$W" "720"
assert_eq "probe: fps" "$FPS" "16.67"
[ -n "$LEVEL" ] && ok "probe: quality assessed ($LEVEL)" || fail "probe: quality"

UP2=$(api -F "file=@$SAMPLE_B" "$BASE/api/upload")
FID_B=$(echo "$UP2" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
assert_eq "probe 4K: quality good" "$(echo "$UP2" | python3 -c "import sys,json;print(json.load(sys.stdin)['quality']['level'])")" "good"

echo "── filmstrip + cropdetect ──"
code=$(api -o "$DATA_DIR/strip.jpg" -w "%{http_code}" "$BASE/api/filmstrip/$FID_A")
assert_eq "filmstrip: 200" "$code" "200"
CD=$(api "$BASE/api/cropdetect/$FID_A")
assert_eq "cropdetect: valid json" "$(echo "$CD" | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok' if d and d['w']>0 else 'bad')")" "ok"

echo "── convert: border + cropPos + custom fps ──"
J1=$(convert_job "{\"fileId\":\"$FID_A\",\"start\":0,\"end\":2.7,\"speed\":1,\"fps\":17,\"fit\":\"cover\",\"cropPos\":0.15,\"border\":true}")
wait_job "$J1" 120
check_spec "$J1" "bordered 17fps"

echo "── convert: 4K source, contain + pad + speed 2x ──"
J2=$(convert_job "{\"fileId\":\"$FID_B\",\"start\":0,\"end\":5.6,\"speed\":2,\"fps\":30,\"fit\":\"contain\",\"padColor\":\"#25d366\"}")
wait_job "$J2" 180
check_spec "$J2" "4K contain"

echo "── convert: two cuts ──"
J3=$(convert_job "{\"fileId\":\"$FID_A\",\"start\":0,\"end\":3,\"spans\":[{\"start\":0,\"end\":1},{\"start\":2,\"end\":3}],\"speed\":1,\"fps\":17,\"fit\":\"cover\"}")
wait_job "$J3" 120
check_spec "$J3" "two cuts"

echo "── output ──"
code=$(api -o "$DATA_DIR/out.webp" -w "%{http_code}" "$BASE/api/output/webp/$J1")
assert_eq "webp output: 200" "$code" "200"
assert_eq "webp output: animated WebP" \
  "$(python3 -c "d=open('$DATA_DIR/out.webp','rb').read();print(d[:4]==b'RIFF' and d[8:12]==b'WEBP' and b'ANIM' in d[:64])")" "True"
code=$(api -o /dev/null -w "%{http_code}" -H "Range: bytes=0-1023" "$BASE/api/output/preview/$J1")
assert_eq "preview: range request 206" "$code" "206"
code=$(api -o /dev/null -w "%{http_code}" -H "Range: bytes=99999999-" "$BASE/api/output/preview/$J1")
assert_eq "preview: unsatisfiable range 416" "$code" "416"

echo "── job stream ──"
STREAM=$(api --max-time 5 "$BASE/api/job/$J1/stream" | head -1)
assert_eq "stream: emits current state and closes" \
  "$(echo "$STREAM" | python3 -c "import sys,json;print(json.loads(sys.stdin.read().replace('data: ',''))['status'])")" "done"

echo "── pack build + source deletion ──"
PACK=$(api -X POST "$BASE/api/packs" -H 'Content-Type: application/json' -d '{"name":"E2E Pack"}')
PACK_CODE=$(echo "$PACK" | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
[ -n "$PACK_CODE" ] && ok "pack: created ($PACK_CODE)" || fail "pack: created"

PUT=$(api -X PUT "$BASE/api/packs/$PACK_CODE/stickers" -H 'Content-Type: application/json' \
  -d "{\"jobIds\":[\"$J1\",\"$J2\",\"$J3\"]}")
READY=$(echo "$PUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['ready'])")
assert_eq "pack: 3 ready" "$READY" "3"

EDITABLE_BEFORE=$(api "$BASE/api/stickers" \
  | python3 -c "import sys,json;print(sum(1 for s in json.load(sys.stdin) if s['editable']))")
assert_lt "pack: stickers editable before build" 0 "$EDITABLE_BEFORE"

BUILT=$(api -X POST "$BASE/api/packs/$PACK_CODE/build")
assert_eq "pack: built" \
  "$(echo "$BUILT" | python3 -c "
import sys, json
manifest = None
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    o = json.loads(line)
    if o.get('done'): manifest = o
    if o.get('error'): raise SystemExit('build error: ' + o['error'])
print(len(manifest['stickers']) if manifest else 0)
")" "3"

assert_eq "pack: sources deleted after build" \
  "$(api "$BASE/api/video/$FID_B" -o /dev/null -w '%{http_code}')" "404"
assert_eq "pack: stickers locked after build" \
  "$(api "$BASE/api/stickers" | python3 -c "import sys,json;print(any(s['editable'] for s in json.load(sys.stdin)))")" "False"
assert_eq "pack: sticker WebP still served after source deletion" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/output/webp/$J1")" "200"

REBUILT=$(api -X POST "$BASE/api/packs/$PACK_CODE/build")
assert_eq "pack: rebuild succeeds with sources gone" \
  "$(echo "$REBUILT" | python3 -c "
import sys, json
manifest = None
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    o = json.loads(line)
    if o.get('done'): manifest = o
print(len(manifest['stickers']) if manifest else 0)
")" "3"

assert_eq "pack: public GET serves the built pack" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/pack/$PACK_CODE")" "200"

echo "── sticker reuse + emojis ──"
PACK3=$(api -X POST "$BASE/api/packs" -H 'Content-Type: application/json' -d '{"name":"Reuse"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
REUSE=$(api -X PUT "$BASE/api/packs/$PACK3/stickers" -H 'Content-Type: application/json' \
  -d "{\"jobIds\":[\"$J2\",\"$J3\"]}")
assert_eq "reuse: a sticker can sit in two packs" \
  "$(echo "$REUSE" | python3 -c "import sys,json;print(json.load(sys.stdin)['ready'])")" "2"
api -X PATCH "$BASE/api/sticker/$J2" -H 'Content-Type: application/json' \
  -d '{"emojis":["🔥","💀"]}' > /dev/null
assert_eq "emoji: stored on the sticker" \
  "$(api "$BASE/api/stickers" | python3 -c "import sys,json;print(next(s['emojis'] for s in json.load(sys.stdin) if s['jobId']=='$J2'))")" \
  "['🔥', '💀']"

echo "── refcount + sticker delete ──"
PACK2=$(api -X POST "$BASE/api/packs" -H 'Content-Type: application/json' -d '{"name":"Shared"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['code'])")
api -X PUT "$BASE/api/packs/$PACK2/stickers" -H 'Content-Type: application/json' \
  -d "{\"jobIds\":[\"$J1\"]}" > /dev/null
api -X DELETE "$BASE/api/packs/$PACK2" > /dev/null
assert_eq "refcount: shared sticker survives deleting one of its packs" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/output/webp/$J1")" "200"
api -X DELETE "$BASE/api/sticker/$J1" > /dev/null
assert_eq "sticker delete: artefacts gone" \
  "$(api -o /dev/null -w '%{http_code}' "$BASE/api/output/webp/$J1")" "404"

echo "── delete + 404s ──"
UP3=$(api -F "file=@$SAMPLE_A" "$BASE/api/upload")
FID_C=$(echo "$UP3" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
code=$(api -X DELETE "$BASE/api/file/$FID_C" -o /dev/null -w "%{http_code}")
assert_eq "delete: 200" "$code" "200"
code=$(api "$BASE/api/video/$FID_C" -o /dev/null -w "%{http_code}")
assert_eq "deleted file: 404" "$code" "404"
code=$(api "$BASE/api/job/nonexistent" -o /dev/null -w "%{http_code}")
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
