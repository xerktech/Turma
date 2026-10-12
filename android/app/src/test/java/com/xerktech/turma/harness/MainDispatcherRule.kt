package com.xerktech.turma.harness

import kotlinx.coroutines.Dispatchers
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
 */
class MainDispatcherRule(
    private val dispatcher: TestDispatcher = UnconfinedTestDispatcher(),
) : TestWatcher() {

    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}
