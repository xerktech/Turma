package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnySibling
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.FleetViewModel
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Dashboard's per-repo spawn composer and the host it reads (XERK-262).
 *
 * `ModelSource.hostLocalModel` picks the TARGET host's block rather than the
 * fleet's first, and is pure and already tested. The mutation that escaped set
 * the ARGUMENT to `null` at this call site: the "Runtime" row vanishes from
 * the Dashboard fleet-wide — the failover becomes unreachable from the screen
 * new work actually starts on — while every `hostLocalModel` assertion stays
 * green.
 *
 * Both cases seed TWO hosts and target the SECOND, so they fail not only on
 * `null` but on the other shape this repo has shipped before: a lookup built
 * over the wrong loop, reading the fleet's first host instead of the one being
 * spawned on.
 *
 * The host list is a `LazyColumn`, so a row below the fold is not merely
 * off-screen but UNCOMPOSED — `performScrollToNode` is what brings it into
 * existence, and `performScrollTo` (which works inside the dialog) cannot.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FleetSpawnLocalModelTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val withModel = """"localModel": { "available": true, "model": "qwen3-coder", "contextTokens": 128000 },"""

    /** Two online hosts, rendered in key order — `aaa-*` first, `zzz-*` second. */
    private fun seed(firstHasModel: Boolean, secondHasModel: Boolean) = hub.seedFleet(
        """
        { "now": 1, "agents": [
          { "key": "aaa-first", "device": "aaa-first", "online": true,
            ${if (firstHasModel) withModel else ""}
            "repos": [ { "name": "Firstrepo", "lastActivity": "2026-08-12T00:00:00Z" } ],
            "sessions": [] },
          { "key": "zzz-second", "device": "zzz-second", "online": true,
            ${if (secondHasModel) withModel else ""}
            "repos": [ { "name": "Secondrepo", "lastActivity": "2026-08-12T00:00:00Z" } ],
            "sessions": [] }
        ] }
        """.trimIndent()
    )

    private fun render() {
        compose.setContent {
            FleetScreen(onOpenChat = { _, _ -> }, vm = FleetViewModel(hub.app))
        }
        compose.waitForIdle()
    }

    /** Open the composer from [repo]'s OWN row, never whichever ＋ is nearest. */
    private fun openComposerFor(repo: String) {
        compose.onNode(hasScrollAction()).performScrollToNode(hasText(repo))
        compose.onNode(hasContentDescription("New session") and hasAnySibling(hasText(repo)))
            .performClick()
        compose.waitForIdle()
        compose.onNodeWithText("New session · $repo").assertIsDisplayed()
    }

    /**
     * The second host reports a model and the first does not, so a call site
     * reading the fleet's first host — or `null` — shows no row.
     */
    @Test
    fun `the composer offers the row for the host being spawned on`() {
        seed(firstHasModel = false, secondHasModel = true)
        render()
        openComposerFor("Secondrepo")
        compose.onNodeWithText("Runtime").performScrollTo().assertIsDisplayed()
    }

    /**
     * The mirror image: the FIRST host reports one and the target does not, so a
     * call site reading the wrong host would wrongly offer the row here.
     */
    @Test
    fun `the composer hides the row for a host with no self-hosted model`() {
        seed(firstHasModel = true, secondHasModel = false)
        render()
        openComposerFor("Secondrepo")
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
    }
}
