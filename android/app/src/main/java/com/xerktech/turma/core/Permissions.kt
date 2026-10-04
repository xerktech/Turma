package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.PermissionGroup
import com.xerktech.turma.model.PermissionRow

/**
 * The Usage screen's "Permission prompts" card (XERK-1576), ported from
 * usage.html's permission helpers (`permKindHtml`, `permSubject`,
 * `permAnswers`, `permRuleHtml`, the recent-row meta). The web page is the
 * source of truth; keep the wording and the order in step with it.
 */
object Permissions {
    /** The window the card asks for (web `PERM_DAYS`). */
    const val DAYS = 7

    /** How often an open card re-reads its route (web `PERM_REFRESH_MS`). */
    const val REFRESH_MS = 60_000L

    /** Kind → chip label (web `PERM_KIND`). An unknown kind reads "Prompt". */
    val KIND_LABELS = mapOf(
        "dialog" to "Dialog",
        "classifier-denied" to "Classifier block",
        "ask-in-chat" to "Asked in chat",
    )

    /** The chip's colour class: a kind this build doesn't know paints as a dialog. */
    fun kindStyle(kind: String): String = if (kind in KIND_LABELS) kind else "dialog"

    /** The chip text: the kind, plus a dialog's own sub-kind unless it is a plain permission one. */
    fun kindLabel(kind: String, dialogKind: String?): String {
        val sub = if (kind == "dialog" && !dialogKind.isNullOrEmpty() && dialogKind != "permission")
            " · $dialogKind" else ""
        return (KIND_LABELS[kind] ?: "Prompt") + sub
    }

    /** What the prompt asked about (web `permSubject`). */
    fun subject(kind: String, head: String?, prompt: String?, tool: String?): String = when {
        !head.isNullOrEmpty() -> head
        kind == "ask-in-chat" -> prompt?.takeIf { it.isNotEmpty() } ?: "asked for permission in chat"
        else -> tool?.takeIf { it.isNotEmpty() } ?: "—"
    }

    fun subject(g: PermissionGroup) = subject(g.kind, g.head, g.prompt, g.tool)
    fun subject(r: PermissionRow) = subject(r.kind, r.head, r.prompt, r.tool)

    /** True when the subject is an ask's question (prose), not a command or tool name. */
    fun subjectIsProse(kind: String, head: String?) = head.isNullOrEmpty() && kind == "ask-in-chat"

    /**
     * An ask's question is the session's markdown: `code` spans render as code
     * and `**bold**` markers drop, in ONE pass (web `permProseHtml`) so a code
     * span's own text is never re-read as bold. Returns (text, isCode) runs.
     */
    fun proseRuns(text: String): List<Pair<String, Boolean>> {
        val out = mutableListOf<Pair<String, Boolean>>()
        var at = 0
        for (m in PROSE_RE.findAll(text)) {
            if (m.range.first > at) out.add(text.substring(at, m.range.first) to false)
            val code = m.groups[1]
            if (code != null) out.add(code.value to true) else out.add(m.groupValues[2] to false)
            at = m.range.last + 1
        }
        if (at < text.length) out.add(text.substring(at) to false)
        return out
    }
    private val PROSE_RE = Regex("`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*")

    /** A wait in ms as "45s" / "6m" / "2h 14m", or "—" (web `permWait`). */
    fun wait(ms: Double?): String =
        if (ms != null && ms.isFinite() && ms >= 0) fmtDuration(Math.round(ms / 1000.0)) else "—"

    /** "45s" / "6m" / "2h 14m" / "2d 2h" — the web's `fmtDuration`, seconds in. */
    fun fmtDuration(sec: Long): String {
        val s = maxOf(0L, sec)
        if (s < 60) return "${s}s"
        val mins = Math.round(s / 60.0)
        if (mins < 60) return "${mins}m"
        val hours = mins / 60
        if (hours < 24) return "${hours}h ${(mins % 60).toString().padStart(2, '0')}m"
        return "${hours / 24}d ${hours % 24}h"
    }

    /**
     * The Allowed / denied cell (web `permAnswers`): "still open" when every row
     * is still holding its session, "—" when no allow/deny answer is knowable
     * (an ask is answered in prose), else "a / d" plus "· N open".
     */
    fun answers(g: PermissionGroup): String {
        val open = g.open?.takeIf { it > 0 } ?: 0
        if (open > 0 && open >= g.count) return "still open"
        if (g.kind == "ask-in-chat" || g.allowed == null || g.denied == null) return "—"
        return "${g.allowed} / ${g.denied}" + if (open > 0) " · $open open" else ""
    }

    /** An answered ask has no allow/deny cell at all on a phone (web `permAnswerless`). */
    fun answerless(g: PermissionGroup): Boolean {
        val open = g.open != null && g.open > 0 && g.open >= g.count
        return !open && g.kind == "ask-in-chat"
    }

    private val BEHAVIOUR_RE = Regex("^model behaviour:\\s*")

    /** The ask-in-chat pointer: instructions, not a setting to paste (web `permIsBehaviour`). */
    fun isBehaviour(g: PermissionGroup): Boolean =
        g.suggestedRule?.let { BEHAVIOUR_RE.containsMatchIn(it) } == true

    /** What the rule cell shows (web `permRuleHtml`). */
    sealed interface Rule {
        /** A pasteable rule, with Copy. */
        data class Copyable(val rule: String) : Rule
        /** No rule; [why] is the one thing to go on, or null. */
        data class None(val text: String, val why: String?) : Rule
    }

    fun rule(g: PermissionGroup): Rule {
        val rule = g.suggestedRule.orEmpty()
        if (rule.isNotEmpty() && isBehaviour(g)) return Rule.None(BEHAVIOUR_ROW, null)
        if (rule.isNotEmpty()) return Rule.Copyable(rule)
        // A classifier block's why is its deny reason ALONE: a Bash head's
        // no-rule reason is about allow rules, not why the classifier said no.
        val deny = if (g.kind == "classifier-denied" && !g.denyReason.isNullOrEmpty())
            "Blocked: ${g.denyReason}" else null
        if (!g.noRuleReason.isNullOrEmpty()) return Rule.None("no safe rule — review it", deny ?: g.noRuleReason)
        return Rule.None("no rule retires this", deny)
    }

    /**
     * A rule as displayed: a zero-width break after `(` or a value-starting `:`
     * so a narrow box wraps there, not mid-name (web `permRuleCodeHtml`'s
     * `<wbr>`). Display only — Copy copies the raw rule.
     */
    fun ruleDisplay(rule: String): String = rule.replace(Regex("([(:])(?=[A-Za-z0-9])"), "$1​")

    const val BEHAVIOUR_ROW = "Instructions, not a setting — see the note below"

    /** The one note under the table when any group is an ask (web `PERM_BEHAVIOUR_NOTE`). */
    const val BEHAVIOUR_NOTE = "Asked in chat has no setting to copy: the session ended its turn to " +
        "ask in prose, and only its instructions change that. The fix is step 0 of “Delivering work” " +
        "in the global ~/.claude/CLAUDE.md on each host: the session runs unattended and never waits " +
        "for a human to approve, continue, push or open a PR."

    /** The path inside [BEHAVIOUR_NOTE] the web shows as `<code>`. */
    const val BEHAVIOUR_NOTE_CODE = "~/.claude/CLAUDE.md"

    /** The card's lead note (web `permissionsCardHtml`'s head). */
    const val NOTE = "Every permission dialog, auto-mode classifier block and ask-for-permission-in-chat " +
        "that held a session, grouped with the allow rule that would retire it. Follows the header's " +
        "org filter only — the chart's series toggles above do not apply here."

    /**
     * A recent row's host · wait/answer · age, host first, empty parts dropped
     * (web `.perm-meta`). A closed row without a wait says only its answer; a
     * row with no close yet is still holding its session; an ask never says
     * "unknown" (it has no allow/deny by design).
     */
    fun recentMeta(r: PermissionRow, nowMs: Long): List<String> {
        val parts = mutableListOf<String>()
        if (r.waitedMs != null) parts.add("waited ${wait(r.waitedMs)}")
        else if (r.closedAt == null && r.answer.isNullOrEmpty()) parts.add("still open")
        if (!r.answer.isNullOrEmpty() && r.kind != "ask-in-chat") parts.add(r.answer)
        val opened = r.openedAt?.takeIf { it.isFinite() && it > 0 }
        val ago = if (opened != null) fmtDuration(Math.round((nowMs - opened) / 1000.0)) + " ago" else ""
        return listOf(r.host, parts.joinToString(" · "), ago).filter { it.isNotEmpty() }
    }

    /**
     * The org keys the card is fetched for: the header's pick as it APPLIES
     * (org.js `getKeys()` — an org nobody reports does not scope), off the LIVE
     * fleet. Sorted, so the same selection always compares equal.
     */
    fun scope(agents: List<AgentInfo>, stored: Set<String>): List<String> =
        effectiveOrgs(stored, mergeSites(agents)).sorted()
}
