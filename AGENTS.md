# StickerForge

Local WhatsApp video-sticker maker. Any video in → spec-perfect animated sticker out. Videos never leave the machine.

## What this is

A Node API + React editor, plus a thin Android app that can push a pack into WhatsApp. Not a hosted UGC platform. No feed, no iOS. Firebase Auth for accounts; WhatsApp whitelist is the long pole.

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
npm test             # node:test unit tests (auth, model, flow, …)
npm run test:e2e     # assertions; needs SAMPLE_A/B in ~/Downloads (see scripts/e2e.sh)
```

## Accounts

Firebase Auth on the **Spark (free)** plan when configured. Browser holds the session (`firebase` web SDK); every `/api` request carries `Authorization: Bearer <id token>` (media/SSE use `?token=`). Server verifies with **`firebase-admin`** + a service-account JSON (`FIREBASE_SERVICE_ACCOUNT`). See `.env.example`.

**If `FIREBASE_SERVICE_ACCOUNT` is unset**, the server falls back to anonymous `sf_uid` cookies and the web build skips the sign-in screen — so dogfood/deploy still works while a Firebase project is unavailable. Flip to Firebase later by setting the env vars and rebuilding the web app.

`GET /api/pack/:code` and `/api/pack/:code/file/:name` stay **unauthenticated** — Android fetches by unguessable pack code. `publicPath()` in `server/src/auth.ts` is that allowlist; do not widen it.

Cloud Storage / Cloud Run are not used. Videos, encodes, and SQLite stay on the VM.

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
  jobfeed.ts         in-process job event bus (SSE fan-out)
  sticker.ts         derived editability, StickerView, emoji normalization
  auth.ts            firebase-admin ID token verify + public-path allowlist
  types.ts           shared models
android/             Java, zero deps — StickerContentProvider + one-screen importer
data/                uploads, outputs, trays, packs, stickerforge.db (gitignored)
```

Dev: two processes (Vite HMR + API). Production/`npm start`: Express serves `web/dist` and the API. Bind is `HOST` (default `127.0.0.1` — Docker must set `0.0.0.0` or the container is unreachable).

Flow: **packs home → pack canvas → build → install drawer**. The home screen lists your packs. Opening one shows the canvas: a **staging shelf** of uploaded-but-uncommitted sources on top, collapsed to nothing when empty, above the **sticker sheet** that is the pack itself (drag to reorder, outlined empty slots below three). Editing a staged source in the editor and committing it moves it down into the sheet. At ≥3, Build assembles the WebP pack, **deletes the sources**, and opens the install drawer over the canvas.

App state is one reducer with three routes (`web/src/flow.ts`): `packs`, `pack`, and `stickers`. There is no router dependency and no localStorage — identity is a Firebase Auth uid when configured, otherwise an anonymous `sf_uid` cookie.

`PUT /api/packs/:code/stickers` sets the pack’s ordered `jobIds`. `POST /api/packs/:code/build` re-encodes those to WebP, writes `data/packs/<code>/` + manifest, then deletes the sources. `GET /api/pack/:code` (Android) serves only a cached pack — 404 if never built; it must never rebuild (Android’s fetch times out at 30s). Files + done jobs are persisted (SQLite), so they survive a restart.

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
- No packs-as-product/feed/remix until a pack has landed in WhatsApp from **our** app.
- UI identity: die-cut print shop — Anton headlines, IBM Plex Mono labels, moss/cream/forge-green, hard stamp shadows, dashed die-cut, registration marks. Don’t generic-dark-app it.

## Model: Source / Sticker / Pack

- **Source** — the uploaded video or image. Transient. Lives in the staging shelf while iterating. Deleted when a pack containing its sticker is built successfully.
- **Sticker** — the encoded artefact (`job` + WebM + tray PNG + webp-cache entry). Durable, owned by user, reusable in any number of packs, searchable.
- **Pack** — an ordered `pack_stickers` membership, buildable and shippable to WhatsApp.

Three rules the code depends on:

1. **A sticker outlives its source.** `removeFile()` in `db.ts` deletes only the file row, and the boot filter in `index.ts` gates jobs on `fs.existsSync(job.outputPath)` alone. Gating on `files.has(job.fileId)` would drop every sticker in every built pack on the next restart.
2. **Editability is derived, never stored.** `isEditable()` in `sticker.ts` is true iff the source file is still on disk. Building a pack is what locks its stickers.
3. **Outputs are reference-counted.** `countPacksWithJob()` must return 0 before any sticker artefact is deleted. `DELETE /api/sticker/:jobId` is the deliberate exception — it removes the sticker from every pack first.

Sources are deleted **only after** `manifest.json` exists on disk. A failed build deletes nothing and leaves the pack a draft.

A sticker may belong to several packs. Membership is deduped by **jobId**, not fileId — the old fileId dedupe collapsed two legitimate trims of one source, and replace-in-place now covers the stale-job case it was protecting against.

Per-sticker emojis (1–3, WhatsApp's limit) live in the job record's JSON and are written into the manifest at build time, so changing them needs a rebuild to reach the phone. `normaliseEmojis()` in `sticker.ts` enforces the range on the way in.

**All stickers** is a third route listing every sticker you own, with client-side search over name, emojis, and containing pack names. Deleting there removes the sticker from every pack; removing from a pack canvas only drops the membership and lets the reference count decide.

## Live encode progress

`GET /api/job/:id/stream` is a Server-Sent Events stream of `{status, progress, stage, sizeBytes, error}`. It emits current state immediately, closes itself on a terminal status, and pings every 25s to survive idle proxies. The client's `watchJob()` uses it and falls back to polling if the stream cannot be opened.

**Firestore was considered and rejected for this.** Progress is written by the server, so Firestore would need a service-account credential on the VM plus `firebase-admin` or a hand-rolled JWT exchange — real operational cost for cross-device sync that encode progress does not need. Firestore remains a reasonable future choice for pack and sticker metadata, which is a different problem.

## Gotchas

- `npm run dev` dies if the API process is killed; Vite alone is a blank proxy. Hard-refresh (⌘⇧R) after CSS/geometry fixes.
- E2E samples are specific files in `~/Downloads`; missing files → suite fails at upload.
- Pack WebP is built from the **already-converted WebM** (crop/scale/trim/speed/border/audio all baked in). The WebP pass must re-apply **none** of `job.settings` — only carry `fps` for the 500KB budget. Spreading `...job.settings` double-processes (original-source `crop` on the 512² WebM → ffmpeg “size too big”; also double-trim/double-speed). See `assemblePack` in `index.ts`.
- `adb push` files are invisible to Sticker.ly until a media scan (`adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE`).
- WhatsApp’s built-in sticker maker re-crops; edge text dies without the white-border toggle.
- Duplicate identical WebMs can be rejected by importer apps.

## Next (only if asked)

1. Live phone test: install APK (Tailscale to the StickerForge host), Load pack, Add to WhatsApp.
2. Submit whitelist the same day that works.
3. Then: host API (Fly/Hetzner + R2), pack builder, accounts. Not before.

## Learned User Preferences

- Keep Oracle infrastructure Always Free / zero paid cost (VM, Object Storage backups, IAM); prefer Always Free shapes. Firebase Auth on Spark is fine; still skip paid Firebase/managed DB.
- Prefer `firebase-admin` + service-account JSON for ID token verify over jose/JWKS-only — user explicitly chose Admin when offered the lighter path.
- Prefer Cursor Automations over local LaunchAgents/nohup for recurring OCI capacity retries.
- For simple automations, prefer the cheapest standard model (Composer 2.5), not Fast variants.
- When Always Free Ampere capacity appears, launch and hold the VM — do not only notify.
- Push this repo with the Haris-Rahat-Dev GitHub account. Workflow for any commit/push here: `gh auth switch --user Haris-Rahat-Dev` → commit → push, then `gh auth switch --user Haris-Rahat` (the default) to leave the active account unchanged so other repos/workflows aren't affected. Do not add a Claude co-author / attribution line to commit messages.
- Prefer Tailscale private access for the hosted app; keep public HTTP closed when Tailscale is up.
- Prefer generic host/device copy in UI and docs — no Mac- or USB-specific wording.
- For the Ampere Cursor Automation, put OCI credentials as Runtime Secrets on the selected Cloud Environment (not Build Secrets); redacted values still mean present.
- Never search/enumerate credential files on disk (`find`/`mdfind`/broad `ls` for `*.pem`, keys, `.env`, etc.); ask for an exact path or have the user paste — EDR treats that hunt as sensitive-data enumeration.

## Learned Workspace Facts

- Hosted StickerForge needs a long-running VM with ffmpeg/cwebp/webpmux; SQLite + local disk is enough for v1.
- OCI home region for this project is `ap-mumbai-1`; Always Free Ampere A1 Flex is often out of capacity there.
- When A1 is unavailable, Always Free `VM.Standard.E2.1.Micro` is the interim shape (~1 GB RAM; needs swap for npm/ffmpeg).
- Ampere capacity retries are intended as a Cursor Automation named “Hold Always Free Ampere A1” (procure-and-hold, ~every 5 minutes), not a checked-in local loop.
- Hosted app HTTP is Tailscale-only (VM iptables allows `:3210` on `tailscale0`; public `:3210` closed); laptop and phone need Tailscale on the same account. VM tailnet hostname is `stickerforge`.
- VM SSH uses the launch `authorized_keys` pubkey (not an OCI console `.pem`); Tailscale SSH is not enabled — `ssh ubuntu@<tailscale-ip>` still authenticates with that key over the private path.
- Android debug builds bake `API_BASE` to the Tailscale host so pack fetch works without USB/`adb reverse`.
- Web deploy to the VM is still manual (`npm run build` → rsync `web/dist` → restart `stickerforge`); no CI/push-to-deploy yet.
- Hosted backups: `backup.sh` on the VM (SQLite snapshot → tar `data/` → OCI Object Storage → prune to 7); bucket `stickerforge-backups` in `ap-mumbai-1` via instance principal; `.backup.env` is gitignored and holds the Object Storage namespace on the VM; nightly cron runs on the VM (see `docs/backups.md`).
- OCI MCP “connected” only means the server process started; Object Storage/IAM calls still need a valid `OCI_CONFIG_PROFILE` with working API signing.
- Auth: `firebase-admin` when `FIREBASE_SERVICE_ACCOUNT` is set; otherwise anonymous `sf_uid` cookies and no sign-in UI so dogfood/deploy works without a Firebase project.
