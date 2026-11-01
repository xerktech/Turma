package com.xerktech.turma.core

import com.xerktech.turma.model.CreateProject
import com.xerktech.turma.model.CreateType
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingItem
import com.xerktech.turma.model.MeetingQuote
import com.xerktech.turma.model.MeetingReview
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset
import java.util.Locale

/** The Meetings screen's pure logic (XERK-2511), pinned to meetings.html's behaviour. */
class MeetingsTest {

    private val m = Meeting(
        meetingId = "m1", status = "ok", title = "Sprint sync", platform = "Zoom",
        startedAt = 1_700_000_000_000, endedAt = 1_700_000_000_000 + 45 * 60_000,
        tenirUrl = "https://tenir.example/c/1#x", participants = listOf("Ann", "Bo"),
    )

    @Test fun `a ticket description carries the proposal, the meeting, its quotes and the link`() {
        val it = MeetingItem(id = "p1", kind = "bug", title = "Fix login", description = "It 500s",
            quotes = listOf(MeetingQuote("Ann", "login is broken", 61_000), MeetingQuote("", "no time", -1)))
        assertEquals(
            "It 500s\n\nProposed from the meeting \"Sprint sync\" (2023-11-14).\n" +
                "> Ann: login is broken [1:01]\n> no time\nMeeting: https://tenir.example/c/1#x",
            meetingTicketDescription(m, it),
        )
        // No description, no date, no link: just where it came from.
        assertEquals("Proposed from the meeting \"T\".",
            meetingTicketDescription(Meeting(title = "T", tenirUrl = "javascript:alert(1)"), MeetingItem(title = "x")))
    }

    @Test fun `clock and moment links`() {
        assertEquals("0:00", meetingClock(0))
        assertEquals("1:01", meetingClock(61_000))
        assertEquals("1:00:05", meetingClock(3_605_000))
        assertEquals("https://tenir.example/c/1#t=61", meetingMomentUrl(m.tenirUrl, 61_999))
        assertEquals("", meetingMomentUrl(m.tenirUrl, -1))
        assertEquals("", meetingMomentUrl("https://x/a b", 0))
        assertEquals("", safeMeetingUrl("https://x/'onmouseover='a"))
    }

    @Test fun `the default type follows the kind among what the project offers`() {
        val types = listOf(CreateType("1", "Story"), CreateType("2", "Bug"), CreateType("3", "Task"))
        assertEquals("2", meetingDefaultType("bug", types))
        assertEquals("3", meetingDefaultType("task", types))
        assertEquals("3", meetingDefaultType("followup", types))
        assertEquals("1", meetingDefaultType("bug", listOf(CreateType("1", "Story"), CreateType("9", "Epic"))))
        assertEquals("9", meetingDefaultType("task", listOf(CreateType("9", "Epic"))))
        assertEquals("", meetingDefaultType("task", emptyList()))
    }

    @Test fun `the project is the viewer's pick while offered, else a lone project`() {
        val ps = listOf(CreateProject("A"), CreateProject("B"))
        assertEquals("B", meetingProject("B", ps))
        assertEquals("", meetingProject("Z", ps))
        assertEquals("A", meetingProject(null, listOf(CreateProject("A"))))
        assertEquals("", meetingProject(null, emptyList()))
    }

    @Test fun `review states read as the web page words them`() {
        fun lines(r: MeetingReview?) = meetingReviewLines(MeetingItem(review = r)).map { it.text }
        assertEquals(emptyList<String>(), lines(null))
        assertEquals(listOf("Creating the ticket…"), lines(MeetingReview("creating")))
        assertEquals(listOf("✓ Created XERK-9"), lines(MeetingReview("created", key = "XERK-9")))
        assertEquals(listOf("✓ Created XERK-9", "· session starts once the board lists it with a repo"),
            lines(MeetingReview("created", key = "XERK-9", start = true, session = "waiting")))
        assertEquals(listOf("✓ Created XERK-9", "· no session — boom"),
            lines(MeetingReview("created", key = "XERK-9", start = true, session = "failed", sessionError = "boom")))
        assertEquals(listOf("Not created — the create failed"), lines(MeetingReview("failed")))
        assertEquals(listOf("✓ Added to the decisions log"), lines(MeetingReview("logged")))
        assertTrue(meetingReviewable(MeetingItem(review = MeetingReview("rejected"))))
        assertTrue(meetingReviewable(MeetingItem(review = MeetingReview("failed"))))
        assertFalse(meetingReviewable(MeetingItem(review = MeetingReview("creating"))))
        assertFalse(meetingReviewable(MeetingItem(review = MeetingReview("created"))))
    }

    @Test fun `meta and status lines`() {
        assertEquals("Zoom · Tue, Nov 14, 10:13 PM · 45 min · 2 participants",
            meetingMetaLine(m, ZoneOffset.UTC, Locale.US))
        assertEquals("Reading the captions on h1…" to false, meetingStatusLine(m.copy(status = "running", host = "h1")))
        assertEquals("Could not propose work items — x" to true, meetingStatusLine(m.copy(status = "failed", error = "x")))
        assertEquals("Nothing to propose from this meeting." to false, meetingStatusLine(m))
        assertNull(meetingStatusLine(m.copy(items = listOf(MeetingItem(id = "p1")))))
    }

    @Test fun `an org needs a project only while a ticket proposal is open`() {
        val dec = MeetingItem(id = "p1", kind = "decision")
        val task = MeetingItem(id = "p2", kind = "task")
        assertFalse(meetingsNeedProject(listOf(m.copy(items = listOf(dec)))))
        assertTrue(meetingsNeedProject(listOf(m.copy(items = listOf(dec, task)))))
        assertFalse(meetingsNeedProject(listOf(m.copy(items = listOf(task.copy(review = MeetingReview("created")))))))
        assertFalse(meetingsNeedProject(listOf(m.copy(status = "running", items = listOf(task)))))
    }

    @Test fun `an empty screen says when the header's pick hides meetings`() {
        assertEquals("No meetings yet — when Tenir sends one, its proposed work items show up here.",
            meetingsEmptyText(mapOf("a" to emptyList())))
        assertEquals("No meetings for the orgs picked in the header — pick All orgs to see the others.",
            meetingsEmptyText(mapOf("a" to listOf(m))))
    }

    @Test fun `orgs shown are those with meetings inside the header's scope`() {
        val map = mapOf("b" to listOf(m), "a" to listOf(m), "c" to emptyList())
        assertEquals(listOf("a", "b"), meetingOrgs(map, emptySet()))
        assertEquals(listOf("b"), meetingOrgs(map, setOf("b", "c")))
    }
}
