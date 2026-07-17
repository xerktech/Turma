package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.JiraBlock
import com.xerktech.turma.model.JiraTicket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parity with turma/public/board.js (mergeSites + categoryOf). */
class BoardTest {

    private fun ticket(key: String, cat: String = "todo") =
        JiraTicket(key = key, statusCategory = cat)

    private fun agent(key: String, online: Boolean, jira: JiraBlock?) =
        AgentInfo(key = key, online = online, jira = jira)

    @Test fun `unknown status category lands in todo`() {
        assertEquals("todo", categoryOf(ticket("A", "")))
        assertEquals("todo", categoryOf(ticket("A", "weird")))
        assertEquals("inprogress", categoryOf(ticket("A", "inprogress")))
        assertEquals("done", categoryOf(ticket("A", "done")))
    }

    @Test fun `two users on one site union their tickets, deduped by key`() {
        val a1 = agent("h1", true, JiraBlock(siteKey = "org", site = "org.atlassian.net", user = "u1", fetchedAt = "2026-07-16T01:00:00Z", tickets = listOf(ticket("X-1"), ticket("X-2"))))
        val a2 = agent("h2", false, JiraBlock(siteKey = "org", user = "u2", fetchedAt = "2026-07-16T02:00:00Z", tickets = listOf(ticket("X-2"), ticket("X-3"))))
        val sites = mergeSites(listOf(a1, a2))
        assertEquals(1, sites.size)
        val keys = sites[0].tickets.map { it.key }.toSet()
        assertEquals(setOf("X-1", "X-2", "X-3"), keys)
        assertEquals(3, sites[0].tickets.size) // X-2 deduped
    }

    @Test fun `site is online when any reporting host is online`() {
        val a1 = agent("h1", false, JiraBlock(siteKey = "org", user = "u1", fetchedAt = "2026-07-16T01:00:00Z"))
        val a2 = agent("h2", true, JiraBlock(siteKey = "org", user = "u1", fetchedAt = "2026-07-16T02:00:00Z"))
        assertTrue(mergeSites(listOf(a1, a2)).single().online)
    }

    @Test fun `freshest block wins for a repeated (site, user)`() {
        val stale = agent("h1", true, JiraBlock(siteKey = "org", user = "u1", fetchedAt = "2026-07-16T01:00:00Z", tickets = listOf(ticket("OLD"))))
        val fresh = agent("h2", true, JiraBlock(siteKey = "org", user = "u1", fetchedAt = "2026-07-16T05:00:00Z", tickets = listOf(ticket("NEW"))))
        val site = mergeSites(listOf(stale, fresh)).single()
        assertEquals(listOf("NEW"), site.tickets.map { it.key })
        assertEquals("2026-07-16T05:00:00Z", site.fetchedAt)
    }

    @Test fun `agents with no jira or blank siteKey are ignored`() {
        val none = agent("h1", true, null)
        val blank = agent("h2", true, JiraBlock(siteKey = "", tickets = listOf(ticket("Z"))))
        assertTrue(mergeSites(listOf(none, blank)).isEmpty())
    }

    @Test fun `org color index is stable and sorted`() {
        val keys = listOf("b.net", "a.net", "c.net")
        assertEquals(0, orgColorIndex("a.net", keys))
        assertEquals(1, orgColorIndex("b.net", keys))
        assertEquals(2, orgColorIndex("c.net", keys))
    }
}
