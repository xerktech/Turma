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
}
