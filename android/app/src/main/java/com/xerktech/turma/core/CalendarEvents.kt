package com.xerktech.turma.core

import com.xerktech.turma.model.CalendarEvent
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * Turma-created calendar events (epic XERK-2967, Android XERK-2972): the editor's
 * draft, its validation, and the exact body `POST|PATCH /api/calendar/events`
 * takes (contract-calendar.md "Turma-created events"). Pure, so the payloads are
 * JVM-tested; the editor (ui/CalendarEventEditor.kt) only renders a draft.
 */

/** Every org a served event belongs to: a Turma event's `orgs`, else its one `org`. */
fun calOrgsOf(ev: CalendarEvent): List<String> =
    ev.orgs?.filter { it.isNotEmpty() }?.takeIf { it.isNotEmpty() } ?: listOfNotNull(ev.org.ifEmpty { null })

/** The hub's `CAL_TURMA_BUSY`, with the words the editor's Show-as pick reads. */
val CAL_SHOW_AS = listOf(
    "busy" to "Busy",
    "tentative" to "Tentative",
    "free" to "Free",
    "outOfOffice" to "Out of office",
    "workingElsewhere" to "Working elsewhere",
)

/** One attendee as the editor holds it; [role] is `required` or `optional` (the creator organizes). */
data class TurmaAttendee(val name: String, val email: String, val role: String)

/**
 * What the editor edits. [id]/[version] are set when editing an existing event
 * (the PATCH names the version it was made to); [endDate] of an all-day event is
 * its LAST day, inclusive, as a person reads it.
 */
data class TurmaEventDraft(
    val id: String = "",
    val version: Long? = null,
    val subject: String = "",
    val required: String = "",
    val optional: String = "",
    val startDate: LocalDate,
    val startTime: LocalTime,
    val endDate: LocalDate,
    val endTime: LocalTime,
    val allDay: Boolean = false,
    val timeZone: String,
    val location: String = "",
    val online: Boolean = false,
    val joinUrl: String = "",
    val body: String = "",
    val busy: String = "busy",
    val categories: String = "",
    val private: Boolean = false,
    // The stored sensitivity, so un-ticking Private on a confidential event keeps it.
    val sensitivity: String = "normal",
    val orgs: Set<String> = emptySet(),
) {
    val editing: Boolean get() = id.isNotEmpty()
}

/** The default new event's length (Outlook's own default). */
const val CAL_NEW_EVENT_MIN = 30

/**
 * A new event starting at [start] on [day], [CAL_NEW_EVENT_MIN] long, in the
 * phone's [zone], for [orgs] (the header pick, or the only org there is).
 */
fun calNewEventDraft(day: LocalDate, start: LocalTime, zone: ZoneId, orgs: Set<String>): TurmaEventDraft {
    val end = day.atTime(start).plusMinutes(CAL_NEW_EVENT_MIN.toLong())
    return TurmaEventDraft(
        startDate = day, startTime = start, endDate = end.toLocalDate(), endTime = end.toLocalTime(),
        timeZone = zone.id, orgs = orgs,
    )
}

/** The slot a tap at [minutes] past midnight lands in: rounded down to the half hour, kept inside the day. */
fun calSlotStart(minutes: Int): LocalTime {
    val m = (minutes.coerceIn(0, 24 * 60 - 30) / 30) * 30
    return LocalTime.of(m / 60, m % 60)
}

/** The next half hour from [now] on [day] when [day] is today, else 9 AM (the start of working hours). */
fun calDefaultStart(day: LocalDate, now: Long, zone: ZoneId): LocalTime {
    val t = java.time.Instant.ofEpochMilli(now).atZone(zone)
    if (t.toLocalDate() != day) return LocalTime.of(CAL_WORK_FROM_H, 0)
    return calSlotStart(t.hour * 60 + t.minute + 30)
}

/** The orgs a new event starts with: the header pick among [available], else the only one there is. */
fun calDefaultOrgs(picked: Collection<String>, available: Collection<String>): Set<String> {
    val p = picked.filter { it in available }.toSet()
    return p.ifEmpty { if (available.size == 1) available.toSet() else emptySet() }
}

/** A served Turma event as the editor's draft, on its own wall clock ([CalendarEvent.timeZone]). */
fun calDraftOf(ev: CalendarEvent, fallback: ZoneId): TurmaEventDraft {
    val zone = calZoneOrNull(ev.timeZone) ?: fallback
    fun at(iso: String, ms: Long?) = runCatching { OffsetDateTime.parse(iso).atZoneSameInstant(zone) }.getOrNull()
        ?: java.time.Instant.ofEpochMilli(ms ?: 0).atZone(zone)
    val s = at(ev.start, ev.startMs)
    var e = at(ev.end, ev.endMs)
    // All-day ends at the next midnight; the editor shows the last day.
    if (ev.allDay && e.toLocalTime() == LocalTime.MIDNIGHT && e.toLocalDate().isAfter(s.toLocalDate())) e = e.minusDays(1)
    fun names(role: String) = ev.attendees.filter { it.role == role }.joinToString(", ") { attendeeText(it.name, it.email) }
    return TurmaEventDraft(
        id = ev.id, version = ev.version, subject = ev.subject,
        required = names("required"), optional = names("optional"),
        startDate = s.toLocalDate(), startTime = s.toLocalTime().withSecond(0).withNano(0),
        endDate = e.toLocalDate(), endTime = e.toLocalTime().withSecond(0).withNano(0),
        allDay = ev.allDay, timeZone = zone.id, location = ev.location,
        online = ev.isOnlineMeeting, joinUrl = ev.joinUrl, body = ev.body,
        busy = ev.busy.takeIf { b -> CAL_SHOW_AS.any { it.first == b } } ?: "busy",
        categories = ev.categories.joinToString(", "),
        private = ev.sensitivity == "private", sensitivity = ev.sensitivity.ifEmpty { "normal" },
        orgs = calOrgsOf(ev).toSet(),
    )
}

private fun attendeeText(name: String, email: String): String = when {
    name.isNotEmpty() && email.isNotEmpty() -> "$name <$email>"
    else -> name.ifEmpty { email }
}

// The hub's `calEmail` accepts one plain address; anything looser is a 400 there.
private val EMAIL_RE = Regex("^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$")
private val NAMED_RE = Regex("^(.*?)\\s*<([^<>]+)>$")

/**
 * The attendees written in one field — "Ann <ann@x.com>", "bo@x.com" or a bare
 * name — split on commas, semicolons and new lines. A bare address is its own
 * name-less attendee; a bare name has no email.
 */
fun calParseAttendees(text: String, role: String): List<TurmaAttendee> =
    text.split(',', ';', '\n').map { jsTrim(it) }.filter { it.isNotEmpty() }.map { tok ->
        val m = NAMED_RE.matchEntire(tok)
        when {
            m != null -> TurmaAttendee(jsTrim(m.groupValues[1]).trim('"'), jsTrim(m.groupValues[2]), role)
            '@' in tok -> TurmaAttendee("", tok, role)
            else -> TurmaAttendee(tok, "", role)
        }
    }

fun calZoneOrNull(id: String): ZoneId? =
    if (id.isBlank()) null else runCatching { ZoneId.of(id.trim()) }.getOrNull()?.takeIf { it.id.contains('/') || it.id == "UTC" }

/** The draft's start and end instants, all-day ending at the midnight after its last day. */
fun calDraftSpan(d: TurmaEventDraft): Pair<OffsetDateTime, OffsetDateTime>? {
    val zone = calZoneOrNull(d.timeZone) ?: return null
    val s = if (d.allDay) d.startDate.atStartOfDay(zone) else d.startDate.atTime(d.startTime).atZone(zone)
    val e = if (d.allDay) d.endDate.plusDays(1).atStartOfDay(zone) else d.endDate.atTime(d.endTime).atZone(zone)
    return s.toOffsetDateTime() to e.toOffsetDateTime()
}

/** Every reason the draft cannot be saved yet, in the order the editor shows its fields; empty = saveable. */
fun calDraftErrors(d: TurmaEventDraft): List<String> = buildList {
    if (jsTrim(d.subject).isEmpty()) add("Give the event a title.")
    if (jsTrim(d.subject).codePointCount() > 300) add("The title is longer than 300 characters.")
    val people = calParseAttendees(d.required, "required") + calParseAttendees(d.optional, "optional")
    people.firstOrNull { it.email.isNotEmpty() && !EMAIL_RE.matches(it.email) }?.let { add("${it.email} is not an email address.") }
    if (people.size > 100) add("An event has at most 100 attendees.")
    if (calZoneOrNull(d.timeZone) == null) add("The time zone must be one like America/New_York.")
    else {
        val (s, e) = calDraftSpan(d)!!
        if (e.isBefore(s)) add("The event must end after it starts.")
    }
    if (jsTrim(d.location).codePointCount() > 300) add("The location is longer than 300 characters.")
    val url = jsTrim(d.joinUrl)
    if (url.isNotEmpty() && (!url.startsWith("https://") || url.length > 500)) add("The join link must be an https:// link.")
    if (d.body.codePointCount() > CAL_BODY_MAX) add("The details are longer than $CAL_BODY_MAX characters.")
    val cats = calCategories(d.categories)
    if (cats.size > 20 || cats.any { it.codePointCount() > 100 }) add("At most 20 categories of at most 100 characters.")
    if (d.orgs.isEmpty()) add("Pick at least one org.")
    if (d.orgs.size > CAL_TURMA_ORGS_MAX) add("An event belongs to at most $CAL_TURMA_ORGS_MAX orgs.")
}

/** The hub's `CALENDAR_BODY_MAX` and `CALENDAR_TURMA_ORGS_MAX`. */
const val CAL_BODY_MAX = 4000
const val CAL_TURMA_ORGS_MAX = 20

private fun String.codePointCount(): Int = codePointCount(0, length)

private fun calCategories(text: String): List<String> = text.split(',').map { jsTrim(it) }.filter { it.isNotEmpty() }

private val ISO = DateTimeFormatter.ISO_OFFSET_DATE_TIME

/**
 * The body of `POST /api/calendar/events` (create) or `PATCH …/<id>` (edit: it
 * carries the version the edit was made to). Every field is sent whole, so an
 * edit that clears one clears it on the hub too. [orgsOrder] keeps the org
 * order an edit started with (`org` = `orgs[0]` colours the event).
 */
fun calDraftPayload(d: TurmaEventDraft, orgsOrder: List<String> = emptyList()): JsonObject {
    val (s, e) = requireNotNull(calDraftSpan(d)) { "a draft with an unknown time zone has no payload" }
    val orgs = orgsOrder.filter { it in d.orgs } + d.orgs.filter { it !in orgsOrder }.sorted()
    val people = calParseAttendees(d.required, "required") + calParseAttendees(d.optional, "optional")
    return buildJsonObject {
        if (d.editing) d.version?.let { put("version", it) }
        put("orgs", JsonArray(orgs.map { JsonPrimitive(it) }))
        put("subject", jsTrim(d.subject))
        put("start", s.format(ISO))
        put("end", e.format(ISO))
        put("timeZone", calZoneOrNull(d.timeZone)!!.id)
        put("allDay", d.allDay)
        put("location", jsTrim(d.location))
        put("attendees", JsonArray(people.map { a ->
            buildJsonObject { put("name", a.name); put("email", a.email); put("role", a.role) }
        }))
        put("isOnlineMeeting", d.online)
        put("joinUrl", if (d.online) jsTrim(d.joinUrl) else "")
        put("body", d.body)
        put("busy", d.busy)
        put("categories", JsonArray(calCategories(d.categories).map { JsonPrimitive(it) }))
        put("sensitivity", if (d.private) "private" else d.sensitivity.takeIf { it != "private" } ?: "normal")
    }
}
