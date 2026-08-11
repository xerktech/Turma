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

    /** The header's org selection (XERK-62, multi per XERK-222), shared by every screen. */
    val orgFilter get() = container.org.stored

    fun start() = container.fleet.start()

    /**
     * The all-time cache split behind a token total (web usage.html
     * `cacheSubLine`/`cacheHitRate`). Carried alongside the flat totals because
     * a total alone can't say what it cost: its parts are priced nothing like
     * each other — a cache read is ~0.1x fresh input, a write ~1.25x — so a big
     * number is cheap when it is mostly reads and expensive when mostly writes.
     */
    data class CacheSummary(val read: Long = 0, val write: Long = 0, val input: Long = 0) {
        /** The prompt side only. Output is generated, never cached. */
        val prompt: Long get() = read + write + input

        /**
         * Percent of the prompt served from cache, or null when there is no
         * prompt traffic to take a ratio of.
         */
        val hitPct: Int? get() = if (prompt > 0) Math.round(read * 100.0 / prompt).toInt() else null

        /** False for an older agent that reports no cache fields at all. */
        val any: Boolean get() = read > 0 || write > 0

        operator fun plus(o: CacheSummary) =
            CacheSummary(read + o.read, write + o.write, input + o.input)
    }

    data class RepoTotal(
        val repo: String,
        val remoteKey: String,
        val today: Long,
        val week: Long,
        val total: Long,
        /** "YYYY-MM-DD" (UTC) -> that day's total tokens, summed across hosts. */
        val days: Map<String, Long> = emptyMap(),
        val cache: CacheSummary = CacheSummary(),
    ) {
        /** Legend/persistence key, the web's skey ("repo::<remoteKey>"). */
        val skey: String get() = "repo::$remoteKey"

        /** Display name — the root bucket reads "Root" (web `repoLabel`). */
        val label: String get() = repoLabel(repo)
    }

    data class HostTotal(
        val host: String,
        val today: Long,
        val week: Long,
        val total: Long,
        val days: Map<String, Long> = emptyMap(),
        val cache: CacheSummary = CacheSummary(),
    ) {
        val skey: String get() = "host::$host"
    }

    /** One model's fleet-wide token counts. */
    data class ModelTotal(
        val model: String,
        val today: Long,
        val week: Long,
        val total: Long,
        val cache: CacheSummary = CacheSummary(),
    )

    /** One host's subscription-limit snapshot, ready to render (XERK-247). */
    data class LimitCard(
        val host: String,
        val capturedAt: Long,
        val fiveHour: LimitView? = null,
        val sevenDay: LimitView? = null,
    )

    /**
     * One window's rendered state. [expired] beats the percentage: when the
     * snapshot's reset time has passed, the window it measured has rolled over
     * since, so the old figure describes a window that no longer exists.
     */
    data class LimitView(
        val pct: Double,
        val expired: Boolean,
        val pctLabel: String,
        val reset: String,
        val level: Level,
    ) {
        /** Bar colour band — earned from headroom, not from branding. */
        enum class Level { NORMAL, WARN, CRIT }
    }

    data class UsageUi(
        val byRepo: List<RepoTotal> = emptyList(),
        val byHost: List<HostTotal> = emptyList(),
        val byModel: List<ModelTotal> = emptyList(),
        val today: Long = 0,
        val week: Long = 0,
        val total: Long = 0,
        val cache: CacheSummary = CacheSummary(),
        /** Freshest snapshot first; empty when no host reports any window. */
        val limits: List<LimitCard> = emptyList(),
    )

    companion object {
        /**
         * The agent's reserved root pseudo-repo name. Usage the agent can't tie
         * to a repo folds in here too, and it reads as "Root" in the UI
         * (XERK-147). Older agents reported such usage as "(other)"/"?" —
         * [normRepo] folds those into the same series rather than listing
         * phantom repos (web usage.html `normRepo`/`repoLabel`).
         */
        const val ROOT_REPO = "(root)"
        private val legacyRootKeys = setOf(ROOT_REPO, "(other)", "?")

        fun normRepo(name: String): String =
            if (name.isBlank() || name in legacyRootKeys) ROOT_REPO else name

        fun repoLabel(name: String): String = if (name == ROOT_REPO) "Root" else name

        /**
         * Pure — a companion fun rather than a method so the JVM unit tests can
         * exercise it without standing up an Application for the ViewModel.
         */
        /** Merge one usage block's per-day buckets into an accumulator. */
        private fun addDays(acc: MutableMap<String, Long>, u: UsageInfo) {
            for ((d, b) in u.days) acc[d] = (acc[d] ?: 0) + b.total
        }

        /** The prompt-side split of a bucket (web `cacheHitRate`'s inputs). */
        fun UsageBucket.cacheSummary() = CacheSummary(cacheRead, cacheWrite, input)

        fun compute(
            fleet: FleetState,
            nowSec: Long = System.currentTimeMillis() / 1000,
        ): UsageUi {
            val repoAcc = LinkedHashMap<String, RepoTotal>()
            val modelAcc = LinkedHashMap<String, ModelTotal>()
            val hosts = ArrayList<HostTotal>()
            var today = 0L
            var week = 0L
            var total = 0L
            var cache = CacheSummary()

            for (a in fleet.agents) {
                // Prefer the host-level block (aggregated from every transcript
                // on the box); fall back to summing its repos for an agent that
                // doesn't report one.
                fun window(of: (UsageInfo) -> UsageBucket): Long =
                    a.usage?.let { of(it).total } ?: a.repoUsage.sumOf { of(it.usage).total }

                val hostToday = window { it.today }
                val hostWeek = window { it.week }
                val hostTotal = window { it.totals }
                // Same host-block-then-repos fallback as the totals above, so a
                // host without an aggregate still reports its cache split.
                val hostCache = a.usage?.totals?.cacheSummary()
                    ?: a.repoUsage.fold(CacheSummary()) { acc, r -> acc + r.usage.totals.cacheSummary() }
                val hostDays = LinkedHashMap<String, Long>()
                a.usage?.let { addDays(hostDays, it) }
                    ?: a.repoUsage.forEach { addDays(hostDays, it.usage) }
                hosts.add(HostTotal(a.key, hostToday, hostWeek, hostTotal, hostDays, hostCache))
                today += hostToday
                week += hostWeek
                total += hostTotal
                cache += hostCache

                for (ru in a.repoUsage) {
                    val key = normRepo(ru.remoteKey.ifBlank { ru.repo })
                    val prev = repoAcc[key]
                    val days = LinkedHashMap(prev?.days ?: emptyMap())
                    addDays(days, ru.usage)
                    repoAcc[key] = RepoTotal(
                        repo = if (ru.repo.isNotBlank()) normRepo(ru.repo)
                               else prev?.repo ?: key,
                        remoteKey = key,
                        today = (prev?.today ?: 0) + ru.usage.today.total,
                        week = (prev?.week ?: 0) + ru.usage.week.total,
                        total = (prev?.total ?: 0) + ru.usage.totals.total,
                        days = days,
                        cache = (prev?.cache ?: CacheSummary()) + ru.usage.totals.cacheSummary(),
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
                        cache = (prev?.cache ?: CacheSummary()) + m.totals.cacheSummary(),
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
                cache = cache,
                limits = limitCards(fleet, nowSec),
            )
        }

        // --- subscription limits (XERK-247) -------------------------------
        // Ports of usage.html's limitEntries / limitWindowView / fmtDuration.
        // The web page is the source of truth for this section; keep them in
        // step (see CLAUDE.md's Web ⇄ Android parity rule).

        /**
         * Agents refresh on a ~30 min cadence while a session runs, so an hour
         * without one is the first point at which the numbers deserve a warning.
         */
        const val LIMIT_STALE_SEC = 60L * 60L

        /**
         * Past this the card is dropped, not just coloured. The agent applies the
         * same rule before reporting, but the hub keeps an OFFLINE host's last
         * heartbeat for days — without the mirror here, a host that died shows a
         * frozen 5-hour window (one that has since reset several times over).
         */
        const val LIMIT_MAX_AGE_SEC = 24L * 60L * 60L

        /** "45s" / "6m" / "2h 14m" / "2d 2h", as an age or a countdown. */
        fun fmtDuration(sec: Long): String {
            val s = maxOf(0L, sec)
            if (s < 60) return "${s}s"
            val mins = Math.round(s / 60.0)
            if (mins < 60) return "${mins}m"
            val hours = mins / 60
            if (hours < 24) return "%dh %02dm".format(hours, mins % 60)
            return "${hours / 24}d ${hours % 24}h"
        }

        /** One window's rendered state, or null when it carries no percentage. */
        fun limitView(win: com.xerktech.turma.model.LimitWindow?, nowSec: Long): LimitView? {
            val raw = win?.usedPct ?: return null
            val pct = raw.coerceIn(0.0, 100.0)
            val resetsIn = win.resetsAt?.let { it - nowSec }
            val expired = resetsIn != null && resetsIn <= 0
            // Trailing ".0" dropped so a whole percentage reads as "41%".
            val rounded = Math.round(pct * 10) / 10.0
            val pctText = if (rounded == Math.floor(rounded)) "${rounded.toInt()}%" else "$rounded%"
            return LimitView(
                pct = pct,
                expired = expired,
                pctLabel = if (expired) "—" else pctText,
                reset = when {
                    resetsIn == null -> ""
                    expired -> "window has since reset"
                    else -> "resets in ${fmtDuration(resetsIn)}"
                },
                level = when {
                    pct >= 90 -> LimitView.Level.CRIT
                    pct >= 75 -> LimitView.Level.WARN
                    else -> LimitView.Level.NORMAL
                },
            )
        }

        /**
         * One card per host that reports a usable snapshot, freshest first. A
         * host reporting none is skipped entirely — an agent too old to send the
         * field, a login with no subscription windows, or one that hasn't been
         * probed yet all mean "this host can't tell you", not "0% used" — and so
         * is one whose snapshot is older than [LIMIT_MAX_AGE_SEC].
         */
        fun limitCards(fleet: FleetState, nowSec: Long): List<LimitCard> =
            fleet.agents.mapNotNull { a ->
                val lim = a.limits ?: return@mapNotNull null
                if (nowSec - lim.capturedAt > LIMIT_MAX_AGE_SEC) return@mapNotNull null
                val five = limitView(lim.fiveHour, nowSec)
                val seven = limitView(lim.sevenDay, nowSec)
                if (five == null && seven == null) return@mapNotNull null
                LimitCard(a.device.ifBlank { a.key }, lim.capturedAt, five, seven)
            }.sortedByDescending { it.capturedAt }

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
