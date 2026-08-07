package com.xerktech.turma.core

/**
 * Sign-in outcome classification (XERK-228), ported from the web login's own
 * branch on the /api/login status (turma/public/login.html): a hub that ANSWERS
 * and refuses the credentials is a different failure from a hub that never
 * answered, and the operator has to be told which.
 *
 * Pure so it is JVM-unit-tested; the probe that produces the status lives in
 * [com.xerktech.turma.net.HubClient.probeCredentials].
 */
sealed interface SignInResult {
    /** The hub accepted these credentials. */
    data object Ok : SignInResult

    /** The hub answered and refused them — a wrong username or password. */
    data object BadCredentials : SignInResult

    /** The hub answered with something else (a wrong URL's 404, a 5xx, …). */
    data class HttpError(val code: Int) : SignInResult

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
    is SignInResult.HttpError -> "Sign-in failed (HTTP ${result.code}). Please try again."
}
