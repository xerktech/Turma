package com.xerktech.turma.core

import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.model.QueuedTicket
import com.xerktech.turma.model.RepoGuess
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The board toolbar's view — mirrors turma/tests/board-view.test.js case for
 * case, so the phone and the web narrow and order a board identically.
 */
class BoardViewTest {
    private val now = java.time.Instant.parse("2026-10-02T12:00:00Z").toEpochMilli()
    private fun hoursAgo(h: Long) = java.time.Instant.ofEpochMilli(now - h * 3_600_000).toString()
    private val siteKey = "acme.atlassian.net"

    private fun tk(
        key: String = "XERK-1",
        summary: String = "A ticket",
        type: String = "Task",
        priority: String = "Medium",
        labels: List<String> = emptyList(),
        updated: String = hoursAgo(1),
        created: String = hoursAgo(100),
        dueDate: String? = null,
        epicKey: String? = null,
        isEpic: Boolean = false,
        blocks: List<String> = emptyList(),
        blockedBy: List<String> = emptyList(),
        repoGuess: RepoGuess? = RepoGuess(repo = "Turma", cloned = true),
        statusCategory: String = "todo",
    ) = JiraTicket(
        key = key, summary = summary, type = type, priority = priority, labels = labels,
        updated = updated, created = created, dueDate = dueDate, epicKey = epicKey, isEpic = isEpic,
        blocks = blocks, blockedBy = blockedBy, repoGuess = repoGuess, project = "XERK",
        status = "To Do", statusCategory = statusCategory,
    )

    private fun site(tickets: List<JiraTicket>) =
        BoardSite(siteKey = siteKey, site = siteKey, online = true, error = null, fetchedAt = "", tickets = tickets)

    private fun facets(t: JiraTicket) = ticketFacets(t, siteKey, emptyMap(), emptyList(), now)

    @Test fun priorityRankFoldsNamesAndAzure() {
        assertEquals(0, priorityRank("Highest"))
        assertEquals(0, priorityRank("blocker"))
        assertEquals(1, priorityRank("High"))
        assertEquals(1, priorityRank("P2"))
        assertEquals(2, priorityRank("Medium"))
        assertEquals(3, priorityRank("Low"))
        assertEquals(4, priorityRank("Lowest"))
        assertTrue(priorityRank("Whatever") > priorityRank("Lowest"))
        assertTrue(priorityRank("") > priorityRank("Whatever"))
    }

    @Test fun facetsCoverRepoEpicDepsDueUpdated() {
        val f = facets(tk(labels = listOf("api", "ui"), epicKey = "XERK-9", blockedBy = listOf("X-2"),
            blocks = listOf("X-3"), dueDate = "2026-10-01", updated = hoursAgo(30)))
        assertEquals(listOf("api", "ui"), f["label"])
        assertEquals(listOf("Turma"), f["repo"])
        assertEquals(listOf("XERK-9"), f["epic"])
        assertEquals(listOf("none"), f["session"])
        assertEquals(listOf("blocked", "blocking"), f["deps"])
        assertEquals(listOf("has", "overdue"), f["due"])
        assertEquals(listOf("7d", "30d"), f["updated"])

        val g = facets(tk(repoGuess = RepoGuess(repo = null), dueDate = "2026-10-06"))
        assertEquals(listOf("-none"), g["repo"])
        assertEquals(listOf("-none"), g["epic"])
        assertEquals(listOf("has", "week"), g["due"])
        assertEquals(listOf("24h", "7d", "30d"), g["updated"])

        val h = facets(tk(repoGuess = null, dueDate = "2026-11-30"))
        assertEquals(listOf("-untriaged"), h["repo"])
        assertEquals(listOf("has"), h["due"])
        assertEquals(listOf("none"), facets(tk())["due"])
    }

    @Test fun jiraOffsetTimestampsCountForUpdated() {
        // Jira ships "+0000", not "+00:00" — parseIsoMs handles both.
        val jira = java.time.OffsetDateTime.ofInstant(java.time.Instant.ofEpochMilli(now - 3_600_000), java.time.ZoneOffset.UTC)
            .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSZ"))
        assertEquals(listOf("24h", "7d", "30d"), facets(tk(updated = jira))["updated"])
    }

    @Test fun sessionFacetReadsIndexThenQueue() {
        val t = tk(key = "XERK-5")
        val ses = TicketSession("h", "s1", "t1", "running", "", "", "", false, "", "XERK-5", siteKey)
        val idx = mapOf(siteKey + "\u0000XERK-5" to listOf(ses))
        val q = listOf(QueuedTicket(siteKey = siteKey, issueKey = "XERK-5"))
        assertEquals(listOf("running"), ticketFacets(t, siteKey, idx, null, now)["session"])
        assertEquals(listOf("queued"), ticketFacets(t, siteKey, emptyMap(), q, now)["session"])
        assertEquals(listOf("running"), ticketFacets(t, siteKey, idx, q, now)["session"])
        assertEquals(listOf("none"), ticketFacets(t, "other", emptyMap(), q, now)["session"])
    }

    @Test fun killedOrEndedSessionIsNotRunning() {
        val t = tk(key = "XERK-5")
        fun ses(status: String) = TicketSession("h", "s", "t", status, "", "", "", false, "", "XERK-5", siteKey)
        fun idx(vararg st: String) = mapOf(siteKey + "\u0000XERK-5" to st.map { ses(it) })
        fun sess(i: Map<String, List<TicketSession>>, q: List<QueuedTicket>? = null) =
            ticketFacets(t, siteKey, i, q, now)["session"]
        assertEquals(listOf("none"), sess(idx("stopped")))
        assertEquals(listOf("running"), sess(idx("stopped", "running")))
        assertEquals(listOf("queued"), sess(idx("queued")))
        assertEquals(listOf("queued"), sess(idx("stopped"), listOf(QueuedTicket(siteKey = siteKey, issueKey = "XERK-5"))))
    }

    @Test fun dueUsesLocalDayNotUtc() {
        val prev = java.util.TimeZone.getDefault()
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("America/Los_Angeles"))
        try {
            val at = java.time.Instant.parse("2026-10-03T01:00:00Z").toEpochMilli()
            assertEquals(listOf("has", "week"), ticketFacets(tk(dueDate = "2026-10-02"), siteKey, emptyMap(), null, at)["due"])
            assertEquals(listOf("has", "overdue"), ticketFacets(tk(dueDate = "2026-10-01"), siteKey, emptyMap(), null, at)["due"])
        } finally {
            java.util.TimeZone.setDefault(prev)
        }
    }

    @Test fun searchIsSubstringExceptExactKey() {
        val t = tk(key = "XERK-12", summary = "Webhook retry storm", labels = listOf("api"), epicKey = "XERK-900")
        assertTrue(ticketSearchMatch(t, "webhook"))
        assertTrue(ticketSearchMatch(t, "  RETRY "))
        assertTrue(ticketSearchMatch(t, "api"))
        assertTrue(ticketSearchMatch(t, "turma"))
        assertTrue(ticketSearchMatch(t, ""))
        assertTrue(ticketSearchMatch(t, "xerk-12"))
        assertFalse(ticketSearchMatch(tk(key = "XERK-120"), "XERK-12"))
        assertFalse(ticketSearchMatch(t, "XERK-900"))
        assertFalse(ticketSearchMatch(t, "nothing-like-it"))
    }

    @Test fun matchesOrWithinAndAcross() {
        val bug = tk(key = "A-1", type = "Bug", priority = "High", labels = listOf("api"))
        val story = tk(key = "A-2", type = "Story", priority = "Low", labels = listOf("ui"))
        fun m(t: JiraTicket, f: Map<String, List<String>>, q: String = "") =
            boardViewMatches(t, siteKey, BoardView(q = q, f = f), emptyMap(), emptyList(), now)
        assertTrue(m(bug, mapOf("type" to listOf("Bug", "Story"))) && m(story, mapOf("type" to listOf("Bug", "Story"))))
        assertTrue(m(bug, mapOf("type" to listOf("Bug"), "priority" to listOf("High"))))
        assertFalse(m(story, mapOf("type" to listOf("Story"), "priority" to listOf("High"))))
        assertFalse(m(bug, mapOf("type" to listOf("Bug")), "zzz"))
        assertTrue(m(bug, mapOf("label" to listOf("api", "nope"))))
        assertTrue(m(bug, mapOf("type" to emptyList())))
    }

    @Test fun activeIgnoresSortAndDone() {
        assertFalse(boardViewActive(BoardView()))
        assertFalse(boardViewActive(BoardView(sort = "key", rev = true, hideDone = true)))
        assertFalse(boardViewActive(BoardView(q = "  ")))
        assertTrue(boardViewActive(BoardView(q = "x")))
        val v = BoardView(f = mapOf("type" to listOf("Bug"), "label" to emptyList(), "priority" to listOf("High", "Low")))
        assertTrue(boardViewActive(v))
        assertEquals(2, boardViewFilterCount(v))
    }

    @Test fun sortPinsEpicsAndBreaksTiesOnUpdated() {
        val epic = tk(key = "E-1", isEpic = true, type = "Epic", priority = "Lowest", updated = hoursAgo(500))
        val a = tk(key = "X-10", priority = "High", type = "Bug", updated = hoursAgo(5), created = hoursAgo(50), dueDate = "2026-10-09")
        val b = tk(key = "X-9", priority = "Highest", type = "Task", updated = hoursAgo(1), created = hoursAgo(90))
        val c = tk(key = "X-100", priority = "Low", type = "Story", updated = hoursAgo(3), created = hoursAgo(10), dueDate = "2026-10-03")
        fun order(sort: String, rev: Boolean = false) =
            listOf(c, epic, a, b).sortedWith(boardViewComparator(BoardView(sort = sort, rev = rev))).map { it.key }
        assertEquals(listOf("E-1", "X-9", "X-100", "X-10"), order("updated"))
        assertEquals(listOf("E-1", "X-10", "X-100", "X-9"), order("updated", true))
        assertEquals(listOf("E-1", "X-100", "X-10", "X-9"), order("created"))
        assertEquals(listOf("E-1", "X-9", "X-10", "X-100"), order("priority"))
        assertEquals(listOf("E-1", "X-100", "X-10", "X-9"), order("priority", true))
        assertEquals(listOf("E-1", "X-100", "X-10", "X-9"), order("due"))
        assertEquals(listOf("E-1", "X-10", "X-100", "X-9"), order("due", true))
        assertEquals(listOf("E-1", "X-9", "X-10", "X-100"), order("key"))
        assertEquals(listOf("E-1", "X-100", "X-10", "X-9"), order("key", true))
        assertEquals(listOf("E-1", "X-10", "X-100", "X-9"), order("type"))
        assertEquals(order("updated"), order("bogus"))
        // The default sort is TICKET_ORDER's rule.
        assertEquals(listOf(c, epic, a, b).sortedWith(TICKET_ORDER).map { it.key }, order("updated"))
    }

    @Test fun groupsCountOrderAndKeepStaleSelection() {
        val tickets = listOf(
            tk(key = "A-1", type = "Bug", priority = "Low", labels = listOf("api", "ui")),
            tk(key = "A-2", type = "Bug", priority = "Highest", labels = listOf("api"), epicKey = "A-9"),
            tk(key = "A-3", type = "Story", priority = "High", repoGuess = null),
            tk(key = "A-9", type = "Epic", isEpic = true, summary = "Big push"),
        )
        val view = BoardView(f = mapOf("type" to listOf("Bug"), "label" to listOf("gone")))
        val groups = boardFilterGroups(listOf(site(tickets)), view, emptyMap(), emptyList(), now)
        assertEquals(FILTER_FIELDS.map { it.first }, groups.map { it.field })
        fun g(field: String) = groups.first { it.field == field }.options
        assertEquals(listOf(Triple("Bug", 2, true), Triple("Epic", 1, false), Triple("Story", 1, false)),
            g("type").map { Triple(it.value, it.count, it.selected) })
        assertEquals(listOf("Highest", "High", "Medium", "Low"), g("priority").map { it.value })
        assertEquals(listOf("api" to 2, "ui" to 1, "gone" to 0), g("label").map { it.value to it.count })
        assertEquals(listOf("Turma", "untriaged"), g("repo").map { it.label })
        assertEquals(listOf("A-9 · Big push", "No epic"), g("epic").map { it.label })
        assertEquals(listOf("none"), g("session").map { it.value })
    }

    @Test fun hiddenDoneTicketsDontCount() {
        val tickets = listOf(
            tk(key = "A-1", type = "Bug"),
            tk(key = "A-2", type = "Bug", statusCategory = "done"),
            tk(key = "A-3", type = "Story", statusCategory = "done"),
        )
        fun type(v: BoardView) = boardFilterGroups(listOf(site(tickets)), v, emptyMap(), emptyList(), now)
            .first { it.field == "type" }.options.map { it.value to it.count }
        assertEquals(listOf("Bug" to 2, "Story" to 1), type(BoardView()))
        assertEquals(listOf("Bug" to 1), type(BoardView(hideDone = true)))
    }

    @Test fun toggleAddsAndRemoves() {
        val v1 = toggleBoardFilter(BoardView(), "type", "Bug")
        assertEquals(mapOf("type" to listOf("Bug")), v1.f)
        val v2 = toggleBoardFilter(v1, "type", "Story")
        assertEquals(listOf("Bug", "Story"), v2.f["type"])
        assertEquals(emptyMap<String, List<String>>(), toggleBoardFilter(v1, "type", "Bug").f)
    }

    @Test fun storedViewRoundTripsAndDropsJunk() {
        val v = boardViewFromParams(listOf(
            "q" to "api", "type" to "Bug", "type" to "Story", "type" to "Bug", "sort" to "priority",
            "rev" to "1", "done" to "0", "nope" to "1", "label" to "",
        ))
        assertEquals(BoardView(q = "api", f = mapOf("type" to listOf("Bug", "Story")), sort = "priority", rev = true, hideDone = true), v)
        assertEquals(v, decodeBoardView(encodeBoardView(v)))
        assertEquals(emptyList<Pair<String, String>>(), boardViewToParams(BoardView()))
        assertEquals("updated", boardViewFromParams(listOf("sort" to "evil")).sort)
        assertEquals(200, boardViewFromParams(listOf("q" to "x".repeat(500))).q.length)
        assertEquals(50, boardViewFromParams((0 until 80).map { "label" to "l$it" }).f["label"]!!.size)
        assertEquals(null, boardViewFromParams(listOf("label" to "y".repeat(201))).f["label"])
        assertEquals(BoardView(), decodeBoardView(null))
        assertEquals(BoardView(), decodeBoardView("%%%garbage"))
        // Values with separators survive the encoding.
        val odd = BoardView(q = "a&b=c d", f = mapOf("label" to listOf("x&y")))
        assertEquals(odd, decodeBoardView(encodeBoardView(odd)))
    }
}
