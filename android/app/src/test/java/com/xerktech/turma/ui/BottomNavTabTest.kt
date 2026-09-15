package com.xerktech.turma.ui

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.xerktech.turma.TurmaApplication
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Regression for XERK-814: the Dashboard bottom-nav button sometimes landed on the
 * Sessions page and stayed stuck there until an app restart.
 *
 * `goTab` used popUpTo(DASHBOARD){saveState} + restoreState. The nav graph is flat,
 * so DASHBOARD is the start destination, the popUpTo anchor AND a navigated tab all
 * under one id — tapping Sessions saved the popped stack keyed "dashboard", and
 * tapping Dashboard restored that saved Sessions entry, landing on Sessions.
 *
 * Both the Dashboard and Sessions screens render a ScreenHeader title matching the
 * bottom-nav label, so the screen we are on shows its own label TWICE (header + nav)
 * and every other tab's label once (nav only).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BottomNavTabTest {

    @get:Rule
    val compose = createComposeRule()

    private val container get() =
        ApplicationProvider.getApplicationContext<TurmaApplication>().container

    @Before fun signIn() {
        // Configured, so TurmaApp starts on the Dashboard.
        container.config.save("http://localhost:1/", "op", "pw")
    }

    @After fun tearDown() {
        container.fleet.stop()
        container.config.clear()
    }

    private fun labelCount(label: String) =
        compose.onAllNodesWithText(label).fetchSemanticsNodes().size

    @Test fun dashboardTabAlwaysReturnsToTheDashboard() {
        compose.setContent {
            TurmaApp(
                container = container,
                wide = false,
                pendingDeepLink = null,
                onDeepLinkConsumed = {},
            )
        }
        compose.waitForIdle()
        // Start on the Dashboard: its label shows in the header AND the nav.
        assertEquals("should start on the Dashboard", 2, labelCount("Dashboard"))

        // Go to Sessions.
        compose.onNodeWithText("Sessions").performClick()
        compose.waitForIdle()
        assertEquals("Sessions tap should open the Sessions page", 2, labelCount("Sessions"))

        // Back to the Dashboard — must land on the Dashboard, not restore Sessions.
        compose.onNodeWithText("Dashboard").performClick()
        compose.waitForIdle()
        assertEquals("Dashboard tap must return to the Dashboard", 2, labelCount("Dashboard"))
        assertEquals("Dashboard tap must NOT leave us on Sessions", 1, labelCount("Sessions"))
    }
}
