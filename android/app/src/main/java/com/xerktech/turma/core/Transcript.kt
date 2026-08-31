package com.xerktech.turma.core

import com.xerktech.turma.model.Block
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TaskNotificationBlock
import com.xerktech.turma.model.TextBlock
import com.xerktech.turma.model.ThinkingBlock
import com.xerktech.turma.model.ToolResultBlock
import com.xerktech.turma.model.ToolUseBlock
import kotlin.math.max

/**
 * Per-session transcript buffer logic — a port of the web chat.js mergeTail
 * (itself descended from glasses/src/transcript.ts). Entries only ever GROW
 * (a shorter incoming copy is a bounded heartbeat preview that must not
 * clobber the full text), are deduped by key, and the concise tool-marker
 * strip matches the web "Concise" verbosity.
 */

private val TOOL_MARKER = Regex("\\[[A-Za-z][A-Za-z0-9_]*]")

/** Strip the agent flattener's bracketed [ToolName] markers from assistant text. */
fun conciseText(role: String, text: String): String =
    if (role == "assistant") text.replace(TOOL_MARKER, "").replace(Regex("[ \\t]{2,}"), " ").trim()
    else text

/**
 * Displayable weight of an entry: flat text plus any block payload (rich >
 * flat). EVERY block payload field counts, not just the text-ish ones — a
 * task_notification carries its content in summary/status/result — matching
 * chat.js `weight`: leaving fields out makes the rich copy TIE its own flat
 * text, and the `>=` tie-break then lets a text-only seed clobber the blocks
 * back off the entry.
 */
fun entryWeight(entry: TailEntry): Int {
    var w = entry.text.length
    for (b in entry.blocks) w += blockText(b).length
    return w
}

private fun blockText(b: Block): String = when (b) {
    is TextBlock -> b.text
    is ThinkingBlock -> b.text
    is ToolResultBlock -> b.text
    is ToolUseBlock -> b.name + (b.input?.toString() ?: "")
    is TaskNotificationBlock -> b.summary + b.status + b.result
    else -> ""
}


/**
 * Merge a delta of [incoming] entries into [existing], keyed on [TailEntry.key].
 * Grow-only: an incoming copy replaces the existing one only when it is at
 * least as heavy — or when it carries blocks the existing text-only copy lacks
 * (chat.js mergeTail's tie-break: the rich live copy must beat the heartbeat's
 * flat preview even at equal weight). New keys are appended in order.
 */
fun mergeTail(existing: List<TailEntry>, incoming: List<TailEntry>): List<TailEntry> {
    if (incoming.isEmpty()) return existing
    val out = existing.toMutableList()
    val indexByKey = HashMap<String, Int>()
    out.forEachIndexed { i, e -> indexByKey[e.key] = i }
    for (inc in incoming) {
        val k = inc.key
        if (k.isEmpty()) continue
        val at = indexByKey[k]
        if (at == null) {
            indexByKey[k] = out.size
            out.add(inc)
        } else if (
            entryWeight(inc) >= entryWeight(out[at]) ||
            (inc.blocks.isNotEmpty() && out[at].blocks.isEmpty())
        ) {
            out[at] = inc
        }
    }
    return out
}

/**
 * Fold a `/history` WINDOW into the buffer — the web chat.js `foldHistory`
 * semantics. History is the authoritative chronological scrollback with the
 * LOOSER per-block caps, so where the two overlap the heavier copy wins per key
 * (fixing the XERK-77 mid-sentence cutoff, where a drop-known-keys prepend left
 * entries stuck at the heartbeat/live-tail cap).
 *
 * It is NOT `mergeTail(history, buffer)`: that seeds order from the history
 * window and appends every buffer id history lacks at the END, so once the
 * grow-only live buffer reaches further back than the bounded history window, a
 * reload — fired by the poll fallback on every socket drop, common on mobile —
 * dumped those PRE-window entries below history, older text out of order. This
 * two-pointer merge instead syncs on the shared ids and preserves each side's
 * transcript order: history's older head leads, and only the buffer entries
 * newer than history's newest shared id trail it. [pickHeavier] mirrors
 * [mergeTail]'s tie-break (the buffer/live copy wins an equal-weight tie, a
 * blocks copy beats a text-only one).
 *
 * `existing` is the live buffer; `older` is the /history window. Returns the
 * merged list and whether more history remains ([truncated]).
 */
fun prependHistory(
    existing: List<TailEntry>,
    older: List<TailEntry>,
    truncated: Boolean,
): Pair<List<TailEntry>, Boolean> {
    return Pair(foldHistory(older, existing), truncated)
}

/** Order-preserving merge of a history window and the live buffer. See [prependHistory]. */
fun foldHistory(history: List<TailEntry>, buffer: List<TailEntry>): List<TailEntry> {
    val inHist = HashSet<String>()
    for (h in history) if (h.key.isNotEmpty()) inHist.add(h.key)
    val inBuf = HashSet<String>()
    for (b in buffer) if (b.key.isNotEmpty()) inBuf.add(b.key)
    fun pickHeavier(h: TailEntry, b: TailEntry): TailEntry =
        if (entryWeight(b) >= entryWeight(h) || (b.blocks.isNotEmpty() && h.blocks.isEmpty())) b else h
    val out = ArrayList<TailEntry>(history.size + buffer.size)
    val seen = HashSet<String>()
    fun pushOnce(e: TailEntry) { if (e.key.isNotEmpty() && seen.add(e.key)) out.add(e) }
    var i = 0
    var j = 0
    while (i < history.size && j < buffer.size) {
        val h = history[i]
        val b = buffer[j]
        if (h.key.isEmpty() || h.key in seen) { i++; continue }
        if (b.key.isEmpty() || b.key in seen) { j++; continue }
        if (h.key == b.key) { pushOnce(pickHeavier(h, b)); i++; j++; continue }
        // Emit whichever entry precedes the next shared anchor; when neither is
        // shared, history — the authoritative scrollback — leads.
        if (b.key in inHist && h.key !in inBuf) { pushOnce(h); i++ }
        else if (h.key in inBuf && b.key !in inHist) { pushOnce(b); j++ }
        else { pushOnce(h); i++ }
    }
    while (i < history.size) { pushOnce(history[i]); i++ }
    while (j < buffer.size) { pushOnce(buffer[j]); j++ }
    return out
}

/** Reserved for callers needing the max weight across a list (e.g. tests). */
fun maxWeight(entries: List<TailEntry>): Int = entries.fold(0) { acc, e -> max(acc, entryWeight(e)) }
