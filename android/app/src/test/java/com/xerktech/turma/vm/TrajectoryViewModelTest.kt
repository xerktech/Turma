package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
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
 * The dsh Trajectory fetch (XERK-498). The three outcomes are kept distinct
 * because they mean different things to the operator: 200 → the trajectory;
 * 404 → the running session's native log has not synced to the archive yet
 * (retry, it will); anything else → an error retrying alone won't fix. A running
 * dsh session opened right away 404s for a beat or two — collapsing that into
 * "error" would tell the operator to give up on data that is on its way.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TrajectoryViewModelTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val tid = "d1"

    private val trajectoryJson = """
        {"transcriptId":"d1","title":"my dsh session","model":"deepseek",
         "durationMs":1500,"truncated":false,"turnsDropped":0,"callsDropped":0,
         "totals":{"turns":2,"steps":3,"toolCalls":1,"errors":0,
                   "tokens":{"input":12,"output":5,"cacheRead":0,"cacheWrite":0}},
         "turns":[{"turn":1,"startedAt":1000,"endedAt":1600,"reason":"stop","steps":2,
                   "tokens":{"input":12,"output":5},
                   "calls":[{"name":"bash","callId":"c1","at":1100,"ok":true,
                             "error":false,"args":"ls","durationMs":40}]}]}
    """.trimIndent()

    @Test
    fun `a 200 populates the parsed trajectory`() {
        hub.json("/api/dsh/$tid/trajectory", trajectoryJson)
        val vm = TrajectoryViewModel(hub.app)
        vm.load(tid)
        val d = hub.awaitValue { vm.state.value.data }
        assertEquals("my dsh session", d.title)
        assertEquals(2, d.totals.turns)
        assertEquals(1, d.totals.toolCalls)
        assertEquals(12L, d.totals.tokens.input)
        assertEquals(1, d.turns.size)
        assertEquals("bash", d.turns[0].calls[0].name)
        assertEquals(true, d.turns[0].calls[0].ok)
        // A successful load is neither a 404 nor an error.
        assertTrue(!vm.state.value.notSynced && vm.state.value.error == null)
    }

    @Test
    fun `a 404 is the not-synced-yet state, not an error`() {
        hub.json("/api/dsh/$tid/trajectory", """{"error":"no dsh trajectory for this session"}""", code = 404)
        val vm = TrajectoryViewModel(hub.app)
        vm.load(tid)
        hub.awaitValue { if (vm.state.value.loading) null else Unit }
        assertTrue("a 404 must read as not-synced-yet", vm.state.value.notSynced)
        assertNull("a 404 is not an error", vm.state.value.error)
        assertNull(vm.state.value.data)
    }

    @Test
    fun `a non-404 status is an error`() {
        hub.json("/api/dsh/$tid/trajectory", """{"error":"boom"}""", code = 500)
        val vm = TrajectoryViewModel(hub.app)
        vm.load(tid)
        val err = hub.awaitValue { vm.state.value.error }
        assertTrue("the HTTP status should be surfaced", err.contains("500"))
        assertTrue(!vm.state.value.notSynced)
    }

    @Test
    fun `a blank transcript id never hits the network`() {
        // No route registered — if it fetched, the harness would 404 (→ notSynced),
        // so an error state with no fetch is the proof it short-circuited.
        val vm = TrajectoryViewModel(hub.app)
        vm.load("")
        assertNotNull(vm.state.value.error)
        assertTrue(!vm.state.value.notSynced)
        assertNull(vm.state.value.data)
    }
}
