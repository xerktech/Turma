package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A superseded answer that is ALREADY QUEUED on Main when the next transcript
 * opens (rollup XERK-1584 #14): cancelling its job does not stop it, since its
 * continuation was resumed before the cancel, so only the `ensureActive()`
 * after the load keeps A's refusal off B's spinner. A queued dispatcher (not
 * the default unconfined one) is what lets the answer sit there.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ArchiveStaleAnswerTest {

    private val dispatcher = StandardTestDispatcher()

    @get:Rule(order = 0)
    val main = MainDispatcherRule(dispatcher)

    @get:Rule(order = 1)
    val hub = HubHarness()

    @Test
    fun `an answer queued before the next open never lands on it`() {
        hub.json(
            "/api/archive/A",
            """{"error":"no transcript","refused":{"host":"h1","error":"too large"}}""",
            code = 404,
        )
        // B never answers: the state must stay B's spinner.
        hub.route("/api/archive/B") { MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE) }
        val vm = main.track(ArchiveViewModel(hub.app))
        vm.openTranscript("A")
        dispatcher.scheduler.advanceUntilIdle()   // A's load starts and goes to the network
        hub.findRequest("/api/archive/A")
        // Let A's 404 come back and queue its resumption on Main (not run yet).
        Thread.sleep(500)
        vm.openTranscript("B")
        dispatcher.scheduler.advanceUntilIdle()   // runs A's stale resumption, then starts B
        val s = vm.state.value
        assertTrue("B is still loading", s.openLoading)
        assertNull("A's refusal must not land on B", s.refusal)
        assertNull("A's 'not found' must not land on B", s.error)
    }

    @Test
    fun `a superseded search answer never stamps the next query`() {
        hub.route("/api/search") { r ->
            if (r.path!!.contains("q=old&")) MockResponse().setResponseCode(500).setBody("{}")
            else MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE)
        }
        val vm = main.track(ArchiveViewModel(hub.app))
        vm.onQuery("old")
        dispatcher.scheduler.advanceUntilIdle()   // the debounce passes and the search goes out
        hub.findRequest("q=old")
        Thread.sleep(500)                          // old's 500 resumes, queued on Main
        vm.onQuery("newer")
        dispatcher.scheduler.runCurrent()          // old's queued resumption only; newer still debounces
        val s = vm.state.value
        assertEquals("a stale answer must not stamp", "", s.searchedQuery)
        assertTrue("the spinner stays up until newer answers", s.searching)
    }
}
