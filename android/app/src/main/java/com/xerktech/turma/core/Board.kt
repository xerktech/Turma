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
    // The freshest block's org-label override (board.js mergeSites `orgName`);
    // "" means the label derives from the siteKey.
    val orgName: String = "",
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
 *
 * `override` is the agent's own BOARD_ORG_NAME (block/site `orgName`) and wins
 * outright when set: a self-hosted Azure collection derives to its COLLECTION
 * name, a deployment detail rather than the org. Label only — the siteKey
 * everything is keyed and routed on is untouched.
 */
fun orgName(siteKey: String, override: String = ""): String {
    val o = override.trim()
    if (o.isNotEmpty()) return o
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
                orgName = newest.orgName,
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

/** djb2 hash of a siteKey -> its preferred palette slot (0..7). */
private fun orgSlotPref(siteKey: String): Int {
    var h = 5381L
    for (c in siteKey) h = (h * 33L + c.code.toLong()) and 0xFFFFFFFFL
    return (h % 8L).toInt()
}

/**
 * Assign every org a UNIQUE color slot (0..7 -> ChartSeries), no two sharing —
 * a port of board.js `orgColorMap` (XERK-48). Uniqueness couples the orgs, so
 * it takes the whole set: each org takes its djb2-preferred slot if free, else
 * linear-probes to the next free one, keys processed in sorted order so the
 * result is deterministic and order-independent. Unique up to 8 orgs (the
 * palette's size); a larger fleet can't be collision-free, so overflow orgs fall
 * back to their preferred (then possibly shared) slot. Persistent where it can
 * be — an org keeps its color as the fleet changes unless its preferred slot
 * actually collides, and even then only the colliding orgs move.
 */
fun orgColorMap(allKeys: List<String>): Map<String, Int> {
    val keys = allKeys.filter { it.isNotEmpty() }.distinct().sorted()
    val used = BooleanArray(8)
    val map = LinkedHashMap<String, Int>()
    for (k in keys) {
        val pref = orgSlotPref(k)
        var slot = -1
        for (step in 0 until 8) {
            val cand = (pref + step) % 8
            if (!used[cand]) { slot = cand; break }
        }
        if (slot < 0) slot = pref else used[slot] = true
        map[k] = slot
    }
    return map
}

/**
 * The palette slot a single org paints, given every org it shares the board with
 * (uniqueness couples them). Mirrors board.js `orgColor`; a key absent from the
 * set falls back to its own preferred slot.
 */
fun orgColorIndex(siteKey: String, allKeys: List<String>): Int =
    orgColorMap(allKeys)[siteKey] ?: orgSlotPref(siteKey)

/**
 * Relative age of an ISO timestamp ("now"/"5m"/"3h"/"2d"/"1w"), a port of
 * board.js `ageStr`. Blank for a missing/unparseable stamp, so a caller can
 * append it or not without a null dance.
 */
fun ageStr(iso: String, nowMs: Long = System.currentTimeMillis()): String {
    if (iso.isBlank()) return ""
    val t = runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull() ?: return ""
    val s = ((nowMs - t) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h"
        s < 86400 * 7 -> "${s / 86400}d"
        else -> "${s / (86400 * 7)}w"
    }
}

// ---- the fleet-wide org filter (XERK-62), a port of turma/public/org.js ------
//
// The org pick used to scope the board alone; it now lives in the shared header
// and scopes every screen. Since a host polls exactly ONE org (an agent-side
// rule), an org IS a partition of the fleet — so the same pick that filters
// tickets filters hosts, sessions and usage, by filtering the agent list once.
// The value is a full siteKey (what the hub keys and routes on), never the
// display org name; "" means every org.

/**
 * The org a host belongs to. A host with no tracker creds reports no jira block
 * and belongs to no org — so it shows under "All orgs" and under none of the
 * named ones, which is the truth about it.
 */
fun siteKeyOf(agent: AgentInfo): String = agent.jira?.siteKey.orEmpty()

/**
 * The fleet, scoped to one org. Deliberately NOT [filterSites]'s fallback
 * ("an unknown filter shows everything") — that rule is about a site list, and
 * here the caller has already resolved the key through [effectiveOrg], which is
 * where a stale pick self-heals.
 */
fun filterAgents(agents: List<AgentInfo>, key: String): List<AgentInfo> =
    if (key.isBlank()) agents else agents.filter { siteKeyOf(it) == key }

/**
 * The stored pick as it APPLIES right now. It only counts while some host still
 * reports that org — an org whose last agent was removed must not leave every
 * screen filtered down to nothing with no way back. The stored value is KEPT by
 * the caller (a host that comes back resumes its filter); it just doesn't apply
 * while nothing reports it.
 */
fun effectiveOrg(key: String, sites: List<BoardSite>): String =
    if (key.isNotBlank() && sites.any { it.siteKey == key }) key else ""

/**
 * The one call site every screen uses: the beat's fleet scoped to the stored
 * pick, self-heal included. Keeps the self-heal in one tested place rather than
 * once per screen.
 */
fun scopedAgents(agents: List<AgentInfo>, stored: String): List<AgentInfo> =
    filterAgents(agents, effectiveOrg(stored, mergeSites(agents)))

/**
 * The org pick to persist on first read, migrating the board-only preference
 * (`turma_board`/`org`) into the fleet-wide one — an operator's existing board
 * filter carries into the new global control rather than silently resetting to
 * "all orgs" on upgrade. Mirrors org.js's `turma-board-org` → `turma-org`
 * migration; null means "nothing stored either way".
 */
fun storedOrg(current: String?, legacy: String?): String? =
    current ?: legacy?.takeIf { it.isNotBlank() }

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
