package com.xerktech.turma.core

import com.xerktech.turma.model.CreateProject
import com.xerktech.turma.model.CreateType
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingItem
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/*
 * Meetings (XERK-2511): the pure logic of the Android Meetings screen, ported
 * from turma/public/meetings.html (XERK-2510) so the phone sends the same ticket
 * text and reads the same states as the web page. JVM-tested in MeetingsTest.
 */

/** An offset into the meeting as m:ss / h:mm:ss (meetings.html `clock`). */
fun meetingClock(ms: Long): String {
    val t = maxOf(0L, ms / 1000)
    val h = t / 3600
    val m = (t % 3600) / 60
    val s = t % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

private val SAFE_URL = Regex("^https?://[^\\s\"'<>`\\\\]+$", RegexOption.IGNORE_CASE)

/** The hub's meeting link, re-checked: only an http(s) URL is ever opened. */
fun safeMeetingUrl(u: String): String = if (SAFE_URL.matches(u)) u else ""

/** That moment in Tenir: a W3C media fragment on the meeting's own link. */
fun meetingMomentUrl(tenirUrl: String, atMs: Long): String {
    val u = safeMeetingUrl(tenirUrl)
    if (u.isEmpty() || atMs < 0) return ""
    return u.substringBefore('#') + "#t=" + (atMs / 1000)
}

fun meetingKindLabel(kind: String): String = when (kind) {
    "followup" -> "follow-up"
    else -> kind
}

/** A proposal can be (re)approved unless it is in flight or done. */
fun meetingReviewable(it: MeetingItem): Boolean =
    it.review == null || it.review.state == "failed" || it.review.state == "rejected"

/** Which org's project new tickets go to: the viewer's pick while offered, else a lone project. */
fun meetingProject(saved: String?, projects: List<CreateProject>): String = when {
    saved != null && projects.any { it.key == saved } -> saved
    projects.size == 1 -> projects[0].key
    else -> ""
}

/** The issue type a proposal's kind maps to, among what the project offers (its id). */
fun meetingDefaultType(kind: String, types: List<CreateType>): String {
    if (types.isEmpty()) return ""
    fun by(re: Regex) = types.firstOrNull { re.containsMatchIn(it.name) }
    val hit = (if (kind == "bug") by(Regex("bug", RegexOption.IGNORE_CASE)) else null)
        ?: by(Regex("^task$", RegexOption.IGNORE_CASE))
        ?: by(Regex("task|story|issue", RegexOption.IGNORE_CASE))
        ?: types[0]
    return hit.id
}

/**
 * What the ticket says by default: the proposal, then where it came from — the
 * meeting and its date, each quote with its offset, the Tenir link. Built on the
 * phone so the operator sees exactly what is sent when editing.
 */
fun meetingTicketDescription(m: Meeting, it: MeetingItem): String {
    val lines = mutableListOf<String>()
    if (it.description.isNotEmpty()) lines += listOf(it.description, "")
    val date = if (m.startedAt > 0) {
        " (" + DateTimeFormatter.ISO_LOCAL_DATE.format(Instant.ofEpochMilli(m.startedAt).atOffset(ZoneOffset.UTC)) + ")"
    } else ""
    lines += "Proposed from the meeting \"${m.title}\"$date."
    for (q in it.quotes) {
        lines += "> " + (if (q.speaker.isNotEmpty()) "${q.speaker}: " else "") + q.text +
            (if (q.atMs >= 0) " [${meetingClock(q.atMs)}]" else "")
    }
    val u = safeMeetingUrl(m.tenirUrl)
    if (u.isNotEmpty()) lines += "Meeting: $u"
    return lines.joinToString("\n")
}

/** The draft an Edit opens with: a decision edits its own text, a ticket the full description. */
fun meetingDraftDescription(m: Meeting, it: MeetingItem): String =
    if (it.kind == "decision") it.description else meetingTicketDescription(m, it)

enum class ReviewTone { NEUTRAL, GOOD, BAD }

/** One line of an item's review state, or null for an unreviewed item. */
data class ReviewLine(val text: String, val tone: ReviewTone, val ticketKey: String = "")

fun meetingReviewLines(it: MeetingItem): List<ReviewLine> {
    val r = it.review ?: return emptyList()
    return when (r.state) {
        "creating" -> listOf(ReviewLine("Creating the ticket…", ReviewTone.NEUTRAL))
        "logged" -> listOf(ReviewLine("✓ Added to the decisions log", ReviewTone.GOOD))
        "rejected" -> listOf(ReviewLine("Rejected", ReviewTone.NEUTRAL))
        "failed" -> listOf(ReviewLine("Not created — " + r.error.ifEmpty { "the create failed" }, ReviewTone.BAD))
        "created" -> buildList {
            add(ReviewLine("✓ Created ${r.key}", ReviewTone.GOOD, r.key))
            if (r.start) {
                val sess = when (r.session) {
                    "queued" -> "session starting"
                    "failed" -> "no session — " + r.sessionError.ifEmpty { "it could not start" }
                    else -> "session starts once the board lists it with a repo"
                }
                add(ReviewLine("· $sess", if (r.session == "failed") ReviewTone.BAD else ReviewTone.NEUTRAL))
            }
        }
        else -> emptyList()
    }
}

/** "Zoom · Tue, Oct 31, 9:00 AM · 45 min · 3 participants". */
fun meetingMetaLine(m: Meeting, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val bits = mutableListOf<String>()
    if (m.platform.isNotEmpty()) bits += m.platform
    if (m.startedAt > 0) {
        bits += DateTimeFormatter.ofPattern("EEE, MMM d, h:mm a", locale)
            .format(Instant.ofEpochMilli(m.startedAt).atZone(zone))
    }
    if (m.startedAt > 0 && m.endedAt > m.startedAt) {
        bits += "${maxOf(1L, Math.round((m.endedAt - m.startedAt) / 60000.0))} min"
    }
    val ppl = m.participants.size
    if (ppl > 0) bits += "$ppl participant" + if (ppl == 1) "" else "s"
    return bits.joinToString(" · ")
}

/** The line a meeting shows instead of items, or null when it lists them. */
fun meetingStatusLine(m: Meeting): Pair<String, Boolean>? = when {
    m.status == "queued" -> "Waiting for a host of this org to read the captions…" to false
    m.status == "running" -> "Reading the captions" + (if (m.host.isNotEmpty()) " on ${m.host}" else "") + "…" to false
    m.status == "failed" -> "Could not propose work items — " + m.error.ifEmpty { "the run failed" } to true
    m.items.isEmpty() -> "Nothing to propose from this meeting." to false
    else -> null
}

/** Whether an org's list has a ticket proposal left to approve (so it needs a project). */
fun meetingsNeedProject(list: List<Meeting>): Boolean =
    list.any { m -> m.status == "ok" && m.items.any { it.kind != "decision" && meetingReviewable(it) } }

/** The orgs the screen shows: those with meetings, inside the header's scope (empty = all). */
fun meetingOrgs(map: Map<String, List<Meeting>>, scoped: Set<String>): List<String> =
    map.filter { (k, v) -> v.isNotEmpty() && (scoped.isEmpty() || k in scoped) }.keys.sorted()
