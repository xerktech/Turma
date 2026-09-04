package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Native SSO PKCE + deep-link helpers (XERK-591). The challenge must be
 * byte-identical to the hub's `pkceChallenge` or the exchange refuses every
 * mobile sign-in — pinned against the RFC 7636 Appendix B vector, the same one
 * the hub's node test uses.
 */
class OidcTest {

    // RFC 7636 Appendix B: verifier -> base64url(SHA-256(verifier)) challenge.
    private val RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    private val RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

    @Test fun `challenge is base64url SHA-256 of the verifier (RFC 7636 vector)`() {
        assertEquals(RFC_CHALLENGE, Oidc.challenge(RFC_VERIFIER))
    }

    @Test fun `newPkce produces a verifier whose challenge round-trips`() {
        val p = Oidc.newPkce()
        assertTrue("verifier is non-trivial", p.verifier.length >= 40)
        assertEquals(p.challenge, Oidc.challenge(p.verifier))
        // base64url, no padding.
        assertTrue(p.verifier.none { it == '+' || it == '/' || it == '=' })
        assertTrue(p.challenge.none { it == '+' || it == '/' || it == '=' })
        // Fresh each call.
        assertTrue(p.verifier != Oidc.newPkce().verifier)
    }

    @Test fun `loginUrl carries the mobile challenge and a single slash`() {
        assertEquals(
            "https://hub.test/auth/oidc/login?mobile=abc",
            Oidc.loginUrl("https://hub.test/", "abc"),
        )
        assertEquals(
            "https://hub.test/auth/oidc/login?mobile=a%2Bb",
            Oidc.loginUrl("https://hub.test", "a+b"),
        )
    }

    @Test fun `parseCallback reads a code, an error, or neither`() {
        assertEquals("the-code", Oidc.parseCallback("turma://oidc-callback?code=the-code").code)
        assertNull(Oidc.parseCallback("turma://oidc-callback?code=the-code").error)
        assertEquals("forbidden", Oidc.parseCallback("turma://oidc-callback?error=forbidden").error)
        assertNull(Oidc.parseCallback("turma://oidc-callback?error=forbidden").code)
        val neither = Oidc.parseCallback("turma://oidc-callback")
        assertNull(neither.code)
        assertNull(neither.error)
    }

    @Test fun `parseCallback url-decodes values`() {
        assertEquals("a b", Oidc.parseCallback("turma://oidc-callback?code=a%20b").code)
    }
}
