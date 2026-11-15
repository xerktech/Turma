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
}
