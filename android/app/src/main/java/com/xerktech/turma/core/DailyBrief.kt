package com.xerktech.turma.core

import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.model.DailyBriefSchedule
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// ---- the Daily Brief screen (epic XERK-2390, Android half XERK-2397) ---------
//
// The hub writes and stores the briefs (`dailyBriefs`, newest first) and serves
// each org's standup schedule (`dailyBriefSchedules`); this is the pure logic
// the Brief screen renders: which row reads aloud, what the earlier rows say,
// and when the next meeting is.

private val TIME_RE = Regex("^([01]\\d|2[0-3]):([0-5]\\d)$")

/**
 * The next meeting (epoch ms) strictly after [now], or null when the schedule
 * is absent, disabled or unusable — the hub's `nextDailyBriefRun` meeting
 * instant. Weekdays are the MEETING's local weekday (0 = Sunday). A
 * spring-forward gap time lands an hour later and a fall-back repeated time on
 * its first occurrence, which is how `ZonedDateTime.of` resolves both and how
 * the hub fires (`contract-daily-brief.md`, "Time rules").
 */
fun nextBriefMeeting(s: DailyBriefSchedule?, now: Long): Long? {
    if (s == null || !s.enabled) return null
    val m = TIME_RE.matchEntire(s.time) ?: return null
    val zone = runCatching { ZoneId.of(s.timeZone) }.getOrNull() ?: return null
    val days = s.weekdays.filter { it in 0..6 }.toSet()
    if (days.isEmpty()) return null
    val time = LocalTime.of(m.groupValues[1].toInt(), m.groupValues[2].toInt())
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    // From yesterday, as the hub scans (XERK-2415): where the spring gap opens at
    // 23:00 (America/Nuuk) yesterday's 23:xx meeting lands after local midnight.
    // Through a week out, the latest a one-weekday schedule can be.
    for (i in -1L..7L) {
        val d = today.plusDays(i)
        if (d.dayOfWeek.value % 7 !in days) continue
        val at = ZonedDateTime.of(d, time, zone).toInstant().toEpochMilli()
        if (at > now) return at
    }
    return null
}

/**
 * "Today 9:30 AM" / "Tomorrow 9:30 AM" / "Mon 3 Nov, 9:30 AM", in the phone's
 * own [zone] and [locale] — the operator reads it against their own clock.
 */
fun briefWhenLabel(at: Long, now: Long, zone: ZoneId, locale: Locale): String {
    val t = Instant.ofEpochMilli(at).atZone(zone)
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(t)
    return when (t.toLocalDate()) {
        today -> "Today $time"
        today.plusDays(1) -> "Tomorrow $time"
        today.minusDays(1) -> "Yesterday $time"
        else -> DateTimeFormatter.ofPattern("EEE d MMM", locale).format(t) + ", $time"
    }
}

/**
 * One org's briefs split for the screen. [shown] is the newest finished brief,
 * read aloud in full; [running] a brief being written right now (Run now is
 * off while it is); [failed] the newest row when it failed — a notice above the
 * last good brief, never in its place; [earlier] every other row, headline only.
 */
data class BriefPage(
    val shown: DailyBrief?,
    val running: DailyBrief?,
    val failed: DailyBrief?,
    val earlier: List<DailyBrief>,
)

fun briefPage(list: List<DailyBrief>): BriefPage {
    val newest = list.firstOrNull()
    val running = newest?.takeIf { it.status == "running" }
    val failed = newest?.takeIf { it.status == "failed" }
    val shown = list.firstOrNull { it.status == "ok" }
    val earlier = list.filter { it !== shown && it !== running && it !== failed }
    return BriefPage(shown, running, failed, earlier)
}

/** The read-aloud sections of a full brief, in order, empty ones left out. */
fun briefSections(b: DailyBrief): List<Pair<String, String>> = listOf(
    "Since yesterday" to b.day,
    "This week" to b.week,
    "Up next" to b.next,
).filter { it.second.isNotBlank() }

// The day section's first sentence — the hub's `dailyBriefWire` headline rule,
// for a row served in full (a full row carries no `headline`).
private val FIRST_SENTENCE = Regex("^.*?[.!?](?= |$)")

/** What an earlier row says in the list: its headline, or why it has none. */
fun briefHeadline(b: DailyBrief): String = when (b.status) {
    "failed" -> "Not written: " + b.error.ifBlank { "the brief could not be written" }
    "running" -> "Being written…"
    else -> b.headline.ifBlank { FIRST_SENTENCE.find(b.day)?.value ?: b.day }
        .ifBlank { "No summary." }
}

/**
 * The instant a row is labelled with. A scheduled brief is ABOUT its meeting; a
 * Run now carries the upcoming meeting too, so three runs in a day would all
 * read "Tomorrow 9:30" — it is labelled with when it ran instead (XERK-2397 QA).
 */
fun briefAt(b: DailyBrief): Long = when {
    b.trigger == "manual" && b.startedAt > 0 -> b.startedAt
    b.meetingAt > 0 -> b.meetingAt
    else -> b.startedAt
}
