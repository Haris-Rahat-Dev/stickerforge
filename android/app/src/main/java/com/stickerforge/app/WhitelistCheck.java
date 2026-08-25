package com.stickerforge.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.database.Cursor;
import android.net.Uri;

/** Port of WhatsApp's official WhitelistCheck sample (BSD, Meta Platforms). */
final class WhitelistCheck {
    private static final String AUTHORITY_QUERY_PARAM = "authority";
    private static final String IDENTIFIER_QUERY_PARAM = "identifier";
    private static final String STICKER_APP_AUTHORITY = BuildConfig.CONTENT_PROVIDER_AUTHORITY;
    static final String CONSUMER_WHATSAPP_PACKAGE_NAME = "com.whatsapp";
    static final String SMB_WHATSAPP_PACKAGE_NAME = "com.whatsapp.w4b";
    private static final String CONTENT_PROVIDER = ".provider.sticker_whitelist_check";
    private static final String QUERY_PATH = "is_whitelisted";
    private static final String QUERY_RESULT_COLUMN_NAME = "result";

    private WhitelistCheck() {}

    static boolean isWhitelisted(Context context, String identifier) {
        try {
            if (!isWhatsAppConsumerAppInstalled(context.getPackageManager())
                    && !isWhatsAppSmbAppInstalled(context.getPackageManager())) {
                return false;
            }
            boolean consumerResult = isStickerPackWhitelistedInWhatsAppConsumer(context, identifier);
            boolean smbResult = isStickerPackWhitelistedInWhatsAppSmb(context, identifier);
            return consumerResult && smbResult;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isWhitelistedFromProvider(Context context, String identifier, String whatsappPackageName) {
        final PackageManager packageManager = context.getPackageManager();
        if (isPackageInstalled(whatsappPackageName, packageManager)) {
            final String whatsappProviderAuthority = whatsappPackageName + CONTENT_PROVIDER;
            final ProviderInfo providerInfo = packageManager.resolveContentProvider(whatsappProviderAuthority, PackageManager.GET_META_DATA);
            if (providerInfo == null) return false;
            final Uri queryUri = new Uri.Builder()
                    .scheme("content")
                    .authority(whatsappProviderAuthority)
                    .appendPath(QUERY_PATH)
                    .appendQueryParameter(AUTHORITY_QUERY_PARAM, STICKER_APP_AUTHORITY)
                    .appendQueryParameter(IDENTIFIER_QUERY_PARAM, identifier)
                    .build();
            try (Cursor cursor = context.getContentResolver().query(queryUri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    final int result = cursor.getInt(cursor.getColumnIndexOrThrow(QUERY_RESULT_COLUMN_NAME));
                    return result == 1;
                }
            }
        } else {
            return true;
        }
        return false;
    }

    static boolean isPackageInstalled(String packageName, PackageManager packageManager) {
        try {
            final ApplicationInfo info = packageManager.getApplicationInfo(packageName, 0);
            return info != null && info.enabled;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static boolean isWhatsAppConsumerAppInstalled(PackageManager pm) {
        return isPackageInstalled(CONSUMER_WHATSAPP_PACKAGE_NAME, pm);
    }

    static boolean isWhatsAppSmbAppInstalled(PackageManager pm) {
        return isPackageInstalled(SMB_WHATSAPP_PACKAGE_NAME, pm);
    }

    static boolean isStickerPackWhitelistedInWhatsAppConsumer(Context context, String identifier) {
        return isWhitelistedFromProvider(context, identifier, CONSUMER_WHATSAPP_PACKAGE_NAME);
    }

    static boolean isStickerPackWhitelistedInWhatsAppSmb(Context context, String identifier) {
        return isWhitelistedFromProvider(context, identifier, SMB_WHATSAPP_PACKAGE_NAME);
    }
}
