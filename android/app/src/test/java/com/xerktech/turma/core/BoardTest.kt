package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.JiraBlock
import com.xerktech.turma.model.JiraTicket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parity with turma/public/board.js (mergeSites + categoryOf). */
class BoardTest {

    private fun ticket(key: String, cat: String = "todo", status: String = "", updated: String = "") =
        JiraTicket(key = key, statusCategory = cat, status = status, updated = updated)

    private fun agent(key: String, online: Boolean, jira: JiraBlock?) =
        AgentInfo(key = key, online = online, jira = jira)

    @Test fun `unknown status category lands in todo`() {
        assertEquals("todo", categoryOf(ticket("A", "")))
        assertEquals("todo", categoryOf(ticket("A", "weird")))
        assertEquals("inprogress", categoryOf(ticket("A", "inprogress")))
        assertEquals("done", categoryOf(ticket("A", "done")))
    }

    @Test fun `in review is carved out of inprogress by status name`() {
        // The four cross-org columns include In Review between In Progress and Done.
        assertEquals(listOf("todo", "inprogress", "review", "done"), BOARD_CATEGORIES.map { it.first })
        // Only an inprogress ticket whose status name reads as review/testing moves.
        assertEquals("review", categoryOf(ticket("A", "inprogress", status = "In Review")))
        assertEquals("review", categoryOf(ticket("A", "inprogress", status = "Code Review")))
        assertEquals("review", categoryOf(ticket("A", "inprogress", status = "Testing")))
        assertEquals("review", categoryOf(ticket("A", "inprogress", status = "QA")))
        // A plain in-progress status stays put.
        assertEquals("inprogress", categoryOf(ticket("A", "inprogress", status = "In Progress")))
        // Word-boundary: "Attestation"/"Contest" must not leak in.
        assertEquals("inprogress", categoryOf(ticket("A", "inprogress", status = "Attestation")))
        assertEquals("inprogress", categoryOf(ticket("A", "inprogress", status = "Contest")))
        // A Done or To Do ticket keeps its category whatever its name says.
        assertEquals("done", categoryOf(ticket("A", "done", status = "Testing complete")))
        assertEquals("todo", categoryOf(ticket("A", "todo", status = "Ready for review")))
    }

    @Test fun `ticketSort orders by updated descending`() {
        val a = ticket("A", updated = "2026-07-16T01:00:00Z")
        val b = ticket("B", updated = "2026-07-16T05:00:00Z")
        val c = ticket("C", updated = "2026-07-16T03:00:00Z")
        assertEquals(listOf("B", "C", "A"), ticketSort(listOf(a, b, c)).map { it.key })
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

    @Test fun `org colors are unique and match the web assignment (XERK-48)`() {
        // A collision-free set: every org keeps its preferred slot, all distinct.
        // Locked to the exact slots board.js `orgColorMap` produces (slot = --sN-1),
        // so an org paints the identical color on web and Android.
        val four = listOf(
            "alpha.atlassian.net", "beta.atlassian.net", "gamma.atlassian.net", "delta.atlassian.net",
        )
        val m = orgColorMap(four)
        assertEquals(4, m.values.toSet().size)  // no two orgs share a color
        assertEquals(6, m["alpha.atlassian.net"])  // --s7
        assertEquals(4, m["beta.atlassian.net"])   // --s5
        assertEquals(3, m["gamma.atlassian.net"])  // --s4
        assertEquals(2, m["delta.atlassian.net"])  // --s3
    }

    @Test fun `colliding preferred slots resolve to distinct colors`() {
        // "a.net" and "gamma.atlassian.net" both prefer slot 3; the probe gives
        // the second the next free slot rather than overlapping.
        val m = orgColorMap(listOf("gamma.atlassian.net", "a.net"))
        assertTrue(m["a.net"] != m["gamma.atlassian.net"])
        assertEquals(3, m["a.net"])       // --s4
        assertEquals(4, m["gamma.atlassian.net"])  // --s5
    }

    @Test fun `org colors are order-independent and stable for non-colliding fleet changes`() {
        val four = listOf(
            "alpha.atlassian.net", "beta.atlassian.net", "gamma.atlassian.net", "delta.atlassian.net",
        )
        val a = orgColorMap(four)
        assertEquals(a, orgColorMap(four.reversed()))
        // Adding a non-colliding org leaves the rest put; removing one likewise.
        val withC = orgColorMap(four + "c.net")
        for (k in four) assertEquals(a[k], withC[k])
        assertEquals(5, withC["c.net"])  // --s6
        val withoutAlpha = orgColorMap(four.filter { it != "alpha.atlassian.net" })
        for (k in four) if (k != "alpha.atlassian.net") assertEquals(a[k], withoutAlpha[k])
    }

    @Test fun `more orgs than colors degrades to reuse without throwing`() {
        val many = (0 until 12).map { "s$it.atlassian.net" }
        val m = orgColorMap(many)
        assertEquals(12, m.size)
        for (v in m.values) assertTrue(v in 0..7)
        assertEquals(8, m.values.toSet().size)  // uses all 8, overflow reuses
    }

    @Test fun `orgColorIndex agrees with the map and falls back without a set`() {
        val four = listOf(
            "alpha.atlassian.net", "beta.atlassian.net", "gamma.atlassian.net", "delta.atlassian.net",
        )
        assertEquals(orgColorMap(four)["gamma.atlassian.net"], orgColorIndex("gamma.atlassian.net", four))
        assertTrue(orgColorIndex("x.atlassian.net", emptyList()) in 0..7)
    }

    @Test fun `org name strips the atlassian net suffix`() {
        assertEquals("xerktech", orgName("xerktech.atlassian.net"))
        assertEquals("self-hosted.example.com", orgName("self-hosted.example.com"))
    }

    @Test fun `org name takes the last path segment for azure devops`() {
        assertEquals("myorg", orgName("dev.azure.com/myorg"))
        assertEquals("defaultcollection", orgName("tfs.company.com/tfs/defaultcollection"))
    }

    @Test fun `the operator's org name override wins over the derived name`() {
        // Locked to board.js orgName: a self-hosted collection otherwise derives
        // to a deployment detail rather than the org.
        assertEquals("Acme", orgName("tfs.company.com/tfs/defaultcollection", "Acme"))
        assertEquals("Acme Corp", orgName("myorg.atlassian.net", "Acme Corp"))
        assertEquals("Padded", orgName("dev.azure.com/myorg", "  Padded  "))
        // Blank falls back rather than blanking the chip (an agent predating the
        // field, or BOARD_ORG_NAME unset, reports "").
        assertEquals("myorg", orgName("dev.azure.com/myorg", ""))
        assertEquals("myorg", orgName("dev.azure.com/myorg", "   "))
        assertEquals("myorg", orgName("dev.azure.com/myorg"))
    }

    @Test fun `merge sites carries the org name override off the freshest block`() {
        fun at(t: String, org: String) = AgentInfo(
            key = "h$t", device = "h$t", online = true,
            jira = JiraBlock(siteKey = "tfs.co/tfs/coll", user = "u", fetchedAt = t,
                orgName = org, tickets = emptyList()),
        )
        assertEquals("New", mergeSites(listOf(at("2026-01-01", "Old"), at("2026-02-01", "New")))[0].orgName)
        assertEquals("", mergeSites(listOf(at("2026-01-01", "")))[0].orgName)
    }

    private fun site(key: String) = BoardSite(
        siteKey = key, site = key, online = true, error = null, fetchedAt = "", tickets = emptyList(),
    )

    @Test fun `blank filter keeps every site`() {
        val sites = listOf(site("a"), site("b"))
        assertEquals(sites, filterSites(sites, ""))
    }

    @Test fun `a matching filter keeps only that org`() {
        val sites = listOf(site("a"), site("b"))
        assertEquals(listOf("b"), filterSites(sites, "b").map { it.siteKey })
    }

    @Test fun `a filter naming an org that stopped reporting falls back to all`() {
        val sites = listOf(site("a"), site("b"))
        assertEquals(sites, filterSites(sites, "gone"))
    }

    // ---- ticket -> agent pin (XERK-38): parity with board.js hostOptions/agentPinOf

    @Test fun `mergeSites collects the org's hosts as picker options, online first`() {
        // Collected over EVERY reporting host, not the freshest-block winners —
        // both hosts poll as the same user, so only one block survives the merge,
        // yet the picker must offer both.
        val a = agent("hostB", false, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T02:00:00Z"))
        val b = agent("hostA", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
        val sites = mergeSites(listOf(a, b))
        assertEquals(
            listOf(
                HostOption("hostA", "hostA", true),
                HostOption("hostB", "hostB", false),
            ),
            sites[0].hostOptions,
        )
    }

    @Test fun `agentPinOf reads the hub's siteKey-issueKey-keyed map`() {
        val ta = mapOf("org.atlassian.net/X-1" to com.xerktech.turma.model.TicketAgentPin(host = "hostA", at = 1))
        assertEquals("hostA", agentPinOf(ta, "org.atlassian.net", "X-1")?.host)
        assertEquals(null, agentPinOf(ta, "org.atlassian.net", "X-2"))
        // A malformed entry (blank host) is no pin, not a crash.
        assertEquals(null, agentPinOf(mapOf("s/X-1" to com.xerktech.turma.model.TicketAgentPin()), "s", "X-1"))
    }

    @Test fun `autoStartOn reads the hub-only per-org opt-in`() {
        val site = "acme.atlassian.net"
        // Off unless the hub toggle names the org.
        assertEquals(false, autoStartOn(emptyMap(), site))
        assertEquals(true, autoStartOn(mapOf(site to true), site))
        // Another org's entry doesn't leak across siteKeys.
        assertEquals(false, autoStartOn(mapOf(site to true), "other.atlassian.net"))
    }
}
