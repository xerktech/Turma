package com.xerktech.turma.ui

import androidx.navigation.navOptions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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
 * The actual round trip cannot be driven here: Robolectric's NavController does not
 * honor saveState/restoreState back-stack persistence, so a rendered-screen test
 * passes on the buggy code too (a false guard). Instead assert on the exact
 * [tabNavOptions] `goTab` uses — chiefly that restoreState is OFF, the flag whose
 * removal is the fix. This fails on the pre-fix options (restoreState = true) and
 * passes on the fix, so it is a real, mutation-sensitive guard.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class BottomNavTabTest {

    @Test fun tabSwitchDoesNotRestoreSavedBackStack() {
        val opts = navOptions(tabNavOptions())

        // The fix: no restore of a saved back stack (and nothing saves one), so a
        // tab tap can never land on a sibling tab held under the shared "dashboard"
        // key. This is the assertion that fails on the pre-fix restoreState = true.
        assertFalse("a tab switch must NOT restore a saved back stack", opts.shouldRestoreState())

        // The rest of the intended tab behavior: reuse the single tab entry, and pop
        // back to the Dashboard root (not inclusive) so detail routes are cleared and
        // Back from any tab lands on the Dashboard.
        assertTrue("a tab switch is single-top", opts.shouldLaunchSingleTop())
        assertEquals("pops back to the Dashboard root", TopDest.DASHBOARD.route, opts.popUpToRoute)
        assertFalse("keeps the Dashboard root itself", opts.isPopUpToInclusive())
    }
}
