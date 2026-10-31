package com.xerktech.turma.core

/**
 * Sign-in outcome classification (XERK-228), ported from the web login's own
 * branch on the /api/login status (turma/public/login.html): a hub that ANSWERS
 * and refuses the credentials is a different failure from a hub that never
 * answered, and the operator has to be told which.
 *
 * Pure so it is JVM-unit-tested; the probe that produces the status lives in
 * [com.xerktech.turma.net.HubClient.signIn].
 */
sealed interface SignInResult {
    /** The hub accepted these credentials. */
    data object Ok : SignInResult

    /** The hub answered and refused them — a wrong username or password. */
    data object BadCredentials : SignInResult

    /**
     * The hub ACCEPTED the password at /api/login, then refused the session it
     * issued (XERK-2569) — so the password is right and must not be called wrong.
     */
    data class SessionRefused(val code: Int) : SignInResult

    /** The hub answered with something else (a wrong URL's 404, a 5xx, …). */
    data class HttpError(val code: Int) : SignInResult

    /**
     * The hub throttled the sign-in (429/503 from /api/login, XERK-2576);
     * [message] is its own words plus the wait — see [loginRefusalMessage].
     */
    data class HubRefused(val message: String) : SignInResult

    /** Nothing answered: bad host, DNS/TLS failure, timeout, no route. */
    data object Unreachable : SignInResult
}

/**
 * Map the credential probe's HTTP status onto a [SignInResult]. 403 joins 401
 * because the hub's gate is single-user: anything it refuses outright, it
 * refuses because the credentials didn't match.
 */
fun signInResultFor(code: Int): SignInResult = when {
    code in 200..299 -> SignInResult.Ok
    code == 401 || code == 403 -> SignInResult.BadCredentials
    else -> SignInResult.HttpError(code)
}

/**
 * The message the login screen shows for a failed sign-in, or null when there
 * is nothing to say. The bad-credentials wording matches the web login's
 * "Incorrect username or password." verbatim.
 */
fun signInError(result: SignInResult): String? = when (result) {
    SignInResult.Ok -> null
    SignInResult.BadCredentials -> "Incorrect username or password."
    SignInResult.Unreachable -> "Could not reach the hub — check the URL."
    is SignInResult.SessionRefused ->
        "Password accepted, but the hub refused the session (HTTP ${result.code}). Please try again."
    is SignInResult.HttpError -> "Sign-in failed (HTTP ${result.code}). Please try again."
    is SignInResult.HubRefused -> result.message
}

/**
 * A throttled sign-in in the hub's own words [said] plus the `Retry-After`
 * wait (XERK-2576) — the web login's `refusalMessage`, worded identically so
 * the same refusal reads the same on both. Only delta-seconds is read; an
 * HTTP-date or zero Retry-After leaves the hub's words alone.
 */
fun loginRefusalMessage(said: String, retryAfter: String?): String {
    val secs = retryAfter?.trim()?.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLongOrNull() ?: 0L
    if (secs <= 0L) return said
    val wait = if (secs < 60) "${secs}s" else "${(secs + 59) / 60} min"
    return "$said (retry in $wait)"
}

/** The hub's login cookie name — `SESSION_COOKIE` in turma/server.js. */
const val SESSION_COOKIE = "hub_session"

/**
 * The `hub_session` token out of a `POST /api/login` answer's `Set-Cookie`
 * headers (XERK-2569), or null when none carries a non-empty one. Only the
 * `name=value` pair matters; the browser attributes (Path, SameSite, Secure,
 * Max-Age) are the hub's instructions to a browser and are ignored here.
 */
fun sessionTokenFrom(setCookies: List<String>): String? = setCookies.firstNotNullOfOrNull { header ->
    val pair = header.substringBefore(';').trim()
    val name = pair.substringBefore('=', missingDelimiterValue = "").trim()
    val value = pair.substringAfter('=', missingDelimiterValue = "").trim()
    value.takeIf { name == SESSION_COOKIE && it.isNotEmpty() }
}
