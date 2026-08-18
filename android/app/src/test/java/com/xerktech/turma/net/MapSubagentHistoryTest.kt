package com.xerktech.turma.net

import com.xerktech.turma.model.HistoryResponse
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.model.WorkflowAgent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * XERK-304. `mapHistory` is shared by /history and /subagents/history, and it is
 * where a workflow run's agent list has to survive onto [HubClient.HistoryResult]
 * — the view decides between the picker and a transcript purely on whether
 * `agents` came through non-null, so dropping it there silently turns every
 * workflow row back into the empty conversation this ticket was filed for.
 */
class MapSubagentHistoryTest {

    @Test fun `a run's agent list survives onto Ready`() {
        val agents = listOf(WorkflowAgent(id = "a1", label = "review:bugs", status = "done"))
        val r = HubClient.mapHistory(
            Response.success(HistoryResponse(agents = agents, agentsTruncated = true)))
        assertTrue(r is HubClient.HistoryResult.Ready)
        val ready = r as HubClient.HistoryResult.Ready
        assertEquals(agents, ready.agents)
        assertTrue(ready.agentsTruncated)
    }

    @Test fun `an empty run stays non-null on the way through`() {
        val r = HubClient.mapHistory(Response.success(HistoryResponse(agents = emptyList())))
        val ready = r as HubClient.HistoryResult.Ready
        assertNotNull("empty is an answer, not an absence", ready.agents)
        assertTrue(ready.agents!!.isEmpty())
    }

    @Test fun `an ordinary transcript carries no agent list at all`() {
        val entries = listOf(TailEntry(id = "e1", role = "assistant"))
        val r = HubClient.mapHistory(Response.success(HistoryResponse(entries = entries)))
        val ready = r as HubClient.HistoryResult.Ready
        assertNull("presence is the signal — a transcript must not look like a run", ready.agents)
        assertEquals(entries, ready.entries)
    }
}
