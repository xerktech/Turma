package com.xerktech.turma.core

import com.xerktech.turma.model.SessionInfo

/**
 * The context-fullness meter (XERK-489 Phase 4) — the pure port of the web
 * `contextMeterChip` / `contextMeterHtml` (chat.js / index.html).
 *
 * How full the model's context window is right now, so an operator sees a session
 * about to auto-compact (~95%) before it does. EXACT for a local session (its
 * selected model's discovered window); a subscription session has no agent-side
 * figure, so Claude Code's own 200k assumption is used and the reading is marked
 * approximate. Both figures come off the heartbeat (agent transcript-sum), never a
 * pane statusLine — the "% context left" text needs a statusLine Turma refuses to
 * wire because it breaks busy detection (XERK-130).
 */
object ContextMeter {

    /** Warn from here up, matching the web (~85%). */
    const val WARN_PCT = 85

    /** Danger near the ~95% auto-compaction threshold. */
    const val DANGER_PCT = 95

    enum class Level { OK, WARN, DANGER }

    /**
     * [pct] is clamped to 0..100; [fraction] (0f..1f) drives a progress bar;
     * [approx] is true for a subscription session (label it "~").
     */
    data class Reading(val pct: Int, val fraction: Float, val level: Level, val approx: Boolean)

    /**
     * The meter for a session, or null when there is nothing to show — no turn
     * measured yet (numerator absent) or no window (denominator absent). Matching
     * the web, the same null both surfaces hide the meter on.
     */
    fun read(session: SessionInfo?): Reading? {
        val num = session?.lastTurnContextTokens ?: return null
        val den = session.contextWindowTokens ?: return null
        if (num <= 0 || den <= 0) return null
        val pct = ((num.toLong() * 100) / den).toInt().coerceIn(0, 100)
        val level = when {
            pct >= DANGER_PCT -> Level.DANGER
            pct >= WARN_PCT -> Level.WARN
            else -> Level.OK
        }
        return Reading(pct, pct / 100f, level, approx = session.modelSource != ModelSource.LOCAL)
    }
}
