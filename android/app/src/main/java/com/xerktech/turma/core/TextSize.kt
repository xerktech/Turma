package com.xerktech.turma.core

/**
 * The in-session chat text size (XERK-144) — a single fleet-wide preference, not
 * a per-session one like verbosity: the ticket asks for a size that changes every
 * session's chat, so it is stored globally (see [data.TextSizePref]) and reached
 * by every transcript renderer through `ui.LocalTextSize`.
 *
 * [scale] multiplies the hardcoded bubble / thinking / tool font + line-height
 * sizes in `ui.TranscriptView`, so one factor moves every text size together and
 * their relative proportions are preserved.
 */
enum class TextSize(val label: String, val scale: Float) {
    SMALL("Small", 0.85f),
    MEDIUM("Medium", 1.0f),
    LARGE("Large", 1.2f),
    XLARGE("Extra large", 1.45f);

    companion object {
        val DEFAULT = MEDIUM

        /** Coerce a persisted ordinal back to an enum, defaulting junk / out-of-range. */
        fun fromOrdinal(i: Int): TextSize = entries.getOrElse(i) { DEFAULT }
    }
}
