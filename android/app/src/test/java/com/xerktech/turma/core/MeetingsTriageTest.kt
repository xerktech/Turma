package com.xerktech.turma.core

import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.model.DailyBriefSchedule
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingDaily
import com.xerktech.turma.model.MeetingItem
import com.xerktech.turma.model.MeetingLabelMiss
import com.xerktech.turma.model.MeetingReview
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.ui.scheduleTime
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * The Brief screen's triage list (XERK-2858), ported from the web's
 * `entriesOf`/`inFilter`/`bucketOf` (XERK-2857). Fixtures are in HUB order —
 * newest first — since that order is what the pairing must survive.
 */
class MeetingsTriageTest {
    private val utc = ZoneId.of("UTC")
    private fun at(d: Int, h: Int, m: Int = 0) =
        ZonedDateTime.of(2026, 11, d, h, m, 0, 0, utc).toInstant().toEpochMilli()
    private val now = at(12, 8) // a Thursday
    private val daily = DailyBriefSchedule(enabled = true, time = "09:30", timeZone = "UTC",
        weekdays = listOf(1, 2, 3, 4, 5))

    private fun item(id: String, state: String? = null) =
        MeetingItem(id = id, kind = "task", title = "Item $id", review = state?.let { MeetingReview(state = it) })

    private fun entry(key: String, m: Meeting?, at: Long = now, daily: Boolean = false,
                      upcoming: Boolean = false, current: Boolean = false, site: String = "s") =
        TriageEntry(key, site, at, listOfNotNull(m), daily = daily, upcoming = upcoming, current = current)

    @Test fun `a proposal is pending until reviewed, a failed create stays pending`() {
        assertTrue(meetingItemPending(item("a")))
        assertTrue(meetingItemPending(item("a", "failed")))
        for (s in listOf("rejected", "creating", "created", "logged")) assertFalse(s, meetingItemPending(item("a", s)))
        assertTrue(meetingReopenable(item("a", "rejected")))
        assertTrue(meetingReopenable(item("a", "failed")))
        assertFalse(meetingReopenable(item("a", "created")))
        assertFalse(meetingReopenable(item("a")))
    }

    @Test fun `progress and the pending split`() {
        val m = Meeting(meetingId = "m", status = "ok", items = listOf(item("1"), item("2", "created"), item("3", "rejected")))
        assertEquals("2 of 3 reviewed", meetingProgress(m))
        assertEquals(1, meetingPendingCount(m))
        val (p, r) = meetingItemsSplit(m)
        assertEquals(listOf("1"), p.map { it.id })
        assertEquals(listOf("2", "3"), r.map { it.id })
        assertNull(meetingProgress(m.copy(status = "running")))
        assertEquals(0, meetingPendingCount(m.copy(status = "running")))
        assertFalse(meetingArchivable(m.copy(status = "queued")))
        assertTrue(meetingArchivable(m.copy(status = "failed")))
    }

    @Test fun `the daily meeting is one entry holding every capture and its briefs`() {
        val yday = at(11, 9, 30)
        val briefs = listOf(
            DailyBrief(runId = "b2", status = "ok", meetingAt = yday, startedAt = yday - 60_000, day = "rerun"),
            DailyBrief(runId = "b1", status = "ok", meetingAt = yday, startedAt = yday - 300_000, day = "linked"),
            DailyBrief(runId = "b0", status = "ok", meetingAt = at(10, 9, 30), day = "not captured"),
        )
        val meetings = listOf(
            Meeting(meetingId = "x", status = "ok", title = "Sync", startedAt = at(12, 7)),
            // The rejoin comes FIRST: the hub serves newest first (XERK-2858 QA).
            Meeting(meetingId = "d2", status = "ok", title = "Standup (rejoin)", startedAt = yday + 1_200_000,
                daily = MeetingDaily(yday)),
            Meeting(meetingId = "d", status = "ok", title = "Standup", startedAt = yday + 60_000,
                daily = MeetingDaily(yday, "b1"), items = listOf(item("1"))),
        )
        val e = triageEntries("s", meetings, briefs, daily, now, utc)
        val byKey = e.associateBy { it.key }
        val d = byKey.getValue("d:$yday")
        assertEquals(listOf("d2", "d"), d.meetings.map { it.meetingId }) // both captures, one entry
        assertEquals(listOf("b2", "b1"), d.briefs.map { it.runId })
        assertEquals(1, d.pending)
        assertFalse("m:d2" in byKey || "m:d" in byKey)
        // A brief whose meeting was never captured is still an entry.
        assertEquals("b0", byKey.getValue("d:${at(10, 9, 30)}").brief?.runId)
        // Today's 09:30 is ahead: the upcoming entry, current, with no brief yet.
        val up = byKey.getValue("d:${at(12, 9, 30)}")
        assertTrue(up.upcoming && up.current)
        assertNull(up.brief)
        assertFalse(d.current)
        assertEquals(e.sortedByDescending { it.at }, e)
    }

    @Test fun `a brief linked to another meetingAt hides only itself`() {
        // QA: claiming the linked brief's meetingAt hid every other brief written for it.
        val m9 = at(11, 9, 30)
        val m10 = at(11, 10, 0)
        val e = triageEntries("s",
            listOf(Meeting(meetingId = "d", status = "ok", daily = MeetingDaily(m10, "r1"))),
            listOf(DailyBrief(runId = "r2", status = "ok", meetingAt = m9), DailyBrief(runId = "r1", status = "ok", meetingAt = m9)),
            null, now, utc)
        assertEquals(listOf("r1"), e.single { it.key == "d:$m10" }.briefs.map { it.runId })
        assertEquals(listOf("r2"), e.single { it.key == "d:$m9" }.briefs.map { it.runId })
    }

    @Test fun `the upcoming entry stays upcoming once its meeting is captured early`() {
        // QA: Run now vanished when the standup was captured before its scheduled time.
        val next = at(12, 9, 30)
        val e = triageEntries("s",
            listOf(Meeting(meetingId = "d", status = "running", startedAt = next - 300_000, daily = MeetingDaily(next))),
            emptyList(), daily, now, utc)
        val up = e.single { it.daily }
        assertTrue(up.upcoming)
        assertEquals(1, up.meetings.size)
    }

    @Test fun `with no daily entry today the newest is current`() {
        val e = triageEntries("s", emptyList(),
            listOf(DailyBrief(runId = "a", status = "ok", meetingAt = at(9, 9, 30)),
                DailyBrief(runId = "b", status = "ok", meetingAt = at(10, 9, 30))), null, now, utc)
        assertEquals(listOf(true, false), e.map { it.current })
    }

    @Test fun `a brief written for the upcoming meeting is the upcoming entry`() {
        val next = at(12, 9, 30)
        val e = triageEntries("s", emptyList(),
            listOf(DailyBrief(runId = "b", status = "running", meetingAt = next)), daily, now, utc)
        val up = e.single { it.upcoming }
        assertEquals("b", up.brief?.runId)
        assertEquals("Brief being written…", triageBriefStatus(up))
        assertEquals(1, e.count { it.daily })
    }

    @Test fun `filters and search`() {
        val pending = entry("m:a", Meeting(meetingId = "a", status = "ok", title = "Sprint",
            items = listOf(MeetingItem(id = "1", title = "Fix login"))))
        val done = entry("m:b", Meeting(meetingId = "b", status = "ok", items = listOf(item("1", "created"))))
        val archived = entry("m:c", Meeting(meetingId = "c", status = "ok", archivedAt = 5, items = listOf(item("1"))))
        val running = entry("m:d", Meeting(meetingId = "d", status = "running"))
        val current = entry("d:1", null, daily = true, current = true)
        val past = entry("d:0", null, daily = true)
        fun shown(f: TriageFilter, q: String = "") =
            listOf(pending, done, archived, running, current, past).filter { triageShows(it, f, q) }.map { it.key }
        assertEquals(listOf("m:a", "m:d", "d:1"), shown(TriageFilter.REVIEW))
        assertEquals(listOf("m:a", "m:b", "m:d", "d:1", "d:0"), shown(TriageFilter.ALL))
        assertEquals(listOf("m:c"), shown(TriageFilter.ARCHIVED))
        assertEquals(listOf("m:a"), shown(TriageFilter.ALL, "LOGIN"))
        assertEquals(listOf("m:a"), shown(TriageFilter.ALL, "sprint"))
        assertEquals(listOf("d:1", "d:0"), shown(TriageFilter.ALL, "daily"))
    }

    @Test fun `buckets read Upcoming, Today, Yesterday, This week, Earlier`() {
        assertEquals(TriageBucket.UPCOMING, triageBucket(at(13, 9), now, utc))
        assertEquals(TriageBucket.TODAY, triageBucket(at(12, 23), now, utc))
        assertEquals(TriageBucket.TODAY, triageBucket(at(12, 0), now, utc))
        assertEquals(TriageBucket.YESTERDAY, triageBucket(at(11, 23), now, utc))
        assertEquals(TriageBucket.WEEK, triageBucket(at(6, 9), now, utc))
        assertEquals(TriageBucket.EARLIER, triageBucket(at(5, 9), now, utc))
        val rows = listOf(
            entry("a", null, at(14, 9), daily = true, upcoming = true),
            entry("b", null, at(13, 9), daily = true, upcoming = true),
            entry("c", Meeting(status = "running"), at(12, 7)),
        )
        val b = triageBuckets(rows, TriageFilter.ALL, "", now, utc)
        assertEquals(listOf(TriageBucket.UPCOMING, TriageBucket.TODAY), b.map { it.first })
        assertEquals(listOf("b", "a"), b[0].second.map { it.key }) // soonest first
    }

    @Test fun `Next moves to the following entry that still needs review, wrapping`() {
        fun e(k: String, pending: Boolean, site: String = "s") = entry(k,
            Meeting(meetingId = k, status = "ok", items = listOf(item("1", if (pending) null else "created"))), site = site)
        val list = listOf(e("a", true), e("b", false), e("c", true, "t"))
        assertEquals("c", triageNext(list, list[0])?.key)
        assertEquals("a", triageNext(list, list[2])?.key)
        assertNull(triageNext(listOf(list[0]), list[0]))
    }

    @Test fun `titles, label misses, focus names and the schedule time`() {
        assertEquals("Daily meeting", triageTitle(entry("d", Meeting(title = "Standup"), daily = true)))
        assertEquals("Standup", triageTitle(entry("m", Meeting(title = "Standup"))))
        assertEquals("Untitled meeting", triageTitle(entry("m", Meeting())))
        assertEquals(listOf("b", "a"), meetingLabelMissLabels(mapOf(
            "a@0011" to MeetingLabelMiss(at = 1), "b" to MeetingLabelMiss(at = 2), "a" to MeetingLabelMiss(at = 0))))
        assertEquals(listOf("Lee, Ann", "bo"), focusNames(" Lee, Ann \n\nbo\nBo\n")) // the first spelling stays
        assertEquals("09:30", scheduleTime("0930"))
        assertEquals("09:30", scheduleTime("930"))
        assertEquals("09:30", scheduleTime(" 9:30 "))
        assertEquals("17:05", scheduleTime("17:05"))
        assertEquals("9.30", scheduleTime("9.30")) // left for the hub to refuse in its words
    }

    @Test fun `the new wire fields decode, and a bad entry drops alone`() {
        val r = TurmaJson.decodeFromString(AgentsResponse.serializer(), """
            { "now": 1, "agents": [],
              "meetingProposals": { "s": [ { "meetingId": "m", "status": "ok", "archivedAt": 7,
                  "daily": { "meetingAt": 9, "briefRunId": "ab" } } ] },
              "dailyBriefSchedules": { "s": { "enabled": true, "time": "09:30", "meetingTitle": "standup" } },
              "meetingLabels": { "s": { "label": "acme", "custom": true }, "t": "junk" },
              "meetingLabelMisses": { "x@01": { "at": 3, "shared": true }, "y": 4 },
              "meetingFocus": { "s": { "names": ["Ann"], "role": "dev" }, "t": [] } }
        """.trimIndent())
        val m = r.meetingProposals.getValue("s").single()
        assertEquals(7L, m.archivedAt)
        assertEquals(MeetingDaily(9, "ab"), m.daily)
        assertEquals("standup", r.dailyBriefSchedules.getValue("s").meetingTitle)
        assertEquals(setOf("s"), r.meetingLabels.keys)
        assertTrue(r.meetingLabels.getValue("s").custom)
        assertEquals(setOf("x@01"), r.meetingLabelMisses.keys)
        assertEquals(listOf("Ann"), r.meetingFocus.getValue("s").names)
        assertEquals(setOf("s"), r.meetingFocus.keys)
        // An older hub sends none of them.
        val old = TurmaJson.decodeFromString(AgentsResponse.serializer(), """{ "now": 1, "agents": [] }""")
        assertTrue(old.meetingLabels.isEmpty() && old.meetingFocus.isEmpty() && old.meetingLabelMisses.isEmpty())
    }
}
