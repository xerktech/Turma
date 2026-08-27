package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.FleetViewModel
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Sessions pane's spawn path and its snackbar (XERK-262).
 *
 * Two escapes live on this one flow, and neither is reachable from a pure test:
 *
 *  - `localModel = ModelSource.hostLocalModel(fleet.agents, host)` handed to the
 *    spawn composer. `hostLocalModel` is pure and tested; setting the ARGUMENT
 *    to `null` at the call site silently takes the row away, which is the same
 *    "built over the wrong loop" shape this repo has shipped before.
 *  - the `LaunchedEffect` collecting `vm.messages` into the snackbar. Deleting
 *    it makes every action fired from this pane silent again — and this pane's
 *    first-class refusal is a 409 saying the host has no local model, so a
 *    refusal you cannot see is worse than no control at all.
 *
 * Both are asserted through the screen, because at the call site there is
 * nothing else to assert on.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SessionsPaneSpawnTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    /** The host every test spawns on — deliberately the SECOND in key order. */
    private val host = "zzz-target"

    private val withModel = """"localModel": { "available": true, "model": "qwen3-coder", "contextTokens": 128000 },"""

    /**
     * Two online hosts, and the composer is always opened on the second.
     *
     * The `null` half of this defect is not the only shape: a lookup built over
     * the wrong loop — reading the fleet's FIRST host rather than the one being
     * spawned on — is one this repo has shipped before. A single-host fixture
     * cannot tell the two apart, so [otherHasModel] puts the opposite answer on
     * the host that sorts first and every case here would fail on that rewiring
     * too.
     */
    private fun openComposer(targetHasModel: Boolean, otherHasModel: Boolean = !targetHasModel) {
        hub.seedFleet(
            """
            { "now": 1, "agents": [
              { "key": "aaa-other", "device": "aaa-other", "online": true,
                ${if (otherHasModel) withModel else ""}
                "repos": [ { "name": "Otherrepo", "lastActivity": "2026-08-12T00:00:00Z" } ],
                "sessions": [] },
              { "key": "$host", "device": "$host", "online": true,
                ${if (targetHasModel) withModel else ""}
                "repos": [ { "name": "Targetrepo", "lastActivity": "2026-08-12T00:00:00Z" } ],
                "sessions": [] }
            ] }
            """.trimIndent()
        )
        compose.setContent {
            SessionsListPane(
                selectedKey = null,
                onSelect = { _, _ -> },
                vm = FleetViewModel(hub.app),
            )
        }
        compose.onNodeWithContentDescription("New session").performClick()
        compose.onNodeWithText("Targetrepo").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("New session · Targetrepo").assertIsDisplayed()
    }

    /** The target host reports one, so the composer offers the row. */
    @Test
    fun `the composer offers the target host's self-hosted model`() {
        openComposer(targetHasModel = true)
        compose.onNodeWithText("Runtime").performScrollTo().assertIsDisplayed()
    }

    /** It does not, so the row is hidden rather than shown-and-refused. */
    @Test
    fun `the composer hides the row for a host reporting none`() {
        openComposer(targetHasModel = false)
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
    }

    /**
     * The hub's refusal reaches the operator's eyes. This is the assertion the
     * deleted snackbar collector fails: the spawn still POSTs, the ViewModel
     * still emits, and absolutely nothing appears on screen.
     */
    @Test
    fun `a refused spawn is shown to the operator`() {
        hub.route("/api/agents/$host/sessions") {
            HubHarness.refusal("host has no local model configured")
        }
        openComposer(targetHasModel = true)
        compose.onNodeWithText("Spawn").performClick()

        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodesWithText("✗ host has no local model configured")
                .fetchSemanticsNodes().isNotEmpty()
        }
    }

    /** And so does the acceptance, so the test above cannot pass on a blank. */
    @Test
    fun `an accepted spawn is shown to the operator`() {
        hub.json("/api/agents/$host/sessions", """{"ok":true}""")
        openComposer(targetHasModel = false)
        compose.onNodeWithText("Spawn").performClick()

        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodesWithText("✓ session queued")
                .fetchSemanticsNodes().isNotEmpty()
        }
    }
}
