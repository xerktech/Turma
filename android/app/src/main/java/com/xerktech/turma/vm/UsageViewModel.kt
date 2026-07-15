package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.model.UsageBucket
import com.xerktech.turma.model.UsageInfo
import com.xerktech.turma.net.FleetState

/**
 * Persistent token usage derived from the agents' usage aggregates (repoUsage /
 * usage) — not the live session list, so killed/deleted/pruned work still
 * counts. Unifies each repo across every host by remoteKey (the "By repo" view),
 * totals per host (the "By host" view), and merges the per-model breakdown
 * fleet-wide ("By model").
 */
class UsageViewModel(app: Application) : AndroidViewModel(app) {
    private val container = (app as TurmaApplication).container
    val fleet get() = container.fleet.state
    fun start() = container.fleet.start()

    data class RepoTotal(
        val repo: String,
        val remoteKey: String,
        val today: Long,
        val week: Long,
        val total: Long,
    )

    data class HostTotal(val host: String, val today: Long, val week: Long, val total: Long)

    /** One model's fleet-wide token counts. */
    data class ModelTotal(val model: String, val today: Long, val week: Long, val total: Long)

    data class UsageUi(
        val byRepo: List<RepoTotal> = emptyList(),
        val byHost: List<HostTotal> = emptyList(),
        val byModel: List<ModelTotal> = emptyList(),
        val today: Long = 0,
        val week: Long = 0,
        val total: Long = 0,
    )

    companion object {
        /**
         * Pure — a companion fun rather than a method so the JVM unit tests can
         * exercise it without standing up an Application for the ViewModel.
         */
        fun compute(fleet: FleetState): UsageUi {
            val repoAcc = LinkedHashMap<String, RepoTotal>()
            val modelAcc = LinkedHashMap<String, ModelTotal>()
            val hosts = ArrayList<HostTotal>()
            var today = 0L
            var week = 0L
            var total = 0L

            for (a in fleet.agents) {
                // Prefer the host-level block (aggregated from every transcript
                // on the box); fall back to summing its repos for an agent that
                // doesn't report one.
                fun window(of: (UsageInfo) -> UsageBucket): Long =
                    a.usage?.let { of(it).total } ?: a.repoUsage.sumOf { of(it.usage).total }

                val hostToday = window { it.today }
                val hostWeek = window { it.week }
                val hostTotal = window { it.totals }
                hosts.add(HostTotal(a.key, hostToday, hostWeek, hostTotal))
                today += hostToday
                week += hostWeek
                total += hostTotal

                for (ru in a.repoUsage) {
                    val key = ru.remoteKey.ifBlank { ru.repo }
                    val prev = repoAcc[key]
                    repoAcc[key] = RepoTotal(
                        repo = prev?.repo?.ifBlank { ru.repo } ?: ru.repo,
                        remoteKey = key,
                        today = (prev?.today ?: 0) + ru.usage.today.total,
                        week = (prev?.week ?: 0) + ru.usage.week.total,
                        total = (prev?.total ?: 0) + ru.usage.totals.total,
                    )
                }

                // The same model runs on many hosts, so it merges by name. Read
                // off the host block rather than the repos, which double-counts.
                for (m in a.usage?.models.orEmpty()) {
                    val prev = modelAcc[m.model]
                    modelAcc[m.model] = ModelTotal(
                        model = m.model,
                        today = (prev?.today ?: 0) + m.today.total,
                        week = (prev?.week ?: 0) + m.week.total,
                        total = (prev?.total ?: 0) + m.totals.total,
                    )
                }
            }
            return UsageUi(
                byRepo = repoAcc.values.sortedByDescending { it.total },
                byHost = hosts.sortedByDescending { it.total },
                byModel = modelAcc.values.sortedByDescending { it.total },
                today = today,
                week = week,
                total = total,
            )
        }
    }
}
