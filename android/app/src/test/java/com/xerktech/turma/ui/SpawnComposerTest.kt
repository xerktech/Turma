package com.xerktech.turma.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.xerktech.turma.model.DshInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.LocalModelOption
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The spawn composer's local-model row (XERK-262).
 *
 * `ModelSource.composerOffers` itself is pinned in `core/ModelSourceTest`; what
 * had no gate at all was its CALL SITE. A mutation pass forced the `if` in
 * [SpawnDialog] to `true` and separately deleted the reset `LaunchedEffect`
 * beside it, and the whole suite stayed green — a rule enforced in a pure
 * function that nothing verifiably reaches (qa.md §5.7).
 *
 * These drive the real composable, so they fail on the WIRING rather than on the
 * rule: the row's presence is read off what is actually on screen, and the reset
 * is read off the value `onSpawn` finally carries.
 *
 * The dialog's option list scrolls, so every interaction goes through
 * [performScrollTo] first — Robolectric's window is a phone's, and a node below
 * the fold is present in the tree but takes no touch input.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SpawnComposerTest {

    @get:Rule
    val compose = createComposeRule()

    private val local = LocalModelInfo(available = true, model = "qwen3-coder", contextTokens = 128_000)
    private val discovered = LocalModelInfo(
        available = true, model = "gpt-oss:120b", defaultModel = "gpt-oss:120b",
        models = listOf(
            LocalModelOption("gpt-oss:120b", 120_000),
            LocalModelOption("qwen:32b", 32_768),
        ),
    )

    private fun show(
        localModel: LocalModelInfo?,
        dsh: DshInfo? = null,
        onSpawn: (String) -> Unit = {},
    ) = compose.setContent {
        SpawnDialog(
            host = "nas01", repo = "Turma", isRoot = false, localModel = localModel, dsh = dsh,
            onDismiss = {}, onSpawn = { _, _, _, _, _, source, _, _ -> onSpawn(source) },
        )
    }

    /** Open the "Run against" menu by clicking its field, then pick [option]. */
    private fun pickSource(current: String, option: String) {
        compose.onNodeWithText(current).performScrollTo().performClick()
        compose.onNodeWithText(option).performClick()
    }

    /**
     * The row is gated on the HOST's capability flag. Forcing that gate true is
     * how the composer starts offering a switch the hub then 409s — the inverse
     * of the contract CLAUDE.md states, that an absent flag means "that agent
     * can't do it", never "unlimited".
     */
    @Test
    fun `no run-against row when the host reports no local model`() {
        show(localModel = null)
        // The rows either side still render, so an empty screen cannot be what
        // makes this pass.
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Run against").assertDoesNotExist()
    }

    /** The same flag reported `false` is still "can't", not "didn't say". */
    @Test
    fun `no run-against row when the host reports the block unavailable`() {
        show(localModel = LocalModelInfo(available = false))
        // The positive anchor is not decoration: with only the assertDoesNotExist
        // below, this case passed against a SpawnDialog that rendered nothing at
        // all. An absence assertion needs a witness that the screen is there.
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Run against").assertDoesNotExist()
    }

    @Test
    fun `run-against row appears when the host reports one`() {
        show(localModel = local)
        compose.onNodeWithText("Run against").performScrollTo().assertIsDisplayed()
        // It opens on the subscription, never on the weaker model.
        compose.onNodeWithText("Claude subscription").assertIsDisplayed()
    }

    /**
     * A bare spawn stays byte-identical to what it was before the failover
     * existed: `subscription` is what a spawn already meant, so the composer
     * hands back that value untouched when nothing was picked.
     */
    @Test
    fun `spawn carries subscription when nothing is picked`() {
        var got: String? = null
        show(localModel = local) { got = it }
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("subscription", got)
    }

    @Test
    fun `picking the self-hosted model is what the spawn carries`() {
        var got: String? = null
        show(localModel = local) { got = it }
        pickSource(current = "Claude subscription", option = "Other")
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("local", got)
    }

    /**
     * XERK-489: choosing "local" reveals the endpoint's discovered models as a
     * dropdown (each "id · 128k"), the web composer's revealed field. Hidden
     * until local is chosen; the whole spawn body (source + endpoint model) is
     * driven end to end.
     */
    @Test
    fun `choosing local reveals the endpoint model dropdown and carries the pick`() {
        var source: String? = null
        var model: String? = null
        compose.setContent {
            SpawnDialog(
                host = "nas01", repo = "Turma", isRoot = false, localModel = discovered,
                onDismiss = {}, onSpawn = { _, _, _, _, _, s, lm, _ -> source = s; model = lm },
            )
        }
        compose.onNodeWithText("Self-hosted model").assertDoesNotExist()
        // The "Run against" local option reads "Other" — the model is named in its
        // own revealed dropdown ("Self-hosted model"), not the source selector.
        pickSource(current = "Claude subscription", option = "Other")
        compose.onNodeWithText("Self-hosted model").performScrollTo().assertIsDisplayed()
        // The window suffix is unique to the self-hosted dropdown field.
        compose.onNodeWithText("gpt-oss:120b · 120k").performScrollTo().performClick()
        compose.onNodeWithText("qwen:32b · 33k").performClick()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("local", source)
        assertEquals("qwen:32b", model)
    }

    /**
     * The reset `LaunchedEffect`: a host that stops reporting a local model
     * while the composer is open takes the row away, and a `local` left behind
     * in state would spawn into a guaranteed 409 with nothing on screen either
     * explaining it or able to change it.
     *
     * Deleting that effect leaves every OTHER case in this file green, which is
     * why this one is driven end to end — pick `local`, take the capability
     * away, then read what the spawn actually carries.
     */
    @Test
    fun `losing the host's local model resets a picked local back to subscription`() {
        var got: String? = null
        var offered by mutableStateOf<LocalModelInfo?>(local)
        compose.setContent {
            SpawnDialog(
                host = "nas01", repo = "Turma", isRoot = false, localModel = offered,
                onDismiss = {}, onSpawn = { _, _, _, _, _, source, _, _ -> got = source },
            )
        }
        pickSource(current = "Claude subscription", option = "Other")

        // The host's next heartbeat no longer carries the block.
        offered = LocalModelInfo(available = false)
        compose.waitForIdle()

        compose.onNodeWithText("Run against").assertDoesNotExist()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("subscription", got)
    }

    // ---- Runtime row (XERK-465) — same gate/wiring rules as "Run against" -----

    private fun showRuntime(dsh: DshInfo?, onType: (String) -> Unit = {}) = compose.setContent {
        SpawnDialog(
            host = "nas01", repo = "Turma", isRoot = false, dsh = dsh,
            onDismiss = {}, onSpawn = { _, _, _, _, _, _, _, agentType -> onType(agentType) },
        )
    }

    @Test
    fun `no runtime row when the host does not offer dsh`() {
        showRuntime(dsh = null)
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
    }

    @Test
    fun `no runtime row when the host reports the dsh block unavailable`() {
        showRuntime(dsh = DshInfo(available = false))
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
    }

    @Test
    fun `runtime row appears when the host offers dsh, defaulting to Claude`() {
        showRuntime(dsh = DshInfo(available = true))
        compose.onNodeWithText("Runtime").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Claude Code").assertIsDisplayed()
    }

    @Test
    fun `spawn carries claude when nothing is picked`() {
        var got: String? = null
        showRuntime(dsh = DshInfo(available = true)) { got = it }
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("claude", got)
    }

    @Test
    fun `picking dsh is what the spawn carries`() {
        var got: String? = null
        showRuntime(dsh = DshInfo(available = true)) { got = it }
        compose.onNodeWithText("Claude Code").performScrollTo().performClick()
        compose.onNodeWithText("dsh").performClick()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("dsh", got)
    }

    @Test
    fun `losing the host's dsh capability resets a picked dsh back to claude`() {
        var got: String? = null
        var offered by mutableStateOf<DshInfo?>(DshInfo(available = true))
        compose.setContent {
            SpawnDialog(
                host = "nas01", repo = "Turma", isRoot = false, dsh = offered,
                onDismiss = {}, onSpawn = { _, _, _, _, _, _, _, agentType -> got = agentType },
            )
        }
        compose.onNodeWithText("Claude Code").performScrollTo().performClick()
        compose.onNodeWithText("dsh").performClick()

        offered = DshInfo(available = false)
        compose.waitForIdle()

        compose.onNodeWithText("Runtime").assertDoesNotExist()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("claude", got)
    }
}
