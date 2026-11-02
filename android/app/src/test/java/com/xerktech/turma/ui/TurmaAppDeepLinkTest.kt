package com.xerktech.turma.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isSelected
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

    /**
     * A "N proposals from <meeting>" push carries only a click path (rollup
     * XERK-2602): tapping it must land on Brief's Meetings pane (XERK-2623).
     * `deepLinkBriefPane` is pinned alone in `BottomNavTabTest`; this pins the
     * effect that acts on it. It asserts the selected pane, not the pane's content:
     * the screen's default `viewModel()` can hold an earlier test's fleet.
     */
    @Test fun aMeetingsPushOpensTheMeetingsTab() {
        container.config.save("http://localhost:1/", "op", "pw")
        var consumed = false
        compose.setContent {
            TurmaApp(
                container = container,
                wide = false,
                pendingDeepLink = MainActivity.DeepLink(null, null, "/brief?site=o.atlassian.net#meetings"),
                onDeepLinkConsumed = { consumed = true },
            )
        }
        compose.waitForIdle()
        assertTrue("the meetings link must be consumed", consumed)
        compose.onAllNodes(hasText("Meetings", substring = true) and isSelected()).assertCountEquals(1)
    }

    /** A click path naming no tab is consumed but moves nothing: the app stays on the Dashboard. */
    @Test fun aPushNamingNoTabStaysOnTheDashboard() {
        container.config.save("http://localhost:1/", "op", "pw")
        var consumed = false
        compose.setContent {
            TurmaApp(
                container = container,
                wide = false,
                pendingDeepLink = MainActivity.DeepLink(null, null, "/board?ticket=X-1"),
                onDeepLinkConsumed = { consumed = true },
            )
        }
        compose.waitForIdle()
        assertTrue("the link must be consumed", consumed)
        compose.onAllNodes(hasText("Meetings", substring = true) and isSelected()).assertCountEquals(0)
    }
}
