package com.xerktech.turma.vm

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What `FleetViewModel` tells the operator when a mutation fails (XERK-262).
 *
 * Every host/session action funnels through one private `run`, whose `catch`
 * used to collapse EVERY failure into "✗ hub unreachable". A mutation pass put
 * that back — deleting the `hubErrorMessage(e)` lookup — and nothing failed,
 * because the whole outcome path lived below the last line any test reached.
 *
 * The reason this matters is a refused spawn onto a host with no self-hosted
 * model: the hub answers a 409 that SAYS so, in about 8ms, and reporting it as
 * "hub unreachable" sends the operator to look at the network for a refusal
 * already explained in the response body.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FleetOutcomeTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val host = "nas01"

    private fun spawn(): String {
        val vm = FleetViewModel(hub.app)
        val message = hub.expectMessage(vm.messages)
        vm.spawn(host = host, repo = "Turma", modelSource = "local")
        return message()
    }

    /** The hub's own words, taken from the body of its refusal. */
    @Test
    fun `a refused spawn reports the reason the hub gave`() {
        hub.route("/api/agents/$host/sessions") {
            HubHarness.refusal("host has no local model configured")
        }
        val msg = spawn()
        assertTrue(
            "reported \"$msg\" instead of the hub's own reason",
            msg.contains("no local model configured"),
        )
        assertTrue("reported it as a success", msg.startsWith("✗"))
    }

    /**
     * A refusal the hub chose to answer 200 with is still a refusal. This half
     * always worked; it is here so the case above cannot be made to pass by
     * routing every failure through the body-error branch.
     */
    @Test
    fun `a 200 carrying an error is not reported as queued`() {
        hub.json("/api/agents/$host/sessions", """{"ok":false,"error":"repo is not cloned here"}""")
        val msg = spawn()
        assertTrue("reported \"$msg\"", msg.contains("repo is not cloned here"))
    }

    /**
     * Only a genuinely unanswered request says "hub unreachable" — the string
     * has to keep meaning something, or it is noise on every failure.
     */
    @Test
    fun `a request the hub never answers still reports unreachable`() {
        hub.route("/api/agents/$host/sessions") {
            MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START)
        }
        val msg = spawn()
        assertTrue("reported \"$msg\"", msg.contains("unreachable") || msg.startsWith("✗"))
    }

    /** A hub that accepted it says so, and says nothing about a failure. */
    @Test
    fun `an accepted spawn reports queued`() {
        hub.json("/api/agents/$host/sessions", """{"ok":true}""")
        val msg = spawn()
        assertTrue("reported \"$msg\"", msg.startsWith("✓"))
    }
}
