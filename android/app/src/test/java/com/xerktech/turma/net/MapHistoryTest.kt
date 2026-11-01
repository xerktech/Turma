package com.xerktech.turma.net

import com.xerktech.turma.model.HistoryResponse
import com.xerktech.turma.model.TailEntry
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * /history answers three different things and the client has to tell them apart
 * (XERK-264): a 202 "the agent hasn't fetched it yet" (poll), a real transcript,
 * and a REFUSAL (stop and say so). A null body used to fold the third into the
 * first — an error body Retrofit couldn't decode as a history reply left
 * `body == null` — so a refused fetch polled 20 times over 60 seconds and then
 * gave up without a word, indistinguishable from a slow agent.
 */
class MapHistoryTest {

    private fun refusal(code: Int, body: String) = Response.error<HistoryResponse>(
        code, body.toResponseBody("application/json".toMediaType())
    )

    @Test fun `a refusal is Failed, in the hub's own words`() {
        val r = HubClient.mapHistory(refusal(429, """{"error":"the host's command queue is full"}"""))
        assertTrue(r is HubClient.HistoryResult.Failed)
        assertEquals("the host's command queue is full", (r as HubClient.HistoryResult.Failed).why)
    }

    @Test fun `a refusal with no explanation is still Failed, not Pending`() {
        // The whole point: an unreadable error body must never read as "not yet".
        val r = HubClient.mapHistory(refusal(503, "<html>gateway</html>"))
        assertTrue(r is HubClient.HistoryResult.Failed)
        assertEquals("the hub answered HTTP 503", (r as HubClient.HistoryResult.Failed).why)
    }

    @Test fun `a 202 is still Pending, and carries the command id to poll on`() {
        val r = HubClient.mapHistory(Response.success(202, HistoryResponse(pending = true, cmdId = "c-7")))
        assertEquals(HubClient.HistoryResult.Pending("c-7"), r)
    }

    @Test fun `a 200 pending body is Pending too`() {
        val r = HubClient.mapHistory(Response.success(HistoryResponse(pending = true, cmdId = "c-9")))
        assertEquals(HubClient.HistoryResult.Pending("c-9"), r)
    }

    @Test fun `a real answer is Ready`() {
        val entries = listOf(TailEntry(id = "e1", role = "assistant"))
        val r = HubClient.mapHistory(Response.success(HistoryResponse(entries = entries, truncated = true)))
        assertEquals(HubClient.HistoryResult.Ready(entries, true), r)
    }

    // XERK-2553: since tenancy a 404 is an unknown session OR another account's
    // (the hub answers both alike), so the app says so — keeping the hub's words.
    @Test fun `a 404 says the session may belong to another account`() {
        val r = HubClient.mapHistory(refusal(404, "{\"error\":\"unknown agent\"}"))
        val why = (r as HubClient.HistoryResult.Failed).why
        assertTrue(why.contains("another account"))
        assertTrue(why.contains("unknown agent"))
    }
}
