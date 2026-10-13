package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

/**
 * Opening a second archived transcript supersedes the first (rollup XERK-1584
 * #14): a slow failure for A must never paint its refusal, or "not found", over
 * B. The web gets this from its `currentTranscriptId` check.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ArchiveOpenTranscriptTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val slowRefusal = """{"error":"no transcript","refused":{"host":"h1","error":"too large"}}"""

    @Test
    fun `a superseded load never lands its refusal on the next transcript`() {
        hub.route("/api/archive/A") {
            MockResponse().setResponseCode(404).setBody(slowRefusal)
                .setHeader("Content-Type", "application/json")
                .setBodyDelay(1500, TimeUnit.MILLISECONDS)
        }
        hub.json("/api/archive/B", """{"transcriptId":"B","summary":"second"}""")
        val vm = main.track(ArchiveViewModel(hub.app))
        vm.openTranscript("A")
        hub.findRequest("/api/archive/A")
        vm.openTranscript("B")
        hub.awaitFlow(vm.state) { it.open != null }
        // Outlast A's delayed answer; a stale write would land in this window.
        Thread.sleep(2500)
        val s = vm.state.value
        assertEquals("B", s.open?.transcriptId)
        assertNull("A's refusal must not show on B", s.refusal)
        assertNull(s.error)
        assertFalse(s.openLoading)
    }

    @Test
    fun `closing cancels the load, so a late answer reopens nothing`() {
        hub.route("/api/archive/A") {
            MockResponse().setBody("""{"transcriptId":"A"}""")
                .setHeader("Content-Type", "application/json")
                .setBodyDelay(1500, TimeUnit.MILLISECONDS)
        }
        val vm = main.track(ArchiveViewModel(hub.app))
        vm.openTranscript("A")
        hub.findRequest("/api/archive/A")
        vm.closeTranscript()
        Thread.sleep(2500)
        assertNull("a closed view must not reopen on a late answer", vm.state.value.open)
        assertFalse(vm.state.value.openLoading)
    }
}
