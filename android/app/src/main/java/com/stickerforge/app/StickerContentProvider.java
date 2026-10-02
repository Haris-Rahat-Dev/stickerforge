package com.stickerforge.app;

import android.content.ContentProvider;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.UriMatcher;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;

/**
 * Dynamic StickerContentProvider — serves every sticker pack downloaded from the
 * StickerForge API, each in filesDir/stickers/&lt;identifier&gt;/. Contract strings and
 * URI structure follow WhatsApp's official sample exactly.
 */
public class StickerContentProvider extends ContentProvider {

    public static final String STICKER_PACK_IDENTIFIER_IN_QUERY = "sticker_pack_identifier";
    public static final String STICKER_PACK_NAME_IN_QUERY = "sticker_pack_name";
    public static final String STICKER_PACK_PUBLISHER_IN_QUERY = "sticker_pack_publisher";
    public static final String STICKER_PACK_ICON_IN_QUERY = "sticker_pack_icon";
    public static final String ANDROID_APP_DOWNLOAD_LINK_IN_QUERY = "android_play_store_link";
    public static final String IOS_APP_DOWNLOAD_LINK_IN_QUERY = "ios_app_download_link";
    public static final String PUBLISHER_EMAIL = "sticker_pack_publisher_email";
    public static final String PUBLISHER_WEBSITE = "sticker_pack_publisher_website";
    public static final String PRIVACY_POLICY_WEBSITE = "sticker_pack_privacy_policy_website";
    public static final String LICENSE_AGREEMENT_WEBSITE = "sticker_pack_license_agreement_website";
    public static final String IMAGE_DATA_VERSION = "image_data_version";
    public static final String AVOID_CACHE = "whatsapp_will_not_cache_stickers";
    public static final String ANIMATED_STICKER_PACK = "animated_sticker_pack";

    public static final String STICKER_FILE_NAME_IN_QUERY = "sticker_file_name";
    public static final String STICKER_FILE_EMOJI_IN_QUERY = "sticker_emoji";
    public static final String STICKER_FILE_ACCESSIBILITY_TEXT_IN_QUERY = "sticker_accessibility_text";

    public static final android.net.Uri AUTHORITY_URI = new Uri.Builder()
            .scheme(ContentResolver.SCHEME_CONTENT)
            .authority(BuildConfig.CONTENT_PROVIDER_AUTHORITY)
            .appendPath("metadata")
            .build();

    private static final UriMatcher MATCHER = new UriMatcher(UriMatcher.NO_MATCH);
    private static final String METADATA = "metadata";
    private static final int METADATA_CODE = 1;
    private static final int METADATA_CODE_FOR_SINGLE_PACK = 2;
    static final String STICKERS = "stickers";
    private static final int STICKERS_CODE = 3;
    static final String STICKERS_ASSET = "stickers_asset";
    private static final int STICKERS_ASSET_CODE = 4;
    private static final int STICKER_PACK_TRAY_ICON_CODE = 5;

    @Override
    public boolean onCreate() {
        final String authority = BuildConfig.CONTENT_PROVIDER_AUTHORITY;
        if (!authority.startsWith(Objects.requireNonNull(getContext()).getPackageName())) {
            throw new IllegalStateException("authority must start with package name");
        }
        MATCHER.addURI(authority, METADATA, METADATA_CODE);
        MATCHER.addURI(authority, METADATA + "/*", METADATA_CODE_FOR_SINGLE_PACK);
        MATCHER.addURI(authority, STICKERS + "/*", STICKERS_CODE);
        MATCHER.addURI(authority, STICKERS_ASSET + "/*/*", STICKERS_ASSET_CODE);
        MATCHER.addURI(authority, STICKERS_ASSET + "/*/*", STICKER_PACK_TRAY_ICON_CODE);
        return true;
    }

    private File root() {
        return new File(Objects.requireNonNull(getContext()).getFilesDir(), STICKERS);
    }

    /** The pack's downloaded manifest, or null if it was never (fully) fetched. */
    private static JSONObject readManifest(File dir) {
        File f = new File(dir, "manifest.json");
        if (!f.isFile()) return null;
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int read;
            while ((read = in.read(buf)) > 0) out.write(buf, 0, read);
            JSONObject json = new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
            return dir.getName().equals(json.optString("identifier")) ? json : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Manifest for one identifier; a bare folder name only, so a URI can't walk out of root. */
    private JSONObject manifestFor(String identifier) {
        if (identifier == null || identifier.isEmpty() || identifier.contains("/") || identifier.contains("..")) return null;
        return readManifest(new File(root(), identifier));
    }

    private List<JSONObject> allManifests() {
        List<JSONObject> out = new ArrayList<>();
        File[] dirs = root().listFiles(File::isDirectory);
        if (dirs == null) return out;
        Arrays.sort(dirs);
        for (File dir : dirs) {
            JSONObject m = readManifest(dir);
            if (m != null) out.add(m);
        }
        return out;
    }

    @Override
    public Cursor query(android.net.Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        final int code = MATCHER.match(uri);

        if (code == METADATA_CODE || code == METADATA_CODE_FOR_SINGLE_PACK) {
            MatrixCursor cursor = new MatrixCursor(new String[]{
                    STICKER_PACK_IDENTIFIER_IN_QUERY, STICKER_PACK_NAME_IN_QUERY,
                    STICKER_PACK_PUBLISHER_IN_QUERY, STICKER_PACK_ICON_IN_QUERY,
                    ANDROID_APP_DOWNLOAD_LINK_IN_QUERY, IOS_APP_DOWNLOAD_LINK_IN_QUERY,
                    PUBLISHER_EMAIL, PUBLISHER_WEBSITE, PRIVACY_POLICY_WEBSITE,
                    LICENSE_AGREEMENT_WEBSITE, IMAGE_DATA_VERSION, AVOID_CACHE,
                    ANIMATED_STICKER_PACK
            });
            List<JSONObject> packs = new ArrayList<>();
            if (code == METADATA_CODE) packs = allManifests();
            else {
                JSONObject one = manifestFor(uri.getLastPathSegment());
                if (one != null) packs.add(one);
            }
            for (JSONObject manifest : packs) {
                MatrixCursor.RowBuilder b = cursor.newRow();
                b.add(manifest.optString("identifier"));
                b.add(manifest.optString("name"));
                b.add(manifest.optString("publisher"));
                b.add(manifest.optString("tray_image_file"));
                b.add(null);
                b.add(null);
                b.add(null);
                b.add(null);
                b.add(null);
                b.add(null);
                b.add(manifest.optString("image_data_version", "1"));
                b.add(0);
                b.add(manifest.optBoolean("animated", true) ? 1 : 0);
            }
            cursor.setNotificationUri(Objects.requireNonNull(getContext()).getContentResolver(), uri);
            return cursor;
        }

        if (code == STICKERS_CODE) {
            MatrixCursor cursor = new MatrixCursor(new String[]{
                    STICKER_FILE_NAME_IN_QUERY, STICKER_FILE_EMOJI_IN_QUERY, STICKER_FILE_ACCESSIBILITY_TEXT_IN_QUERY
            });
            JSONObject manifest = manifestFor(uri.getLastPathSegment());
            JSONArray stickers = manifest == null ? null : manifest.optJSONArray("stickers");
            if (stickers != null) {
                for (int i = 0; i < stickers.length(); i++) {
                    JSONObject s = stickers.optJSONObject(i);
                    if (s == null) continue;
                    JSONArray emojis = s.optJSONArray("emojis");
                    StringBuilder emojiStr = new StringBuilder();
                    if (emojis != null) {
                        for (int e = 0; e < emojis.length(); e++) {
                            if (e > 0) emojiStr.append(',');
                            emojiStr.append(emojis.optString(e));
                        }
                    }
                    cursor.addRow(new Object[]{s.optString("image_file"), emojiStr.toString(), ""});
                }
            }
            cursor.setNotificationUri(Objects.requireNonNull(getContext()).getContentResolver(), uri);
            return cursor;
        }

        throw new IllegalArgumentException("Unknown URI: " + uri);
    }

    @Override
    public AssetFileDescriptor openAssetFile(android.net.Uri uri, String mode) throws FileNotFoundException {
        final List<String> seg = uri.getPathSegments();
        if (seg.size() != 3 || !STICKERS_ASSET.equals(seg.get(0))) return null;
        final String identifier = seg.get(1);
        final String fileName = seg.get(2);

        JSONObject manifest = manifestFor(identifier);
        if (manifest == null) {
            throw new FileNotFoundException("Unknown pack: " + identifier);
        }

        boolean allowed = fileName.equals(manifest.optString("tray_image_file"));
        if (!allowed) {
            JSONArray stickers = manifest.optJSONArray("stickers");
            if (stickers != null) {
                for (int i = 0; i < stickers.length(); i++) {
                    JSONObject s = stickers.optJSONObject(i);
                    if (s != null && fileName.equals(s.optString("image_file"))) { allowed = true; break; }
                }
            }
        }
        if (!allowed) throw new FileNotFoundException("File not in manifest: " + fileName);

        File f = new File(new File(root(), identifier), fileName);
        if (!f.exists()) throw new FileNotFoundException("Missing: " + fileName);
        return new AssetFileDescriptor(ParcelFileDescriptorOpen(f), 0, f.length());
    }

    private android.os.ParcelFileDescriptor ParcelFileDescriptorOpen(File f) throws FileNotFoundException {
        return android.os.ParcelFileDescriptor.open(f, android.os.ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(android.net.Uri uri) {
        final List<String> seg = uri.getPathSegments();
        if (seg.size() == 3 && STICKERS_ASSET.equals(seg.get(0))) {
            return seg.get(2).endsWith(".png") ? "image/png" : "image/webp";
        }
        final int code = MATCHER.match(uri);
        switch (code) {
            case METADATA_CODE:
                return "vnd.android.cursor.dir/vnd." + BuildConfig.CONTENT_PROVIDER_AUTHORITY + "." + METADATA;
            case METADATA_CODE_FOR_SINGLE_PACK:
                return "vnd.android.cursor.item/vnd." + BuildConfig.CONTENT_PROVIDER_AUTHORITY + "." + METADATA;
            case STICKERS_CODE:
                return "vnd.android.cursor.dir/vnd." + BuildConfig.CONTENT_PROVIDER_AUTHORITY + "." + STICKERS;
            default:
                throw new IllegalArgumentException("Unknown URI: " + uri);
        }
    }

    @Override
    public int delete(android.net.Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Not supported");
    }

    @Override
    public android.net.Uri insert(android.net.Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Not supported");
    }

    @Override
    public int update(android.net.Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Not supported");
    }
}
