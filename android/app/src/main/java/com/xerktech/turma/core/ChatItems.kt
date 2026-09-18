package com.xerktech.turma.core

import com.xerktech.turma.model.Block
import com.xerktech.turma.model.SendFile
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.TaskNotificationBlock
import com.xerktech.turma.model.TextBlock
import com.xerktech.turma.model.ThinkingBlock
import com.xerktech.turma.model.ToolResultBlock
import com.xerktech.turma.model.ToolUseBlock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Turn transcript entries + verbosity prefs into flat renderable chat items —
 * a pure port of chat.js buildItems, unit-tested independently of Compose.
 * Groups a tool_result into its matching tool_use by forId; folds thinking and
 * tool components in/out per the verbosity filter.
 */

enum class Verbosity { CONCISE, NORMAL, VERBOSE }

data class VerbosityPrefs(
    val thinking: Boolean,
    val toolCalls: Boolean,
    val toolOutputs: Boolean,
) {
    companion object {
        fun forPreset(v: Verbosity): VerbosityPrefs = when (v) {
            Verbosity.CONCISE -> VerbosityPrefs(thinking = false, toolCalls = false, toolOutputs = false)
            Verbosity.NORMAL -> VerbosityPrefs(thinking = false, toolCalls = true, toolOutputs = true)
            Verbosity.VERBOSE -> VerbosityPrefs(thinking = true, toolCalls = true, toolOutputs = true)
        }
    }
}

sealed interface ChatItem {
    val entryKey: String

    /**
     * A user/assistant text bubble. [clipped] marks a block the agent had to cut
     * to its cap — a static mark, never a control, exactly as the web renders it
     * (XERK-347): the live tail and /history read at the same fidelity, so there
     * is no fuller copy for a tap to fetch.
     */
    data class Bubble(
        override val entryKey: String,
        val role: String,
        val text: String,
        val clipped: Boolean = false,
    ) : ChatItem

    data class Thinking(
        override val entryKey: String,
        val text: String,
        val clipped: Boolean = false,
    ) : ChatItem

    data class Tool(
        override val entryKey: String,
        val name: String,
        val input: String,
        val result: String,
        val isError: Boolean,
        val clipped: Boolean = false,
        // SendUserFile inline previews + caption (XERK-221). Shown whenever the
        // card shows (like the web's open-by-default files), not gated on outputs.
        val files: List<SendFile> = emptyList(),
        val caption: String = "",
    ) : ChatItem

    data class TaskNote(
        override val entryKey: String,
        val summary: String,
        val status: String,
        val result: String,
        val clipped: Boolean = false,
    ) : ChatItem
}

/**
 * Build display items from [entries] under [prefs]. Every bubble renders in
 * full, the moment it lands (XERK-251 — the newest one used to type in).
 */
fun buildItems(
    entries: List<TailEntry>,
    prefs: VerbosityPrefs,
): List<ChatItem> {
    val out = ArrayList<ChatItem>()
    // Pair tool_result -> tool_use by forId across the WHOLE conversation, not
    // within one entry: the agent emits a call's result in the NEXT (user-role)
    // entry, never beside the call (hub-agent.py _entry_blocks), so a per-entry
    // map pairs nothing and every card renders empty beside a duplicate.
    // Last result wins, deliberately: a Skill call reports twice under one id —
    // a "Launching skill: <name>" stub, then the body — and the body is what a
    // reader opening the card wants (chat.js buildItems).
    val resultsByForId = HashMap<String, ToolResultBlock>()
    val toolUseIds = HashSet<String>()
    for (entry in entries) {
        for (block in entry.blocks) {
            when (block) {
                is ToolUseBlock -> if (block.id.isNotEmpty()) toolUseIds.add(block.id)
                is ToolResultBlock -> if (block.forId.isNotEmpty()) resultsByForId[block.forId] = block
                else -> {}
            }
        }
    }
    for (entry in entries) {
        // Older agents / the text-only heartbeat seed carry no blocks: synthesize
        // them, splitting a trailing run of tool markers off into name-only
        // tool_use rows the verbosity filter can hide — never deleting them, and
        // never touching bracketed prose (XERK-861). The web chat.js synthesizes
        // a block-less entry as one text block and shows the markers verbatim;
        // Android leads it here (see android/PARITY.md, XERK-861).
        val blocks = if (entry.blocks.isNotEmpty()) entry.blocks else degradedBlocks(entry.role, entry.text)
        if (blocks.isEmpty()) continue
        // Consecutive text blocks are ONE bubble, flushed by any other block —
        // the web accumulates `msg.text += b.text` and flushes the same way, so
        // a turn split across blocks must not render as several bubbles.
        var pending: StringBuilder? = null
        var pendingClipped = false
        fun flushText() {
            val text = pending?.toString()
            val clipped = pendingClipped
            pending = null
            pendingClipped = false
            if (!text.isNullOrBlank()) out.add(ChatItem.Bubble(entry.key, entry.role, text, clipped))
        }
        for (block in blocks) {
            when (block) {
                is TextBlock -> {
                    (pending ?: StringBuilder().also { pending = it }).append(block.text)
                    if (block.truncated) pendingClipped = true
                }
                is ThinkingBlock -> if (prefs.thinking && block.text.isNotBlank()) {
                    flushText()
                    out.add(ChatItem.Thinking(entry.key, block.text, block.truncated))
                }
                // A SendUserFile delivery (a block carrying rendered files) is
                // user-facing content, not a tool mechanic, so it shows in EVERY
                // verbosity — even Concise, which hides ordinary tool cards (XERK-221).
                is ToolUseBlock -> if (prefs.toolCalls || block.files.isNotEmpty()) {
                    flushText()
                    val res = resultsByForId[block.id]
                    out.add(
                        ChatItem.Tool(
                            entry.key,
                            name = block.name,
                            input = renderInput(block.input),
                            result = if (prefs.toolOutputs) (res?.text ?: "") else "",
                            isError = res?.isError ?: false,
                            files = block.files,
                            caption = block.caption,
                            clipped = block.truncated || (prefs.toolOutputs && res?.truncated == true),
                        )
                    )
                }
                is TaskNotificationBlock -> {
                    flushText()
                    out.add(ChatItem.TaskNote(entry.key, block.summary, block.status, block.result, block.truncated))
                }
                // A result whose call is anywhere in the conversation folded into
                // that card above. Anything left is an orphan — keep it, so a
                // result-only turn isn't dropped (matching _entry_blocks).
                is ToolResultBlock -> {
                    val paired = block.forId.isNotEmpty() && block.forId in toolUseIds
                    // No isNotBlank() guard: chat.js pushes the orphan card
                    // regardless and renders "(no output)". Dropping the empty
                    // one was the last divergence out of 14 producer-generated
                    // wire cases (XERK-235).
                    if (!paired && prefs.toolOutputs) {
                        flushText()
                        out.add(
                            ChatItem.Tool(
                                entry.key, name = "result", input = "",
                                result = block.text, isError = block.isError,
                                clipped = block.truncated,
                            )
                        )
                    }
                }
                else -> { /* unknown block: skip */ }
            }
        }
        flushText()
    }
    return out
}

// The agent flattener (hub-agent.py `_entry_text`) appends one `[ToolName]`
// marker per tool_use in content order with NO separator; within one entry the
// tool_use blocks sit at the end (the turn yields at the first tool call), so a
// genuine run is always TRAILING and its markers abut each other. `-` is in the
// name class for hyphenated subagent types; MCP names (`mcp__server__tool`)
// carry underscores. Conditions per XERK-861 (the intended web behavior — the
// web chat.js does NOT yet do this split; see android/PARITY.md).
private val TRAILING_MARKER_RUN = Regex("(?:\\[[A-Za-z][A-Za-z0-9_-]*])+$")
private val ONE_MARKER = Regex("\\[[A-Za-z][A-Za-z0-9_-]*]")

/**
 * Synthesize display blocks for a BLOCK-LESS entry (an older agent or the
 * text-only heartbeat seed) — the fix for XERK-861 (the old `conciseText`
 * deleted ANY `[Word]` from assistant text, prose included, silently and
 * un-recoverably).
 *
 * A trailing run of tool markers is split off into NAME-ONLY tool_use rows so
 * buildItems' verbosity filter hides them under Concise and shows them under
 * Normal/Verbose — rather than the text vanishing. (The web chat.js does not do
 * this split yet; Android leads it — see android/PARITY.md.) The split is
 * deliberately narrow, and the narrowness is the point:
 *  - only role == "assistant" (a user turn's text is never a flattened turn);
 *  - only a RUN of markers at the very END of the text;
 *  - only a plausible tool name, `[A-Za-z][A-Za-z0-9_-]*`;
 *  - only when the run is NOT preceded by a space or tab — the join has no
 *    separator, so a real marker abuts its text or a line break, while prose
 *    ("the plan [WIP]") puts a space before its bracket.
 * That set keeps "the plan [WIP]", "see [1]" and "see the [notes] section"
 * intact as ordinary text.
 */
fun degradedBlocks(role: String, text: String): List<Block> {
    if (text.isEmpty()) return emptyList()
    val plain = if (text.isBlank()) emptyList() else listOf(TextBlock(text))
    if (role != "assistant") return plain
    val run = TRAILING_MARKER_RUN.find(text) ?: return plain
    val runStart = run.range.first
    // Prose puts a space (or tab) before its bracket; a flattened marker does not.
    if (runStart > 0 && (text[runStart - 1] == ' ' || text[runStart - 1] == '\t')) return plain
    val lead = text.substring(0, runStart).trimEnd()
    val out = ArrayList<Block>()
    if (lead.isNotEmpty()) out.add(TextBlock(lead))
    for (m in ONE_MARKER.findAll(run.value)) out.add(ToolUseBlock(name = m.value.substring(1, m.value.length - 1)))
    return out
}

/** Compact one-line-ish rendering of a tool_use input for the card header. */
fun renderInput(input: JsonElement?): String = when (input) {
    null, JsonNull -> ""
    is JsonPrimitive -> input.content
    is JsonObject -> input.entries.joinToString(", ") { (k, v) ->
        "$k: ${if (v is JsonPrimitive) v.content else v.toString()}"
    }
    else -> input.toString()
}
