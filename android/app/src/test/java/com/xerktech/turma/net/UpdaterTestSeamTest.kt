package com.xerktech.turma.net

import androidx.test.core.app.ApplicationProvider
import com.xerktech.turma.TurmaApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Guards the XERK-281 test seam: `TurmaApplication.onCreate` fires a
 * fire-and-forget `Updater.check()`, and Robolectric builds a fresh Application
 * per test METHOD, so the updater's ~15-min throttle never applies and every
 * test hit live `api.github.com` (~33 anonymous calls per suite from a
 * shared-IP CI runner). `Updater.check()` no-ops when [Updater.DISABLE_PROPERTY]
 * is set; `app/build.gradle.kts`'s `testOptions` sets it for the whole test JVM.
 *
 * If either half regresses — the gradle line dropped, or the guard removed —
 * these fail HERE rather than silently reintroducing the egress.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UpdaterTestSeamTest {

    /** The gradle `testOptions.systemProperty` reaches this JVM. */
    @Test
    fun disablePropertyIsSetForTheTestJvm() {
        assertEquals("true", System.getProperty(Updater.DISABLE_PROPERTY))
    }

    /** Under the property, `check()` no-ops — it never proceeds past its guard. */
    @Test
    fun checkNoOpsUnderTheDisableProperty() {
        val app = ApplicationProvider.getApplicationContext<TurmaApplication>()
        val updater = Updater(
            appContext = app,
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
            installedVersion = "0.0.1",
        )
        // `force = true` still no-ops: the disable gate is checked before the
        // throttle/force branch, so a test's "check now" cannot reach GitHub.
        updater.check(force = true)
        // `lastCheckAt`, not `state`: a check that RAN and whose fetch failed
        // (offline/blackholed CI) also lands on Hidden, so state alone cannot
        // tell "no-op'd" from "ran and failed" and would pass with the guard
        // removed. `lastCheckAt` is set only once check() proceeds, so it stays
        // 0 iff the guard actually short-circuited.
        assertEquals(0L, updater.lastCheckAt)
        assertTrue(updater.state.value is Updater.State.Hidden)
    }
}
