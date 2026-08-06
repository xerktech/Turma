package com.xerktech.turma.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response

/**
 * A refusal the hub explained must reach the operator in its own words — the
 * chat composer's "message too long" (XERK-227) is a length problem the operator
 * can fix, and reporting it as "hub unreachable" sends them hunting for a
 * network fault instead. Retrofit throws the body away as an [HttpException],
 * so [hubErrorMessage] is what digs it back out.
 */
class HubErrorMessageTest {

    private fun refusal(code: Int, body: String) = HttpException(
        Response.error<Any>(code, body.toResponseBody("application/json".toMediaType()))
    )

    @Test fun `the hub's own error text is surfaced`() {
        val e = refusal(413, """{"error":"message too long — 120,000 characters, the limit is 100,000"}""")
        assertEquals("message too long — 120,000 characters, the limit is 100,000", hubErrorMessage(e))
    }

    @Test fun `a body with no error text reads as no message`() {
        assertNull(hubErrorMessage(refusal(500, """{"ok":false}""")))
        assertNull(hubErrorMessage(refusal(502, "<html>bad gateway</html>")))
    }

    @Test fun `a transport failure has no hub message at all`() {
        assertNull(hubErrorMessage(java.io.IOException("connection reset")))
    }
}
