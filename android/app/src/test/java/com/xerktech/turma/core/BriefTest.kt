package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.BriefCounts
import com.xerktech.turma.model.BriefItem
import com.xerktech.turma.model.JiraBlock
import com.xerktech.turma.model.OrgBrief
import com.xerktech.turma.model.OrgDecision
import org.junit.Assert.assertEquals
import org.junit.Test

/** Parity with turma/public/brief.html's render (XERK-1573). */
class BriefTest {

    private fun host(key: String, org: String?) = AgentInfo(
        key = key, device = key, online = true, org = org,
        jira = org?.let { JiraBlock(available = true, configured = true, siteKey = it) },
    )

    private fun brief(site: String) = OrgBrief(siteKey = site, at = 2000, since = 1000)

    @Test fun `briefOrgs lists decided orgs and kept briefs, scoped by the org pick`() {
        val agents = listOf(host("a1", "a.atlassian.net"), host("b1", "b.atlassian.net"), host("n1", null))
        val briefs = mapOf(
            "a.atlassian.net" to listOf(brief("a.atlassian.net")),
            // An org whose last host was removed still has its kept brief.
            "gone.atlassian.net" to listOf(brief("gone.atlassian.net")),
            "empty.atlassian.net" to emptyList(),
        )
        assertEquals(
            listOf("a.atlassian.net", "b.atlassian.net", "gone.atlassian.net"),
            briefOrgs(briefs, agents, emptySet()),
        )
        assertEquals(listOf("b.atlassian.net"), briefOrgs(briefs, agents, setOf("b.atlassian.net")))
        // A pick naming an org nobody reports doesn't apply (the self-heal).
        assertEquals(3, briefOrgs(briefs, agents, setOf("nobody.atlassian.net")).size)
    }

    @Test fun `briefLiveOrgs is the decided orgs alone, never a kept brief's`() {
        val agents = listOf(host("a1", "a.atlassian.net"), host("a2", "a.atlassian.net"),
            host("b1", "b.atlassian.net"), host("n1", null), host("e1", ""))
        assertEquals(setOf("a.atlassian.net", "b.atlassian.net"), briefLiveOrgs(agents))
        assertEquals(emptySet<String>(), briefLiveOrgs(emptyList()))
    }

    @Test fun `briefDur words a duration like the web page`() {
        assertEquals("0s", briefDur(-5))
        assertEquals("89s", briefDur(89_000))
        assertEquals("2m", briefDur(90_000))
        assertEquals("59m", briefDur(3_569_000))
        assertEquals("1h", briefDur(3_570_000))
        assertEquals("1h", briefDur(3_600_000))
        // 61 minutes: the hub's "Starts next" reason says the same (XERK-1573).
        assertEquals("1h", briefDur(61 * 60_000L))
        assertEquals("1h", briefDur(5_399_000))
        assertEquals("2h", briefDur(7_200_000))
        assertEquals("3d", briefDur(3 * 86_400_000L))
    }

    @Test fun `briefItemMeta reads state, why, reason, time, key and host in the web's order`() {
        val now = 10_000_000L
        val q = BriefItem(kind = "session", title = "t", host = "h1", sessionId = "s1",
            state = "needs-you:question", why = "Ship it?", since = now - 600_000, key = "X-1")
        assertEquals("question · Ship it? · 10m ago · X-1 · h1", briefItemMeta("needsYou", q, now))
        val w = BriefItem(kind = "session", title = "t", host = "h1", state = "waiting",
            why = "Watch CI", since = now - 60_000, eta = now + 1_200_000)
        assertEquals("waiting · Watch CI · in 20m · h1", briefItemMeta("waiting", w, now))
        // Starts next: the reason alone — no age, no host.
        val n = BriefItem(kind = "ticket", title = "do it", key = "O-1", since = now - 1000,
            reason = "oldest first · created 60d ago", host = "h1")
        assertEquals("oldest first · created 60d ago", briefItemMeta("nextUp", n, now))
        // A stale close names its kind in words.
        val z = BriefItem(kind = "ticket", title = "flaky", key = "A-9", reason = "not-reproducible",
            note = "ran 50x", since = now - 3_600_000, host = "h1")
        assertEquals("not reproducible · ran 50x · 1h ago · h1", briefItemMeta("closedStale", z, now))
    }

    @Test fun `briefItemMeta leads a Finished row with how and when it finished`() {
        val now = 10_000_000L
        val t = BriefItem(kind = "ticket", title = "shipped", key = "A-1", since = now - 7_200_000, host = "h1")
        assertEquals("done 2h ago · h1", briefItemMeta("finished", t, now))
        // A PR carries no merge time: the verb alone.
        val p = BriefItem(kind = "pr", title = "Fix it", url = "https://x/pull/9", key = "A-2", host = "h1")
        assertEquals("merged · A-2 · h1", briefItemMeta("finished", p, now))
        val s = BriefItem(kind = "session", title = "run", sessionId = "c4", transcriptId = "t-c4",
            since = now - 600_000, host = "h1")
        assertEquals("ended 10m ago · h1", briefItemMeta("finished", s, now))
        // Only the Finished section words it so.
        assertEquals("2h ago · h1", briefItemMeta("closedStale", t, now))
    }

    @Test fun `a Done ticket carries its folded merged PR`() {
        val now = 10_000_000L
        val t = BriefItem(kind = "ticket", title = "shipped", key = "P-1", since = now - 3_600_000,
            host = "h1", prUrl = "https://github.com/x/y/pull/42")
        assertEquals("done 1h ago · merged PR · h1", briefItemMeta("finished", t, now))
        assertEquals("https://github.com/x/y/pull/42", briefPrUrl(t))
        // Only an http(s) link is a link (web safeUrl).
        val bad = t.copy(prUrl = "javascript:alert(1)")
        assertEquals(null, briefPrUrl(bad))
        assertEquals("done 1h ago · h1", briefItemMeta("finished", bad, now))
    }

    @Test fun `briefSpendWindow says when each window resets`() {
        val now = 10_000_000L
        assertEquals("5h 95%, resets in 52m", briefSpendWindow("5h", 95.2, now + 52 * 60_000L, now))
        assertEquals("7d 40%, resets in 3d", briefSpendWindow("7d", 40.0, now + 3 * 86_400_000L, now))
        assertEquals("5h 95%, has reset since", briefSpendWindow("5h", 95.0, now - 1000, now))
        assertEquals("7d 40%", briefSpendWindow("7d", 40.0, null, now))
        assertEquals(null, briefSpendWindow("5h", null, now + 1000, now))
    }

    @Test fun `briefSectionCount is the uncapped total, never below the rows shown`() {
        val rows = List(10) { BriefItem(kind = "session", title = "s$it") }
        val b = OrgBrief(counts = BriefCounts(needsYou = 15), needsYou = rows, waiting = rows.take(2))
        assertEquals(15L, briefSectionCount(b, "needsYou"))
        assertEquals("a count the hub left 0 reads as the rows", 2L, briefSectionCount(b, "waiting"))
    }

    @Test fun `briefDecisionLines is the newest few, newest first, worded as the web does`() {
        val now = 10_000_000L
        val log = listOf(
            OrgDecision(at = now - 7_200_000, source = "question", question = "Which DB?",
                answer = "Postgres", ticket = "O-1", host = "h"),
            OrgDecision(at = now - 60_000, source = "note", text = "No infra merges."),
            OrgDecision(at = 0, source = "permission", question = "Proceed?", answer = "Yes"),
        )
        assertEquals(
            listOf(
                "Proceed? → Yes" to "permission",
                "No infra merges." to "note · 60s ago",
                "Which DB? → Postgres" to "answered · O-1 · 2h ago · h",
            ),
            briefDecisionLines(log, now),
        )
        val many = (1..15).map { OrgDecision(at = it.toLong(), source = "note", text = "n$it") }
        val lines = briefDecisionLines(many, 100)
        assertEquals(BRIEF_DECISIONS_SHOWN, lines.size)
        assertEquals("n15", lines.first().first)
        assertEquals("n6", lines.last().first)
    }
}
