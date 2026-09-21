package com.stickerforge.app;

/** A load failure that already knows which sentence explains it to a human. */
final class LoadException extends Exception {

    static final int KIND_UNREACHABLE = 0;
    static final int KIND_TIMEOUT = 1;
    static final int KIND_NOT_FOUND = 2;
    static final int KIND_SERVER = 3;
    static final int KIND_MANIFEST = 4;
    static final int KIND_TOO_FEW = 5;
    static final int KIND_DISK = 6;
    static final int KIND_INCOMPLETE = 7;
    static final int KIND_UNKNOWN = 8;

    final int messageRes;
    final int kind;
    final Object[] args;

    LoadException(int messageRes, int kind, Object... args) {
        super(Integer.toString(messageRes));
        this.messageRes = messageRes;
        this.kind = kind;
        this.args = args;
    }

    static LoadException wrap(int messageRes, int kind, Throwable cause, Object... args) {
        LoadException error = new LoadException(messageRes, kind, args);
        error.initCause(cause);
        return error;
    }
}
