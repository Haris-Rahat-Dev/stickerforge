# StickerForge

WhatsApp video-sticker maker: any video in → spec-perfect animated sticker out. Node API + React editor, plus a thin Android app that loads a pack and hands it to WhatsApp.

Videos are processed on your StickerForge host (local machine or the deployed VM). Not a hosted UGC platform — no accounts, no feed, no iOS.

## WhatsApp spec

Third-party Android provider (`whatsapp/stickers`): **animated WebP**, 512×512, ≤10s, ≤30fps (our cap), **≤500KB**, silent.

Pack: **3–30 stickers**, 1–3 emojis each. Tray PNG required (≤50KB). Only an installed app with `StickerContentProvider` can add packs to WhatsApp (after user taps “Add to WhatsApp”). App must be WhatsApp-whitelisted for production.

## Deployed setup (current)

Hosted on **Oracle Cloud Always Free** (`ap-mumbai-1`):

| Piece | Detail |
|-------|--------|
| Shape | `VM.Standard.E2.1.Micro` (interim; Ampere A1 preferred when capacity exists) |
| App | systemd unit `stickerforge` — Node serves UI + API on port **3210** |
| Data | SQLite + files under `~/stickerforge/data` on the VM |
| Access | **Tailscale only** for the web UI / API (public `:3210` is closed) |
| SSH | Still available on the VM public IP for admin |

### Access the web editor

1. Install [Tailscale](https://tailscale.com/) on your device and join the **same** tailnet as the VM (`stickerforge`).
2. Open: **http://100.112.48.57:3210**  
   (or MagicDNS `http://stickerforge:3210` if enabled on your tailnet)

Flow: **Import → Stage → Build → Install**. Need ≥3 stickers in a pack, then scan the QR / use the pack code in the Android app.

### Access from the Android app

1. Install Tailscale on the phone (same account/tailnet).
2. Build & install the debug APK (baked API base points at the Tailscale host):

```bash
cd android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Default `API_BASE` is `http://100.112.48.57:3210`. Override when building:

```bash
./gradlew -PapiBase=http://YOUR_HOST:3210 assembleDebug
```

3. Open StickerForge → Load pack (scan QR or paste code) → Add to WhatsApp.

The QR encodes `stickerforge://pack/<code>` (opens the app). Pack files are fetched over HTTP from `API_BASE`.

### Deploying web UI updates (today)

There is **no** CI deploy pipeline yet. Manual:

```bash
npm run build
rsync -az web/dist/ ubuntu@<vm-ssh-host>:~/stickerforge/web/dist/
ssh ubuntu@<vm-ssh-host> 'sudo systemctl restart stickerforge'
```

Prefer SSH via Tailscale once MagicDNS/SSH over Tailscale is set up; public SSH IP still works for ops.

## Local development

**System deps:** Node **22.5+** (`node:sqlite`), `ffmpeg`/`ffprobe`, `cwebp` + `webpmux` (Homebrew ffmpeg 8 has no libwebp encoder — install `webp` separately).

```bash
npm install
npm run dev          # API :3210 + Vite :5173 (proxies /api → 3210)
npm run build && npm start   # single process, UI+API on :3210
npm run typecheck
npm run test:e2e     # needs SAMPLE_A/B in ~/Downloads — see scripts/e2e.sh
```

Bind for LAN/VM: `HOST=0.0.0.0 npm start`.

### Docker

```bash
docker build -t stickerforge .
docker run -p 3210:3210 -e HOST=0.0.0.0 -v stickerforge-data:/app/data stickerforge
```

Note: the image installs ffmpeg but **not** `cwebp`/`webpmux` — pack WebP export will fail until those are added to the image.

## Architecture

```
web/                 React + Vite editor
server/src/          Express API, SQLite, encode queue, animated WebP pipeline
android/             Java StickerContentProvider + one-screen importer
data/                uploads, outputs, trays, packs, stickerforge.db (gitignored)
```

Encode preview must match ffmpeg (trim, fit, crop, borders, speed, fps). Each sticker's WebP is encoded once at Add; pack build copies them.

## Security notes

- Tailscale keeps the editor/API off the public internet.
- The app has **no auth** — anyone on the tailnet can upload/encode.
- Always Free Micro has ~1 GB RAM; large encodes may be slow or OOM (swap is configured on the VM).

## Product decisions

- Conversion stays on the server (frame extraction + img2webp is heavy for phones).
- Android is native Java (WhatsApp sample contract), not RN/Capacitor.
- Provider authority: `com.stickerforge.app.stickercontentprovider`.
- iOS: no public provider API — web download + Sticker.ly is the interim.

## Next

1. Finish WhatsApp whitelist after a successful Add-to-WhatsApp on a real phone.
2. Move to Always Free Ampere A1 when Mumbai capacity appears (more RAM/CPU for encodes).
3. Add a real deploy script / CI when the host is stable.
