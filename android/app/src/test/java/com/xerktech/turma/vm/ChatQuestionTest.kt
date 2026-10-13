package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `ChatViewModel`'s half of answering an AskUserQuestion (XERK-812).
 *
 * The card must go the instant the operator picks — the POST to the hub plus the
 * agent's next heartbeat take a moment, and a card left up reads as if the tap
 * did nothing, so they tap again and the extra answers land on the NEXT question
 * (the erratic skip-ahead in the report). The optimistic dismiss lives in the VM,
 * with a guard ([ChatUiState.answeredQuestion]) so a stale beat still reporting
 * the answered question can't bounce it back. `ChatUiStateTest` pins the getter +
 * `fromFleet` guard purely; these prove the VM actually arms and unwinds it on a
 * real POST — the same call-site gap `ChatModelSourceTest` guards for the memo.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatQuestionTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = "nas01"
    private val session = "s1"

    private fun vm() = main.track(ChatViewModel(hub.app, host, session))

    private fun asking(q: String) = HubHarness.fleetJson(
        host = host,
        sessions = """{ "id": "$session", "repo": "Turma", "session": { "question": "$q" } }""",
    )

    @Test
    fun `answering hides the question card at once, before any beat lands`() {
        hub.json("/api/agents/$host/sessions/$session/answer", """{"ok":true}""")
        hub.seedFleet(asking("Pick a colour"))
        val vm = vm()
        vm.onEnter()
        hub.awaitFlow(vm.state) { it.question == "Pick a colour" }

        // The dismiss is synchronous — no beat, no round-trip. The fleet still
        // reports the question (no new beat has landed), so only the guard hides it.
        vm.answerOption(0)
        assertEquals("", vm.state.value.question)
        vm.onLeave()
    }

    @Test
    fun `a refused answer re-surfaces the question so it can be answered again`() {
        hub.route("/api/agents/$host/sessions/$session/answer") {
            HubHarness.refusal("session is not accepting answers")
        }
        hub.seedFleet(asking("Pick a colour"))
        val vm = vm()
        vm.onEnter()
        hub.awaitFlow(vm.state) { it.question == "Pick a colour" }

        vm.answerOption(0)
        // The card comes back once the POST fails — the fleet still has the
        // question, so clearing the guard shows it again rather than stranding it.
        hub.awaitFlow(vm.state) { it.question == "Pick a colour" }
        vm.onLeave()
    }

    @Test
    fun `a custom-text answer dismisses the card too`() {
        hub.json("/api/agents/$host/sessions/$session/answer", """{"ok":true}""")
        hub.seedFleet(asking("Pick a colour"))
        val vm = vm()
        vm.onEnter()
        hub.awaitFlow(vm.state) { it.question == "Pick a colour" }

        vm.setDraft("a custom answer")
        vm.submitDraft()
        assertEquals("", vm.state.value.question)
        vm.onLeave()
    }

    private fun permission(prompt: String) = HubHarness.fleetJson(
        host = host,
        sessions = """{ "id": "$session", "repo": "Turma", "session": { "panePrompt": {
            "prompt": "$prompt", "detail": "Bash command\\n  ls", "id": "0123456789abcdef0123456789abcdef",
            "options": [{"number":1,"label":"Yes","selected":true},{"number":2,"label":"No"}] } } }""",
    )

    @Test
    fun `a permission dialog surfaces and is answered by its option number`() {
        hub.json("/api/agents/$host/sessions/$session/pane-prompt", """{"ok":true}""")
        hub.seedFleet(permission("Do you want to proceed?"))
        val vm = vm()
        vm.onEnter()
        hub.awaitFlow(vm.state) { it.panePrompt?.prompt == "Do you want to proceed?" }
        assertEquals(listOf(1, 2), vm.state.value.panePrompt?.options?.map { it.number })

        val job = vm.answerPanePrompt(2)
        // Hidden at once — the fleet still reports the dialog, only the guard hides it.
        assertEquals(null, vm.state.value.panePrompt)
        // Let the POST + nudge finish inside the test, so nothing touches Main after it.
        kotlinx.coroutines.runBlocking { job?.join() }
        val req = hub.findRequest("/pane-prompt")
        // The answer names the dialog it was picked on (XERK-1831).
        assertEquals("""{"optionNumber":2,"dialogId":"0123456789abcdef0123456789abcdef"}""", req.body.readUtf8())
        vm.onLeave()
    }

    @Test
    fun `a refused permission answer re-surfaces the dialog`() {
        hub.route("/api/agents/$host/sessions/$session/pane-prompt") {
            HubHarness.refusal("session is not running")
        }
        hub.seedFleet(permission("Do you want to proceed?"))
        val vm = vm()
        vm.onEnter()
        hub.awaitFlow(vm.state) { it.panePrompt != null }

        val job = vm.answerPanePrompt(1)
        kotlinx.coroutines.runBlocking { job?.join() }
        hub.awaitFlow(vm.state) { it.panePrompt?.prompt == "Do you want to proceed?" }
        vm.onLeave()
    }
}
