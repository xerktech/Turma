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

/** Whether any of the entry's blocks was clipped to a cap by the agent. */
fun entryTruncated(entry: TailEntry): Boolean = entry.blocks.any {
    when (it) {
        is TextBlock -> it.truncated
        is ThinkingBlock -> it.truncated
        is ToolUseBlock -> it.truncated
        is ToolResultBlock -> it.truncated
        is TaskNotificationBlock -> it.truncated
        else -> false
    }
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
 * Fold a `/history` page into the buffer — the web chat.js loadHistory
 * semantics, NOT a drop-duplicates prepend: history is the authoritative
 * chronological scrollback with the LOOSER per-block caps, so it seeds the
 * order and each already-known entry is re-merged on top, the heavier copy
 * winning per key. (The old drop-known-keys prepend left every entry stuck at
 * the 500-char heartbeat preview / 4000-char live-tail block cap it first
 * arrived with — the XERK-77 mid-sentence cutoff.) Buffer keys history doesn't
 * know are strictly newer live entries and keep their order at the end.
 * Returns the merged list and whether more history remains ([truncated]).
 */
fun prependHistory(
    existing: List<TailEntry>,
    older: List<TailEntry>,
    truncated: Boolean,
): Pair<List<TailEntry>, Boolean> {
    return Pair(mergeTail(older, existing), truncated)
}

/** Reserved for callers needing the max weight across a list (e.g. tests). */
fun maxWeight(entries: List<TailEntry>): Int = entries.fold(0) { acc, e -> max(acc, entryWeight(e)) }
