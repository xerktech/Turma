package com.xerktech.turma.model

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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

    // The local-model failover block (XERK-246), in the exact shape hub-agent
    // reports it: a host with no LOCAL_MODEL_* env sends available:false with
    // BOTH other fields explicitly null, which must decode as "cannot fail over"
    // rather than throw and hide the whole fleet.
    @Test fun `the localModel block decodes both configured and not`() {
        val body = """
            { "now": 1, "agents": [
              { "key": "on", "device": "on", "online": true,
                "localModel": { "available": true, "model": "gpt-oss:120b", "contextTokens": 81920 },
                "sessions": [ { "id": "s1", "modelSource": "local",
                                "modelSourceAt": "2026-08-11T02:30:00Z" } ] },
              { "key": "off", "device": "off", "online": true,
                "localModel": { "available": false, "model": null, "contextTokens": null },
                "sessions": [ { "id": "s2", "modelSource": "subscription" } ] }
            ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val on = resp.agents[0]
        assertEquals(true, on.localModel?.available)
        assertEquals("gpt-oss:120b", on.localModel?.model)
        assertEquals(81920, on.localModel?.contextTokens)
        assertEquals("local", on.sessions[0].modelSource)
        assertEquals("2026-08-11T02:30:00Z", on.sessions[0].modelSourceAt)
        val off = resp.agents[1]
        assertEquals(false, off.localModel?.available)
        assertNull(off.localModel?.model)
        assertEquals("subscription", off.sessions[0].modelSource)
    }

    // XERK-460: the dsh capability flag + per-session runtime. Typing these is
    // what makes them decode-fatal if wrong, so the shape is pinned here — the
    // available/absent block and the session's agentType.
    @Test fun `the dsh block and session agentType decode`() {
        val body = """
            { "now": 1, "agents": [
              { "key": "on", "device": "on", "online": true,
                "dsh": { "available": true },
                "sessions": [ { "id": "s1", "agentType": "dsh" } ] },
              { "key": "off", "device": "off", "online": true,
                "dsh": { "available": false },
                "sessions": [ { "id": "s2", "agentType": "claude" } ] },
              { "key": "old", "device": "old", "online": true,
                "sessions": [ { "id": "s3" } ] }
            ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        assertEquals(true, resp.agents[0].dsh?.available)
        assertEquals("dsh", resp.agents[0].sessions[0].agentType)
        assertEquals(false, resp.agents[1].dsh?.available)
        assertEquals("claude", resp.agents[1].sessions[0].agentType)
        // A pre-dsh agent sends neither; both read as absent/default, never a throw.
        assertNull(resp.agents[2].dsh)
        assertEquals("", resp.agents[2].sessions[0].agentType)
    }

    // XERK-477 [M]: an ENDED dsh session's runtime rides _closed_payload's
    // agentType too, so its ended card carries the same badge as the live one.
    // A record from an agent predating the field omits it and defaults to "".
    @Test fun `a closed session carries its agentType`() {
        val body = """
            { "now": 1, "agents": [ {
              "key": "h", "device": "h", "online": true,
              "closedSessions": [
                { "id": "d", "repo": "r", "agentType": "dsh" },
                { "id": "c", "repo": "r", "agentType": "claude" },
                { "id": "o", "repo": "r" }
              ]
            } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val closed = resp.agents[0].closedSessions
        assertEquals("dsh", closed[0].agentType)
        assertEquals("claude", closed[1].agentType)
        assertEquals("", closed[2].agentType)
    }

    // XERK-489: the discovered model list + defaultModel on the block, and the
    // per-session localModelName/localModelContext. Both are typed now, so the
    // hub coerces them (normalizeLocalModel / normalizeSessions) and this decode
    // must accept the well-formed shape and the absent one.
    @Test fun `the discovered local models and per-session pick decode`() {
        val body = """
            { "now": 1, "agents": [
              { "key": "h", "device": "h", "online": true,
                "localModel": { "available": true, "model": "gpt-oss:120b",
                  "contextTokens": 120000, "defaultModel": "gpt-oss:120b",
                  "models": [ { "id": "gpt-oss:120b", "contextTokens": 120000 },
                              { "id": "qwen:32b", "contextTokens": null } ] },
                "sessions": [ { "id": "s1", "modelSource": "local",
                                "localModelName": "qwen:32b", "localModelContext": 16000 } ] },
              { "key": "old", "device": "old", "online": true,
                "localModel": { "available": true, "model": "m" },
                "sessions": [ { "id": "s2", "modelSource": "local" } ] }
            ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val h = resp.agents[0]
        assertEquals("gpt-oss:120b", h.localModel?.defaultModel)
        assertEquals(2, h.localModel?.models?.size)
        assertEquals("qwen:32b", h.localModel?.models?.get(1)?.id)
        assertNull(h.localModel?.models?.get(1)?.contextTokens)   // bare OpenAI
        assertEquals("qwen:32b", h.sessions[0].localModelName)
        assertEquals(16000, h.sessions[0].localModelContext)
        // An older hub sends neither the list nor the per-session fields: they
        // default (empty list / null), never throw.
        val old = resp.agents[1]
        assertEquals(emptyList<Any>(), old.localModel?.models)
        assertNull(old.localModel?.defaultModel)
        assertNull(old.sessions[0].localModelName)
        assertNull(old.sessions[0].localModelContext)
    }

    // XERK-489 Phase 4: the context-fullness meter's numerator + denominator. Both
    // are typed Int? now, so the hub coerces them and this decode must accept the
    // figures and the absent (older-agent) shape.
    @Test fun `the context-meter fields decode`() {
        val body = """
            { "now": 1, "agents": [
              { "key": "h", "device": "h", "online": true,
                "sessions": [ { "id": "s1", "modelSource": "subscription",
                                "lastTurnContextTokens": 21500, "contextWindowTokens": 200000 },
                              { "id": "s2", "modelSource": "local" } ] }
            ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val s = resp.agents[0].sessions
        assertEquals(21500, s[0].lastTurnContextTokens)
        assertEquals(200000, s[0].contextWindowTokens)
        // A session with no measurement / an older agent: both null, never a throw.
        assertNull(s[1].lastTurnContextTokens)
        assertNull(s[1].contextWindowTokens)
    }

    // What hub-agent actually emits for a session that never moved:
    // `_session_payload` sends `modelSourceAt: sess.get("modelSourceAt")`, i.e.
    // a JSON null, on EVERY such session. A non-nullable field would throw and
    // take the whole fleet's decode with it.
    @Test fun `a null modelSourceAt does not break the decode`() {
        val body = """
            { "now": 1, "agents": [ { "key": "h", "device": "h", "online": true,
              "sessions": [ { "id": "s", "modelSource": "subscription", "modelSourceAt": null } ] } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        assertEquals("", resp.agents[0].sessions[0].modelSourceAt)
    }

    // The @Serializable DEFAULT, held on its own (XERK-262).
    //
    // The two cases either side of this one send `available` explicitly, so both
    // stayed green when a mutation pass flipped the default to `true` — and that
    // default is the whole contract for a block that arrives PRESENT but EMPTY.
    // Flipped, a host reporting `localModel: {}` reads fleet-wide as "can fail
    // over": the UI offers the switch, and the hub 409s every command it sends.
    // That is the exact inverse of the rule CLAUDE.md states — an absent flag
    // means "that agent can't do it", never "unlimited" — so the default is
    // load-bearing and gets a case that fails the moment it moves.
    @Test fun `an empty localModel block is not available`() {
        val body = """
            { "now": 1, "agents": [ { "key": "h", "device": "h", "online": true,
              "localModel": {} } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        val lm = resp.agents[0].localModel
        assertEquals(false, lm?.available)
        // The two it carries are null exactly when it is unavailable, so nothing
        // downstream can read them as a fallback for an unconfigured host.
        assertNull(lm?.model)
        assertNull(lm?.contextTokens)
    }

    // An agent predating the failover reports neither field. Absent must mean
    // "that host can't do it", which is what hides the control.
    @Test fun `an agent predating the failover decodes with no local model`() {
        val body = """
            { "now": 1, "agents": [ { "key": "h", "device": "h", "online": true,
              "sessions": [ { "id": "s" } ] } ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<AgentsResponse>(body)
        assertNull(resp.agents[0].localModel)
        assertEquals("", resp.agents[0].sessions[0].modelSource)
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

    // A two-host fleet whose SECOND host reports `input` as [figure] on three
    // different buckets — the shapes XERK-306 is about.
    private fun fleetWith(figure: String) = """
        { "now": 1, "agents": [
          { "key": "good", "device": "good", "online": true,
            "usage": { "totals": { "input": 7, "output": 0, "cacheWrite": 0, "cacheRead": 0 } } },
          { "key": "bad", "device": "bad", "online": true,
            "usage": {
              "totals": { "input": $figure, "output": 0, "cacheWrite": 0, "cacheRead": 0 },
              "days": { "2026-08-15": { "input": $figure } },
              "models": [ { "model": "opus", "totals": { "input": $figure } } ]
            } }
        ] }
    """.trimIndent()

    // XERK-306: a token figure is a Long here, so a FLOAT one anywhere in ANY
    // host's usage block throws for the WHOLE array — the poll fails silently,
    // the app keeps its last snapshot, and the tile still reads "N / N online".
    // The hub coerces every figure at ingest (normalizeUsageTokens in
    // turma/server.js); this pins both halves — that the raw shape really is
    // fatal, so that coercion is load-bearing rather than decorative, and that
    // the shape the hub serves in its place decodes with every host intact.
    //
    // The hub's rule is deliberately STRICTER than this decoder's: a negative
    // or a quoted figure decodes here (lenient mode reads `"9"` as 9) and is
    // still not a token count, so it is coerced too.
    @Test fun `a float token figure is fatal raw, and survives once the hub coerces it`() {
        val threw = try {
            TurmaJson.decodeFromString<AgentsResponse>(fleetWith("1.5"))
            false
        } catch (e: Exception) {
            true
        }
        assertTrue("a raw float figure must not decode — the hub has to coerce it", threw)

        // What the hub serves for that same host: the unusable figure zeroed,
        // every other host and every good figure untouched.
        val resp = TurmaJson.decodeFromString<AgentsResponse>(fleetWith("0"))
        assertEquals(listOf("good", "bad"), resp.agents.map { it.key })
        assertEquals(7L, resp.agents[0].usage!!.totals.input)
        assertEquals(0L, resp.agents[1].usage!!.totals.input)
        assertEquals(0L, resp.agents[1].usage!!.days["2026-08-15"]!!.input)
        assertEquals(0L, resp.agents[1].usage!!.models[0].totals.input)
    }

    @Test fun `a tool_use block decodes its SendUserFile files and caption (XERK-221)`() {
        val json = """
            {"t":"tool_use","id":"t1","name":"SendUserFile",
             "files":[{"name":"a.svg","kind":"image","src":"data:image/svg+xml;base64,PHN2Zy8+"},
                      {"name":"p.html","kind":"html","html":"<h1>Hi</h1>"},
                      {"name":"x.zip","kind":"file"}],
             "caption":"three files"}
        """.trimIndent()
        val block = TurmaJson.decodeFromString<Block>(json)
        assertTrue(block is ToolUseBlock)
        block as ToolUseBlock
        assertEquals("three files", block.caption)
        assertEquals(3, block.files.size)
        assertEquals("image", block.files[0].kind)
        assertEquals("data:image/svg+xml;base64,PHN2Zy8+", block.files[0].src)
        assertEquals("<h1>Hi</h1>", block.files[1].html)
        assertEquals("file", block.files[2].kind)
        // An older payload with no files/caption still decodes to the defaults.
        val plain = TurmaJson.decodeFromString<Block>("""{"t":"tool_use","id":"t2","name":"Bash"}""")
        assertTrue((plain as ToolUseBlock).files.isEmpty())
        assertEquals("", plain.caption)
    }
}
