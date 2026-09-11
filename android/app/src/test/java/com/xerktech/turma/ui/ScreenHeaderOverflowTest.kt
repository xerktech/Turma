package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import com.xerktech.turma.harness.HubHarness
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Plumbing guard for the shared [ScreenHeader] trailing-cluster fix (XERK-745).
 *
 * The cluster — New-ticket pill, org filter, page action icons, ⋮ overflow — is
 * a fixed, non-wrapping row. A long-named org used to expand the org button and
 * push the last action icon(s) and the ⋮ overflow (Sign out's only home) off a
 * phone screen. The fix makes the org control the FLEXIBLE member of the cluster:
 * [ScreenHeader] passes it `Modifier.weight(fill = false)` so the fixed trailing
 * controls are measured first and the org yields, ellipsizing its name.
 *
 * The VISUAL (does the ⋮ stay on-screen with a long org) is verified on the real
 * emulator, not here: Robolectric's text metrics don't match a device and its Row
 * squishes an over-constrained fixed child to zero instead of placing it past the
 * edge, so a bounds assertion measures no overflow and passes with OR without the
 * fix — the exact blind spot that shipped the PR #669 overflow unseen
 * (`android-emulator-drive`). What IS faithfully testable, and is the regression
 * that would silently reintroduce the bug, is that the caller's layout [Modifier]
 * actually reaches [OrgFilterAction]'s root node — drop the param (as the
 * pre-fix code had it) and the header's weight is discarded, the org stops
 * yielding, and the overflow is back.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ScreenHeaderOverflowTest {

    // Real Main dispatcher, matching OrgControlMergeTest: OrgFilterAction surfaces
    // vm.messages through a real Toast, which throws off the main looper.
    @get:Rule(order = 0)
    val hub = HubHarness()

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private fun fleet() = """
        {"now": 1, "agents": [{"key": "k8x", "device": "k8x",
          "online": true, "terminalOnline": true,
          "repos": [{"name": "Turma", "lastActivity": "2026-08-12T00:00:00Z"}],
          "sessions": [],
          "jira": {"available": true, "configured": true, "site": "Big Org",
            "siteKey": "bigorg.atlassian.net", "user": "op",
            "fetchedAt": "2026-09-01T00:00:00Z", "source": "jira",
            "orgName": "malcolm.habeeb@gmail.com's Organization",
            "tickets": [{"key": "XERK-1", "summary": "T", "status": "To Do",
              "statusCategory": "todo", "project": "XERK"}]}}]}
    """.trimIndent()

    @Test fun `OrgFilterAction applies the caller's layout modifier to its root`() {
        hub.seedFleet(fleet())
        compose.setContent { OrgFilterAction(Modifier.testTag("orgControl")) }
        compose.waitForIdle()

        // The tag rides the same Modifier the header threads its weight through, so
        // its presence proves the control honours a caller layout modifier at all —
        // the plumbing the flex fix depends on. Ignoring the param drops both.
        compose.onNodeWithTag("orgControl").assertIsDisplayed()
    }
}
