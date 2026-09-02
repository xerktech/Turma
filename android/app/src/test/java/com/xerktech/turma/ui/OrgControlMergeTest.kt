package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.harness.HubHarness
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Call-site tests for the org control's per-org auto-MERGE switch (XERK-550 /
 * closed by XERK-564) — the second switch beside auto-start the web has carried
 * and Android lacked (`android/PARITY.md`).
 *
 * The pure read is pinned in [com.xerktech.turma.core.BoardTest] (`autoMergeOn`);
 * these gate the COMPOSE wiring — that the "merge" switch actually renders in the
 * menu row, reads its OWN `autoMergeOrgs` map (not auto-start's), and POSTs the
 * hub's `/automerge` wire shape when tapped.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class OrgControlMergeTest {

    // No MainDispatcherRule here (unlike the other UI tests): OrgFilterAction
    // surfaces vm.messages through a real Toast, and an unconfined Main dispatcher
    // resumes that collector inline on OkHttp's response thread — where Toast
    // throws "not called Looper.prepare()". Left on the real Main dispatcher, the
    // emit dispatches to the main looper (as in production) and never runs on a
    // background thread.
    @get:Rule(order = 0)
    val hub = HubHarness()

    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<ComponentActivity>()

    // One online host reporting an org, auto-start ON for it and auto-merge OFF —
    // so the two switches must read INDEPENDENT maps or the merge one reads ON by
    // mistake.
    private fun fleet(autoMerge: String) = """
        {"now": 1, "agents": [{"key": "nas01", "device": "nas01",
          "online": true, "terminalOnline": true,
          "repos": [{"name": "Turma", "lastActivity": "2026-08-12T00:00:00Z"}],
          "sessions": [],
          "jira": {"available": true, "configured": true, "site": "Acme", "siteKey": "acme",
            "user": "op", "fetchedAt": "2026-09-01T00:00:00Z", "source": "jira",
            "tickets": [{"key": "XERK-1", "summary": "T", "status": "To Do",
              "statusCategory": "todo", "project": "XERK"}]}}],
          "autoStartOrgs": {"acme": true}, "autoMergeOrgs": $autoMerge}
    """.trimIndent()

    private fun open(autoMerge: String = "{}") {
        hub.seedFleet(fleet(autoMerge))
        compose.setContent { OrgFilterAction() }
        compose.waitForIdle()
        // The header button reads "All orgs" (nothing scoped) — open the menu.
        compose.onNodeWithText("All orgs").performClick()
        compose.waitForIdle()
    }

    @Test fun `the org row shows both the auto and merge switches`() {
        open()
        compose.onNodeWithText("auto").assertIsDisplayed()
        compose.onNodeWithText("merge").assertIsDisplayed()
        // auto (rendered first) then merge — exactly two toggles on the one row.
        compose.onAllNodes(isToggleable()).assertCountEquals(2)
    }

    @Test fun `tapping merge POSTs the automerge wire shape, independent of auto-start`() {
        hub.route("/api/jira/acme/automerge") {
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/json").setBody("""{"ok":true}""")
        }
        open()
        // The merge switch is the SECOND toggle in the row (auto renders first).
        compose.onAllNodes(isToggleable())[1].performClick()
        compose.waitForIdle()
        val req = hub.findRequest("/api/jira/acme/automerge")
        assertTrue("must be a POST", req.method == "POST")
        // Off -> on, so the body enables it — and it is the merge route, not autostart.
        val body = req.body.readUtf8()
        assertTrue("body enables merge: $body", body.contains("\"enabled\":true"))
    }
}
