package com.stickerforge.app;

import android.content.Context;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The pack as a die-cut sheet: every sticker in the manifest gets a tile whether or not it has
 * landed, so each slot can be inspected — and retried — on its own.
 * Index 0 of the loader's items is the tray icon, so the grid is offset by one.
 */
final class StickerAdapter extends RecyclerView.Adapter<StickerAdapter.Holder> {

    interface Callback {
        void onSlotClicked(int loaderPosition, StickerSlot slot);
    }

    private final List<StickerSlot> slots = new ArrayList<>();
    private final PackLoader loader;
    private final Callback callback;
    private final int targetPx;

    StickerAdapter(Context context, PackLoader loader, Callback callback) {
        this.loader = loader;
        this.callback = callback;
        this.targetPx = (int) (context.getResources().getDisplayMetrics().density * 170);
        // Pack order is fixed while a download runs, so a tile keeps its identity.
        setHasStableIds(true);
    }

    /** Takes the loader's list, which starts with the tray icon at index 0. */
    void setItems(@NonNull List<StickerSlot> loaderItems) {
        slots.clear();
        for (int i = PackLoader.TRAY + 1; i < loaderItems.size(); i++) {
            slots.add(loaderItems.get(i));
        }
        notifyDataSetChanged();
    }

    void notifySlot(int loaderPosition) {
        int position = loaderPosition - (PackLoader.TRAY + 1);
        if (position >= 0 && position < slots.size()) notifyItemChanged(position);
    }

    @Override
    public int getItemCount() {
        return slots.size();
    }

    @Override
    public long getItemId(int position) {
        return slots.get(position).fileName.hashCode() & 0x7fffffffL;
    }

    @NonNull
    @Override
    public Holder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_sticker, parent, false);
        return new Holder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull Holder holder, int position) {
        holder.bind(slots.get(position), position, slots.size());
    }

    @Override
    public void onViewRecycled(@NonNull Holder holder) {
        super.onViewRecycled(holder);
        StickerArt.cancel(holder.thumb);
    }

    @Override
    public void onViewDetachedFromWindow(@NonNull Holder holder) {
        super.onViewDetachedFromWindow(holder);
        StickerArt.cancel(holder.thumb);
    }

    @Override
    public void onViewAttachedToWindow(@NonNull Holder holder) {
        super.onViewAttachedToWindow(holder);
        holder.replay();
    }

    class Holder extends RecyclerView.ViewHolder {

        private final FrameLayout tile;
        private final ImageView thumb;
        private final TextView index;
        private final TextView emoji;
        private final TextView state;
        private final ProgressBar bar;

        private File shown;

        Holder(@NonNull View itemView) {
            super(itemView);
            tile = (FrameLayout) itemView;
            thumb = itemView.findViewById(R.id.slotThumb);
            index = itemView.findViewById(R.id.slotIndex);
            emoji = itemView.findViewById(R.id.slotEmoji);
            state = itemView.findViewById(R.id.slotState);
            bar = itemView.findViewById(R.id.slotBar);
        }

        void bind(StickerSlot slot, int position, int total) {
            Context context = itemView.getContext();
            if (slot == null) return;
            final int loaderPosition = position + PackLoader.TRAY + 1;
            shown = new File(loader.packDir(), slot.fileName);
            index.setText(context.getString(R.string.slot_index, position + 1));
            emoji.setText(TextUtils.join(" ", slot.emojis));
            tile.setOnClickListener(v -> callback.onSlotClicked(loaderPosition, slot));
            itemView.setContentDescription(context.getString(R.string.cd_sticker, position + 1, total));

            boolean onPaper;
            switch (slot.state) {
                case StickerSlot.READY:
                    tile.setBackgroundResource(R.drawable.bg_tile_ready);
                    state.setVisibility(View.GONE);
                    bar.setVisibility(View.GONE);
                    onPaper = true;
                    StickerArt.show(thumb, shown, targetPx);
                    break;
                case StickerSlot.FETCHING:
                    tile.setBackgroundResource(R.drawable.bg_tile_busy);
                    clearThumb();
                    state.setVisibility(View.VISIBLE);
                    state.setText(context.getString(R.string.slot_percent, slot.percent));
                    state.setTextColor(context.getColor(R.color.sf_green_ink));
                    bar.setVisibility(View.VISIBLE);
                    bar.setProgress(slot.percent);
                    onPaper = true;
                    break;
                case StickerSlot.FAILED:
                    tile.setBackgroundResource(R.drawable.bg_tile_failed);
                    clearThumb();
                    state.setVisibility(View.VISIBLE);
                    state.setText(R.string.slot_failed);
                    state.setTextColor(context.getColor(R.color.sf_red));
                    bar.setVisibility(View.GONE);
                    onPaper = false;
                    break;
                default:
                    tile.setBackgroundResource(R.drawable.bg_tile_empty);
                    clearThumb();
                    state.setVisibility(View.VISIBLE);
                    state.setText(R.string.slot_queued);
                    state.setTextColor(context.getColor(R.color.sf_muted));
                    bar.setVisibility(View.GONE);
                    onPaper = false;
                    break;
            }
            index.setTextColor(context.getColor(onPaper ? R.color.sf_chat_frame : R.color.sf_muted_dim));
        }

        private void clearThumb() {
            StickerArt.cancel(thumb);
            thumb.setImageDrawable(null);
        }

        void replay() {
            if (shown == null) return;
            StickerArt.show(thumb, shown, targetPx);
        }
    }
}
