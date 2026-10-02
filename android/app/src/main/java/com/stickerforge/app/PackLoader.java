package com.stickerforge.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pulls a built pack from the StickerForge server into filesDir/stickers/&lt;identifier&gt;/,
 * which is exactly where StickerContentProvider reads. Each pack has its own folder, so
 * loading one never touches another WhatsApp already holds. manifest.json is written
 * last, so WhatsApp never sees a half-downloaded pack. Every callback arrives on the main thread.
 */
final class PackLoader {

    /** Item 0 is the tray icon; the rest are the pack's stickers, in pack order. */
    static final int TRAY = 0;

    interface Listener {
        void onManifest(PackManifest manifest, String code);

        void onItem(int position, StickerSlot slot);

        void onProgress(int done, int total, int percent, String currentFile);

        void onDone(PackManifest manifest, String code);

        void onError(LoadException error);

        void onCancelled();
    }

    private static final int CONNECT_MS = 8000;
    private static final int READ_MS = 30000;
    private static final int MANIFEST_CAP = 1 << 20;
    private static final int EMIT_MS = 60;

    private final File root;
    private volatile File packDir;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean();

    private Listener listener;
    private volatile boolean cancelled;
    private volatile HttpURLConnection connection;

    private volatile String code;
    private volatile JSONObject rawManifest;
    private volatile PackManifest manifest;
    private volatile List<StickerSlot> items;

    PackLoader(Context context) {
        root = new File(context.getApplicationContext().getFilesDir(), StickerContentProvider.STICKERS);
        packDir = root;
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    /** Folder of the pack currently loaded (or loading). */
    File packDir() {
        return packDir;
    }

    boolean isBusy() {
        return running.get();
    }

    /** The tray icon at index 0 followed by the pack's stickers, in pack order. */
    List<StickerSlot> items() {
        return items;
    }

    // ── commands ─────────────────────────────────────────────────────────

    void load(String packCode) {
        if (!running.compareAndSet(false, true)) return;
        cancelled = false;
        code = packCode;
        manifest = null;
        rawManifest = null;
        items = null;
        worker.submit(() -> {
            try {
                PackManifest parsed = fetchManifest(packCode);
                if (cancelled) {
                    notifyCancelled();
                    return;
                }
                downloadAll(parsed);
            } catch (CancelledSignal signal) {
                notifyCancelled();
            } catch (LoadException error) {
                post(() -> listener.onError(error));
            } catch (Exception e) {
                post(() -> listener.onError(translate(e)));
            } finally {
                running.set(false);
            }
        });
    }

    /** Re-pulls one file; the pack becomes ready again once every item is on disk. */
    void retryItem(final int position) {
        final List<StickerSlot> slots = items;
        if (slots == null || rawManifest == null || position < 0 || position >= slots.size()) return;
        if (!running.compareAndSet(false, true)) return;
        cancelled = false;
        worker.submit(() -> {
            try {
                StickerSlot slot = slots.get(position);
                slot.set(StickerSlot.FETCHING, 0);
                post(() -> {
                    listener.onItem(position, slot);
                    listener.onProgress(done(slots), slots.size(), percent(slots), slot.fileName);
                });
                try {
                    download(slots, position, slot);
                } catch (LoadException error) {
                    slot.set(StickerSlot.FAILED, 0);
                    post(() -> {
                        listener.onItem(position, slot);
                        listener.onError(error);
                    });
                    return;
                }
                slot.set(StickerSlot.READY, 100);
                post(() -> {
                    listener.onItem(position, slot);
                    listener.onProgress(done(slots), slots.size(), percent(slots), null);
                });
                finishIfComplete(slots);
            } catch (CancelledSignal signal) {
                notifyCancelled();
            } catch (LoadException error) {
                post(() -> listener.onError(error));
            } finally {
                running.set(false);
            }
        });
    }

    void cancel() {
        cancelled = true;
        HttpURLConnection conn = connection;
        if (conn != null) conn.disconnect();
    }

    void shutdown() {
        cancelled = true;
        worker.shutdownNow();
    }

    // ── steps ────────────────────────────────────────────────────────────

    private PackManifest fetchManifest(String packCode) throws LoadException {
        JSONObject json;
        try {
            json = new JSONObject(readManifest(packCode));
        } catch (CancelledSignal signal) {
            throw signal;
        } catch (LoadException error) {
            throw error;
        } catch (IOException e) {
            throw translate(e);
        } catch (Exception e) {
            throw new LoadException(R.string.error_manifest, LoadException.KIND_MANIFEST);
        }
        PackManifest parsed = PackManifest.parse(json);
        if (parsed.entries.size() < 3) {
            throw new LoadException(R.string.error_too_few, LoadException.KIND_TOO_FEW,
                    parsed.entries.size());
        }
        rawManifest = json;
        manifest = parsed;
        packDir = new File(root, parsed.identifier);
        return parsed;
    }

    private void downloadAll(PackManifest parsed) throws LoadException {
        final List<StickerSlot> slots = new ArrayList<>();
        slots.add(new StickerSlot(parsed.trayImageFile, new String[0]));
        for (PackManifest.Entry entry : parsed.entries) {
            slots.add(new StickerSlot(entry.imageFile, entry.emojis));
        }
        items = slots;
        clearPartFiles();
        post(() -> {
            listener.onManifest(parsed, code);
            for (int i = 0; i < slots.size(); i++) listener.onItem(i, slots.get(i));
            listener.onProgress(0, slots.size(), 0, null);
        });

        for (int i = 0; i < slots.size(); i++) {
            final StickerSlot slot = slots.get(i);
            final int position = i;
            slot.set(StickerSlot.FETCHING, 0);
            post(() -> {
                listener.onItem(position, slot);
                listener.onProgress(done(slots), slots.size(), percent(slots), slot.fileName);
            });
            download(slots, position, slot);
            slot.set(StickerSlot.READY, 100);
            post(() -> {
                listener.onItem(position, slot);
                listener.onProgress(done(slots), slots.size(), percent(slots), slot.fileName);
            });
        }
        finishIfComplete(slots);
    }

    private void finishIfComplete(List<StickerSlot> slots) throws LoadException {
        if (done(slots) < slots.size()) return;
        post(() -> listener.onProgress(slots.size(), slots.size(), 100, null));
        writeManifest();
        post(() -> listener.onDone(manifest, code));
    }

    private void download(List<StickerSlot> slots, final int position, final StickerSlot slot)
            throws LoadException {
        HttpURLConnection conn = null;
        File dest = new File(packDir, slot.fileName);
        File part = new File(packDir, slot.fileName + ".part");
        try {
            mkdirsOrThrow();
            conn = open(endpoint() + "/file/" + slot.fileName, READ_MS);
            connection = conn;
            expectOk(conn.getResponseCode());
            int total = conn.getContentLength();
            long written = 0;
            long lastEmit = 0;
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(part)) {
                byte[] buffer = new byte[16384];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    if (cancelled) throw new CancelledSignal();
                    out.write(buffer, 0, read);
                    written += read;
                    if (total > 0) {
                        slot.percent = (int) (written * 100 / total);
                        long now = System.currentTimeMillis();
                        if (now - lastEmit >= EMIT_MS) {
                            lastEmit = now;
                            post(() -> {
                                listener.onItem(position, slot);
                                listener.onProgress(done(slots), slots.size(), percent(slots), slot.fileName);
                            });
                        }
                    }
                }
            }
            if (written == 0 || (total > 0 && written != total)) {
                throw new LoadException(R.string.error_file, LoadException.KIND_INCOMPLETE);
            }
            deleteIfExists(dest);
            if (!part.renameTo(dest)) {
                throw new LoadException(R.string.error_write, LoadException.KIND_DISK);
            }
            slot.percent = 100;
        } catch (CancelledSignal signal) {
            deleteIfExists(part);
            throw signal;
        } catch (LoadException error) {
            deleteIfExists(part);
            throw error;
        } catch (IOException e) {
            deleteIfExists(part);
            if (cancelled) throw new CancelledSignal();
            throw translate(e);
        } finally {
            connection = null;
            if (conn != null) conn.disconnect();
        }
    }

    private void writeManifest() throws LoadException {
        JSONObject json = rawManifest;
        if (json == null) throw new LoadException(R.string.error_manifest, LoadException.KIND_MANIFEST);
        mkdirsOrThrow();
        File target = new File(packDir, "manifest.json");
        File part = new File(packDir, "manifest.json.part");
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(json.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            deleteIfExists(part);
            throw new LoadException(R.string.error_write, LoadException.KIND_DISK);
        }
        deleteIfExists(target);
        if (!part.renameTo(target)) {
            deleteIfExists(part);
            throw new LoadException(R.string.error_write, LoadException.KIND_DISK);
        }
    }

    // ── http plumbing ────────────────────────────────────────────────────

    private String readManifest(String packCode) throws IOException, LoadException {
        HttpURLConnection conn = null;
        try {
            conn = open(BuildConfig.API_BASE + "/api/pack/" + packCode, READ_MS);
            connection = conn;
            expectOk(conn.getResponseCode());
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read, total = 0;
            try (InputStream in = conn.getInputStream()) {
                while ((read = in.read(buffer)) > 0) {
                    if (cancelled) throw new CancelledSignal();
                    total += read;
                    if (total > MANIFEST_CAP) throw new IOException("manifest too large");
                    out.write(buffer, 0, read);
                }
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection = null;
            if (conn != null) conn.disconnect();
        }
    }

    private String endpoint() {
        return BuildConfig.API_BASE + "/api/pack/" + code;
    }

    private static HttpURLConnection open(String url, int readTimeout) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_MS);
        conn.setReadTimeout(readTimeout);
        conn.setRequestProperty("Accept", "application/json, image/webp, image/png");
        conn.setInstanceFollowRedirects(true);
        return conn;
    }

    private void expectOk(int status) throws LoadException {
        if (status >= 200 && status < 300) return;
        if (status == 404) {
            throw new LoadException(R.string.error_not_found, LoadException.KIND_NOT_FOUND, code);
        }
        throw new LoadException(R.string.error_server, LoadException.KIND_SERVER,
                String.valueOf(status));
    }

    private static LoadException translate(Throwable error) {
        if (error instanceof LoadException) return (LoadException) error;
        String host = BuildConfig.API_BASE;
        if (error instanceof SocketTimeoutException) {
            return new LoadException(R.string.error_timeout, LoadException.KIND_TIMEOUT, host);
        }
        String message = error.getMessage();
        if (error instanceof UnknownHostException || error instanceof ConnectException
                || error instanceof NoRouteToHostException
                || (message != null && message.startsWith("failed to connect"))) {
            return new LoadException(R.string.error_unreachable, LoadException.KIND_UNREACHABLE, host);
        }
        return new LoadException(R.string.error_unknown, LoadException.KIND_UNKNOWN);
    }

    // ── maths & files ────────────────────────────────────────────────────

    private static int done(List<StickerSlot> slots) {
        int count = 0;
        for (StickerSlot slot : slots) if (slot.state == StickerSlot.READY) count++;
        return count;
    }

    private static int percent(List<StickerSlot> slots) {
        if (slots.isEmpty()) return 0;
        double units = 0;
        for (StickerSlot slot : slots) {
            if (slot.state == StickerSlot.READY) units += 1;
            else if (slot.state == StickerSlot.FETCHING) units += Math.min(0.99d, slot.percent / 100d);
        }
        return (int) Math.round(units * 100 / slots.size());
    }

    private void mkdirsOrThrow() throws LoadException {
        if (!packDir.isDirectory() && !packDir.mkdirs()) {
            throw new LoadException(R.string.error_write, LoadException.KIND_DISK);
        }
    }

    private void clearPartFiles() {
        File[] files = packDir.listFiles();
        if (files == null) return;
        for (File file : files) if (file.getName().endsWith(".part")) deleteIfExists(file);
    }

    private static void deleteIfExists(File file) {
        if (file.exists() && !file.delete()) file.deleteOnExit();
    }

    private void notifyCancelled() {
        post(() -> listener.onCancelled());
    }

    private void post(Runnable action) {
        main.post(() -> {
            if (listener != null) action.run();
        });
    }

    /** Thrown out of a read loop when a cancel lands mid-transfer. */
    private static final class CancelledSignal extends RuntimeException {
        CancelledSignal() {
            super("cancelled");
        }
    }
}
