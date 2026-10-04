package com.xerktech.turma.vm

import androidx.lifecycle.viewModelScope
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.TurmaJson
import kotlinx.serialization.decodeFromString
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Usage screen's permission card slice (XERK-1576): its own
 * `GET /api/permissions` call, scoped to the header's org exactly as
 * usage.html's `refreshPermissions` is, over the real HTTP stack.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UsagePermissionsViewModelTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private var watch: Job? = null

    @After fun stopWatching() { watch?.cancel() }

    private val fleet = """
        {"now":1,"agents":[
          {"key":"h1","device":"h1","online":true,"jira":{"siteKey":"acme","site":"Acme"}},
          {"key":"h2","device":"h2","online":true,"jira":{"siteKey":"rival","site":"Rival"}}]}
    """.trimIndent()

    private fun summary(head: String) =
        """{"days":7,"top":[{"kind":"dialog","head":"$head","count":1,"allowed":1,"denied":0,"open":0}],"recent":[]}"""

    /** Answer each org with its own rows, so a row names the scope it was fetched for. */
    private fun routeByOrg(delayFor: String? = null) = hub.route("/api/permissions") { req ->
        val org = req.requestUrl?.queryParameter("org") ?: "all"
        MockResponse().setResponseCode(200)
            .setHeader("Content-Type", "application/json")
            .setBody(summary("$org-cmd"))
            .apply { if (org == delayFor) setHeadersDelay(1_200, TimeUnit.MILLISECONDS) }
    }

    private fun startWatching(vm: UsageViewModel) {
        watch = vm.viewModelScope.launch { vm.watchPermissions() }
    }

    private fun headOf(vm: UsageViewModel) = vm.permissions.value.view?.top?.firstOrNull()?.head

    @Test
    fun `fetches the current org's seven days and refetches on an org change, never showing the old org`() {
        routeByOrg()
        hub.container.org.set(setOf("acme"))
        hub.seedFleet(fleet)
        val vm = UsageViewModel(hub.app)
        startWatching(vm)

        hub.awaitFlow(vm.permissions) { it.view != null }
        assertEquals("acme-cmd", headOf(vm))
        val first = hub.findRequest("/api/permissions")
        assertEquals("7", first.requestUrl?.queryParameter("days"))
        assertEquals("acme", first.requestUrl?.queryParameter("org"))

        hub.container.org.set(setOf("rival"))
        // The old org's rows are gone the moment the scope moves — loading, not acme's.
        assertNull("org A's view must not survive under org B's pick", headOf(vm))
        hub.awaitFlow(vm.permissions) { it.view != null }
        assertEquals("rival-cmd", headOf(vm))

        // "All orgs" omits the parameter entirely (every org).
        hub.container.org.set(emptySet())
        hub.awaitFlow(vm.permissions) { it.view?.top?.firstOrNull()?.head == "all-cmd" }
    }

    @Test
    fun `an answer for an org the operator has since left is discarded`() {
        routeByOrg(delayFor = "acme")
        hub.container.org.set(setOf("acme"))
        hub.seedFleet(fleet)
        val vm = UsageViewModel(hub.app)
        startWatching(vm)               // acme's read is now in flight, slow
        hub.container.org.set(setOf("rival"))
        hub.awaitFlow(vm.permissions) { it.view != null }
        assertEquals("rival-cmd", headOf(vm))
        Thread.sleep(1_800)             // acme's late answer lands now
        assertEquals("a stale org's answer must not replace the current one", "rival-cmd", headOf(vm))
    }

    @Test
    fun `nothing is fetched until a fleet snapshot says which orgs exist`() {
        routeByOrg()
        hub.container.org.set(setOf("acme"))
        val vm = UsageViewModel(hub.app)
        startWatching(vm)
        // Before a snapshot no org is known: an unscoped fetch would show every
        // org's prompts under a scoped header.
        assertNull(hub.findRequestOrNull("/api/permissions", timeoutMs = 800))
        hub.seedFleet(fleet)
        assertEquals("acme", hub.findRequest("/api/permissions").requestUrl?.queryParameter("org"))
    }

    @Test
    fun `an SSE upsert before the first poll is not a fleet snapshot`() {
        routeByOrg()
        hub.container.org.set(setOf("acme"))
        val vm = UsageViewModel(hub.app)
        startWatching(vm)
        // One rival host arrives over SSE before any poll: the state reads loaded
        // with no error, but scoping "acme" against it would drop the org and
        // fetch EVERY org's prompts under a scoped header.
        hub.container.fleet.upsert(TurmaJson.decodeFromString<AgentInfo>(
            """{"key":"h2","device":"h2","online":true,"jira":{"siteKey":"rival","site":"Rival"}}"""))
        val s = hub.container.fleet.state.value
        assertTrue(!s.loading && s.error == null && !s.polled && s.agents.size == 1)
        assertNull(hub.findRequestOrNull("/api/permissions", timeoutMs = 800))
        hub.seedFleet(fleet)
        assertEquals("acme", hub.findRequest("/api/permissions").requestUrl?.queryParameter("org"))
    }

    @Test
    fun `a refusal shows the hub's own words, never a blank section`() {
        hub.route("/api/permissions") { HubHarness.refusal("permission ledger unavailable", code = 503) }
        val vm = UsageViewModel(hub.app)
        runBlocking { vm.refreshPermissions(listOf("acme")).join() }
        assertEquals("permission ledger unavailable", vm.permissions.value.error)
        assertNull(vm.permissions.value.view)

        // No {error} body: the status, worded as every client words it.
        hub.route("/api/permissions") { MockResponse().setResponseCode(500) }
        runBlocking { vm.refreshPermissions(listOf("rival")).join() }
        assertEquals("the hub answered HTTP 500", vm.permissions.value.error)
    }

    @Test
    fun `a wrong-typed answer fails this section alone, and a failed refresh keeps the last view`() {
        hub.seedFleet(fleet)
        hub.json("/api/permissions", """{"days":7,"top":"not a list"}""")
        val vm = UsageViewModel(hub.app)
        runBlocking { vm.refreshPermissions(emptyList()).join() }
        assertEquals("no readable answer from the hub", vm.permissions.value.error)
        // The fleet decode is a different call: both hosts are still there.
        assertEquals(2, vm.fleet.value.agents.size)

        hub.json("/api/permissions", summary("git status"))
        runBlocking { vm.refreshPermissions(emptyList()).join() }
        assertEquals("git status", headOf(vm))
        assertNull(vm.permissions.value.error)

        // The same scope's refresh fails: its last view stays up, silently.
        hub.route("/api/permissions") { HubHarness.refusal("busy", code = 503) }
        runBlocking { vm.refreshPermissions(emptyList()).join() }
        assertEquals("git status", headOf(vm))
        assertNull(vm.permissions.value.error)
        assertNotNull(vm.permissions.value.view)
        assertTrue(vm.permissions.value.view!!.recent.isEmpty())
    }

    @Test
    fun `a failed fleet read before any snapshot says why instead of loading forever`() {
        routeByOrg()
        hub.container.org.set(setOf("acme"))
        hub.route("/api/agents") { MockResponse().setResponseCode(500) }
        runBlocking { hub.container.fleet.refresh() }
        val fleetError = hub.container.fleet.state.value.error
        assertNotNull(fleetError)
        val vm = UsageViewModel(hub.app)
        startWatching(vm)
        hub.awaitFlow(vm.permissions) { it.error != null }
        assertEquals(fleetError, vm.permissions.value.error)
        // Still nothing fetched: no org is known yet.
        assertNull(hub.findRequestOrNull("/api/permissions", timeoutMs = 500))

        // The first good snapshot clears it and fetches the scoped card.
        hub.seedFleet(fleet)
        hub.awaitFlow(vm.permissions) { it.view != null }
        assertEquals("acme-cmd", headOf(vm))
        assertNull(vm.permissions.value.error)
    }

    @Test
    fun `an unchanged ledger still re-emits on refresh, so the ages keep moving`() {
        hub.json("/api/permissions", summary("git status"))
        val vm = UsageViewModel(hub.app)
        runBlocking { vm.refreshPermissions(emptyList()).join() }
        val first = vm.permissions.value
        assertTrue("the view carries the time it landed", first.at > 0)
        Thread.sleep(5)
        runBlocking { vm.refreshPermissions(emptyList()).join() }
        val second = vm.permissions.value
        assertEquals(first.view, second.view)
        // An equal value is dropped by the StateFlow; the stamp makes it a new one.
        assertNotEquals(first, second)
        assertTrue(second.at > first.at)
    }
}
