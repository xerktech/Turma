package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.Attention
import com.xerktech.turma.model.LiveAgent
import com.xerktech.turma.model.LiveSignals
import com.xerktech.turma.model.PrInfo
import com.xerktech.turma.model.SessionInfo
import kotlin.math.max

/**
 * Session state derivation — a pure port of glasses/src/sessions.ts + the hub's
 * sessionWorking() (turma/server.js). Kept in Kotlin so the UI and any tests
 * agree on working/idle/waiting exactly as the web + glasses clients do.
 */

private const val WORKING_WINDOW_MS = 90_000L

/** Mirrors the hub's OFFLINE_AFTER_MS (turma/server.js): beats arrive every ~20s. */
private const val OFFLINE_AFTER_MS = 75_000L

/**
 * Is this session actively working? paneBusy is authoritative; else freshness.
 *
 * Two rules the web applies and this did not (XERK-235), in the web's own
 * order (`liveState`, sessions.html):
 *  - no transcript yet is IDLE, decided BEFORE paneBusy is consulted;
 *  - working requires the HOST to be online. paneBusy is a value on a record
 *    the host last pushed, so a host that dies mid-turn leaves `paneBusy:true`
 *    behind and its session read WORKING forever — which also kept it out of
 *    Ready for review, where a dead host's unfinished work belongs.
 */
fun sessionWorking(session: SessionInfo, agentLastSeen: Long, now: Long): Boolean {
    val s = session.session ?: return false
    val age = s.transcriptAgeSec ?: return false
    // `host.online` on the web, computed the same way the hub does — derived
    // here rather than threaded through every call site so the rule cannot be
    // forgotten at one of them.
    if (now - agentLastSeen >= OFFLINE_AFTER_MS) return false
    // Background agents are what paneBusy cannot see (XERK-245): a session that
    // delegated work and ended its own turn paints no interrupt hint, so it read
    // idle while an agent was still running — and qualified as Ready for review,
    // buzzing the phone mid-run. Behind the offline gate for the same reason
    // paneBusy is: this too is a value on the record a host last pushed.
    //
    // Only WORK rows count (XERK-1570): a background shell that is a sleep or a
    // CI watch is the session WAITING, and must not keep it "working" forever.
    if (hasLiveWork(s)) return true
    s.paneBusy?.let { return it }
    // Every live row is a wait: waiting, not working — whatever freshness says.
    if (hasLiveAgents(s)) return false
    return (age * 1000).toLong() + max(0, now - agentLastSeen) < WORKING_WINDOW_MS
}

/**
 * Does this session have background agents in flight? Older agents report none,
 * which reads as "can't tell" and leaves the paneBusy behaviour untouched.
 */
fun hasLiveAgents(s: LiveSignals?): Boolean = !(s?.agents.isNullOrEmpty())

/** A background row that is WAITING (XERK-1570); no kind (an agent row, an older agent) is work. */
fun isWaitAgent(a: LiveAgent): Boolean = a.kind == "wait-timed" || a.kind == "wait-external"

/** Does this session have background WORK in flight — any row that is not a wait? */
fun hasLiveWork(s: LiveSignals?): Boolean = s?.agents.orEmpty().any { !isWaitAgent(it) }

/** The hub's ATTENTION_WAIT_STALL_MIN default and its ETA grace (turma/server.js). */
private const val WAIT_STALL_MS = 45 * 60_000L
private const val WAIT_ETA_GRACE_MS = 2 * 60_000L

/** A session's background wait: [stalled] once past its ETA or silent too long; [eta] epoch ms. */
data class BackgroundWait(val stalled: Boolean, val eta: Long?)

/**
 * Mirror of the hub's `backgroundWait` (turma/server.js): null with no wait rows;
 * an ETA still ahead is waiting; past it (plus grace) with no transcript write
 * since, or silent [WAIT_STALL_MS] with no ETA ahead, is stalled.
 */
fun backgroundWait(rows: List<LiveAgent>, lastWrite: Long, now: Long): BackgroundWait? {
    val waits = rows.filter(::isWaitAgent)
    if (waits.isEmpty()) return null
    val eta = waits.mapNotNull { it.eta }.maxOrNull()
    if (eta != null && eta > now) return BackgroundWait(stalled = false, eta = eta)
    val overdue = eta != null && lastWrite < eta && now - eta >= WAIT_ETA_GRACE_MS
    val silent = now - lastWrite >= WAIT_STALL_MS
    return BackgroundWait(stalled = overdue || silent, eta = eta)
}

/** The hub's `sessionWait`: the wait read for a live, online, not-working session. */
fun sessionWait(session: SessionInfo, agentLastSeen: Long, now: Long): BackgroundWait? {
    val s = session.session ?: return null
    val age = s.transcriptAgeSec ?: return null
    if (now - agentLastSeen >= OFFLINE_AFTER_MS) return null
    if (hasLiveWork(s) || s.paneBusy == true) return null
    return backgroundWait(s.agents, agentLastSeen - (age * 1000).toLong(), now)
}

/** "45s" / "12m" / "1h 5m" / "2d" — the web's `ago()` buckets without "ago". */
fun waitLeftText(ms: Long): String {
    val s = max(0L, ms / 1000)
    return when {
        s < 60 -> "${s}s"
        s < 3600 -> "${s / 60}m"
        s < 86400 -> "${s / 3600}h ${(s % 3600) / 60}m"
        else -> "${s / 86400}d"
    }
}

/**
 * HOLDING (XERK-1570): every live background row is a WAITING shell — not working,
 * and not the operator's yet. A STALLED wait reads IDLE, so a dead shell surfaces
 * in Ready for review like any finished session.
 */
enum class LiveState { WORKING, IDLE, WAITING, HOLDING, STOPPED }

fun liveState(session: SessionInfo, agentLastSeen: Long, now: Long): LiveState = when {
    session.status != "running" -> LiveState.STOPPED
    (session.session?.question ?: "").isNotBlank() -> LiveState.WAITING
    sessionWorking(session, agentLastSeen, now) -> LiveState.WORKING
    // Asleep until a session-CLI wake (XERK-1571): holding, never Ready for review.
    sessionSleeping(session, now) -> LiveState.HOLDING
    sessionWait(session, agentLastSeen, now)?.stalled == false -> LiveState.HOLDING
    else -> LiveState.IDLE
}

/** A session-CLI wake still in the future (XERK-1571) — the hub's `sessionSleeping`. */
fun sessionSleeping(session: SessionInfo, now: Long): Boolean = (session.session?.wakeAt ?: 0L) > now

/** "14:05" — the local wall-clock time a sleeping session wakes at. */
fun clockTime(ms: Long): String {
    val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    return String.format(
        java.util.Locale.ROOT, "%02d:%02d",
        c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE),
    )
}

/** The chip word for a `needs-you:*` attention state (XERK-1571), else null. */
fun needsYouChip(state: String): String? = when (state) {
    "needs-you:question" -> "question"
    "needs-you:permission" -> "permission"
    "needs-you:review" -> "review"
    "needs-you:test" -> "test"
    "needs-you:stalled" -> "stalled"
    else -> null
}

/**
 * Does the hub say this running session waits on the operator (XERK-1571, web
 * index.html `needsYou`)? Read off the served [SessionInfo.attention], never
 * re-derived, so it agrees with the phone's alerts. The dashboard's Ready-for-review
 * tile counts these; an older hub serves none, so it counts nothing.
 */
fun needsYou(session: SessionInfo): Boolean =
    session.status == "running" && needsYouChip(session.attention?.state ?: "") != null

/**
 * Is this running session in the Sessions screen's Ready for review group
 * (XERK-1571, web sessions.html `inReview`)? Where the hub serves an attention
 * state it decides: every `needs-you:*` session is listed (question, permission,
 * review, stalled) and nothing else, so the group is the set the dashboard tile
 * counts. From an older hub (no attention) the local [readyForReview] port decides.
 */
fun inReview(session: SessionInfo, state: LiveState): Boolean {
    val att = session.attention?.state.orEmpty()
    if (att.isNotEmpty()) return needsYouChip(att) != null
    return readyForReview(session, state)
}

/**
 * How long the hub says a needs-you session has waited, for a fleet card's State
 * row (XERK-1571, web index.html `attentionFor`): "for 31m" off the attention
 * `since` — the ONE age a stalled card shows. "" when there is none.
 */
fun attentionFor(att: Attention?, now: Long): String {
    val since = att?.since ?: return ""
    if (needsYouChip(att.state) == null) return ""
    return "for ${waitLeftText(now - since)}"
}

/**
 * Ready for review, oldest-waiting first by the hub's attention `since`
 * (XERK-1571, web sessions.html `bySince`). A row with no `since` (an older hub)
 * keeps its place after them — `sortedWith` is stable.
 */
fun <T> sortedBySince(rows: List<T>, attention: (T) -> Attention?): List<T> =
    rows.sortedWith(compareBy<T, Long?>(nullsLast<Long>()) { attention(it)?.since })

/**
 * A review card's second line (XERK-1571, web sessions.html `attentionWhy`): WHY
 * the session is the operator's and how long it has waited. Unlike the web card,
 * the phone card carries no state label or quoted question, so the why is kept for
 * every needs-you state (the question text, the wait, the PR). The time reads
 * "stalled 31m" on a stall, "for 22m" on a question/permission (no second
 * "waiting"), else "waiting 12m". "" when the hub serves none.
 */
fun attentionWhy(att: Attention?, now: Long): String {
    if (att == null || needsYouChip(att.state) == null) return ""
    val bits = ArrayList<String>()
    att.why?.takeIf { it.isNotBlank() }?.let { bits.add(it) }
    att.since?.let {
        val word = when (att.state) {
            "needs-you:stalled" -> "stalled"
            "needs-you:question", "needs-you:permission" -> "for"
            else -> "waiting"
        }
        bits.add("$word ${waitLeftText(now - it)}")
    }
    return bits.joinToString(" · ")
}

/**
 * A fleet card's State row for a session the hub says needs the operator (XERK-1571,
 * web index.html `attentionLabel`): "review · PR open · CI passing", "awaiting your
 * test · PR open", "stalled · Watch CI", "waiting for your answer", "waiting for your
 * permission". Null when it
 * doesn't — the card then keeps its own live-state word. Used where that word would
 * be "idle", so a session Ready for review lists never reads idle on its own card.
 */
fun attentionLabel(att: Attention?): String? {
    if (att == null) return null
    val chip = needsYouChip(att.state) ?: return null
    if (chip == "question") return "waiting for your answer"
    if (chip == "permission") return "waiting for your permission"
    // A review the classifier says needs a human TEST (XERK-1572) reads as one,
    // not as a bare "test" chip word — the web dashboard and Sessions headline.
    val word = if (chip == "test") "awaiting your test" else chip
    return listOf(word, att.why.orEmpty()).filter { it.isNotBlank() }.joinToString(" · ")
}

/** Does the hub say this session has STALLED on a background wait (XERK-1571)? */
fun attentionStalled(att: Attention?): Boolean = att?.state == "needs-you:stalled"

/** The wait classifier's label as a card reads it (XERK-1572, web `HINT_KIND`). */
fun hintKind(label: String): String = when (label) {
    "rubber-stamp" -> "go-ahead"
    "design-decision" -> "decision"
    "needs-human-test" -> "needs a human test"
    "blocked-on-host" -> "blocked on the host"
    "looping" -> "looping"
    "waiting-external" -> "waiting on something outside"
    else -> ""
}

/**
 * The wait classifier's why on a needs-you card (XERK-1572, web sessions.html
 * `.att-hint`): "decision · Pick schema v2 or v3". "" when the hub serves no
 * verdict, or the session no longer needs the operator.
 */
fun attentionHintLine(att: Attention?): String {
    if (att == null || needsYouChip(att.state) == null) return ""
    val h = att.hint ?: return ""
    if (h.why.isBlank()) return ""
    val kind = hintKind(h.label)
    return if (kind.isEmpty()) h.why else "$kind · ${h.why}"
}

/** The answer the classifier suggests, as "Suggested: …" (XERK-1572), or "". */
fun attentionSuggested(att: Attention?): String {
    if (attentionHintLine(att).isEmpty()) return ""
    val a = att?.hint?.suggestedAnswer?.takeIf { it.isNotBlank() } ?: return ""
    return "Suggested: $a"
}

/**
 * Has this PR left the operator's plate? MERGED/CLOSED are the two end states;
 * everything else — OPEN, DRAFT, and an unfetched/unknown state — counts as
 * still live. An unreadable state must never be what drops work off the review
 * list. Mirrors the web (sessions.html / server.js `prLanded`).
 */
fun prLanded(p: PrInfo): Boolean = p.state.uppercase().let { it == "MERGED" || it == "CLOSED" }

/**
 * "Ready for review" (XERK-224): a running session that has stopped and is now
 * waiting on the OPERATOR rather than on itself — the Sessions list's own
 * section, above Active, because a working session is one to leave alone and
 * this is the work to look at. A pure port of the web's `readyForReview`
 * (turma/public/sessions.html), which the hub's ready-for-review alert mirrors
 * again (turma/server.js) — all three have to agree on what the group means.
 *
 * Derived from the signals alone; there is no "I've reviewed this" action, so a
 * qualifying session stays listed until it runs again or its PR lands. Three
 * qualifiers, deliberately generous — the case a PR-only rule misses is a
 * research task that finished with an answer and never opened one:
 *
 *  - waiting on a human (a pending question), which qualifies whatever the busy
 *    read says, and leads the section;
 *  - a PR that hasn't landed — there is a diff to read;
 *  - a finished turn: the newest transcript entry is plain assistant output with
 *    no tool call pending, the only trace a no-PR task leaves behind.
 *
 * Every PR merged or closed IS the review, so it stops being a reason to look
 * and the session falls back to Idle — where work that is merged but not yet
 * verified against a build is parked. That demotion is scoped in TIME, never
 * absolute: a session is a conversation, not a pull request, and handing the
 * same one a new task after the merge must not be hidden by the PR it already
 * shipped. See [SessionInfo.newWorkSincePrs].
 */
fun readyForReview(session: SessionInfo, state: LiveState): Boolean {
    if (state == LiveState.WAITING) return true      // blocked on you either way
    if (state != LiveState.IDLE) return false        // working, holding, or not live at all
    val sig = session.session ?: return false
    val prs = session.prs
    if (prs.any { !prLanded(it) }) return true      // an unlanded PR is a diff to read
    // Landed PRs stop being a reason to look, but must not become a reason NOT
    // to: the same session can be given a new task after the merge and would
    // otherwise be hidden for good. The demotion expires once the conversation
    // moves past the landing ([SessionInfo.newWorkSincePrs], XERK-224).
    if (prs.isNotEmpty() && !session.newWorkSincePrs) return false
    return sig.lastRole == "assistant" && !sig.lastHasToolUse
}

/** The few-word display title for a session card (summary → label → worktree). */
fun sessionName(session: SessionInfo): String {
    session.summary.takeIf { it.isNotBlank() }?.let { return it }
    session.label.takeIf { it.isNotBlank() }?.let { return it }
    // Strip BOTH separators — a Windows agent's worktreePath uses backslashes,
    // so a '/'-only basename returns the whole path (XERK-666).
    val wt = session.worktreePath.substringAfterLast('/').substringAfterLast('\\')
    return wt.ifBlank { session.id }
}

/**
 * Branch shown on the card: the agent's live HEAD, or "detached" until it branches.
 * "" when there is no git block — the agent hasn't read it yet (it serves git:null
 * until its cheap-git worker answers), which is unknown, not detached (XERK-1538).
 * Callers drop or placeholder the blank, as web sessions.html `sessMeta` does.
 */
fun sessionBranch(session: SessionInfo): String {
    val b = session.git?.branch ?: return ""
    return if (b.isBlank() || b == "HEAD") "detached" else b
}

/**
 * The delete button's armed label — a port of web index.html `delConfirm`. No git
 * block is unknown, NOT clean, so it warns changes may be lost (XERK-1538); a
 * repos-root session has no worktree to lose.
 */
fun deleteConfirmText(session: SessionInfo): String {
    val dirty = session.git?.dirtyFiles
    return when {
        dirty != null && dirty > 0 -> "Confirm delete — uncommitted changes will be lost"
        dirty == null && !session.root -> "Confirm delete — may have uncommitted changes"
        else -> "Confirm delete"
    }
}

/**
 * The repo a session works, as the Sessions-tab card names it (XERK-125) — with
 * several sessions open at once it is what tells them apart, so it sits on the
 * card's meta line (`host · repo · branch`) as it does on the web card
 * (sessions.html `activeCard`) and on the queued/ended rows.
 *
 * A repos-root session has no repo: it spans the whole git root, and the agent
 * reports the `(root)` pseudo-repo sentinel for it. That says nothing to a
 * reader, so it reads in words instead, as the Dashboard card already does
 * ("repos root (no worktree)" in FleetScreen) and as the web session header does
 * (`sessMeta`). A record with no repo at all (an older agent, a partial closed
 * record) reads "?" like the queued and ended rows.
 */
fun sessionRepoLabel(session: SessionInfo): String = when {
    session.root || session.repo == ROOT_REPO_NAME -> "repos root"
    session.repo.isNotBlank() -> session.repo
    else -> "?"
}

/** The agent's pseudo-repo name for a repos-root session (hub-agent.py ROOT_REPO_NAME). */
const val ROOT_REPO_NAME = "(root)"

/**
 * The session header's subtitle line (XERK-121): the host the agent runs on, the
 * repo, and the live branch — e.g. "truenas · Turma · XERK-121". Blank parts are
 * dropped, so a repos-root session (no repo) still reads cleanly. Mirrors the web
 * session header (turma sessions.html `sessMeta`, prefixed with the host).
 */
fun sessionHeaderMeta(host: String, session: SessionInfo): String =
    listOf(host, session.repo, sessionBranch(session))
        .filter { it.isNotBlank() }
        .joinToString(" · ")

/**
 * The marker that follows the session header's meta line: whether anything is
 * actually reaching this screen. Web parity: the Sessions page's "⚠ tunnel
 * offline" chip (XERK-252).
 *
 * A host whose terminal tunnel is down OUTRANKS [connected], which only says
 * our own /live socket is open — the hub accepts and holds that socket across a
 * control-channel flap, so "live" would claim a stream that has stopped.
 */
fun liveMarker(tunnelOnline: Boolean, connected: Boolean): String = when {
    !tunnelOnline -> "⚠ tunnel offline"
    connected -> "live"
    else -> ""
}

/**
 * Whether a session's host still has its terminal tunnel up, off the fleet
 * heartbeat. A host missing from the payload is NOT offline — it is unknown,
 * and the chat says nothing rather than claiming a fault it can't see.
 */
fun tunnelOnlineOf(agent: com.xerktech.turma.model.AgentInfo?): Boolean =
    agent?.terminalOnline ?: true

/**
 * Work-safety facts for a session (web index.html `unpushedCommits`): how many
 * commits aren't on origin yet — relative to origin/<branch> when it was ever
 * pushed, else everything past the base branch. Null = unknown (first beat,
 * branch not born yet, repo gone).
 */
fun unpushedCommits(work: com.xerktech.turma.model.WorkInfo?): Int? = when (work?.pushed) {
    true -> work.aheadOfRemote   // may be null (sync unknown)
    false -> work.aheadOfBase    // never pushed: all of these
    else -> null
}

/** The card's compact work-state line + whether it reads as at-risk. */
data class WorkLine(val text: String, val risk: Boolean)

/**
 * Compact work-state line for the session card, e.g. "3 commits ahead of main ·
 * not pushed" (risk) or "pushed · 0 ahead" (muted) — a pure port of web
 * index.html `workLine`. Null when nothing is known.
 */
fun workLine(session: SessionInfo): WorkLine? {
    val w = session.work
    val dirty = session.git?.dirtyFiles ?: 0
    if (w?.pushed == null && w?.aheadOfBase == null && dirty == 0) return null
    val bits = ArrayList<String>()
    w?.aheadOfBase?.let { n ->
        bits.add("$n commit${if (n == 1) "" else "s"} ahead" + (w.baseRef?.let { " of $it" } ?: ""))
    }
    when (w?.pushed) {
        true -> bits.add(
            when {
                (w.aheadOfRemote ?: 0) > 0 -> "${w.aheadOfRemote} unpushed"
                w.aheadOfRemote == 0 -> "pushed"
                else -> "pushed · sync unknown"
            },
        )
        false -> bits.add("not pushed")
        else -> {}
    }
    if (dirty > 0) bits.add("$dirty dirty file${if (dirty == 1) "" else "s"}")
    val risk = (unpushedCommits(w) ?: 0) > 0 || dirty > 0
    return WorkLine(bits.joinToString(" · "), risk)
}

data class FlatSession(val host: String, val session: SessionInfo)

/** Every session across all hosts, flattened (used by the notifications router). */
fun flattenSessions(agents: List<AgentInfo>): List<FlatSession> =
    agents.flatMap { a -> a.sessions.map { FlatSession(a.key, it) } }

/** Locate the host that owns a sessionId (for deep-link routing). */
fun findHost(agents: List<AgentInfo>, sessionId: String): String? =
    agents.firstOrNull { a -> a.sessions.any { it.id == sessionId } }?.key

/**
 * The org the HUB DECIDED a host is in (XERK-349) — the bound org, or "" for a
 * drifted or never-bound host — which is what the migrate route enforces, not the
 * claimed [siteKeyOf]. The hub serves it as [AgentInfo.org]; an older hub omits it
 * (null), so fall back to the claimed key then. A PRESENT "" means "no org" and
 * must be honoured, so only a null (absent) field triggers the fallback.
 */
fun orgOf(agent: AgentInfo): String = agent.org ?: siteKeyOf(agent)

/**
 * The hosts a running session at [srcHost] could move to (XERK-101): online,
 * in the same DECIDED org, a different host, with the session's repo already
 * cloned — the exact predicate the hub enforces (`sameDecidedOrg`) and web
 * `eligibleMoveTargets` renders. An empty org offers NOTHING: a drifted or
 * never-bound host is not pooled with any other.
 */
fun eligibleMoveTargets(
    agents: List<AgentInfo>,
    srcHost: String,
    session: SessionInfo,
): List<AgentInfo> {
    val src = agents.firstOrNull { it.key == srcHost } ?: return emptyList()
    val org = orgOf(src)
    if (org.isEmpty()) return emptyList()
    return agents.filter { t ->
        t.key != srcHost && t.online && orgOf(t) == org &&
            t.repos.any { it.name == session.repo }
    }
}
