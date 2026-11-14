package com.xerktech.turma.vm

import android.app.Application
import android.content.Context
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.CalMode
import com.xerktech.turma.core.CalWeek
import com.xerktech.turma.core.calDay
import com.xerktech.turma.core.calDayStartMs
import com.xerktech.turma.core.calHostNotices
import com.xerktech.turma.core.calUpcomingWeeks
import com.xerktech.turma.core.calWantedWeeks
import com.xerktech.turma.model.CalendarAnswer
import com.xerktech.turma.model.LenientHolidaysSerializer
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.net.FleetState
import com.xerktech.turma.net.hubErrorMessage
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Backs the Meetings tab's Calendar view (XERK-2900, the web's calendar.js data
 * half). The events are too big for the fleet snapshot, so this reads
 * `GET /api/calendar` + `GET /api/holidays` per Monday–Sunday week itself, keyed
 * by the header's org pick (`<orgs>|<week>`; a read keeps the pick it started with).
 *
 * What re-reads it (each a web QA finding): a `calendar`, `holidaySettings` or
 * `meetingProposals` frame and a stream (re)open, coalesced 1s; a 60s poll while
 * the stream is down. A re-read covers only the shown weeks ± one (and the notes
 * review's upcoming weeks) and DROPS every other cached week. A failed read backs
 * off 20s doubling to 5 min; a host still syncing is re-read every 20s; both only
 * while the calendar (or the notes review's upcoming list) is in use.
 *
 * Also the view's per-phone preferences (the Calendar / Notes review switch and
 * each layout's mode) and the one write: relinking a capture to another event.
 */
class CalendarViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet: StateFlow<FleetState> get() = container.fleet.state

    private val zone: ZoneId get() = ZoneId.systemDefault()
    private var nowFn: () -> Long = System::currentTimeMillis

    private val _weeks = MutableStateFlow<Map<String, CalWeek>>(emptyMap())

    /** Every cached week's read by [weekKey]. */
    val weeks: StateFlow<Map<String, CalWeek>> = _weeks

    // A read's answer may resume off the main thread (a test's unconfined
    // dispatcher does), so the cache is written with update{} and the
    // bookkeeping below under [lock]: two weeks landing at once must not drop one.
    private val lock = Any()
    private val again = mutableSetOf<String>()
    private val retries = mutableMapOf<String, Job>()
    // Bumped when refetch() drops a week: a read landing after that is not stored.
    private val gen = mutableMapOf<String, Int>()

    private var active = false
    private var shownDays: List<LocalDate> = emptyList()
    private var orgs: List<String> = emptyList()
    private var upcomingWanted = false

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** A refused relink, in the hub's words (the screen toasts it). */
    val messages: SharedFlow<String> = _messages

    private val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private val _view = MutableStateFlow(runCatching { prefs.getString(VIEW_KEY, null) }.getOrNull() ?: VIEW_CALENDAR)

    /** "calendar" (the default) or "notes": the Meetings tab's view, remembered on this phone. */
    val view: StateFlow<String> = _view

    private val _modes = MutableStateFlow(
        mapOf(
            true to CalMode.of(runCatching { prefs.getString(MODE_WIDE, null) }.getOrNull(), true),
            false to CalMode.of(runCatching { prefs.getString(MODE_NARROW, null) }.getOrNull(), false),
        ),
    )

    /** The mode picked per layout (wide: Work week / Week; narrow: Day / 3 days). */
    val modes: StateFlow<Map<Boolean, CalMode>> = _modes

    init {
        @OptIn(FlowPreview::class)
        viewModelScope.launch {
            // The first value is the current count, not a frame.
            container.fleet.calendarFrames.drop(1).debounce(FRAME_COALESCE_MS).collect { refetch() }
        }
        viewModelScope.launch {
            while (true) {
                delay(STREAM_DOWN_POLL_MS)
                if (!container.fleet.streamUp.value && (active || upcomingWanted)) refetch()
            }
        }
    }

    fun start() = container.fleet.start()

    fun setView(v: String) {
        if (v != VIEW_CALENDAR && v != VIEW_NOTES) return
        _view.value = v
        runCatching { prefs.edit().putString(VIEW_KEY, v).apply() }
    }

    fun setMode(wide: Boolean, m: CalMode) {
        if (m.wide != wide) return
        _modes.value = _modes.value + (wide to m)
        runCatching { prefs.edit().putString(if (wide) MODE_WIDE else MODE_NARROW, m.name).apply() }
    }

    /** The calendar is on screen (or not): a failed week is asked again at once on showing. */
    fun setActive(on: Boolean) {
        active = on
        if (!on) return
        for ((k, w) in _weeks.value) if (w.err.isNotEmpty()) synchronized(lock) { retries.remove(k) }?.cancel()
        ensure()
    }

    /** What the grid shows now, and under which org pick ([keys], empty = every org). */
    fun show(days: List<LocalDate>, keys: Collection<String>) {
        shownDays = days
        orgs = keys.sorted()
        ensure()
    }

    /** The notes review reads the upcoming weeks, shown or not (XERK-2899). */
    fun wantUpcoming(keys: Collection<String>) {
        upcomingWanted = true
        orgs = keys.sorted()
        for (ws in calUpcomingWeeks(nowFn(), zone)) ensureWeek(ws)
    }

    fun weekKey(ws: LocalDate, keys: List<String> = orgs): String = "${keys.joinToString(",")}|$ws"

    /** The read of [ws] under the current org pick, or null when never asked. */
    fun weekOf(ws: LocalDate): CalWeek? = _weeks.value[weekKey(ws)]

    private fun ensure() {
        if (active && shownDays.isNotEmpty()) for (ws in calWantedWeeks(shownDays)) ensureWeek(ws)
    }

    private fun ensureWeek(ws: LocalDate) {
        val k = weekKey(ws)
        val w = _weeks.value[k]
        val waiting = synchronized(lock) { retries[k]?.isActive == true }
        if ((w?.cal == null || w.err.isNotEmpty()) && w?.loading != true && !waiting) loadWeek(ws, orgs)
    }

    /**
     * Something the calendar shows changed, or the stream was down: re-read the
     * shown weeks ± one and the upcoming weeks; drop every other cached week, so
     * a frame costs the same however many weeks were browsed.
     */
    fun refetch() {
        val keep = linkedSetOf<String>()
        if (active && shownDays.isNotEmpty()) for (ws in calWantedWeeks(shownDays)) keep += weekKey(ws)
        if (upcomingWanted) for (ws in calUpcomingWeeks(nowFn(), zone)) keep += weekKey(ws)
        val dropped = _weeks.value.keys - keep
        for (k in dropped) {
            synchronized(lock) {
                again -= k
                gen[k] = (gen[k] ?: 0) + 1
                retries.remove(k)
            }?.cancel()
        }
        if (dropped.isNotEmpty()) _weeks.update { it - dropped }
        val org = orgs.joinToString(",")
        for (k in keep) loadWeek(LocalDate.parse(k.substring(org.length + 1)), orgs)
    }

    /**
     * Read one week. A read already in flight is asked again once it lands, so a
     * frame mid-read is never lost; the read keeps the org pick it started with.
     */
    fun loadWeek(ws: LocalDate, keys: List<String>): Job? {
        val k = weekKey(ws, keys)
        var busy = false
        _weeks.update { m ->
            val w = m[k] ?: CalWeek()
            busy = w.loading
            if (busy) m else m + (k to w.copy(loading = true))
        }
        val myGen = synchronized(lock) {
            if (busy) again += k else again -= k
            if (!busy) retries.remove(k)?.cancel()
            gen[k] ?: 0
        }
        if (busy) return null
        val org = keys.joinToString(",")
        return viewModelScope.launch {
            val from = calDayStartMs(ws, zone)
            val until = calDayStartMs(ws.plusDays(7), zone)
            var cal: CalendarAnswer? = null
            var hol: List<com.xerktech.turma.model.Holiday>? = null
            val err = try {
                coroutineScope {
                    val c = async { container.client.api.calendar(from, until, org.ifEmpty { null }) }
                    val h = async { container.client.api.holidays(ws.toString(), ws.plusDays(6).toString()) }
                    val cr = c.await()
                    val hr = h.await()
                    when {
                        !cr.isSuccessful -> "Loading the calendar failed — ${hubErrorMessage(cr)}"
                        !hr.isSuccessful -> "Loading the calendar failed — ${hubErrorMessage(hr)}"
                        else -> {
                            cal = cr.body() ?: CalendarAnswer()
                            hol = hr.body()?.let { TurmaJson.decodeFromJsonElement(LenientHolidaysSerializer, it) }.orEmpty()
                            null
                        }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                "Loading the calendar failed — the hub is unreachable"
            }
            if (synchronized(lock) { gen[k] ?: 0 } != myGen) return@launch   // dropped by refetch() meanwhile
            var next = CalWeek()
            _weeks.update { m ->
                val prev = m[k] ?: CalWeek()
                next = if (err == null) CalWeek(cal, hol, loading = false, err = "", fails = 0)
                else prev.copy(loading = false, err = err, fails = prev.fails + 1)
                m + (k to next)
            }
            if (synchronized(lock) { k in again }) { loadWeek(ws, keys); return@launch }
            val syncing = next.cal?.let { c -> calHostNotices(c, from, until).any { it.syncing } } == true
            if (next.err.isNotEmpty() || syncing) {
                val wait = if (next.err.isNotEmpty()) {
                    minOf(RETRY_MS shl minOf(next.fails - 1, 8), RETRY_ERROR_MAX_MS)
                } else RETRY_MS
                val job = viewModelScope.launch {
                    delay(wait)
                    synchronized(lock) { retries.remove(k) }
                    if (active || upcomingWanted) loadWeek(ws, keys)
                }
                synchronized(lock) { retries[k] = job }
            }
        }
    }

    private val _linkBusy = MutableStateFlow<Set<String>>(emptySet())

    /** "site\u0000meetingId" with a relink POST in flight. */
    val linkBusy: StateFlow<Set<String>> = _linkBusy

    private val _linkErr = MutableStateFlow<Map<String, String>>(emptyMap())

    /** The hub's refusal per capture, shown under its relink controls. */
    val linkErr: StateFlow<Map<String, String>> = _linkErr

    fun clearLinkErrors() {
        _linkErr.value = emptyMap()
    }

    /**
     * Relink a capture (`POST .../meetings/<mid>/calendar`): `{eventId}` to another
     * event, `{eventId: null}` never linked, `{auto: true}` back to the matcher.
     * The answer's row patches the fleet; the shown weeks re-read.
     */
    fun relink(site: String, meetingId: String, body: JsonObject, what: String): Job? {
        val k = "$site\u0000$meetingId"
        if (k in _linkBusy.value) return null
        _linkBusy.update { it + k }
        _linkErr.update { it - k }
        return viewModelScope.launch {
            val err = try {
                val r = container.client.api.relinkMeeting(site, meetingId, body)
                val out = r.body()
                when {
                    !r.isSuccessful -> "$what failed — ${hubErrorMessage(r)}"
                    out == null || !out.ok -> "$what failed — " + (out?.error?.ifBlank { null } ?: "the hub refused it")
                    else -> { out.meeting?.let { row -> container.fleet.patchMeeting(site, row) }; null }
                }
            } catch (e: CancellationException) {
                _linkBusy.update { it - k }
                throw e
            } catch (_: Exception) {
                "$what failed — the hub is unreachable"
            }
            _linkBusy.update { it - k }
            if (err != null) {
                _linkErr.update { it + (k to err) }
                _messages.tryEmit("✗ $err")
            } else refetch()
        }
    }

    /** Today on this phone's clock (tests pin it). */
    fun today(): LocalDate = calDay(nowFn(), zone)

    fun now(): Long = nowFn()

    @androidx.annotation.VisibleForTesting
    internal fun setClock(f: () -> Long) {
        nowFn = f
    }

    companion object {
        const val VIEW_CALENDAR = "calendar"
        const val VIEW_NOTES = "notes"
        private const val PREFS = "turma-meetings-view"
        private const val VIEW_KEY = "view"
        private const val MODE_WIDE = "mode-wide"
        private const val MODE_NARROW = "mode-narrow"
        private const val FRAME_COALESCE_MS = 1_000L
        private const val STREAM_DOWN_POLL_MS = 60_000L
        private const val RETRY_MS = 20_000L
        private const val RETRY_ERROR_MAX_MS = 300_000L
    }
}
