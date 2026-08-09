package com.xerktech.turma.core

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

    /** A user/assistant text bubble. [revealLen] < 0 means "show all". */
    data class Bubble(
        override val entryKey: String,
        val role: String,
        val text: String,
        val revealLen: Int = -1,
    ) : ChatItem

    data class Thinking(override val entryKey: String, val text: String) : ChatItem

    data class Tool(
        override val entryKey: String,
        val name: String,
        val input: String,
        val result: String,
        val isError: Boolean,
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
    ) : ChatItem
}

/**
 * Build display items from [entries] under [prefs]. When [revealNewestId]/
 * [revealShown] are set, the matching newest bubble is truncated to [revealShown]
 * chars for the typewriter effect (everything else renders full).
 */
fun buildItems(
    entries: List<TailEntry>,
    prefs: VerbosityPrefs,
    revealNewestId: String? = null,
    revealShown: Int = -1,
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
        val revealThis = entry.key == revealNewestId
        if (entry.blocks.isEmpty()) {
            val text = conciseText(entry.role, entry.text)
            if (text.isNotBlank()) {
                out.add(
                    ChatItem.Bubble(
                        entry.key, entry.role, text,
                        revealLen = if (revealThis) revealShown else -1,
                    )
                )
            }
            continue
        }
        // Consecutive text blocks are ONE bubble, flushed by any other block —
        // the web accumulates `msg.text += b.text` and flushes the same way, so
        // a turn split across blocks must not render as several bubbles.
        var pending: StringBuilder? = null
        fun flushText() {
            val text = pending?.toString()
            pending = null
            if (!text.isNullOrBlank()) {
                out.add(
                    ChatItem.Bubble(
                        entry.key, entry.role, text,
                        revealLen = if (revealThis) revealShown else -1,
                    )
                )
            }
        }
        for (block in entry.blocks) {
            when (block) {
                is TextBlock -> (pending ?: StringBuilder().also { pending = it }).append(block.text)
                is ThinkingBlock -> if (prefs.thinking && block.text.isNotBlank()) {
                    flushText()
                    out.add(ChatItem.Thinking(entry.key, block.text))
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
                        )
                    )
                }
                is TaskNotificationBlock -> {
                    flushText()
                    out.add(ChatItem.TaskNote(entry.key, block.summary, block.status, block.result))
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

/** Compact one-line-ish rendering of a tool_use input for the card header. */
fun renderInput(input: JsonElement?): String = when (input) {
    null, JsonNull -> ""
    is JsonPrimitive -> input.content
    is JsonObject -> input.entries.joinToString(", ") { (k, v) ->
        "$k: ${if (v is JsonPrimitive) v.content else v.toString()}"
    }
    else -> input.toString()
}
