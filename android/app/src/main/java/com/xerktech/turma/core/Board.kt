package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.JiraTicket

/**
 * Cross-org Jira board derivation — a pure port of `turma/public/board.js`
 * (`mergeSites` + `categoryOf`). Collapses the hosts that share an org into one
 * board per `siteKey`: the freshest block wins per (site, user), different users
 * on one site union, deduped by issue key. Kept pure + JVM-tested.
 */

val BOARD_CATEGORIES = listOf(
    "todo" to "To Do",
    "inprogress" to "In Progress",
    "review" to "In Review",
    "done" to "Done",
)

/**
 * "In Review"/"Testing" statuses live in Jira's `indeterminate` category (which
 * the agent maps to `inprogress`) — there is no fourth cross-org category for
 * them. So the In Review column is carved out of `inprogress` by matching the
 * org-specific status NAME rather than the category, on word boundaries so
 * "Attestation"/"Contest" can't leak in but "In Review"/"Code Review"/"Testing"/
 * "In Test"/"QA" all land here. A pure port of board.js `REVIEW_STATUS_RE`.
 */
private val REVIEW_STATUS_RE = Regex("\\b(review|reviewing|testing|test|qa)\\b", RegexOption.IGNORE_CASE)

fun isReviewStatus(t: JiraTicket): Boolean = REVIEW_STATUS_RE.containsMatchIn(t.status)

/**
 * An unknown/missing statusCategory lands in To Do rather than vanishing. An
 * `inprogress` ticket whose status name reads as review/testing is pulled into
 * the `review` column — only from inprogress, so a Done ("Testing complete") or
 * To Do ticket keeps its category and can't be yanked by its name alone.
 */
fun categoryOf(t: JiraTicket): String {
    val base = if (t.statusCategory == "inprogress" || t.statusCategory == "done") t.statusCategory else "todo"
    return if (base == "inprogress" && isReviewStatus(t)) "review" else base
}

/** Column card order: newest `updated` first, a port of board.js `ticketSort`. */
fun ticketSort(tickets: List<JiraTicket>): List<JiraTicket> =
    tickets.sortedByDescending { it.updated }

data class BoardSite(
    val siteKey: String,
    val site: String,
    val online: Boolean,
    val error: String?,
    val fetchedAt: String,
    val tickets: List<JiraTicket>,
    // The freshest block's manual-repo picker options (board.js repoOptions).
    val repoOptions: List<com.xerktech.turma.model.RepoOption> = emptyList(),
    // The agent-pin picker's host choices (board.js hostOptions, XERK-38):
    // every host reporting this org, online first — offline included, since a
    // pin is a persistent choice about future spawns.
    val hostOptions: List<HostOption> = emptyList(),
)

/** One org host the agent picker can pin a ticket to (board.js hostOpts entry). */
data class HostOption(val key: String, val name: String, val online: Boolean)

/**
 * The ticket's pinned host out of the hub's ticketAgents map, keyed
 * "<siteKey>/<issueKey>" — a port of board.js `agentPinOf`. Null means the
 * ticket routes automatically (most-available host).
 */
fun agentPinOf(
    ticketAgents: Map<String, com.xerktech.turma.model.TicketAgentPin>,
    siteKey: String,
    issueKey: String,
): com.xerktech.turma.model.TicketAgentPin? =
    ticketAgents["$siteKey/$issueKey"]?.takeIf { it.host.isNotBlank() }

/**
 * Org display name (board.js orgName). Two siteKey shapes:
 *   - Jira Cloud is a bare host ("myorg.atlassian.net"); strip `.atlassian.net`.
 *   - Azure DevOps carries an org/collection PATH ("dev.azure.com/myorg"); the last
 *     path segment is the readable org/collection identity.
 */
fun orgName(siteKey: String): String {
    if (siteKey.contains('/')) {
        val segs = siteKey.split('/').filter { it.isNotEmpty() }
        return segs.lastOrNull() ?: siteKey
    }
    return siteKey.replace(Regex("\\.atlassian\\.net$", RegexOption.IGNORE_CASE), "")
}

/**
 * Whether an org is opted in to auto-start, for the org-chip switch (XERK-41), a
 * pure port of board.js `autoStartOn`. Hub-only: it reads the hub-owned per-org
 * toggle (`AgentsResponse.autoStartOrgs`) and nothing else — there is no
 * agent-side flag — so a tap freely turns it on and off.
 */
fun autoStartOn(autoStartOrgs: Map<String, Boolean>, siteKey: String): Boolean =
    autoStartOrgs[siteKey] == true

fun mergeSites(agents: List<AgentInfo>): List<BoardSite> {
    // Step 1: within each (siteKey, user) group keep only the freshest block.
    data class Block(val j: com.xerktech.turma.model.JiraBlock, val online: Boolean)
    val byUser = LinkedHashMap<String, Block>()
    val reporterOnline = LinkedHashMap<String, Boolean>()
    // site -> agent key -> picker option, collected over EVERY reporting host
    // (not the freshest-block winners): the agent picker must offer the whole
    // org, exactly like the web board's hostOpts collection (XERK-38).
    val hostOpts = LinkedHashMap<String, LinkedHashMap<String, HostOption>>()
    for (a in agents) {
        val j = a.jira ?: continue
        if (j.siteKey.isBlank()) continue
        reporterOnline[j.siteKey] = (reporterOnline[j.siteKey] ?: false) || a.online
        val hk = a.key.ifBlank { a.device }
        if (hk.isNotBlank()) {
            hostOpts.getOrPut(j.siteKey) { LinkedHashMap() }[hk] =
                HostOption(hk, a.device.ifBlank { hk }, a.online)
        }
        val k = j.siteKey + "\u0000" + j.user
        val prev = byUser[k]
        if (prev == null || j.fetchedAt > prev.j.fetchedAt) byUser[k] = Block(j, a.online)
    }
    // Step 2: union users within a site, dedupe tickets by key (freshest first).
    val bySite = LinkedHashMap<String, MutableList<Block>>()
    for (b in byUser.values) bySite.getOrPut(b.j.siteKey) { mutableListOf() }.add(b)
    val out = ArrayList<BoardSite>()
    for ((site, blocks) in bySite) {
        val sorted = blocks.sortedByDescending { it.j.fetchedAt }
        val seen = HashSet<String>()
        val tickets = ArrayList<JiraTicket>()
        for (b in sorted) for (t in b.j.tickets) if (seen.add(t.key)) tickets.add(t)
        val newest = sorted.first().j
        out.add(
            BoardSite(
                siteKey = site,
                site = newest.site.ifBlank { site },
                online = reporterOnline[site] ?: false,
                error = sorted.firstNotNullOfOrNull { it.j.error },
                fetchedAt = newest.fetchedAt,
                tickets = tickets,
                repoOptions = newest.repoOptions,
                // Online hosts first (the ones a pin routes to today), then by
                // name — the picker's own order (board.js hostOptions sort).
                hostOptions = (hostOpts[site]?.values ?: emptyList())
                    .sortedWith(compareByDescending<HostOption> { it.online }.thenBy { it.name }),
            ),
        )
    }
    return out.sortedBy { it.siteKey }
}

/**
 * Persistent org color slot for a siteKey: a hash of the KEY ITSELF into one of
 * the 8 palette slots (0..7 -> ChartSeries), matching board.js `orgColor`. Keying
 * on the key rather than its index in the current org set is what makes the color
 * hold when a host (hence an org) is added or removed (XERK-48); the old
 * index-in-sorted-set rule reshuffled every org's hue on any fleet change. Same
 * djb2 hash and modulo as the web, so a given org gets the identical color on both.
 */
fun orgColorIndex(siteKey: String): Int {
    var h = 5381L
    for (c in siteKey) h = (h * 33L + c.code.toLong()) and 0xFFFFFFFFL
    return (h % 8L).toInt()
}

/**
 * The board's org filter, a port of board.js `boardHtml`'s `shown`: a blank
 * filter (the "All orgs" chip) keeps every site; otherwise only the site whose
 * `siteKey` matches. A filter naming an org no longer reporting collapses to
 * "all" rather than an empty board (board.html clears a stale `orgFilter` the
 * same way), so a killed org can't strand the board on nothing.
 */
fun filterSites(sites: List<BoardSite>, filter: String): List<BoardSite> {
    if (filter.isBlank() || sites.none { it.siteKey == filter }) return sites
    return sites.filter { it.siteKey == filter }
}
