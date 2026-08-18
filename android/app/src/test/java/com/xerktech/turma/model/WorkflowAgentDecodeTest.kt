package com.xerktech.turma.model

import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * XERK-304. A Workflow row in a session's background-agent list is N agents, not
 * one conversation, so `/subagents/history` answers it with the RUN's agent list
 * instead of a transcript.
 *
 * The whole contract rests on one thing: **`agents` PRESENT — the empty list
 * included — is what says "this is a run"**. An absent field means the row did
 * not resolve. Folding the two together loses the difference between "this run
 * hasn't started anything yet" and "this row is broken", so these pin the decode
 * that keeps them apart.
 */
class WorkflowAgentDecodeTest {

    @Test fun `an absent agents field decodes to null, not an empty list`() {
        val body = """{ "entries": [], "truncated": false }"""
        val resp = TurmaJson.decodeFromString<HistoryResponse>(body)
        assertNull("absent must stay distinguishable from empty", resp.agents)
    }

    @Test fun `an empty agents list decodes to an empty list, not null`() {
        val body = """{ "entries": [], "truncated": false, "agents": [] }"""
        val resp = TurmaJson.decodeFromString<HistoryResponse>(body)
        assertNotNull("a started run with nothing written yet is an ANSWER", resp.agents)
        assertTrue(resp.agents!!.isEmpty())
    }

    @Test fun `a populated run decodes every row`() {
        val body = """
            { "entries": [], "truncated": false, "agentsTruncated": true,
              "agents": [
                { "id": "a1", "label": "review:bugs", "startedAt": "2026-08-18T03:31:07.583Z", "status": "done" },
                { "id": "a2", "label": "verify:auth.ts", "startedAt": "2026-08-18T03:31:09.349Z", "status": "running" }
              ] }
        """.trimIndent()
        val resp = TurmaJson.decodeFromString<HistoryResponse>(body)
        val agents = resp.agents
        assertNotNull(agents)
        assertEquals(listOf("a1", "a2"), agents!!.map { it.id })
        assertEquals("review:bugs", agents[0].label)
        assertEquals("running", agents[1].status)
        assertTrue(resp.agentsTruncated)
    }

    @Test fun `a row with no status decodes to blank rather than throwing`() {
        // The agent OMITS status when the run's journal cannot say. That absence
        // is the "can't tell" value, and it must not be decode-fatal.
        val body = """{ "agents": [ { "id": "a1", "label": "did a thing" } ] }"""
        val resp = TurmaJson.decodeFromString<HistoryResponse>(body)
        assertEquals("", resp.agents!![0].status)
    }
}
