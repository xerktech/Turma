package com.xerktech.turma.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull

/*
 * The Calendar wire (XERK-2900, epic XERK-2890; .claude/rules/contract-calendar.md):
 * `GET /api/calendar`, `GET /api/holidays` and a capture's `calendarEvent` on the
 * meeting row. Every string is sender-written (Outlook, Tenir) and is only ever
 * drawn as plain Text. Every list decodes row by row, so one malformed event or
 * host drops alone instead of blanking the week.
 */

/** One invitee of an Outlook event (`sanitizeCalendarEvent`). */
@Serializable
data class CalendarAttendee(
    val name: String = "",
    val email: String = "",
    val role: String = "unknown",
    val response: String = "unknown",
)

/** A Tenir capture linked to an Outlook event (`meetings[]` on the served event). */
@Serializable
data class CalendarCapture(val site: String = "", val meetingId: String = "", val title: String = "")

/**
 * One event of `GET /api/calendar`: an Outlook event ([source] "outlook") or a
 * Turma-only Tenir capture ([source] "tenir", `id` "tenir:<meetingId>"). [startMs]
 * / [endMs] null = the row carried none; such a row is never drawn (the web's `num`).
 */
@Serializable
data class CalendarEvent(
    val host: String = "",
    val org: String = "",
    val id: String = "",
    val source: String = "",
    val subject: String = "",
    val start: String = "",
    val end: String = "",
    val startMs: Long? = null,
    val endMs: Long? = null,
    val allDay: Boolean = false,
    val location: String = "",
    val organizer: String = "",
    val organizerEmail: String = "",
    val busy: String = "unknown",
    val myResponse: String = "unknown",
    val canceled: Boolean = false,
    val recurring: Boolean = false,
    @Serializable(with = LenientAttendeesSerializer::class)
    val attendees: List<CalendarAttendee> = emptyList(),
    val joinUrl: String = "",
    val seriesId: String = "",
    val body: String = "",
    @Serializable(with = LenientStringsSerializer::class)
    val categories: List<String> = emptyList(),
    val sensitivity: String = "",
    val isOnlineMeeting: Boolean = false,
    val private: Boolean = false,
    /** XERK-2936: the hub's "real meeting" verdict, judged before a private event is withheld; null = older hub. */
    val meeting: Boolean? = null,
    @Serializable(with = LenientCapturesSerializer::class)
    val meetings: List<CalendarCapture> = emptyList(),
    // The org the hub's capture matcher counts it for (XERK-2898); null = an older hub.
    val matchOrg: String? = null,
    // A Tenir-only entry's own fields (XERK-2896).
    val site: String = "",
    val meetingId: String = "",
    val platform: String = "",
    @Serializable(with = LenientStringsSerializer::class)
    val participants: List<String> = emptyList(),
    val status: String = "",
    val summary: String = "",
    val tenirUrl: String = "",
    val ambiguous: Boolean = false,
    val calendarEventMissing: Boolean = false,
    val calendarEventId: String = "",
    val moved: Boolean = false,
    // A Turma-created event's own fields (XERK-2968/2972): every org it belongs to
    // (`org` = orgs[0]), whether this caller may edit or delete it, its optimistic-
    // concurrency version and the wall clock it was made in. null = an older hub:
    // the event is read-only.
    @Serializable(with = LenientNullableStringsSerializer::class)
    val orgs: List<String>? = null,
    val editable: Boolean? = null,
    val version: Long? = null,
    val timeZone: String = "",
    // A Turma series' rule (XERK-2973), read by core/CalendarRepeat.kt's calRuleOf; raw, so
    // a shape this build cannot read degrades to "no rule" rather than failing the decode.
    val recurrence: kotlinx.serialization.json.JsonElement? = null,
    // An occurrence's original start (UTC ISO), the day its series' rule is read from.
    val originalStart: String = "",
    // An occurrence's series' first instant (ISO with offset): the day an implicit rule day reads off.
    val seriesStart: String = "",
    // A Turma event's Outlook copy per org (XERK-2987), read by core/CalendarEvents.kt's
    // calOutlookStates; raw, so a shape this build cannot read shows no state, never a failed decode.
    // null = an older hub: the panel reads as before.
    val outlook: kotlinx.serialization.json.JsonElement? = null,
    // Invitations (XERK-2989): sent from the first org's Outlook copy; the hub's defaults
    // (an older hub sends none: no invitations, Outlook's two options).
    val sendInvites: Boolean = false,
    val responseRequested: Boolean = true,
    val allowForward: Boolean = true,
) {
    val tenir: Boolean get() = source == "tenir"

    /** A Turma-created event (XERK-2967): owned by the hub, never on Outlook. */
    val turma: Boolean get() = source == "turma"

    /**
     * Edit and Delete are offered only for a Turma event the hub says this caller
     * may change — never a withheld private one (`private`): its served fields are
     * blanked, so saving them back would wipe the creator's event (XERK-2972 QA).
     */
    val canEdit: Boolean get() = turma && editable == true && version != null && !private

    /** One occurrence of a Turma series (XERK-2973): an Edit / Delete first asks which events. */
    val turmaOccurrence: Boolean get() = turma && recurring && seriesId.isNotEmpty()

    /** Host + id: one meeting on two hosts is two rows of the answer (the web's `evKey`). */
    val key: String get() = "$host\u0000$id"
}

/** One host's row of the answer: whether its copy of the range may be stale. */
@Serializable
data class CalendarHost(
    val host: String = "",
    val device: String = "",
    val online: Boolean? = null,
    val syncedAt: Long = 0,
    val windowFrom: Long = 0,
    val windowUntil: Long = 0,
    val ranges: List<List<Long>> = emptyList(),
    val lastError: String = "",
    val lastErrorAt: Long = 0,
    val pending: Boolean = false,
    // Its calendar settings (XERK-2929): [org] the host's decided org, which every
    // one of its events takes and nothing sets (XERK-2964); the private opt-in.
    val org: String = "",
    val showPrivate: Boolean = false,
)

/** `GET /api/calendar` (contract-calendar.md "Served"). */
@Serializable
data class CalendarAnswer(
    val from: Long = 0,
    val until: Long = 0,
    @Serializable(with = LenientCalendarHostsSerializer::class)
    val hosts: List<CalendarHost> = emptyList(),
    @Serializable(with = LenientCalendarEventsSerializer::class)
    val events: List<CalendarEvent> = emptyList(),
    val truncated: Boolean = false,
)

/** One day of `GET /api/holidays`: [date] the OBSERVED day "YYYY-MM-DD"; [offFor] the orgs it is a day off for. */
@Serializable
data class Holiday(
    val id: String = "",
    val date: String = "",
    val name: String = "",
    val country: String = "",
    val actualDate: String = "",
    val offFor: List<String> = emptyList(),
)

/**
 * A linked capture's event as the meeting row carries it (`meetingWire`,
 * XERK-2896/2899): [attendees] are invitee NAMES here, not objects.
 */
@Serializable
data class MeetingCalendarEvent(
    val host: String = "",
    val org: String = "",
    val subject: String = "",
    val start: String = "",
    val end: String = "",
    val startMs: Long? = null,
    val endMs: Long? = null,
    val canceled: Boolean = false,
    val moved: Boolean = false,
    val attendees: List<String> = emptyList(),
    val private: Boolean = false,
)

/** `{ok, meeting}` / `{error}` of `POST /api/orgs/<site>/meetings/<mid>/calendar`. */
@Serializable
data class MeetingCalendarResponse(val ok: Boolean = false, val meeting: Meeting? = null, val error: String = "")

/** A list decoded row by row: a malformed row drops alone; a non-array reads as empty. */
open class LenientListSerializer<T>(
    private val item: KSerializer<T>,
    // Strip control/bidi/format characters from every string of a row (XERK-2921).
    private val clean: Boolean = false,
) : KSerializer<List<T>> {
    override val descriptor: SerialDescriptor = ListSerializer(JsonElement.serializer()).descriptor

    override fun deserialize(decoder: Decoder): List<T> {
        val arr = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonArray ?: return emptyList()
        return arr.mapNotNull { row ->
            runCatching { TurmaJson.decodeFromJsonElement(item, if (clean) cleanCalendarJson(row) else row) }.getOrNull()
        }
    }

    override fun serialize(encoder: Encoder, value: List<T>) {
        (encoder as JsonEncoder).encodeJsonElement(TurmaJson.encodeToJsonElement(ListSerializer(item), value))
    }
}

object LenientCalendarEventsSerializer : LenientListSerializer<CalendarEvent>(CalendarEvent.serializer(), clean = true)
object LenientCalendarHostsSerializer : LenientListSerializer<CalendarHost>(CalendarHost.serializer(), clean = true)

/**
 * The hub's `meetingText` character class (C0 but tab/newline, DEL + C1, zero-width
 * and bidi marks, line/paragraph separators, word joiners, BOM), removed. The hub
 * already strips them in `sanitizeCalendarEvent`; this is defence against an older
 * or forwarding hub (XERK-2921): drawn as plain Text there is no markup risk, but a
 * bidi override still reorders what the operator reads.
 */
private val CALENDAR_CONTROL = Regex("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]")

internal fun cleanCalendarText(s: String): String = if (CALENDAR_CONTROL.containsMatchIn(s)) CALENDAR_CONTROL.replace(s, "") else s

// Keys that IDENTIFY a row and are sent back to the hub or matched against its ids:
// never cleaned, or an id the hub accepts (CAL_ID_RE allows zero-width marks) would
// round-trip as one it doesn't have (QA).
private val CALENDAR_ID_KEYS = setOf("host", "id", "seriesId", "org", "orgs", "matchOrg", "site", "meetingId", "calendarEventId")

/** Every display string in [e] (values only, id keys kept as sent) through [cleanCalendarText]. */
internal fun cleanCalendarJson(e: JsonElement): JsonElement = when (e) {
    is kotlinx.serialization.json.JsonObject -> kotlinx.serialization.json.JsonObject(
        e.mapValues { (k, v) -> if (k in CALENDAR_ID_KEYS) v else cleanCalendarJson(v) })
    is JsonArray -> JsonArray(e.map { cleanCalendarJson(it) })
    is kotlinx.serialization.json.JsonPrimitive ->
        if (e.isString) kotlinx.serialization.json.JsonPrimitive(cleanCalendarText(e.content)) else e
    else -> e
}
object LenientAttendeesSerializer : LenientListSerializer<CalendarAttendee>(CalendarAttendee.serializer())
object LenientCapturesSerializer : LenientListSerializer<CalendarCapture>(CalendarCapture.serializer())
/**
 * A list of strings where one wrong-typed field must not drop the whole event
 * (the web keeps it): a non-array reads as empty, and only STRING entries count,
 * as the web's `typeof c === "string"` filter — TurmaJson's lenient decode would
 * otherwise turn a number into "1".
 */
object LenientStringsSerializer : KSerializer<List<String>> {
    override val descriptor: SerialDescriptor = ListSerializer(JsonElement.serializer()).descriptor

    override fun deserialize(decoder: Decoder): List<String> {
        val arr = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonArray ?: return emptyList()
        return arr.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }
    }

    override fun serialize(encoder: Encoder, value: List<String>) {
        (encoder as JsonEncoder).encodeJsonElement(TurmaJson.encodeToJsonElement(ListSerializer(String.serializer()), value))
    }
}
/** [LenientStringsSerializer], but an absent / non-array value reads as null ("an older hub"). */
object LenientNullableStringsSerializer : KSerializer<List<String>?> {
    override val descriptor: SerialDescriptor = ListSerializer(JsonElement.serializer()).descriptor

    override fun deserialize(decoder: Decoder): List<String>? {
        val arr = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonArray ?: return null
        return arr.mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content }
    }

    override fun serialize(encoder: Encoder, value: List<String>?) {
        val json = encoder as JsonEncoder
        json.encodeJsonElement(
            if (value == null) JsonNull else TurmaJson.encodeToJsonElement(ListSerializer(String.serializer()), value),
        )
    }
}

/** `{ok, event}` / `{error, event?}` of the Turma-event routes (XERK-2968): a 409 carries the current event. */
@Serializable
data class TurmaEventResponse(val ok: Boolean = false, val event: CalendarEvent? = null, val error: String = "")

object LenientHolidaysSerializer : LenientListSerializer<Holiday>(Holiday.serializer())

/**
 * A meeting row's `calendarEvent`: a malformed one reads as none, never as a
 * dropped meeting (`/api/agents` decodes each meeting whole).
 */
object LenientMeetingCalendarEventSerializer : KSerializer<MeetingCalendarEvent?> {
    override val descriptor: SerialDescriptor = JsonElement.serializer().descriptor

    override fun deserialize(decoder: Decoder): MeetingCalendarEvent? {
        val el = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return null
        return runCatching { TurmaJson.decodeFromJsonElement(MeetingCalendarEvent.serializer(), el) }.getOrNull()
    }

    override fun serialize(encoder: Encoder, value: MeetingCalendarEvent?) {
        val json = encoder as JsonEncoder
        json.encodeJsonElement(
            if (value == null) JsonNull else TurmaJson.encodeToJsonElement(MeetingCalendarEvent.serializer(), value),
        )
    }
}
