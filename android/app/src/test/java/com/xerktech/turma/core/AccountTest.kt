package com.xerktech.turma.core

import com.xerktech.turma.model.Me
import com.xerktech.turma.model.TurmaJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** XERK-2553: the signed-in label, the admin-only gate, and the `/api/me` decode. */
class AccountTest {

    @Test fun `the label names the account, and nothing when the hub named nobody`() {
        assertEquals("Signed in as alice", meLabel(Me(name = "alice")))
        assertEquals("", meLabel(Me(name = "")))
        assertEquals("", meLabel(null))
    }

    @Test fun `only an explicit admin-only answer is admin-only`() {
        assertTrue(isAdminOnly(Me(roles = listOf("admin"), adminOnly = true)))
        assertFalse(isAdminOnly(Me(roles = listOf("user", "admin"), tenant = true)))
        assertFalse(isAdminOnly(null)) // older hub / not answered: the app as it always was
    }

    @Test fun `the hub's answer decodes, unknown keys and missing fields included`() {
        val me = TurmaJson.decodeFromString(Me.serializer(),
            """{"kind":"user","name":"Alice","source":"oidc","roles":["user"],"tenant":true,"adminOnly":false,"later":1}""")
        assertEquals(Me("user", "Alice", "oidc", listOf("user"), tenant = true, adminOnly = false), me)
        assertEquals(Me(kind = "breakglass"), TurmaJson.decodeFromString(Me.serializer(), """{"kind":"breakglass"}"""))
    }

    @Test fun `a session 404 says it may be another account's, in the hub's words too`() {
        val m = sessionUnavailableMessage("unknown agent")
        assertTrue(m.contains("another account"))
        assertTrue(m.endsWith("(unknown agent)."))
    }
}
