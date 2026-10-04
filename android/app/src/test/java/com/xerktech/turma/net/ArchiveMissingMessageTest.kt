package com.xerktech.turma.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * Why an archived transcript is missing (XERK-356, XERK-1283). "Not here yet" and "the hub
 * refused the push" look identical to the operator, and the ended-session view
 * words the first as "it syncs within a few minutes of ending" — a promise that
 * a refusal makes untrue forever, so the operator goes on waiting for a
 * conversation that is never coming.
 *
 * A 404 degrades to null, which is that old wording: the reason has to be
 * positively present and legible before this pane claims one. Anything that is
 * not a 404 is a failed load, never "not yet".
 */
class ArchiveMissingMessageTest {

    private fun missing(code: Int, body: String) = HttpException(
        Response.error<Any>(code, body.toResponseBody("application/json".toMediaType()))
    )

    private val refused = """
        {"error":"unknown transcript","refused":{"host":"nas","at":1787141740775,
         "error":"archive chunk is larger than this hub takes (2097152 bytes)"}}
    """.trimIndent()

    @Test fun `the hub's own reason names the host that failed`() {
        assertEquals(
            "nas’s last push of this conversation to the archive was refused: " +
                "archive chunk is larger than this hub takes (2097152 bytes).",
            archiveMissingMessage(missing(404, refused)),
        )
    }

    @Test fun `an ordinary not-here-yet 404 says nothing`() {
        assertNull(archiveMissingMessage(missing(404, """{"error":"unknown transcript"}""")))
        assertNull(archiveMissingMessage(missing(404, """{"error":"unknown transcript","refused":null}""")))
        // Present but empty is not a reason either — it would render as a
        // refusal with a blank explanation, which says less than the fallback.
        assertNull(archiveMissingMessage(missing(404, """{"refused":{"host":"nas","error":"  "}}""".trimIndent())))
    }

    @Test fun `a non-404 is a failed load in the hub's words, never not-yet`() {
        assertEquals(
            "Couldn\u2019t load this conversation \u2014 archive index is still syncing on this replica \u2014 retry.",
            archiveMissingMessage(missing(503, """{"error":"archive index is still syncing on this replica \u2014 retry"}""")),
        )
        assertEquals(
            "Couldn\u2019t load this conversation \u2014 the hub answered HTTP 502.",
            archiveMissingMessage(missing(502, "<html>bad gateway</html>")),
        )
        // A refusal riding a non-404 is not this record — the status wins.
        assertTrue(archiveMissingMessage(missing(500, refused))!!.startsWith("Couldn\u2019t load"))
        assertEquals(
            "Couldn\u2019t load this conversation from the hub.",
            archiveMissingMessage(java.io.IOException("connection reset")),
        )
    }

    @Test fun `closed ingest says since when, and drops the few-minutes promise`() {
        val now = 1_790_000_000_000L
        val since = now - 3 * 86_400_000L
        val msg = archiveMissingMessage(
            missing(404, """{"error":"unknown transcript","ingestClosed":{"since":$since}}"""), now,
        )!!
        assertTrue(msg, msg.startsWith("The hub has not been accepting archive pushes since "))
        assertTrue(msg, msg.contains("(3d ago)"))
        assertTrue(msg, msg.endsWith("can\u2019t reach the archive until it does."))
    }

    @Test fun `a refusal and closed ingest are both said`() {
        val msg = archiveMissingMessage(missing(404,
            """{"refused":{"host":"nas","error":"too big"},"ingestClosed":{"since":1}}"""), 2_000L)!!
        assertTrue(msg, msg.startsWith("nas\u2019s last push"))
        assertTrue(msg, msg.contains("not been accepting archive pushes"))
    }

    @Test fun `a garbage since is the plain not-yet`() {
        for (since in listOf("0", "-5", "\"x\"", "null", "1e999")) {
            assertNull(since, archiveMissingMessage(missing(404, """{"ingestClosed":{"since":$since}}""")))
        }
        assertNull(archiveMissingMessage(missing(404, """{"ingestClosed":"yes"}""")))
        assertNull(archiveMissingMessage(missing(404, """{"ingestClosed":{"since":1e20}}""")))
    }

    @Test fun `a malformed ingestClosed never takes the refusal down with it`() {
        for (closed in listOf("\"yes\"", "{\"since\":\"<b>x</b>\"}", "{\"since\":{}}")) {
            val msg = archiveMissingMessage(missing(404,
                """{"refused":{"host":"nas","error":"too big"},"ingestClosed":$closed}"""))
            assertEquals(closed, "nas\u2019s last push of this conversation to the archive was refused: too big.", msg)
        }
    }

    @Test fun `a malformed or surprising body degrades instead of throwing`() {
        for (body in listOf(
            "", "not json at all", "[]", """{"refused":"a string"}""",
            """{"refused":[1,2,3]}""", """{"refused":{"host":7,"error":"x"}}""",
            """{"refused":{"error":"x","at":1e999}}""",
            """{"refused":{"host":"nas","error":"x","unknown":"key"}}""",
        )) {
            // Never throws — a decode failure here would replace the transcript
            // pane with a crash instead of a sentence.
            val msg = archiveMissingMessage(missing(404, body))
            assertTrue("body $body", msg == null || msg.contains("was refused"))
        }
    }

    @Test fun `a reason with no host still reads as a sentence`() {
        val msg = archiveMissingMessage(missing(404, """{"refused":{"error":"the hub could not store this chunk"}}"""))
        assertEquals(
            "The agent’s last push of this conversation to the archive was refused: " +
                "the hub could not store this chunk.",
            msg,
        )
    }
}
