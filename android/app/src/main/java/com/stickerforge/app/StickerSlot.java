package com.stickerforge.app;

/** One sticker (or the tray) in the pack being pulled down. */
final class StickerSlot {

    static final int QUEUED = 0;
    static final int FETCHING = 1;
    static final int READY = 2;
    static final int FAILED = 3;

    final String fileName;
    final String[] emojis;

    volatile int state = QUEUED;
    volatile int percent = 0;

    StickerSlot(String fileName, String[] emojis) {
        this.fileName = fileName;
        this.emojis = emojis;
    }

    void set(int newState, int newPercent) {
        state = newState;
        percent = newPercent;
    }
}
