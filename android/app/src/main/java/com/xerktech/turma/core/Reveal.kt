package com.xerktech.turma.core

import kotlin.math.floor
import kotlin.math.min

/**
 * Typewriter reveal state machine — a pure port of glasses/src/reveal.ts.
 *
 * Tracks a character count into the NEWEST transcript entry only; everything
 * above is always rendered in full. A committed entry lands whole (echoed user
 * message, tool result, a message only recorded on completion) and snaps; a
 * genuine live streaming turn types in character-by-character.
 */
data class RevealState(val entryId: String = "", val shown: Int = 0)

const val REVEAL_RATE_CPS = 150
const val REVEAL_SNAP_CHARS = 200

/**
 * @param prev previous reveal state
 * @param newestId id of the newest entry (or the live turn)
 * @param targetLen displayable length of that newest entry
 * @param dtMs elapsed ms since the last tick (0 = "text just changed" re-anchor)
 * @param live true when [newestId] is the in-progress streaming turn (types),
 *             false for a committed entry (snaps on id change)
 */
fun advanceReveal(
    prev: RevealState,
    newestId: String,
    targetLen: Int,
    dtMs: Long,
    live: Boolean,
): RevealState {
    if (targetLen <= 0 || newestId.isEmpty()) return RevealState(newestId, 0)

    val sameId = newestId == prev.entryId
    // A newly-committed entry (id changed, not a live turn) lands whole.
    if (!sameId && !live) return RevealState(newestId, targetLen)

    val base = if (sameId) min(prev.shown, targetLen) else 0
    val backlog = targetLen - base
    // A big chunk arriving at once mirrors immediately instead of animating.
    if (backlog > REVEAL_SNAP_CHARS) return RevealState(newestId, targetLen)

    val step = floor(REVEAL_RATE_CPS * dtMs / 1000.0).toInt()
    val shown = min(targetLen, base + step)
    return RevealState(newestId, shown)
}

/** Show an entry outright (entering a session so history renders full). */
fun fullReveal(id: String, len: Int): RevealState = RevealState(id, len)

fun revealComplete(state: RevealState, targetLen: Int): Boolean = state.shown >= targetLen
