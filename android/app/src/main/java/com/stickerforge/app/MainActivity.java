package com.stickerforge.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {

    private static final int REQ_ADD_TO_WHATSAPP = 200;

    private TextView status;
    private TextView packInfo;
    private Button addBtn;
    private EditText codeInput;
    private SharedPreferences prefs;
    private String packId;
    private String packName;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(28), dp(48), dp(28), dp(28));

        TextView title = new TextView(this);
        title.setText("⚡ StickerForge");
        title.setTextSize(30);
        title.setTextColor(0xFF2FE06C);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("pack importer — video → die-cut stickers");
        sub.setTextSize(12);
        sub.setTextColor(0xFF99A089);
        root.addView(sub);

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, dp(32)));

        status = new TextView(this);
        status.setText("Connect your Mac (USB) and run:\nadb reverse tcp:8080 tcp:3210");
        status.setTextSize(14);
        status.setTextColor(0xFFEFEFDF);
        root.addView(status);

        View spacer2 = new View(this);
        root.addView(spacer2, new LinearLayout.LayoutParams(1, dp(20)));

        prefs = getSharedPreferences("stickerforge", MODE_PRIVATE);
        TextView codeLabel = new TextView(this);
        codeLabel.setText("Pack code (scan the QR on your Mac, or type it):");
        codeLabel.setTextSize(12);
        codeLabel.setTextColor(0xFF99A089);
        root.addView(codeLabel);

        codeInput = new EditText(this);
        codeInput.setSingleLine(true);
        codeInput.setHint("pack code");
        codeInput.setText(prefs.getString("code", "demo"));
        codeInput.setTextColor(0xFFEFEFDF);
        root.addView(codeInput);

        View spacer2b = new View(this);
        root.addView(spacer2b, new LinearLayout.LayoutParams(1, dp(16)));

        packInfo = new TextView(this);
        packInfo.setTextSize(14);
        packInfo.setTextColor(0xFFEFEFDF);
        root.addView(packInfo);

        View spacer3 = new View(this);
        root.addView(spacer3, new LinearLayout.LayoutParams(1, dp(20)));

        Button loadBtn = new Button(this);
        loadBtn.setText("⬇ Load pack from StickerForge");
        loadBtn.setOnClickListener(v -> loadPack());
        root.addView(loadBtn);

        addBtn = new Button(this);
        addBtn.setText("＋ Add to WhatsApp");
        addBtn.setEnabled(false);
        addBtn.setOnClickListener(v -> addToWhatsApp());
        root.addView(addBtn);

        setContentView(root);
        handleDeepLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
    }

    // stickerforge://pack/<code> — from scanning the QR on the Mac. Fills the code
    // field and loads immediately.
    private void handleDeepLink(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data == null || !"stickerforge".equals(data.getScheme())) return;
        List<String> seg = data.getPathSegments();
        String code = !seg.isEmpty() ? seg.get(seg.size() - 1) : data.getHost();
        if (code != null && !code.isEmpty() && !"pack".equals(code)) {
            codeInput.setText(code);
            loadPack();
        }
    }

    private String currentCode() {
        String c = codeInput.getText().toString().trim();
        if (c.isEmpty()) c = "demo";
        prefs.edit().putString("code", c).apply();
        return c;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density);
    }

    private void status(final String s) {
        runOnUiThread(() -> status.setText(s));
    }

    private void loadPack() {
        final String code = currentCode();
        status("Loading pack " + code + " from " + BuildConfig.API_BASE + " …");
        new Thread(() -> {
            try {
                JSONObject manifest = fetchJson(BuildConfig.API_BASE + "/api/pack/" + code);
                String identifier = manifest.getString("identifier");
                String trayFile = manifest.getString("tray_image_file");

                // Save flat into filesDir/stickers/ — the provider reads files by
                // name from here (no identifier subdir), and the manifest lives here too.
                File dir = new File(getFilesDir(), "stickers");
                dir.mkdirs();

                download(BuildConfig.API_BASE + "/api/pack/" + code + "/file/" + trayFile,
                        new File(dir, trayFile));

                JSONArray stickers = manifest.getJSONArray("stickers");
                for (int i = 0; i < stickers.length(); i++) {
                    String f = stickers.getJSONObject(i).getString("image_file");
                    status("Downloading " + (i + 1) + "/" + stickers.length() + " …");
                    download(BuildConfig.API_BASE + "/api/pack/" + code + "/file/" + f,
                            new File(dir, f));
                }

                // provider reads this exact path
                try (FileOutputStream out = new FileOutputStream(new File(dir, "manifest.json"))) {
                    out.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
                }

                packId = identifier;
                packName = manifest.optString("name", "StickerForge Pack");

                runOnUiThread(() -> {
                    status("✓ Pack ready — " + stickers.length() + " animated stickers");
                    packInfo.setText(packName);
                    addBtn.setEnabled(true);
                });
            } catch (Exception e) {
                status("✗ Failed: " + e.getMessage());
            }
        }).start();
    }

    private void addToWhatsApp() {
        if (packId == null) return;
        // consumer first, then business
        for (String pkg : new String[]{WhitelistCheck.CONSUMER_WHATSAPP_PACKAGE_NAME, WhitelistCheck.SMB_WHATSAPP_PACKAGE_NAME}) {
            Intent intent = new Intent();
            intent.setAction("com.whatsapp.intent.action.ENABLE_STICKER_PACK");
            intent.setPackage(pkg);
            intent.putExtra("sticker_pack_id", packId);
            intent.putExtra("sticker_pack_authority", BuildConfig.CONTENT_PROVIDER_AUTHORITY);
            intent.putExtra("sticker_pack_name", packName);
            try {
                startActivityForResult(intent, REQ_ADD_TO_WHATSAPP);
                return;
            } catch (Exception e) {
                // try next package
            }
        }
        Toast.makeText(this, "WhatsApp not installed", Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_ADD_TO_WHATSAPP) return;
        boolean whitelisted = WhitelistCheck.isWhitelisted(this, packId);
        Toast.makeText(this,
                whitelisted ? "✓ Pack added to WhatsApp — open any chat → stickers"
                        : "Pack may not have been added. Try again.",
                Toast.LENGTH_LONG).show();
    }

    private JSONObject fetchJson(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(30000);
        try (InputStream in = conn.getInputStream()) {
            byte[] buf = readAll(in);
            return new JSONObject(new String(buf, StandardCharsets.UTF_8));
        } finally {
            conn.disconnect();
        }
    }

    private void download(String url, File dest) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(60000);
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    private byte[] readAll(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }
}
