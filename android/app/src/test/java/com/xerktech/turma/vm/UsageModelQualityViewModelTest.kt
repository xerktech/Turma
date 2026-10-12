package com.xerktech.turma.vm

import androidx.lifecycle.viewModelScope
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okhttp3.mockwebserver.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Usage screen's model-quality slice (XERK-1849): its own
 * `GET /api/model-quality`, rows asked for only when exactly one org applies,
 * and never another org's rows (or error) under the current pick — usage.html's
 * `refreshModelQuality`, over the real HTTP stack.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UsageModelQualityViewModelTest {
    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private var watch: Job? = null

    @After fun stopWatching() { watch?.cancel() }

    private val fleet = """
        {"now":1,"agents":[
          {"key":"h1","device":"h1","online":true,"jira":{"siteKey":"acme","site":"Acme","orgName":"Acme Corp"}},
          {"key":"h2","device":"h2","online":true,"jira":{"siteKey":"rival","site":"Rival"}}]}
    """.trimIndent()

    /** Each org answers with a row naming it; `failFor` refuses, `delayFor` answers late. */
    private fun routeByOrg(delayFor: String? = null, failFor: String? = null) = hub.route("/api/model-quality") { req ->
        val org = req.requestUrl?.queryParameter("org") ?: "all"
        if (org == failFor) {
            MockResponse().setResponseCode(500).setHeader("Content-Type", "application/json")
                .setBody("""{"error":"ledger down"}""")
        } else {
            MockResponse().setResponseCode(200).setHeader("Content-Type", "application/json")
                .setBody("""{"windowDays":90,"groups":[],"rows":[{"issue":"$org-1"}]}""")
                .apply { if (org == delayFor) setHeadersDelay(1_200, TimeUnit.MILLISECONDS) }
        }
    }

    private fun start(vm: UsageViewModel) { watch = vm.viewModelScope.launch { vm.watchModelQuality() } }
    private fun issueOf(vm: UsageViewModel) = vm.modelQuality.value.view?.rows?.firstOrNull()?.issue

    @Test
    fun `one org asks for its rows, named as the header names it, several ask for none`() {
        // The unscoped read answers late, so the moment between the pick and it is observable.
        routeByOrg(delayFor = "all")
        hub.container.org.set(setOf("acme"))
        hub.seedFleet(fleet)
        val vm = UsageViewModel(hub.app)
        start(vm)
        hub.awaitFlow(vm.modelQuality) { it.view != null }
        val req = hub.findRequest("/api/model-quality")
        assertEquals("acme", req.requestUrl?.queryParameter("org"))
        assertEquals("1", req.requestUrl?.queryParameter("rows"))
        assertEquals("Acme Corp", vm.modelQuality.value.orgLabel)

        hub.container.org.set(setOf("acme", "rival"))
        assertNull("acme's rows must not survive a pick that is not acme", issueOf(vm))
        hub.awaitFlow(vm.modelQuality) { it.view != null }
        assertEquals("", vm.modelQuality.value.org)
    }

    @Test
    fun `an answer for an org the operator has since left is discarded`() {
        routeByOrg(delayFor = "acme")
        hub.container.org.set(setOf("acme"))
        hub.seedFleet(fleet)
        val vm = UsageViewModel(hub.app)
        start(vm)
        hub.container.org.set(setOf("rival"))
        hub.awaitFlow(vm.modelQuality) { it.view != null }
        assertEquals("rival-1", issueOf(vm))
        Thread.sleep(1_800)
        assertEquals("a stale org's answer must not replace the current one", "rival-1", issueOf(vm))
    }

    @Test
    fun `a refusal reads in the hub's words and is dropped on a pick change`() {
        routeByOrg(failFor = "acme", delayFor = "rival")
        hub.container.org.set(setOf("acme"))
        hub.seedFleet(fleet)
        val vm = UsageViewModel(hub.app)
        start(vm)
        hub.awaitFlow(vm.modelQuality) { it.error != null }
        assertEquals("ledger down", vm.modelQuality.value.error)
        hub.container.org.set(setOf("rival"))
        hub.awaitFlow(vm.modelQuality) { it.org == "rival" }
        assertNull("acme's error must not linger under rival's pick", vm.modelQuality.value.error)
    }
}
