package com.xerktech.turma.core

import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.model.DailyBriefSchedule
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingItem
import java.time.Instant
import java.time.ZoneId

/*
 * The Brief screen's meetings triage (XERK-2858, the web's XERK-2857 two-pane
 * page): one list of each org's meetings with the Daily brief folded into the
 * org's daily-meeting entry. Pure, so MeetingsTriageTest pins it on the JVM.
 * Wire: XERK-2856 (`archivedAt`, `daily`, `meetingTitle`, the reopen action),
 * .claude/rules/contract-meetings.md.
 */

/** The list's filter chips. Needs review is the default. */
enum class TriageFilter(val label: String) { REVIEW("Needs review"), ALL("All"), ARCHIVED("Archived") }

/** A proposal still waiting on the operator: unreviewed, or its create failed (Approve retries it). */
fun meetingItemPending(it: MeetingItem): Boolean = it.review == null || it.review.state == "failed"

/** Only a rejected or failed proposal can be reopened (the hub's 409 otherwise). */
fun meetingReopenable(it: MeetingItem): Boolean = it.review?.state == "rejected" || it.review?.state == "failed"

/** How many of a settled meeting's proposals still wait on the operator. */
fun meetingPendingCount(m: Meeting): Int = if (m.status == "ok") m.items.count(::meetingItemPending) else 0

/** "x of n reviewed", or null when the meeting proposes nothing (or is not settled). */
fun meetingProgress(m: Meeting): String? {
    if (m.status != "ok" || m.items.isEmpty()) return null
    return "${m.items.size - meetingPendingCount(m)} of ${m.items.size} reviewed"
}

/** A meeting's proposals split for the detail pane: pending first, reviewed behind "show reviewed". */
fun meetingItemsSplit(m: Meeting): Pair<List<MeetingItem>, List<MeetingItem>> =
    m.items.partition(::meetingItemPending)

/** A queued/running meeting cannot be archived (the hub's 409); every settled one can. */
fun meetingArchivable(m: Meeting): Boolean = m.status == "ok" || m.status == "failed"

/**
 * One row of the list. A plain meeting is one [meetings] entry; the org's
 * daily meeting ([daily]) gathers every capture the hub tagged for that
 * scheduled meeting (newest first) and the briefs written for it, either
 * possibly empty — the web's `entriesOf`. [at] places it in time; [upcoming]
 * is the schedule's next meeting; [current] a daily entry for today or later
 * (or the org's newest one when none is), which Needs review always lists.
 */
data class TriageEntry(
    val key: String,
    val siteKey: String,
    val at: Long,
    val meetings: List<Meeting> = emptyList(),
    val briefs: List<DailyBrief> = emptyList(),
    val daily: Boolean = false,
    val upcoming: Boolean = false,
    val current: Boolean = false,
) {
    val pending: Int get() = meetings.sumOf(::meetingPendingCount)
    val archived: Boolean get() = meetings.isNotEmpty() && meetings.all { it.archivedAt > 0 }
    val inflight: Boolean get() = meetings.any { it.status == "queued" || it.status == "running" }

    /** The brief the entry reads aloud: the newest finished one, else the newest row. */
    val brief: DailyBrief? get() = briefs.firstOrNull { it.status == "ok" } ?: briefs.firstOrNull()
}

private fun meetingAt(m: Meeting): Long = if (m.startedAt > 0) m.startedAt else m.receivedAt

private fun startOfDay(t: Long, zone: ZoneId): Long =
    Instant.ofEpochMilli(t).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()

/**
 * Every entry of one org, newest first (the web's `entriesOf`): one per plain
 * meeting, and ONE per scheduled daily `meetingAt` holding every capture the
 * hub tagged `daily` for it, the brief each capture links (`briefRunId`), and
 * every other brief written for that meeting. A brief whose meeting was never
 * captured is still an entry, and so is the schedule's next meeting.
 */
fun triageEntries(
    siteKey: String,
    meetings: List<Meeting>,
    briefs: List<DailyBrief>,
    schedule: DailyBriefSchedule?,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
): List<TriageEntry> {
    val out = mutableListOf<TriageEntry>()
    val dayMeetings = LinkedHashMap<Long, MutableList<Meeting>>()
    val dayBriefs = LinkedHashMap<Long, MutableList<DailyBrief>>()
    val byRun = briefs.filter { it.runId.isNotEmpty() }.associateBy { it.runId }
    val claimed = mutableSetOf<String>()
    for (m in meetings) {
        val d = m.daily
        if (d != null && d.meetingAt > 0) {
            dayMeetings.getOrPut(d.meetingAt) { mutableListOf() } += m
            val b = byRun[d.briefRunId]
            if (b != null && claimed.add(b.runId)) dayBriefs.getOrPut(d.meetingAt) { mutableListOf() } += b
        } else {
            out += TriageEntry("m:${m.meetingId}", siteKey, meetingAt(m), listOf(m))
        }
    }
    for (b in briefs) {
        if (b.runId in claimed) continue
        val at = if (b.meetingAt > 0) b.meetingAt else b.startedAt
        if (at > 0) dayBriefs.getOrPut(at) { mutableListOf() } += b
    }
    val next = nextBriefMeeting(schedule, now)
    val days = (dayMeetings.keys + dayBriefs.keys + listOfNotNull(next)).distinct()
    val today = startOfDay(now, zone)
    val dailies = days.map { at ->
        TriageEntry(
            "d:$at", siteKey, at,
            meetings = dayMeetings[at].orEmpty(),
            // Served newest first; a linked brief joined out of order, so order again.
            briefs = dayBriefs[at].orEmpty().sortedByDescending { it.startedAt },
            daily = true, upcoming = at == next, current = at >= today,
        )
    }.toMutableList()
    if (dailies.none { it.current } && dailies.isNotEmpty()) {
        val i = dailies.indices.maxBy { dailies[it].at }
        dailies[i] = dailies[i].copy(current = true)
    }
    out += dailies
    return out.sortedByDescending { it.at }
}

/**
 * Whether [e] shows under [filter] and matches [query] (meeting and proposal
 * titles). Needs review lists what waits on the operator, a meeting still
 * being read, and the org's current daily entry (where Run now lives).
 */
fun triageShows(e: TriageEntry, filter: TriageFilter, query: String): Boolean {
    val inFilter = when (filter) {
        TriageFilter.ARCHIVED -> e.archived
        TriageFilter.ALL -> !e.archived
        TriageFilter.REVIEW -> !e.archived && (e.pending > 0 || e.inflight || e.current)
    }
    if (!inFilter) return false
    val q = query.trim()
    if (q.isEmpty()) return true
    return (e.daily && "daily meeting".contains(q, ignoreCase = true)) ||
        e.meetings.any { m ->
            m.title.contains(q, ignoreCase = true) || m.items.any { it.title.contains(q, ignoreCase = true) }
        }
}

/** The list's date buckets, in display order. */
enum class TriageBucket(val label: String) {
    UPCOMING("Upcoming"), TODAY("Today"), YESTERDAY("Yesterday"), WEEK("This week"), EARLIER("Earlier")
}

fun triageBucket(at: Long, now: Long, zone: ZoneId): TriageBucket {
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val d = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
    return when {
        d.isAfter(today) -> TriageBucket.UPCOMING
        d == today -> TriageBucket.TODAY
        d == today.minusDays(1) -> TriageBucket.YESTERDAY
        d.isAfter(today.minusDays(7)) -> TriageBucket.WEEK
        else -> TriageBucket.EARLIER
    }
}

/** An org's entries under [filter]/[query], grouped by bucket in display order. */
fun triageBuckets(
    entries: List<TriageEntry>,
    filter: TriageFilter,
    query: String,
    now: Long,
    zone: ZoneId,
): List<Pair<TriageBucket, List<TriageEntry>>> =
    entries.filter { triageShows(it, filter, query) }
        .groupBy { triageBucket(it.at, now, zone) }
        .toSortedMap(compareBy { it.ordinal })
        .map { (b, l) ->
            // Upcoming reads soonest first; everything past, newest first.
            b to if (b == TriageBucket.UPCOMING) l.sortedBy { it.at } else l
        }

/**
 * The entry after [current] that still needs review, in list order across the
 * orgs shown (the web's "next entry selected" once one is done), or null.
 */
fun triageNext(ordered: List<TriageEntry>, current: TriageEntry): TriageEntry? {
    val i = ordered.indexOfFirst { it.siteKey == current.siteKey && it.key == current.key }
    val rest = if (i < 0) ordered else ordered.drop(i + 1) + ordered.take(i)
    return rest.firstOrNull { it.pending > 0 && !it.archived }
}

/** An entry's title: "Daily meeting" (the web's `entryTitle`), else the meeting's own. */
fun triageTitle(e: TriageEntry): String =
    if (e.daily) "Daily meeting" else e.meetings.firstOrNull()?.title?.ifBlank { null } ?: "Untitled meeting"

/** A daily entry's brief status line, the rail's "brief ready / being written / none". */
fun triageBriefStatus(e: TriageEntry): String? {
    if (!e.daily) return null
    val b = e.brief ?: return if (e.upcoming || e.current) "No brief yet" else null
    return when (b.status) {
        "running" -> "Brief being written…"
        "failed" -> "Brief not written"
        else -> "Brief ready"
    }
}

/**
 * Labels Tenir sent that no org answers to (`meetingLabelMisses` keys,
 * `<label>[@tenant]`), as the banner lists them: the bare label, newest first.
 */
fun meetingLabelMissLabels(misses: Map<String, com.xerktech.turma.model.MeetingLabelMiss>): List<String> =
    misses.entries.sortedByDescending { it.value.at }.map { it.key.substringBefore('@') }.distinct()

/** One name per line, as the Whose work field holds them; blanks dropped, case-folded duplicates once. */
fun focusNames(text: String): List<String> {
    val out = mutableListOf<String>()
    for (n in text.lines().map { it.trim() }) {
        if (n.isNotEmpty() && out.none { it.equals(n, ignoreCase = true) }) out += n
    }
    return out
}
