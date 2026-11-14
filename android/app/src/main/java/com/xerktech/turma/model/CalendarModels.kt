package com.xerktech.turma.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
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
    val categories: List<String> = emptyList(),
    val sensitivity: String = "",
    val isOnlineMeeting: Boolean = false,
    val private: Boolean = false,
    @Serializable(with = LenientCapturesSerializer::class)
    val meetings: List<CalendarCapture> = emptyList(),
    // The org the hub's capture matcher counts it for (XERK-2898); null = an older hub.
    val matchOrg: String? = null,
    // A Tenir-only entry's own fields (XERK-2896).
    val site: String = "",
    val meetingId: String = "",
    val platform: String = "",
    val participants: List<String> = emptyList(),
    val status: String = "",
    val summary: String = "",
    val tenirUrl: String = "",
    val ambiguous: Boolean = false,
    val calendarEventMissing: Boolean = false,
    val calendarEventId: String = "",
    val moved: Boolean = false,
) {
    val tenir: Boolean get() = source == "tenir"

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
open class LenientListSerializer<T>(private val item: KSerializer<T>) : KSerializer<List<T>> {
    override val descriptor: SerialDescriptor = ListSerializer(JsonElement.serializer()).descriptor

    override fun deserialize(decoder: Decoder): List<T> {
        val arr = (decoder as? JsonDecoder)?.decodeJsonElement() as? JsonArray ?: return emptyList()
        return arr.mapNotNull { row -> runCatching { TurmaJson.decodeFromJsonElement(item, row) }.getOrNull() }
    }

    override fun serialize(encoder: Encoder, value: List<T>) {
        (encoder as JsonEncoder).encodeJsonElement(TurmaJson.encodeToJsonElement(ListSerializer(item), value))
    }
}

object LenientCalendarEventsSerializer : LenientListSerializer<CalendarEvent>(CalendarEvent.serializer())
object LenientCalendarHostsSerializer : LenientListSerializer<CalendarHost>(CalendarHost.serializer())
object LenientAttendeesSerializer : LenientListSerializer<CalendarAttendee>(CalendarAttendee.serializer())
object LenientCapturesSerializer : LenientListSerializer<CalendarCapture>(CalendarCapture.serializer())
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
