package com.xerktech.turma.core

import com.xerktech.turma.model.Block
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TextBlock
import com.xerktech.turma.model.ThinkingBlock
import com.xerktech.turma.model.ToolResultBlock
import com.xerktech.turma.model.ToolUseBlock
import kotlin.math.max

/**
 * Per-session transcript buffer logic — a pure port of glasses/src/transcript.ts.
 * Entries only ever GROW (a shorter incoming copy is a bounded heartbeat
 * preview that must not clobber the full text), are deduped by key, and the
 * concise tool-marker strip matches the web "Concise" verbosity.
 */

private val TOOL_MARKER = Regex("\\[[A-Za-z][A-Za-z0-9_]*]")

/** Strip the agent flattener's bracketed [ToolName] markers from assistant text. */
fun conciseText(role: String, text: String): String =
    if (role == "assistant") text.replace(TOOL_MARKER, "").replace(Regex("[ \\t]{2,}"), " ").trim()
    else text

/** Displayable weight of an entry: flat text plus any block text (rich > flat). */
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
    else -> ""
}

/**
 * Merge a delta of [incoming] entries into [existing], keyed on [TailEntry.key].
 * Grow-only: an incoming copy replaces the existing one only when it is at least
 * as heavy. New keys are appended in order. Returns a new list.
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
        } else if (entryWeight(inc) >= entryWeight(out[at])) {
            out[at] = inc
        }
    }
    return out
}

/**
 * Prepend an older history page. Keys already present are dropped (the live tail
 * is always more current than a history snapshot). Returns the merged list and
 * whether more history remains ([truncated]).
 */
fun prependHistory(
    existing: List<TailEntry>,
    older: List<TailEntry>,
    truncated: Boolean,
): Pair<List<TailEntry>, Boolean> {
    val known = existing.map { it.key }.toHashSet()
    val fresh = older.filter { it.key.isNotEmpty() && it.key !in known }
    return Pair(fresh + existing, truncated)
}

/** Reserved for callers needing the max weight across a list (e.g. tests). */
fun maxWeight(entries: List<TailEntry>): Int = entries.fold(0) { acc, e -> max(acc, entryWeight(e)) }
