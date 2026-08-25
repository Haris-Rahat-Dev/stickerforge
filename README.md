# StickerForge

WhatsApp video sticker maker — trim, crop, and compress any video into spec-perfect animated stickers (WebM/VP9, 512×512, ≤30fps, ≤6s, <500KB, silent).

## Local development

Requires Node 20+, ffmpeg (`brew install ffmpeg`).

```bash
npm install
npm run dev        # API on :3210, Vite UI on :5173
```

## Production

```bash
npm run build
npm start          # serves UI + API on :3210
```

## Tests

```bash
npm run typecheck  # strict TS across server + web
npm run test:e2e   # boots isolated server, runs 44 API/spec assertions
```

The E2E suite uses two sample videos from `~/Downloads` — adjust `SAMPLE_A`/`SAMPLE_B` in `scripts/e2e.sh` if missing.

## Docker

```bash
docker build -t stickerforge .
docker run -p 3210:3210 -v stickerforge-data:/app/data stickerforge
```

## API

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/upload` | multipart video → FileRecord (probe + quality verdict) |
| GET | `/api/files` | list imported files |
| DELETE | `/api/file/:id` | remove import |
| GET | `/api/video/:id` | stream original (range-supported) |
| GET | `/api/filmstrip/:id` | 12-tile thumbnail strip |
| GET | `/api/cropdetect/:id` | detect baked black borders |
| POST | `/api/convert` | settings → `{ jobId }` |
| GET | `/api/job/:id` | progress + result metadata |
| POST | `/api/batch` | convert many with defaults |
| GET | `/api/download/webm/:jobId` | final sticker |
| GET | `/api/download/tray/:jobId` | static tray icon |
