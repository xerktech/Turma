package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.SessionInfo
import kotlin.math.max

/**
 * Session state derivation — a pure port of glasses/src/sessions.ts + the hub's
 * sessionWorking() (turma/server.js). Kept in Kotlin so the UI and any tests
 * agree on working/idle/waiting exactly as the web + glasses clients do.
 */

private const val WORKING_WINDOW_MS = 90_000L

/** Is this session actively working? paneBusy is authoritative; else freshness. */
fun sessionWorking(session: SessionInfo, agentLastSeen: Long, now: Long): Boolean {
    val s = session.session ?: return false
    s.paneBusy?.let { return it }
    val age = s.transcriptAgeSec ?: return false
    return (age * 1000).toLong() + max(0, now - agentLastSeen) < WORKING_WINDOW_MS
}

enum class LiveState { WORKING, IDLE, WAITING, STOPPED }

fun liveState(session: SessionInfo, agentLastSeen: Long, now: Long): LiveState = when {
    session.status != "running" -> LiveState.STOPPED
    (session.session?.question ?: "").isNotBlank() -> LiveState.WAITING
    sessionWorking(session, agentLastSeen, now) -> LiveState.WORKING
    else -> LiveState.IDLE
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
