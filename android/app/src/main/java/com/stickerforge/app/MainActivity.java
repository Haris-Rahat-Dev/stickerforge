package com.stickerforge.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.text.format.Formatter;
import android.os.Bundle;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.io.File;
import java.util.List;

/**
 * One screen: point at a pack built on the StickerForge host, pull it down, hand it to WhatsApp.
 */
public class MainActivity extends AppCompatActivity
        implements PackLoader.Listener, StickerAdapter.Callback {

    private static final int REQ_ADD_TO_WHATSAPP = 200;

    private static final String ACTION_ENABLE = "com.whatsapp.intent.action.ENABLE_STICKER_PACK";
    private static final String EXTRA_PACK_ID = "sticker_pack_id";
    private static final String EXTRA_AUTHORITY = "sticker_pack_authority";
    private static final String EXTRA_PACK_NAME = "sticker_pack_name";
    private static final String DEEP_LINK_SCHEME = "stickerforge";
    private static final String PREF_CODE = "code";

    private SharedPreferences prefs;
    private PackLoader loader;
    private StickerAdapter adapter;

    private EditText codeInput;
    private TextView codeHelper;
    private TextView hostLine;
    private TextView loadBtn;
    private TextView countChip;
    private ImageView statusIcon;
    private TextView statusText;
    private View progressRow;
    private ProgressBar overallBar;
    private TextView progressCount;
    private View errorRow;
    private TextView errorDetail;
    private View packCard;
    private FrameLayout trayTile;
    private ImageView trayIcon;
    private ProgressBar trayBusy;
    private TextView packName;
    private TextView packMeta;
    private TextView whatsappChip;
    private View packSheet;
    private TextView gridCount;
    private TextView addBtn;
    private TextView addReason;
    private TextView animationNote;

    private List<StickerSlot> items;
    private PackManifest manifest;
    private int stickerTotal;
    private boolean ready;
    // A pack that already reached this device stays addable even if a later attempt fails,
    // because nothing on disk is replaced until the new manifest is written.
    private boolean deliveredPack;
    private boolean whatsappInstalled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        StickerArt.init(this);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences("stickerforge", MODE_PRIVATE);
        loader = new PackLoader(this);
        loader.setListener(this);

        bindViews();
        adapter = new StickerAdapter(this, loader, this);
        RecyclerView grid = findViewById(R.id.stickerGrid);
        grid.setLayoutManager(new GridLayoutManager(this, getResources().getInteger(R.integer.grid_cols)));
        grid.setAdapter(adapter);
        grid.setNestedScrollingEnabled(false);

        hostLine.setText(getString(R.string.host_line, BuildConfig.API_BASE));
        codeInput.setText(prefs.getString(PREF_CODE, ""));
        codeInput.setSelection(codeInput.getText().length());

        loadBtn.setOnClickListener(v -> {
            if (loader.isBusy()) loader.cancel();
            else startLoad();
        });
        findViewById(R.id.retryBtn).setOnClickListener(v -> startLoad());
        addBtn.setOnClickListener(v -> addToWhatsApp());

        handleDeepLink(getIntent());
    }

    @Override
    protected void onResume() {
        super.onResume();
        whatsappInstalled = WhitelistCheck.isWhatsAppConsumerAppInstalled(getPackageManager())
                || WhitelistCheck.isWhatsAppSmbAppInstalled(getPackageManager());
        refreshChrome();
    }

    @Override
    protected void onDestroy() {
        loader.setListener(null);
        loader.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleDeepLink(intent);
    }

    private void bindViews() {
        codeInput = findViewById(R.id.codeInput);
        codeHelper = findViewById(R.id.codeHelper);
        hostLine = findViewById(R.id.hostLine);
        loadBtn = findViewById(R.id.loadBtn);
        countChip = findViewById(R.id.countChip);
        statusIcon = findViewById(R.id.statusIcon);
        statusText = findViewById(R.id.statusText);
        progressRow = findViewById(R.id.progressRow);
        overallBar = findViewById(R.id.overallBar);
        progressCount = findViewById(R.id.progressCount);
        errorRow = findViewById(R.id.errorRow);
        errorDetail = findViewById(R.id.errorDetail);
        packCard = findViewById(R.id.packCard);
        trayTile = findViewById(R.id.trayTile);
        trayIcon = findViewById(R.id.trayIcon);
        trayBusy = findViewById(R.id.trayBusy);
        packName = findViewById(R.id.packName);
        packMeta = findViewById(R.id.packMeta);
        whatsappChip = findViewById(R.id.whatsappChip);
        packSheet = findViewById(R.id.packSheet);
        gridCount = findViewById(R.id.gridCount);
        addBtn = findViewById(R.id.addBtn);
        addReason = findViewById(R.id.addReason);
        animationNote = findViewById(R.id.animationNote);
    }

    // ── loading ──────────────────────────────────────────────────────────

    /** Empty input is a prompt, never a silent fallback to some default pack. */
    private String currentCode() {
        String raw = codeInput.getText().toString().trim();
        if (raw.isEmpty()) {
            codeHelper.setText(R.string.code_missing);
            codeHelper.setTextColor(color(R.color.sf_red));
            codeInput.requestFocus();
            return null;
        }
        codeHelper.setText(R.string.code_helper);
        codeHelper.setTextColor(color(R.color.sf_muted));
        prefs.edit().putString(PREF_CODE, raw).apply();
        return raw;
    }

    private void startLoad() {
        String code = currentCode();
        if (code == null) return;
        ready = false;
        errorRow.setVisibility(View.GONE);
        progressRow.setVisibility(View.VISIBLE);
        overallBar.setProgress(0);
        progressCount.setText("");
        statusIcon.setImageResource(R.drawable.ic_download);
        statusText.setTextColor(color(R.color.sf_ink));
        statusText.setText(R.string.status_connecting);
        whatsappChip.setVisibility(View.GONE);
        hideKeyboard();
        loader.load(code);
        refreshChrome();
    }

    private void hideKeyboard() {
        codeInput.clearFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(codeInput.getWindowToken(), 0);
    }

    // ── PackLoader.Listener ──────────────────────────────────────────────

    @Override
    public void onManifest(PackManifest parsed, String code) {
        manifest = parsed;
        deliveredPack = false;
        items = loader.items();
        stickerTotal = parsed.entries.size();
        packName.setText(parsed.name);
        packMeta.setText(getString(R.string.pack_meta_line, stickerTotal, parsed.publisher, parsed.version));
        countChip.setText(getString(R.string.pack_code_meta, code));
        packCard.setVisibility(View.VISIBLE);
        packSheet.setVisibility(View.VISIBLE);
        gridCount.setText(getString(R.string.grid_count, 0, stickerTotal));
        animationNote.setVisibility(StickerArt.animatesThumbnails() ? View.GONE : View.VISIBLE);
        adapter.setItems(items);
        statusText.setText(R.string.status_fetching);
        refreshChrome();
    }

    @Override
    public void onItem(int position, StickerSlot slot) {
        if (position == PackLoader.TRAY) bindTray(slot);
        else adapter.notifySlot(position);
    }

    private void bindTray(StickerSlot slot) {
        switch (slot.state) {
            case StickerSlot.READY:
                trayTile.setBackgroundResource(R.drawable.bg_tile_ready);
                trayBusy.setVisibility(View.GONE);
                StickerArt.show(trayIcon, new File(loader.packDir(), slot.fileName), 0);
                break;
            case StickerSlot.FETCHING:
                trayTile.setBackgroundResource(R.drawable.bg_tile_busy);
                trayBusy.setVisibility(View.VISIBLE);
                break;
            case StickerSlot.FAILED:
                trayTile.setBackgroundResource(R.drawable.bg_tile_failed);
                trayBusy.setVisibility(View.GONE);
                StickerArt.cancel(trayIcon);
                trayIcon.setImageDrawable(null);
                break;
            default:
                trayTile.setBackgroundResource(R.drawable.bg_tile_empty);
                trayBusy.setVisibility(View.GONE);
                break;
        }
    }

    /** Item 0 is the tray, so the sticker tally lags the file count by one. */
    @Override
    public void onProgress(int done, int total, int percent, String currentFile) {
        progressRow.setVisibility(View.VISIBLE);
        overallBar.setProgress(percent);
        progressCount.setText(getString(R.string.status_file_count, done, total));
        if (stickerTotal > 0) {
            gridCount.setText(getString(R.string.grid_count, Math.max(0, done - 1), stickerTotal));
        }
        if (currentFile != null) statusText.setText(getString(R.string.status_fetching_file, currentFile));
    }

    @Override
    public void onDone(PackManifest finished, String code) {
        manifest = finished;
        ready = true;
        deliveredPack = true;
        stickerTotal = finished.entries.size();
        statusIcon.setImageResource(R.drawable.ic_check);
        statusText.setTextColor(color(R.color.sf_green));
        statusText.setText(getString(R.string.status_ready, stickerTotal));
        progressRow.setVisibility(View.GONE);
        errorRow.setVisibility(View.GONE);
        gridCount.setText(getString(R.string.grid_count, stickerTotal, stickerTotal));
        refreshChrome();
        checkWhatsAppStatus(finished.identifier);
    }

    @Override
    public void onError(LoadException error) {
        ready = deliveredPack;
        statusIcon.setImageResource(R.drawable.ic_alert);
        statusText.setTextColor(color(R.color.sf_red));
        statusText.setText(R.string.error_title);
        progressRow.setVisibility(View.GONE);
        errorRow.setVisibility(View.VISIBLE);
        errorDetail.setText(getString(error.messageRes, error.args));
        refreshChrome();
    }

    @Override
    public void onCancelled() {
        ready = deliveredPack;
        resetUnfinished();
        statusIcon.setImageResource(R.drawable.ic_close);
        statusText.setTextColor(color(R.color.sf_ink));
        statusText.setText(R.string.status_cancelled);
        progressRow.setVisibility(View.GONE);
        errorRow.setVisibility(View.GONE);
        refreshChrome();
    }

    private void resetUnfinished() {
        if (items == null) return;
        for (int i = 0; i < items.size(); i++) {
            StickerSlot slot = items.get(i);
            if (slot.state == StickerSlot.FETCHING) {
                slot.set(StickerSlot.QUEUED, 0);
                onItem(i, slot);
            }
        }
    }

    // ── StickerAdapter.Callback ──────────────────────────────────────────

    /** A tile is its own unit of progress: tap a failed one to re-pull just that file. */
    @Override
    public void onSlotClicked(int loaderPosition, StickerSlot slot) {
        if (slot.state == StickerSlot.FAILED) {
            retrySlot(loaderPosition);
            return;
        }
        File file = new File(loader.packDir(), slot.fileName);
        String size = file.isFile()
                ? Formatter.formatFileSize(this, file.length())
                : getString(R.string.not_measured);
        int stateLabel;
        String detail;
        switch (slot.state) {
            case StickerSlot.READY:
                stateLabel = R.string.slot_ready;
                detail = size;
                break;
            case StickerSlot.FETCHING:
                stateLabel = R.string.slot_downloading;
                detail = getString(R.string.slot_percent, slot.percent);
                break;
            default:
                stateLabel = R.string.slot_queued;
                detail = getString(R.string.not_measured);
                break;
        }
        statusText.setTextColor(color(R.color.sf_ink));
        statusText.setText(getString(R.string.slot_detail, slot.fileName, detail, getString(stateLabel)));
    }

    /** The pack is only addable again once every item is back on disk. */
    private void retrySlot(int loaderPosition) {
        if (loader.isBusy()) return;
        ready = false;
        errorRow.setVisibility(View.GONE);
        progressRow.setVisibility(View.VISIBLE);
        statusIcon.setImageResource(R.drawable.ic_download);
        statusText.setTextColor(color(R.color.sf_ink));
        statusText.setText(R.string.status_fetching);
        whatsappChip.setVisibility(View.GONE);
        loader.retryItem(loaderPosition);
        refreshChrome();
    }

    // ── chrome ───────────────────────────────────────────────────────────

    private void refreshChrome() {
        boolean busy = loader.isBusy();
        loadBtn.setText(busy ? R.string.cancel_action
                : (manifest == null ? R.string.load_action : R.string.reload_action));
        addBtn.setEnabled(!busy && whatsappInstalled && ready);
        if (busy) addReason.setText(R.string.add_reason_loading);
        else if (!whatsappInstalled) addReason.setText(R.string.add_reason_no_whatsapp);
        else if (ready) addReason.setText(R.string.add_reason_loaded);
        else addReason.setText(manifest == null ? R.string.add_reason_missing : R.string.add_reason_failed);
    }

    private void checkWhatsAppStatus(String identifier) {
        whatsappChip.setVisibility(View.VISIBLE);
        whatsappChip.setText(R.string.status_checking_whatsapp);
        setChip(R.drawable.chip_diecut, R.color.sf_muted);
        new Thread(() -> {
            final boolean approved = WhitelistCheck.isWhitelisted(this, identifier);
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (approved) setChipApproved();
                else showWhatsAppWaitingChip();
            });
        }).start();
    }

    private void setChip(int background, int textColor) {
        whatsappChip.setBackgroundResource(background);
        whatsappChip.setTextColor(color(textColor));
    }

    private void setChipApproved() {
        whatsappChip.setText(R.string.whatsapp_approved);
        setChip(R.drawable.chip_green, R.color.sf_green);
    }

    private void showWhatsAppWaitingChip() {
        whatsappChip.setText(R.string.whatsapp_pending);
        setChip(R.drawable.chip_amber, R.color.sf_amber);
    }

    // ── hand off to WhatsApp ─────────────────────────────────────────────

    private void addToWhatsApp() {
        final PackManifest current = manifest;
        if (current == null || current.identifier.isEmpty()) return;
        for (String pkg : new String[]{WhitelistCheck.CONSUMER_WHATSAPP_PACKAGE_NAME,
                WhitelistCheck.SMB_WHATSAPP_PACKAGE_NAME}) {
            Intent intent = new Intent(ACTION_ENABLE);
            intent.setPackage(pkg);
            intent.putExtra(EXTRA_PACK_ID, current.identifier);
            intent.putExtra(EXTRA_AUTHORITY, BuildConfig.CONTENT_PROVIDER_AUTHORITY);
            intent.putExtra(EXTRA_PACK_NAME, current.name);
            try {
                startActivityForResult(intent, REQ_ADD_TO_WHATSAPP);
                return;
            } catch (Exception ignored) {
                // that WhatsApp variant isn't installed — try the next one
            }
        }
        whatsappInstalled = false;
        statusIcon.setImageResource(R.drawable.ic_alert);
        statusText.setTextColor(color(R.color.sf_red));
        statusText.setText(R.string.result_no_whatsapp);
        refreshChrome();
        Toast.makeText(this, R.string.result_no_whatsapp, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_ADD_TO_WHATSAPP) return;
        final PackManifest current = manifest;
        final String identifier = current == null ? "" : current.identifier;
        final boolean dismissed = resultCode == RESULT_CANCELED;
        new Thread(() -> {
            final boolean added = WhitelistCheck.isWhitelisted(this, identifier);
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) reportAddResult(added, dismissed);
            });
        }).start();
    }

    private void reportAddResult(boolean added, boolean dismissed) {
        int message = added ? R.string.result_added
                : (dismissed ? R.string.result_cancelled : R.string.result_rejected);
        statusIcon.setImageResource(added ? R.drawable.ic_check : R.drawable.ic_alert);
        statusText.setText(message);
        statusText.setTextColor(color(added ? R.color.sf_green : R.color.sf_amber));
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        whatsappChip.setVisibility(View.VISIBLE);
        if (added) {
            ready = true;
            deliveredPack = true;
            setChipApproved();
        } else if (!dismissed) {
            showWhatsAppWaitingChip();
        }
        refreshChrome();
    }

    // ── deep link: stickerforge://pack/<code>, from the install QR ───────

    private void handleDeepLink(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data == null || !DEEP_LINK_SCHEME.equals(data.getScheme())) return;
        List<String> segments = data.getPathSegments();
        String code = !segments.isEmpty() ? segments.get(segments.size() - 1) : data.getHost();
        if (code != null && !code.isEmpty() && !"pack".equals(code)) {
            codeInput.setText(code);
            startLoad();
        }
    }

    private int color(int res) {
        return ContextCompat.getColor(this, res);
    }
}
