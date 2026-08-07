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
}
