package com.xerktech.turma.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import com.xerktech.turma.MainActivity
import com.xerktech.turma.TurmaApplication
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A notification tapped while the user is SIGNED OUT must still open its session
 * once they log in. The deep-link effect used to call `onDeepLinkConsumed()`
 * unconditionally — even when it skipped the navigation because the app wasn't
 * configured yet — so the pending link was thrown away and the session never
 * opened after sign-in. It must now hold the link until `configured` flips true.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TurmaAppDeepLinkTest {

    @get:Rule
    val compose = createComposeRule()

    private val container get() =
        ApplicationProvider.getApplicationContext<TurmaApplication>().container

    @After fun tearDown() {
        container.fleet.stop()
        container.config.clear()
    }

    @Test fun aDeepLinkTappedWhileSignedOutOpensAfterLogin() {
        container.config.clear() // signed out
        var consumed = false
        compose.setContent {
            TurmaApp(
                container = container,
                wide = false,
                pendingDeepLink = MainActivity.DeepLink("nas01", "sess-1", null),
                onDeepLinkConsumed = { consumed = true },
            )
        }
        compose.waitForIdle()
        assertFalse("a deep link must NOT be consumed while signed out", consumed)

        // Sign in: configured flips true, the effect re-runs and navigates.
        compose.runOnUiThread { container.config.save("http://localhost:1/", "op", "pw") }
        compose.waitForIdle()
        assertTrue("the held deep link must be consumed once signed in", consumed)
    }
}
