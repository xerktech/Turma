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

    private fun vm() = ChatViewModel(hub.app, host, session)

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
}
