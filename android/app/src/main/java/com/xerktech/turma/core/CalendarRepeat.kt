package com.xerktech.turma.core

import java.time.LocalDate
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/*
 * The editor's Repeat control ⇄ the hub's recurrence rule, and its one-line
 * summary (XERK-2973; contract-calendar-turma.md "Recurring Turma events"). A port of
 * calendar.js's repeat block: both read turma/tests/fixtures/calendar-repeat-vectors.json
 * (CalendarRepeatTest), so a pick sends the same rule and reads the same line on
 * the phone as on the web. Pure. [LocalDate] `start` is the series' first day in
 * the event's own zone, which an implicit day / weekday / month means.
 */

/** The hub's rule (`sanitizeRule`'s fields); null fields are absent. */
data class CalRule(
    val freq: String,
    val interval: Int = 1,
    val byDay: List<String>? = null,
    val byMonthDay: Int? = null,
    val byWeekday: CalNth? = null,
    val until: String? = null,
    val count: Int? = null,
)

/** "The [n]th [day]" of a month; n 1..4, or -1 for the last. */
data class CalNth(val n: Int, val day: String)

/**
 * What the Repeat control holds. [days] empty = the start's weekday (weekly) or
 * every day (daily); [monthDay]/[nth] null = the start's (kept only when a rule named one).
 * [interval]/[count] are text as typed, so a half-typed number is never lost.
 */
data class RepeatForm(
    val kind: String = "none",          // none | weekday | daily | weekly | monthly | yearly | custom
    val interval: String = "1",
    val unit: String = "week",          // day | week | month | year (custom)
    val days: List<String> = emptyList(),
    val monthMode: String = "day",      // day | weekday
    val monthDay: Int? = null,
    val nth: CalNth? = null,
    val end: String = "never",          // never | until | count
    val until: LocalDate? = null,
    val count: String = "10",
)

val CAL_DAYS = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
private val DAY_SHORT = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
private val DAY_LONG = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
private val WEEKDAYS = listOf("MO", "TU", "WE", "TH", "FR")
private val NTH = mapOf(1 to "first", 2 to "second", 3 to "third", 4 to "fourth", -1 to "last")
private val MONTHS = listOf("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
val CAL_REPEAT_UNITS = listOf("day", "week", "month", "year")
private val FREQ = mapOf("day" to "daily", "week" to "weekly", "month" to "monthly", "year" to "yearly")
const val CAL_REPEAT_INTERVAL_MAX = 99   // recurrence.js INTERVAL_MAX
const val CAL_REPEAT_COUNT_MAX = 999     // recurrence.js COUNT_MAX

/** A weekday's two-letter code (SU..SA) for [d]. */
fun calDayCode(d: LocalDate): String = CAL_DAYS[d.dayOfWeek.value % 7]
fun calDayShort(code: String): String = DAY_SHORT.getOrElse(CAL_DAYS.indexOf(code)) { code }
fun calDayLong(code: String): String = DAY_LONG.getOrElse(CAL_DAYS.indexOf(code)) { code }

/** The start's place in its month: the 1st..4th of its weekday; a 5th reads "last". */
fun calAnchorNth(d: LocalDate): CalNth {
    val n = (d.dayOfMonth + 6) / 7
    return CalNth(if (n > 4) -1 else n, calDayCode(d))
}

private fun weekOrder(days: Collection<String>) = CAL_DAYS.filter { it in days }
private fun sameDays(a: List<String>, b: List<String>) = a.size == b.size && a.all { it in b }

/** The served `recurrence` as a rule, or null (a single event, or one this build cannot read). */
fun calRuleOf(json: JsonElement?): CalRule? {
    val o = json as? JsonObject ?: return null
    fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
    fun int(k: String) = (o[k] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
    val freq = str("freq")?.takeIf { it in FREQ.values } ?: return null
    val byDay = (o["byDay"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }?.filter { it in CAL_DAYS }
    val wd = (o["byWeekday"] as? JsonObject)?.let { w ->
        val n = (w["n"] as? JsonPrimitive)?.intOrNull
        val day = (w["day"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (n != null && day != null && day in CAL_DAYS) CalNth(n, day) else null
    }
    return CalRule(freq, int("interval") ?: 1, byDay?.takeIf { it.isNotEmpty() }, int("byMonthDay"), wd, str("until"), int("count"))
}

/** The rule as the route body takes it, in the hub's key order. */
fun calRuleJson(r: CalRule?): JsonElement = if (r == null) JsonNull else buildJsonObject {
    put("freq", r.freq)
    put("interval", r.interval)
    r.byDay?.let { put("byDay", JsonArray(it.map(::JsonPrimitive))) }
    r.byMonthDay?.let { put("byMonthDay", it) }
    r.byWeekday?.let { w -> put("byWeekday", buildJsonObject { put("n", w.n); put("day", w.day) }) }
    r.until?.let { put("until", it) }
    r.count?.let { put("count", it) }
}

/** The control for a stored rule. */
fun calRepeatOf(rule: CalRule?): RepeatForm {
    if (rule == null || rule.freq !in FREQ.values) return RepeatForm()
    val days = weekOrder(rule.byDay.orEmpty())
    val wd = rule.byWeekday
    val md = rule.byMonthDay
    val unit = FREQ.entries.first { it.value == rule.freq }.key
    val i = rule.interval
    val kind = when {
        i != 1 -> "custom"
        unit == "day" && sameDays(days, WEEKDAYS) -> "weekday"
        unit == "day" && days.isEmpty() -> "daily"
        unit == "week" -> "weekly"
        unit == "month" -> "monthly"
        unit == "year" && wd == null && md == null -> "yearly"
        else -> "custom"
    }
    val until = rule.until?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
    return RepeatForm(
        kind = kind, interval = i.toString(), unit = unit, days = if (kind == "weekday") emptyList() else days,
        monthMode = if (wd != null) "weekday" else "day", monthDay = if (wd != null) null else md, nth = wd,
        end = if (until != null) "until" else if (rule.count != null) "count" else "never",
        until = until, count = rule.count?.toString() ?: "10",
    )
}

private fun unitOf(r: RepeatForm): String? = if (r.kind == "custom") r.unit.takeIf { it in CAL_REPEAT_UNITS } ?: "week"
else mapOf("weekday" to "day", "daily" to "day", "weekly" to "week", "monthly" to "month", "yearly" to "year")[r.kind]

/** The rule the control names, or null (does not repeat). Assumes [calRepeatError] passed for the numbers. */
fun calRuleOfRepeat(r: RepeatForm, start: LocalDate): CalRule? {
    if (r.kind == "none") return null
    val unit = unitOf(r) ?: return null
    val custom = r.kind == "custom"
    val days = weekOrder(r.days)
    val byDay = when {
        r.kind == "weekday" -> WEEKDAYS
        (unit == "week" || (custom && unit == "day")) && days.isNotEmpty() && days.size < 7 -> days
        unit == "week" && days.size == 7 -> days
        else -> null
    }
    var byMonthDay: Int? = null
    var byWeekday: CalNth? = null
    if (unit == "month" || (custom && unit == "year")) {
        if (r.monthMode == "weekday") byWeekday = r.nth ?: calAnchorNth(start)
        else if (r.monthDay != null && r.monthDay != start.dayOfMonth) byMonthDay = r.monthDay
    }
    return CalRule(
        freq = FREQ.getValue(unit), interval = if (custom) r.interval.trim().toIntOrNull() ?: 1 else 1,
        byDay = byDay, byMonthDay = byMonthDay, byWeekday = byWeekday,
        until = if (r.end == "until") r.until?.toString() else null,
        count = if (r.end == "count") r.count.trim().toIntOrNull() else null,
    )
}

/** What keeps the control from saving, or "" — the web's wording. */
/** [from]: the first day an until may name (a "following" split's day). */
fun calRepeatError(r: RepeatForm, start: LocalDate, from: LocalDate = start): String {
    if (r.kind == "none") return ""
    val n = r.interval.trim().toIntOrNull()
    if (r.kind == "custom" && (n == null || n < 1 || n > CAL_REPEAT_INTERVAL_MAX)) return "Repeat every 1 to $CAL_REPEAT_INTERVAL_MAX."
    if (r.end == "until") {
        val u = r.until ?: return "Pick the date it repeats until."
        if (u.isBefore(from)) return "It must repeat until a day on or after its start."
    }
    val c = r.count.trim().toIntOrNull()
    if (r.end == "count" && (c == null || c < 1 || c > CAL_REPEAT_COUNT_MAX)) return "End after 1 to $CAL_REPEAT_COUNT_MAX occurrences."
    return ""
}

private fun nthText(w: CalNth) = "the ${NTH[w.n] ?: "first"} ${calDayLong(w.day)}"
private fun list(days: List<String>) = weekOrder(days).joinToString(", ") { calDayShort(it) }

/** One line a person reads: "Every 2 weeks on Mon, Wed until 31 Dec". */
fun calRepeatSummary(rule: CalRule?, start: LocalDate): String {
    if (rule == null || rule.freq !in FREQ.values) return "Does not repeat"
    val i = if (rule.interval > 1) rule.interval else 1
    fun every(u: String) = if (i == 1) "Every $u" else "Every $i ${u}s"
    val days = rule.byDay.orEmpty()
    val wd = rule.byWeekday
    val md = rule.byMonthDay ?: start.dayOfMonth
    val month = MONTHS[start.monthValue - 1]
    var s = when (rule.freq) {
        "daily" -> if (i == 1 && sameDays(days, WEEKDAYS)) "Every weekday" else every("day") + if (days.isNotEmpty()) " on ${list(days)}" else ""
        "weekly" -> "${every("week")} on ${list(days.ifEmpty { listOf(calDayCode(start)) })}"
        "monthly" -> "${every("month")} on ${if (wd != null) nthText(wd) else "day $md"}"
        else -> "${every("year")} on ${if (wd != null) "${nthText(wd)} of $month" else "$md $month"}"
    }
    val u = rule.until?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
    if (u != null) s += " until ${u.dayOfMonth} ${MONTHS[u.monthValue - 1].take(3)}${if (u.year != start.year) " ${u.year}" else ""}"
    else if (rule.count != null) s += ", ${rule.count} time${if (rule.count == 1) "" else "s"}"
    return s
}

/** The Repeat menu, Teams' presets named for the start day ("Weekly on Tuesday"). */
fun calRepeatPresets(start: LocalDate, r: RepeatForm? = null): List<Pair<String, String>> = listOf(
    "none" to "Does not repeat",
    "weekday" to "Every weekday (Mon–Fri)",
    "daily" to "Daily",
    // A weekly control names its own days (QA: a stored Mon/Wed/Fri read "Weekly on Tuesday").
    "weekly" to "Weekly on ${if (r?.kind == "weekly" && r.days.isNotEmpty()) list(r.days) else calDayLong(calDayCode(start))}",
    "monthly" to "Monthly on day ${start.dayOfMonth}",
    "monthlyNth" to "Monthly on ${nthText(calAnchorNth(start))}",
    "yearly" to "Yearly on ${start.dayOfMonth} ${MONTHS[start.monthValue - 1]}",
    "custom" to "Custom…",
)

/** The preset a control shows (monthly splits on its mode). */
fun calRepeatPresetOf(r: RepeatForm): String = if (r.kind == "monthly" && r.monthMode == "weekday") "monthlyNth" else r.kind

/** A preset picked: the control it starts (a day / weekday named for the old start is dropped). */
fun calRepeatPick(r: RepeatForm, preset: String): RepeatForm {
    val next = r.copy(monthDay = null, nth = null)
    return when (preset) {
        "monthlyNth" -> next.copy(kind = "monthly", monthMode = "weekday")
        "monthly" -> next.copy(kind = "monthly", monthMode = "day")
        "custom" -> r.copy(
            kind = "custom",
            unit = unitOf(r)?.takeIf { r.kind != "none" } ?: r.unit,
            days = if (r.kind == "weekday") WEEKDAYS else r.days,
        )
        else -> next.copy(kind = preset, days = if (preset == "weekly") r.days else emptyList())
    }
}

/** The days a weekly control shows ticked: its own, else its start's weekday. */
fun calRepeatDaysShown(r: RepeatForm, start: LocalDate): List<String> {
    val week = r.kind == "weekly" || (r.kind == "custom" && r.unit == "week")
    return r.days.ifEmpty { if (week) listOf(calDayCode(start)) else emptyList() }
}

/** [code] ticked or unticked on the control (from what it shows, so the start's default day counts). */
fun calRepeatToggleDay(r: RepeatForm, start: LocalDate, code: String, on: Boolean): RepeatForm {
    val set = calRepeatDaysShown(r, start).toMutableSet()
    if (on) set += code else set -= code
    return r.copy(days = weekOrder(set))
}
