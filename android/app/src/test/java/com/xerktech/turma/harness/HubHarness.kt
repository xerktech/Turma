package com.xerktech.turma.harness

import androidx.test.core.app.ApplicationProvider
import com.xerktech.turma.AppContainer
import com.xerktech.turma.TurmaApplication
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.onSubscription
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.rules.ExternalResource

/**
 * A scripted hub for the ViewModel and screen tests (XERK-262).
 *
 * The call sites this exists to gate are the ones that read a HOST CAPABILITY
 * off the heartbeat and turn an HTTP refusal into words on screen, so the tests
 * drive the REAL Retrofit/OkHttp/kotlinx stack against a real socket rather than
 * a hand-rolled `HubApi` fake. A fake would prove the fake was called: it cannot
 * carry a 409 with a JSON `error` body, which is the exact shape
 * `hubErrorMessage` digs a reason back out of, and `FleetViewModel.run`'s whole
 * bug was mis-reading that shape.
 *
 * Nothing here needs a production seam. [AppContainer]'s `HubClient` rebuilds
 * its Retrofit whenever the configured base URL changes, so pointing [Config]
 * at this server after the app has started is enough to redirect every call.
 */
class HubHarness : ExternalResource() {

    lateinit var server: MockWebServer
        private set

    /** Real threads, for the collectors — never the test's Main dispatcher. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val app: TurmaApplication get() = ApplicationProvider.getApplicationContext()
    val container: AppContainer get() = app.container

    /**
     * Canned answers by path prefix, newest wins. A map rather than a response
     * QUEUE because these tests poll: `FleetRepository` refreshes on a timer and
     * the chat screen re-fetches, so a queue would empty mid-test and start
     * answering 404 for reasons that have nothing to do with what is asserted.
     */
    private val routes = LinkedHashMap<String, (RecordedRequest) -> MockResponse>()

    override fun before() {
        server = startServer()
        server.dispatcher = routingDispatcher()
        // Credentials as well as the URL: HubClient's interceptor stamps them on
        // every call, and an unconfigured Config makes the app treat itself as
        // signed out.
        container.config.save(server.url("/").toString(), "op", "pw")
    }

    /**
     * Bind a [MockWebServer], retrying a [BindException].
     *
     * `MockWebServer.start()` calls `setReuseAddress(port != 0)`, so on the port
     * 0 it uses here **SO_REUSEADDR is off** — and a kernel-picked ephemeral port
     * still in `TIME_WAIT` fails the bind outright. One server is started per
     * test METHOD, so on a box with a small `ip_local_port_range` this reddened
     * whole runs: measured 2 failures in 10 loaded runs (19 tests down in one of
     * them), all `BindException: Address already in use` from this line.
     *
     * A retry is the fix rather than a shared server, because per-test isolation
     * is what keeps one test's routes out of another's.
     */
    private fun startServer(attempts: Int = 8): MockWebServer {
        var last: java.io.IOException? = null
        repeat(attempts) {
            val candidate = MockWebServer()
            try {
                candidate.start()
                return candidate
            } catch (e: java.net.BindException) {
                last = e
                runCatching { candidate.shutdown() }
                Thread.sleep(25)
            }
        }
        throw AssertionError("could not bind a MockWebServer in $attempts attempts", last)
    }

    private fun routingDispatcher() = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                // LONGEST prefix wins, never insertion order: "/api/agents" is a
                // prefix of every per-session route, so an order-based match
                // would answer a `model-source` POST with the fleet payload the
                // moment a test seeded a fleet after registering the route.
                val hit = routes.entries
                    .filter { path.startsWith(it.key) }
                    .maxByOrNull { it.key.length }
                // 404 rather than a default 200: an unrouted call is a test that
                // has drifted from what the app actually asks for, and a silent
                // empty-body 200 would decode to a defaulted object and hide it.
                return hit?.value?.invoke(request) ?: MockResponse().setResponseCode(404)
            }
        }

    override fun after() {
        scope.cancel()
        container.fleet.stop()
        server.shutdown()
    }

    /** Answer any path starting with [prefix] using [respond]. */
    fun route(prefix: String, respond: (RecordedRequest) -> MockResponse) {
        routes[prefix] = respond
    }

    /** Answer [prefix] with [code] and a JSON [body]. */
    fun json(prefix: String, body: String, code: Int = 200) = route(prefix) {
        MockResponse().setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody(body)
    }

    /**
     * Serve [agentsJson] as the fleet and pull it in ONCE, synchronously.
     *
     * `FleetRepository.refresh()` is a suspend function that does the whole
     * fetch-and-emit, so awaiting it directly is what keeps these tests off the
     * 6-second poll — a test that started the poller and waited would be timing
     * against a real clock, which is how a suite starts failing on a loaded CI
     * runner for reasons no one can reproduce.
     */
    fun seedFleet(agentsJson: String) {
        json("/api/agents", agentsJson)
        runBlocking { container.fleet.refresh() }
        // `/api/agents` decodes ATOMICALLY, and `FleetRepository.refresh` catches
        // the throw and emits an EMPTY fleet with an error string. So a fixture
        // with one wrong-typed field does not fail here — it quietly delivers no
        // hosts, and every assertion downstream fails somewhere else entirely.
        // (Measured while writing these: `"repos": ["Turma"]` where the field is
        // `List<RepoInfo>` cost an hour of looking at the wrong ViewModel.) Fail
        // where the mistake actually is.
        val state = container.fleet.state.value
        if (state.error != null) {
            throw AssertionError("the fleet fixture did not decode: ${state.error}")
        }
        if (state.agents.isEmpty() && agentsJson.contains("\"key\"")) {
            throw AssertionError("the fleet fixture named a host but none decoded")
        }
    }

    /**
     * Spin until [read] returns non-null, or fail after [timeoutMs].
     *
     * For the paths that genuinely cannot be awaited: a ViewModel action whose
     * `viewModelScope.launch` returns no Job to join, whose result lands via a
     * `SharedFlow`, and whose HTTP leg resumes on OkHttp's own threads. The
     * dispatcher rule cannot make that synchronous, so this is a real wait
     * against a real clock — bounded, and it fails LOUD rather than asserting on
     * whatever was there when it gave up.
     */
    fun <T : Any> awaitValue(timeoutMs: Long = 10_000, read: () -> T?): T {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            read()?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("nothing arrived within ${timeoutMs}ms")
    }

    /**
     * Suspend until [flow] emits a value matching [pred], returning it — or fail
     * after [timeoutMs] (XERK-308).
     *
     * The event-driven counterpart to [awaitValue]'s 10ms poll, and the one to
     * reach for whenever the value under test is a `Flow`. It subscribes and is
     * resumed the INSTANT the value flips, so it spends no wall-clock spinning a
     * poll loop the scheduler can starve — which is what reddened these on a
     * loaded runner: a 10s deadline raced a poll slice against work the box was
     * too busy to schedule, and lost. Because a `StateFlow` replays its current
     * value to a new collector, a condition ALREADY satisfied returns at once
     * with no missed-emission race — the reason this is safe where a bare
     * `SharedFlow` await would not be (see [expectMessage]).
     *
     * Keep [awaitValue] only for a plain value with no flow behind it.
     */
    fun <T> awaitFlow(flow: Flow<T>, timeoutMs: Long = 10_000, pred: (T) -> Boolean): T =
        runBlocking {
            try {
                withTimeout(timeoutMs) { flow.first(pred) }
            } catch (e: TimeoutCancellationException) {
                throw AssertionError("no matching value within ${timeoutMs}ms", e)
            }
        }

    /**
     * Subscribe to [flow] NOW and return a getter that blocks for the first
     * message matching [pred] (XERK-308).
     *
     * The event-driven form of the `collectMessages` + `awaitValue { list
     * .firstOrNull() }` pair: the same subscribe-BEFORE-the-action discipline a
     * zero-replay `SharedFlow` demands (a message emitted before the collector
     * attaches is dropped), but the getter is resumed by the emission rather
     * than polling a list against a 10s deadline. Call it before the ViewModel
     * action, invoke the returned getter after.
     */
    fun expectMessage(
        flow: SharedFlow<String>,
        timeoutMs: Long = 10_000,
        pred: (String) -> Boolean = { true },
    ): () -> String {
        val hit = CompletableDeferred<String>()
        val subscribed = CompletableDeferred<Unit>()
        scope.launch {
            flow.onSubscription { subscribed.complete(Unit) }
                .collect { if (pred(it)) hit.complete(it) }
        }
        runBlocking { withTimeout(5_000) { subscribed.await() } }
        return {
            try {
                runBlocking { withTimeout(timeoutMs) { hit.await() } }
            } catch (e: TimeoutCancellationException) {
                throw AssertionError("no matching message within ${timeoutMs}ms", e)
            }
        }
    }

    /**
     * Drain recorded requests until one whose path contains [pathContains]
     * appears, or fail after [timeoutMs].
     *
     * MockWebServer 4.x exposes no request-list getter, only the blocking
     * `takeRequest`. This drains intervening requests (fleet polls, SSE
     * retries) in short slices until the matching one is dequeued.
     */
    fun findRequest(pathContains: String, timeoutMs: Long = 10_000): RecordedRequest {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val slice = (deadline - System.currentTimeMillis()).coerceIn(1L, 500L)
            val req = server.takeRequest(slice, TimeUnit.MILLISECONDS) ?: continue
            if (req.path?.contains(pathContains) == true) return req
        }
        throw AssertionError("no request matching '$pathContains' within ${timeoutMs}ms")
    }

    /**
     * Like [findRequest] but returns null instead of throwing when no matching
     * request was recorded within [timeoutMs] — for negative assertions.
     */
    fun findRequestOrNull(pathContains: String, timeoutMs: Long = 1_500): RecordedRequest? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val slice = (deadline - System.currentTimeMillis()).coerceIn(1L, 500L)
            val req = server.takeRequest(slice, TimeUnit.MILLISECONDS) ?: continue
            if (req.path?.contains(pathContains) == true) return req
        }
        return null
    }

    companion object {
        /** A refusal in the hub's own shape: the reason lives in the BODY. */
        fun refusal(reason: String, code: Int = 409) = MockResponse()
            .setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody("""{"ok":false,"error":"$reason"}""")

        /**
         * One host, optionally reporting a self-hosted model and one session.
         *
         * [now] exists because `FleetState` is a `data class` in a `StateFlow`,
         * which **conflates an equal value**: re-seeding a byte-identical fixture
         * emits NOTHING, so any collector-driven rule under test never runs and
         * the test passes without exercising it. Bump [now] whenever a test seeds
         * a second beat whose agent payload is deliberately unchanged. Nothing
         * reads it — `ModelSource.settle` takes the wall clock — so it moves the
         * emission without moving the rule.
         */
        fun fleetJson(
            host: String = "nas01",
            localModel: String? = null,
            dsh: String? = null,
            sessions: String = "",
            repo: String = "Turma",
            now: Long = 1,
            // The host's `jira` heartbeat block (the board's org) — a raw JSON
            // object; null for the no-board fixtures the other screens use.
            jira: String? = null,
            // Hub-owned triage maps (XERK-486): ticketTriageActions is keyed
            // "<siteKey>/<issueKey>", triagePolicies is keyed by siteKey. Raw
            // JSON objects, null for fixtures predating the feature.
            triageActions: String? = null,
            triagePolicies: String? = null,
        ): String = buildString {
            append("""{"now": $now, "agents": [{"key": "$host", "device": "$host", """)
            append("\"online\": true, \"terminalOnline\": true, ")
            append("\"repos\": [{\"name\": \"$repo\", \"lastActivity\": \"2026-08-12T00:00:00Z\"}],")
            if (localModel != null) append(" \"localModel\": $localModel,")
            if (dsh != null) append(" \"dsh\": $dsh,")
            append(" \"sessions\": [ $sessions ]")
            if (jira != null) append(", \"jira\": $jira")
            append(" }]")
            if (triageActions != null) append(", \"ticketTriageActions\": $triageActions")
            if (triagePolicies != null) append(", \"triagePolicies\": $triagePolicies")
            append(" }")
        }
    }
}
