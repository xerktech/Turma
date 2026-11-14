package com.xerktech.turma.core

import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.CalendarAnswer
import com.xerktech.turma.model.CalendarCapture
import com.xerktech.turma.model.CalendarEvent
import com.xerktech.turma.model.CalendarHost
import com.xerktech.turma.model.Holiday
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingCalendarEvent
import com.xerktech.turma.model.MeetingItem
import com.xerktech.turma.model.MeetingReview
import com.xerktech.turma.model.TurmaJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/**
 * The Calendar view's pure logic (XERK-2900), pinned against the web's
 * calendar.js behaviour (tests/calendar.test.js): week math across DST and the
 * year boundary, the Teams overlap layout, badges, notices, the notes review's
 * upcoming meetings and the wire's row-by-row decode.
 */
class CalendarTest {
    private val ny = ZoneId.of("America/New_York")
    private val utc = ZoneId.of("UTC")
    private fun at(y: Int, mo: Int, d: Int, h: Int, m: Int = 0, zone: ZoneId = ny) =
        ZonedDateTime.of(y, mo, d, h, m, 0, 0, zone).toInstant().toEpochMilli()

    private fun ev(
        id: String, s: Long, e: Long, org: String = "o", host: String = "h1",
        busy: String = "busy", resp: String = "accepted", allDay: Boolean = false,
        canceled: Boolean = false, meetings: List<CalendarCapture> = emptyList(),
    ) = CalendarEvent(
        host = host, org = org, id = id, source = "outlook", subject = "S $id", startMs = s, endMs = e,
        busy = busy, myResponse = resp, allDay = allDay, canceled = canceled, meetings = meetings,
    )

    // ---- week math ----

    @Test fun `the week runs Monday to Sunday and Work week is its first five days`() {
        val sat = LocalDate.of(2026, 11, 14)
        assertEquals(LocalDate.of(2026, 11, 9), calWeekStart(sat))
        assertEquals(LocalDate.of(2026, 11, 9), calWeekStart(LocalDate.of(2026, 11, 9)))
        assertEquals((9..13).map { LocalDate.of(2026, 11, it) }, calVisibleDays(sat, CalMode.WORK))
        assertEquals((9..15).map { LocalDate.of(2026, 11, it) }, calVisibleDays(sat, CalMode.WEEK))
        assertEquals(listOf(sat), calVisibleDays(sat, CalMode.DAY))
        assertEquals((14..16).map { LocalDate.of(2026, 11, it) }, calVisibleDays(sat, CalMode.THREE))
    }

    @Test fun `arrows move a week in the week modes, else by what is shown, across the year`() {
        val d = LocalDate.of(2026, 12, 30)
        assertEquals(LocalDate.of(2027, 1, 6), calStep(d, CalMode.WORK, 1))
        assertEquals(LocalDate.of(2026, 12, 23), calStep(d, CalMode.WEEK, -1))
        assertEquals(LocalDate.of(2027, 1, 2), calStep(d, CalMode.THREE, 1))
        assertEquals(LocalDate.of(2026, 12, 29), calStep(d, CalMode.DAY, -1))
        // The week of New Year's Eve 2026 starts Monday Dec 28.
        assertEquals(LocalDate.of(2026, 12, 28), calWeekStart(LocalDate.of(2027, 1, 1)))
        assertEquals(
            listOf(LocalDate.of(2026, 12, 21), LocalDate.of(2026, 12, 28), LocalDate.of(2027, 1, 4)),
            calWantedWeeks(calVisibleDays(d, CalMode.WORK)),
        )
        // Three days over a week boundary fetch both weeks (± one).
        assertEquals(2, calWeeksOf(calVisibleDays(LocalDate.of(2026, 11, 15), CalMode.THREE)).size)
    }

    @Test fun `a mode is kept per layout and an unknown one falls back`() {
        assertEquals(CalMode.WORK, CalMode.of(null, true))
        assertEquals(CalMode.DAY, CalMode.of("WEEK", false))   // a wide mode is not a phone's
        assertEquals(CalMode.THREE, CalMode.of("THREE", false))
        assertEquals(CalMode.WEEK, CalMode.of("WEEK", true))
    }

    @Test fun `wall minutes hold 9 AM at 540 on both DST edges`() {
        // US DST 2026: starts Sun Mar 8, ends Sun Nov 1.
        for (day in listOf(LocalDate.of(2026, 3, 8), LocalDate.of(2026, 11, 1), LocalDate.of(2026, 11, 2))) {
            assertEquals(day.toString(), 540.0, calWallMinutes(at(day.year, day.monthValue, day.dayOfMonth, 9), day, ny), 0.0)
        }
        // A 25h day: midnight to midnight is still clamped to [0, 1440].
        val fallBack = LocalDate.of(2026, 11, 1)
        assertEquals(0.0, calWallMinutes(at(2026, 10, 31, 23), fallBack, ny), 0.0)
        assertEquals(1440.0, calWallMinutes(at(2026, 11, 2, 0, 30), fallBack, ny), 0.0)
        assertEquals(25 * 3_600_000L, calDayStartMs(fallBack.plusDays(1), ny) - calDayStartMs(fallBack, ny))
        assertEquals(23 * 3_600_000L, calDayStartMs(LocalDate.of(2026, 3, 9), ny) - calDayStartMs(LocalDate.of(2026, 3, 8), ny))
    }

    // ---- events ----

    @Test fun `all-day and day-long events ride the band, a zero-length one belongs to its start day`() {
        val d = LocalDate.of(2026, 11, 10)
        assertTrue(calInBand(ev("a", at(2026, 11, 10, 0), at(2026, 11, 11, 0), allDay = true)))
        assertTrue(calInBand(ev("b", at(2026, 11, 10, 9), at(2026, 11, 11, 9))))
        assertFalse(calInBand(ev("c", at(2026, 11, 10, 9), at(2026, 11, 10, 10))))
        val zero = ev("z", at(2026, 11, 10, 9), at(2026, 11, 10, 9))
        assertTrue(calOnDay(zero, d, ny))
        assertFalse(calOnDay(zero, d.plusDays(1), ny))
        // An event ending at midnight does not touch the next day.
        assertFalse(calOnDay(ev("m", at(2026, 11, 10, 23), at(2026, 11, 11, 0)), d.plusDays(1), ny))
        val band = calBandEvents(listOf(ev("a", at(2026, 11, 10, 0), at(2026, 11, 12, 0), allDay = true)), d.plusDays(1), ny)
        assertEquals(listOf("a"), band.map { it.id })
    }

    @Test fun `overlapping events share the width and widen into free columns`() {
        val d = LocalDate.of(2026, 11, 10)
        val segs = calDaySegments(
            listOf(
                ev("a", at(2026, 11, 10, 9), at(2026, 11, 10, 11)),
                ev("b", at(2026, 11, 10, 9), at(2026, 11, 10, 10)),
                ev("c", at(2026, 11, 10, 10), at(2026, 11, 10, 10, 30)),
                ev("d", at(2026, 11, 10, 13), at(2026, 11, 10, 14)),
            ),
            d, ny,
        ).associateBy { it.ev.id }
        assertEquals(2, segs["a"]!!.cols)
        assertEquals(0, segs["a"]!!.col)
        assertEquals(1, segs["b"]!!.col)
        // c starts when b ends: it takes b's column, not a third one.
        assertEquals(1, segs["c"]!!.col)
        assertEquals(2, segs["c"]!!.cols)
        // d stands alone: the full width.
        assertEquals(1, segs["d"]!!.cols)
        assertEquals(1, segs["d"]!!.span)
    }

    @Test fun `an event widens into a free column on its right`() {
        val d = LocalDate.of(2026, 11, 10)
        val segs = calDaySegments(
            listOf(
                ev("a", at(2026, 11, 10, 9), at(2026, 11, 10, 12)),
                ev("b", at(2026, 11, 10, 9), at(2026, 11, 10, 10)),
                ev("c", at(2026, 11, 10, 9), at(2026, 11, 10, 9, 30)),
                ev("e", at(2026, 11, 10, 10), at(2026, 11, 10, 11)),
            ),
            d, ny,
        ).associateBy { it.ev.id }
        assertEquals(3, segs["a"]!!.cols)
        // e sits in b's column at 10:00, and c's column is free then: it spans two.
        assertEquals(1, segs["e"]!!.col)
        assertEquals(2, segs["e"]!!.span)
        assertEquals(1, segs["b"]!!.span)
    }

    @Test fun `a short or zero-length event lays out as 20 minutes`() {
        val d = LocalDate.of(2026, 11, 10)
        val s = calDaySegments(listOf(ev("z", at(2026, 11, 10, 9), at(2026, 11, 10, 9))), d, ny).single()
        assertEquals(540.0, s.top, 0.0)
        assertEquals(560.0, s.bottom, 0.0)
    }

    @Test fun `Teams styles follow busy and my response`() {
        val now = at(2026, 11, 10, 12)
        val s = at(2026, 11, 10, 9)
        val e = at(2026, 11, 10, 10)
        assertTrue(calStyle(ev("a", s, e, resp = "notResponded"), now).tentative)
        assertTrue(calStyle(ev("a", s, e, busy = "tentative"), now).tentative)
        assertTrue(calStyle(ev("a", s, e, resp = "declined"), now).free)
        assertTrue(calStyle(ev("a", s, e, busy = "free"), now).free)
        assertFalse(calStyle(ev("a", s, e, busy = "free", resp = "tentative"), now).free)
        assertTrue(calStyle(ev("a", s, e), now).past)
        assertFalse(calStyle(ev("a", now + 1, now + 2), now).past)
        assertTrue(calStyle(ev("a", s, e, canceled = true), now).canceled)
        assertEquals("Canceled: S a", calTitle(ev("a", s, e, canceled = true)))
        assertEquals("(no title)", calTitle(CalendarEvent(subject = "  ")))
    }

    // ---- badges ----

    private fun row(id: String, status: String = "ok", archived: Long = 0, vararg states: String?) = Meeting(
        meetingId = id, status = status, archivedAt = archived,
        items = states.mapIndexed { i, st -> MeetingItem(id = "p$i", title = "t", review = st?.let { MeetingReview(state = it) }) },
    )

    @Test fun `a badge counts a linked capture's pending proposals, never an archived one's`() {
        val caps = listOf(CalendarCapture("o", "m1"), CalendarCapture("o", "m2"), CalendarCapture("o", "m3"))
        val e = ev("a", 0, 1, meetings = caps)
        val meetings = mapOf("o" to listOf(
            row("m1", "ok", 0, null, "failed", "created"),     // 2 pending
            row("m2", "ok", 5, null, null),                    // archived: 0
            row("m3", "running"),
        ))
        assertEquals(CalBadge(2, true), calBadge(e, meetings))
        assertEquals("2 proposals to review", calBadgeText(CalBadge(2, true)))
        assertEquals("the meeting is being read", calBadgeText(CalBadge(0, true)))
        assertEquals("", calBadgeText(CalBadge(0, false)))
        // A Tenir entry the snapshot no longer carries reads its own status.
        val tenir = CalendarEvent(source = "tenir", site = "o", meetingId = "gone", status = "queued", startMs = 0, endMs = 1)
        assertEquals(CalBadge(0, true), calBadge(tenir, meetings))
        assertEquals(CalBadge(0, false), calBadge(ev("x", 0, 1), meetings))
    }

    // ---- notices ----

    @Test fun `a host is stale when offline, erroring, or not synced for the week`() {
        val from = 1_000L
        val until = 2_000L
        val cal = CalendarAnswer(hosts = listOf(
            CalendarHost(host = "ok", device = "ok", online = true, ranges = listOf(listOf(0L, 5_000L))),
            CalendarHost(host = "off@0123456789abcdef0123456789abcdef", online = false, syncedAt = 1, ranges = listOf(listOf(0L, 5_000L))),
            CalendarHost(host = "err", device = "Desk", online = true, lastError = "Outlook is not open", ranges = listOf(listOf(0L, 5_000L))),
            CalendarHost(host = "new", device = "Laptop", online = true, ranges = emptyList()),
            CalendarHost(host = "pend", device = "P", online = true, pending = true, ranges = listOf(listOf(0L, 5_000L))),
        ))
        val n = calHostNotices(cal, from, until).associateBy { it.host }
        assertNull(n["ok"])
        assertTrue(n["off@0123456789abcdef0123456789abcdef"]!!.offline)
        // A tenant host is labelled by its bare name, never its key.
        assertEquals("off", n["off@0123456789abcdef0123456789abcdef"]!!.device)
        assertTrue(n["new"]!!.syncing && n["new"]!!.never)
        assertTrue(n["pend"]!!.syncing)
        val now = 10_000_000L
        val l = Locale.US
        assertEquals("Syncing Laptop's Outlook for this week…", calNoticeText(n["new"]!!, now, utc, l))
        assertEquals("Desk: the calendar sync reported a problem — Outlook is not open.", calNoticeText(n["err"]!!, now, utc, l).replace(Regex(" \\(last synced.*\\)"), ""))
        assertTrue(calNoticeText(n["off@0123456789abcdef0123456789abcdef"]!!, now, utc, l).startsWith("off is offline — showing its calendar as last synced"))
        // An offline host that never synced the week says its events may be missing, and quotes the error as is.
        val never = HostNotice("x", "X", 0, offline = true, error = "the hub kept 10 of 20 events", syncing = false, never = true)
        assertEquals(
            "X is offline and has not synced this week; its events may be missing. Last sync problem: the hub kept 10 of 20 events",
            calNoticeText(never, now, utc, l),
        )
    }

    @Test fun `a holiday is a day off only for the orgs in view`() {
        val d = LocalDate.of(2026, 11, 26)
        val hol = listOf(Holiday(id = "us-thanksgiving", date = "2026-11-26", name = "Thanksgiving", offFor = listOf("a", "b")))
        assertEquals(listOf("a", "b"), calOffOrgs(d, hol, emptySet()))
        assertEquals(listOf("b"), calOffOrgs(d, hol, setOf("b", "c")))
        assertEquals(emptyList<String>(), calOffOrgs(d.plusDays(1), hol, emptySet()))
    }

    // ---- the notes review's upcoming meetings + cross-links ----

    @Test fun `an upcoming meeting is a live timed Outlook meeting of an org within a week`() {
        val now = at(2026, 11, 10, 8)
        val ok = ev("a", now + 3_600_000, now + 7_200_000)
        assertTrue(calIsUpcomingMeeting(ok, now))
        assertFalse(calIsUpcomingMeeting(ok.copy(org = ""), now))
        assertFalse(calIsUpcomingMeeting(ok.copy(canceled = true), now))
        assertFalse(calIsUpcomingMeeting(ok.copy(myResponse = "declined"), now))
        for (b in listOf("free", "outOfOffice", "workingElsewhere")) assertFalse(b, calIsUpcomingMeeting(ok.copy(busy = b), now))
        assertFalse(calIsUpcomingMeeting(ok.copy(allDay = true), now))
        assertFalse(calIsUpcomingMeeting(ok.copy(meetings = listOf(CalendarCapture("o", "m"))), now))
        assertFalse(calIsUpcomingMeeting(ok.copy(startMs = now + 8 * CAL_DAY_MS, endMs = now + 8 * CAL_DAY_MS + 1), now))
        assertFalse(calIsUpcomingMeeting(ok.copy(startMs = now - 7_200_000, endMs = now - 1), now))
        // One meeting on two hosts is listed once, soonest first.
        val list = calUpcoming("o", listOf(ok.copy(host = "h2"), ev("b", now + 60_000, now + 120_000), ok), now)
        assertEquals(listOf("b", "a"), list.map { it.id })
    }

    @Test fun `Open in notes review lands on the capture, else the upcoming meeting`() {
        val now = at(2026, 11, 10, 8)
        assertEquals(NotesTarget("o", "m1"), calNotesTarget(CalendarEvent(source = "tenir", site = "o", meetingId = "m1"), now))
        assertEquals(NotesTarget("o", "m2"), calNotesTarget(ev("a", 0, 1, meetings = listOf(CalendarCapture("o", "m2"))), now))
        assertEquals(NotesTarget("o", eventId = "a"), calNotesTarget(ev("a", now + 60_000, now + 120_000), now))
        assertNull(calNotesTarget(ev("a", 0, 1), now))
    }

    @Test fun `a reveal finds the capture's own entry before an event sharing its id`() {
        val t = CalTarget(0, "o", "m1", "E1")
        val linked = ev("E1", 0, 1, meetings = listOf(CalendarCapture("o", "m1")))
        val tenir = CalendarEvent(source = "tenir", id = "tenir:m1", site = "o", meetingId = "m1", startMs = 0, endMs = 1)
        assertEquals(tenir, calRevealFind(listOf(linked, tenir), t))
        assertEquals(linked, calRevealFind(listOf(linked), t))
        assertEquals(ev("E1", 0, 1), calRevealFind(listOf(ev("E1", 0, 1)), CalTarget(0, "o", eventId = "E1")))
        assertNull(calRevealFind(listOf(ev("E2", 0, 1)), t))
    }

    @Test fun `upcoming meetings join the triage, the daily occurrence joins its entry and a captured one is the capture's`() {
        val now = at(2026, 11, 10, 8, zone = utc)
        val sched = com.xerktech.turma.model.DailyBriefSchedule(enabled = true, time = "09:30", timeZone = "UTC",
            weekdays = listOf(0, 1, 2, 3, 4, 5, 6))
        val standup = ev("D", at(2026, 11, 10, 9, 40, utc), at(2026, 11, 10, 10, 0, utc))
        val other = ev("X", at(2026, 11, 11, 14, 0, utc), at(2026, 11, 11, 15, 0, utc))
        val captured = ev("C", at(2026, 11, 10, 7, 0, utc), at(2026, 11, 10, 9, 0, utc))
        val m = Meeting(meetingId = "m1", status = "ok", startedAt = at(2026, 11, 10, 7, 0, utc), calendarEventId = "C")
        val es = triageEntries("o", listOf(m), emptyList(), sched, now, utc, listOf(standup, other, captured))
        val daily = es.single { it.daily }
        assertEquals("D", daily.event?.id)
        val cal = es.single { it.cal }
        assertEquals("c:X", cal.key)
        assertEquals("S X", triageTitle(cal))
        assertEquals(0, cal.pending)
        assertFalse(cal.current)
        // Never Needs review on its own; listed under All; shown while selected; found by subject.
        assertFalse(triageShows(cal, TriageFilter.REVIEW, ""))
        assertTrue(triageShows(cal, TriageFilter.REVIEW, "", cal))
        assertTrue(triageShows(cal, TriageFilter.ALL, "s x"))
        assertFalse(triageShows(cal, TriageFilter.ALL, "nothing"))
        assertNull(triageNext(es, es.first())?.takeIf { it.cal })
    }

    @Test fun `a linked capture is named by its Outlook subject, never a private event's`() {
        val m = Meeting(title = "Meeting", inferredTitle = "Pricing", calendarEvent = MeetingCalendarEvent(subject = " Q4 pricing "))
        assertEquals("Q4 pricing", meetingTitle(m))
        assertEquals("Pricing", meetingTitle(m.copy(calendarEvent = MeetingCalendarEvent(subject = "Private event", private = true))))
        assertTrue(meetingImpromptu(Meeting()))
        assertFalse(meetingImpromptu(Meeting(calendarEventId = "E")))
        val lines = calMeetingLines(
            Meeting(calendarEventId = "E", calendarEvent = MeetingCalendarEvent(
                startMs = at(2026, 11, 10, 9, zone = utc), endMs = at(2026, 11, 10, 10, zone = utc),
                moved = true, attendees = listOf("Ann", "Bo"),
            )),
            utc, Locale.US,
        )
        assertEquals("On the calendar", lines[0].first)
        assertTrue(lines[0].second, lines[0].second.endsWith("· moved since"))
        assertEquals("Invited" to "Ann, Bo", lines[1])
        assertEquals("Impromptu", calMeetingLines(Meeting(calendarAmbiguous = true), utc, Locale.US).single().first)
        assertTrue(calMeetingLines(Meeting(calendarAmbiguous = true), utc, Locale.US).single().second.contains("more than one"))
        assertEquals(emptyList<Pair<String, String>>(), calMeetingLines(Meeting(calendarEventId = "E"), utc, Locale.US))
    }

    // ---- detail ----

    @Test fun `a moved occurrence is read off its id, a single event never moved`() {
        val s = at(2026, 11, 10, 10, zone = utc)
        val moved = ev("GAID:2026-11-10T09:00:00Z", s, s + 1).copy(seriesId = "GAID")
        assertEquals(at(2026, 11, 10, 9, zone = utc), calOriginalStart(moved))
        assertNotNull(calMovedFrom(moved))
        assertNull(calMovedFrom(ev("GAID:2026-11-10T10:00:00+00:00", s, s + 1).copy(seriesId = "GAID")))
        assertNull(calOriginalStart(ev("GAID:2026-11-10T09:00:00Z", s, s + 1)))   // no series
        assertNull(calOriginalStart(ev("GAID:garbage", s, s + 1).copy(seriesId = "GAID")))
    }

    @Test fun `relink candidates are same-day timed events of the capture's org, nearest first`() {
        val at9 = at(2026, 11, 10, 9, zone = utc)
        val events = listOf(
            ev("far", at9 + 5 * 3_600_000, at9 + 6 * 3_600_000),
            ev("near", at9 + 600_000, at9 + 1_200_000),
            ev("other", at9, at9 + 1, org = "x"),
            ev("cx", at9, at9 + 1, canceled = true),
            ev("tomorrow", at9 + CAL_DAY_MS, at9 + CAL_DAY_MS + 1),
            ev("hostorg", at9 + 60_000, at9 + 120_000, org = "", host = "h9"),
            ev("pinned", at9, at9 + 1, org = "").copy(matchOrg = ""),
        )
        val ids = calLinkCandidates("o", at9, "h1\u0000near", events, utc) { h -> if (h == "h9") "o" else "" }.map { it.id }
        assertEquals(listOf("hostorg", "far"), ids)
    }

    @Test fun `the panel shows one org's captures and an Outlook event's daily time`() {
        val e = ev("a", 5, 6, meetings = listOf(CalendarCapture("o", "m1"), CalendarCapture("p", "m2"), CalendarCapture("o", "m3")))
        assertEquals(CalPanelSpec("o", listOf("m1", "m3"), 5), calPanelSpec(e) { "" })
        assertEquals(CalPanelSpec("o", emptyList(), 5), calPanelSpec(ev("b", 5, 6)) { "" })
        assertNull(calPanelSpec(ev("b", 5, 6, org = "")) { "" })
        val tenir = CalendarEvent(source = "tenir", site = "o", meetingId = "m", startMs = 5)
        assertEquals(CalPanelSpec("o", listOf("m"), 0), calPanelSpec(tenir) { "" })
    }

    @Test fun `a join link opens only from https`() {
        assertEquals("https://teams.microsoft.com/l/x", calSafeHttps("https://teams.microsoft.com/l/x"))
        for (u in listOf("http://x", "javascript:alert(1)", "https://x\"onload", "https://a b")) assertEquals(u, "", calSafeHttps(u))
    }

    @Test fun `the range label spans a month and a year`() {
        val l = Locale.US
        assertEquals("November 9 – 13, 2026", calRangeLabel((9..13).map { LocalDate.of(2026, 11, it) }, l))
        assertEquals("November 30 – December 4, 2026", calRangeLabel(listOf(LocalDate.of(2026, 11, 30), LocalDate.of(2026, 12, 4)), l))
        assertEquals("December 28, 2026 – January 1, 2027", calRangeLabel(listOf(LocalDate.of(2026, 12, 28), LocalDate.of(2027, 1, 1)), l))
        assertEquals("November 14, 2026", calRangeLabel(listOf(LocalDate.of(2026, 11, 14)), l))
    }

    @Test fun `a range collects each week's events once and its notices`() {
        val days = calVisibleDays(LocalDate.of(2026, 11, 15), CalMode.THREE)   // Sun..Tue over two weeks
        val shared = ev("x", at(2026, 11, 15, 23, zone = utc), at(2026, 11, 16, 1, zone = utc))
        val w1 = CalWeek(CalendarAnswer(events = listOf(shared, CalendarEvent(id = "nostart"))), emptyList())
        val w2 = CalWeek(CalendarAnswer(events = listOf(shared)), listOf(Holiday(id = "h", date = "2026-11-16")), loading = true)
        val r = calCollect(days, utc) { if (it == LocalDate.of(2026, 11, 9)) w1 else w2 }
        assertEquals(listOf("x"), r.events.map { it.id })
        assertTrue(r.have)
        assertTrue(r.loading)
        assertEquals(1, r.holidays.size)
        val missing = calCollect(days, utc) { if (it == LocalDate.of(2026, 11, 9)) w1 else null }
        assertFalse(missing.have)
    }

    // ---- the wire ----

    @Test fun `one malformed event or host drops alone`() {
        val a = TurmaJson.decodeFromString<CalendarAnswer>("""
            { "from": 1, "until": 2, "truncated": true,
              "hosts": [ { "host": "h1", "online": true, "ranges": [[0, 9]] }, { "host": 5, "ranges": "x" } ],
              "events": [
                { "host": "h1", "id": "a", "subject": "<b>x</b>", "startMs": 1, "endMs": 2,
                  "attendees": [ { "name": "Ann", "response": "accepted" }, "junk" ],
                  "meetings": [ { "site": "o", "meetingId": "m1", "title": "T" } ] },
                { "host": "h1", "id": "b", "startMs": "soon" },
                { "host": "h1", "id": "c", "startMs": 5, "endMs": 6, "categories": { "x": 1 }, "participants": "Ann" },
                { "host": "h1", "id": "d", "startMs": 5, "endMs": 6, "categories": [1, "Red", null, {"x": 1}], "participants": ["Ann", 2] },
                { "source": "tenir", "id": "tenir:m2", "site": "o", "meetingId": "m2", "startMs": 3, "endMs": 4 }
              ] }
        """.trimIndent())
        // A wrong-typed list field reads as empty; the event stays (the web keeps it).
        assertEquals(listOf("a", "c", "d", "tenir:m2"), a.events.map { it.id })
        // Only string entries count, as the web filters them; a number never becomes "1".
        assertEquals(listOf("Red"), a.events[2].categories)
        assertEquals(listOf("Ann"), a.events[2].participants)
        assertEquals("<b>x</b>", a.events[0].subject)   // text, never markup
        assertEquals(listOf("Ann"), a.events[0].attendees.map { it.name })
        assertEquals(1, a.hosts.size)
        assertTrue(a.truncated)
        assertTrue(a.events[3].tenir)
    }

    @Test fun `a malformed calendarEvent reads as none and keeps its meeting`() {
        val r = TurmaJson.decodeFromString<AgentsResponse>("""
            { "now": 1, "agents": [], "meetingProposals": { "o": [
              { "meetingId": "m1", "status": "ok", "calendarEventId": "E", "calendarBy": "operator",
                "calendarEvent": { "subject": "Sync", "startMs": 1, "endMs": 2, "attendees": ["Ann"] } },
              { "meetingId": "m2", "status": "ok", "calendarEvent": { "attendees": [ { "name": "x" } ] } }
            ] } }
        """.trimIndent())
        val ms = r.meetingProposals["o"]!!
        assertEquals(listOf("m1", "m2"), ms.map { it.meetingId })
        assertEquals("Sync", ms[0].calendarEvent?.subject)
        assertEquals("operator", ms[0].calendarBy)
        assertNull(ms[1].calendarEvent)
    }

    @Test fun `XERK-2921 control and bidi characters in a calendar row are stripped at decode`() {
        // An older or forwarding hub that skipped sanitizeCalendarEvent (QA proxy: "ctl\u0007…").
        val a = TurmaJson.decodeFromString<CalendarAnswer>(
            "{\"hosts\":[{\"host\":\"h1\",\"device\":\"Lap\\u202etop\",\"lastError\":\"bad\\u0000\"}]," +
                "\"events\":[{\"host\":\"h1\",\"id\":\"a\",\"startMs\":1,\"endMs\":2," +
                "\"subject\":\"ctl\\u0007 \\u202eevil\\u200b\",\"body\":\"line1\\nline2\\tx\\u009f\"," +
                "\"attendees\":[{\"name\":\"A\\u2066nn\"}],\"categories\":[\"R\\ufeffed\"]}]}")
        val e = a.events.single()
        assertEquals("ctl evil", e.subject)
        assertEquals("line1\nline2\tx", e.body)        // newline and tab are kept
        assertEquals("Ann", e.attendees.single().name)
        assertEquals(listOf("Red"), e.categories)
        assertEquals("Laptop", a.hosts.single().device)
        assertEquals("bad", a.hosts.single().lastError)
        assertEquals("plain é 日本", com.xerktech.turma.model.cleanCalendarText("plain é 日本"))
    }
}
