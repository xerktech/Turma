package com.xerktech.turma.model

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Decoding the /api/agents fleet payload is atomic: one un-decodable host throws
 * for the WHOLE array, so a single bad record hides every other host from the
 * poll. These lock in that a ticket-backed closed session — whose `ticket` is an
 * OBJECT on the wire, not a String — no longer breaks that decode.
 */
class AgentDecodeTest {

    // A killed session that was spawned from a Jira ticket: the closed record
    // carries the ticket object hub-agent _closed_payload snapshots.
    private val ticketedHost = """
        {
          "key": "txp-1", "device": "txp-1", "online": true,
          "closedSessions": [
            {
              "id": "s1", "repo": "turma", "branch": "XERK-9",
              "summary": "Fix the thing", "closedAt": "2026-07-17T00:00:00Z",
              "ticket": {
                "key": "XERK-9", "siteKey": "xerk.atlassian.net",
                "url": "https://xerk.atlassian.net/browse/XERK-9",
                "summary": "Fix the thing", "branch": "XERK-9"
              }
            }
          ]
        }
    """.trimIndent()

    private val plainHost = """
        { "key": "mxh-t16", "device": "mxh-t16", "online": true, "closedSessions": [] }
    """.trimIndent()

    @Test fun `a ticket-backed closed session does not hide its host`() {
        val body = """{ "now": 1, "agents": [ $plainHost, $ticketedHost ] }"""
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        // Before the fix this threw (object into a String field), dropping BOTH
        // hosts from the poll.
        assertEquals(listOf("mxh-t16", "txp-1"), resp.agents.map { it.key })
        val ticket = resp.agents[1].closedSessions[0].ticket
        assertNotNull(ticket)
        assertEquals("XERK-9", ticket!!.key)
        assertEquals("xerk.atlassian.net", ticket.siteKey)
    }

    @Test fun `a closed session with no ticket decodes to null`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "closedSessions": [ { "id": "s", "repo": "r", "ticket": null } ]
            } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        assertEquals(1, resp.agents.size)
        assertNull(resp.agents[0].closedSessions[0].ticket)
    }

    // The ended-session read-only review (XERK-70) opens by transcriptId and chips
    // the session's PRs; both ride _closed_payload and must decode onto the record.
    @Test fun `a closed session carries its transcriptId and PRs`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "closedSessions": [ {
                "id": "s", "repo": "r", "transcriptId": "tid-abc",
                "prs": [ { "url": "https://gh/x/pull/7", "number": 7, "state": "MERGED", "ready": "ready" } ]
              } ]
            } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val closed = resp.agents[0].closedSessions[0]
        assertEquals("tid-abc", closed.transcriptId)
        assertEquals(1, closed.prs.size)
        assertEquals(7, closed.prs[0].number)
        assertEquals("MERGED", closed.prs[0].state)
    }

    // Records from an agent predating the snapshot omit both — they must default,
    // not throw (which would drop the whole fleet poll).
    @Test fun `a closed session without transcriptId or prs still decodes`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "closedSessions": [ { "id": "s", "repo": "r" } ]
            } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val closed = resp.agents[0].closedSessions[0]
        assertEquals("", closed.transcriptId)
        assertEquals(0, closed.prs.size)
    }

    // The live-status frame (XERK-75): tunnel-agent.js scrapes up/down/elapsed as
    // DISPLAY STRINGS ("1.2k", "12s") and attaches an optional agents[] list. These
    // were typed Long, so decodeFromString<TailFrame> threw on every real status
    // frame — and LiveTail swallows that, dropping the whole turn. Lock the shapes.
    @Test fun `a turn status frame with string tokens and an agent list decodes`() {
        val body = """
            {
              "type": "turn", "text": "hello",
              "status": {
                "verb": "Cogitating", "up": "1.2k", "down": "340", "elapsed": "12s",
                "hint": "Tip: press esc\n☐ write the test",
                "agents": [
                  { "sel": true, "type": "main" },
                  { "sel": false, "type": "Explore", "label": "look at chat.js" }
                ]
              }
            }
        """.trimIndent()
        val frame = TurmaJson.decodeFromString<TailFrame>(body)
        val st = frame.status!!
        assertEquals("Cogitating", st.verb)
        assertEquals("1.2k", st.up)
        assertEquals("340", st.down)
        assertEquals("12s", st.elapsed)
        assertEquals(2, st.agents.size)
        assertEquals("main", st.agents[0].type)
        assertEquals(true, st.agents[0].sel)
        assertEquals("look at chat.js", st.agents[1].label)
    }

    // An idle frame carries no status (null) and no agents — must default cleanly.
    @Test fun `a turn frame with no status decodes to null`() {
        val frame = TurmaJson.decodeFromString<TailFrame>("""{ "type": "turn", "text": "" }""")
        assertNull(frame.status)
    }

    // ---- the XERK-78 session-detail fields (hub-agent _session_payload) ------

    @Test fun `a live session's detail fields decode, nulls coercing to defaults`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "sessions": [ {
                "id": "s1", "status": "queued", "repo": "turma",
                "ticket": { "key": "XERK-9", "siteKey": "x.atlassian.net", "branch": "XERK-9" },
                "spawnCmdId": "cmd-1", "transcriptId": "tid-1",
                "createdAt": "2026-07-22T10:00:00Z", "stoppedAt": null, "errorMsg": null,
                "queuedReason": "capacity", "queuedAt": "2026-07-22T10:00:01Z",
                "restartCount": 2,
                "work": { "baseRef": "main", "aheadOfBase": 3, "pushed": false, "aheadOfRemote": null },
                "git": { "repoName": "turma", "branch": "XERK-9", "dirtyFiles": 4 }
              } ]
            } ] }
        """.trimIndent()
        val s = TurmaJson.decodeFromString<AgentsResponse>(body).agents[0].sessions[0]
        assertEquals("XERK-9", s.ticket!!.key)
        assertEquals("cmd-1", s.spawnCmdId)
        assertEquals("tid-1", s.transcriptId)
        assertEquals("capacity", s.queuedReason)
        assertEquals("2026-07-22T10:00:01Z", s.queuedAt)
        assertEquals(2, s.restartCount)
        // The wire's explicit nulls coerce to the blank defaults, not a throw.
        assertEquals("", s.stoppedAt)
        assertEquals("", s.errorMsg)
        assertEquals(3, s.work!!.aheadOfBase)
        assertEquals(false, s.work!!.pushed)
        assertNull(s.work!!.aheadOfRemote)
        assertEquals(4, s.git!!.dirtyFiles)
    }

    // The resumable scan's real wire shape ({transcriptId, cwd, repo, root,
    // endedTs, ticket, prs}) — the ended list's durable channel.
    @Test fun `a resumable transcript decodes its endedTs, ticket and PRs`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "repos": [ { "name": "turma", "resumable": [ {
                "transcriptId": "tid-9", "cwd": "/repos/.turma/worktrees/x",
                "repo": "turma", "root": false, "summary": "old work",
                "endedTs": "2026-07-20T09:00:00Z",
                "ticket": { "key": "XERK-5", "siteKey": "x.atlassian.net" },
                "prs": [ { "url": "https://gh/x/pull/3", "number": 3, "state": "OPEN" } ]
              } ] } ]
            } ] }
        """.trimIndent()
        val r = TurmaJson.decodeFromString<AgentsResponse>(body).agents[0].repos[0].resumable[0]
        assertEquals("tid-9", r.transcriptId)
        assertEquals("2026-07-20T09:00:00Z", r.endedTs)
        assertEquals("XERK-5", r.ticket!!.key)
        assertEquals(3, r.prs[0].number)
        assertEquals("/repos/.turma/worktrees/x", r.cwd)
    }

    // The usage block's per-day buckets (the 30-day chart's source) and
    // lastActivity — absent on an older agent, defaulting cleanly.
    @Test fun `usage days and lastActivity decode, and default when absent`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "usage": {
                "totals": { "input": 1, "output": 2, "cacheWrite": 0, "cacheRead": 0 },
                "days": { "2026-07-21": { "input": 5, "output": 1, "cacheWrite": 0, "cacheRead": 0 } },
                "lastActivity": "2026-07-21T23:00:00Z"
              }
            } ] }
        """.trimIndent()
        val u = TurmaJson.decodeFromString<AgentsResponse>(body).agents[0].usage!!
        assertEquals(6L, u.days["2026-07-21"]!!.total)
        assertEquals("2026-07-21T23:00:00Z", u.lastActivity)
        val bare = TurmaJson.decodeFromString<AgentsResponse>(
            """{ "now": 1, "agents": [ { "key": "h", "usage": { } } ] }""",
        ).agents[0].usage!!
        assertEquals(0, bare.days.size)
        assertEquals("", bare.lastActivity)
    }
}
