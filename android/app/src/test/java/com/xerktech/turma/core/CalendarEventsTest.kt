package com.xerktech.turma.core

import com.xerktech.turma.model.CalendarEvent
import com.xerktech.turma.model.LenientCalendarEventsSerializer
import com.xerktech.turma.model.TurmaJson
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.builtins.serializer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** XERK-2972: the Turma-event draft, its validation and the exact body the hub's routes take. */
class CalendarEventsTest {
    private val ny = ZoneId.of("America/New_York")
    private val day = LocalDate.of(2026, 11, 16)

    private fun draft(vararg orgs: String) = calNewEventDraft(day, LocalTime.of(9, 0), ny, orgs.toSet())
        .copy(subject = "  Planning  ")

    private fun decode(json: String): List<CalendarEvent> =
        TurmaJson.decodeFromJsonElement(LenientCalendarEventsSerializer, TurmaJson.parseToJsonElement(json))

    @Test fun `a new event's create body carries every field, times with their offset`() {
        val p = calDraftPayload(
            draft("a.atlassian.net", "b.atlassian.net").copy(
                required = "Ann <ann@x.com>, bo@x.com", optional = "Cy", location = "Room 1",
                online = true, joinUrl = "https://meet.example/abc", body = "Agenda",
                busy = "tentative", categories = "Red, Blue", private = true,
            ),
        )
        assertNull(p["version"])
        assertEquals(listOf("a.atlassian.net", "b.atlassian.net"), p["orgs"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("Planning", p["subject"]!!.jsonPrimitive.content)
        assertEquals("2026-11-16T09:00:00-05:00", p["start"]!!.jsonPrimitive.content)
        assertEquals("2026-11-16T09:30:00-05:00", p["end"]!!.jsonPrimitive.content)
        assertEquals("America/New_York", p["timeZone"]!!.jsonPrimitive.content)
        val att = p["attendees"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("ann@x.com", "bo@x.com", ""), att.map { it["email"]!!.jsonPrimitive.content })
        assertEquals(listOf("Ann", "", "Cy"), att.map { it["name"]!!.jsonPrimitive.content })
        assertEquals(listOf("required", "required", "optional"), att.map { it["role"]!!.jsonPrimitive.content })
        assertEquals("true", p["isOnlineMeeting"]!!.jsonPrimitive.content)
        assertEquals("https://meet.example/abc", p["joinUrl"]!!.jsonPrimitive.content)
        assertEquals("tentative", p["busy"]!!.jsonPrimitive.content)
        assertEquals(listOf("Red", "Blue"), p["categories"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("private", p["sensitivity"]!!.jsonPrimitive.content)
    }

    @Test fun `XERK-2989 invitations ride the payload, read back, and the panel tallies the answers`() {
        val d = draft("a.atlassian.net")
        assertEquals(listOf(false, true, true), listOf(d.invites, d.reqResp, d.allowFwd))
        val p = calDraftPayload(d.copy(invites = true, allowFwd = false))
        assertEquals(listOf("true", "true", "false"),
            listOf("sendInvites", "responseRequested", "allowForward").map { p[it]!!.jsonPrimitive.content })
        val (ev) = decode("""[{"source":"turma","host":"","id":"turma:0123456789abcdef","orgs":["a.atlassian.net"],
            "org":"a.atlassian.net","subject":"P","start":"2026-11-16T09:00:00-05:00","end":"2026-11-16T09:30:00-05:00",
            "startMs":1,"endMs":2,"timeZone":"America/New_York","sendInvites":true,"responseRequested":false,
            "attendees":[{"name":"Ann","email":"ann@x.com","role":"required","response":"accepted"},
            {"name":"Bo","email":"bo@x.com","role":"optional","response":"declined"}]}]""")
        val back = calDraftOf(ev, java.time.ZoneId.of("America/New_York"))
        assertEquals(listOf(true, false, true), listOf(back.invites, back.reqResp, back.allowFwd))
        assertEquals("Sent from A's Outlook · no responses requested · 1 accepted, 1 declined",
            calInvitesText(ev) { "A" })
        assertEquals("", calInvitesText(ev.copy(sendInvites = false)) { "A" })
        assertEquals("", calInvitesText(ev.copy(recurring = true)) { "A" })
        // An older hub sends none of the three: the defaults.
        val (old) = decode("""[{"source":"turma","id":"turma:0123456789abcdef","subject":"P","start":"2026-11-16T09:00:00-05:00",
            "end":"2026-11-16T09:30:00-05:00","startMs":1,"endMs":2}]""")
        assertEquals(listOf(false, true, true), listOf(old.sendInvites, old.responseRequested, old.allowForward))
        assertTrue(calInvitesNote(d.copy(private = true)).startsWith("A private event sends no invitations"))
    }

    @Test fun `an offline event sends no join link, and all-day ends at the midnight after its last day`() {
        val p = calDraftPayload(draft("o").copy(allDay = true, endDate = day.plusDays(1), joinUrl = "https://x.example"))
        assertEquals("", p["joinUrl"]!!.jsonPrimitive.content)
        assertEquals("2026-11-16T00:00:00-05:00", p["start"]!!.jsonPrimitive.content)
        assertEquals("2026-11-18T00:00:00-05:00", p["end"]!!.jsonPrimitive.content)
        assertEquals("true", p["allDay"]!!.jsonPrimitive.content)
    }

    @Test fun `an edit carries its version and keeps the org order it started with`() {
        val ev = decode("""[ { "source": "turma", "host": "", "id": "turma:0123456789abcdef", "orgs": ["z", "a"], "org": "z",
            "subject": "Sync", "start": "2026-11-16T14:00:00Z", "end": "2026-11-16T15:00:00Z",
            "startMs": 1, "endMs": 2, "timeZone": "America/New_York", "editable": true, "version": 4,
            "sensitivity": "confidential", "attendees": [ { "name": "Ann", "email": "ann@x.com", "role": "optional" } ] } ]""").single()
        val d = calDraftOf(ev, ZoneId.of("UTC"))
        assertEquals(LocalTime.of(9, 0), d.startTime)            // its own wall clock, not the phone's
        assertEquals("Ann <ann@x.com>", d.optional)
        val p = calDraftPayload(d.copy(orgs = d.orgs + "m"), listOf("z", "a"))
        assertEquals("4", p["version"]!!.jsonPrimitive.content)
        assertEquals(listOf("z", "a", "m"), p["orgs"]!!.jsonArray.map { it.jsonPrimitive.content })
        // Un-ticked Private keeps a confidential event confidential.
        assertEquals("confidential", p["sensitivity"]!!.jsonPrimitive.content)
    }

    @Test fun `a draft refuses what the hub would 400 on`() {
        assertTrue(calDraftErrors(draft("o")).isEmpty())
        assertTrue(calDraftErrors(draft()).contains("Pick at least one org."))
        assertTrue(calDraftErrors(draft("o").copy(subject = " ")).isNotEmpty())
        assertTrue(calDraftErrors(draft("o").copy(required = "not an <address>")).isNotEmpty())
        assertTrue(calDraftErrors(draft("o").copy(timeZone = "Mars/Base")).isNotEmpty())
        assertTrue(calDraftErrors(draft("o").copy(endTime = LocalTime.of(8, 0))).isNotEmpty())
        assertTrue(calDraftErrors(draft("o").copy(online = true, joinUrl = "http://x")).isNotEmpty())
    }

    @Test fun `served Turma fields decode, and an older hub's event reads read-only`() {
        val (turma, outlook, old) = decode("""[
            { "source": "turma", "host": "", "id": "turma:a", "orgs": ["a", "b"], "org": "a", "editable": true, "version": 2,
              "startMs": 1, "endMs": 2 },
            { "source": "outlook", "host": "h1", "id": "E1", "org": "a", "startMs": 1, "endMs": 2 },
            { "source": "turma", "host": "", "id": "turma:b", "org": "a", "startMs": 1, "endMs": 2 } ]""")
        assertTrue(turma.canEdit)
        assertEquals(listOf("a", "b"), calOrgsOf(turma))
        assertFalse(outlook.canEdit)
        assertEquals(listOf("a"), calOrgsOf(outlook))
        assertNull(old.orgs)
        assertFalse(old.canEdit)
    }

    @Test fun `an event of several orgs counts as upcoming for each of them`() {
        val now = 1_000L
        val ev = decode("""[ { "source": "turma", "host": "", "id": "turma:a", "orgs": ["a", "b"], "org": "a",
            "startMs": ${now + 3_600_000}, "endMs": ${now + 5_400_000}, "busy": "busy", "meeting": true } ]""")
        assertEquals(1, calUpcoming("b", ev, now).size)
        assertEquals(1, calUpcoming("a", ev, now).size)
        assertEquals(0, calUpcoming("c", ev, now).size)
    }

    @Test fun `slot and default starts`() {
        assertEquals(LocalTime.of(10, 30), calSlotStart(10 * 60 + 44))
        assertEquals(LocalTime.of(23, 30), calSlotStart(24 * 60 + 5))
        assertEquals(setOf("a"), calDefaultOrgs(emptyList(), listOf("a")))
        assertEquals(emptySet<String>(), calDefaultOrgs(emptyList(), listOf("a", "b")))
        assertEquals(setOf("b"), calDefaultOrgs(listOf("b", "gone"), listOf("a", "b")))
        assertEquals(LocalTime.of(9, 0), calDefaultStart(day.plusDays(3), 0, ny))
    }

    @Test fun `XERK-2972 QA a name with a comma survives an unchanged save, and quoted names parse`() {
        val ev = decode("""[ { "source": "turma", "host": "", "id": "turma:a", "orgs": ["o"], "org": "o", "editable": true, "version": 1,
            "start": "2026-11-16T14:00:00Z", "end": "2026-11-16T15:00:00Z", "startMs": 1, "endMs": 2, "timeZone": "UTC",
            "attendees": [ { "name": "Smith, John", "email": "john@x.com", "role": "required" },
                           { "name": "Ann \"A\" Lee", "email": "", "role": "required" } ] } ]""").single()
        val d = calDraftOf(ev, ny)
        assertEquals(
            listOf(TurmaAttendee("Smith, John", "john@x.com", "required"), TurmaAttendee("Ann \"A\" Lee", "", "required")),
            calParseAttendees(d.required, "required"),
        )
        assertEquals(
            listOf(TurmaAttendee("Smith, John", "j@x.com", "optional"), TurmaAttendee("", "bo@x.com", "optional")),
            calParseAttendees("\"Smith, John\" <j@x.com>; bo@x.com", "optional"),
        )
    }

    @Test fun `XERK-2972 QA validation agrees with the hub on emails, links, zones, titles and skipped times`() {
        val ok = draft("o")
        assertTrue(calEmailOk("jöhn@exämple.de"))
        assertTrue(calEmailOk("foo@bar.x"))
        assertFalse(calEmailOk("a b@x.com"))
        assertTrue(calDraftErrors(ok.copy(online = true, joinUrl = "https://x y.com")).isNotEmpty())
        assertTrue(calDraftErrors(ok.copy(online = true, joinUrl = "https://")).isNotEmpty())
        assertTrue(calDraftErrors(ok.copy(online = true, joinUrl = "https://x.com/\"q")).isNotEmpty())
        assertTrue(calDraftErrors(ok.copy(required = "x".repeat(101))).isNotEmpty())
        assertTrue(calDraftErrors(ok.copy(timeZone = "GMT")).isEmpty())
        assertTrue(calDraftErrors(ok.copy(timeZone = "EST5EDT")).isEmpty())
        assertTrue(calDraftErrors(ok.copy(timeZone = "+05:00")).isNotEmpty())
        assertTrue(calDraftErrors(ok.copy(subject = "\u0007\u200b")).isNotEmpty())
        val gap = LocalDate.of(2027, 3, 14)
        val skipped = ok.copy(startDate = gap, endDate = gap, startTime = LocalTime.of(2, 30), endTime = LocalTime.of(3, 30))
        assertTrue(calDraftErrors(skipped).any { "does not exist" in it })
    }

    @Test fun `XERK-2953 a time a zone kept local mean time is refused, like the web editor`() {
        val ok = draft("o").copy(timeZone = "Europe/Brussels")
        val d1890 = LocalDate.of(1890, 6, 2)
        val lmt = ok.copy(startDate = d1890, endDate = d1890)
        assertTrue(calDraftErrors(lmt).any { "The start is before Europe/Brussels kept standard time" in it })
        assertTrue(calDraftErrors(lmt.copy(allDay = true)).any { "standard time" in it })
        val monrovia = ok.copy(timeZone = "Africa/Monrovia", startDate = LocalDate.of(1960, 3, 1), endDate = LocalDate.of(1960, 3, 1))
        assertTrue(calDraftErrors(monrovia).any { "standard time" in it })
        val d1980 = LocalDate.of(1980, 3, 1)
        assertTrue(calDraftErrors(monrovia.copy(startDate = d1980, endDate = d1980)).isEmpty())
        assertTrue(calDraftErrors(lmt.copy(endDate = LocalDate.of(1960, 6, 2))).any { "The start is before" in it })
    }

    @Test fun `XERK-2972 QA a withheld private event is never editable`() {
        val ev = decode("""[ { "source": "turma", "host": "", "id": "turma:p", "orgs": ["o"], "org": "o", "editable": true,
            "version": 1, "private": true, "subject": "Private event", "startMs": 1, "endMs": 2 } ]""").single()
        assertFalse(ev.canEdit)
    }

    @Test fun `XERK-2972 QA orgs are ids, never cleaned at decode`() {
        val ev = decode("""[ { "source": "turma", "host": "", "id": "turma:z", "orgs": ["o\u200b"], "org": "o\u200b",
            "subject": "a\u200bb", "startMs": 1, "endMs": 2 } ]""").single()
        assertEquals(listOf("o\u200b"), ev.orgs)
        assertEquals("ab", ev.subject)
    }

    @Test fun `XERK-2972 QA every attendee shape the hub keeps survives an unchanged save`() {
        val people = listOf(
            TurmaAttendee("R&D <lab>", "rd@x.com", "required"),
            TurmaAttendee("a>b", "ab@x.com", "required"),
            TurmaAttendee("bob@home", "", "required"),
            TurmaAttendee("", "c,d@x.com", "required"),
            TurmaAttendee("Back\\slash", "", "required"),
            TurmaAttendee("", "plain@x.com", "required"),
        )
        val json = people.joinToString(",") { """{ "name": ${TurmaJson.encodeToString(String.serializer(), it.name)}, "email": "${it.email}", "role": "required" }""" }
        val ev = decode("""[ { "source": "turma", "host": "", "id": "turma:a", "orgs": ["o"], "org": "o", "editable": true, "version": 1,
            "start": "2026-11-16T14:00:00Z", "end": "2026-11-16T15:00:00Z", "startMs": 1, "endMs": 2, "timeZone": "UTC",
            "attendees": [ $json ] } ]""").single()
        assertEquals(people, calParseAttendees(calDraftOf(ev, ny).required, "required"))
    }

    @Test fun `XERK-2972 QA UT is refused and the payload's subject is cleaned`() {
        assertTrue(calDraftErrors(draft("o").copy(timeZone = "UT")).isNotEmpty())
        assertEquals("AB", calDraftPayload(draft("o").copy(subject = " A\u200bB\u202e ")) ["subject"]!!.jsonPrimitive.content)
    }

    @Test fun `XERK-2987 each org's Outlook copy, the block mark, and an older hub reading as before`() {
        val base = """"source": "turma", "id": "turma:0123456789abcdef", "orgs": ["a", "b"], "org": "a", "startMs": 1, "endMs": 2"""
        val old = decode("""[{ $base }]""").single()
        assertNull(calOutlookStates(old))
        assertEquals("", calOutlookMark(old))
        // Outlook's event never reads an `outlook` field as its own.
        assertNull(calOutlookStates(decode("""[{ "source": "outlook", "id": "E1", "org": "a", "startMs": 1, "endMs": 2,
            "outlook": { "a": { "state": "failed" } } }]""").single()))
        val ev = decode("""[{ $base, "outlook": {
            "a": { "state": "failed", "error": " Outlook is not open ", "at": 1 },
            "b": { "state": "pending", "noHost": true, "at": 1 } } }]""").single()
        assertEquals(listOf(CalOutlookState("a", "failed", "Failed: Outlook is not open"),
            CalOutlookState("b", "nohost", "No Outlook host for this org")), calOutlookStates(ev))
        assertEquals("failed", calOutlookMark(ev))
        val writing = decode("""[{ $base, "outlook": { "a": { "state": "written", "recreatedAt": 5, "at": 5 },
            "b": { "state": "pending", "at": 1 } } }]""").single()
        assertEquals(listOf("In Outlook (re-created after it was deleted there)", "Writing…"), calOutlookStates(writing)!!.map { it.text })
        assertEquals("pending", calOutlookMark(writing))
        // No host alone marks nothing; a malformed entry reads as still writing, never a crash.
        assertEquals("", calOutlookMark(decode("""[{ $base, "outlook": { "a": { "state": "pending", "noHost": true },
            "b": { "state": "written" } } }]""").single()))
        assertEquals("Writing…", calOutlookStates(decode("""[{ $base, "outlook": { "a": 7, "b": { "state": 3 } } }]""").single())!![0].text)
        assertNull(calOutlookStates(decode("""[{ $base, "outlook": [1] }]""").single()))
    }
}
