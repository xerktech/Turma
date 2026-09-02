package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.CreateMetaEnvelope
import com.xerktech.turma.model.CreateProject
import com.xerktech.turma.model.CreateResultEnvelope
import com.xerktech.turma.model.CreateType
import com.xerktech.turma.model.JiraIssueDetail
import com.xerktech.turma.model.JiraIssueEnvelope
import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.model.QueuedTicket
import com.xerktech.turma.model.RepoOption

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
 *
 * "Resolved" is Azure DevOps' own "fixed, not yet verified" state (XERK-250),
 * which reaches the client as `inprogress`; board.js's copy carries the why.
 */
private val REVIEW_STATUS_RE =
    Regex("\\b(review|reviewing|testing|test|qa|resolved)\\b", RegexOption.IGNORE_CASE)

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

// --- Triage lane + verdict (XERK-486) ----------------------------------------
// The Triage lane is a client-side-only view ahead of To Do: untriaged To Do
// tickets (no agent triage assessment) and HELD ones. It is NOT a tracker
// category — [categoryOf] and its mirrors are untouched, and drops onto the
// lane are rejected. A live drag override always wins over the lane. Pure port
// of board.js triageActionOf / triageLaneOf.

private val TRIAGE_VERDICTS = setOf("approve", "hold", "reject")

/**
 * The operator's verdict for a ticket out of the hub's ticketTriageActions map,
 * keyed "<siteKey>/<issueKey>". A missing key or an unknown action value reads
 * as no verdict (auto).
 */
fun triageActionOf(
    actions: Map<String, com.xerktech.turma.model.TriageActionPin>,
    siteKey: String,
    issueKey: String,
): String? {
    val v = actions["$siteKey/$issueKey"] ?: return null
    return if (v.action in TRIAGE_VERDICTS) v.action else null
}

/**
 * "triage" when the ticket belongs in the client-side Triage lane — a To Do
 * ticket with no agent triage assessment yet, or one carrying a "hold" verdict.
 * Null otherwise. A live drag override is handled by the caller, which only
 * consults the lane when no override is active.
 */
fun triageLaneOf(t: JiraTicket?, action: String?): String? {
    if (t == null || categoryOf(t) != "todo") return null
    if (action == "hold") return "triage"
    if (t.triage == null) return "triage"
    return null
}

/**
 * The column a card renders in (board.js `cards[lane || boardColumnOf(t, mv)]`):
 * a live drag override wins outright, then the Triage lane, then the real
 * category.
 */
fun displayColumnOf(t: JiraTicket, move: MoveState?, action: String?): String {
    val override = move != null && (move.pending || move.settled) && move.error == null
    return if (override) move!!.category else (triageLaneOf(t, action) ?: categoryOf(t))
}

/**
 * The policy sheet's "Max auto-starts per 15 min" field: empty means the hub
 * default, otherwise a whole number in 1..50 (the web `savePolicy` bound).
 * Returns the inline error to show, or null when the value is acceptable.
 */
fun rateMaxError(s: String): String? {
    val v = s.trim()
    if (v.isEmpty()) return null
    val n = v.toIntOrNull()
    return if (n == null || n !in 1..50)
        "Max auto-starts must be a whole number between 1 and 50 (or empty for the default)"
    else null
}

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

/**
 * How far to auto-scroll the column strip this frame while a dragged card
 * hovers near its left/right edge — board.html `edgeScroll` (XERK-179): a phone
 * can't show every column, and once the long-press drag owns the gesture a
 * swipe can't scroll the strip, so the strip slides under the held card
 * instead. [x] is the pointer, [left]/[right] the strip's bounds, all in one
 * coordinate space. Speed ramps linearly from 0 at a zone's inner edge to
 * [maxStep] at the strip edge (the web scrolls a fixed step per pointermove;
 * this runs per frame, so it also scrolls while the finger holds still — the
 * gesture the ticket asks for). 0 outside the zones, or when the strip is too
 * narrow for two distinct zones.
 */
fun edgeScrollStep(x: Float, left: Float, right: Float, edge: Float, maxStep: Float): Float {
    if (edge <= 0f || right - left <= edge * 2) return 0f
    return when {
        x < left + edge -> -maxStep * ((left + edge - x) / edge).coerceAtMost(1f)
        x > right - edge -> maxStep * ((x - (right - edge)) / edge).coerceAtMost(1f)
        else -> 0f
    }
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
    // Whether ANY host reporting this org offers the dsh runtime (board.js
    // mergeSites `dshAvailable`, XERK-473): the org-level capability the Runtime
    // row's "dsh" option is gated on, so the picker can't name a runtime the hub
    // would refuse. An existing dsh pin is always releasable even when false.
    val dshAvailable: Boolean = false,
    // The qwen twin (board.js mergeSites `qwenAvailable`, XERK-515): gates the
    // Runtime row's "qwen" option. An existing qwen pin is always releasable.
    val qwenAvailable: Boolean = false,
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
 * The ticket's pinned RUNTIME out of the hub's ticketRuntimes map, keyed
 * "<siteKey>/<issueKey>" — a port of board.js `runtimePinOf` (XERK-473). Null
 * means the ticket runs the default (claude); a "claude" value is treated as no
 * pin too, matching the web (the hub only ever stores a non-default "dsh").
 */
fun runtimePinOf(
    ticketRuntimes: Map<String, com.xerktech.turma.model.TicketRuntimePin>,
    siteKey: String,
    issueKey: String,
): com.xerktech.turma.model.TicketRuntimePin? =
    ticketRuntimes["$siteKey/$issueKey"]?.takeIf { it.runtime.isNotBlank() && it.runtime != "claude" }

/** Human form of a runtime signal — a port of board.js `prettyRuntime`. */
fun prettyRuntime(v: String): String = when (v) {
    "dsh" -> "dsh (DeepSeek Harness)"
    "qwen" -> "Qwen Code"
    else -> "Claude Code"
}

/**
 * Whether the Runtime row can offer a change — a port of the web's
 * `editable: !!(o.runtimePin || o.dshAvailable || o.qwenAvailable)` (board.js
 * `runtimeFieldHtml` call site). Editable when the org offers a non-default
 * runtime OR a pin already exists, so an existing pin can always be RELEASED
 * even after the last capable host left — mirroring the hub, which still lets a
 * pin clear.
 */
fun runtimeEditable(
    dshAvailable: Boolean,
    qwenAvailable: Boolean,
    pin: com.xerktech.turma.model.TicketRuntimePin?,
): Boolean = dshAvailable || qwenAvailable || pin != null

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
    // Whether any reporting host offers the dsh runtime (XERK-473): an org-level
    // OR over every host, like the web's `if (a.dsh?.available) rep.dshAvailable`.
    val dshBySite = LinkedHashMap<String, Boolean>()
    // The qwen twin (XERK-515), `if (a.qwen?.available) rep.qwenAvailable`.
    val qwenBySite = LinkedHashMap<String, Boolean>()
    // site -> repo name -> picker option, collected over EVERY reporting host —
    // like hostOpts above, and for the same reason board.js gives: the blocks
    // that survive the byUser dedupe are one per (site, user), and the COMMON
    // case is an org whose hosts all poll as the same user. Collected in the
    // winners loop below it saw exactly one of them, so the picker offered
    // whichever host polled last and a repo cloned only on another vanished.
    val repoOptsBySite = LinkedHashMap<String, LinkedHashMap<String, RepoOption>>()
    for (a in agents) {
        val j = a.jira ?: continue
        if (j.siteKey.isBlank()) continue
        reporterOnline[j.siteKey] = (reporterOnline[j.siteKey] ?: false) || a.online
        // Gated on the fleet-wide dsh kill switch (Runtime.DSH_ENABLED): with dsh
        // disabled, `site.dshAvailable` is false everywhere so the board Runtime
        // picker isn't offered. An existing dsh pin is still carried back and
        // releasable (runtimeEditable), unchanged.
        if (Runtime.DSH_ENABLED && a.dsh?.available == true) dshBySite[j.siteKey] = true
        // The qwen twin, gated on the fleet-wide kill switch (Runtime.QWEN_ENABLED).
        if (Runtime.QWEN_ENABLED && a.qwen?.available == true) qwenBySite[j.siteKey] = true
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
        // `cloned` is host-relative and a cloned copy wins the dedupe: "someone
        // here has it" is the useful claim, and a pin fans out to every host.
        val ro = repoOptsBySite.getOrPut(j.siteKey) { LinkedHashMap() }
        for (o in j.repoOptions) {
            if (o.name.isBlank()) continue
            val seen = ro[o.name]
            if (seen == null || (o.cloned && !seen.cloned)) ro[o.name] = o
        }
        val k = j.siteKey + "\u0000" + j.user
        val prev = byUser[k]
        // An ONLINE host's block outranks any offline one, freshness deciding
        // only within a tier — the same rule `ticketRepo` applies hub-side
        // (XERK-325). The hub routes only to an online host that agrees with the
        // repo it resolved, so an offline host winning on freshness put a repo on
        // the chip that Start would never spawn against.
        if (prev == null || (a.online && !prev.online) ||
            (a.online == prev.online && j.fetchedAt > prev.j.fetchedAt)) {
            byUser[k] = Block(j, a.online)
        }
    }
    // Step 2: union users within a site, dedupe tickets by key (online, then
    // freshest, first — mirroring board.js).
    val bySite = LinkedHashMap<String, MutableList<Block>>()
    for (b in byUser.values) bySite.getOrPut(b.j.siteKey) { mutableListOf() }.add(b)
    val out = ArrayList<BoardSite>()
    for ((site, blocks) in bySite) {
        // Ticket dedupe below is by the ticket's own `updated`, which two hosts
        // polling one tracker report IDENTICALLY — so ties are the norm and this
        // order is what really decides a card's fields.
        val sorted = blocks.sortedWith(
            compareByDescending<Block> { it.online }.thenByDescending { it.j.fetchedAt })
        // Dedupe by the ticket's OWN `updated`, not by which block was fetched
        // more recently (board.js mergeSites). Two users polling one site can
        // each carry a different copy, and the freshest BLOCK is not
        // necessarily the freshest TICKET — first-wins showed the stale
        // summary and the stale column (XERK-235).
        val byKey = LinkedHashMap<String, JiraTicket>()
        for (b in sorted) for (t in b.j.tickets) {
            if (t.key.isBlank()) continue
            val seen = byKey[t.key]
            if (seen == null || t.updated > seen.updated) byKey[t.key] = t
        }
        val tickets = ArrayList(byKey.values)
        // The winning block for every single-valued field: online first, then
        // freshest — `sorted`'s own order.
        val newest = sorted.first().j
        // ...EXCEPT `fetchedAt`, which board.js takes as the MAX across the
        // winner blocks, not off the winner. The two were the same thing only
        // while the sort was freshest-first; once online outranks freshness
        // (XERK-325) the winner can be the OLDER block, and reporting its stamp
        // as the site's last-fetched understates how current the board is.
        val lastFetched = sorted.maxOfOrNull { it.j.fetchedAt }.orEmpty()
        // Unioned over every reporting host in the first loop above — see
        // repoOptsBySite for why it cannot be collected here.
        val repoOpts = repoOptsBySite[site] ?: LinkedHashMap()
        out.add(
            BoardSite(
                siteKey = site,
                site = newest.site.ifBlank { site },
                orgName = newest.orgName,
                source = newest.source.ifBlank { "jira" },
                online = reporterOnline[site] ?: false,
                error = sorted.firstNotNullOfOrNull { it.j.error },
                fetchedAt = lastFetched,
                tickets = tickets,
                // Cloned repos first (the ones you can work in today), then by
                // name — the picker's own order, so it doesn't inherit the
                // scan's (board.js).
                repoOptions = repoOpts.values
                    .sortedWith(compareByDescending<RepoOption> { it.cloned }
                        // board.js sorts with localeCompare, which is
                        // case-INSENSITIVE; ordinal compareTo put every
                        // capitalised repo ahead of every lowercase one.
                        .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }),
                // Online hosts first (the ones a pin routes to today), then by
                // name — the picker's own order (board.js hostOptions sort).
                hostOptions = (hostOpts[site]?.values ?: emptyList())
                    .sortedWith(compareByDescending<HostOption> { it.online }
                        .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }),
                models = BoardModels(
                    available = (modelAvail[site]?.toList() ?: emptyList()).sorted(),
                    defaultLabel = modelDefault[site]?.second ?: "",
                ),
                dshAvailable = dshBySite[site] ?: false,
                qwenAvailable = qwenBySite[site] ?: false,
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
/**
 * Milliseconds for an ISO-8601 timestamp the board can actually receive, or
 * null.
 *
 * `Instant.parse` alone only accepts the extended offset form (`+00:00`/`Z`),
 * but Jira Cloud stamps `updated` in the BASIC form — `2026-08-08T12:34:56.789+0000`
 * — which it rejects. `Date.parse` on the web accepts both, so every Jira
 * ticket's age chip rendered blank on Android while Azure's Zulu timestamps
 * worked, which is why Azure-only testing never saw it (XERK-235).
 *
 * Input with NO offset (`2026-08-08T12:34:56`, `2026-08-08`) deliberately
 * returns null and renders a blank chip, where the web's `Date.parse` would
 * guess the viewer's local zone. No tracker emits it — Jira Cloud and Azure
 * always stamp an offset and the agent stamps Zulu — and guessing would make
 * two phones in different zones disagree about the same ticket's age.
 */
internal fun parseIsoMs(iso: String): Long? {
    runCatching { return java.time.Instant.parse(iso).toEpochMilli() }
    return runCatching {
        java.time.OffsetDateTime
            .parse(iso, java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)
            .toInstant().toEpochMilli()
    }.getOrNull() ?: runCatching {
        // Basic-format offset (+0000 / -0500), Jira Cloud's spelling.
        java.time.OffsetDateTime.parse(
            iso,
            java.time.format.DateTimeFormatterBuilder()
                .appendPattern("yyyy-MM-dd'T'HH:mm:ss")
                .appendFraction(java.time.temporal.ChronoField.NANO_OF_SECOND, 0, 9, true)
                .appendPattern("XX")
                .toFormatter(),
        ).toInstant().toEpochMilli()
    }.getOrNull()
}

fun ageStr(iso: String, nowMs: Long = System.currentTimeMillis()): String {
    if (iso.isBlank()) return ""
    val t = parseIsoMs(iso) ?: return ""
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

/**
 * This ticket's entry in the hub's ticket queue (XERK-296), or null. Keyed on
 * org AND key, like every other ticket lookup — two orgs can share an issue key.
 */
fun queuedTicketOf(
    queue: List<QueuedTicket>?,
    siteKey: String,
    issueKey: String,
): QueuedTicket? = queue?.firstOrNull { it.siteKey == siteKey && it.issueKey == issueKey }

/**
 * The ticket queue as the cards should render it: the hub's own list, plus a
 * client's in-flight optimism over it — [adds] queued by a POST whose confirming
 * beat hasn't landed, minus [drops] cancelled by a DELETE the payload still
 * lists (both keyed like the board's start map). Pure; the ViewModel retires
 * each overlay on the beat the hub agrees, so neither can outlive the truth.
 * Mirrors board.html's queueView.
 */
fun queueView(
    hub: List<QueuedTicket>,
    adds: Map<String, QueuedTicket>,
    drops: Set<String>,
): List<QueuedTicket> =
    hub.filterNot { ticketIndexKey(it.siteKey, it.issueKey) in drops } + adds.values

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
     * The ticket is waiting in the HUB's queue for a free session slot
     * (XERK-296) — no host chosen, no session created. [position] is its place
     * in its org's line, worth showing past the first; [blocked] marks a hold
     * the operator has to clear rather than one that clears itself, with the
     * hub's wording in [reason]. The start button is REPLACED by this (a second
     * press could only re-queue what is queued), leaving the cancel as the one
     * thing that applies. [error] is a failed CANCEL's reason — the entry rolled
     * back, so the card is still the queued one and it has to render here.
     */
    data class Queued(
        val position: Int,
        val blocked: Boolean,
        val reason: String?,
        val error: String? = null,
        /**
         * Terminal: it waited as long as the hub allows and gave up. Said out
         * loud, because a queued click that simply vanished reads like someone
         * cancelling it. The ✕ dismisses the note and a live start sits beside it.
         */
        val expired: Boolean = false,
        /**
         * XERK-555: every host that could run it has its Claude 5-hour usage
         * limit maxed. Self-clearing like capacity (the window resets on its
         * own), so NOT [blocked] — it just carries its own label and message.
         */
        val paused: Boolean = false,
    ) : StartControl
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
fun ticketStartControl(
    t: JiraTicket,
    sessionCount: Int,
    start: StartState?,
    queued: QueuedTicket? = null,
): StartControl? {
    val g = t.repoGuess
    if (g?.repo == null) return null
    if (queued != null) return StartControl.Queued(
        position = queued.position,
        blocked = queued.reason == "blocked" || queued.reason == "expired",
        reason = queued.error,
        error = start?.error,
        expired = queued.reason == "expired",
        paused = queued.reason == "paused",
    )
    if (start?.pending == true) return StartControl.Busy
    return StartControl.Button(
        clone = !g.cloned,
        more = sessionCount > 0,
        error = start?.error,
    )
}

enum class SweepVerdict { HOLD, CLEAR, REFUSED, ERROR }

/**
 * What a start-in-flight should become, given the current fleet — a pure port
 * of board.js `startSweepVerdict`. The load-bearing subtlety is `sawCmd`:
 * "command absent" only means "acked" once the command was actually seen
 * PRESENT — a cache too stale to have seen it land reads as absent too, and
 * treating that as acked would sweep the pending the instant it was set.
 * A cmdId-less pending (POST not back yet) always holds; its own request
 * resolves it. Returns the verdict plus the state to keep on HOLD (which is
 * where a newly-seen command sets `sawCmd`).
 *
 * [refusal] is this cmdId's entry in the host's `spawnRefusals` (XERK-265), the
 * agent's own word that it declined the spawn. Checked AFTER the landed-session
 * test, so a spawn that actually came up always wins the tie, and BEFORE the
 * sawCmd/timeout rules, which only ever guess at what a drained command meant:
 * without it a refused start CLEARED silently, which is byte-for-byte what a
 * start that worked looks like, and the operator simply pressed it again
 * (XERK-325). Null means "can't tell" — an older hub serves no refusals and an
 * older agent stages none — so the timing rules below stay exactly as they were.
 */
fun startSweepVerdict(
    p: StartState,
    sessions: List<TicketSession>,
    cmdPresent: Boolean,
    hostKnown: Boolean,
    ageMs: Long,
    timeoutMs: Long,
    refusal: String? = null,
): Pair<SweepVerdict, StartState> {
    val cmdId = p.cmdId ?: return SweepVerdict.HOLD to p
    if (sessions.any { it.spawnCmdId == cmdId }) return SweepVerdict.CLEAR to p
    if (refusal != null) return SweepVerdict.REFUSED to p
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
// The value is a SET of full siteKeys (what the hub keys and routes on), never
// display org names; an empty set means every org. Multi-select per XERK-222:
// any subset of orgs can be selected at once.

/**
 * The org a host belongs to. A host with no tracker creds reports no jira block
 * and belongs to no org — so it shows under "All orgs" and under none of the
 * named ones, which is the truth about it.
 */
fun siteKeyOf(agent: AgentInfo): String = agent.jira?.siteKey.orEmpty()

/**
 * The fleet, scoped to the selected orgs (an empty set = every org).
 * Deliberately NOT [filterSites]'s fallback ("an unknown filter shows
 * everything") — that rule is about a site list, and here the caller has
 * already resolved the selection through [effectiveOrgs], which is where a
 * stale pick self-heals.
 */
fun filterAgents(agents: List<AgentInfo>, keys: Set<String>): List<AgentInfo> =
    if (keys.isEmpty()) agents else agents.filter { siteKeyOf(it) in keys }

/**
 * The stored selection as it APPLIES right now. Each key only counts while
 * some host still reports that org — an org whose last agent was removed must
 * not leave every screen filtered down to nothing with no way back. The stored
 * value is KEPT by the caller (a host that comes back resumes its filter);
 * a key just doesn't apply while nothing reports it.
 */
fun effectiveOrgs(keys: Set<String>, sites: List<BoardSite>): Set<String> =
    keys.filterTo(mutableSetOf()) { k -> sites.any { it.siteKey == k } }

/**
 * The one call site every screen uses: the beat's fleet scoped to the stored
 * selection, self-heal included. Keeps the self-heal in one tested place
 * rather than once per screen.
 */
fun scopedAgents(agents: List<AgentInfo>, stored: Set<String>): List<AgentInfo> =
    filterAgents(agents, effectiveOrgs(stored, mergeSites(agents)))

/**
 * Spend from hosts the hub no longer has (`retiredUsage`, XERK-338), scoped by
 * the same pick.
 *
 * The self-heal keys come from the LIVE fleet, never from the retired list —
 * that is org.js's rule (`TurmaOrg.update(data)` builds `sites` from
 * `data.agents`, and `filter` then applies those keys to whatever list it is
 * handed), and the two must agree. Passing the retired list to `scopedAgents`
 * instead computes the self-heal from the retired hosts' OWN orgs, which is a
 * different rule in both directions: a scope naming an org no live host reports
 * stops self-healing away (so the screen shows only that org's removed spend
 * where the web shows everything), and a scope naming a live org self-heals to
 * "all" over the retired list (so the screen adds OTHER orgs' removed spend to
 * a scoped total — the damaging half). Nothing in the types catches it: both
 * are `List<AgentInfo>`.
 */
fun scopedRetired(
    retired: List<AgentInfo>,
    live: List<AgentInfo>,
    stored: Set<String>,
): List<AgentInfo> = filterAgents(retired, effectiveOrgs(stored, mergeSites(live)))

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
 * The board's org filter, a port of board.js `boardHtml`'s `shown`: an empty
 * selection (the "All orgs" row) keeps every site; otherwise the sites whose
 * `siteKey` is selected. Keys naming orgs no longer reporting are ignored, and
 * a selection with NO reporting org left collapses to "all" rather than an
 * empty board (board.html clears a stale `orgFilter` the same way), so a
 * killed org can't strand the board on nothing.
 */
fun filterSites(sites: List<BoardSite>, filter: Set<String>): List<BoardSite> {
    val eff = filter.filterTo(mutableSetOf()) { k -> sites.any { it.siteKey == k } }
    if (eff.isEmpty()) return sites
    return sites.filter { it.siteKey in eff }
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

/**
 * Whether closing the create form now would throw away typed work (XERK-218):
 * one of the text fields holds something and no ticket has been created yet.
 * The created screen is never dirty — the ticket exists, so nothing typed is
 * lost. Port of newticket.js `createDirty`; a dirty close must raise a discard
 * confirmation instead of dismissing.
 */
fun createDirty(summary: String, description: String, labels: String, created: Boolean): Boolean =
    !created && (summary.isNotBlank() || description.isNotBlank() || labels.isNotBlank())

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
