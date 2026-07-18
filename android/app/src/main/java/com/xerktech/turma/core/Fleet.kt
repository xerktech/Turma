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
    val waiting: Int,
    val tokensToday: Long,
    val tokensWeek: Long,
    val tokensAllTime: Long,
    val topModels: String,
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

fun fleetSummary(agents: List<AgentInfo>): FleetSummary {
    val sessions = agents.flatMap { it.sessions }
    return FleetSummary(
        hostsOnline = agents.count { it.online },
        hostsTotal = agents.size,
        devices = agents.map { it.device }.filter { it.isNotBlank() }.distinct(),
        running = sessions.count { it.status == "running" },
        totalSessions = sessions.size,
        waiting = sessions.count { it.status == "running" && !it.session?.question.isNullOrBlank() },
        tokensToday = fleetTokens(agents, UsageWindow.TODAY),
        tokensWeek = fleetTokens(agents, UsageWindow.WEEK),
        tokensAllTime = fleetTokens(agents, UsageWindow.TOTALS),
        topModels = fleetTopModels(agents),
    )
}
