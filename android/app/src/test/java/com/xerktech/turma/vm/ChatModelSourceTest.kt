package com.xerktech.turma.vm

import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `ChatViewModel`'s half of the model-source switch (XERK-262).
 *
 * `core/ModelSource` is fully pinned by its own tests, but every RULE it states
 * is applied here, at a call site that had no gate: a mutation pass deleted the
 * `ModelSource.Pending(...)` that arms the memo, deleted the
 * `ModelSource.afterAttempt(...)` that drops it on a refusal, and deleted the
 * `ModelSource.settle(...)` that retires it once the heartbeat agrees — and the
 * suite stayed green through all three.
 *
 * The memo is asserted on the STORE (`container.modelSwitches`) rather than on
 * `ChatUiState`, deliberately. The store is where the value has to survive — the
 * state copy is a mirror the ViewModel rebuilds — so an assertion against the
 * mirror would pass on a change that dropped the real thing.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatModelSourceTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = "nas01"
    private val session = "s1"

    private fun vm() = ChatViewModel(hub.app, host, session)

    private fun memo() = hub.container.modelSwitches.of(host, session).value

    /**
     * The memo is armed BEFORE the POST, and survives the hub accepting it: the
     * switch relaunches Claude with `--resume`, so the heartbeat takes several
     * beats to agree and the chip paints from this meanwhile. Without it the
     * chip springs straight back and reads as a control that did nothing.
     */
    @Test
    fun `an accepted switch arms the memo and keeps it`() {
        hub.json("/api/agents/$host/sessions/$session/model-source", """{"ok":true}""")
        val vm = vm()

        runBlocking { vm.setModelSource(ModelSource.LOCAL).join() }

        val p = memo()
        assertNotNull("the switch left no memo for the chip to paint from", p)
        assertEquals(ModelSource.LOCAL, p?.value)
        // Scoped to THIS session: a memo with someone else's id would be honoured
        // against every record-less session at once.
        assertEquals(session, p?.sessionId)
    }

    /**
     * A refusal DROPS the memo rather than letting it age out. The hub 409s a
     * host with no local model, and a chip that keeps claiming a switch that was
     * rejected is the same lie the TTL exists to bound — just held for a full
     * minute with the answer already in hand.
     */
    @Test
    fun `a refused switch drops the memo`() {
        hub.route("/api/agents/$host/sessions/$session/model-source") {
            HubHarness.refusal("host has no local model configured")
        }
        val vm = vm()

        runBlocking { vm.setModelSource(ModelSource.LOCAL).join() }

        assertNull("a refused switch left the chip claiming it happened", memo())
    }

    /** The same drop applies when the hub never answered at all. */
    @Test
    fun `a switch the hub never answers drops the memo`() {
        hub.route("/api/agents/$host/sessions/$session/model-source") {
            MockResponse().setResponseCode(500)
        }
        val vm = vm()

        runBlocking { vm.setModelSource(ModelSource.LOCAL).join() }

        assertNull(memo())
    }

    /**
     * The hub's OWN words reach the operator. Collapsing this to a blanket
     * failure sends someone looking at the network for a refusal the hub already
     * explained — the same defect `FleetViewModel.run` carried one layer up.
     */
    @Test
    fun `a refusal reports the reason the hub gave`() {
        hub.route("/api/agents/$host/sessions/$session/model-source") {
            HubHarness.refusal("host has no local model configured")
        }
        val vm = vm()
        val message = hub.expectMessage(vm.messages)

        runBlocking { vm.setModelSource(ModelSource.LOCAL).join() }
        val msg = message()

        assertTrue("reported \"$msg\" instead of the hub's reason", msg.contains("no local model"))
    }

    /**
     * `settle`, driven through the heartbeat rather than called directly: once
     * the record reports the value that was asked for, the memo has done its job
     * and must be retired THROUGH THE STORE. Clearing only the state copy would
     * let the next emission paint the stale memo straight back.
     */
    @Test
    fun `the memo retires once the heartbeat agrees`() {
        hub.json("/api/agents/$host/sessions/$session/model-source", """{"ok":true}""")
        hub.seedFleet(
            HubHarness.fleetJson(
                host = host,
                localModel = """{"available":true,"model":"qwen3-coder"}""",
                sessions = """{ "id": "$session", "repo": "Turma", "modelSource": "subscription" }""",
            )
        )
        val vm = vm()
        vm.onEnter()
        runBlocking { vm.setModelSource(ModelSource.LOCAL).join() }
        assertNotNull(memo())

        // The host's next beat reports the switch as landed.
        hub.seedFleet(
            HubHarness.fleetJson(
                host = host,
                localModel = """{"available":true,"model":"qwen3-coder"}""",
                sessions = """{ "id": "$session", "repo": "Turma", "modelSource": "local" }""",
            )
        )

        // Await the STORE flow rather than poll a clock (XERK-308): the
        // retirement rides the fleet collector, and `settle` writes the memo
        // through this same MutableStateFlow — so a wait resumed by that write
        // (and returning at once when it has already happened, since a
        // StateFlow replays its value) is deterministic where a 10s timed poll
        // reddened on a loaded runner.
        hub.awaitFlow(hub.container.modelSwitches.of(host, session)) { it == null }
        vm.onLeave()
    }

    /**
     * The other half of the same rule: while the record still disagrees, the memo
     * STAYS. A `settle` that cleared unconditionally would drop the chip back to
     * the old value on the very first beat after the switch — which is the bug
     * the memo exists to prevent, reintroduced one layer down.
     */
    @Test
    fun `the memo survives a heartbeat that has not caught up`() {
        hub.json("/api/agents/$host/sessions/$session/model-source", """{"ok":true}""")
        // `now` DIFFERS between the two beats, and that is load-bearing.
        // `FleetState` is a data class in a StateFlow, so a byte-identical second
        // fixture is conflated and emits nothing — the collector where `settle`
        // lives would never run and this test would pass against a `settle` that
        // cleared unconditionally. (It did: proven by mutation.)
        fun stillOld(now: Long) = HubHarness.fleetJson(
            host = host,
            localModel = """{"available":true,"model":"qwen3-coder"}""",
            sessions = """{ "id": "$session", "repo": "Turma", "modelSource": "subscription" }""",
            now = now,
        )
        hub.seedFleet(stillOld(1))
        val vm = vm()
        vm.onEnter()
        runBlocking { vm.setModelSource(ModelSource.LOCAL).join() }

        // A second beat that still reports the OLD value. The memo must survive
        // it — the switch takes several beats to land, and dropping the memo on
        // the first one is the "control that did nothing" bug it exists to stop.
        hub.seedFleet(stillOld(2))

        assertNotNull("the chip sprang back before the switch had landed", memo())
        assertEquals(ModelSource.LOCAL, memo()?.value)
        vm.onLeave()
    }
}
