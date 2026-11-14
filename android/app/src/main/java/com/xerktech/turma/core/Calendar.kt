package com.xerktech.turma.core

import com.xerktech.turma.model.CalendarAnswer
import com.xerktech.turma.model.CalendarCapture
import com.xerktech.turma.model.CalendarEvent
import com.xerktech.turma.model.Holiday
import com.xerktech.turma.model.Meeting
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/*
 * The Meetings tab's Calendar view (XERK-2900), ported from the web's
 * calendar.js (XERK-2897/2898/2899) so phone and web place, style and badge an
 * event the same way. Pure, so CalendarTest pins it on the JVM. Rules + the
 * Teams decisions: .claude/rules/turma-meetings.md; the wire:
 * .claude/rules/contract-calendar.md.
 *
 * Week math is local wall time on java.time's calendar (LocalDate), never
 * `+ 86_400_000`: a DST week has a 23h and a 25h day (the web's `addDays`).
 */

const val CAL_DAY_MS = 86_400_000L
const val CAL_MIN_LAYOUT_MIN = 20          // a shorter (or zero-length) event lays out as 20 minutes
const val CAL_WORK_FROM_H = 8
const val CAL_WORK_UNTIL_H = 17
const val CAL_UPCOMING_MS = 7 * CAL_DAY_MS // how far ahead the notes review lists calendar meetings
const val CAL_DAILY_EVENT_MS = 20 * 60_000L // a daily entry and its calendar occurrence are one meeting

/** The view modes: Work week / Week on a wide screen, Day / 3 days on a phone (Teams' choice). */
enum class CalMode(val days: Int, val label: String, val wide: Boolean) {
    WORK(5, "Work week", true), WEEK(7, "Week", true), DAY(1, "Day", false), THREE(3, "3 days", false);

    val weekly: Boolean get() = this == WORK || this == WEEK

    companion object {
        fun of(name: String?, wide: Boolean): CalMode {
            val m = entries.firstOrNull { it.name == name && it.wide == wide }
            return m ?: if (wide) WORK else DAY
        }
    }
}

/** The Monday of [d]'s week (Teams' week runs Monday–Sunday). */
fun calWeekStart(d: LocalDate): LocalDate = d.minusDays((d.dayOfWeek.value - DayOfWeek.MONDAY.value).toLong())

/** The days [mode] shows around [anchor]. */
fun calVisibleDays(anchor: LocalDate, mode: CalMode): List<LocalDate> {
    val first = if (mode.weekly) calWeekStart(anchor) else anchor
    return (0 until mode.days).map { first.plusDays(it.toLong()) }
}

/** ‹ › move a week in the week modes, else by what is shown. */
fun calStep(anchor: LocalDate, mode: CalMode, dir: Int): LocalDate =
    anchor.plusDays(dir.toLong() * (if (mode.weekly) 7 else mode.days))

/** The weeks (their Mondays) a set of days touches: what is fetched. */
fun calWeeksOf(days: List<LocalDate>): List<LocalDate> = days.map(::calWeekStart).distinct()

/** The shown weeks plus one either side, so ‹ › paints at once (the web's `wantedWeeks`). */
fun calWantedWeeks(days: List<LocalDate>): List<LocalDate> {
    val vis = calWeeksOf(days)
    return listOf(vis.first().minusWeeks(1)) + vis + vis.last().plusWeeks(1)
}

/** The weeks the next [CAL_UPCOMING_MS] touch (the notes review's upcoming meetings). */
fun calUpcomingWeeks(now: Long, zone: ZoneId): List<LocalDate> =
    calWeeksOf(listOf(calDay(now, zone), calDay(now + CAL_UPCOMING_MS, zone)))

fun calDay(ms: Long, zone: ZoneId): LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()

fun calDayStartMs(d: LocalDate, zone: ZoneId): Long = d.atStartOfDay(zone).toInstant().toEpochMilli()

/** Minutes past [day]'s local midnight on the wall clock (9:00 sits at 540 on a DST day too). */
fun calWallMinutes(ms: Long, day: LocalDate, zone: ZoneId): Double {
    if (ms <= calDayStartMs(day, zone)) return 0.0
    if (ms >= calDayStartMs(day.plusDays(1), zone)) return 1440.0
    val t = Instant.ofEpochMilli(ms).atZone(zone)
    return t.hour * 60 + t.minute + t.second / 60.0
}

private fun CalendarEvent.s(): Long = startMs ?: 0
private fun CalendarEvent.e(): Long = endMs ?: 0

/** Drawable at all: the web skips a row without numeric start/end. */
fun calDrawable(ev: CalendarEvent): Boolean = ev.startMs != null && ev.endMs != null

/** An all-day event, or one lasting a day or more, rides the all-day band (as Teams draws it). */
fun calInBand(ev: CalendarEvent): Boolean = ev.allDay || ev.e() - ev.s() >= CAL_DAY_MS

/** Does the event touch [day]? A zero-length one belongs to its start's day. */
fun calOnDay(ev: CalendarEvent, day: LocalDate, zone: ZoneId): Boolean {
    val from = calDayStartMs(day, zone)
    val next = calDayStartMs(day.plusDays(1), zone)
    if (ev.e() <= ev.s()) return ev.s() in from until next
    return ev.s() < next && ev.e() > from
}

/** The Teams look of one event (the web's `styleOf` class list). */
data class CalStyle(
    val canceled: Boolean = false,
    val past: Boolean = false,
    val tentative: Boolean = false,
    val free: Boolean = false,
    val ooo: Boolean = false,
    val tenir: Boolean = false,
)

fun calStyle(ev: CalendarEvent, now: Long): CalStyle {
    val tentative = ev.busy == "tentative" || ev.myResponse == "tentative" || ev.myResponse == "notResponded"
    return CalStyle(
        canceled = ev.canceled,
        past = ev.endMs != null && maxOf(ev.e(), ev.s()) < now,
        tentative = tentative,
        free = !tentative && (ev.busy == "free" || ev.myResponse == "declined"),
        ooo = ev.busy == "outOfOffice",
        tenir = ev.tenir,
    )
}

/** "Canceled: <subject>", "(no title)" for a blank one. */
fun calTitle(ev: CalendarEvent): String {
    val s = jsTrim(ev.subject).ifEmpty { "(no title)" }
    return if (ev.canceled) "Canceled: $s" else s
}

private val NOT_MEETING_BUSY = setOf("free", "outOfOffice", "workingElsewhere")

/**
 * A meeting the notes review lists as upcoming (XERK-2899): a timed, live Outlook
 * meeting of an org — not all-day, canceled, declined, free / out of office /
 * working elsewhere, or already captured — ending after [now], starting within a week.
 */
fun calIsUpcomingMeeting(ev: CalendarEvent, now: Long): Boolean =
    !ev.tenir && ev.org.isNotEmpty() && calDrawable(ev) && !calInBand(ev) && !ev.canceled &&
        ev.myResponse != "declined" && ev.busy !in NOT_MEETING_BUSY && ev.meetings.isEmpty() &&
        ev.e() > now && ev.s() < now + CAL_UPCOMING_MS

/** The upcoming calendar meetings of [site] from [events], earliest first, one per Outlook id. */
fun calUpcoming(site: String, events: List<CalendarEvent>, now: Long): List<CalendarEvent> =
    events.filter { it.org == site && calIsUpcomingMeeting(it, now) }
        .distinctBy { it.id }
        .sortedWith(compareBy<CalendarEvent> { it.s() }.thenBy { it.e() })

/** Where "Open in notes review" lands: a capture, else an upcoming meeting; null = nothing there. */
data class NotesTarget(val site: String, val meetingId: String = "", val eventId: String = "")

fun calNotesTarget(ev: CalendarEvent, now: Long): NotesTarget? {
    if (ev.tenir && ev.site.isNotEmpty() && ev.meetingId.isNotEmpty()) return NotesTarget(ev.site, ev.meetingId)
    ev.meetings.firstOrNull { it.site.isNotEmpty() && it.meetingId.isNotEmpty() }
        ?.let { return NotesTarget(it.site, it.meetingId) }
    return if (calIsUpcomingMeeting(ev, now)) NotesTarget(ev.org, eventId = ev.id) else null
}

/** Where "Open in calendar" lands (XERK-2899): the event by id, or the one carrying the capture. */
data class CalTarget(val startMs: Long, val site: String = "", val meetingId: String = "", val eventId: String = "")

/** A capture's target: its linked event's time (else its own start). */
fun calMeetingTarget(site: String, m: Meeting): CalTarget =
    CalTarget(m.calendarEvent?.startMs ?: m.startedAt, site, m.meetingId, m.calendarEventId)

/** Does [ev] answer the reveal [t]? A capture's own entry or its linked event, else the id. */
fun calRevealHit(ev: CalendarEvent, t: CalTarget): Boolean {
    if (t.meetingId.isNotEmpty()) {
        if (ev.tenir) return ev.site == t.site && ev.meetingId == t.meetingId
        if (ev.meetings.any { it.site == t.site && it.meetingId == t.meetingId }) return true
    }
    return t.eventId.isNotEmpty() && !ev.tenir && ev.id == t.eventId
}

/** The reveal's event among [events]: a capture's own Tenir entry outranks one sharing its id. */
fun calRevealFind(events: List<CalendarEvent>, t: CalTarget): CalendarEvent? =
    events.firstOrNull { t.meetingId.isNotEmpty() && it.tenir && calRevealHit(it, t) }
        ?: events.firstOrNull { calRevealHit(it, t) }

/** One timed event laid out on a day: minutes [top]..[bottom], column [col] of [cols], [span] columns wide. */
data class CalSeg(
    val ev: CalendarEvent,
    val top: Double,
    val end: Double,
    val bottom: Double,
    val col: Int = 0,
    val cols: Int = 1,
    val span: Int = 1,
)

/**
 * Side-by-side columns, Teams-style (the web's `layoutDay`): each cluster of
 * (transitively) overlapping events splits the width into as many columns as it
 * needs at once, and an event widens into free columns to its right.
 */
fun calLayoutDay(segs: List<CalSeg>): List<CalSeg> {
    val list = segs.sortedWith(compareBy<CalSeg> { it.top }.thenByDescending { it.bottom })
    val out = ArrayList<CalSeg>(list.size)
    var cluster = ArrayList<CalSeg>()
    var cols = ArrayList<Double>()
    var maxBottom = Double.NEGATIVE_INFINITY
    fun finish() {
        for (s in cluster) {
            var span = 1
            while (s.col + span < cols.size &&
                cluster.none { o -> o.col == s.col + span && o.top < s.bottom && o.bottom > s.top }
            ) span++
            out += s.copy(cols = cols.size, span = span)
        }
        cluster = ArrayList(); cols = ArrayList(); maxBottom = Double.NEGATIVE_INFINITY
    }
    for (s in list) {
        if (cluster.isNotEmpty() && s.top >= maxBottom) finish()
        var col = cols.indexOfFirst { it <= s.top }
        if (col < 0) { col = cols.size; cols += s.bottom } else cols[col] = s.bottom
        cluster += s.copy(col = col)
        maxBottom = maxOf(maxBottom, s.bottom)
    }
    if (cluster.isNotEmpty()) finish()
    return out
}

/** The timed events of [day] as laid-out segments. */
fun calDaySegments(events: List<CalendarEvent>, day: LocalDate, zone: ZoneId): List<CalSeg> {
    val segs = events.filter { calDrawable(it) && !calInBand(it) && calOnDay(it, day, zone) }.map { ev ->
        val top = calWallMinutes(ev.s(), day, zone)
        val end = if (ev.e() > ev.s()) calWallMinutes(ev.e(), day, zone) else top
        CalSeg(ev, top, end, minOf(1440.0, maxOf(end, top + CAL_MIN_LAYOUT_MIN)))
    }
    return calLayoutDay(segs)
}

/** The band's events of [day]: all-day and ≥24h ones, one chip per day. */
fun calBandEvents(events: List<CalendarEvent>, day: LocalDate, zone: ZoneId): List<CalendarEvent> =
    events.filter { calDrawable(it) && calInBand(it) && calOnDay(it, day, zone) }

fun calDayKey(d: LocalDate): String = d.toString()   // ISO "YYYY-MM-DD", the hub's holiday `date`

/** The orgs in view [day] is a day off for: the header pick ([keys]), else every org. */
fun calOffOrgs(day: LocalDate, holidays: List<Holiday>, keys: Set<String>): List<String> {
    val k = calDayKey(day)
    return holidays.filter { it.date == k }.flatMap { it.offFor }
        .filter { it.isNotEmpty() && (keys.isEmpty() || it in keys) }.distinct()
}

/** One line per host whose copy may be stale (the web's `hostNotices`). */
data class HostNotice(
    val host: String,
    val device: String,
    val syncedAt: Long,
    val offline: Boolean,
    val error: String,
    val syncing: Boolean,
    val never: Boolean,
)

fun calHostNotices(cal: CalendarAnswer?, weekFromMs: Long, weekUntilMs: Long): List<HostNotice> {
    val out = mutableListOf<HostNotice>()
    for (h in cal?.hosts.orEmpty()) {
        val covered = h.ranges.any { r -> r.size >= 2 && r[0] <= weekFromMs && r[1] >= weekUntilMs }
        val n = HostNotice(
            host = h.host,
            device = h.device.ifEmpty { bareKey(h.host) },
            syncedAt = h.syncedAt,
            offline = h.online == false,
            error = h.lastError,
            syncing = h.online != false && (h.pending || !covered),
            never = !covered,
        )
        if (n.offline || n.error.isNotEmpty() || n.syncing) out += n
    }
    return out
}

/** "5 min ago", or the date once a day old (the web's `ago`). */
fun calAgo(ms: Long, now: Long, zone: ZoneId, locale: Locale): String {
    if (ms <= 0) return ""
    val s = maxOf(0L, Math.round((now - ms) / 1000.0))
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60} min ago"
        s < 86400 -> "${s / 3600} h ago"
        else -> DateTimeFormatter.ofPattern("MMM d, h:mm a", locale).format(Instant.ofEpochMilli(ms).atZone(zone))
    }
}

/** A stale-host notice. `lastError` is quoted as is (it may be the hub's budget words), never re-labelled. */
fun calNoticeText(n: HostNotice, now: Long, zone: ZoneId, locale: Locale): String {
    val whenText = calAgo(n.syncedAt, now, zone, locale)
    val err = if (n.error.isNotEmpty()) " Last sync problem: ${n.error}" else ""
    if (n.offline) {
        return (if (n.never) "${n.device} is offline and has not synced this week; its events may be missing."
        else "${n.device} is offline — showing its calendar as last synced" +
            (if (whenText.isNotEmpty()) " $whenText" else "") + ".") + err
    }
    if (n.error.isNotEmpty()) {
        return "${n.device}: the calendar sync reported a problem — ${n.error}" +
            (if (whenText.isNotEmpty()) " (last synced $whenText)" else "") + "."
    }
    return "Syncing ${n.device}'s Outlook for this week…"
}

/** The captures an event carries: a Tenir entry is its own; an Outlook event's linked ones. */
fun calCapturesOf(ev: CalendarEvent): List<CalendarCapture> =
    if (ev.tenir) {
        if (ev.site.isNotEmpty() && ev.meetingId.isNotEmpty()) listOf(CalendarCapture(ev.site, ev.meetingId)) else emptyList()
    } else ev.meetings.filter { it.site.isNotEmpty() && it.meetingId.isNotEmpty() }

/** A capture's row in the fleet snapshot, or null when the snapshot no longer carries it. */
fun calMeetingOf(meetings: Map<String, List<Meeting>>, c: CalendarCapture): Meeting? =
    meetings[c.site]?.firstOrNull { it.meetingId == c.meetingId }

/** A block's review badge (XERK-2898): proposals still pending (archived = 0), or the captions being read. */
data class CalBadge(val pending: Int, val reading: Boolean)

fun calBadge(ev: CalendarEvent, meetings: Map<String, List<Meeting>>): CalBadge {
    var pending = 0
    var reading = false
    for (c in calCapturesOf(ev)) {
        val m = calMeetingOf(meetings, c)
        if (m != null) {
            if (m.archivedAt <= 0) pending += meetingPendingCount(m)
            reading = reading || m.status == "queued" || m.status == "running"
        } else if (ev.tenir) {
            reading = reading || ev.status == "queued" || ev.status == "running"
        }
    }
    return CalBadge(pending, reading)
}

fun calBadgeText(b: CalBadge): String = when {
    b.pending > 0 -> "${b.pending} proposal${if (b.pending == 1) "" else "s"} to review"
    b.reading -> "the meeting is being read"
    else -> ""
}

private fun timeFmt(locale: Locale) = DateTimeFormatter.ofPattern("h:mm a", locale)

fun calTime(ms: Long, zone: ZoneId, locale: Locale): String =
    timeFmt(locale).format(Instant.ofEpochMilli(ms).atZone(zone))

/** "9:00 – 9:30 AM"-style span; the end alone on another day reads as the start only (the web's fmtSpan). */
fun calSpan(s: Long, e: Long, zone: ZoneId, locale: Locale): String =
    if (e > s) "${calTime(s, zone, locale)} – ${calTime(e, zone, locale)}" else calTime(s, zone, locale)

fun calLongDay(d: LocalDate, locale: Locale): String =
    DateTimeFormatter.ofPattern("EEEE, MMMM d", locale).format(d)

/** "Monday, November 9, 9:00 AM – 9:30 AM" or "…, all day". */
fun calWhenText(ev: CalendarEvent, zone: ZoneId, locale: Locale): String {
    val day = calLongDay(calDay(ev.s(), zone), locale)
    return if (calInBand(ev)) "$day, all day" else "$day, ${calSpan(ev.s(), ev.e(), zone, locale)}"
}

/** The range label: "November 9 – 13, 2026", across a month or year boundary too. */
fun calRangeLabel(days: List<LocalDate>, locale: Locale): String {
    val a = days.first()
    val b = days.last()
    val full = DateTimeFormatter.ofPattern("MMMM d, yyyy", locale)
    return when {
        a == b -> full.format(a)
        a.year != b.year -> "${full.format(a)} – ${full.format(b)}"
        a.month != b.month -> "${DateTimeFormatter.ofPattern("MMMM d", locale).format(a)} – ${full.format(b)}"
        else -> "${DateTimeFormatter.ofPattern("MMMM d", locale).format(a)} – ${b.dayOfMonth}, ${b.year}"
    }
}

fun calWeekdayLabel(d: LocalDate, short: Boolean, locale: Locale): String =
    d.dayOfWeek.getDisplayName(if (short) TextStyle.SHORT else TextStyle.FULL, locale)

/** The sentence a screen reader says for an event (the web's `ariaOf` + the badge). */
fun calAria(ev: CalendarEvent, day: LocalDate, orgLabel: String, badge: CalBadge, zone: ZoneId, locale: Locale): String {
    val bits = mutableListOf(calTitle(ev))
    bits += if (calInBand(ev)) "${calLongDay(day, locale)}, all day"
    else "${calLongDay(calDay(ev.s(), zone), locale)}, ${calSpan(ev.s(), ev.e(), zone, locale)}"
    if (ev.location.isNotEmpty()) bits += ev.location
    bits += orgLabel
    when {
        ev.busy == "tentative" || ev.myResponse == "tentative" -> bits += "tentative"
        ev.myResponse == "notResponded" -> bits += "not responded"
        ev.busy == "free" -> bits += "free"
    }
    if (ev.myResponse == "declined") bits += "declined"
    if (ev.tenir) bits += "captured by Tenir, not on Outlook"
    calBadgeText(badge).takeIf { it.isNotEmpty() }?.let { bits += it }
    return bits.joinToString(", ")
}

/**
 * An Outlook occurrence's original start, read off its id
 * (`<GlobalAppointmentID>:<original start ISO>`); null for a single event or a Tenir entry.
 */
fun calOriginalStart(ev: CalendarEvent): Long? {
    if (ev.tenir || ev.seriesId.isEmpty()) return null
    val i = ev.id.indexOf(':')
    if (i < 0) return null
    val iso = ev.id.substring(i + 1)
    return runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()
        ?: runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
}

/** "Moved from …": the occurrence starts a minute or more from where the series put it. */
fun calMovedFrom(ev: CalendarEvent): Long? {
    val o = calOriginalStart(ev) ?: return null
    return if (kotlin.math.abs(o - ev.s()) >= 60_000) o else null
}

/**
 * The org the hub's capture matcher counts an event for: the served `matchOrg`
 * (a series pinned to no org is ""), else (an older hub) its assigned org, else
 * its host's decided org ([hostOrg]).
 */
fun calEventOrg(ev: CalendarEvent, hostOrg: (String) -> String): String =
    ev.matchOrg ?: ev.org.ifEmpty { if (ev.tenir) "" else hostOrg(ev.host) }

/**
 * Outlook events a capture of [site] can move to: the same day as [at], timed,
 * not canceled, counted for its org, nearest its start first; ≤20.
 */
fun calLinkCandidates(
    site: String,
    at: Long,
    skipKey: String,
    events: List<CalendarEvent>,
    zone: ZoneId,
    hostOrg: (String) -> String,
): List<CalendarEvent> {
    val day = calDay(at, zone)
    return events.filter {
        !it.tenir && !it.canceled && calDrawable(it) && !calInBand(it) && it.key != skipKey &&
            calDay(it.s(), zone) == day && calEventOrg(it, hostOrg) == site && it.id.isNotEmpty()
    }.sortedBy { kotlin.math.abs(it.s() - at) }.take(20)
}

/** What the detail shows below Outlook's part: ONE org's captures and, for an Outlook event, its daily brief. */
data class CalPanelSpec(val site: String, val meetingIds: List<String>, val dailyAt: Long)

fun calPanelSpec(ev: CalendarEvent, hostOrg: (String) -> String): CalPanelSpec? {
    val caps = calCapturesOf(ev)
    val site = caps.firstOrNull()?.site ?: calEventOrg(ev, hostOrg)
    if (site.isEmpty()) return null
    return CalPanelSpec(site, caps.filter { it.site == site }.map { it.meetingId }, if (ev.tenir) 0 else ev.s())
}

/** The text of the response chips (the web's RESPONSE / MY_RESPONSE). */
fun calAttendeeResponse(r: String): String = when (r) {
    "organizer" -> "Organizer"
    "accepted" -> "Accepted"
    "tentative" -> "Tentative"
    "declined" -> "Declined"
    "notResponded" -> "Not responded"
    "none" -> "No response needed"
    else -> ""
}

fun calMyResponse(r: String): String = when (r) {
    "organizer" -> "You organized it"
    "accepted" -> "Accepted"
    "tentative" -> "Tentative"
    "declined" -> "Declined"
    "notResponded" -> "Not responded yet"
    else -> ""
}

private val SAFE_HTTPS = Regex("^https://[^\\s\"'<>`\\\\]+$", RegexOption.IGNORE_CASE)

/** A join link opens only from an https URL (the web's `safeHttps`); "" otherwise. */
fun calSafeHttps(u: String): String = if (SAFE_HTTPS.matches(u)) u else ""

/** The calendar lines under a capture (the web's `calLineHtml`). */
fun calMeetingLines(m: Meeting, zone: ZoneId, locale: Locale): List<Pair<String, String>> {
    val ev = m.calendarEvent
    if (ev != null) {
        val bits = mutableListOf<String>()
        val s = ev.startMs
        if (s != null) bits += calSpanLong(s, ev.endMs ?: s, zone, locale)
        if (ev.canceled) bits += "canceled"
        if (ev.moved) bits += "moved since"
        val out = mutableListOf("On the calendar" to bits.joinToString(" · "))
        val who = ev.attendees.filter { it.isNotEmpty() }
        if (who.isNotEmpty()) out += "Invited" to who.joinToString(", ")
        return out
    }
    if (m.calendarEventMissing) return listOf("" to "Its calendar event is no longer on the calendar.")
    if (!meetingImpromptu(m)) return emptyList()
    return listOf(
        "Impromptu" to "Not on the calendar" +
            (if (m.calendarAmbiguous) " — more than one calendar event could be it" else "") + ".",
    )
}

/** Captured with no calendar event: Tenir's own entry on the calendar (XERK-2899). */
fun meetingImpromptu(m: Meeting): Boolean = m.calendarEventId.isEmpty() && m.calendarEvent == null

/** "Mon, Nov 9, 9:00 AM – 9:30 AM" (the end's date only when it is another day). */
fun calSpanLong(s: Long, e: Long, zone: ZoneId, locale: Locale): String {
    val day = DateTimeFormatter.ofPattern("EEE, MMM d, h:mm a", locale)
    val start = day.format(Instant.ofEpochMilli(s).atZone(zone))
    if (e <= s) return start
    val end = if (calDay(s, zone) == calDay(e, zone)) calTime(e, zone, locale) else day.format(Instant.ofEpochMilli(e).atZone(zone))
    return "$start – $end"
}

/** One week's read (Monday–Sunday): the answer, its holidays, and the read's state. */
data class CalWeek(
    val cal: CalendarAnswer? = null,
    val hol: List<Holiday>? = null,
    val loading: Boolean = false,
    val err: String = "",
    val fails: Int = 0,
)

/** What a range of days shows, gathered from its weeks (the web's `collect`). */
data class CalRange(
    val events: List<CalendarEvent> = emptyList(),
    val holidays: List<Holiday> = emptyList(),
    val notices: List<HostNotice> = emptyList(),
    val loading: Boolean = false,
    val err: String = "",
    val truncated: Boolean = false,
    val have: Boolean = false,
)

/**
 * The events, holidays and stale-host notices of [days] from [weekOf] (a week's
 * read by its Monday): an event two weeks both hold appears once, earliest first.
 */
fun calCollect(days: List<LocalDate>, zone: ZoneId, weekOf: (LocalDate) -> CalWeek?): CalRange {
    val evs = LinkedHashMap<String, CalendarEvent>()
    val hol = LinkedHashMap<String, Holiday>()
    val hosts = LinkedHashMap<String, HostNotice>()
    var loading = false
    var err = ""
    var truncated = false
    var have = true
    for (ws in calWeeksOf(days)) {
        val w = weekOf(ws)
        if (w?.loading == true) loading = true
        if (!w?.err.isNullOrEmpty()) err = w!!.err
        val cal = w?.cal
        if (cal == null) { have = false; continue }
        if (cal.truncated) truncated = true
        for (ev in cal.events) if (calDrawable(ev)) evs[ev.key] = ev
        val from = calDayStartMs(ws, zone)
        for (n in calHostNotices(cal, from, calDayStartMs(ws.plusDays(7), zone))) {
            if (n.host !in hosts || n.syncing) hosts[n.host] = n
        }
        for (h in w.hol.orEmpty()) if (h.date.isNotEmpty()) hol["${h.date}\u0000${h.id}"] = h
    }
    val list = evs.values.sortedWith(compareBy<CalendarEvent> { it.startMs }.thenBy { it.endMs })
    return CalRange(list, hol.values.toList(), hosts.values.toList(), loading, err, truncated, have)
}
