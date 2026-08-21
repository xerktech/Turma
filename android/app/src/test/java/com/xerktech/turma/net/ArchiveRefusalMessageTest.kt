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
 * Why an archived transcript is missing (XERK-356). "Not here yet" and "the hub
 * refused the push" look identical to the operator, and the ended-session view
 * words the first as "it syncs within a few minutes of ending" — a promise that
 * a refusal makes untrue forever, so the operator goes on waiting for a
 * conversation that is never coming.
 *
 * Everything here degrades to null, which is that old wording: the reason has to
 * be positively present and legible before this pane claims a refusal happened.
 */
class ArchiveRefusalMessageTest {

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
            archiveRefusalMessage(missing(404, refused)),
        )
    }

    @Test fun `an ordinary not-here-yet 404 says nothing`() {
        assertNull(archiveRefusalMessage(missing(404, """{"error":"unknown transcript"}""")))
        assertNull(archiveRefusalMessage(missing(404, """{"error":"unknown transcript","refused":null}""")))
        // Present but empty is not a reason either — it would render as a
        // refusal with a blank explanation, which says less than the fallback.
        assertNull(archiveRefusalMessage(missing(404, """{"refused":{"host":"nas","error":"  "}}""".trimIndent())))
    }

    @Test fun `only a 404 carries this, and only over HTTP`() {
        assertNull(archiveRefusalMessage(missing(500, refused)))
        assertNull(archiveRefusalMessage(missing(503, refused)))
        assertNull(archiveRefusalMessage(java.io.IOException("connection reset")))
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
            val msg = archiveRefusalMessage(missing(404, body))
            assertTrue("body $body", msg == null || msg.contains("was refused"))
        }
    }

    @Test fun `a reason with no host still reads as a sentence`() {
        val msg = archiveRefusalMessage(missing(404, """{"refused":{"error":"the hub could not store this chunk"}}"""))
        assertEquals(
            "The agent’s last push of this conversation to the archive was refused: " +
                "the hub could not store this chunk.",
            msg,
        )
    }
}
