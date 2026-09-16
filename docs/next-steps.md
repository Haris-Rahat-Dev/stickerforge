# StickerForge — Next-Steps Spec

Written after the first pack passed WhatsApp validation and rendered in
`AddThirdPartyStickerPackActivity` (the whitelist gate in AGENTS.md is now cleared).
Scope: make packs **updatable**, make the server **multi-user**, and close the
**crop UX gap**. Ordered by dependency — persistence first, because updatable
packs and multi-user both need it.

---

## 0. Current reality (what exists today)

- **State is in-memory.** `files` and `jobs` are global `Map`s in `server/src/index.ts`.
  A process restart wipes them; the pack route rebuilds from "the last 3–6 done
  jobs" in that one shared map.
- **No entities, no ownership.** No user, no persisted pack. `code` is an open URL
  param (`/api/pack/:code`); the Android app hardcodes `PACK_CODE = "demo"`.
- **Pack identifier is a fresh timestamp per build** (`stickerforge-${code}-${Date.now()}`),
  and `image_data_version` is hardcoded `"1"`. So WhatsApp can neither dedupe nor
  refresh a pack it already has.
- **Cropping** is `cover` + center + black-border autodetect in batch, with no
  per-video override reachable from the batch UI (Fine-tune is broken).

Everything below is the delta from that.

---

## 1. Persistence (foundation) — DONE

Files + finished jobs now survive a server restart.

- **Store:** SQLite at `data/stickerforge.db` via the **built-in `node:sqlite`**
  (Node 22.5+) — no dependency, no native build. `server/src/db.ts`.
- **Shape:** records are JSON-serializable, so they're stored whole (`files(id, json)`,
  `jobs(id, file_id, json)`) — no per-field schema to maintain. Loaded into the
  in-memory Maps on boot; the rest of the server is unchanged.
- **What persists:** files on upload; jobs only when **done** (a running encode's
  ffmpeg dies with the process, so it can't resume). Boot skips rows whose backing
  file on disk is gone.
- **Node floor:** this raises the requirement from Node 20 to **Node 22.5+**
  (AGENTS.md still says Node 20 — update it, or swap to `better-sqlite3` if Node 20
  support is needed; same synchronous API).
- **Not yet modelled as tables:** `packs` / `pack_stickers` (still rebuilt on demand
  + client-side selection). Add those with the multi-user work (§3).

---

## 2. Updatable packs — DONE

Re-adding a pack now updates the same WhatsApp pack instead of duplicating it.

- **Stable identifier per code**, generated once and persisted in the `packs` table
  (`server/src/db.ts`), reused on every rebuild.
- **`image_data_version` bumps** on each build (persisted, monotonic) — WhatsApp
  reloads the pack's images only when it increases.
- Both survive a restart, so a restart can't regenerate the identifier and spawn a
  duplicate. Verified: two builds → same identifier, version 1 → 2.

Original plan retained below for reference.

- **Stable identifier.** Generate the pack `identifier` **once**, at pack
  creation, and persist it in `packs.identifier`. Never regenerate on rebuild.
  Drop the `Date.now()` suffix.
- **Bump on change.** Maintain `packs.image_data_version` as an integer. Increment
  it whenever the pack's sticker set or any sticker's bytes change (hash the
  ordered sticker files; bump when the hash changes). WhatsApp reloads a pack's
  images only when this number increases — this is the actual "update" mechanism.
- **Provider passthrough.** `StickerContentProvider` already reads
  `image_data_version` from the manifest; just make sure the server writes the
  current integer into the manifest it serves.
- **Re-add flow.** "Add to WhatsApp" with an unchanged identifier + higher version
  updates the existing pack in place — no user action beyond tapping Add again.

Acceptance: edit one sticker, rebuild, re-add → the *same* WhatsApp pack shows the
new sticker (no duplicate pack appears).

---

## 3. Multi-user — DONE

Shipped: anonymous per-browser identity, owner-scoped files/jobs, multiple named
packs, real pack codes, and a QR/deep-link handoff to the phone.

- **Identity:** random httpOnly `sf_uid` cookie (no login). The phone stays
  auth-less — it reads a pack by its unguessable **code**.
- **Scoping:** `owner` on files/jobs/packs; every endpoint filters to the caller.
  `GET /api/pack/:code` (+ `/file/:name`) stays public for the phone; all mutations
  are owner-checked. Verified: two cookie sessions can't see each other's files or
  build each other's packs, but either can read a pack by code.
- **Multiple named packs:** `packs` + `pack_stickers` tables; pack CRUD + membership
  endpoints; web pack switcher (create/rename/delete/select), active-pack tray.
- **Handoff:** web Install stage shows a QR of `stickerforge://pack/<code>` + the
  code; the Android app has a `stickerforge://pack` intent-filter (no in-app
  scanner — the phone camera scans, an `<intent-filter>` opens the app) plus a code
  field fallback. Verified on device: deep link → app prefilled the code, auto-loaded
  the pack (cross-user, public read), and WhatsApp's confirm dialog showed the pack.
- **Not signed cookies** (local threat model is nil) — a hosted deployment should use
  signed sessions. **Not done:** feed/sharing/remix (still deferred).

Original plan retained below for reference.

- **User identity.** Lightweight: a `user_id` cookie/token minted on first visit
  (no passwords yet). Enough to scope `files`, `jobs`, `packs` by `owner_id`.
- **Real pack codes.** Replace hardcoded `"demo"`. A pack gets a random unguessable
  `code` at creation; the Android app receives it (QR or paste) instead of assuming
  `demo`. `/api/pack/:code` resolves the persisted pack, not "last N jobs."
- **Ownership checks.** `code` alone grants read (needed — the phone fetches with no auth). Mutations (rebuild, add/remove sticker)
  require the owner's `user_id`. This is the "possession logic" that's absent today.
- **Pack = explicit entity.** Building a pack becomes "create pack from these N
  jobs" (persisted `pack_stickers` rows), not an implicit "grab the last 6 done."
  This also removes the ordering fragility and the accidental-duplicate-sticker
  problem seen during the demo.

Acceptance: two browser sessions upload different videos; each builds a pack; each
phone loads only its owner's pack via its own code.

---

## 4. Editing & crop UX — the staging tray

**Remove batch mode entirely.** Replace the batch-vs-individual split (and its
disconnected results table, invisible crops, and dead Fine-tune button) with one
surface: the list of uploaded videos, where each card carries its own state.

### The tray

Each uploaded video is one card showing:

- A **preview thumbnail** rendered as the actual cropped 512×512 square — so the
  auto-crop is visible *before* the user commits. A clip that lost its caption is
  obvious at a glance.
- A **status chip**: `Needs review` (uploaded, auto-defaults applied, unconfirmed)
  → `Ready` (accepted/edited) → `In pack` (encoded, size badge e.g. `480KB`).

A **header progress line** — the thing the user wants — reads e.g.
`3 of 5 ready · 3 in pack`, with a **Build pack** button that enables at ≥3 in-pack.

### Flow

1. Upload → auto-defaults + cropdetect run, thumbnail appears, chip = `Needs review`.
2. Thumbnail looks right → tap **Add to pack** → encodes now (decision below),
   chip → `In pack` with size badge.
3. Thumbnail looks clipped → tap the card → editor opens seeded with the card's
   settings → change fit / pan (`cropPos`) / crop → **Add to pack**.
4. At ≥3 in-pack, **Build pack** assembles instantly (all stickers already encoded).

For a good clip this is **one tap** — no slower than batch was — but the crop is
seen and confirmed, not silently applied.

### Encode timing (decided)

**Encode on "Add to pack," per card.** Each card runs its two-pass VP9 (~90s) when
marked in-pack, with per-card progress. By the time the user hits Build pack every
sticker is done, so pack assembly is instant (assembles the already-encoded
stickers into WebP + manifest). Spreads the wait across the session instead of one
long stall at the end.

### What this fixes

- **Disconnected jobs** — the card *is* the job; one source of truth (needs §1 to
  persist across restarts).
- **Invisible crops** — thumbnail shows the real cropped result pre-commit.
- **Dead Fine-tune** — tapping any card opens the editor; there is no separate
  Fine-tune affordance to break.
- **Accidental duplicate stickers** — the pack is built from explicit in-pack cards
  (§3 `pack_stickers`), not "the last N done jobs."

Acceptance: a portrait clip whose caption got cropped is visibly clipped in its
thumbnail, re-fit to `contain` or panned from its card in ≤2 taps, and the
corrected sticker is what lands in the pack.

---

## 4b. Flow management (decided: typed reducer + explicit stages)

Today the flow is implicit — four stages mashed into one screen with state scattered
across ad-hoc `useState`s (`files`, `pack`, `building`, `built`, `editingId`), and one
stage missing entirely. Fix: model it explicitly.

- **App stages** as a discriminated union: `import → stage → build → install`. No XState —
  a single `useReducer` with typed actions. Enough structure without the ceremony.
- **Per-entity lifecycles** as status enums, not ad-hoc strings:
  - file: `uploaded → reviewing → queued → encoding → in-pack → error`
  - pack: `draft → building → built → stale` (stale = edited since last build)
- **Add the Install stage** (missing today): after Build, show the pack summary +
  the phone handoff steps (Load pack → Add to WhatsApp). QR deep-links into the app;
  the phone fetches the pack from the StickerForge host (e.g. over Tailscale).

## 4c. Job execution (decided: in-process queue + SQLite, no Redis)

- **Concurrency-limited queue** (`server/src/queue.ts`, `createLimiter(2)`) so parallel
  two-pass VP9 encodes don't thrash the CPU. **Done.** Jobs enter `queued`, promote to
  `encoding` when admitted.
- **Persist jobs/files to the SQLite table** from §1 so they survive a server restart
  (browser-refresh survival already shipped via localStorage + `/api/files` rehydrate).
- **Not BullMQ/Redis** — that's a second always-on service for a single-process local
  tool. Graduate to it only at the hosted, multi-worker stage (§4/hosted-future).

## 5. Sequencing

1. ~~**Persistence** (SQLite)~~ — **DONE** (files + done jobs survive restart).
2. ~~**Staging tray**~~ — **DONE** (one list, per-card status, header progress, per-card encode).
3. ~~**Flow management + queue**~~ — **DONE** (typed reducer + stages + install; concurrency-capped encode queue).
4. ~~**Updatable packs**~~ — **DONE** (stable identifier + `image_data_version` bump, persisted).
5. ~~**Multi-user**~~ — **DONE** (identity, scoping, named packs, QR/deep-link handoff).

1–3 are local-only and shippable on the current single-process app. 4 is the
gateway to the hosted API (Fly/Hetzner + R2) and accounts that AGENTS.md parks
until a pack lands in WhatsApp — which it now has.
