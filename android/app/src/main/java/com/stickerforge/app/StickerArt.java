package com.stickerforge.app;

import android.content.Context;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.widget.ImageView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Decodes the pack's image files onto ImageViews off the main thread.
 *
 * Stickers are 512×512 ANIMATED WebP. Only ImageDecoder (API 28+) understands the
 * animation chunk, so below that the first frame is shown as a still — BitmapFactory
 * cannot decode an animated WebP at all on those releases.
 */
final class StickerArt {

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final AtomicLong TOKENS = new AtomicLong();

    private static Resources resources;

    private StickerArt() {
    }

    static void init(Context context) {
        resources = context.getApplicationContext().getResources();
    }

    /** True when this device can actually play the thumbnails. */
    static boolean animatesThumbnails() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P;
    }

    static void show(ImageView view, File file, int targetPx) {
        if (file != null && file.equals(view.getTag(R.id.artFile)) && view.getDrawable() != null) {
            Drawable live = view.getDrawable();
            if (live instanceof Animatable) ((Animatable) live).start();
            return;
        }
        cancel(view);
        if (file == null || !file.isFile()) {
            view.setImageDrawable(null);
            return;
        }
        final long token = TOKENS.incrementAndGet();
        view.setTag(R.id.artToken, Long.valueOf(token));
        view.setTag(R.id.artFile, file);
        view.setImageDrawable(null);
        POOL.submit(() -> {
            final Drawable art = decode(file, targetPx);
            MAIN.post(() -> {
                Long current = (Long) view.getTag(R.id.artToken);
                if (current == null || current != token) return;
                view.setImageDrawable(art);
                if (art instanceof Animatable) ((Animatable) art).start();
            });
        });
    }

    /** Invalidates anything in flight for this view and stops whatever it was showing. */
    static void cancel(ImageView view) {
        view.setTag(R.id.artToken, null);
        Drawable art = view.getDrawable();
        // Animatable, not AnimatedImageDrawable: naming the latter would resolve a class
        // that does not exist before API 28.
        if (art instanceof Animatable) ((Animatable) art).stop();
    }

    private static Drawable decode(File file, int targetPx) {
        Drawable art = null;
        try {
            art = decodeWebP(file, targetPx);
        } catch (Exception ignored) {
            // fall through to the still frame
        }
        if (art != null) return art;
        try {
            return decodeFirstFrame(file, targetPx);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Drawable decodeWebP(File file, int targetPx) throws IOException {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null;
        ByteBuffer buffer = ByteBuffer.wrap(readAll(file));
        ImageDecoder.Source source = ImageDecoder.createSource(buffer);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && targetPx > 0) {
            return ImageDecoder.decodeDrawable(source, (decoder, info, mime) -> {
                int longest = Math.max(info.getSize().getWidth(), info.getSize().getHeight());
                if (longest > targetPx * 2) {
                    try {
                        decoder.setTargetSampleSize(Math.max(2, longest / targetPx));
                    } catch (Exception ignored) {
                        // some builds refuse to scale animated sources; full size is fine
                    }
                }
            });
        }
        return ImageDecoder.decodeDrawable(source);
    }

    private static Drawable decodeFirstFrame(File file, int targetPx) {
        String path = file.getAbsolutePath();
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(path, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inSampleSize = sampleSize(Math.max(bounds.outWidth, bounds.outHeight), targetPx);
        Bitmap bitmap = BitmapFactory.decodeFile(path, options);
        return bitmap == null || resources == null
                ? null : new BitmapDrawable(resources, bitmap);
    }

    private static int sampleSize(int longestEdge, int targetPx) {
        int sample = 1;
        if (targetPx <= 0) return sample;
        while (longestEdge / (sample * 2) >= targetPx) sample *= 2;
        return sample;
    }

    private static byte[] readAll(File file) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream((int) file.length());
        byte[] buffer = new byte[16384];
        try (InputStream in = new FileInputStream(file)) {
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
