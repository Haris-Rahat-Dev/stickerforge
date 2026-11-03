package com.stickerforge.app;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * Streams a shared clip to {@code POST /api/upload} as the multipart "file" field, signed
 * with the phone's link token. That token can only upload; it lands in the account's
 * staging shelf on the StickerForge host.
 */
final class ShareUploader {

    /** The host refused the token: the phone was never linked, or linked again elsewhere. */
    static final class NotLinked extends IOException {
        NotLinked() { super("not linked"); }
    }

    private ShareUploader() {}

    /** Blocking; call off the main thread. Returns the uploaded file's display name. */
    static String upload(ContentResolver resolver, Uri uri, String token) throws IOException {
        String name = displayName(resolver, uri);
        String type = resolver.getType(uri);
        if (type == null) type = "application/octet-stream";
        String boundary = "sf" + UUID.randomUUID().toString().replace("-", "");

        HttpURLConnection conn = (HttpURLConnection) new URL(BuildConfig.API_BASE + "/api/upload").openConnection();
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(120_000);
        conn.setDoOutput(true);
        conn.setRequestMethod("POST");
        conn.setChunkedStreamingMode(64 * 1024);
        conn.setRequestProperty("Authorization", "Device " + token);
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try {
            try (OutputStream out = conn.getOutputStream();
                 InputStream in = resolver.openInputStream(uri)) {
                if (in == null) throw new IOException("cannot read " + name);
                String head = "--" + boundary + "\r\n"
                        + "Content-Disposition: form-data; name=\"file\"; filename=\""
                        + name.replace("\"", "'").replace("\r", "").replace("\n", "") + "\"\r\n"
                        + "Content-Type: " + type + "\r\n\r\n";
                out.write(head.getBytes(StandardCharsets.UTF_8));
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
                out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            if (code == 401) throw new NotLinked();
            if (code / 100 != 2) throw new IOException("HTTP " + code);
            return name;
        } finally {
            conn.disconnect();
        }
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
            // some providers refuse the query; the path segment is good enough
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "clip.mp4";
    }
}
