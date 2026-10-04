package com.xerktech.turma.vm

import com.xerktech.turma.net.PermissionPolicyResponse
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/**
 * How the board's permission policy sheet (XERK-1566) reads the route's answer
 * — board.html `permissionRequest`'s rules: a 2xx is authoritative, an absent
 * `text` is empty, an absent `isDefault` is the default, and a refusal carries
 * the hub's own `{error}` (XERK-264) or the shared "the hub answered HTTP <n>".
 */
class PermissionPolicyResultTest {

    private fun refusal(code: Int, body: String) = Response.error<PermissionPolicyResponse>(
        code, body.toResponseBody("application/json".toMediaType()),
    )

    @Test fun `a 200 is the org's text and its default flag`() {
        val r = permissionPolicyResult(Response.success(PermissionPolicyResponse(ok = true, text = "Allow x.", isDefault = false)))
        assertNull(r.error)
        assertEquals("Allow x.", r.text)
        assertFalse(r.isDefault)
    }

    @Test fun `absent fields read as an empty default text`() {
        val r = permissionPolicyResult(Response.success(PermissionPolicyResponse(ok = true)))
        assertNull(r.error)
        assertEquals("", r.text)
        assertTrue(r.isDefault)
    }

    @Test fun `a saved empty text stays empty and custom`() {
        // "" is the operator switching the judge off for the org — not the default.
        val r = permissionPolicyResult(Response.success(PermissionPolicyResponse(ok = true, text = "", isDefault = false)))
        assertEquals("", r.text)
        assertFalse(r.isDefault)
    }

    @Test fun `a refusal carries the hub's own words`() {
        val r = permissionPolicyResult(refusal(413, """{"error":"policy text is longer than 16000 characters","limit":16000}"""))
        assertEquals("policy text is longer than 16000 characters", r.error)
    }

    @Test fun `a refusal with no readable body names the status`() {
        assertEquals("the hub answered HTTP 502", permissionPolicyResult(refusal(502, "<html>bad gateway</html>")).error)
    }
}
