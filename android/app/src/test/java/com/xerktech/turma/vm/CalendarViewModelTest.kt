package com.xerktech.turma.vm

import com.xerktech.turma.core.CalMode
import com.xerktech.turma.core.calVisibleDays
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import java.time.LocalDate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Calendar view's week cache (XERK-2900 QA findings): a dropped week's late
 * answer is never stored, a stalled calendar read never starves the fleet poll,
 * an unreadable 200 is not "unreachable", and a push's Notes review is not kept.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CalendarViewModelTest {
    // Virtual time for the frame throttle; everything else runs eagerly as usual.
    private val scheduler = kotlinx.coroutines.test.TestCoroutineScheduler()

    @get:Rule(order = 0)
    val main = MainDispatcherRule(kotlinx.coroutines.test.UnconfinedTestDispatcher(scheduler))

    @get:Rule(order = 1)
    val hub = HubHarness()

    private val empty = """{ "from": 0, "until": 1, "hosts": [], "events": [] }"""

    private fun vm() = main.track(CalendarViewModel(hub.app))

    @Test fun `a week dropped by a re-read does not come back when its late answer lands`() {
        val held = CountDownLatch(1)
        val asked = CountDownLatch(1)
        val w1 = LocalDate.of(2026, 11, 9)
        val far = LocalDate.of(2027, 6, 7)
        hub.json("/api/holidays", "[]")
        hub.route("/api/calendar") { req ->
            val from = req.requestUrl!!.queryParameter("from")!!.toLong()
            if (from == w1.atStartOfDay(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()) {
                asked.countDown()
                held.await(10, TimeUnit.SECONDS)
            }
            MockResponse().setHeader("Content-Type", "application/json").setBody(empty)
        }
        val cvm = vm()
        val job = cvm.loadWeek(w1, emptyList())
        assertNotNull(job)
        assertEquals(true, asked.await(10, TimeUnit.SECONDS))
        // The grid moved far away and a frame re-read: w1 is dropped while its read is out.
        cvm.setActive(true)
        cvm.show(calVisibleDays(far, CalMode.WEEK), emptyList())
        cvm.refetch()
        assertFalse(cvm.weekKey(w1, emptyList()) in cvm.weeks.value)
        held.countDown()
        runBlocking { withTimeout(10_000) { job!!.join() } }
        assertFalse("a dropped week came back", cvm.weekKey(w1, emptyList()) in cvm.weeks.value)
    }

    @Test fun `a stalled calendar read never holds up the fleet poll`() {
        val held = CountDownLatch(1)
        hub.json("/api/holidays", "[]")
        hub.route("/api/calendar") { held.await(15, TimeUnit.SECONDS); MockResponse().setBody(empty) }
        hub.json("/api/agents", """{ "now": 7, "agents": [] }""")
        val cvm = vm()
        // Far more reads than OkHttp's 5-per-host slots on one dispatcher.
        val base = LocalDate.of(2026, 11, 9)
        repeat(8) { cvm.loadWeek(base.plusWeeks(it.toLong()), emptyList()) }
        try {
            runBlocking { withTimeout(5_000) { hub.container.fleet.refresh() } }
            assertEquals(7L, hub.container.fleet.state.value.now)
        } finally {
            held.countDown()
        }
    }

    @Test fun `a 200 that is not the hub's answer reads as unreadable, not unreachable`() {
        hub.json("/api/holidays", "[]")
        hub.route("/api/calendar") {
            MockResponse().setHeader("Content-Type", "application/json").setBody("[\"portal\"]")
        }
        val cvm = vm()
        val ws = LocalDate.of(2026, 11, 9)
        runBlocking { withTimeout(10_000) { cvm.loadWeek(ws, emptyList())!!.join() } }
        assertEquals(
            "Loading the calendar failed — the hub's answer could not be read",
            cvm.weeks.value[cvm.weekKey(ws, emptyList())]?.err,
        )
    }

    @Test fun `a view shown without remembering leaves the kept view alone`() {
        val cvm = vm()
        cvm.setView(CalendarViewModel.VIEW_CALENDAR)
        cvm.setView(CalendarViewModel.VIEW_NOTES, remember = false)
        assertEquals(CalendarViewModel.VIEW_NOTES, cvm.view.value)
        assertEquals(CalendarViewModel.VIEW_CALENDAR, vm().view.value)
    }

    @Test fun `frames are throttled like the web's, never pushed back by the next one`() {
        hub.json("/api/holidays", "[]")
        hub.json("/api/calendar", empty)
        val cvm = vm()
        val ws = LocalDate.of(2026, 11, 9)
        runBlocking { withTimeout(10_000) { cvm.loadWeek(ws, emptyList())!!.join() } }
        // Not shown and no upcoming list: a re-read keeps nothing, so it drops this week.
        val key = cvm.weekKey(ws, emptyList())
        assertEquals(true, key in cvm.weeks.value)
        val fleet = hub.container.fleet
        fleet.onSseEvent("calendar", "{}")
        // Coalesced: no re-read inside the first second (a burst must not re-read per frame).
        scheduler.runCurrent()
        assertEquals("re-read before the throttle's second", true, key in cvm.weeks.value)
        scheduler.advanceTimeBy(600); scheduler.runCurrent()
        assertEquals("re-read before the throttle's second", true, key in cvm.weeks.value)
        fleet.onSseEvent("calendar", "{}")      // 600ms later: must not push the re-read back
        scheduler.advanceTimeBy(500); scheduler.runCurrent()
        // 1.1s after the FIRST frame: the throttled re-read has run (a debounce would wait to 1.6s).
        assertFalse("the re-read waited out the second frame", key in cvm.weeks.value)
    }
}
