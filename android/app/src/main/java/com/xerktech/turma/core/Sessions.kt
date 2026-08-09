package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
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
    s.paneBusy?.let { return it }
    return (age * 1000).toLong() + max(0, now - agentLastSeen) < WORKING_WINDOW_MS
}

enum class LiveState { WORKING, IDLE, WAITING, STOPPED }

fun liveState(session: SessionInfo, agentLastSeen: Long, now: Long): LiveState = when {
    session.status != "running" -> LiveState.STOPPED
    (session.session?.question ?: "").isNotBlank() -> LiveState.WAITING
    sessionWorking(session, agentLastSeen, now) -> LiveState.WORKING
    else -> LiveState.IDLE
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
    if (state != LiveState.IDLE) return false        // working, or not live at all
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
    val wt = session.worktreePath.substringAfterLast('/')
    return wt.ifBlank { session.id }
}

/** Branch shown on the card: the agent's live HEAD, or "detached" until it branches. */
fun sessionBranch(session: SessionInfo): String {
    val b = session.git?.branch ?: session.branch
    return if (b.isBlank() || b == "HEAD") "detached" else b
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
 * The hosts a running session at [srcHost] could move to (XERK-101): online,
 * in the same org, a different host, with the session's repo already cloned —
 * the exact predicate the hub enforces and web `eligibleMoveTargets` renders.
 */
fun eligibleMoveTargets(
    agents: List<AgentInfo>,
    srcHost: String,
    session: SessionInfo,
): List<AgentInfo> {
    val src = agents.firstOrNull { it.key == srcHost } ?: return emptyList()
    val org = siteKeyOf(src)
    return agents.filter { t ->
        t.key != srcHost && t.online && siteKeyOf(t) == org &&
            t.repos.any { it.name == session.repo }
    }
}
