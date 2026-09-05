package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.CreateMetaEnvelope
import com.xerktech.turma.model.CreateProject
import com.xerktech.turma.model.CreateResultEnvelope
import com.xerktech.turma.model.CreateType
import com.xerktech.turma.model.JiraBlock
import com.xerktech.turma.model.JiraIssueDetail
import com.xerktech.turma.model.JiraIssueEnvelope
import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.model.RepoOption
import com.xerktech.turma.model.StatusOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test fun `azure devops states land in the columns the board names`() {
        // XERK-250: ADO's New / Active / Resolved / Closed / Removed. Resolved
        // reaches the client as `inprogress` and is placed by name, like Jira's
        // review statuses; the other four are already category-placed.
        assertEquals("todo", categoryOf(ticket("A", "todo", status = "New")))
        assertEquals("inprogress", categoryOf(ticket("A", "inprogress", status = "Active")))
        assertEquals("review", categoryOf(ticket("A", "inprogress", status = "Resolved")))
        assertEquals("done", categoryOf(ticket("A", "done", status = "Closed")))
        assertEquals("done", categoryOf(ticket("A", "done", status = "Removed")))
        // A Jira "Resolved" is normally a done status and stays in Done.
        assertEquals("done", categoryOf(ticket("A", "done", status = "Resolved")))
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

    @Test fun `XERK-325 - an ONLINE host's block outranks a fresher offline one`() {
        // The card and the hub must resolve a ticket the same way: ticketRepo
        // prefers an online host and routing reaches only one, so an offline host
        // winning on freshness put a repo on the chip Start would never spawn
        // against. Mirrors board.js mergeSites.
        val down = agent("down", false, JiraBlock(siteKey = "org", user = "u1",
            fetchedAt = "2026-07-16T05:00:00Z",
            tickets = listOf(JiraTicket(key = "T-1", statusCategory = "todo",
                repoGuess = com.xerktech.turma.model.RepoGuess(repo = "Veiller", cloned = true)))))
        val up = agent("up", true, JiraBlock(siteKey = "org", user = "u1",
            fetchedAt = "2026-07-16T01:00:00Z",
            tickets = listOf(JiraTicket(key = "T-1", statusCategory = "todo",
                repoGuess = com.xerktech.turma.model.RepoGuess(repo = "Turma", cloned = true)))))
        val t = mergeSites(listOf(down, up)).single().tickets.single()
        assertEquals("Turma", t.repoGuess?.repo)
    }

    @Test fun `XERK-325 - online is a tier, so freshness still decides between two live hosts`() {
        val older = agent("h1", true, JiraBlock(siteKey = "org", user = "u1",
            fetchedAt = "2026-07-16T01:00:00Z", tickets = listOf(ticket("OLD"))))
        val newer = agent("h2", true, JiraBlock(siteKey = "org", user = "u1",
            fetchedAt = "2026-07-16T05:00:00Z", tickets = listOf(ticket("NEW"))))
        assertEquals(listOf("NEW"), mergeSites(listOf(older, newer)).single().tickets.map { it.key })
    }

    @Test fun `XERK-325 - an all-offline org still shows its tickets`() {
        // A preference, not a filter: a board whose hosts are all down shows
        // what was last known rather than going blank.
        val down = agent("down", false, JiraBlock(siteKey = "org", user = "u1",
            fetchedAt = "2026-07-16T01:00:00Z", tickets = listOf(ticket("T-1"))))
        assertEquals(listOf("T-1"), mergeSites(listOf(down)).single().tickets.map { it.key })
    }

    @Test fun `XERK-325 - lastFetched is the MAX across winners, not the winner's own`() {
        // board.js takes the max; taking the winner's own stamp was equivalent
        // only while the sort was freshest-first. With online outranking
        // freshness the winner can be the OLDER block, which understated how
        // current the board is.
        val onlineOld = agent("alice", true, JiraBlock(siteKey = "org", user = "alice",
            fetchedAt = "2026-08-18T09:00:00.000Z", tickets = listOf(ticket("A-1"))))
        val offlineNew = agent("bob", false, JiraBlock(siteKey = "org", user = "bob",
            fetchedAt = "2026-08-18T10:00:00.000Z", tickets = listOf(ticket("B-1"))))
        val site = mergeSites(listOf(onlineOld, offlineNew)).single()
        assertEquals("2026-08-18T10:00:00.000Z", site.fetchedAt)
        // The online block still owns the single-valued fields and wins ties.
        assertEquals(setOf("A-1", "B-1"), site.tickets.map { it.key }.toSet())
    }

    // ---- XERK-235: divergences from board.js found by a QA parity audit ----

    @Test fun `ticket dedupe keeps the freshest UPDATED, not the freshest block`() {
        // First-wins over blocks sorted by fetchedAt showed the stale summary
        // and the stale column whenever two users polled one site and the
        // fresher BLOCK carried the older TICKET (board.js keeps the newer
        // t.updated).
        val a1 = agent("h1", true, JiraBlock(
            siteKey = "org", user = "u1", fetchedAt = "2026-08-08T12:00:00Z",
            tickets = listOf(JiraTicket(key = "P-1", statusCategory = "todo",
                summary = "OLD", updated = "2026-08-01T00:00:00Z")),
        ))
        val a2 = agent("h2", true, JiraBlock(
            siteKey = "org", user = "u2", fetchedAt = "2026-08-08T11:00:00Z",
            tickets = listOf(JiraTicket(key = "P-1", statusCategory = "inprogress",
                summary = "NEW", updated = "2026-08-08T00:00:00Z")),
        ))
        val t = mergeSites(listOf(a1, a2)).single().tickets.single()
        assertEquals("NEW", t.summary)
        assertEquals("inprogress", t.statusCategory)
    }

    @Test fun `repoOptions union every host of the org, cloned first`() {
        // Taking only the freshest block's list meant the picker offered
        // whichever host polled Jira last, and a repo cloned only on the other
        // vanished from the dropdown.
        val a1 = agent("h1", true, JiraBlock(
            siteKey = "org", user = "u1", fetchedAt = "2026-08-08T12:00:00Z",
            repoOptions = listOf(RepoOption(name = "zeta", cloned = false)),
        ))
        val a2 = agent("h2", true, JiraBlock(
            siteKey = "org", user = "u2", fetchedAt = "2026-08-08T11:00:00Z",
            repoOptions = listOf(RepoOption(name = "alpha", cloned = true)),
        ))
        val opts = mergeSites(listOf(a1, a2)).single().repoOptions
        assertEquals(listOf("alpha", "zeta"), opts.map { it.name })
    }

    @Test fun `repoOptions union hosts polling as the SAME tracker user`() {
        // The case board.js calls the common one, and the case the two tests
        // around this one cannot see: they use different `user`s, so byUser keeps
        // both blocks and the union appears to work wherever it is collected.
        // With one user, byUser keeps ONE block — so collecting the union from
        // the winners dropped every repo cloned on any other host (XERK-235).
        val a1 = agent("h1", true, JiraBlock(
            siteKey = "org", user = "mal@acme.io", fetchedAt = "2026-08-08T12:00:00Z",
            repoOptions = listOf(RepoOption(name = "only-on-A", cloned = true)),
        ))
        val a2 = agent("h2", true, JiraBlock(
            siteKey = "org", user = "mal@acme.io", fetchedAt = "2026-08-08T13:00:00Z",
            repoOptions = listOf(RepoOption(name = "only-on-B", cloned = true)),
        ))
        val opts = mergeSites(listOf(a1, a2)).single().repoOptions
        assertEquals(listOf("only-on-A", "only-on-B"), opts.map { it.name }.sorted())
    }

    @Test fun `picker ordering is case-insensitive, as board_js localeCompare is`() {
        // board.js sorts with localeCompare; ordinal compareTo put every
        // capitalised repo ahead of every lowercase one, so the two pickers
        // listed the same repos in a different order (XERK-235).
        val a = agent("h1", true, JiraBlock(
            siteKey = "org", user = "u1", fetchedAt = "2026-08-08T12:00:00Z",
            repoOptions = listOf(
                RepoOption(name = "Turma", cloned = true),
                RepoOption(name = "agent-notes", cloned = true),
                RepoOption(name = "DockerOps", cloned = true),
            ),
        ))
        assertEquals(
            listOf("agent-notes", "DockerOps", "Turma"),
            mergeSites(listOf(a)).single().repoOptions.map { it.name },
        )
    }

    @Test fun `a cloned copy wins the repoOptions dedupe`() {
        val a1 = agent("h1", true, JiraBlock(
            siteKey = "org", user = "u1", fetchedAt = "2026-08-08T12:00:00Z",
            repoOptions = listOf(RepoOption(name = "r", cloned = false)),
        ))
        val a2 = agent("h2", true, JiraBlock(
            siteKey = "org", user = "u2", fetchedAt = "2026-08-08T11:00:00Z",
            repoOptions = listOf(RepoOption(name = "r", cloned = true)),
        ))
        assertTrue(mergeSites(listOf(a1, a2)).single().repoOptions.single().cloned)
    }

    @Test fun `ageStr reads Jira Cloud's basic-format offset, not just Zulu`() {
        // Instant.parse rejects `+0000`, which is exactly how Jira Cloud stamps
        // `updated` — so every Jira ticket's age chip rendered blank, while
        // Azure's Zulu timestamps worked. That is why Azure-only testing never
        // saw it. Date.parse (the web) accepts both.
        val now = java.time.Instant.parse("2026-08-08T12:40:00Z").toEpochMilli()
        assertEquals("5m", ageStr("2026-08-08T12:34:56.789+0000", now))
        assertEquals("5m", ageStr("2026-08-08T12:34:56Z", now))
        assertEquals("5m", ageStr("2026-08-08T12:34:56.789+00:00", now))
        assertEquals("5m", ageStr("2026-08-08T13:34:56.789+0100", now))
        assertEquals("", ageStr("not a date", now))
        assertEquals("", ageStr("", now))
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

    @Test fun `a manual pin takes exactly its slot and autos probe around it`() {
        // Locked to the board.test.js XERK-145 vectors (wire slot 1..8 -> 0-based).
        val four = listOf(
            "alpha.atlassian.net", "beta.atlassian.net", "gamma.atlassian.net", "delta.atlassian.net",
        )
        val m = orgColorMap(four, mapOf("gamma.atlassian.net" to 1))
        assertEquals(0, m["gamma.atlassian.net"])  // --s1, the pin
        assertEquals(6, m["alpha.atlassian.net"])  // the rest keep their hash slots
        assertEquals(4, m["beta.atlassian.net"])
        assertEquals(2, m["delta.atlassian.net"])
        // An auto org whose preferred slot is pinned away probes to the next free.
        val m2 = orgColorMap(listOf("a.net", "beta.atlassian.net"), mapOf("beta.atlassian.net" to 4))
        assertEquals(3, m2["beta.atlassian.net"])  // --s4, the pin
        assertEquals(4, m2["a.net"])               // --s5, probed past it
    }

    @Test fun `two orgs pinned to one slot share it - the operator's explicit choice`() {
        val m = orgColorMap(
            listOf("alpha.atlassian.net", "beta.atlassian.net"),
            mapOf("alpha.atlassian.net" to 2, "beta.atlassian.net" to 2),
        )
        assertEquals(1, m["alpha.atlassian.net"])
        assertEquals(1, m["beta.atlassian.net"])
    }

    @Test fun `a malformed pin is ignored`() {
        val four = listOf(
            "alpha.atlassian.net", "beta.atlassian.net", "gamma.atlassian.net", "delta.atlassian.net",
        )
        val clean = orgColorMap(four)
        for (bad in listOf(0, 9, -1)) {
            assertEquals(clean, orgColorMap(four, mapOf("gamma.atlassian.net" to bad)))
        }
    }

    @Test fun `orgColorIndex honors a pin with and without the full set`() {
        val four = listOf(
            "alpha.atlassian.net", "beta.atlassian.net", "gamma.atlassian.net", "delta.atlassian.net",
        )
        val pins = mapOf("gamma.atlassian.net" to 1)
        assertEquals(0, orgColorIndex("gamma.atlassian.net", four, pins))
        assertEquals(0, orgColorIndex("gamma.atlassian.net", emptyList(), pins))
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

    @Test fun `empty filter keeps every site`() {
        val sites = listOf(site("a"), site("b"))
        assertEquals(sites, filterSites(sites, emptySet()))
    }

    @Test fun `a matching filter keeps only the selected orgs`() {
        val sites = listOf(site("a"), site("b"), site("c"))
        assertEquals(listOf("b"), filterSites(sites, setOf("b")).map { it.siteKey })
        // Multi-select (XERK-222): every selected org's site shows.
        assertEquals(listOf("a", "c"), filterSites(sites, setOf("a", "c")).map { it.siteKey })
    }

    @Test fun `a filter naming only orgs that stopped reporting falls back to all`() {
        val sites = listOf(site("a"), site("b"))
        assertEquals(sites, filterSites(sites, setOf("gone")))
        // A gone key beside a live one is simply ignored.
        assertEquals(listOf("a"), filterSites(sites, setOf("gone", "a")).map { it.siteKey })
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

    // ---- ticket -> model pin (XERK-123): parity with board.js models/modelPinOf

    @Test fun `mergeSites unions the org's probed models with the freshest default`() {
        val a = agent("hostA", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
            .copy(models = com.xerktech.turma.model.ModelsInfo(
                available = listOf("opus", "sonnet", "default"), defaultLabel = "Sonnet 5",
                at = "2026-07-16T11:00:00Z"))
        val b = agent("hostB", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T02:00:00Z"))
            .copy(models = com.xerktech.turma.model.ModelsInfo(
                available = listOf("haiku", "opus[1m]"), defaultLabel = "Haiku 4.5",
                at = "2026-07-16T12:00:00Z"))
        val site = mergeSites(listOf(a, b)).single()
        // Union across hosts, sorted, "default" dropped; the bracketed alias stays
        // in the raw list (modelChoices filters it).
        assertEquals(listOf("haiku", "opus", "opus[1m]", "sonnet"), site.models.available)
        // Default off the FRESHEST probe (hostB).
        assertEquals("Haiku 4.5", site.models.defaultLabel)
    }

    @Test fun `modelPinOf reads the hub's siteKey-issueKey-keyed map`() {
        val tm = mapOf("org.atlassian.net/X-1" to com.xerktech.turma.model.TicketModelPin(model = "opus", at = 1))
        assertEquals("opus", modelPinOf(tm, "org.atlassian.net", "X-1")?.model)
        assertEquals(null, modelPinOf(tm, "org.atlassian.net", "X-2"))
        assertEquals(null, modelPinOf(mapOf("s/X-1" to com.xerktech.turma.model.TicketModelPin()), "s", "X-1"))
    }

    @Test fun `modelChoices filters the menu to the probe, static fallback when empty`() {
        assertEquals(listOf("opus", "haiku"), modelChoices(BoardModels(available = listOf("opus", "haiku"))))
        assertEquals(listOf("opus", "fable", "sonnet", "haiku"), modelChoices(BoardModels()))
        // The bracketed live-switch-only alias is never a pin option.
        assertEquals(listOf("sonnet"), modelChoices(BoardModels(available = listOf("opus[1m]", "sonnet"))))
    }

    // ---- ticket -> runtime pin (XERK-473): parity with board.js
    // runtimePinOf/prettyRuntime + mergeSites dshAvailable ----------------------

    @Test fun `mergeSites marks dshAvailable when ANY reporting host offers dsh`() {
        // dsh ships DISABLED fleet-wide (Runtime.DSH_ENABLED = false); enable it to
        // exercise the retained mergeSites dsh-availability OR, resetting in finally
        // so the flag can't leak into the other board tests.
        Runtime.DSH_ENABLED = true
        try {
            val noDsh = agent("hostA", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
            val withDsh = agent("hostB", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T02:00:00Z"))
                .copy(dsh = com.xerktech.turma.model.DshInfo(available = true))
            // One host offering dsh makes the whole org offer it (an OR).
            assertTrue(mergeSites(listOf(noDsh, withDsh)).single().dshAvailable)
            // No host offering it (absent or available:false) leaves the org without.
            val off = agent("hostC", true, JiraBlock(siteKey = "org2", user = "u"))
                .copy(dsh = com.xerktech.turma.model.DshInfo(available = false))
            assertFalse(mergeSites(listOf(noDsh.copy(jira = JiraBlock(siteKey = "org2", user = "u")), off)).single().dshAvailable)
        } finally {
            Runtime.DSH_ENABLED = false
        }
    }

    @Test fun `runtimePinOf reads the map, treating claude and blank as no pin`() {
        val tr = mapOf(
            "org.atlassian.net/X-1" to com.xerktech.turma.model.TicketRuntimePin(runtime = "dsh", at = 1),
            "org.atlassian.net/X-2" to com.xerktech.turma.model.TicketRuntimePin(runtime = "claude", at = 1),
        )
        assertEquals("dsh", runtimePinOf(tr, "org.atlassian.net", "X-1")?.runtime)
        // "claude" is the default, so it reads as no pin — same as the web.
        assertEquals(null, runtimePinOf(tr, "org.atlassian.net", "X-2"))
        // A key nothing pinned, and a blank runtime, both read as no pin.
        assertEquals(null, runtimePinOf(tr, "org.atlassian.net", "X-9"))
        assertEquals(null, runtimePinOf(mapOf("s/X-1" to com.xerktech.turma.model.TicketRuntimePin()), "s", "X-1"))
    }

    @Test fun `prettyRuntime and runtimeEditable mirror the web`() {
        assertEquals("dsh (DeepSeek Harness)", prettyRuntime("dsh"))
        assertEquals("Claude Code", prettyRuntime("claude"))
        assertEquals("Claude Code", prettyRuntime(""))
        val pin = com.xerktech.turma.model.TicketRuntimePin(runtime = "dsh", at = 1)
        // Editable when the org offers a non-default runtime OR a pin already
        // exists (so it can be released even after the last capable host leaves).
        assertTrue(runtimeEditable(dshAvailable = true, qwenAvailable = false, pin = null))
        assertTrue(runtimeEditable(dshAvailable = false, qwenAvailable = false, pin = pin))
        assertFalse(runtimeEditable(dshAvailable = false, qwenAvailable = false, pin = null))
    }

    // ---- XERK-515 [Qwen I]: qwen is a second board runtime pin, parity with the web

    @Test fun `mergeSites marks qwenAvailable when ANY reporting host offers qwen`() {
        // The mergeSites qwen-availability OR is gated on Runtime.QWEN_ENABLED; set it
        // explicitly (reset in finally) to exercise the OR regardless of the default.
        Runtime.QWEN_ENABLED = true
        try {
            val noQwen = agent("hostA", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
            val withQwen = agent("hostB", true, JiraBlock(siteKey = "org", user = "u", fetchedAt = "2026-07-16T02:00:00Z"))
                .copy(qwen = com.xerktech.turma.model.QwenInfo(available = true))
            assertTrue(mergeSites(listOf(noQwen, withQwen)).single().qwenAvailable)
            // No host offering it leaves the org without.
            val off = agent("hostC", true, JiraBlock(siteKey = "org2", user = "u"))
                .copy(qwen = com.xerktech.turma.model.QwenInfo(available = false))
            assertFalse(mergeSites(listOf(noQwen.copy(jira = JiraBlock(siteKey = "org2", user = "u")), off)).single().qwenAvailable)
        } finally {
            Runtime.QWEN_ENABLED = false
        }
    }

    @Test fun `qwen is a non-default runtime pin like dsh, and its picker mirrors the web`() {
        val tr = mapOf(
            "org.atlassian.net/X-1" to com.xerktech.turma.model.TicketRuntimePin(runtime = "qwen", at = 1),
        )
        assertEquals("qwen", runtimePinOf(tr, "org.atlassian.net", "X-1")?.runtime)
        assertEquals("Qwen Code", prettyRuntime("qwen"))
        val qwenPin = com.xerktech.turma.model.TicketRuntimePin(runtime = "qwen", at = 1)
        // Offering qwen makes the row editable; a qwen pin stays releasable with qwen gone.
        assertTrue(runtimeEditable(dshAvailable = false, qwenAvailable = true, pin = null))
        assertTrue(runtimeEditable(dshAvailable = false, qwenAvailable = false, pin = qwenPin))
    }

    @Test fun `prettyModel capitalizes aliases and parses claude ids`() {
        assertEquals("Opus", prettyModel("opus"))
        assertEquals("Opus 4.8", prettyModel("claude-opus-4-8"))
        assertEquals("Fable 5 1M", prettyModel("claude-fable-5[1m]"))
        assertEquals("", prettyModel(""))
    }

    // ---- the fleet-wide org filter (XERK-62): parity with org.js

    @Test fun `siteKeyOf is the host's org, blank for a host with no tracker`() {
        assertEquals("acme.atlassian.net", siteKeyOf(agent("h1", true, JiraBlock(siteKey = "acme.atlassian.net"))))
        assertEquals("", siteKeyOf(agent("h2", true, null)))
    }

    @Test fun `filterAgents scopes the fleet to the selected orgs`() {
        val a = agent("h1", true, JiraBlock(siteKey = "acme"))
        val b = agent("h2", true, JiraBlock(siteKey = "beta"))
        // A host with no tracker belongs to no org: under "All orgs" and under
        // none of the named ones.
        val c = agent("h3", true, null)
        val all = listOf(a, b, c)
        assertEquals(all, filterAgents(all, emptySet()))
        assertEquals(listOf("h1"), filterAgents(all, setOf("acme")).map { it.key })
        // Multi-select (XERK-222): every selected org's hosts stay.
        assertEquals(listOf("h1", "h2"), filterAgents(all, setOf("acme", "beta")).map { it.key })
        assertEquals(listOf("h3"), filterAgents(all, emptySet()).filter { siteKeyOf(it).isEmpty() }.map { it.key })
        // Unlike filterSites, unknown keys here filter to nothing — the caller
        // resolves the selection through effectiveOrgs first.
        assertTrue(filterAgents(all, setOf("gone")).isEmpty())
    }

    @Test fun `effectiveOrgs self-heals picks no host reports any more`() {
        val sites = listOf(site("acme"), site("beta"))
        assertEquals(setOf("acme"), effectiveOrgs(setOf("acme"), sites))
        assertEquals(emptySet<String>(), effectiveOrgs(setOf("gone"), sites))
        assertEquals(emptySet<String>(), effectiveOrgs(emptySet(), sites))
        // Each key self-heals independently (XERK-222): the reported one keeps
        // applying while the gone one drops out of the effective set.
        assertEquals(setOf("acme"), effectiveOrgs(setOf("acme", "gone"), sites))
        // Nothing reporting at all can't strand every screen on an empty fleet.
        assertEquals(emptySet<String>(), effectiveOrgs(setOf("acme"), emptyList()))
    }

    @Test fun `scopedAgents applies the selection only while its orgs report`() {
        val a = agent("h1", true, JiraBlock(siteKey = "acme", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
        val b = agent("h2", true, JiraBlock(siteKey = "beta", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
        assertEquals(listOf("h1"), scopedAgents(listOf(a, b), setOf("acme")).map { it.key })
        // Multi-select (XERK-222): both orgs selected keeps both hosts.
        assertEquals(listOf("h1", "h2"), scopedAgents(listOf(a, b), setOf("acme", "beta")).map { it.key })
        // The stored selection is kept by the caller; it just doesn't scope
        // anything while nothing reports those orgs — the whole fleet shows.
        assertEquals(listOf("h1", "h2"), scopedAgents(listOf(a, b), setOf("gone")).map { it.key })
    }

    // XERK-338/XERK-441 parity: retired spend is scoped by the LIVE fleet's orgs.
    // Passing the retired list to `scopedAgents` derives the self-heal from the
    // removed hosts' own orgs, which diverges from org.js in both directions —
    // and the damaging direction adds another org's removed spend to a scoped
    // total. Both types are List<AgentInfo>, so only a test catches it.
    @Test fun `scopedRetired takes its self-heal from the live fleet, not the retired list`() {
        val at = "2026-07-16T01:00:00Z"
        val live = listOf(agent("live", true, JiraBlock(siteKey = "beta", user = "u", fetchedAt = at)))
        val retired = listOf(
            agent("goneAcme", false, JiraBlock(siteKey = "acme", user = "u", fetchedAt = at)),
            agent("goneNoOrg", false, null),
        )
        // Scoped to the LIVE org: neither retired host belongs to it, so neither
        // counts. `scopedAgents(retired, …)` would self-heal "beta" away — no
        // retired host reports it — and hand back BOTH.
        assertEquals(emptyList<String>(), scopedRetired(retired, live, setOf("beta")).map { it.key })
        assertEquals(listOf("goneAcme", "goneNoOrg"), scopedAgents(retired, setOf("beta")).map { it.key })
        // Scoped to an org no LIVE host reports: the pick self-heals away and
        // everything shows, exactly as it does for the live fleet.
        assertEquals(listOf("goneAcme", "goneNoOrg"), scopedRetired(retired, live, setOf("acme")).map { it.key })
        // No pick at all is every retired host.
        assertEquals(listOf("goneAcme", "goneNoOrg"), scopedRetired(retired, live, emptySet()).map { it.key })
    }

    @Test fun `storedOrg migrates the board-only pick forward exactly once`() {
        // Nothing stored either way.
        assertEquals(null, storedOrg(null, null))
        // Only the legacy board key: adopt it.
        assertEquals("acme", storedOrg(null, "acme"))
        // A blank legacy value is nothing to migrate.
        assertEquals(null, storedOrg(null, ""))
        // Once the new key exists it wins, including a deliberate "all orgs".
        assertEquals("", storedOrg("", "acme"))
        assertEquals("beta", storedOrg("beta", "acme"))
    }

    @Test fun `ageStr reports how stale an offline org's last report is`() {
        val now = java.time.Instant.parse("2026-07-16T12:00:00Z").toEpochMilli()
        assertEquals("", ageStr("", now))
        assertEquals("", ageStr("not-a-date", now))
        assertEquals("now", ageStr("2026-07-16T11:59:30Z", now))
        assertEquals("5m", ageStr("2026-07-16T11:55:00Z", now))
        assertEquals("3h", ageStr("2026-07-16T09:00:00Z", now))
        assertEquals("2d", ageStr("2026-07-14T12:00:00Z", now))
        assertEquals("1w", ageStr("2026-07-08T12:00:00Z", now))
    }

    @Test fun `autoStartOn reads the hub-only per-org opt-in`() {
        val site = "acme.atlassian.net"
        // Off unless the hub toggle names the org.
        assertEquals(false, autoStartOn(emptyMap(), site))
        assertEquals(true, autoStartOn(mapOf(site to true), site))
        // Another org's entry doesn't leak across siteKeys.
        assertEquals(false, autoStartOn(mapOf(site to true), "other.atlassian.net"))
    }

    @Test fun `autoMergeOn reads its own map, independent of auto-start`() {
        val site = "acme.atlassian.net"
        assertEquals(false, autoMergeOn(emptyMap(), site))
        assertEquals(true, autoMergeOn(mapOf(site to true), site))
        assertEquals(false, autoMergeOn(mapOf(site to true), "other.atlassian.net"))
        // The two opt-ins are independent maps (XERK-550): an org opted into
        // auto-start reads its own map, not the merge one, and vice-versa.
        assertEquals(true, autoStartOn(mapOf(site to true), site))
        assertEquals(false, autoMergeOn(emptyMap(), site))
    }

    // XERK-83: the on-demand issue detail response envelope.
    @Test fun `a 202 pending response asks to poll again`() {
        assertEquals(IssueFetch.Pending, classifyIssueResponse(202, null))
        // The hub also flags pending in a 200 body (older shape); honour it too.
        assertEquals(IssueFetch.Pending, classifyIssueResponse(200, JiraIssueEnvelope(pending = true)))
    }

    @Test fun `a 200 unwraps the nested issue, not the top-level body`() {
        // The issue lives under `issue`; decoding the body itself blanks every
        // field, which was the empty-sheet half of the bug.
        val env = JiraIssueEnvelope(
            issue = JiraIssueDetail(key = "X-1", description = "hi", stale = false),
            stale = true,
        )
        val out = classifyIssueResponse(200, env)
        assertTrue(out is IssueFetch.Done)
        val d = (out as IssueFetch.Done).detail
        assertEquals("X-1", d.key)
        assertEquals("hi", d.description)
        // The envelope's stale flag rides onto the detail.
        assertEquals(true, d.stale)
    }

    @Test fun `a cached error becomes an error-bearing detail, never a spin`() {
        val out = classifyIssueResponse(200, JiraIssueEnvelope(error = "boom"))
        assertTrue(out is IssueFetch.Done)
        assertEquals("boom", (out as IssueFetch.Done).detail.error)
    }

    @Test fun `a non-2xx with no parsed body surfaces the code`() {
        val out = classifyIssueResponse(503, null)
        assertTrue(out is IssueFetch.Done)
        assertEquals("HTTP 503", (out as IssueFetch.Done).detail.error)
    }

    // ---- card fields (web board.js prioClass / overdueOf), XERK-78 -----------

    @Test fun `prioClass emphasizes highest-high and mutes low-lowest`() {
        assertEquals(PrioEmphasis.HIGH, prioClass("Highest"))
        assertEquals(PrioEmphasis.HIGH, prioClass("high"))
        assertEquals(PrioEmphasis.LOW, prioClass("Low"))
        assertEquals(PrioEmphasis.LOW, prioClass("lowest"))
        assertEquals(PrioEmphasis.NONE, prioClass("Medium"))
        assertEquals(PrioEmphasis.NONE, prioClass(""))
    }

    @Test fun `overdueOf needs a past due date on a not-done ticket`() {
        val now = java.time.Instant.parse("2026-07-22T12:00:00Z").toEpochMilli()
        fun t(due: String?, cat: String = "todo") =
            JiraTicket(key = "A", statusCategory = cat, dueDate = due)
        assertTrue(overdueOf(t("2026-07-21"), now))
        assertTrue(!overdueOf(t("2026-07-22"), now))   // due today is not overdue
        assertTrue(!overdueOf(t("2026-07-23"), now))
        assertTrue(!overdueOf(t(null), now))
        // A Done ticket is never overdue however old its date.
        assertTrue(!overdueOf(t("2020-01-01", cat = "done"), now))
    }

    // ---- ticket -> session chips (web board.js ticketSessionIndex), XERK-78 --

    private fun tref(key: String, site: String = "org.atlassian.net", branch: String? = null) =
        com.xerktech.turma.model.TicketRef(key = key, siteKey = site, branch = branch)

    @Test fun `ticketSessionIndex merges the three channels, record winning`() {
        val t = tref("X-1")
        val live = com.xerktech.turma.model.SessionInfo(
            id = "aa1", status = "running", ticket = t, transcriptId = "tid-live",
            createdAt = "2026-07-20T10:00:00Z",
        )
        val closed = com.xerktech.turma.model.ClosedSessionInfo(
            id = "bb2", ticket = t, transcriptId = "tid-closed", createdAt = "2026-07-19T10:00:00Z",
        )
        // The killed session's own transcript also shows up in the resumable
        // scan; the closed record must win the dedupe.
        val scanDupe = com.xerktech.turma.model.ResumableInfo(
            transcriptId = "tid-closed", ticket = t, endedTs = "2026-07-19T11:00:00Z",
        )
        // Plus one the registry has forgotten entirely.
        val scanOnly = com.xerktech.turma.model.ResumableInfo(
            transcriptId = "tid-old", ticket = t, endedTs = "2026-07-18T09:00:00Z", summary = "old work",
        )
        val agent = AgentInfo(
            key = "host1", online = true,
            sessions = listOf(live),
            closedSessions = listOf(closed),
            repos = listOf(com.xerktech.turma.model.RepoInfo(name = "r", resumable = listOf(scanDupe, scanOnly))),
        )
        val idx = ticketSessionIndex(listOf(agent))
        val sessions = ticketSessionsOf(idx, "org.atlassian.net", "X-1")
        // Three chips: live + closed + the scan-only orphan — oldest first, and
        // the resumable entry sorts on its endedTs (the only stamp it has).
        assertEquals(listOf("tid-old", "tid-closed", "tid-live"), sessions.map { it.transcriptId })
        assertEquals("bb2", sessions[1].id)          // the record's id survived the dedupe
        assertEquals("", sessions[0].id)             // the orphan never had one
    }

    @Test fun `chip label prefers rename, then branch, and state maps status`() {
        val s = TicketSession(
            host = "h", id = "aa1", transcriptId = "t", status = "running",
            gitBranch = "X-1-2", ticketBranch = "X-1", summary = "X-1 fix the thing",
            summaryManual = false, label = "", ticketKey = "X-1", siteKey = "s",
        )
        // The live branch beats the reserved one and the generated summary.
        assertEquals("X-1-2", ticketSessionLabel(s))
        // A rename leads once it exists.
        assertEquals("my name", ticketSessionLabel(s.copy(summaryManual = true, summary = "my name")))
        // No branches at all: summary, then label, then id, then the key.
        assertEquals("X-1 fix the thing", ticketSessionLabel(s.copy(gitBranch = "", ticketBranch = "")))
        assertEquals("aa1", ticketSessionLabel(s.copy(gitBranch = "", ticketBranch = "", summary = "", label = "")))
        assertEquals("running", ticketSessionState(s))
        assertEquals("queued", ticketSessionState(s.copy(status = "queued")))
        assertEquals("failed", ticketSessionState(s.copy(status = "error")))
        assertEquals("stopped", ticketSessionState(s.copy(status = "stopped")))
    }

    // ---- the start control + sweep (web ticketStartHtml / startSweepVerdict) -

    private fun guessed(cloned: Boolean) = JiraTicket(
        key = "X-1",
        repoGuess = com.xerktech.turma.model.RepoGuess(repo = "turma", cloned = cloned),
    )

    @Test fun `start control has the web's four states`() {
        // No triaged repo -> no control at all.
        assertEquals(null, ticketStartControl(JiraTicket(key = "X-1"), 0, null))
        assertEquals(
            null,
            ticketStartControl(
                JiraTicket(key = "X-1", repoGuess = com.xerktech.turma.model.RepoGuess(repo = null)), 0, null,
            ),
        )
        // Pending -> the busy marker.
        assertEquals(StartControl.Busy, ticketStartControl(guessed(true), 0, StartState(pending = true)))
        // Ready -> a live button; an uncloned repo is a live start too (clone
        // on demand), just labelled; sessions compact it to "+".
        assertEquals(StartControl.Button(clone = false, more = false, error = null), ticketStartControl(guessed(true), 0, null))
        assertEquals(StartControl.Button(clone = true, more = false, error = null), ticketStartControl(guessed(false), 0, null))
        assertEquals(StartControl.Button(clone = false, more = true, error = null), ticketStartControl(guessed(true), 2, null))
        // A failed attempt keeps a LIVE button with the reason beside it.
        assertEquals(
            StartControl.Button(clone = false, more = false, error = "boom"),
            ticketStartControl(guessed(true), 0, StartState(error = "boom")),
        )
    }

    // ---- the hub's ticket queue on a card (XERK-296) -------------------------

    private fun queued(
        position: Int = 1,
        reason: String? = null,
        error: String? = null,
    ) = com.xerktech.turma.model.QueuedTicket(
        siteKey = "s", issueKey = "X-1", source = "manual",
        position = position, reason = reason, error = error,
    )

    @Test fun `queuedTicketOf keys on org AND issue key`() {
        val q = listOf(
            com.xerktech.turma.model.QueuedTicket(siteKey = "a", issueKey = "X-1", position = 1),
            com.xerktech.turma.model.QueuedTicket(siteKey = "b", issueKey = "X-2", position = 1),
        )
        assertEquals(1, queuedTicketOf(q, "a", "X-1")?.position)
        assertEquals(null, queuedTicketOf(q, "b", "X-1"))
        assertEquals(null, queuedTicketOf(null, "a", "X-1"))
    }

    @Test fun `queueView overlays a client's in-flight add and cancel on the hub list`() {
        val hub = listOf(
            com.xerktech.turma.model.QueuedTicket(siteKey = "a", issueKey = "X-1", position = 1),
            com.xerktech.turma.model.QueuedTicket(siteKey = "a", issueKey = "X-2", position = 2),
        )
        val add = com.xerktech.turma.model.QueuedTicket(siteKey = "a", issueKey = "X-9", position = 3)
        val out = queueView(hub, mapOf("a\u0000X-9" to add), setOf("a\u0000X-1"))
        assertEquals(listOf("X-2", "X-9"), out.map { it.issueKey })
    }

    @Test fun `a queued ticket replaces the start button with the wait and its cancel`() {
        // Nothing has been handed to a host, so a second press could only
        // re-queue what is queued — the web board replaces the button too.
        assertEquals(
            StartControl.Queued(position = 3, blocked = false, reason = null),
            ticketStartControl(guessed(true), 0, null, queued(position = 3)),
        )
        // A "blocked" hold needs the operator, so it must not read like the
        // capacity wait that clears itself; the reason is the hub's own words.
        assertEquals(
            StartControl.Queued(position = 1, blocked = true, reason = "no triaged repo"),
            ticketStartControl(guessed(true), 0, null,
                queued(reason = "blocked", error = "no triaged repo")),
        )
        // A failed CANCEL rolled the entry back, so its reason renders on the
        // still-queued card rather than vanishing.
        assertEquals(
            StartControl.Queued(position = 1, blocked = false, reason = null, error = "boom"),
            ticketStartControl(guessed(true), 0, StartState(error = "boom"), queued()),
        )
        // Terminal: it waited as long as the hub allows and gave up, which the
        // card must SAY — a click that vanished reads like someone cancelling it.
        assertEquals(
            StartControl.Queued(position = 0, blocked = true,
                reason = "no agent had a free slot", error = null, expired = true),
            ticketStartControl(guessed(true), 0, null,
                queued(position = 0, reason = "expired", error = "no agent had a free slot")),
        )
        // XERK-555: a "paused" hold (every host's Claude 5-hour limit maxed) is
        // self-clearing like capacity, so it is NOT blocked — it carries its own
        // flag and the hub's wording, and the window resetting starts it.
        assertEquals(
            StartControl.Queued(position = 1, blocked = false,
                reason = "5-hour usage limit is maxed", paused = true),
            ticketStartControl(guessed(true), 0, null,
                queued(reason = "paused", error = "5-hour usage limit is maxed")),
        )
        // Still nothing to start against without a triaged repo.
        assertEquals(null, ticketStartControl(JiraTicket(key = "X-1"), 0, null, queued()))
    }

    private fun sess(spawnCmdId: String) = TicketSession(
        host = "h", id = "s1", transcriptId = "t1", status = "running",
        gitBranch = "", ticketBranch = "", summary = "", summaryManual = false,
        label = "", ticketKey = "X-1", siteKey = "s", spawnCmdId = spawnCmdId,
    )

    @Test fun `sweep verdict follows the web's evidence rules`() {
        val p = StartState(pending = true, cmdId = "c1", host = "h", at = 0)
        // A cmdId-less pending (POST not back yet) always holds.
        assertEquals(SweepVerdict.HOLD, startSweepVerdict(StartState(pending = true), emptyList(), false, true, 0, 100).first)
        // A session reporting this cmdId clears it.
        assertEquals(SweepVerdict.CLEAR, startSweepVerdict(p, listOf(sess("c1")), false, true, 0, 100).first)
        // Host gone from the fleet: only the timeout resolves it.
        assertEquals(SweepVerdict.HOLD, startSweepVerdict(p, emptyList(), false, false, 50, 100).first)
        assertEquals(SweepVerdict.ERROR, startSweepVerdict(p, emptyList(), false, false, 150, 100).first)
        // Command present in the host queue: hold, and REMEMBER we saw it.
        val (v, seen) = startSweepVerdict(p, emptyList(), true, true, 0, 100)
        assertEquals(SweepVerdict.HOLD, v)
        assertTrue(seen.sawCmd)
        // Once seen, its absence means the agent took (or refused) it: clear.
        assertEquals(SweepVerdict.CLEAR, startSweepVerdict(seen, emptyList(), false, true, 0, 100).first)
        // Never seen + absent: a stale cache, not an ack — wait, then time out.
        assertEquals(SweepVerdict.HOLD, startSweepVerdict(p, emptyList(), false, true, 50, 100).first)
        assertEquals(SweepVerdict.ERROR, startSweepVerdict(p, emptyList(), false, true, 150, 100).first)
    }

    @Test fun `XERK-325 - a reported refusal ends the wait instead of clearing silently`() {
        val p = StartState(pending = true, cmdId = "c1", host = "h", at = 0, sawCmd = true)
        // The agent said it declined this spawn: that is the verdict, whatever the
        // sawCmd/timeout rules would have guessed.
        assertEquals(SweepVerdict.REFUSED,
            startSweepVerdict(p, emptyList(), false, true, 0, 100, "no triaged repo on this host").first)
        // A session that actually landed still wins the tie.
        assertEquals(SweepVerdict.CLEAR,
            startSweepVerdict(p, listOf(sess("c1")), false, true, 0, 100, "no triaged repo").first)
        // No refusal reported is "can't tell" (older hub), never "it was refused":
        // the old timing rules apply unchanged.
        assertEquals(SweepVerdict.CLEAR, startSweepVerdict(p, emptyList(), false, true, 0, 100, null).first)
        val fresh = StartState(pending = true, cmdId = "c2", host = "h", at = 0)
        assertEquals(SweepVerdict.HOLD, startSweepVerdict(fresh, emptyList(), false, true, 50, 100, null).first)
    }

    // ---- status change (XERK-138): parity with board.js canChangeStatus -------
    @Test fun `status is changeable only when online and options exist`() {
        val opts = listOf(StatusOption(id = "31", name = "Done", category = "done"))
        assertTrue(statusChangeable(online = true, options = opts))
        assertFalse(statusChangeable(online = false, options = opts))   // write needs a live host
        assertFalse(statusChangeable(online = true, options = emptyList()))  // nothing to move to
    }

    // ---- drag-and-drop status change (XERK-141): parity with board.js ---------
    @Test fun `boardColumnOf holds the dropped column through pending AND settled`() {
        val t = ticket("A", "todo")
        assertEquals("todo", boardColumnOf(t, null))
        assertEquals("todo", boardColumnOf(t, MoveState(category = "done", error = "x")))
        assertEquals("done", boardColumnOf(t, MoveState(category = "done", pending = true)))
        // settled must ALSO hold (the change landed, the slow poll hasn't caught
        // up) — honouring pending alone snapped a just-moved card back.
        assertEquals("done", boardColumnOf(t, MoveState(category = "done", settled = true)))
    }

    @Test fun `moveSweepVerdict holds a pending move`() {
        val m = MoveState(category = "done", pending = true, at = 1_000)
        assertEquals(SweepVerdict.HOLD, moveSweepVerdict(m, "todo", 1_000, 120_000, 6_000))
    }

    @Test fun `moveSweepVerdict holds a settled move until the poll catches up`() {
        val m = MoveState(category = "done", settled = true, settledAt = 1_000, at = 1_000)
        assertEquals(SweepVerdict.HOLD, moveSweepVerdict(m, "todo", 2_000, 120_000, 6_000))   // poll lags
        assertEquals(SweepVerdict.CLEAR, moveSweepVerdict(m, "done", 2_000, 120_000, 6_000))  // caught up
        assertEquals(SweepVerdict.CLEAR, moveSweepVerdict(m, "todo", 121_001, 120_000, 6_000)) // backstop
    }

    @Test fun `moveSweepVerdict shows a failed move briefly then clears`() {
        val m = MoveState(category = "done", error = "nope", at = 1_000)
        assertEquals(SweepVerdict.HOLD, moveSweepVerdict(m, "todo", 2_000, 120_000, 6_000))
        assertEquals(SweepVerdict.CLEAR, moveSweepVerdict(m, "todo", 7_001, 120_000, 6_000))
    }

    // ---- drag edge auto-scroll (XERK-179): parity with board.html edgeScroll ----

    @Test fun `edgeScrollStep is zero in the middle and full-speed at the edges`() {
        // Strip 0..1000, 48px zones, 20px max step.
        assertEquals(0f, edgeScrollStep(500f, 0f, 1000f, 48f, 20f))
        assertEquals(0f, edgeScrollStep(48f, 0f, 1000f, 48f, 20f))    // on the inner boundary
        assertEquals(0f, edgeScrollStep(952f, 0f, 1000f, 48f, 20f))
        assertEquals(-20f, edgeScrollStep(0f, 0f, 1000f, 48f, 20f))   // hard left
        assertEquals(20f, edgeScrollStep(1000f, 0f, 1000f, 48f, 20f)) // hard right
    }

    @Test fun `edgeScrollStep ramps with depth into the zone`() {
        assertEquals(-10f, edgeScrollStep(24f, 0f, 1000f, 48f, 20f))  // halfway into the left zone
        assertEquals(10f, edgeScrollStep(976f, 0f, 1000f, 48f, 20f))  // halfway into the right zone
    }

    @Test fun `edgeScrollStep clamps past the strip and needs room for two zones`() {
        // A pointer past the strip edge (the finger can wander off it) caps at max.
        assertEquals(-20f, edgeScrollStep(-100f, 0f, 1000f, 48f, 20f))
        assertEquals(20f, edgeScrollStep(1100f, 0f, 1000f, 48f, 20f))
        // A strip too narrow for two distinct zones never scrolls, nor a zero zone.
        assertEquals(0f, edgeScrollStep(10f, 0f, 90f, 48f, 20f))
        assertEquals(0f, edgeScrollStep(10f, 0f, 1000f, 0f, 20f))
    }

    // ---- New-ticket creation (XERK-137): parity with board.js/board.html ----

    @Test fun `mergeSites carries the tracker source off the freshest block, defaulting jira`() {
        val az = agent("az", true, JiraBlock(siteKey = "dev.azure.com/o", user = "u", fetchedAt = "2026-07-16T01:00:00Z", source = "azure"))
        assertEquals("azure", mergeSites(listOf(az))[0].source)
        // An older agent omits `source`; it must default to jira, not blank.
        val jira = agent("j", true, JiraBlock(siteKey = "o.atlassian.net", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
        assertEquals("jira", mergeSites(listOf(jira))[0].source)
    }

    @Test fun `createLabelWord is worded per source`() {
        assertEquals("label", createLabelWord("jira"))
        assertEquals("Label", createLabelWord("jira", cap = true))
        assertEquals("tag", createLabelWord("azure"))
        assertEquals("Tag", createLabelWord("azure", cap = true))
    }

    @Test fun `splitLabels splits jira on whitespace+commas and azure on commas only`() {
        // Jira forbids spaces in a label, so "e2e test" is two labels.
        assertEquals(listOf("turma", "e2e", "test"), splitLabels("turma, e2e test", "jira"))
        // Azure tags may contain spaces, so it stays one tag.
        assertEquals(listOf("turma", "e2e test"), splitLabels("turma, e2e test", "azure"))
        // Deduped, trimmed, blanks dropped.
        assertEquals(listOf("a", "b"), splitLabels(" a , a ,, b ", "azure"))
    }

    @Test fun `createDirty guards a close only while un-created text would be lost`() {
        // A clean form closes freely; any text field makes it dirty (XERK-218).
        assertEquals(false, createDirty("", "", "", created = false))
        assertEquals(false, createDirty("  ", " ", "", created = false))
        assertEquals(true, createDirty("t", "", "", created = false))
        assertEquals(true, createDirty("", "d", "", created = false))
        assertEquals(true, createDirty("", "", "l", created = false))
        // The created screen is never dirty — the ticket exists.
        assertEquals(false, createDirty("t", "d", "l", created = true))
    }

    @Test fun `classifyCreateMeta distinguishes pending, projects, types, and error`() {
        assertEquals(CreateMetaFetch.Pending, classifyCreateMeta(202, null, wantTypes = false))
        assertEquals(CreateMetaFetch.Pending, classifyCreateMeta(200, CreateMetaEnvelope(pending = true), wantTypes = false))
        val projects = classifyCreateMeta(200, CreateMetaEnvelope(projects = listOf(CreateProject("E", "Eng")), labels = listOf("x"), source = "jira"), wantTypes = false)
        assertEquals(CreateMetaFetch.Projects(listOf(CreateProject("E", "Eng")), listOf("x"), "jira"), projects)
        val types = classifyCreateMeta(200, CreateMetaEnvelope(types = listOf(CreateType("1", "Task"))), wantTypes = true)
        assertEquals(CreateMetaFetch.Types(listOf(CreateType("1", "Task"))), types)
        assertTrue(classifyCreateMeta(200, CreateMetaEnvelope(error = "boom"), wantTypes = false) is CreateMetaFetch.Error)
        assertTrue(classifyCreateMeta(500, null, wantTypes = false) is CreateMetaFetch.Error)
        // A project-less body with no source still reads jira.
        val defaulted = classifyCreateMeta(200, CreateMetaEnvelope(projects = emptyList()), wantTypes = false) as CreateMetaFetch.Projects
        assertEquals("jira", defaulted.source)
    }

    @Test fun `classifyCreateResult distinguishes pending, created, and error`() {
        assertEquals(CreateResultFetch.Pending, classifyCreateResult(202, null))
        assertEquals(CreateResultFetch.Created("ENG-9", "u"), classifyCreateResult(200, CreateResultEnvelope(key = "ENG-9", url = "u")))
        // XERK-151: created but unassigned is a success carrying a warning — the
        // board filters on the tracker user, so it lands invisible there.
        assertEquals(
            CreateResultFetch.Created("ENG-9", "u", "couldn't be assigned"),
            classifyCreateResult(200, CreateResultEnvelope(key = "ENG-9", url = "u", warning = "couldn't be assigned")),
        )
        assertTrue(classifyCreateResult(200, CreateResultEnvelope(error = "bad field")) is CreateResultFetch.Error)
        assertTrue(classifyCreateResult(500, null) is CreateResultFetch.Error)
        // A 200 with neither key nor error is an error, not a false success.
        assertTrue(classifyCreateResult(200, CreateResultEnvelope()) is CreateResultFetch.Error)
    }

    // ---- Triage lane + verdict (XERK-486): parity with board.js
    // triageActionOf / triageLaneOf / cards[lane || boardColumnOf] ----------------

    @Test fun `triageActionOf reads the hub's siteKey-issueKey-keyed map`() {
        val actions = mapOf(
            "org.atlassian.net/X-1" to com.xerktech.turma.model.TriageActionPin(action = "hold", at = 1),
            "org.atlassian.net/X-2" to com.xerktech.turma.model.TriageActionPin(action = "approve", at = 1),
            "org.atlassian.net/X-3" to com.xerktech.turma.model.TriageActionPin(action = "reject", at = 1),
            "org.atlassian.net/X-4" to com.xerktech.turma.model.TriageActionPin(action = "bogus", at = 1),
            "org.atlassian.net/X-5" to com.xerktech.turma.model.TriageActionPin(),
        )
        assertEquals("hold", triageActionOf(actions, "org.atlassian.net", "X-1"))
        assertEquals("approve", triageActionOf(actions, "org.atlassian.net", "X-2"))
        assertEquals("reject", triageActionOf(actions, "org.atlassian.net", "X-3"))
        // Unknown action value and blank action both read as no verdict (auto).
        assertEquals(null, triageActionOf(actions, "org.atlassian.net", "X-4"))
        assertEquals(null, triageActionOf(actions, "org.atlassian.net", "X-5"))
        assertEquals(null, triageActionOf(actions, "org.atlassian.net", "X-9"))
    }

    @Test fun `triageLaneOf sends untriaged To Do tickets to the triage lane`() {
        // No triage assessment yet -> the lane.
        assertEquals("triage", triageLaneOf(ticket("A", "todo"), null))
        // A triage assessment present -> the normal column.
        val triaged = ticket("A", "todo").copy(
            triage = com.xerktech.turma.model.TicketTriage(priority = "P2", type = "task", reason = "x", at = "2026-09-01T00:00:00Z"),
        )
        assertEquals(null, triageLaneOf(triaged, null))
        // Non-To-Do tickets never land in the lane, whatever their state.
        assertEquals(null, triageLaneOf(ticket("A", "inprogress"), null))
        assertEquals(null, triageLaneOf(ticket("A", "done"), null))
        // Null ticket is safe.
        assertEquals(null, triageLaneOf(null, null))
    }

    @Test fun `triageLaneOf always wins over triage for held tickets`() {
        // "hold" moves a triaged To Do ticket back into the lane — the operator's
        // verdict overrides the agent's assessment, exactly like the web.
        val triaged = ticket("A", "todo").copy(
            triage = com.xerktech.turma.model.TicketTriage(priority = "P1", type = "bug", reason = "x", at = "2026-09-01T00:00:00Z"),
        )
        assertEquals("triage", triageLaneOf(triaged, "hold"))
        // Approve/reject keep the ticket in its normal column.
        assertEquals(null, triageLaneOf(triaged, "approve"))
        assertEquals(null, triageLaneOf(triaged, "reject"))
        // A held non-To-Do ticket stays put (the lane is To-Do-only).
        assertEquals(null, triageLaneOf(ticket("A", "inprogress"), "hold"))
    }

    @Test fun `displayColumnOf - lane beats category, live drag override beats lane`() {
        val untriaged = ticket("A", "todo")
        // No override: the untriaged To Do ticket sits in the Triage lane.
        assertEquals("triage", displayColumnOf(untriaged, null, null))
        // Triaged To Do ticket without a verdict: normal To Do column.
        val triaged = ticket("A", "todo").copy(
            triage = com.xerktech.turma.model.TicketTriage(priority = "P2", type = "task", reason = "x", at = "2026-09-01T00:00:00Z"),
        )
        assertEquals("todo", displayColumnOf(triaged, null, null))
        // Held: lane again.
        assertEquals("triage", displayColumnOf(triaged, null, "hold"))
        // A live drag override always wins — even for a held ticket (mirrors
        // board.js `mv ? null : triageLaneOf`).
        assertEquals("inprogress", displayColumnOf(triaged, MoveState("inprogress", pending = true), "hold"))
        assertEquals("done", displayColumnOf(untriaged, MoveState("done", settled = true), null))
        // A move in error does not pin the card (reverts to lane/category).
        assertEquals("triage", displayColumnOf(untriaged, MoveState("done", error = "nope"), null))
    }

    // --- epic auto-orchestration (XERK-638) ---------------------------------

    private fun epicTicket(key: String) =
        JiraTicket(key = key, isEpic = true, type = "Epic", statusCategory = "todo", status = "To Do")

    private fun child(key: String, cat: String = "todo", blockedBy: List<String> = emptyList(), summary: String = "") =
        JiraTicket(key = key, statusCategory = cat, blockedBy = blockedBy, summary = summary)

    private fun epicSite(children: List<JiraTicket>) =
        BoardSite(siteKey = "org", site = "org", online = true, error = null, fetchedAt = "",
            tickets = listOf(epicTicket("E-1")) + children)

    private fun mkRun(
        state: String = "running",
        children: List<String> = listOf("C-1", "C-2", "C-3"),
        waves: List<List<String>> = listOf(listOf("C-1"), listOf("C-2", "C-3")),
        cycle: List<String> = emptyList(),
        paused: Boolean = false,
    ) = com.xerktech.turma.model.EpicRun(
        epicKey = "E-1", siteKey = "org", state = state, children = children, waves = waves,
        cycle = cycle, paused = paused)

    private fun epicSess(status: String) = TicketSession(
        host = "h", id = "s", transcriptId = "t", status = status, gitBranch = "", ticketBranch = "",
        summary = "", summaryManual = false, label = "", ticketKey = "", siteKey = "org")

    @Test fun `isEpicTicket is true only for an epic`() {
        assertTrue(isEpicTicket(epicTicket("E-1")))
        assertFalse(isEpicTicket(child("W-1")))
        assertFalse(isEpicTicket(null))
    }

    @Test fun `epicRunOf resolves by site-slash-key, null when absent or childless`() {
        val map = mapOf("org/E-1" to mkRun(), "org/E-2" to mkRun(children = emptyList()))
        assertEquals("E-1", epicRunOf(map, "org", "E-1")?.epicKey)
        assertNull(epicRunOf(map, "org", "E-2"))   // no children -> not a run
        assertNull(epicRunOf(map, "org", "E-9"))
        assertNull(epicRunOf(null, "org", "E-1"))
    }

    @Test fun `an epic is never parked in the Triage lane`() {
        // An untriaged To Do work ticket lands in the lane; an untriaged To Do
        // epic does not (it is an organizer, XERK-638).
        assertEquals("triage", triageLaneOf(child("W-1"), null))
        assertNull(triageLaneOf(epicTicket("E-1"), null))
        assertNull(triageLaneOf(epicTicket("E-1"), "hold"))
    }

    @Test fun `an epic offers no per-ticket Start control`() {
        // ticketStartControl returns null for an epic even with a repo/sessions.
        val e = epicTicket("E-1").copy(repoGuess = com.xerktech.turma.model.RepoGuess(repo = "Turma", cloned = true))
        assertNull(ticketStartControl(e, 0, null, null))
    }

    @Test fun `epicRunView derives child status from the live board`() {
        // C-1 Done; C-2 has a running session; C-3 unstarted, its in-epic blocker
        // C-2 not Done -> blocked.
        val site = epicSite(listOf(
            child("C-1", cat = "done"),
            child("C-2"),
            child("C-3", blockedBy = listOf("C-2")),
        ))
        val idx = mapOf("org\u0000C-2" to listOf(epicSess("running")))
        val view = epicRunView(mkRun(), site, idx)
        assertEquals("running", view.state)
        assertEquals(3, view.total)
        assertEquals(1, view.done)
        val flat = (view.waves.flatten()).associate { it.key to it.status }
        assertEquals(EpicChildStatus.DONE, flat["C-1"])
        assertEquals(EpicChildStatus.RUNNING, flat["C-2"])
        assertEquals(EpicChildStatus.BLOCKED, flat["C-3"])
        assertEquals(1, view.count(EpicChildStatus.DONE))
        assertEquals(1, view.count(EpicChildStatus.RUNNING))
        assertEquals(1, view.count(EpicChildStatus.BLOCKED))
        // Wave order preserved from the hub's layering.
        assertEquals(listOf(listOf("C-1"), listOf("C-2", "C-3")), view.waves.map { w -> w.map { it.key } })
    }

    @Test fun `epicRunView marks a child ready when its in-epic blockers are Done`() {
        val site = epicSite(listOf(
            child("C-1", cat = "done"),
            child("C-2", blockedBy = listOf("C-1")),
            child("C-3", blockedBy = listOf("C-1")),
        ))
        val view = epicRunView(mkRun(), site, emptyMap())
        val flat = view.waves.flatten().associate { it.key to it.status }
        assertEquals(EpicChildStatus.READY, flat["C-2"])
        assertEquals(EpicChildStatus.READY, flat["C-3"])
        assertEquals(2, view.count(EpicChildStatus.READY))
    }

    @Test fun `epicRunView counts a queued child as running and a cycle child as blocked`() {
        val site = epicSite(listOf(child("C-1"), child("C-2"), child("C-3")))
        val q = listOf(com.xerktech.turma.model.QueuedTicket(siteKey = "org", issueKey = "C-1"))
        val view = epicRunView(mkRun(state = "blocked", cycle = listOf("C-2", "C-3")), site, emptyMap(), q)
        val flat = (view.waves.flatten() + view.cycleChildren).associate { it.key to it.status }
        assertEquals(EpicChildStatus.RUNNING, flat["C-1"])
        assertTrue(view.cycle)
        assertEquals(2, view.cycleChildren.size)
        assertTrue(view.cycleChildren.all { it.status == EpicChildStatus.BLOCKED })
    }

    @Test fun `epicRunSig changes when the run advances`() {
        val a = epicSite(listOf(child("C-1"), child("C-2"), child("C-3")))
        val before = epicRunSig(epicRunView(mkRun(), a, emptyMap()))
        val b = epicSite(listOf(child("C-1", cat = "done"), child("C-2"), child("C-3")))
        val after = epicRunSig(epicRunView(mkRun(), b, emptyMap()))
        assertTrue(before != after)
        assertEquals("", epicRunSig(null))
    }

    @Test fun `epicRunView surfaces the run's paused hold and the sig reflects it (XERK-641)`() {
        val site = epicSite(listOf(child("C-1"), child("C-2"), child("C-3")))
        assertFalse(epicRunView(mkRun(), site, emptyMap()).paused)
        assertTrue(epicRunView(mkRun(paused = true), site, emptyMap()).paused)
        // The signature changes when the hold toggles, so the open panel repaints.
        val running = epicRunSig(epicRunView(mkRun(), site, emptyMap()))
        val held = epicRunSig(epicRunView(mkRun(paused = true), site, emptyMap()))
        assertTrue(running != held)
    }

    @Test fun `rateMaxError validates the policy-sheet rate field`() {
        assertNull(rateMaxError(""))
        assertNull(rateMaxError("  "))
        assertNull(rateMaxError("5"))
        assertNull(rateMaxError("50"))
        assertEquals("Max auto-starts must be a whole number between 1 and 50 (or empty for the default)", rateMaxError("99"))
        assertEquals("Max auto-starts must be a whole number between 1 and 50 (or empty for the default)", rateMaxError("0"))
        assertEquals("Max auto-starts must be a whole number between 1 and 50 (or empty for the default)", rateMaxError("abc"))
        assertEquals("Max auto-starts must be a whole number between 1 and 50 (or empty for the default)", rateMaxError("-1"))
    }
}
