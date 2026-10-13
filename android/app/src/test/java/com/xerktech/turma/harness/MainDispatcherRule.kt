package com.xerktech.turma.harness

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * Points `Dispatchers.Main` at a test dispatcher for the duration of a test
 * (XERK-262).
 *
 * Every ViewModel here launches on `viewModelScope`, which is hard-wired to
 * `Dispatchers.Main.immediate`. Off a device that dispatcher has no looper, so
 * the very first `viewModelScope.launch` throws — which is why `vm/` had no
 * tests at all and four mutations in it escaped.
 *
 * The default is [UnconfinedTestDispatcher], deliberately, and it is the whole
 * reason these tests read as straight-line code: it starts a coroutine EAGERLY
 * on the calling thread, so state a ViewModel sets before its first real
 * suspension point is already set when the constructor or the call returns.
 * `StandardTestDispatcher` would queue that work instead, so every assertion
 * would need an `advanceUntilIdle()` first — and one forgotten call is a test
 * that passes because it asserted on state nothing had written yet, which is
 * the failure mode this ticket is about.
 *
 * It is NOT a substitute for a real await. A ViewModel call that goes to the
 * network suspends on OkHttp's own threads, and no amount of dispatcher control
 * makes that resume synchronously — see `awaitValue` in [HubHarness].
 *
 * Wrap every ViewModel a test builds in [track] (rollup XERK-1584 #6). A
 * request still in flight when the test ends resumes on `Dispatchers.Main`
 * from an OkHttp thread. If that lands while the next test's `setMain` or
 * this test's `resetMain` runs, the test dispatcher throws "Dispatchers.Main
 * is used concurrently with setting it". Cancelling the tracked scopes first
 * means a late response resumes nothing.
 */
class MainDispatcherRule(
    private val dispatcher: TestDispatcher = UnconfinedTestDispatcher(),
) : TestWatcher() {

    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    /** Registers [vm] to have its scope cancelled before the hub stops and `Dispatchers.Main` resets. */
    fun <T : ViewModel> track(vm: T): T = vm.also { synchronized(tracked) { tracked += it } }

    override fun finished(description: Description) {
        cancelTracked()
        Dispatchers.resetMain()
    }

    companion object {
        // Process-wide, not per rule: [HubHarness] (an INNER rule) must cancel
        // these before its server.shutdown(), which aborts every in-flight call
        // and resumes it from an OkHttp thread; this rule's finished() runs
        // after that (QA: 5 of 150 calls resumed there). Tests in a JVM fork
        // run one at a time, so the list only ever holds this test's VMs.
        private val tracked = mutableListOf<ViewModel>()

        /** Cancels every tracked ViewModel's scope; idempotent. */
        fun cancelTracked() {
            val vms = synchronized(tracked) { tracked.toList().also { tracked.clear() } }
            vms.forEach { it.viewModelScope.cancel() }
        }
    }
}
