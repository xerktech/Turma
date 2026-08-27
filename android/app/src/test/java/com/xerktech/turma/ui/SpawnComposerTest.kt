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
 * The spawn composer's UNIFIED Runtime picker (XERK-503), the port of web
 * `sessions.html`. It collapses the old Runtime (claude/dsh) + "Run against"
 * (subscription/local) pair into ONE "Runtime" picker — "Claude Code" / "Claude
 * Code Local" / "dsh" — that maps onto the existing agentType/modelSource wire
 * fields. "Run against" is gone.
 *
 * The rules live in `core/RuntimeTest`; these drive the real composable so they
 * fail on the WIRING — the row's presence is read off what is actually on screen,
 * and the mapping off the values `onSpawn` finally carries.
 *
 * The dialog scrolls, so every interaction goes through [performScrollTo] first —
 * Robolectric's window is a phone's, and a node below the fold takes no input.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SpawnComposerTest {

    @get:Rule
    val compose = createComposeRule()

    private val local = LocalModelInfo(
        available = true, model = "gpt-oss:120b", defaultModel = "gpt-oss:120b",
        models = listOf(
            LocalModelOption("gpt-oss:120b", 120_000),
            LocalModelOption("qwen:32b", 32_768),
        ),
    )
    private val dsh = DshInfo(
        available = true, defaultModel = "deepseek-chat",
        models = listOf(
            LocalModelOption("deepseek-chat", 128_000),
            LocalModelOption("qwen3-coder", 32_768),
        ),
    )

    /** All eight args `onSpawn` carries, so a test can assert the whole mapping. */
    private data class Spawn(
        val model: String, val mode: String, val source: String,
        val local: String, val agentType: String,
    )

    private fun show(
        localModel: LocalModelInfo? = null,
        dshInfo: DshInfo? = null,
        onSpawn: (Spawn) -> Unit = {},
    ) = compose.setContent {
        SpawnDialog(
            host = "nas01", repo = "Turma", isRoot = false,
            localModel = localModel, dsh = dshInfo, onDismiss = {},
            onSpawn = { _, _, _, model, mode, source, lm, agentType ->
                onSpawn(Spawn(model, mode, source, lm, agentType))
            },
        )
    }

    /** Open a dropdown by clicking its current value, then pick [option]. */
    private fun pick(current: String, option: String) {
        compose.onNodeWithText(current).performScrollTo().performClick()
        compose.onNodeWithText(option).performClick()
    }

    // ---- the picker's presence ----------------------------------------------

    @Test
    fun `no runtime picker on a plain subscription host`() {
        // Only one runtime, so nothing to choose — the picker is hidden and the
        // Model + Permission rows are the plain Claude ones.
        show()
        compose.onNodeWithText("Permission mode").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
        // "Run against" is gone — its subscription/local choice is the runtime now.
        compose.onNodeWithText("Run against").assertDoesNotExist()
    }

    @Test
    fun `the picker appears with a local endpoint and offers Claude Code Local`() {
        show(localModel = local)
        compose.onNodeWithText("Runtime").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Run against").assertDoesNotExist()
        // Opening it reveals the Claude Code Local runtime.
        compose.onNodeWithText("Claude Code").performScrollTo().performClick()
        compose.onNodeWithText("Claude Code Local").assertIsDisplayed()
    }

    @Test
    fun `the picker offers dsh when the host reports it`() {
        show(dshInfo = dsh)
        compose.onNodeWithText("Claude Code").performScrollTo().performClick()
        compose.onNodeWithText("dsh").assertIsDisplayed()
    }

    // ---- the wire mapping ----------------------------------------------------

    @Test
    fun `a bare spawn carries subscription + claude, byte-identical to before`() {
        var got: Spawn? = null
        show(localModel = local, dshInfo = dsh) { got = it }
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("subscription", got?.source)
        assertEquals("claude", got?.agentType)
    }

    @Test
    fun `Claude Code Local carries modelSource local and the endpoint model`() {
        var got: Spawn? = null
        show(localModel = local) { got = it }
        pick(current = "Claude Code", option = "Claude Code Local")
        // The endpoint model dropdown (labeled "Model") is now revealed.
        compose.onNodeWithText("gpt-oss:120b · 120k").performScrollTo().performClick()
        compose.onNodeWithText("qwen:32b · 33k").performClick()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("local", got?.source)
        assertEquals("qwen:32b", got?.local)
        assertEquals("claude", got?.agentType)
    }

    @Test
    fun `dsh carries agentType dsh and the discovered dsh model, no permission mode`() {
        var got: Spawn? = null
        show(dshInfo = dsh) { got = it }
        pick(current = "Claude Code", option = "dsh")
        // dsh manages approvals itself — the permission dropdown is replaced by a note.
        compose.onNodeWithText("Permission mode").assertDoesNotExist()
        compose.onNodeWithText("Approvals are managed by dsh", substring = true)
            .performScrollTo().assertIsDisplayed()
        // The dsh model dropdown lists discovered ids; pick a non-default one.
        compose.onNodeWithText("deepseek-chat · 128k").performScrollTo().performClick()
        compose.onNodeWithText("qwen3-coder · 33k").performClick()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("dsh", got?.agentType)
        assertEquals("qwen3-coder", got?.model)     // the dsh id rides `model`
        assertEquals("subscription", got?.source)   // never a modelSource
    }

    // ---- resets when a runtime leaves the picker ----------------------------

    @Test
    fun `losing the host's local model resets a picked local back to claude`() {
        var got: Spawn? = null
        var offeredLocal by mutableStateOf<LocalModelInfo?>(local)
        compose.setContent {
            SpawnDialog(
                host = "nas01", repo = "Turma", isRoot = false,
                localModel = offeredLocal, dsh = null, onDismiss = {},
                onSpawn = { _, _, _, _, _, source, _, agentType ->
                    got = Spawn("", "", source, "", agentType)
                },
            )
        }
        pick(current = "Claude Code", option = "Claude Code Local")
        offeredLocal = LocalModelInfo(available = false)
        compose.waitForIdle()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("subscription", got?.source)
        assertEquals("claude", got?.agentType)
    }

    @Test
    fun `losing the host's dsh capability resets a picked dsh back to claude`() {
        var got: Spawn? = null
        var offeredDsh by mutableStateOf<DshInfo?>(dsh)
        compose.setContent {
            SpawnDialog(
                host = "nas01", repo = "Turma", isRoot = false,
                localModel = null, dsh = offeredDsh, onDismiss = {},
                onSpawn = { _, _, _, model, _, _, _, agentType ->
                    got = Spawn(model, "", "", "", agentType)
                },
            )
        }
        pick(current = "Claude Code", option = "dsh")
        offeredDsh = DshInfo(available = false)
        compose.waitForIdle()
        compose.onNodeWithText("Runtime").assertDoesNotExist()
        compose.onNodeWithText("Spawn").performClick()
        assertEquals("claude", got?.agentType)
    }
}
