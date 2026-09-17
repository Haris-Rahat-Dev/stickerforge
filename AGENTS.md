# StickerForge

Local WhatsApp video-sticker maker. Any video in → spec-perfect animated sticker out. Videos never leave the machine.

## What this is

A Node API + React editor, plus a thin Android app that can push a pack into WhatsApp. Not a hosted UGC platform. No accounts, no feed, no iOS. Dogfood the local loop first; WhatsApp whitelist is the long pole.

## WhatsApp spec (non-negotiable)

- **Sticker.ly / chat import:** WebM VP9, 512×512, ≤30fps, ≤6s, **<500KB**, silent
- **Third-party provider API** (`github.com/whatsapp/stickers`): **animated WebP**, same size/duration/fps caps — not WebM. Sticker.ly silently re-encodes WebMs; the Android app cannot.
- Pack minimum: **3 stickers**. Tray PNG required (96×96-ish static icon).
- No website can write into WhatsApp. Only an installed app exposing `StickerContentProvider`, then user taps “Add to WhatsApp”. App must be **whitelisted** by WhatsApp (days–weeks).

## Commands

```bash
npm install
npm run dev          # API :3210 + Vite :5173 (proxy /api → 3210)
npm run build && npm start   # one process, UI+API on :3210
npm run typecheck
npm run test:e2e     # 44 assertions; needs SAMPLE_A/B in ~/Downloads (see scripts/e2e.sh)
```

Docker (ffmpeg in image; **no cwebp/webpmux** — pack export will fail):

```bash
docker build -t stickerforge .
docker run -p 3210:3210 -e HOST=0.0.0.0 -v stickerforge-data:/app/data stickerforge
```

Android (debug APK, phone or emulator):

```bash
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Phone reaches the StickerForge host over Tailscale (baked `API_BASE`, default Tailscale IP). Override with `-PapiBase=…` if needed. Emulator proves the ContentProvider; only a real phone with WhatsApp signed in completes the last tap.

System deps: **Node 22.5+** (uses the built-in `node:sqlite` for persistence — no dependency, but not available on Node 20/21), `ffmpeg`/`ffprobe`, `cwebp` + `webpmux` (Homebrew ffmpeg 8 has **no** libwebp encoder).

## Architecture

```
web/                 React+Vite editor (die-cut print-shop UI)
server/src/
  index.ts           Express routes, files/jobs maps (SQLite-backed)
  db.ts              node:sqlite persistence — files + done jobs survive restart
  queue.ts           in-process concurrency limiter (caps parallel encodes)
  probe.ts           ffprobe + quality score + cropdetect
  convert.ts         two-pass VP9 WebM, <500KB with bitrate retry
  webp.ts            ffmpeg frames → cwebp → webpmux animated WebP
  types.ts           shared models
android/             Java, zero deps — StickerContentProvider + one-screen importer
data/                uploads, outputs, trays, packs, stickerforge.db (gitignored)
```

Dev: two processes (Vite HMR + API). Production/`npm start`: Express serves `web/dist` and the API. Bind is `HOST` (default `127.0.0.1` — Docker must set `0.0.0.0` or the container is unreachable).

Flow (staging tray, no batch mode): import → stage → build → install. Each uploaded video is a card; "Add to pack" encodes it with auto defaults (cover + cropdetect), or click the card to fine-tune (trim ≤6s, fit, cropPos, black-border crop, white safe-border, speed, fps) in the editor. Encodes run through a concurrency-capped queue → convert job → tray PNG. At ≥3 in-pack, Build pack assembles WebP + manifest; the Install stage shows the phone handoff. App flow state lives in one reducer (`web/src/flow.ts`).

`POST /api/pack/:code` (the editor) builds from an explicit, ordered set of `jobIds` — one per sticker — re-encodes to WebP, writes `data/packs/<code>/` + manifest. `GET /api/pack/:code` (Android uses `demo`) just serves the cached pack (Android's fetch times out at 30s, so GET must never rebuild); it only builds, from the last 3–6 done jobs, if nothing is cached yet. Files + done jobs are persisted (SQLite), so they survive a restart.

## Editor / encode rules

Preview **must** match the encode: square stage, trim loop, speed, cover/contain/stretch, crop-position pan, black-border crop, white inset. If preview and ffmpeg diverge, that’s a bug.

- **cover** — fill square, pan with `cropPos` (0 = top/left, 1 = bottom/right). Needed because captions often sit in the shaved 15%.
- **contain** — letterbox with `padColor`. Source often has **baked** black bars (cropdetect); pad-on-black looks like a no-op until “Remove black borders” is on.
- **stretch** — squash to square (preview so the user sees how ugly it is).
- **White border** — opt-in 460px content + 26px white pad. Stops WhatsApp rounded-corners / built-in maker from clipping edge text. Off by default; Sticker.ly does not need it.
- FPS: default to source, cap 30. Do **not** upsample GIF-sourced 10–17fps (duplicates frames, wastes the 500KB budget). No minterpolate.
- Bitrate: `computeBitrateKbps` targets ~470KB; convert retries downward. Shorter trim = sharper sticker.
- Quality bpp warn is 0.02; flat 3D animation (JoeVerse) false-alarms — expected.

Good meme defaults: Crop, black-border ON, 2–4s, 1×, 30fps (or source if lower), joke in the first second.

## Product decisions (don’t reopen)

- Local web + system ffmpeg. Not Tauri/Electron, not a hosted converter (367MB sources, no upload tax).
- Keep conversion on the server. Phones are slow at two-pass VP9.
- Android is native Java from WhatsApp’s sample contract — not RN/Capacitor. Provider authority must start with the package name: `com.stickerforge.app.stickercontentprovider`.
- iOS: no public provider API. Web download + Sticker.ly is the interim.
- No accounts/packs-as-product/feed/remix until a pack has landed in WhatsApp from **our** app.
- UI identity: die-cut print shop — Anton headlines, IBM Plex Mono labels, moss/cream/forge-green, hard stamp shadows, dashed die-cut, registration marks. Don’t generic-dark-app it.

## Gotchas

- `npm run dev` dies if the API process is killed; Vite alone is a blank proxy. Hard-refresh (⌘⇧R) after CSS/geometry fixes.
- E2E samples are specific files in `~/Downloads`; missing files → suite fails at upload.
- Pack WebP is built from **already-converted WebM** plus original settings — don’t “fix” that without checking double-crop/double-speed.
- `adb push` files are invisible to Sticker.ly until a media scan (`adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE`).
- WhatsApp’s built-in sticker maker re-crops; edge text dies without the white-border toggle.
- Duplicate identical WebMs can be rejected by importer apps.

## Next (only if asked)

1. Live phone test: install APK (Tailscale to the StickerForge host), Load pack, Add to WhatsApp.
2. Submit whitelist the same day that works.
3. Then: host API (Fly/Hetzner + R2), pack builder, accounts. Not before.

## Learned User Preferences

- Prefer OCI Always Free for the first hosted deploy (long-running VM + disk/SQLite); skip Firebase/managed DB until needed.
- Prefer Cursor Automations over local LaunchAgents/nohup for recurring OCI capacity retries.
- For simple automations, prefer the cheapest standard model (Composer 2.5), not Fast variants.
- When Always Free Ampere capacity appears, launch and hold the VM — do not only notify.
- Push this repo with the Haris-Rahat-Dev GitHub account. Workflow for any commit/push here: `gh auth switch --user Haris-Rahat-Dev` → commit → push, then `gh auth switch --user Haris-Rahat` (the default) to leave the active account unchanged so other repos/workflows aren't affected. Do not add a Claude co-author / attribution line to commit messages.
- Prefer Tailscale private access for the hosted app; keep public HTTP closed when Tailscale is up.
- Prefer generic host/device copy in UI and docs — no Mac- or USB-specific wording.
- For the Ampere Cursor Automation, put OCI credentials as Runtime Secrets on the selected Cloud Environment (not Build Secrets); redacted values still mean present.

## Learned Workspace Facts

- Hosted StickerForge needs a long-running VM with ffmpeg/cwebp/webpmux; SQLite + local disk is enough for v1.
- OCI home region for this project is `ap-mumbai-1`; Always Free Ampere A1 Flex is often out of capacity there.
- When A1 is unavailable, Always Free `VM.Standard.E2.1.Micro` is the interim shape (~1 GB RAM; needs swap for npm/ffmpeg).
- Ampere capacity retries are intended as a Cursor Automation named “Hold Always Free Ampere A1” (procure-and-hold, ~every 5 minutes), not a checked-in local loop.
- Hosted access is Tailscale-only once public `:3210` is closed; laptop and phone both need Tailscale on the same account.
- Android debug builds bake `API_BASE` to the Tailscale host so pack fetch works without USB/`adb reverse`.
- Web deploy to the VM is still manual (`npm run build` → rsync `web/dist` → restart `stickerforge`); no CI/push-to-deploy yet.
