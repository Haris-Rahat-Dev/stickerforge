package com.stickerforge.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** The manifest StickerForge writes at build time, as served by GET /api/pack/&lt;code&gt;. */
final class PackManifest {

    static final class Entry {
        final String imageFile;
        final String[] emojis;

        Entry(String imageFile, String[] emojis) {
            this.imageFile = imageFile;
            this.emojis = emojis;
        }
    }

    final String identifier;
    final String name;
    final String publisher;
    final String trayImageFile;
    final String version;
    final boolean animated;
    final List<Entry> entries;

    PackManifest(String identifier, String name, String publisher, String trayImageFile,
                 String version, boolean animated, List<Entry> entries) {
        this.identifier = identifier;
        this.name = name;
        this.publisher = publisher;
        this.trayImageFile = trayImageFile;
        this.version = version;
        this.animated = animated;
        this.entries = entries;
    }

    /** File names land on disk verbatim, so anything that isn't a bare name is refused. */
    private static String safeName(String raw) throws LoadException {
        if (raw == null || raw.isEmpty() || raw.indexOf('/') >= 0 || raw.contains("..")) {
            throw new LoadException(R.string.error_manifest, LoadException.KIND_MANIFEST);
        }
        return raw;
    }

    static PackManifest parse(JSONObject json) throws LoadException {
        String identifier = json.optString("identifier", "");
        String tray = safeName(json.optString("tray_image_file", ""));
        JSONArray list = json.optJSONArray("stickers");
        if (identifier.isEmpty() || list == null || list.length() == 0) {
            throw new LoadException(R.string.error_manifest, LoadException.KIND_MANIFEST);
        }
        List<Entry> entries = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) {
            JSONObject sticker = list.optJSONObject(i);
            if (sticker == null) continue;
            String file = safeName(sticker.optString("image_file", ""));
            JSONArray emojiArray = sticker.optJSONArray("emojis");
            String[] emojis = new String[emojiArray == null ? 0 : emojiArray.length()];
            if (emojiArray != null) {
                for (int e = 0; e < emojis.length; e++) emojis[e] = emojiArray.optString(e);
            }
            entries.add(new Entry(file, emojis));
        }
        return new PackManifest(identifier,
                json.optString("name", "StickerForge"),
                json.optString("publisher", "StickerForge"),
                tray,
                json.optString("image_data_version", "1"),
                json.optBoolean("animated", true),
                entries);
    }
}
