# Accounts, durable stickers, and the pack canvas

Date: 2026-09-20
Status: approved, not yet implemented

## Problem

The editor presents one grid of cards that silently carries three unrelated
meanings at once: the uploaded source file, its encode status, and whether its
finished job belongs to whichever pack the toolbar dropdown currently selects.
Switching packs relabels every card without moving anything, which reads as a
bug. The pack itself has no body — it is a `<select>` and a count — so it cannot
be ordered, inspected, or understood before it is built.

Underneath that, identity is an anonymous `sf_uid` httpOnly cookie
(`server/src/index.ts:34`). Files, jobs, and packs are correctly scoped to it,
but the scope is unnamed, unportable, and unrecoverable: a new browser or a
cleared cookie orphans the data on disk. StickerForge cannot be launched to
users in that state.

## Model

Three nouns, each with one job. This replaces the current two-noun model where
"file" tries to be both the raw upload and the sticker.

**Source** — an uploaded video or image. Transient. Lives in the staging shelf
while the user iterates on it. Deleted when the pack containing its sticker is
built.

**Sticker** — the encoded artifact (today's `job` and its WebM plus tray PNG).
Durable, owned by the user, reusable in any number of packs, searchable.

**Pack** — an ordered list of sticker references, buildable and shippable to
WhatsApp.

The existing schema already supports this. `pack_stickers(code, position,
job_id)` is a join table, so a job can belong to several packs with no change.

### Editability is derived, never stored

A sticker is editable **iff its source file still exists**. No new column and no
state machine. Building a pack deletes the sources of its stickers, which locks
them; sources uploaded afterwards stay editable until the next build. The lock
badge in the UI reads off exactly this fact.

This is safe because pack WebPs are assembled from the already-converted WebM,
not from the source (see `assemblePack` in `server/src/index.ts` and the gotcha
in AGENTS.md). Rebuilding a pack after its sources are gone works unchanged.
Only re-cropping needs the original, and re-cropping is precisely what the lock
forbids.

## Screens

### Sign in

Firebase Auth, Google and email/password. Unauthenticated users see only this
screen. No anonymous mode — work that follows the user is the entire point.

### Packs home

The landing screen for a returning user. A grid of pack cards showing tray icon,
name, sticker count, state chip (`Draft` or `Built · v3`), and last-updated time.
`+ New pack` creates one. A per-card menu offers Open, Rename, Delete.

A sibling tab, **All stickers**, lists every sticker the user owns. It is both
the search surface and the picker for cross-pack reuse.

### Pack canvas

The workspace. The header carries back-to-packs, an inline-editable pack name,
the state chip, and Build. Two zones sit below it.

**Staging shelf** — horizontal, pinned above the sheet, collapsed to zero height
when empty. One card per uploaded-but-uncommitted source: thumbnail, quality
chip, `Edit & add`, and `✕` to discard. The shelf's presence is the "you have
unfinished work" signal; its absence means everything is filed. This is why the
layout is asymmetric rather than a 50/50 split — the shelf is empty most of the
time, and the pack is what the user returns to.

**Sticker sheet** — the main grid, drag to reorder. Below three stickers the
shortfall renders as outlined empty slots, so WhatsApp's minimum is visible
rather than explained in prose. Each sticker tile shows a hover preview, its
emojis, and a lock badge when its source is gone. Its menu offers Fine-tune
(editable stickers only), Replace, and Remove.

An `Add existing` action opens the stickers picker for cross-pack reuse.

**Replace** is how a locked sticker gets fixed. It opens the file picker, stages
the new source, and on commit writes the resulting job into the *same index* of
the pack's ordered array rather than appending. The old sticker is detached from
this pack and garbage-collected by the reference count if no other pack holds it.
This exists so that pack order survives a correction, which matters once a pack
has a dozen stickers in it.

### Install

Becomes a drawer over the canvas rather than a screen that replaces it, so the
pack stays visible while the user scans the QR.

## Authentication

Firebase Auth on the Spark (free) plan: 50K monthly active users, no billing
account, no card. Cloud Storage and Cloud Run are Blaze-only and are therefore
not used. Compute, binaries, and SQLite stay on the OCI Always Free VM.

The middleware at `server/src/index.ts:34` stops parsing the `sf_uid` cookie and
starts verifying a Firebase ID token from the `Authorization: Bearer` header,
using `jose` against Google's published public certs. `firebase-admin` is not
needed for verification alone and is not added.

`req.userId` becomes the Firebase `uid`. Every `owner === req.userId` check
downstream is untouched — `owner` remains an opaque string, it simply stops
being a random cookie value and starts being an account.

The cookie is never set again. No claim or migration path is built; existing
anonymous data is abandoned deliberately (decision: start fresh).

Because `owner` stays opaque, a later move to Cloud Storage and Cloud Run is a
storage-layer swap with no identity migration and no user-visible event.

## Firestore

Firestore is used for one thing that measurably improves the product: **job
status and progress**. `web/src/App.tsx:44` currently polls `getJob` every 600ms
until an encode finishes. A Firestore listener replaces that loop and gives live
progress across tabs and devices, free on Spark.

The split is deliberate:

- **Firestore** — pack metadata, sticker metadata, job status and progress.
- **SQLite on the VM** — file records, encode settings, disk paths.
- **VM disk** — all binaries. Videos never go to a third party.

Everything is not moved to Firestore because `GET /api/pack/:code` serves the
Android app, whose fetch times out at 30s. That path must not acquire a network
round-trip to another provider.

## Server changes

- Auth middleware verifies a Firebase ID token instead of reading a cookie.
- `POST /api/packs/:code/build` deletes the source files of every member job
  **after** the manifest is written and verified. A failed build deletes nothing
  and leaves the pack a draft.
- `DELETE /api/packs/:code` no longer deletes its stickers' outputs
  unconditionally. It removes the pack, its built directory, and only those
  sticker outputs whose reference count in `pack_stickers` has dropped to zero.
- New `DELETE /api/sticker/:jobId` deletes a sticker everywhere: its rows in
  `pack_stickers`, its WebM, tray PNG, and any surviving source.
- New `PATCH /api/sticker/:jobId` sets the sticker's emojis (1–3), written into
  the manifest at build time.
- `PUT /api/packs/:code/stickers` is unchanged. It already replaces the whole
  ordered array, which serves reorder, cross-pack add, and replace-in-place
  alike.

### Reference counting

A sticker's output files are removable only when
`SELECT COUNT(*) FROM pack_stickers WHERE job_id = ?` returns zero. This is the
one real complexity that cross-pack reuse introduces and it is unavoidable given
reuse. It is a single query at two call sites — pack delete and sticker remove.

## Client changes

`web/src/flow.ts` gets smaller. `stage` becomes a route (`packs` | `pack`), and
the `encoded` localStorage map at `web/src/App.tsx:16` is **deleted outright** —
it existed to remember which encodes belonged to this browser, which is the exact
problem accounts solve. Committed stickers are the pack's `jobIds`; staged
sources are files with no job. Both lists come from the server.

The quick-convert-then-add two-step collapses: every commit now goes through the
editor, so `quickConvert` and its separate membership write become one action.
`Editor.tsx` keeps its preview and controls; its primary button becomes
`Add to pack` for a staged source and `Save changes` when re-opened on an
editable committed sticker, which re-encodes and replaces the job at the same
position.

Search on the All stickers screen filters over filename, emojis, and pack
membership client-side. It is a `.filter()`, not an index, until the list is
large enough to justify otherwise.

## Error handling

- Build failure leaves sources intact and the pack in `Draft`.
- Source deletion runs only after the manifest exists on disk.
- Token expiry refreshes through the Firebase SDK; a hard 401 returns to sign in.
- Sign-out clears client state and returns to sign in.
- Unsupported uploads are rejected at the shelf, as today.
- A pack whose sticker count drops below three cannot be built; the Build button
  states the shortfall rather than disabling silently.

## Testing

Additions to the existing e2e suite (`npm run test:e2e`):

1. Building a pack deletes its member sources.
2. Rebuilding a pack still succeeds after its sources are deleted.
3. Replace-in-place preserves the sticker's position in the pack.
4. Deleting a pack does not delete a sticker that another pack still references.
5. Unauthenticated API requests return 401.
6. `GET /api/pack/:code` still serves the cached pack without auth, for Android.

## Out of scope

Pack templates and encode presets, pack duplication, and any migration of
existing anonymous data. Cloud Storage, Cloud Run, and CDN pack delivery are
deferred until the free tier is outgrown; the design keeps that path open.

## Implementation order

Strict, so the work can be cut at any line and still ship something coherent:

1. **Auth** — Firebase Auth, token verification, `owner` becomes uid. Unblocks
   launch on its own.
2. **Model** — the Source/Sticker/Pack split, derived editability, source
   deletion at build, reference counting.
3. **UI** — packs home, pack canvas with staging shelf, install drawer.
4. **Reuse** — All stickers screen, search, cross-pack add, emoji editing.
5. **Firestore** — job status listener replacing the poll loop.

## Known risk outside this spec

The VM is currently `VM.Standard.E2.1.Micro` (~1GB RAM with swap) because Ampere
A1 capacity was unavailable in `ap-mumbai-1`. That is adequate for one person
dogfooding and inadequate for concurrent two-pass VP9 encodes from real users.
Landing the A1 instance is a harder prerequisite for launch than anything in this
document.
