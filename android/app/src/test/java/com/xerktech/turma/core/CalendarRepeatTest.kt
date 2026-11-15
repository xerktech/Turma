package com.xerktech.turma.core

import com.xerktech.turma.model.CalendarEvent
import com.xerktech.turma.model.TurmaJson
import java.io.File
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * XERK-2973: the Repeat control ⇄ rule and its summary, over the SAME vectors the
 * web's calendar.test.js reads (turma/tests/fixtures/calendar-repeat-vectors.json),
 * so a pick sends one rule and reads one line on both clients. Plus the scope
 * each occurrence edit sends.
 */
class CalendarRepeatTest {

    private val vectors: JsonObject by lazy {
        // Gradle runs unit tests from android/app; the vectors live with the web's tests.
        val f = listOf("../../turma/tests/fixtures/calendar-repeat-vectors.json", "turma/tests/fixtures/calendar-repeat-vectors.json")
            .map(::File).first { it.isFile }
        TurmaJson.parseToJsonElement(f.readText()).jsonObject
    }

    private fun day(v: JsonObject) = LocalDate.parse(v["ymd"]!!.jsonPrimitive.content)
    private fun name(v: JsonObject) = v["name"]!!.jsonPrimitive.content
    private fun rule(e: JsonElement?): JsonElement = e ?: JsonNull

    @Test fun `every rule reads into the control and back unchanged, with the web's summary`() {
        for (e in vectors["roundTrip"]!!.jsonArray) {
            val v = e.jsonObject
            val r = calRepeatOf(calRuleOf(v["rule"]))
            assertEquals(name(v), v["kind"]!!.jsonPrimitive.content, r.kind)
            assertEquals(name(v), rule(v["rule"]), calRuleJson(calRuleOfRepeat(r, day(v))))
            assertEquals(name(v), v["summary"]!!.jsonPrimitive.content, calRepeatSummary(calRuleOf(v["rule"]), day(v)))
            assertEquals(name(v), "", calRepeatError(r, day(v)))
        }
    }

    @Test fun `each preset sends the rule it names`() {
        for (e in vectors["fromControl"]!!.jsonArray) {
            val v = e.jsonObject
            var r = calRepeatPick(RepeatForm(), v["pick"]!!.jsonPrimitive.content)
            v["then"]?.let { r = calRepeatPick(r, it.jsonPrimitive.content) }
            assertEquals(name(v), v["rule"], calRuleJson(calRuleOfRepeat(r, day(v))))
        }
        assertEquals(
            listOf("Does not repeat", "Every weekday (Mon–Fri)", "Daily", "Weekly on Tuesday", "Monthly on day 17",
                "Monthly on the third Tuesday", "Yearly on 17 November", "Custom…"),
            calRepeatPresets(LocalDate.of(2026, 11, 17)).map { it.second },
        )
    }

    @Test fun `a repeat the hub would refuse is said before Save, in the web's words`() {
        for (e in vectors["errors"]!!.jsonArray) {
            val v = e.jsonObject
            var r = calRepeatOf(calRuleOf(v["rule"]))
            for ((k, x) in v["set"]!!.jsonObject) {
                val s = x.jsonPrimitive.content
                r = when (k) {
                    "interval" -> r.copy(interval = s)
                    "count" -> r.copy(count = s)
                    "end" -> r.copy(end = s)
                    "until" -> r.copy(until = runCatching { LocalDate.parse(s) }.getOrNull())
                    else -> error("unknown field $k")
                }
            }
            assertEquals(name(v), v["error"]!!.jsonPrimitive.content, calRepeatError(r, day(v)))
        }
    }

    @Test fun `ticking a weekly day keeps the start's default day`() {
        val start = LocalDate.of(2026, 11, 17)
        val r = calRepeatToggleDay(calRepeatPick(RepeatForm(), "weekly"), start, "TH", true)
        assertEquals(listOf("TU", "TH"), r.days)
    }

    private val zone = ZoneId.of("America/New_York")
    private fun draft(repeat: RepeatForm = RepeatForm(), scope: String = "") = TurmaEventDraft(
        id = if (scope.isEmpty()) "" else "turma:0123456789abcdef:2026-11-17T14:00:00Z", version = 4, subject = "Plan",
        startDate = LocalDate.of(2026, 11, 17), startTime = LocalTime.of(9, 0), endDate = LocalDate.of(2026, 11, 17),
        endTime = LocalTime.of(10, 0), timeZone = zone.id, orgs = setOf("acme"), repeat = repeat, scope = scope,
    )

    @Test fun `the payload carries the rule, and an occurrence's own edit carries none`() {
        assertEquals(JsonNull, calDraftPayload(draft())["recurrence"])
        val nth = calRepeatPick(RepeatForm(), "monthlyNth")
        val want = TurmaJson.parseToJsonElement("""{"freq":"monthly","interval":1,"byWeekday":{"n":3,"day":"TU"}}""")
        assertEquals(want, calDraftPayload(draft(nth))["recurrence"])
        val one = calDraftPayload(draft(nth, "occurrence"))
        assertFalse("recurrence" in one)
        assertEquals("occurrence", one["scope"]!!.jsonPrimitive.content)
        assertEquals("4", one["version"]!!.jsonPrimitive.content)
        val following = calDraftPayload(draft(nth, "following"))
        assertEquals("following", following["scope"]!!.jsonPrimitive.content)
        assertEquals(want, following["recurrence"])
        assertEquals("series", calDraftPayload(draft(nth, "series"))["scope"]!!.jsonPrimitive.content)
        // A bad repeat is refused before Save; one occurrence never checks a rule it does not send.
        val bad = calRepeatPick(RepeatForm(), "custom").copy(interval = "0")
        assert("Repeat every 1 to 99." in calDraftErrors(draft(bad)))
        assert("Repeat every 1 to 99." !in calDraftErrors(draft(bad, "occurrence")))
    }

    @Test fun `a served occurrence opens with its series' rule, read from its original day`() {
        val ev = TurmaJson.decodeFromString(CalendarEvent.serializer(), """{ "source": "turma", "id": "turma:0123456789abcdef:2026-11-19T14:00:00Z",
            "seriesId": "turma:0123456789abcdef", "recurring": true, "originalStart": "2026-11-19T14:00:00Z",
            "start": "2026-11-20T09:00:00-05:00", "end": "2026-11-20T10:00:00-05:00", "startMs": 1, "endMs": 2,
            "timeZone": "America/New_York", "orgs": ["acme"], "editable": true, "version": 4,
            "recurrence": { "freq": "weekly", "interval": 2, "byDay": ["TU", "TH"], "until": "2026-12-31" } }""")
        assert(ev.turmaOccurrence)
        val d = calDraftOf(ev, zone)
        assertEquals("custom", d.repeat.kind)
        assertEquals(LocalDate.of(2026, 11, 19), calAnchorDay(ev, zone))
        assertEquals("Every 2 weeks on Tue, Thu until 31 Dec", calRepeatSummary(calRuleOf(ev.recurrence), calAnchorDay(ev, zone)))
        // An unreadable rule degrades to "no rule", never a failed decode.
        val odd = TurmaJson.decodeFromString(CalendarEvent.serializer(), """{ "source": "turma", "recurrence": "weekly" }""")
        assertEquals(null, calRuleOf(odd.recurrence))
    }
}
