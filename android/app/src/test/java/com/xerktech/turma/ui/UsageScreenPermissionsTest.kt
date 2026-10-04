package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.hasScrollToKeyAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToKey
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.UsageViewModel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Usage screen's WIRING of the permission section (XERK-1576): the screen
 * itself starts the org-scoped `/api/permissions` watch and lays the section in
 * as its "permissions" row. [PermissionsSectionTest] covers the section's own
 * states in isolation; this only proves the screen reaches it. The header is
 * asserted rather than a fetched row, so the assertion never races the
 * OkHttp-thread settle against the paint (see TrajectoryScreenTest).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UsageScreenPermissionsTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    // The screen starts the fleet poller + SSE on the app scope; stop them so they
    // do not outlive this test in the shared JVM.
    @After fun stopFleet() = hub.container.fleet.stop()

    @Test
    fun `the screen fetches the org's prompts and shows the section as its permissions row`() {
        hub.json("/api/permissions", """{"days":7,"top":[],"recent":[]}""")
        hub.container.org.set(setOf("acme"))
        hub.seedFleet(HubHarness.fleetJson(jira = """{"siteKey":"acme","site":"Acme"}"""))
        val vm = UsageViewModel(hub.app)
        compose.setContent { UsageScreen(vm = vm) }
        compose.waitForIdle()

        // The screen's own LaunchedEffect started the watch: the scoped read went out.
        val req = hub.findRequest("/api/permissions")
        assertEquals("acme", req.requestUrl?.queryParameter("org"))
        assertEquals("7", req.requestUrl?.queryParameter("days"))

        // The section is the list's "permissions" row (scrolled to: it sits below the fold).
        compose.onNode(hasScrollToKeyAction()).performScrollToKey("permissions")
        compose.waitForIdle()
        compose.onNodeWithText("Permission prompts (7 days)").assertExists()
    }
}
