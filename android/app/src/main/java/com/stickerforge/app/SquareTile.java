package com.stickerforge.app;

import android.content.Context;
import android.util.AttributeSet;
import android.widget.FrameLayout;

/** A die-cut tile: always as tall as the grid column it was measured into. */
public class SquareTile extends FrameLayout {

    public SquareTile(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        int side = MeasureSpec.getSize(widthSpec);
        super.onMeasure(
                MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(side, MeasureSpec.EXACTLY));
    }
}
