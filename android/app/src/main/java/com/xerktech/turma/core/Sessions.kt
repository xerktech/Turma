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

data class FlatSession(val host: String, val session: SessionInfo)

/** Every session across all hosts, flattened (used by the notifications router). */
fun flattenSessions(agents: List<AgentInfo>): List<FlatSession> =
    agents.flatMap { a -> a.sessions.map { FlatSession(a.key, it) } }

/** Locate the host that owns a sessionId (for deep-link routing). */
fun findHost(agents: List<AgentInfo>, sessionId: String): String? =
    agents.firstOrNull { a -> a.sessions.any { it.id == sessionId } }?.key
