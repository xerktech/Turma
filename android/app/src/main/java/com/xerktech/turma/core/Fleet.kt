package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.UsageInfo

/**
 * Dashboard summary-tile aggregation — a pure port of the reducers in
 * turma/public/index.html's `render()` (`fleetTokens` / `mergeModels` /
 * `shortModels` and the session counts). Kept pure + JVM-tested so the Fleet
 * screen's six tiles match the web dashboard exactly.
 */

enum class UsageWindow { TODAY, WEEK, TOTALS }

/** The numbers behind the six dashboard summary tiles. */
data class FleetSummary(
    val hostsOnline: Int,
    val hostsTotal: Int,
    val devices: List<String>,
    val running: Int,
    val totalSessions: Int,
    // Session ceiling for the scoped fleet: the SUM of each host's per-agent
    // MAX_SESSIONS (XERK-72), null when no scoped host reports a capacity block.
    val maxSessions: Int?,
    val waiting: Int,
    val tokensToday: Long,
    val tokensWeek: Long,
    val tokensAllTime: Long,
    val topModels: String,
    // Whether a removed host's spend is inside the three token totals, so the
    // tiles can say so (index.html's `retiredNote`).
    val retiredCounted: Boolean = false,
)

private fun bucket(u: UsageInfo, w: UsageWindow) = when (w) {
    UsageWindow.TODAY -> u.today
    UsageWindow.WEEK -> u.week
    UsageWindow.TOTALS -> u.totals
}

/**
 * Fleet token total for a window, reading each host's persistent `usage` block —
 * which the agent aggregates from EVERY transcript on the box, so killed, deleted
 * and pruned work still counts — rather than summing the live session list. A
 * host too old to report the block falls back to the sessions it does report
 * (understating, but only for that host). Mirrors index.html `fleetTokens`.
 */
fun fleetTokens(agents: List<AgentInfo>, w: UsageWindow): Long = agents.sumOf { a ->
    val u = a.usage
    if (u != null) bucket(u, w).total
    else a.sessions.sumOf { s -> s.usage?.let { bucket(it, w).total } ?: 0L }
}

/**
 * The 1–2 dominant model names across the fleet, biggest consumer first — the
 * same model runs on many hosts, so it merges by name rather than concatenating.
 * Mirrors index.html `mergeModels` + `shortModels` ("–" when none).
 */
fun fleetTopModels(agents: List<AgentInfo>): String {
    val by = LinkedHashMap<String, Long>()
    for (a in agents) for (m in a.usage?.models ?: emptyList()) {
        by[m.model] = (by[m.model] ?: 0L) + m.totals.total
    }
    val sorted = by.entries.sortedByDescending { it.value }.map { it.key }
    if (sorted.isEmpty()) return "–"
    return sorted.take(2).joinToString(", ") {
        it.removePrefix("claude-").replace(Regex("-\\d{8}$"), "")
    }
}

/**
 * The six dashboard tiles for the scoped fleet.
 *
 * `retired` is the scoped `AgentsResponse.retiredUsage` (XERK-338) — spend from
 * hosts the hub no longer has. It feeds the TOKEN TILES ONLY, matching
 * index.html: a retired entry is not a host, so it carries no sessions, repos or
 * capacity and must never reach the host counts. Reading only `agents` made this
 * screen disagree with the Usage screen, which has always counted both — removing
 * one busy host erased most of the fleet's all-time tokens here while Usage still
 * charted them.
 */
fun fleetSummary(
    agents: List<AgentInfo>,
    retired: List<AgentInfo> = emptyList(),
): FleetSummary {
    val spenders = agents + retired
    val sessions = agents.flatMap { it.sessions }
    // MAX_SESSIONS is per-agent, so the scoped fleet's ceiling is the sum across
    // hosts that report a capacity block; null when none do (pre-capacity fleet),
    // so the tile shows the running count alone rather than a misleading "/ 0".
    val capHosts = agents.mapNotNull { it.capacity }
    return FleetSummary(
        hostsOnline = agents.count { it.online },
        hostsTotal = agents.size,
        devices = agents.map { it.device }.filter { it.isNotBlank() }.distinct(),
        running = sessions.count { it.status == "running" },
        totalSessions = sessions.size,
        maxSessions = if (capHosts.isEmpty()) null else capHosts.sumOf { it.maxSessions },
        waiting = sessions.count { it.status == "running" && !it.session?.question.isNullOrBlank() },
        tokensToday = fleetTokens(spenders, UsageWindow.TODAY),
        tokensWeek = fleetTokens(spenders, UsageWindow.WEEK),
        tokensAllTime = fleetTokens(spenders, UsageWindow.TOTALS),
        topModels = fleetTopModels(spenders),
        // Said on the tiles rather than left to be discovered: a total larger
        // than the hosts on screen can account for reads as a bug otherwise.
        retiredCounted = retired.isNotEmpty(),
    )
}
