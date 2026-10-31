package com.xerktech.turma.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LoginTest {

    // ---- signInResultFor -----------------------------------------------------

    @Test fun acceptsAnyTwoHundred() {
        assertEquals(SignInResult.Ok, signInResultFor(200))
        assertEquals(SignInResult.Ok, signInResultFor(204))
        assertEquals(SignInResult.Ok, signInResultFor(299))
    }

    // The whole point of XERK-228: a refusal must be its own outcome, not
    // folded into a generic failure the login screen shrugs at.
    @Test fun refusalIsBadCredentials() {
        assertEquals(SignInResult.BadCredentials, signInResultFor(401))
        assertEquals(SignInResult.BadCredentials, signInResultFor(403))
    }

    @Test fun otherStatusesAreHttpErrors() {
        assertEquals(SignInResult.HttpError(404), signInResultFor(404))
        assertEquals(SignInResult.HttpError(502), signInResultFor(502))
        assertEquals(SignInResult.HttpError(302), signInResultFor(302))
    }

    // ---- signInError ---------------------------------------------------------

    @Test fun successHasNoMessage() {
        assertNull(signInError(SignInResult.Ok))
    }

    // Verbatim the web login's wording (turma/public/login.html).
    @Test fun badCredentialsMatchesTheWebWording() {
        assertEquals("Incorrect username or password.", signInError(SignInResult.BadCredentials))
    }

    @Test fun unreachableBlamesTheUrlNotTheCredentials() {
        val msg = signInError(SignInResult.Unreachable)!!
        assertEquals("Could not reach the hub — check the URL.", msg)
    }

    @Test fun httpErrorNamesTheStatus() {
        assertEquals("Sign-in failed (HTTP 502). Please try again.", signInError(SignInResult.HttpError(502)))
    }

    // The password was accepted, so the wording must not call it wrong.
    @Test fun sessionRefusedDoesNotBlameThePassword() {
        val msg = signInError(SignInResult.SessionRefused(403))!!
        assertEquals("Password accepted, but the hub refused the session (HTTP 403). Please try again.", msg)
    }

    // ---- sessionTokenFrom (XERK-2569) ------------------------------------------

    @Test fun readsTheHubSessionOutOfSetCookie() {
        assertEquals(
            "tok-1",
            sessionTokenFrom(listOf("hub_session=tok-1; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000")),
        )
    }

    @Test fun skipsOtherCookies() {
        assertEquals("tok-2", sessionTokenFrom(listOf("other=x; Path=/", "hub_session=tok-2; Path=/")))
        assertNull(sessionTokenFrom(listOf("not_hub_session=x; Path=/")))
    }

    // A logout's cleared cookie (empty value) is not a session.
    @Test fun emptyOrMissingIsNull() {
        assertNull(sessionTokenFrom(listOf("hub_session=; Path=/; Max-Age=0")))
        assertNull(sessionTokenFrom(emptyList()))
        assertNull(sessionTokenFrom(listOf("garbage")))
    }

    // ---- loginRefusalMessage (XERK-2576) — mirrors login.html's refusalMessage --

    @Test fun throttledSignInReadsInTheHubsWordsWithTheWait() {
        assertEquals(
            "too many sign-ins in progress — try again in a moment (retry in 1s)",
            loginRefusalMessage("too many sign-ins in progress — try again in a moment", "1"),
        )
        assertEquals(
            "too many failed sign-ins — try again later (retry in 5 min)",
            loginRefusalMessage("too many failed sign-ins — try again later", "300"),
        )
        assertEquals("slow down (retry in 2 min)", loginRefusalMessage("slow down", "61"))
        assertEquals("slow down (retry in 59s)", loginRefusalMessage("slow down", "59"))
        assertEquals("slow down (retry in 1 min)", loginRefusalMessage("slow down", "60"))
        assertEquals("slow down", loginRefusalMessage("slow down", "99999999999999999999999"))
        assertEquals("slow down", loginRefusalMessage("slow down", "\u0661\u0662"))
        assertEquals("slow down", loginRefusalMessage("slow down", null))
        assertEquals("slow down", loginRefusalMessage("slow down", "0"))
        assertEquals("slow down", loginRefusalMessage("slow down", "Wed, 21 Oct 2026 07:28:00 GMT"))
        assertEquals("slow down", signInError(SignInResult.HubRefused("slow down")))
    }
}
