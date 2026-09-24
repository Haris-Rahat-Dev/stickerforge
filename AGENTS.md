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
npm test             # node:test unit tests (auth, model, flow, reap, probe, …)
npm run test:corpus  # ~4 min: synthesises 7 clips, encodes them, asserts measured spec
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
  reap.ts            boot-time sweep of media no record can reach (orphans, .next)
  probe.ts           ffprobe + quality score + cropdetect
  convert.ts         two-pass VP9 WebM, <500KB with bitrate retry
  budget.ts          WhatsApp WebP fps ladder + motion-budget (24fps floor)
  webp.ts            ffmpeg frames → img2webp mixed/delta animated WebP
  jobfeed.ts         in-process job event bus (SSE fan-out)
  sticker.ts         derived editability, StickerView, emoji normalization
  auth.ts            firebase-admin ID token verify + public-path allowlist
  types.ts           shared models
android/             Java + AndroidX/Material — StickerContentProvider (dependency-free) + importer screen
data/                uploads, outputs, trays, packs, stickerforge.db (gitignored)
```

Dev: two processes (Vite HMR + API). Production/`npm start`: Express serves `web/dist` and the API. Bind is `HOST` (default `127.0.0.1` — Docker must set `0.0.0.0` or the container is unreachable).

Flow: **packs home → pack canvas → build → install drawer**. The home screen lists your packs. Opening one shows the canvas: a **staging shelf** of uploaded-but-uncommitted sources on top, collapsed to nothing when empty, above the **sticker sheet** that is the pack itself (drag to reorder, outlined empty slots below three). Editing a staged source in the editor and committing it moves it down into the sheet. At ≥3, Build assembles the WebP pack, **deletes the sources**, and opens the install drawer over the canvas.

**Loading states.** Nothing renders a false empty state while a fetch is in flight: `packsLoaded`, a `null` sticker list and `shelfLoading` drive shimmer placeholders (`.skeleton`, `.skel-line`, `.skel-card` — exempt from the cards' die-cut entrance or they're invisible while needed). Uploads are fetched with packs at start and cached in `state.files`, so opening a pack derives its shelf immediately and refreshes behind it — the shelf used to pop in ~0.4s after the sheet over Tailscale and shove it down. Images fade in over a shimmer (`.fade-img` → `.is-ready`, also on error so a missing file never shimmers forever); a pack's tray is only requested once it's built. To see these locally, put a proxy that delays `/api/*` in front of Vite — the local API is too fast to show them.

App state is one reducer with three routes (`web/src/flow.ts`): `packs`, `pack`, and `stickers`. There is no router dependency and no localStorage — identity is a Firebase Auth uid when configured, otherwise an anonymous `sf_uid` cookie.

`PUT /api/packs/:code/stickers` sets the pack’s ordered `jobIds`. `POST /api/packs/:code/build` re-encodes those to WebP, writes `data/packs/<code>/` + manifest, then deletes the sources. `GET /api/pack/:code` (Android) serves only a cached pack — 404 if never built; it must never rebuild (Android’s fetch times out at 30s). Files + done jobs are persisted (SQLite), so they survive a restart.

## Editor / encode rules

Preview **must** match the encode: square crop on the stage, trim loop, white inset. If preview and ffmpeg diverge, that’s a bug.

**Modes.** The editor opens in **Short** (source fps, as long as fits) with **Long** (15fps, up to 6s; hidden when the source is ≤15fps) and **Custom** (the full timeline/crop/fps editor) beside it. Presets encode the real WebP as soon as they're picked and whenever their fixed-length window is released (`lockLength` on `Timeline`); on a byte-budget failure they refit via `nextFitLength()` in `web/src/budget.ts` — the encoder's `fitSeconds` comes from a q50 sample and undershoots, so it bisects before taking the safe figure. Custom previews only after **Generate**. Switching to Custom starts from exactly the preset's settings, so its result stays addable until something changes.

**Review before commit.** Editor encodes are `draft: true` jobs: hidden from `GET /api/stickers`, discarded by `DELETE /api/job/:id` (keeps the source) when replaced, stopped, or the editor closes, and turned into real stickers by `PUT /api/packs/:code/stickers`. Boot discards drafts older than 24h that no pack holds. Cancel/discard now kills ffmpeg: `startJob` runs the task under `encodeSignal` (AsyncLocalStorage in `webp.ts`), which every spawn picks up — otherwise abandoned preset encodes held the two encode slots.

**Timeline.** The filmstrip is a sprite (`/api/filmstrip`, `<id>-film.jpg`, 128px tall) that `stripTiles()` lays out as source-aspect thumbnails — never stretch it as one image (that made slivers). Ruler scrubs; the lane grabs cuts. While the encoded sticker is on screen the source is parked and the playhead (green) follows the sticker's loop via `sourceTimeAt()`; an animated `<img>` has no clock, so it is timed from the image's load. Keys: space, ←/→ frame, I/O in/out, C cut (Custom).

**Layout.** Preview on top, the timeline full-width under it, config (modes, measured spec, fps, estimate) below — the timeline needs the width.

**Smooth seams** (`∞` in the transport, `POST /api/seams`, `server/src/seams.ts` + scoring in `loop.ts`). Every join is a seam: each cut between pieces, plus the loop from the last piece back to the first. Each piece end belongs to exactly one seam, so they're scored in order on one cached whole-clip pass of 16×16 gray fingerprints taken *with the sticker's crop/fit* (~0.1–0.3s even for 65s). A seam's cost is how far the next piece's first frame is from the frame that *would have come next* — that, not the last shown frame, separates a forward continuation from a one-frame twitch. Verdicts (seamless/smooth/noticeable/jump/hard) are relative to one normal *moving* step measured over the **whole clip** — measuring it per window or over the kept pieces made the yardstick move with the cut, so pressing again kept "improving" things; one press must be idempotent (tested). It picks the best level, then the longest loop / the smallest cut move among near-best costs, and changes nothing unless the level improves. **Loop seams only trim; cuts may move ±1.5s and grow the sticker** (up to 6s, reported as "+Ns longer — check the size estimate"). A *hard cut* is one isolated spike (both neighbouring steps small) — sustained motion (zooms, a leg sweeping past, fades) is not; a seam across a hard cut is a "shot change" and left alone. Pieces running into (or starting on) blank frames get a warning with an "End at…" fix. Live markers on the timeline show each seam; click one to snap just it. Presets hand over to Custom.

- **Crop** is a square box on the full frame (drag / corner-resize). Default is the largest centered square (same as cover-center).
- **Fit whole** — contain + letterbox so portrait/landscape memes keep the entire frame.
- **White border** — opt-in 460px content + 26px white pad. Stops WhatsApp rounded-corners / built-in maker from clipping edge text. Off by default.
- **FPS:** source, cap 30. Do **not** upsample GIF-sourced 10–17fps. WhatsApp WebP uses `img2webp` mixed/delta encoding: quality first (q≥70), then 24fps floor. Consecutive identical frames are held as one long frame. The 24 floor is the encoder's automatic ladder only: the editor's **Frame rate** control (`fpsChoices()` in `web/src/budget.ts`) lets the user pick source/24/20/15 — never above source — trading smoothness for seconds or sharpness. Busy 30fps footage fits ~2.5–4.5s at 24; 15fps buys roughly 60–90% more (measured: smol_silly_cat 2.5s→4.8s).
- **Speed** (Custom: 1×–8×; server clamps 0.25–8). The 6s cap is on the *sticker*, so up to 6 × speed seconds of source may be kept (`normalizeSpans(…, maxKept)`, `maxSrcSpanForSpeed`); `outDur = kept / speed` everywhere a length is judged (budget, estimate, concat encodes). The preview plays at `playbackRate = speed`. Measured on a busy clip: 4s of source at 2× fits at q70 (worst frame 0.987) where the same 4s at 1× needs q30 — speed is a real quality lever, not just a meme effect.
- **Quality floor.** `minQ` in `ConvertSettings` (unset = 30). Presets send 50 and refit shorter instead: q30 turns smooth skin into visible 8px blocks (ray clip, Short went 4.3s blocky → 3.3s clean). Luma SSIM badly under-reports this blockiness (0.965 on a visibly blocky face) — look at a zoomed crop before trusting a score. `settingsKey` ignores `minQ` so Custom still recognises a preset's result.
- **Budget:** Add allows up to 6s. All-motion estimate (~4s at 30fps) is a warning with a safer-trim button; holds can still make a longer cut fit. Encoder fails closed if it will not.
- Bitrate: `computeBitrateKbps` targets ~470KB for the WebM; WebP is encoded from the **original** at Add (cached) so pack build is a copy.
- Staging shelf rehydrates from `GET /api/files` when a pack opens — reload does not drop uncommitted uploads.
- Quality bpp warn is 0.02; flat 3D animation (JoeVerse) false-alarms — expected.

Good meme defaults: square crop, black-border auto available, 2–4s (budget-capped), 1×, source fps cap 30, joke in the first second.

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

## Verified output, not requested output

Every finished sticker carries a `spec` (`StickerSpec` in `types.ts`) **measured out of the encoded WebP** by `inspectWebp()`/`frameSsim()` in `webp.ts` — canvas size, real frame count, real average fps from the frame durations, real duration, and luma SSIM of the muxed first frame against the PNG frame that produced it. Nothing the UI presents as "within WhatsApp limits" may come from the settings that were asked for; `specLines()` in `web/src/budget.ts` judges the measured file. Images no longer fabricate `outMeta`.

This is what caught the single-frame defect below, and it is cheap (two 512² ffmpeg passes on a job that already takes ~30s).

**Persistence rule:** `files.path`, `jobs.outputPath` and `jobs.trayPath` are stored **relative to `DATA_DIR`** and re-rooted on load. A backup restored to a different directory, or a changed `DATA_DIR`, therefore still resolves. `initDb()` normalises legacy absolute rows once (idempotent fixpoint) after copying the DB to `stickerforge.db.pre-path-normalise.bak`; it never touches files, and a path whose target is missing is left exactly as it was. Boot now logs how many records it drops instead of dropping them silently.

## Live encode progress

`GET /api/job/:id/stream` is a Server-Sent Events stream of `{status, progress, stage, sizeBytes, error}`. It emits current state immediately, closes itself on a terminal status, and pings every 25s to survive idle proxies. The client's `watchJob()` uses it and falls back to polling if the stream cannot be opened.

**Firestore was considered and rejected for this.** Progress is written by the server, so Firestore would need a service-account credential on the VM plus `firebase-admin` or a hand-rolled JWT exchange — real operational cost for cross-device sync that encode progress does not need. Firestore remains a reasonable future choice for pack and sticker metadata, which is a different problem.

## Gotchas

- `npm run dev` dies if the API process is killed; Vite alone is a blank proxy. Hard-refresh (⌘⇧R) after CSS/geometry fixes.
- E2E samples are specific files in `~/Downloads`; missing files → suite fails at upload.
- **Measuring a sticker against its source:** never resample the decoded WebP with `fps=N`. Frame durations are stored as whole ms (24fps → 42ms, not 41.67), so the timelines drift a full frame apart after ~60 frames and fast motion then scores like a disaster (it made q50/2× look blocky at SSIM 0.79 when they were 0.98). Decode with `-fps_mode passthrough` and compare index-to-index against the frames that were muxed.
- **Ghosting is keyframe spacing, not a decode bug.** Lossy delta frames reuse the previous frame wherever a pixel moved less than a q-dependent threshold, so error accumulates until the next keyframe (Cat: SSIM slid 0.97→0.93 over 18 frames, then snapped back). `IMG2WEBP_HEAD` uses `-kmin 2 -kmax 6`: worst-frame 0.941→0.953 for +2KB on busy clips, ~10% more bytes on static ones (kmax 3 cost static clips ~37%). The spec's `ssim` measures frame 1 — always a keyframe — so it cannot see this; don't read a good Detail figure as "no ghosting".
- The VM runs Ubuntu 22.04's ffmpeg 4.4 and libwebp 1.2.2: ffmpeg cannot decode animated WebP there, so `frameSsim()` falls back to `webpmux -get frame 1` + `dwebp`. `-sharp_yuv` is skipped on that img2webp.
- **Never encode the pack WebP from the WebM.** That second lossy generation was the pixelation. Convert writes `data/webp-cache/<jobId>.webp` at Add (from the original, `job.settings` applied once), and `assemblePack` copies that. On a cache miss it **re-encodes from the original source** with `...job.settings` — correct there, and only there. If the source is gone too it fails closed and names the sticker; do not "fix" that by falling back to the WebM.
- **`probeVideo` returns display dimensions, not coded ones.** ffprobe's `width/height` are coded; ffmpeg auto-applies the display matrix on decode. A portrait phone clip is coded 1920×1080 with `rotation: -90` and decodes as 1080×1920 — cropping against the coded numbers puts the box on the wrong axis. `displaySize()` swaps for ±90/270. Everything downstream (`squareCrop`, `sanitizeCrop`, the crop-box overlay, `cropdetect`) assumes display space.
- **A motionless trim must still be an animation.** `collapseHolds` can reduce a still clip to one held frame; feeding `img2webp` that frame twice yields a **static** WebP (it dedupes them), which WhatsApp refuses inside an animated pack. `muxImg2Webp` special-cases `frames.length === 1` to `cwebp` + two `webpmux -frame` entries. The `spec.frames >= 2` assertion in `webp.test.ts` guards it.
- `-t` in `webp.ts`/`convert.ts` is a **source** span while `setpts=PTS/speed` compresses the timeline afterwards. `planSpan()` in `budget.ts` returns `srcSpan` (for `-t`) and `outDur` (for everything else) — never pass one where the other belongs. `parseSettings` clamps the trim so `outDur` can't exceed 6s at any speed.
- **Hold detection thresholds are measured, not guessed.** At 16×16 gray a re-encoded photographic still peaks at 0–1 per pixel; a ticking counter peaks at 6, a mandelbrot zoom at 4–6, handheld phone footage at 28–55. `HOLD_MEAN_MAX = 0.5` / `HOLD_PEAK_MAX = 2` sit in that gap. Loosening them silently throws away motion — that is what a perceptual hash did here.
- An all-motion 6s clip is not a corpus fixture: it took 23 minutes to encode. The corpus uses a 6s *held* scene to prove duration legality and leaves the busy-6s rejection to `budget.test.ts`.
- `verify()` must be `return await` inside the `try`: a bare `return verify(...)` runs the `finally` temp cleanup while the measurement is still writing into it, which intermittently throws `ENOTEMPTY` and yields `ssim: null`.
- `npm test` lists test files explicitly by glob. A `server/test/index.js` barrel used to import a hardcoded list, so new `*.test.ts` files were silently skipped (15 tests were not running).
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
- Prefer maximizing kept frames/duration/fps within WhatsApp caps; contain/letterbox non-square sources rather than crop-away; when a cut is required, use the trim timeline as the primary fine-tune (framing/speed/fps secondary, preview-matched).

## Learned Workspace Facts

- Hosted StickerForge needs a long-running VM with ffmpeg/cwebp/webpmux; SQLite + local disk is enough for v1.
- OCI home region for this project is `ap-mumbai-1`; Always Free Ampere A1 Flex is often out of capacity there.
- When A1 is unavailable, Always Free `VM.Standard.E2.1.Micro` is the interim shape (~1 GB RAM; needs swap for npm/ffmpeg; keep encode concurrency low on this shape).
- Ampere capacity retries are intended as a Cursor Automation named “Hold Always Free Ampere A1” (procure-and-hold, ~every 5 minutes), not a checked-in local loop.
- Hosted app HTTP is Tailscale-only (VM iptables allows `:3210` on `tailscale0`; public `:3210` closed); laptop and phone need Tailscale on the same account. VM tailnet hostname is `stickerforge`.
- VM SSH uses the launch `authorized_keys` pubkey (not an OCI console `.pem`); Tailscale SSH is not enabled — `ssh ubuntu@<tailscale-ip>` still authenticates with that key over the private path.
- Web/server deploy is `./deploy.sh` (local build + rsync); the VM tree is not a git clone (`git pull` fails). After dependency changes, run `npm install` on the VM, then restart the `stickerforge` systemd unit. No CI/push-to-deploy yet. Android debug builds bake `API_BASE` to the Tailscale host; rebuild the APK only when that or the ContentProvider contract changes — pack/editor deploys need no new APK.
- After a successful build, “Show install” reopens the install drawer without rebuilding (loads the cached pack via `GET /api/pack/:code`).
- Hosted backups: `backup.sh` on the VM (SQLite snapshot → tar `data/` → OCI Object Storage → prune to 7); bucket `stickerforge-backups` in `ap-mumbai-1` via instance principal; `.backup.env` is gitignored and holds the Object Storage namespace on the VM; nightly cron runs on the VM (see `docs/backups.md`).
- OCI MCP “connected” only means the server process started; Object Storage/IAM calls still need a valid `OCI_CONFIG_PROFILE` with working API signing.
- Auth: `firebase-admin` when `FIREBASE_SERVICE_ACCOUNT` is set; otherwise anonymous `sf_uid` cookies and no sign-in UI so dogfood/deploy works without a Firebase project.
- Older Homebrew `img2webp` may reject `-sharp_yuv` (“Unknown option”); WebP mux retries skipping unknown flags — do not assume libwebp feature parity across Mac and the VM.
