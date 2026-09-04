package com.xerktech.turma.core

import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * Native-app OIDC (Authentik SSO) helpers, XERK-591. Pure + JVM-unit-tested so
 * the PKCE handoff — the security-critical half — is exercised offline.
 *
 * The Android app can't run the hub's browser-cookie OIDC flow: after the hub's
 * callback sets `hub_session` in the system browser, the app's own HTTP client
 * can't read that cookie. So the app opens the hub's `/auth/oidc/login` in a
 * Chrome Custom Tab (system browser → passkeys work) with a PKCE `mobile`
 * challenge; on success the hub deep-links back a single-use `code` the app
 * redeems (presenting its verifier) at `/api/oidc/mobile/exchange` for the same
 * opaque session token the web cookie carries. See .claude/rules/turma-oidc.md.
 */
object Oidc {
    /**
     * The deep link the hub redirects to at the end of the mobile flow. Must
     * match the hub's `TURMA_OIDC_MOBILE_REDIRECT` default AND the manifest
     * intent-filter (`scheme=turma`, `host=oidc-callback`).
     */
    const val REDIRECT = "turma://oidc-callback"

    /** A PKCE pair: a random verifier and its base64url(SHA-256) challenge. */
    data class Pkce(val verifier: String, val challenge: String)

    fun newPkce(random: SecureRandom = SecureRandom()): Pkce {
        val bytes = ByteArray(32).also(random::nextBytes)
        val verifier = b64url(bytes)
        return Pkce(verifier, challenge(verifier))
    }

    /**
     * base64url(SHA-256(verifier)) — byte-identical to the hub's `pkceChallenge`
     * (`crypto.createHash("sha256").update(verifier).digest("base64url")`), since
     * a base64url verifier is ASCII.
     */
    fun challenge(verifier: String): String =
        b64url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /** The Custom Tab URL that starts the hub's mobile OIDC flow. */
    fun loginUrl(baseUrl: String, challenge: String): String =
        baseUrl.trimEnd('/') + "/auth/oidc/login?mobile=" + URLEncoder.encode(challenge, "UTF-8")

    /** The outcome carried on the `turma://oidc-callback` deep link. */
    data class Callback(val code: String?, val error: String?)

    /**
     * Parse the deep-link query (`code=…` or `error=…`) WITHOUT android.net.Uri
     * so it stays pure/JVM-testable. Accepts a full `turma://…?code=x` link or a
     * bare query string.
     */
    fun parseCallback(link: String): Callback {
        val q = link.substringAfter('?', "")
        var code: String? = null
        var error: String? = null
        for (pair in q.split('&')) {
            if (pair.isEmpty()) continue
            val k = pair.substringBefore('=')
            val v = decode(pair.substringAfter('=', ""))
            when (k) {
                "code" -> code = v.ifEmpty { null }
                "error" -> error = v.ifEmpty { null }
            }
        }
        return Callback(code, error)
    }

    private fun b64url(b: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(b)

    private fun decode(s: String): String =
        runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
}
