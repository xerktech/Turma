package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The chat compose bar's two model chips, driven through the REAL screen
 * (XERK-262).
 *
 * Both decisions are pure and pinned in `core/ModelSourceTest` — and both were
 * deletable at the call site with the suite green: forcing
 * `canSwitchModelSource` to `false` hid the entire failover feature, and forcing
 * `modelPickable(...)` to `true` put back a Claude alias menu on a session
 * running the self-hosted model, where every alias it offers is one that
 * endpoint refuses.
 *
 * Pushing those rules further down into `core/` cannot close this: they are
 * ALREADY in `core/` and already tested. What had no gate is the wiring, so the
 * only test that fails on the mutation is one that renders the screen and reads
 * what is on it.
 *
 * [createAndroidComposeRule] rather than `createComposeRule`: `ChatScreen`
 * builds its own keyed `ChatViewModel` through `viewModel()`, which needs a real
 * `ViewModelStoreOwner` and `LifecycleOwner` in the composition.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatModelChipsTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val host = "nas01"
    private val session = "s1"

    /** Seed a fleet whose one session runs [modelSource], then open its chat. */
    private fun openChat(modelSource: String, localModel: String?) {
        // The chat re-fetches its own history on entry; answer it so the screen
        // settles instead of retrying against a 404 for the whole test.
        hub.json(
            "/api/agents/$host/sessions/$session/history",
            """{"entries":[],"truncated":false,"pending":false}""",
        )
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(
            HubHarness.fleetJson(
                host = host,
                localModel = localModel,
                sessions = """{ "id": "$session", "repo": "Turma", "status": "running",
                                "worktree": "wt", "modelSource": "$modelSource" }""",
            )
        )
        compose.setContent {
            ChatScreen(host = host, sessionId = session, onBack = {}, onTerminal = {})
        }
        compose.waitForIdle()
    }

    /**
     * The "run against" chip is gated on the host's capability flag, exactly as
     * the composer's 📎 is gated on `uploadMaxBytes`. Present, the operator has a
     * way to move a session off an exhausted subscription; hidden, the feature
     * does not exist on this phone.
     */
    @Test
    fun `the run chip shows when the host reports a self-hosted model`() {
        openChat(
            modelSource = "subscription",
            localModel = """{"available":true,"model":"qwen3-coder","contextTokens":128000}""",
        )
        compose.onNodeWithText("☁ run: Subscription").assertIsDisplayed()
    }

    /**
     * The second half of [com.xerktech.turma.core.ModelSource.offered]: a session
     * already ON the local model keeps the control even if its host has since
     * lost the configuration, so there is always a visible way back.
     */
    @Test
    fun `the run chip stays for a local session whose host stopped reporting one`() {
        openChat(modelSource = "local", localModel = null)
        // The source chip reads "Other" (the model is named in the model chip).
        compose.onNodeWithText("🏠 run: Other").assertIsDisplayed()
    }

    /** No capability, no session on it — no chip. */
    @Test
    fun `no run chip when neither the host nor the session has a local model`() {
        openChat(modelSource = "subscription", localModel = null)
        compose.onNodeWithText("☁ run: Subscription").assertDoesNotExist()
    }

    /**
     * On the local model the Claude alias picker is not merely useless but
     * harmful, so the bar states the FIXED model instead of offering a menu that
     * can only break the session. The chip reads as the model NAME, never the
     * word "local" — it is a weaker model, and nobody should have to wonder
     * which one wrote a turn.
     */
    @Test
    fun `a local session states its fixed model instead of offering the picker`() {
        openChat(
            modelSource = "local",
            localModel = """{"available":true,"model":"qwen3-coder","contextTokens":128000}""",
        )
        compose.onNodeWithText("model: qwen3-coder").assertIsDisplayed()
        // The picker's own label is what a forced-pickable mutation puts back.
        compose.onNodeWithText("model: default").assertDoesNotExist()
    }

    /**
     * XERK-489: with a DISCOVERED model list the local session's model becomes a
     * live dropdown (each "id · 128k") instead of the fixed label — the endpoint
     * model is switchable per session. The chip carries the served window, which
     * the old fixed label never did, and opening it reveals the other model.
     */
    @Test
    fun `a local session with a discovered list offers a model dropdown`() {
        openChat(
            modelSource = "local",
            localModel = """{"available":true,"model":"gpt-oss:120b","contextTokens":120000,
                "defaultModel":"gpt-oss:120b",
                "models":[{"id":"gpt-oss:120b","contextTokens":120000},{"id":"qwen:32b","contextTokens":32768}]}""",
        )
        compose.onNodeWithText("model: gpt-oss:120b · 120k").assertIsDisplayed()
        compose.onNodeWithText("model: gpt-oss:120b · 120k").performClick()
        compose.onNodeWithText("qwen:32b · 33k").assertIsDisplayed()
    }

    /** On the subscription the picker is exactly what should be there. */
    @Test
    fun `a subscription session keeps the Claude model picker`() {
        openChat(
            modelSource = "subscription",
            localModel = """{"available":true,"model":"qwen3-coder","contextTokens":128000}""",
        )
        compose.onNodeWithText("model: default").assertIsDisplayed()
    }
}
