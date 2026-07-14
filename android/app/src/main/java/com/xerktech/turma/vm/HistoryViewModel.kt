package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.net.FleetState

/**
 * Persistent cost history derived from the agents' usage aggregates (repoUsage /
 * usage) — not the live session list, so killed/deleted/pruned work still
 * counts. Unifies each repo across every host by remoteKey (the "By repo" view)
 * and totals per host (the "By host" view).
 */
class HistoryViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet get() = container.fleet.state
    fun start() = container.fleet.start()

    data class RepoTotal(val repo: String, val remoteKey: String, val todayCost: Double, val totalCost: Double)
    data class HostTotal(val host: String, val todayCost: Double, val totalCost: Double)
    data class HistoryUi(
        val byRepo: List<RepoTotal> = emptyList(),
        val byHost: List<HostTotal> = emptyList(),
        val todayCost: Double = 0.0,
        val totalCost: Double = 0.0,
    )

    fun compute(fleet: FleetState): HistoryUi {
        val repoAcc = LinkedHashMap<String, RepoTotal>()
        val hosts = ArrayList<HostTotal>()
        var today = 0.0
        var total = 0.0

        for (a in fleet.agents) {
            val hostToday = a.usage?.today?.cost ?: a.repoUsage.sumOf { it.usage.today.cost }
            val hostTotal = a.usage?.totals?.cost ?: a.repoUsage.sumOf { it.usage.totals.cost }
            hosts.add(HostTotal(a.key, hostToday, hostTotal))
            today += hostToday
            total += hostTotal
            for (ru in a.repoUsage) {
                val key = ru.remoteKey.ifBlank { ru.repo }
                val prev = repoAcc[key]
                repoAcc[key] = RepoTotal(
                    repo = prev?.repo?.ifBlank { ru.repo } ?: ru.repo,
                    remoteKey = key,
                    todayCost = (prev?.todayCost ?: 0.0) + ru.usage.today.cost,
                    totalCost = (prev?.totalCost ?: 0.0) + ru.usage.totals.cost,
                )
            }
        }
        return HistoryUi(
            byRepo = repoAcc.values.sortedByDescending { it.totalCost },
            byHost = hosts.sortedByDescending { it.totalCost },
            todayCost = today,
            totalCost = total,
        )
    }
}
