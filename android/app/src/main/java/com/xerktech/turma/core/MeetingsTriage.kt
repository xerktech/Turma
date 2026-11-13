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
 * One row of the list. A plain meeting carries [meeting]; the org's daily
 * meeting ([daily]) carries the brief written for it and/or the captured
 * meeting, either possibly absent. [at] places it in time; [upcoming] is the
 * schedule's next meeting, not yet held.
 */
data class TriageEntry(
    val key: String,
    val siteKey: String,
    val at: Long,
    val meeting: Meeting?,
    val brief: DailyBrief? = null,
    val daily: Boolean = false,
    val upcoming: Boolean = false,
) {
    val pending: Int get() = meeting?.let(::meetingPendingCount) ?: 0
    val archived: Boolean get() = (meeting?.archivedAt ?: 0L) > 0
}

private fun meetingAt(m: Meeting): Long = if (m.startedAt > 0) m.startedAt else m.receivedAt

/** The newest finished brief of a group (newest first), else its newest row. */
private fun pickBrief(rows: List<DailyBrief>): DailyBrief? = rows.firstOrNull { it.status == "ok" } ?: rows.firstOrNull()

/**
 * Every entry of one org, newest first: one per captured meeting, except that
 * the daily meetings are ONE entry per scheduled `meetingAt`, pairing the
 * brief written for it with the meeting the hub tagged `daily` for it. A
 * brief whose meeting was never captured is still an entry, and the
 * schedule's next meeting is one ([upcoming]) before it is held.
 */
fun triageEntries(
    siteKey: String,
    meetings: List<Meeting>,
    briefs: List<DailyBrief>,
    schedule: DailyBriefSchedule?,
    now: Long,
): List<TriageEntry> {
    val out = mutableListOf<TriageEntry>()
    val dailyAt = LinkedHashMap<Long, TriageEntry>()
    val byRun = briefs.filter { it.runId.isNotEmpty() }.associateBy { it.runId }
    val byAt = briefs.filter { it.meetingAt > 0 }.groupBy { it.meetingAt }
    val usedBriefs = mutableSetOf<Long>()
    for (m in meetings) {
        val d = m.daily
        if (d == null || d.meetingAt <= 0 || d.meetingAt in dailyAt) {
            // A second capture of the same daily meeting stays a plain entry.
            out += TriageEntry("m:${m.meetingId}", siteKey, meetingAt(m), m)
            continue
        }
        val brief = byRun[d.briefRunId] ?: pickBrief(byAt[d.meetingAt].orEmpty())
        if (brief != null && brief.meetingAt > 0) usedBriefs += brief.meetingAt
        usedBriefs += d.meetingAt
        dailyAt[d.meetingAt] = TriageEntry("d:${d.meetingAt}", siteKey, d.meetingAt, m, brief, daily = true)
    }
    val next = nextBriefMeeting(schedule, now)
    for ((at, rows) in byAt) {
        if (at in usedBriefs) continue
        dailyAt[at] = TriageEntry("d:$at", siteKey, at, null, pickBrief(rows), daily = true, upcoming = at == next)
    }
    if (next != null && next !in dailyAt) {
        dailyAt[next] = TriageEntry("d:$next", siteKey, next, null, null, daily = true, upcoming = true)
    }
    out += dailyAt.values.map { if (it.at == next && it.meeting == null) it.copy(upcoming = true) else it }
    return out.sortedByDescending { it.at }
}

/** Whether [e] shows under [filter] and matches [query] (meeting and proposal titles). */
fun triageShows(e: TriageEntry, filter: TriageFilter, query: String): Boolean {
    val inFilter = when (filter) {
        TriageFilter.ARCHIVED -> e.archived
        TriageFilter.ALL -> !e.archived
        TriageFilter.REVIEW -> !e.archived && (
            e.pending > 0 || e.upcoming ||
                e.meeting?.status == "queued" || e.meeting?.status == "running")
    }
    if (!inFilter) return false
    val q = query.trim()
    if (q.isEmpty()) return true
    val m = e.meeting
    return (e.daily && "daily meeting".contains(q, ignoreCase = true)) ||
        (m != null && (m.title.contains(q, ignoreCase = true) ||
            m.items.any { it.title.contains(q, ignoreCase = true) }))
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

/** A daily entry's title: "Daily meeting" plus, once captured, the meeting's own title. */
fun triageTitle(e: TriageEntry): String = when {
    e.daily && e.meeting != null && e.meeting.title.isNotBlank() -> "Daily meeting · ${e.meeting.title}"
    e.daily -> "Daily meeting"
    else -> e.meeting?.title?.ifBlank { "Untitled meeting" } ?: "Untitled meeting"
}

/** A daily entry's brief status line, the rail's "brief ready / being written / none". */
fun triageBriefStatus(e: TriageEntry): String? {
    if (!e.daily) return null
    val b = e.brief ?: return if (e.upcoming) "No brief yet" else null
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
