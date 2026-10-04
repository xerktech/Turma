package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.BriefItem
import com.xerktech.turma.model.OrgBrief

/**
 * The per-org brief (XERK-1573) — pure reads behind `ui/BriefScreen.kt`, the
 * port of `turma/public/brief.html`'s render. The hub compiles the brief; these
 * only decide which orgs show and how a row's meta line reads.
 */

/** The brief's sections in screen order: (key, heading). */
val BRIEF_SECTIONS: List<Pair<String, String>> = listOf(
    "needsYou" to "Needs you",
    "stalled" to "Stalled",
    "waiting" to "Waiting",
    "nextUp" to "Starts next",
    "finished" to "Finished",
    "closedStale" to "Closed as stale",
)

private val BRIEF_STATE_LABEL = mapOf(
    "needs-you:question" to "question", "needs-you:permission" to "permission",
    "needs-you:review" to "review", "needs-you:test" to "test", "needs-you:stalled" to "stalled",
    "waiting" to "waiting", "sleeping" to "sleeping",
)
private val BRIEF_STALE_LABEL = mapOf(
    "not-reproducible" to "not reproducible", "already-fixed" to "already fixed",
)

/**
 * How a Finished row finished — leads its meta, with the age where the hub knows
 * it (a PR carries no merge time). web brief.html `FINISHED_VERB`.
 */
private val BRIEF_FINISHED_VERB = mapOf(
    "ticket" to "done", "pr" to "merged", "session" to "ended",
)

/** One section's rows off a brief, by [BRIEF_SECTIONS] key. */
fun briefSection(b: OrgBrief, key: String): List<BriefItem> = when (key) {
    "needsYou" -> b.needsYou
    "stalled" -> b.stalled
    "waiting" -> b.waiting
    "nextUp" -> b.nextUp
    "finished" -> b.finished
    "closedStale" -> b.closedStale
    else -> emptyList()
}

/** A section's TOTAL (the lists are capped hub-side, the counts are not). */
fun briefSectionCount(b: OrgBrief, key: String): Long = when (key) {
    "needsYou" -> b.counts.needsYou
    "stalled" -> b.counts.stalled
    "waiting" -> b.counts.waiting
    "nextUp" -> b.counts.nextUp
    "finished" -> b.counts.finished
    "closedStale" -> b.counts.closedStale
    else -> 0L
}.coerceAtLeast(briefSection(b, key).size.toLong())

/**
 * The orgs the Brief screen lists, sorted: every org a host is DECIDED into (the
 * served `org`) plus any org with a kept brief — so an org with none yet still
 * offers "Brief now" — scoped by the header's org pick (self-healed like every
 * screen, [effectiveOrgs]). web brief.html `render`.
 */
fun briefOrgs(
    briefs: Map<String, List<OrgBrief>>,
    agents: List<AgentInfo>,
    stored: Set<String>,
): List<String> {
    val keys = effectiveOrgs(stored, mergeSites(agents))
    val orgs = sortedSetOf<String>()
    for ((site, list) in briefs) if (site.isNotEmpty() && list.isNotEmpty()) orgs += site
    for (a in agents) a.org?.takeIf { it.isNotEmpty() }?.let { orgs += it }
    return orgs.filter { keys.isEmpty() || it in keys }
}

/**
 * The orgs a host is DECIDED into (the served `org`) — the only ones the hub will
 * compile a brief for, so "Brief now" shows for these alone; an org listed only
 * for its kept briefs has no host to brief. web brief.html `render`'s `live`.
 */
fun briefLiveOrgs(agents: List<AgentInfo>): Set<String> =
    agents.mapNotNull { a -> a.org?.takeIf { it.isNotEmpty() } }.toSet()

/** A duration as the brief words it — web brief.html `dur`, same thresholds. */
fun briefDur(ms: Long): String {
    val s = Math.round(ms.coerceAtLeast(0) / 1000.0)
    return when {
        s < 90 -> "${s}s"
        s < 5400 -> "${Math.round(s / 60.0)}m"
        s < 172800 -> "${Math.round(s / 3600.0)}h"
        else -> "${Math.round(s / 86400.0)}d"
    }
}

/**
 * A row's meta line — web brief.html `itemHtml`'s meta, part for part: the
 * attention state, its why, the reason it is next (or how it was closed), the
 * session's note, then "in <eta>" or "<age> ago" (a Finished row's led by how it
 * finished — "done 3h ago", "merged"), the ticket key of a non-ticket row and the
 * host.
 */
fun briefItemMeta(section: String, item: BriefItem, now: Long): String {
    val parts = mutableListOf<String>()
    val state = item.state
    val why = item.why
    val reason = item.reason
    val note = item.note
    val eta = item.eta
    val since = item.since
    val key = item.key
    val host = item.host
    if (state != null) BRIEF_STATE_LABEL[state]?.let { label -> parts += label }
    if (why != null) parts += why
    if (reason != null) parts += if (section == "closedStale") BRIEF_STALE_LABEL[reason] ?: reason else reason
    if (note != null) parts += note
    val verb = if (section == "finished") BRIEF_FINISHED_VERB[item.kind] else null
    if (eta != null && eta > now) {
        parts += "in ${briefDur(eta - now)}"
    } else if (since != null && section != "nextUp") {
        parts += (if (verb != null) "$verb " else "") + "${briefDur(now - since)} ago"
    } else if (verb != null) {
        parts += verb
    }
    if (item.kind != "ticket" && key != null) parts += key
    if (host != null && section != "nextUp") parts += host
    return parts.joinToString(" · ")
}
