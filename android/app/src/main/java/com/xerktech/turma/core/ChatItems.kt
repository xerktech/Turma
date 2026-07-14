package com.xerktech.turma.core

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
        // Pair tool_result → tool_use by forId; leftover results render standalone.
        val resultsByForId = entry.blocks.filterIsInstance<ToolResultBlock>()
            .filter { it.forId.isNotEmpty() }
            .associateBy { it.forId }
        val consumed = HashSet<String>()
        for (block in entry.blocks) {
            when (block) {
                is TextBlock -> if (block.text.isNotBlank()) {
                    out.add(
                        ChatItem.Bubble(
                            entry.key, entry.role, block.text,
                            revealLen = if (revealThis) revealShown else -1,
                        )
                    )
                }
                is ThinkingBlock -> if (prefs.thinking && block.text.isNotBlank()) {
                    out.add(ChatItem.Thinking(entry.key, block.text))
                }
                is ToolUseBlock -> if (prefs.toolCalls) {
                    val res = resultsByForId[block.id]
                    if (res != null) consumed.add(block.id)
                    out.add(
                        ChatItem.Tool(
                            entry.key,
                            name = block.name,
                            input = renderInput(block.input),
                            result = if (prefs.toolOutputs) (res?.text ?: "") else "",
                            isError = res?.isError ?: false,
                        )
                    )
                }
                is TaskNotificationBlock -> out.add(
                    ChatItem.TaskNote(entry.key, block.summary, block.status, block.result)
                )
                is ToolResultBlock -> { /* folded above; orphans handled below */ }
                else -> { /* unknown block: skip */ }
            }
        }
        // Orphan tool_result (no matching tool_use in this entry) — keep it so a
        // result-only turn isn't dropped, matching _entry_blocks inclusion.
        if (prefs.toolOutputs) {
            for (block in entry.blocks) {
                if (block is ToolResultBlock && block.forId !in consumed && block.text.isNotBlank()) {
                    out.add(ChatItem.Tool(entry.key, name = "result", input = "", result = block.text, isError = block.isError))
                }
            }
        }
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
