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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** The Brief screen's triage list (XERK-2858): entries, the daily pairing, filters, buckets. */
class MeetingsTriageTest {
    private val utc = ZoneId.of("UTC")
    private fun at(d: Int, h: Int, m: Int = 0) =
        ZonedDateTime.of(2026, 11, d, h, m, 0, 0, utc).toInstant().toEpochMilli()
    private val now = at(12, 8) // a Thursday
    private val daily = DailyBriefSchedule(enabled = true, time = "09:30", timeZone = "UTC",
        weekdays = listOf(1, 2, 3, 4, 5))

    private fun item(id: String, state: String? = null) =
        MeetingItem(id = id, kind = "task", title = "Item $id", review = state?.let { MeetingReview(state = it) })

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

    @Test fun `the daily meeting is one entry pairing its brief and its captured meeting`() {
        val yday = at(11, 9, 30)
        val briefs = listOf(
            DailyBrief(runId = "b2", status = "ok", meetingAt = yday, day = "newer"),
            DailyBrief(runId = "b1", status = "ok", meetingAt = yday, day = "linked"),
            DailyBrief(runId = "b0", status = "ok", meetingAt = at(10, 9, 30), day = "not captured"),
        )
        val meetings = listOf(
            Meeting(meetingId = "d", status = "ok", title = "Standup", startedAt = yday + 60_000,
                daily = MeetingDaily(yday, "b1"), items = listOf(item("1"))),
            // A second capture of the same daily meeting stays its own entry.
            Meeting(meetingId = "d2", status = "ok", title = "Standup (2)", startedAt = yday + 120_000,
                daily = MeetingDaily(yday)),
            Meeting(meetingId = "x", status = "ok", title = "Sync", startedAt = at(12, 7)),
        )
        val e = triageEntries("s", meetings, briefs, daily, now)
        val byKey = e.associateBy { it.key }
        val d = byKey.getValue("d:$yday")
        assertEquals("b1", d.brief?.runId) // the hub's link wins over the newer brief
        assertEquals("d", d.meeting?.meetingId)
        assertTrue(d.daily)
        assertFalse(d.upcoming)
        assertEquals(1, d.pending)
        assertTrue("m:d2" in byKey)
        // A brief whose meeting was never captured is still an entry.
        assertEquals("b0", byKey.getValue("d:${at(10, 9, 30)}").brief?.runId)
        // Today's 09:30 is ahead: the upcoming entry, with no brief yet.
        val up = byKey.getValue("d:${at(12, 9, 30)}")
        assertTrue(up.upcoming)
        assertNull(up.brief)
        assertNull(up.meeting)
        // Newest first.
        assertEquals(e.sortedByDescending { it.at }, e)
    }

    @Test fun `a brief written for the upcoming meeting is the upcoming entry`() {
        val next = at(12, 9, 30)
        val e = triageEntries("s", emptyList(),
            listOf(DailyBrief(runId = "b", status = "running", meetingAt = next)), daily, now)
        val up = e.single { it.upcoming }
        assertEquals("b", up.brief?.runId)
        assertEquals("Brief being written…", triageBriefStatus(up))
        assertEquals(1, e.count { it.daily })
    }

    @Test fun `filters and search`() {
        val pending = TriageEntry("m:a", "s", now, Meeting(meetingId = "a", status = "ok", title = "Sprint",
            items = listOf(MeetingItem(id = "1", title = "Fix login"))))
        val done = TriageEntry("m:b", "s", now, Meeting(meetingId = "b", status = "ok", items = listOf(item("1", "created"))))
        val archived = TriageEntry("m:c", "s", now, Meeting(meetingId = "c", status = "ok", archivedAt = 5,
            items = listOf(item("1"))))
        val running = TriageEntry("m:d", "s", now, Meeting(meetingId = "d", status = "running"))
        val upcoming = TriageEntry("d:1", "s", now, null, daily = true, upcoming = true)
        fun shown(f: TriageFilter, q: String = "") =
            listOf(pending, done, archived, running, upcoming).filter { triageShows(it, f, q) }.map { it.key }
        assertEquals(listOf("m:a", "m:d", "d:1"), shown(TriageFilter.REVIEW))
        assertEquals(listOf("m:a", "m:b", "m:d", "d:1"), shown(TriageFilter.ALL))
        assertEquals(listOf("m:c"), shown(TriageFilter.ARCHIVED))
        assertEquals(listOf("m:a"), shown(TriageFilter.ALL, "LOGIN"))
        assertEquals(listOf("m:a"), shown(TriageFilter.ALL, "sprint"))
        assertEquals(listOf("d:1"), shown(TriageFilter.ALL, "daily"))
        // An archived meeting's pending work does not count in Needs review.
        assertEquals(0, listOf(archived).filter { triageShows(it, TriageFilter.REVIEW, "") }.size)
    }

    @Test fun `buckets read Upcoming, Today, Yesterday, This week, Earlier`() {
        assertEquals(TriageBucket.UPCOMING, triageBucket(at(13, 9), now, utc))
        assertEquals(TriageBucket.TODAY, triageBucket(at(12, 23), now, utc))
        assertEquals(TriageBucket.TODAY, triageBucket(at(12, 0), now, utc))
        assertEquals(TriageBucket.YESTERDAY, triageBucket(at(11, 23), now, utc))
        assertEquals(TriageBucket.WEEK, triageBucket(at(6, 9), now, utc))
        assertEquals(TriageBucket.EARLIER, triageBucket(at(5, 9), now, utc))
        val rows = listOf(
            TriageEntry("a", "s", at(14, 9), null, daily = true, upcoming = true),
            TriageEntry("b", "s", at(13, 9), null, daily = true, upcoming = true),
            TriageEntry("c", "s", at(12, 7), Meeting(status = "running")),
        )
        val b = triageBuckets(rows, TriageFilter.ALL, "", now, utc)
        assertEquals(listOf(TriageBucket.UPCOMING, TriageBucket.TODAY), b.map { it.first })
        assertEquals(listOf("b", "a"), b[0].second.map { it.key }) // soonest first
    }

    @Test fun `Next moves to the following entry that still needs review, wrapping`() {
        fun e(k: String, pending: Boolean, site: String = "s") = TriageEntry(k, site, 0,
            Meeting(meetingId = k, status = "ok", items = listOf(item("1", if (pending) null else "created"))))
        val list = listOf(e("a", true), e("b", false), e("c", true, "t"))
        assertEquals("c", triageNext(list, list[0])?.key)
        assertEquals("a", triageNext(list, list[2])?.key)
        assertNull(triageNext(listOf(list[0]), list[0]))
    }

    @Test fun `titles, label misses and focus names`() {
        assertEquals("Daily meeting", triageTitle(TriageEntry("d", "s", 0, null, daily = true)))
        assertEquals("Daily meeting · Standup",
            triageTitle(TriageEntry("d", "s", 0, Meeting(title = "Standup"), daily = true)))
        assertEquals("Untitled meeting", triageTitle(TriageEntry("m", "s", 0, Meeting())))
        assertEquals(listOf("b", "a"), meetingLabelMissLabels(mapOf(
            "a@0011" to MeetingLabelMiss(at = 1), "b" to MeetingLabelMiss(at = 2), "a" to MeetingLabelMiss(at = 0))))
        assertEquals(listOf("Lee, Ann", "bo"), focusNames(" Lee, Ann \n\nbo\nBo\n")) // the first spelling stays
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
