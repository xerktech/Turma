package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.JiraBlock
import com.xerktech.turma.model.JiraIssueDetail
import com.xerktech.turma.model.JiraIssueEnvelope
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

    // ---- the fleet-wide org filter (XERK-62): parity with org.js

    @Test fun `siteKeyOf is the host's org, blank for a host with no tracker`() {
        assertEquals("acme.atlassian.net", siteKeyOf(agent("h1", true, JiraBlock(siteKey = "acme.atlassian.net"))))
        assertEquals("", siteKeyOf(agent("h2", true, null)))
    }

    @Test fun `filterAgents scopes the fleet to one org`() {
        val a = agent("h1", true, JiraBlock(siteKey = "acme"))
        val b = agent("h2", true, JiraBlock(siteKey = "beta"))
        // A host with no tracker belongs to no org: under "All orgs" and under
        // none of the named ones.
        val c = agent("h3", true, null)
        val all = listOf(a, b, c)
        assertEquals(all, filterAgents(all, ""))
        assertEquals(listOf("h1"), filterAgents(all, "acme").map { it.key })
        assertEquals(listOf("h3"), filterAgents(all, "").filter { siteKeyOf(it).isEmpty() }.map { it.key })
        // Unlike filterSites, an unknown key here filters to nothing — the caller
        // resolves it through effectiveOrg first.
        assertTrue(filterAgents(all, "gone").isEmpty())
    }

    @Test fun `effectiveOrg self-heals a pick no host reports any more`() {
        val sites = listOf(site("acme"), site("beta"))
        assertEquals("acme", effectiveOrg("acme", sites))
        assertEquals("", effectiveOrg("gone", sites))
        assertEquals("", effectiveOrg("", sites))
        // Nothing reporting at all can't strand every screen on an empty fleet.
        assertEquals("", effectiveOrg("acme", emptyList()))
    }

    @Test fun `scopedAgents applies the pick only while its org reports`() {
        val a = agent("h1", true, JiraBlock(siteKey = "acme", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
        val b = agent("h2", true, JiraBlock(siteKey = "beta", user = "u", fetchedAt = "2026-07-16T01:00:00Z"))
        assertEquals(listOf("h1"), scopedAgents(listOf(a, b), "acme").map { it.key })
        // The stored pick is kept by the caller; it just doesn't scope anything
        // while nothing reports that org — the whole fleet shows instead.
        assertEquals(listOf("h1", "h2"), scopedAgents(listOf(a, b), "gone").map { it.key })
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
}
