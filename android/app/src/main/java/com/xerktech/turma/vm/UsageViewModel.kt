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

    /** The header's org scope (XERK-62), shared by every screen. */
    val orgFilter get() = container.org.stored

    fun start() = container.fleet.start()

    data class RepoTotal(
        val repo: String,
        val remoteKey: String,
        val today: Long,
        val week: Long,
        val total: Long,
        /** "YYYY-MM-DD" (UTC) -> that day's total tokens, summed across hosts. */
        val days: Map<String, Long> = emptyMap(),
    ) {
        /** Legend/persistence key, the web's skey ("repo::<remoteKey>"). */
        val skey: String get() = "repo::$remoteKey"
    }

    data class HostTotal(
        val host: String,
        val today: Long,
        val week: Long,
        val total: Long,
        val days: Map<String, Long> = emptyMap(),
    ) {
        val skey: String get() = "host::$host"
    }

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
        /** Merge one usage block's per-day buckets into an accumulator. */
        private fun addDays(acc: MutableMap<String, Long>, u: UsageInfo) {
            for ((d, b) in u.days) acc[d] = (acc[d] ?: 0) + b.total
        }

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
                val hostDays = LinkedHashMap<String, Long>()
                a.usage?.let { addDays(hostDays, it) }
                    ?: a.repoUsage.forEach { addDays(hostDays, it.usage) }
                hosts.add(HostTotal(a.key, hostToday, hostWeek, hostTotal, hostDays))
                today += hostToday
                week += hostWeek
                total += hostTotal

                for (ru in a.repoUsage) {
                    val key = ru.remoteKey.ifBlank { ru.repo }
                    val prev = repoAcc[key]
                    val days = LinkedHashMap(prev?.days ?: emptyMap())
                    addDays(days, ru.usage)
                    repoAcc[key] = RepoTotal(
                        repo = prev?.repo?.ifBlank { ru.repo } ?: ru.repo,
                        remoteKey = key,
                        today = (prev?.today ?: 0) + ru.usage.today.total,
                        week = (prev?.week ?: 0) + ru.usage.week.total,
                        total = (prev?.total ?: 0) + ru.usage.totals.total,
                        days = days,
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

        /** How many days the stacked daily chart shows (web usage.html DAYS_SHOWN). */
        const val DAYS_SHOWN = 30

        /**
         * The chart's date axis: [DAYS_SHOWN] consecutive UTC days ending at the
         * newest day any series reports (web usage.html `dateWindow`). Empty when
         * no series carries per-day data (older agents).
         */
        fun dateWindow(seriesDays: List<Map<String, Long>>): List<String> {
            val newest = seriesDays.flatMap { it.keys }.maxOrNull() ?: return emptyList()
            val end = runCatching { java.time.LocalDate.parse(newest) }.getOrNull() ?: return emptyList()
            return (DAYS_SHOWN - 1 downTo 0).map { end.minusDays(it.toLong()).toString() }
        }

        /** Round a max value up to a "nice" axis ceiling (web `niceMax`). */
        fun niceMax(v: Long): Long {
            if (v <= 0) return 1
            val pow = Math.pow(10.0, Math.floor(Math.log10(v.toDouble())))
            for (m in doubleArrayOf(1.0, 2.0, 2.5, 5.0, 10.0)) {
                if (v <= m * pow) return Math.ceil(m * pow).toLong()
            }
            return (10 * pow).toLong()
        }
    }
}
