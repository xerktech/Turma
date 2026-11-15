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

    @Test fun `QA a scoped edit sends only what changed, start and end together`() {
        val base = draft(calRepeatOf(calRuleOf(TurmaJson.parseToJsonElement("""{"freq":"weekly","interval":1,"count":10}"""))), "following")
        assertEquals(null, calScopedPayload(base, base))
        val moved = calScopedPayload(base, base.copy(endTime = LocalTime.of(11, 0)))!!
        assertEquals(setOf("start", "end", "version", "scope"), moved.keys)
        val rule = calScopedPayload(base, base.copy(repeat = base.repeat.copy(kind = "custom", unit = "week", interval = "2")))!!
        assertEquals(setOf("recurrence", "version", "scope"), rule.keys)
    }

    @Test fun `QA an occurrence's rule reads off its series' first day, never a clamped one`() {
        val feb = TurmaJson.decodeFromString(CalendarEvent.serializer(), """{ "source": "turma", "id": "turma:0123456789abcdef:2027-02-28T15:00:00Z",
            "seriesId": "turma:0123456789abcdef", "recurring": true, "originalStart": "2027-02-28T15:00:00Z", "seriesStart": "2027-01-31T10:00:00-05:00",
            "start": "2027-02-28T10:00:00-05:00", "end": "2027-02-28T11:00:00-05:00", "startMs": 1, "endMs": 2,
            "timeZone": "America/New_York", "orgs": ["acme"], "editable": true, "version": 4, "recurrence": { "freq": "monthly", "interval": 1 } }""")
        assertEquals("Every month on day 31", calRepeatSummary(calRuleOf(feb.recurrence), calAnchorDay(feb, zone)))
        val d = calDraftFor(feb, zone, "series")
        assertEquals(LocalDate.of(2027, 1, 31), d.seriesDate)
        // Ending before Feb 28 is fine for a series that starts Jan 31, and the implicit 31st stays implicit.
        val until = d.copy(repeat = d.repeat.copy(end = "until", until = LocalDate.of(2027, 2, 15)))
        assertEquals("", calRepeatError(until.repeat, calRepeatDay(until)))
        assertEquals(TurmaJson.parseToJsonElement("""{"freq":"monthly","interval":1,"until":"2027-02-15"}"""), calDraftPayload(until)["recurrence"])
    }

    @Test fun `QA a stored weekly rule's preset names its own days`() {
        val r = calRepeatOf(calRuleOf(TurmaJson.parseToJsonElement("""{"freq":"weekly","interval":1,"byDay":["MO","WE","FR"]}""")))
        assertEquals("Weekly on Mon, Wed, Fri", calRepeatPresets(LocalDate.of(2026, 11, 17), r).toMap()["weekly"])
    }

    @Test fun `QA every scoped draft reads the series' rule off its first day, a split's until starts at the split`() {
        val apr = TurmaJson.decodeFromString(CalendarEvent.serializer(), """{ "source": "turma", "id": "turma:0123456789abcdef:2027-04-30T14:00:00Z",
            "seriesId": "turma:0123456789abcdef", "recurring": true, "originalStart": "2027-04-30T14:00:00Z", "seriesStart": "2027-01-31T10:00:00-05:00",
            "start": "2027-04-30T10:00:00-04:00", "end": "2027-04-30T11:00:00-04:00", "startMs": 1, "endMs": 2,
            "timeZone": "America/New_York", "orgs": ["acme"], "editable": true, "version": 4, "recurrence": { "freq": "monthly", "interval": 1 } }""")
        for (scope in listOf("occurrence", "following", "series")) {
            val d = calDraftFor(apr, zone, scope)
            assertEquals(scope, "Every month on day 31", calRepeatSummary(calRuleOfRepeat(d.repeat, calRepeatDay(d)), calRepeatDay(d)))
        }
        val f = calDraftFor(apr, zone, "following")
        val early = f.copy(repeat = f.repeat.copy(end = "until", until = LocalDate.of(2027, 3, 31)))
        assert("It must repeat until a day on or after its start." in calDraftErrors(early))
        val four = f.copy(repeat = f.repeat.copy(end = "count", count = "4"))
        assertEquals(TurmaJson.parseToJsonElement("""{"freq":"monthly","interval":1,"count":4}"""), calDraftPayload(four)["recurrence"])
    }

    @Test fun `QA a scoped edit that moves the date re-anchors the repeat as the hub does`() {
        val tue = TurmaJson.decodeFromString(CalendarEvent.serializer(), """{ "source": "turma", "id": "turma:0123456789abcdef:2027-01-26T15:00:00Z",
            "seriesId": "turma:0123456789abcdef", "recurring": true, "originalStart": "2027-01-26T15:00:00Z", "seriesStart": "2027-01-05T10:00:00-05:00",
            "start": "2027-01-26T10:00:00-05:00", "end": "2027-01-26T11:00:00-05:00", "startMs": 1, "endMs": 2,
            "timeZone": "America/New_York", "orgs": ["acme"], "editable": true, "version": 4, "recurrence": { "freq": "weekly", "interval": 1, "count": 8 } }""")
        fun moved(scope: String) = calDraftFor(tue, zone, scope).let { it.copy(startDate = LocalDate.of(2027, 1, 27), endDate = LocalDate.of(2027, 1, 27)) }
        fun sum(d: TurmaEventDraft) = calRepeatSummary(calRuleOfRepeat(d.repeat, calRepeatDay(d)), calRepeatDay(d))
        assertEquals("Every week on Tue, 8 times", sum(calDraftFor(tue, zone, "following")))
        assertEquals("Every week on Wed, 8 times", sum(moved("following")))
        assertEquals("Every week on Wed, 8 times", sum(moved("series")))
        assertEquals("Every week on Tue, 8 times", sum(moved("occurrence")))
    }
}
