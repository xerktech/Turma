package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.CreateMetaEnvelope
import com.xerktech.turma.model.CreateProject
import com.xerktech.turma.model.CreateResultEnvelope
import com.xerktech.turma.model.CreateType
import com.xerktech.turma.model.JiraIssueDetail
import com.xerktech.turma.model.JiraIssueEnvelope
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

// --- drag-and-drop status change (XERK-141) ----------------------------------
// Dragging a card into another column changes the ticket's status: the drop
// POSTs the target COLUMN (the card never loaded the ticket's transitions — the
// agent resolves it to a real status against a fresh read) and polls the queued
// command's outcome. Meanwhile an optimistic [MoveState] override lands the card
// in the dropped column across fleet beats until the board's own Jira/Azure poll
// reports it there — else it would snap back (the same lag the detail sheet has).
// A pure port of board.js boardColumnOf / moveSweepVerdict.

/**
 * An in-flight/just-landed drag override, keyed "<siteKey> <issueKey>" like
 * [StartState]. `pending` -> POST/poll in flight; `settled` -> landed, held
 * until the poll catches up; `error` -> failed, shown briefly then reverted.
 */
data class MoveState(
    val category: String,
    val pending: Boolean = false,
    val settled: Boolean = false,
    val settledAt: Long = 0,
    val error: String? = null,
    val at: Long = 0,
)

/** The column a card renders in: its real category, unless a live drag override
 *  pins it to the dropped column meanwhile — through BOTH the in-flight `pending`
 *  state AND the `settled` state after it (the change landed on the tracker but
 *  the board's slow poll hasn't reported the new status, so `categoryOf` still
 *  reads the OLD column). Honouring `pending` alone snapped a just-moved card
 *  back until the next poll; the sweep clears the override only once the poll has
 *  caught up (moveSweepVerdict), so the card never moves backward. */
fun boardColumnOf(t: JiraTicket, move: MoveState?): String =
    if (move != null && (move.pending || move.settled) && move.error == null) move.category else categoryOf(t)

/**
 * The per-beat sweep verdict for a drag override (board.js `moveSweepVerdict`):
 *   pending -> HOLD  (the POST/poll loop owns it);
 *   settled -> CLEAR once the board poll reports the ticket in the new column
 *              (realCat catches up) or after `settleMs` (backstop), else HOLD;
 *   error   -> HOLD briefly, then CLEAR (which reverts the card).
 */
fun moveSweepVerdict(move: MoveState, realCat: String, now: Long, settleMs: Long, errorTtlMs: Long): SweepVerdict {
    if (move.error != null) return if (now - move.at > errorTtlMs) SweepVerdict.CLEAR else SweepVerdict.HOLD
    if (move.settled) {
        if (realCat == move.category) return SweepVerdict.CLEAR
        return if (now - (if (move.settledAt != 0L) move.settledAt else move.at) > settleMs)
            SweepVerdict.CLEAR else SweepVerdict.HOLD
    }
    return SweepVerdict.HOLD
}

data class BoardSite(
    val siteKey: String,
    val site: String,
    // The freshest block's org-label override (board.js mergeSites `orgName`);
    // "" means the label derives from the siteKey.
    val orgName: String = "",
    // Which tracker this org is ("jira" | "azure"), off the freshest block — the
    // New-ticket form words its label field and splits labels from it (XERK-137).
    val source: String = "jira",
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
    // The org's probed model list + what "Default" resolves to (board.js
    // `models`, XERK-123): the ticket model picker's options, unioned across the
    // org's hosts, freshest default label winning.
    val models: BoardModels = BoardModels(),
)

/** One org host the agent picker can pin a ticket to (board.js hostOpts entry). */
data class HostOption(val key: String, val name: String, val online: Boolean)

/** The org's model options for the ticket model picker (board.js BoardSite.models). */
data class BoardModels(val available: List<String> = emptyList(), val defaultLabel: String = "")

/**
 * The ticket's pinned model out of the hub's ticketModels map, keyed
 * "<siteKey>/<issueKey>" — a port of board.js `modelPinOf`. Null means the
 * ticket runs the login's default model.
 */
fun modelPinOf(
    ticketModels: Map<String, com.xerktech.turma.model.TicketModelPin>,
    siteKey: String,
    issueKey: String,
): com.xerktech.turma.model.TicketModelPin? =
    ticketModels["$siteKey/$issueKey"]?.takeIf { it.model.isNotBlank() }

/**
 * The curated aliases the model picker offers besides "Default", filtered to what
 * the org probed — a port of board.js `modelChoices`. The bracketed "[1m]" alias
 * is never offered (it's a live-switch affordance the spawn command rejects); an
 * org with no probe yet falls back to the static family set.
 */
val MODEL_MENU_ALIASES = listOf("opus", "fable", "sonnet", "haiku")
fun modelChoices(models: BoardModels): List<String> {
    val avail = models.available
    if (avail.isEmpty()) return MODEL_MENU_ALIASES
    return MODEL_MENU_ALIASES.filter { it in avail }
}

/**
 * Human form of a model signal — a port of board.js `prettyModel`. An alias
 * ("opus") capitalizes; a raw claude-* id is parsed (family word, dotted
 * version, trailing datestamp dropped, "[1m]" -> " 1M").
 */
fun prettyModel(v: String): String {
    var s = v.trim()
    if (s.isEmpty()) return ""
    if (!s.startsWith("claude-", ignoreCase = true)) {
        return s.replaceFirstChar { it.uppercase() }
    }
    val oneM = Regex("\\[1m\\]$", RegexOption.IGNORE_CASE).containsMatchIn(s)
    s = s.replaceFirst(Regex("^claude-", RegexOption.IGNORE_CASE), "")
        .replaceFirst(Regex("\\[1m\\]$", RegexOption.IGNORE_CASE), "")
    val words = ArrayList<String>()
    val nums = ArrayList<String>()
    for (p in s.split("-").filter { it.isNotEmpty() }) {
        if (Regex("^\\d{8}$").matches(p)) continue          // datestamp, not a version
        if (Regex("^\\d+$").matches(p)) nums.add(p)
        else words.add(p.replaceFirstChar { it.uppercase() })
    }
    val name = words.joinToString(" ") + (if (nums.isNotEmpty()) " " + nums.joinToString(".") else "")
    return (name.ifBlank { v }) + (if (oneM) " 1M" else "")
}

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
 * Whether the Status row can offer a change (XERK-138) — a port of board.js
 * `canChangeStatus`. The status write rides the heartbeat command path, so it
 * needs an ONLINE host to deliver it AND the fetched detail's `statusOptions`
 * (the board's own list of what the ticket can move to); an offline org's ticket
 * is still readable, just not changeable.
 */
fun statusChangeable(online: Boolean, options: List<com.xerktech.turma.model.StatusOption>): Boolean =
    online && options.isNotEmpty()

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
    // The org's model options (XERK-123): a union of probed aliases + the freshest
    // probe's default label. Collected over EVERY reporting host, like hostOpts.
    val modelAvail = LinkedHashMap<String, LinkedHashSet<String>>()
    val modelDefault = LinkedHashMap<String, Pair<String, String>>()  // site -> (at, defaultLabel)
    for (a in agents) {
        val j = a.jira ?: continue
        if (j.siteKey.isBlank()) continue
        reporterOnline[j.siteKey] = (reporterOnline[j.siteKey] ?: false) || a.online
        val hk = a.key.ifBlank { a.device }
        if (hk.isNotBlank()) {
            hostOpts.getOrPut(j.siteKey) { LinkedHashMap() }[hk] =
                HostOption(hk, a.device.ifBlank { hk }, a.online)
        }
        a.models?.let { mb ->
            val set = modelAvail.getOrPut(j.siteKey) { LinkedHashSet() }
            for (m in mb.available) if (m.isNotBlank() && m != "default") set.add(m)
            val cur = modelDefault[j.siteKey]
            if (cur == null || mb.at >= cur.first) modelDefault[j.siteKey] = mb.at to mb.defaultLabel
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
                source = newest.source.ifBlank { "jira" },
                online = reporterOnline[site] ?: false,
                error = sorted.firstNotNullOfOrNull { it.j.error },
                fetchedAt = newest.fetchedAt,
                tickets = tickets,
                repoOptions = newest.repoOptions,
                // Online hosts first (the ones a pin routes to today), then by
                // name — the picker's own order (board.js hostOptions sort).
                hostOptions = (hostOpts[site]?.values ?: emptyList())
                    .sortedWith(compareByDescending<HostOption> { it.online }.thenBy { it.name }),
                models = BoardModels(
                    available = (modelAvail[site]?.toList() ?: emptyList()).sorted(),
                    defaultLabel = modelDefault[site]?.second ?: "",
                ),
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
 * A manual pin's 0-based slot for a key, validated: only a wire value 1..8 from
 * the hub's orgColors map counts (a malformed value reads as unpinned). The
 * port of board.js `orgSlotPin`.
 */
fun orgSlotPin(pins: Map<String, Int>, key: String): Int? =
    pins[key]?.takeIf { it in 1..8 }?.minus(1)

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
 *
 * [pins] (XERK-145) is the hub's manual orgColors map (siteKey -> slot 1..8): a
 * pinned org takes exactly its pinned slot — the operator's explicit choice
 * beats uniqueness, so two orgs pinned to one slot DO share it — and the
 * auto-assigned orgs probe around the pinned slots.
 */
fun orgColorMap(allKeys: List<String>, pins: Map<String, Int> = emptyMap()): Map<String, Int> {
    val keys = allKeys.filter { it.isNotEmpty() }.distinct().sorted()
    val used = BooleanArray(8)
    val map = LinkedHashMap<String, Int>()
    for (k in keys) {
        val pin = orgSlotPin(pins, k) ?: continue
        map[k] = pin
        used[pin] = true
    }
    for (k in keys) {
        if (map.containsKey(k)) continue
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
 * (uniqueness couples them) and any manual pins. Mirrors board.js `orgColor`; a
 * key absent from the set falls back to its own pinned, else preferred, slot.
 */
fun orgColorIndex(siteKey: String, allKeys: List<String>, pins: Map<String, Int> = emptyMap()): Int =
    orgColorMap(allKeys, pins)[siteKey] ?: orgSlotPin(pins, siteKey) ?: orgSlotPref(siteKey)

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

/**
 * Priority emphasis for the card's priority pill, a port of board.js
 * `prioClass`: highest/high read as urgent, low/lowest as muted, anything else
 * (or blank) neutral.
 */
enum class PrioEmphasis { HIGH, LOW, NONE }

fun prioClass(priority: String): PrioEmphasis = when (priority.trim().lowercase()) {
    "highest", "high" -> PrioEmphasis.HIGH
    "low", "lowest" -> PrioEmphasis.LOW
    else -> PrioEmphasis.NONE
}

/**
 * Whether a ticket's due date has passed, a port of board.js `overdueOf`: a
 * dueDate set, the ticket not Done, and the date (a "YYYY-MM-DD" string, so a
 * plain string compare) before today's UTC date.
 */
fun overdueOf(t: JiraTicket, nowMs: Long = System.currentTimeMillis()): Boolean {
    val due = t.dueDate ?: return false
    if (due.isBlank() || categoryOf(t) == "done") return false
    val today = java.time.Instant.ofEpochMilli(nowMs).toString().substring(0, 10)
    return due < today
}

// ---- ticket -> session link (board.js ticketSessionIndex, XERK-78) -----------
//
// The agent stamps the ticket onto the session record it spawns
// (session.ticket); this indexes the fleet payload the board already polls to
// walk that link backwards. It reads the same THREE channels the Sessions
// page's Ended list merges — a.sessions (live + stopped), a.closedSessions
// (killed), and repo.resumable (the durable transcript scan) — deduped on
// <host>\u0000<transcriptId> with the registry-backed record winning, because a
// killed session is reported through BOTH its closed record and (once the slow
// scan catches up) resumable, and only the record knows its id and rename.

/** One of a ticket's sessions, shaped channel-agnostically for its card chip. */
data class TicketSession(
    val host: String,
    /** The session's own id; "" for a resumable row (the registry never knew it). */
    val id: String,
    val transcriptId: String,
    /** running | queued | error | stopped (resumable rows read as stopped). */
    val status: String,
    /** The live git branch, "" when unknown. */
    val gitBranch: String,
    /** The branch name the ticket spawn reserved, "" when none. */
    val ticketBranch: String,
    val summary: String,
    val summaryManual: Boolean,
    val label: String,
    val ticketKey: String,
    val siteKey: String,
    val spawnCmdId: String = "",
    /** Sort key: createdAt for a record, endedTs for a resumable row. */
    val at: String = "",
)

/** The chip's run-state dot, board.js sessionChipHtml's `state`. */
fun ticketSessionState(s: TicketSession): String = when {
    s.status == "error" -> "failed"
    s.status == "queued" -> "queued"
    s.status != "running" -> "stopped"
    else -> "running"
}

/**
 * The chip's label — the BRANCH, not the session name (a ticket-spawned
 * session's name just repeats the key + summary already on the card, while the
 * branch's -1/-2 tells two sessions apart). An operator's rename leads once it
 * exists; the live branch beats the reserved one. Port of board.js
 * sessionChipHtml's precedence.
 */
fun ticketSessionLabel(s: TicketSession): String {
    val renamed = if (s.summaryManual) s.summary else ""
    val branch = s.gitBranch.ifBlank { s.ticketBranch }
    return renamed.ifBlank { branch }.ifBlank { s.summary }.ifBlank { s.label }
        .ifBlank { s.id }.ifBlank { s.ticketKey }.ifBlank { "session" }
}

private fun ticketIndexKey(siteKey: String, issueKey: String) = siteKey + "\u0000" + issueKey

/**
 * Index every session that worked a ticket, keyed "<siteKey>\u0000<issueKey>",
 * each list oldest-first (the first session holds the bare PROJ-123 branch, so
 * chips read in branch-cut order; a resumable row sorts on when its
 * conversation last spoke — the only timestamp its scan recovers).
 */
fun ticketSessionIndex(agents: List<AgentInfo>): Map<String, List<TicketSession>> {
    val idx = LinkedHashMap<String, MutableList<TicketSession>>()
    val seen = HashSet<String>()
    fun add(host: String, s: TicketSession) {
        // Untranscripted records can't collide (nothing to key on) and are rare:
        // a session killed before its first turn, or one an older agent wrote.
        if (s.transcriptId.isNotBlank() && !seen.add(host + "\u0000" + s.transcriptId)) return
        if (s.ticketKey.isBlank()) return
        idx.getOrPut(ticketIndexKey(s.siteKey, s.ticketKey)) { mutableListOf() }.add(s)
    }
    for (a in agents) {
        val host = a.key.ifBlank { a.device }
        for (s in a.sessions) {
            val t = s.ticket ?: continue
            add(host, TicketSession(
                host = host, id = s.id, transcriptId = s.transcriptId,
                status = s.status, gitBranch = s.git?.branch.orEmpty(),
                ticketBranch = t.branch.orEmpty(), summary = s.summary,
                summaryManual = false, label = s.label, ticketKey = t.key,
                siteKey = t.siteKey, spawnCmdId = s.spawnCmdId, at = s.createdAt,
            ))
        }
        for (c in a.closedSessions) {
            val t = c.ticket ?: continue
            add(host, TicketSession(
                host = host, id = c.id, transcriptId = c.transcriptId,
                status = "stopped", gitBranch = c.branch,
                ticketBranch = t.branch.orEmpty(), summary = c.summary,
                summaryManual = c.summaryManual, label = c.label, ticketKey = t.key,
                siteKey = t.siteKey, at = c.createdAt,
            ))
        }
    }
    // Resumable last, in its own pass over the whole fleet: it is the weakest
    // channel, so every registry-backed record must already be in `seen` before
    // it gets a look — else a killed session reported by a host listed later
    // would lose to its own scan entry and show up id-less.
    for (a in agents) {
        val host = a.key.ifBlank { a.device }
        for (r in a.repos) for (t in r.resumable) {
            val tk = t.ticket ?: continue
            add(host, TicketSession(
                host = host, id = "", transcriptId = t.transcriptId,
                status = "stopped", gitBranch = "",
                ticketBranch = tk.branch.orEmpty(), summary = t.summary,
                summaryManual = false, label = "", ticketKey = tk.key,
                siteKey = tk.siteKey, at = t.endedTs,
            ))
        }
    }
    for (list in idx.values) list.sortBy { it.at }
    return idx
}

fun ticketSessionsOf(
    idx: Map<String, List<TicketSession>>,
    siteKey: String,
    issueKey: String,
): List<TicketSession> = idx[ticketIndexKey(siteKey, issueKey)] ?: emptyList()

// ---- the card's start control (board.js ticketStartHtml + startSweepVerdict) --

/**
 * One ticket's in-flight start, the board's optimistic pending painted the
 * instant the button is pressed (before the POST). `sawCmd` records that the
 * command was SEEN in the host's queue — "command absent" only means "acked"
 * after that (see [startSweepVerdict]). A failure parks [error] on the ticket
 * until the next attempt.
 */
data class StartState(
    val pending: Boolean = false,
    val cmdId: String? = null,
    val host: String? = null,
    val at: Long = 0,
    val sawCmd: Boolean = false,
    val error: String? = null,
)

/** What the card's start control should render — board.js ticketStartHtml. */
sealed interface StartControl {
    /** A spawn is in flight: the "⏳ starting…" busy marker. */
    object Busy : StartControl
    /**
     * A live start button. [clone] marks the repo as not cloned anywhere (the
     * host clones on demand first); [more] compacts the label to "+" once the
     * ticket already has sessions; [error] is a failed attempt's reason,
     * rendered BESIDE the still-live button.
     */
    data class Button(val clone: Boolean, val more: Boolean, val error: String?) : StartControl
}

/**
 * The start control's state for one ticket, or null for no control at all (no
 * triaged repo: nothing to start against, and the repo chip already says why).
 * An uncloned repo still gets a LIVE button — the hub clones on demand and
 * queues the session behind the clone (XERK-14).
 */
fun ticketStartControl(t: JiraTicket, sessionCount: Int, start: StartState?): StartControl? {
    val g = t.repoGuess
    if (g?.repo == null) return null
    if (start?.pending == true) return StartControl.Busy
    return StartControl.Button(
        clone = !g.cloned,
        more = sessionCount > 0,
        error = start?.error,
    )
}

enum class SweepVerdict { HOLD, CLEAR, ERROR }

/**
 * What a start-in-flight should become, given the current fleet — a pure port
 * of board.js `startSweepVerdict`. The load-bearing subtlety is `sawCmd`:
 * "command absent" only means "acked" once the command was actually seen
 * PRESENT — a cache too stale to have seen it land reads as absent too, and
 * treating that as acked would sweep the pending the instant it was set.
 * A cmdId-less pending (POST not back yet) always holds; its own request
 * resolves it. Returns the verdict plus the state to keep on HOLD (which is
 * where a newly-seen command sets `sawCmd`).
 */
fun startSweepVerdict(
    p: StartState,
    sessions: List<TicketSession>,
    cmdPresent: Boolean,
    hostKnown: Boolean,
    ageMs: Long,
    timeoutMs: Long,
): Pair<SweepVerdict, StartState> {
    val cmdId = p.cmdId ?: return SweepVerdict.HOLD to p
    if (sessions.any { it.spawnCmdId == cmdId }) return SweepVerdict.CLEAR to p
    if (!hostKnown) return (if (ageMs > timeoutMs) SweepVerdict.ERROR else SweepVerdict.HOLD) to p
    if (cmdPresent) return SweepVerdict.HOLD to p.copy(sawCmd = true) // command still queued
    if (p.sawCmd) return SweepVerdict.CLEAR to p                      // watched it land, now drained
    return (if (ageMs > timeoutMs) SweepVerdict.ERROR else SweepVerdict.HOLD) to p
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

/**
 * One GET /api/jira/<siteKey>/<key> attempt's outcome — a pure port of
 * board.html `fetchDetail`'s per-response branch. [Pending] means the host is
 * still fetching (HTTP 202 / `{pending}`) so poll again; [Done] is terminal and
 * carries either the resolved issue or an error-bearing [JiraIssueDetail] to
 * render (never null, so the detail sheet always exits its "Loading details…"
 * spinner).
 *
 * The issue is nested under `issue` in the envelope; decoding the top-level body
 * straight into [JiraIssueDetail] silently blanks every field, which is why the
 * on-demand 200 rendered an empty sheet before XERK-83.
 */
sealed interface IssueFetch {
    object Pending : IssueFetch
    data class Done(val detail: JiraIssueDetail) : IssueFetch
}

fun classifyIssueResponse(code: Int, body: JiraIssueEnvelope?): IssueFetch = when {
    code == 202 || body?.pending == true -> IssueFetch.Pending
    body?.issue != null -> IssueFetch.Done(body.issue.copy(stale = body.stale))
    body?.error != null -> IssueFetch.Done(JiraIssueDetail(error = body.error))
    // A non-2xx (4xx/5xx) parses no body; surface the code rather than spin.
    body == null -> IssueFetch.Done(JiraIssueDetail(error = "HTTP $code"))
    else -> IssueFetch.Done(JiraIssueDetail(error = "the host reported no issue"))
}

// --- New-ticket creation (XERK-137) ------------------------------------------
// Pure ports of the board.js/board.html create flow: the 202-poll classifiers
// (like classifyIssueResponse) and the per-source label splitter.

/** The label FIELD word per source — Jira "label", Azure DevOps "tag". */
fun createLabelWord(source: String, cap: Boolean = false): String {
    val w = if (source == "azure") "tag" else "label"
    return if (cap) w.replaceFirstChar { it.uppercase() } else w
}

/**
 * Jira labels can't contain spaces, so split on commas AND whitespace; Azure tags
 * can, so split on commas only. Deduped, trimmed, capped — a port of board.html
 * `splitLabels`, matching the hub's own cap.
 */
fun splitLabels(raw: String, source: String): List<String> {
    val parts = if (source == "azure") raw.split(",") else raw.split(Regex("[,\\s]+"))
    val out = LinkedHashSet<String>()
    for (p in parts) p.trim().takeIf { it.isNotEmpty() }?.let { out.add(it) }
    return out.toList().take(20)
}

/** The project/label metadata a create-meta fetch resolves to (or is still pending). */
sealed interface CreateMetaFetch {
    object Pending : CreateMetaFetch
    data class Projects(val projects: List<CreateProject>, val labels: List<String>, val source: String) : CreateMetaFetch
    data class Types(val types: List<CreateType>) : CreateMetaFetch
    data class Error(val message: String) : CreateMetaFetch
}

/**
 * Classify a create-meta response (GET .../create-meta[?project=]). `wantTypes`
 * says which shape the caller asked for, so an empty projects/types list reads
 * correctly rather than as the other shape. Mirrors classifyIssueResponse.
 */
fun classifyCreateMeta(code: Int, body: CreateMetaEnvelope?, wantTypes: Boolean): CreateMetaFetch = when {
    code == 202 || body?.pending == true -> CreateMetaFetch.Pending
    body == null -> CreateMetaFetch.Error("HTTP $code")
    body.error != null -> CreateMetaFetch.Error(body.error)
    wantTypes -> CreateMetaFetch.Types(body.types)
    else -> CreateMetaFetch.Projects(body.projects, body.labels, body.source.ifBlank { "jira" })
}

/** The outcome of a create POST, polled by cmdId. */
sealed interface CreateResultFetch {
    object Pending : CreateResultFetch
    data class Created(
        val key: String,
        val url: String,
        val warning: String = "",
    ) : CreateResultFetch
    data class Error(val message: String) : CreateResultFetch
}

fun classifyCreateResult(code: Int, body: CreateResultEnvelope?): CreateResultFetch = when {
    code == 202 || body?.pending == true -> CreateResultFetch.Pending
    body == null -> CreateResultFetch.Error("HTTP $code")
    body.error != null -> CreateResultFetch.Error(body.error)
    !body.key.isNullOrBlank() ->
        CreateResultFetch.Created(body.key, body.url.orEmpty(), body.warning.orEmpty())
    else -> CreateResultFetch.Error("the host reported no ticket")
}
