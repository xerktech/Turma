package com.xerktech.turma.core

import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.model.DailyBriefSchedule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/** The Brief screen's pure logic (XERK-2397). */
class DailyBriefTest {
    private val ny = ZoneId.of("America/New_York")
    private fun ms(z: ZonedDateTime) = z.toInstant().toEpochMilli()
    private fun at(y: Int, mo: Int, d: Int, h: Int, mi: Int, zone: ZoneId = ny) =
        ms(ZonedDateTime.of(y, mo, d, h, mi, 0, 0, zone))

    private val weekdays = DailyBriefSchedule(
        enabled = true, time = "09:30", timeZone = "America/New_York", weekdays = listOf(1, 2, 3, 4, 5),
    )

    @Test fun `the next meeting is today's when it has not passed, else the next weekday`() {
        // Thu 2026-10-29.
        assertEquals(at(2026, 10, 29, 9, 30), nextBriefMeeting(weekdays, at(2026, 10, 29, 8, 0)))
        assertEquals(at(2026, 10, 30, 9, 30), nextBriefMeeting(weekdays, at(2026, 10, 29, 9, 30)))
        // Fri after the meeting → Monday (the weekend is skipped).
        assertEquals(at(2026, 11, 2, 9, 30), nextBriefMeeting(weekdays, at(2026, 10, 30, 10, 0)))
        // A one-weekday schedule just past its meeting → a week out.
        val thu = weekdays.copy(weekdays = listOf(4))
        assertEquals(at(2026, 11, 5, 9, 30), nextBriefMeeting(thu, at(2026, 10, 29, 9, 31)))
    }

    @Test fun `DST gaps fire an hour later and repeats on the first occurrence, as the hub does`() {
        val s = weekdays.copy(time = "02:30", weekdays = (0..6).toList())
        // 2026-03-08 02:30 does not exist in New York: 03:30 EDT = 07:30Z.
        assertEquals(ms(ZonedDateTime.of(2026, 3, 8, 7, 30, 0, 0, ZoneId.of("UTC"))),
            nextBriefMeeting(s, at(2026, 3, 8, 0, 0)))
        // 2026-11-01 01:30 happens twice: the first is EDT = 05:30Z.
        val fb = s.copy(time = "01:30")
        assertEquals(ms(ZonedDateTime.of(2026, 11, 1, 5, 30, 0, 0, ZoneId.of("UTC"))),
            nextBriefMeeting(fb, at(2026, 11, 1, 0, 0)))
    }

    @Test fun `a 23xx meeting the spring gap pushes past midnight is still next, as the hub finds it`() {
        // Nuuk's 2025 gap opens 23:00 on 03-29: 23:30 that day is 01:30Z on 03-30,
        // after local midnight (01:00Z). At 01:10Z it is still the next meeting.
        val s = weekdays.copy(time = "23:30", timeZone = "America/Godthab", weekdays = (0..6).toList())
        val utc = ZoneId.of("UTC")
        assertEquals(ms(ZonedDateTime.of(2025, 3, 30, 1, 30, 0, 0, utc)),
            nextBriefMeeting(s, ms(ZonedDateTime.of(2025, 3, 30, 1, 10, 0, 0, utc))))
        // After it, the following day's 23:30, now at -01.
        assertEquals(ms(ZonedDateTime.of(2025, 3, 31, 0, 30, 0, 0, utc)),
            nextBriefMeeting(s, ms(ZonedDateTime.of(2025, 3, 30, 1, 30, 0, 0, utc))))
    }

    @Test fun `no next meeting for an absent, disabled or unusable schedule`() {
        val now = at(2026, 10, 29, 8, 0)
        assertNull(nextBriefMeeting(null, now))
        assertNull(nextBriefMeeting(weekdays.copy(enabled = false), now))
        assertNull(nextBriefMeeting(weekdays.copy(time = "9:30"), now))
        assertNull(nextBriefMeeting(weekdays.copy(time = "24:00"), now))
        assertNull(nextBriefMeeting(weekdays.copy(timeZone = "Mars/Olympus"), now))
        assertNull(nextBriefMeeting(weekdays.copy(weekdays = emptyList()), now))
        assertNull(nextBriefMeeting(weekdays.copy(weekdays = listOf(7, -1)), now))
    }

    @Test fun `when labels read against the phone's own clock`() {
        val now = at(2026, 10, 29, 8, 0)
        assertEquals("Today 9:30 AM", briefWhenLabel(at(2026, 10, 29, 9, 30), now, ny, Locale.US))
        assertEquals("Tomorrow 9:30 AM", briefWhenLabel(at(2026, 10, 30, 9, 30), now, ny, Locale.US))
        assertEquals("Yesterday 9:30 AM", briefWhenLabel(at(2026, 10, 28, 9, 30), now, ny, Locale.US))
        assertEquals("Mon 2 Nov, 9:30 AM", briefWhenLabel(at(2026, 11, 2, 9, 30), now, ny, Locale.US))
        // Same instant, a phone in London.
        assertEquals("Today 1:30 PM",
            briefWhenLabel(at(2026, 10, 29, 9, 30), now, ZoneId.of("Europe/London"), Locale.US))
    }

    private fun row(id: String, status: String, day: String = "", headline: String = "", error: String = "") =
        DailyBrief(runId = id, status = status, day = day, headline = headline, error = error)

    @Test fun `the page reads the newest ok brief, with running and failed above it`() {
        val p = briefPage(listOf(
            row("r", "running"), row("o2", "ok", day = "A."), row("f", "failed", error = "x"), row("o1", "ok"),
        ))
        assertEquals("r", p.running?.runId)
        assertNull(p.failed)
        assertEquals("o2", p.shown?.runId)
        assertEquals(listOf("f", "o1"), p.earlier.map { it.runId })

        val f = briefPage(listOf(row("f", "failed", error = "no host"), row("o", "ok")))
        assertEquals("f", f.failed?.runId)
        assertEquals("o", f.shown?.runId)
        assertEquals(emptyList<String>(), f.earlier.map { it.runId })

        val empty = briefPage(emptyList())
        assertNull(empty.shown)
        assertEquals(emptyList<DailyBrief>(), empty.earlier)
    }

    @Test fun `sections keep the hub's order and drop empty ones`() {
        val b = DailyBrief(status = "ok", day = "Shipped two.", week = "", next = "XERK-1 next.")
        assertEquals(listOf("Since yesterday" to "Shipped two.", "Up next" to "XERK-1 next."), briefSections(b))
    }

    @Test fun `headlines say what an earlier row is`() {
        assertEquals("One shipped.", briefHeadline(row("a", "ok", headline = "One shipped.")))
        // A full row (no headline): the day's first sentence, the hub's rule.
        assertEquals("v1.2 is out.", briefHeadline(row("a", "ok", day = "v1.2 is out. Then more.")))
        assertEquals("Not written: no host", briefHeadline(row("a", "failed", error = "no host")))
        assertEquals("Not written: the brief could not be written", briefHeadline(row("a", "failed")))
        assertEquals("Being written…", briefHeadline(row("a", "running")))
        assertEquals("No summary.", briefHeadline(row("a", "ok")))
    }

    @Test fun `a scheduled row is labelled by its meeting, a Run now by when it ran`() {
        val sched = DailyBrief(trigger = "scheduled", meetingAt = 500, startedAt = 200)
        assertEquals(500L, briefAt(sched))
        assertEquals(200L, briefAt(DailyBrief(trigger = "manual", meetingAt = 500, startedAt = 200)))
        assertEquals(500L, briefAt(DailyBrief(trigger = "manual", meetingAt = 500)))
    }
}
