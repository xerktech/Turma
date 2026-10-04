package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.JiraBlock
import com.xerktech.turma.model.PermissionGroup
import com.xerktech.turma.model.PermissionRow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The usage.html permission-card helpers, ported (XERK-1576). Expectations are the web's. */
class PermissionsTest {

    @Test fun `kind labels follow the web's table, an unknown kind reads Prompt`() {
        assertEquals("Dialog", Permissions.kindLabel("dialog", "permission"))
        assertEquals("Dialog · sandbox", Permissions.kindLabel("dialog", "sandbox"))
        assertEquals("Classifier block", Permissions.kindLabel("classifier-denied", null))
        assertEquals("Asked in chat", Permissions.kindLabel("ask-in-chat", null))
        assertEquals("Prompt", Permissions.kindLabel("sandbox-escape", null))
        assertEquals("dialog", Permissions.kindStyle("sandbox-escape"))
        assertEquals("ask-in-chat", Permissions.kindStyle("ask-in-chat"))
    }

    @Test fun `a judged prompt reads Judged in its own chip style (XERK-1566)`() {
        assertEquals("Judged", Permissions.kindLabel("judged", null))
        // A sub-kind is a dialog's alone; a judged row never carries one into its label.
        assertEquals("Judged", Permissions.kindLabel("judged", "sandbox"))
        // Its own style (web `.perm-kind.k-judged`), never the dialog fallback.
        assertEquals("judged", Permissions.kindStyle("judged"))
    }

    @Test fun `a judged group offers no rule — the web's no-rule wording stands in`() {
        // The hub sends `suggestedRule: null` and no reason for a judged group.
        assertEquals(
            Permissions.Rule.None("no rule retires this", null),
            Permissions.rule(PermissionGroup(kind = "judged", tool = "Bash", head = "rm", count = 2, allowed = 1, denied = 1)),
        )
    }

    @Test fun `the subject is the head, an ask's question, or the tool`() {
        assertEquals("git status", Permissions.subject("dialog", "git status", null, "Bash"))
        assertEquals("Shall I push?", Permissions.subject("ask-in-chat", null, "Shall I push?", null))
        assertEquals("asked for permission in chat", Permissions.subject("ask-in-chat", null, null, null))
        assertEquals("ExitPlanMode", Permissions.subject("dialog", null, null, "ExitPlanMode"))
        assertEquals("—", Permissions.subject("dialog", null, null, null))
        assertTrue(Permissions.subjectIsProse("ask-in-chat", null))
        assertFalse(Permissions.subjectIsProse("dialog", null))
    }

    @Test fun `a path is joined so no line breaker can split it, and reads back unchanged`() {
        val wj = Permissions.WORD_JOINER
        assertEquals("~$wj/$wj.${wj}c", Permissions.unbreakable("~/.c"))
        val path = Permissions.unbreakable(Permissions.BEHAVIOUR_NOTE_CODE)
        assertEquals(Permissions.BEHAVIOUR_NOTE_CODE, path.replace(wj, ""))
        // Every slash and dot is held on both sides (the break the phone made was after a `/`).
        assertFalse(Regex("[^\u2060][/.]|[/.][^\u2060]").containsMatchIn(path))
        assertEquals("", Permissions.unbreakable(""))
    }

    @Test fun `an ask's markdown renders code spans and drops bold markers in one pass`() {
        assertEquals(
            listOf("Delete " to false, "legacy/" to true, " " to false, "now" to false),
            Permissions.proseRuns("Delete `legacy/` **now**"),
        )
        // A code span's own text is never re-read as bold; an unpaired marker stays.
        assertEquals(listOf("**kwargs" to true), Permissions.proseRuns("`**kwargs`"))
        assertEquals(listOf("a **b" to false), Permissions.proseRuns("a **b"))
    }

    @Test fun `answers read still-open, a dash for an ask, else allowed over denied`() {
        assertEquals("2 / 1", Permissions.answers(PermissionGroup(kind = "dialog", count = 3, allowed = 2, denied = 1, open = 0)))
        assertEquals("1 / 0 · 2 open", Permissions.answers(PermissionGroup(kind = "dialog", count = 3, allowed = 1, denied = 0, open = 2)))
        assertEquals("still open", Permissions.answers(PermissionGroup(kind = "dialog", count = 2, allowed = 0, denied = 0, open = 2)))
        assertEquals("—", Permissions.answers(PermissionGroup(kind = "ask-in-chat", count = 2, open = 0)))
        // An ask is answered in prose even if some hub counted it: never "0 / 0" ("ignored").
        assertEquals("—", Permissions.answers(PermissionGroup(kind = "ask-in-chat", count = 2, allowed = 0, denied = 0, open = 0)))
        // An older hub without allowed/denied: no answer is knowable, never 0 / 0.
        assertEquals("—", Permissions.answers(PermissionGroup(kind = "dialog", count = 2)))
        assertTrue(Permissions.answerless(PermissionGroup(kind = "ask-in-chat", count = 2, open = 1)))
        assertFalse(Permissions.answerless(PermissionGroup(kind = "ask-in-chat", count = 2, open = 2)))
        assertFalse(Permissions.answerless(PermissionGroup(kind = "dialog", count = 2)))
    }

    @Test fun `the rule cell copies a real rule and explains a missing one`() {
        assertEquals(
            Permissions.Rule.Copyable("Bash(git status:*)"),
            Permissions.rule(PermissionGroup(kind = "dialog", suggestedRule = "Bash(git status:*)")),
        )
        assertEquals(
            Permissions.Rule.None(Permissions.BEHAVIOUR_ROW, null),
            Permissions.rule(PermissionGroup(kind = "ask-in-chat", suggestedRule = "model behaviour: see CLAUDE.md step 0")),
        )
        assertEquals(
            Permissions.Rule.None("no safe rule — review it", "runs whatever follows it"),
            Permissions.rule(PermissionGroup(kind = "dialog", noRuleReason = "runs whatever follows it")),
        )
        // A classifier block's why is its deny reason ALONE.
        assertEquals(
            Permissions.Rule.None("no safe rule — review it", "Blocked: network egress"),
            Permissions.rule(PermissionGroup(kind = "classifier-denied", noRuleReason = "not on the list", denyReason = "network egress")),
        )
        assertEquals(
            Permissions.Rule.None("no rule retires this", null),
            Permissions.rule(PermissionGroup(kind = "dialog", tool = "ExitPlanMode")),
        )
        assertEquals("WebFetch(​domain:​docs.example.com)", Permissions.ruleDisplay("WebFetch(domain:docs.example.com)"))
    }

    @Test fun `waits and ages format like the web's fmtDuration`() {
        assertEquals("45s", Permissions.wait(45_000.0))
        assertEquals("6m", Permissions.wait(360_000.0))
        assertEquals("2h 05m", Permissions.wait((2 * 3600 + 5 * 60) * 1000.0))
        assertEquals("—", Permissions.wait(null))
        assertEquals("—", Permissions.wait(-1.0))
    }

    @Test fun `a recent row's meta is host, then wait or state and answer, then age`() {
        val now = 1_000_000_000L
        assertEquals(
            listOf("nas01", "waited 45s · allow", "2m ago"),
            Permissions.recentMeta(PermissionRow(host = "nas01", kind = "dialog", answer = "allow",
                waitedMs = 45_000.0, openedAt = (now - 120_000).toDouble(), closedAt = now.toDouble()), now),
        )
        assertEquals(
            listOf("nas01", "still open"),
            Permissions.recentMeta(PermissionRow(host = "nas01", kind = "dialog"), now),
        )
        // A classifier block holds nothing: only its answer. An ask never says "unknown".
        assertEquals(listOf("h", "deny"),
            Permissions.recentMeta(PermissionRow(host = "h", kind = "classifier-denied", answer = "deny", closedAt = 1.0), now))
        assertEquals(listOf("h"),
            Permissions.recentMeta(PermissionRow(host = "h", kind = "ask-in-chat", answer = "unknown", closedAt = 1.0), now))
    }

    @Test fun `a judged recent row says what the judge decided, and why, after the answer`() {
        val now = 1_000_000_000L
        val allow = PermissionRow(host = "nas01", kind = "judged", head = "rm -rf build", answer = "allow",
            waitedMs = 3_000.0, verdict = "allow", judgeReason = "build output only",
            openedAt = (now - 120_000).toDouble(), closedAt = now.toDouble())
        assertEquals("judge: allow — build output only", Permissions.judgeMeta(allow))
        assertEquals(
            listOf("nas01", "waited 3s · allow · judge: allow — build output only", "2m ago"),
            Permissions.recentMeta(allow, now),
        )
        // No reason: the verdict alone.
        val stand = PermissionRow(host = "h", kind = "judged", verdict = "stand", closedAt = 1.0)
        assertEquals("judge: stand", Permissions.judgeMeta(stand))
        assertEquals(listOf("h", "judge: stand"), Permissions.recentMeta(stand, now))
        // Any other verdict, an absent one, or a non-judged row: nothing.
        assertNull(Permissions.judgeMeta(stand.copy(verdict = "deny")))
        assertNull(Permissions.judgeMeta(stand.copy(verdict = null)))
        assertNull(Permissions.judgeMeta(stand.copy(kind = "dialog")))
        assertEquals(listOf("h"), Permissions.recentMeta(stand.copy(verdict = null, judgeReason = "x"), now))
    }

    @Test fun `the fetch scope is the pick as it applies off the live fleet, sorted`() {
        val agents = listOf(
            AgentInfo(key = "a", jira = JiraBlock(siteKey = "zeta")),
            AgentInfo(key = "b", jira = JiraBlock(siteKey = "acme")),
        )
        assertEquals(emptyList<String>(), Permissions.scope(agents, emptySet()))
        assertEquals(listOf("acme", "zeta"), Permissions.scope(agents, linkedSetOf("zeta", "acme")))
        // An org no live host reports does not scope (it self-heals to every org).
        assertEquals(emptyList<String>(), Permissions.scope(agents, setOf("gone")))
        assertEquals(listOf("acme"), Permissions.scope(agents, setOf("acme", "gone")))
    }
}
