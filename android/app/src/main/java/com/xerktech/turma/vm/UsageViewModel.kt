package com.xerktech.turma.vm

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import java.util.Locale
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
        /**
         * A host the hub no longer has (XERK-338) — deleted, pruned or evicted —
         * on this screen only because its spend outlived it. Web `hostLabel`.
         */
        val retired: Boolean = false,
    ) {
        val skey: String get() = "host::$host"
        /** What the legend and the chart call it; see [retired]. */
        val label: String get() = if (retired) "$host (removed)" else host
    }

    /** One model's fleet-wide token counts. */
    data class ModelTotal(
        val model: String,
        val today: Long,
        val week: Long,
        val total: Long,
        val cache: CacheSummary = CacheSummary(),
    )

    /**
     * How much of the fleet's spend went to background agents (XERK-302, web
     * usage.html `subagentCard`).
     *
     * The `of*` figures are the denominators, and they are NOT the fleet totals:
     * they carry only what the hosts REPORTING a split spent. A fleet with one
     * older host would otherwise take the share against spend that host never
     * offered a split for, quietly understating it.
     */
    data class SubagentSplit(
        val today: Long = 0,
        val week: Long = 0,
        val total: Long = 0,
        val ofToday: Long = 0,
        val ofWeek: Long = 0,
        val ofTotal: Long = 0,
        /** Hosts that reported a split; 0 means nothing to show at all. */
        val reporting: Int = 0,
        /** Hosts in view, reporting or not — `reporting < hosts` is a partial answer. */
        val hosts: Int = 0,
    ) {
        val any: Boolean get() = reporting > 0

        /** True when some host in view can't answer, so the figures cover only part of it. */
        val partial: Boolean get() = reporting in 1 until hosts

        /**
         * Delegated share of a window, 0..100 — null when that window has no
         * spend to take a ratio of ("nothing happened", never "0% delegated").
         */
        fun pct(spent: Long, delegated: Long): Double? =
            if (spent > 0) delegated * 100.0 / spent else null

        val todayPct: Double? get() = pct(ofToday, today)
        val weekPct: Double? get() = pct(ofWeek, week)
        val totalPct: Double? get() = pct(ofTotal, total)
    }

    /**
     * One SUBSCRIPTION's limit snapshot, ready to render (XERK-247, XERK-301).
     * [hosts] is every host on that subscription — usually one — and each
     * window carries the freshest reading any of them took.
     */
    data class LimitCard(
        val hosts: List<LimitHost>,
        val capturedAt: Long,
        /**
         * The subscription's human-readable name (XERK-541), or blank. When set
         * it heads the card and [host] (the machine list) becomes the subtitle,
         * answering "which machines are in which subscription".
         */
        val label: String = "",
        val fiveHour: LimitView? = null,
        val sevenDay: LimitView? = null,
        /**
         * When each window's reading was actually taken. [capturedAt] is the
         * group's FRESHEST capture, so on a consolidated card a window sourced
         * from an older host would otherwise be presented under an age that is
         * not its own; the screen discloses these when they differ.
         */
        val fiveHourAt: Long = capturedAt,
        val sevenDayAt: Long = capturedAt,
    ) {
        /**
         * The card's heading. There is no better name for a subscription — the
         * key is a hash by design — and the hosts are what the operator
         * recognises. Long lists give way to a count; every name is still in
         * [hosts] for the detail line.
         */
        val host: String get() =
            if (hosts.size <= LIMIT_HOSTS_SHOWN) hosts.joinToString(" · ") { it.host }
            else hosts.take(LIMIT_HOSTS_SHOWN).joinToString(" · ") { it.host } +
                " +${hosts.size - LIMIT_HOSTS_SHOWN} more"
    }

    /** One host on a subscription, with the moment IT last read the windows. */
    data class LimitHost(val host: String, val capturedAt: Long)

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
        /**
         * The even-pace day markers for the 7-day bar (XERK-536), or null when
         * this window can't be paced (the 5-hour window, no reset stamp, no
         * labels, or already reset). Purely informational.
         */
        val pacing: SevenDayPacing? = null,
    ) {
        /** Bar colour band — earned from headroom, not from branding. */
        enum class Level { NORMAL, WARN, CRIT }
    }

    /** One day slice of the 7-day even-pace grid. [end] is its cumulative 0..1
     *  boundary; [isToday] marks the slice the current moment falls in. */
    data class SevenDaySlice(val label: String, val end: Double, val isToday: Boolean)

    /** The 7-day bar's day markers plus [paceFrac], the fraction of the week
     *  elapsed — the continuous "you should be here by now" line. */
    data class SevenDayPacing(val slices: List<SevenDaySlice>, val paceFrac: Double)

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
        /** The delegated share of the spend above (XERK-302). */
        val subagent: SubagentSplit = SubagentSplit(),
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
            var sub = SubagentSplit()

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
                hosts.add(HostTotal(a.key, hostToday, hostWeek, hostTotal, hostDays, hostCache,
                                    retired = a.retired))
                today += hostToday
                week += hostWeek
                total += hostTotal
                cache += hostCache

                // The delegated slice, and beside it the spend it is a slice OF
                // (XERK-302). Host block first, then the repo blocks — the same
                // fallback as the totals above. A host reporting no split at all
                // contributes to NEITHER side, so it drops out of the share
                // instead of reading as a host that delegated nothing.
                val hostSub = a.usage?.subagent
                val repoSubs = if (a.usage == null) a.repoUsage.filter { it.usage.subagent != null }
                               else emptyList()
                if (hostSub != null || repoSubs.isNotEmpty()) {
                    sub = sub.copy(
                        today = sub.today + (hostSub?.today?.total
                            ?: repoSubs.sumOf { it.usage.subagent!!.today.total }),
                        week = sub.week + (hostSub?.week?.total
                            ?: repoSubs.sumOf { it.usage.subagent!!.week.total }),
                        total = sub.total + (hostSub?.totals?.total
                            ?: repoSubs.sumOf { it.usage.subagent!!.totals.total }),
                        ofToday = sub.ofToday + (if (hostSub != null) hostToday
                                  else repoSubs.sumOf { it.usage.today.total }),
                        ofWeek = sub.ofWeek + (if (hostSub != null) hostWeek
                                 else repoSubs.sumOf { it.usage.week.total }),
                        ofTotal = sub.ofTotal + (if (hostSub != null) hostTotal
                                  else repoSubs.sumOf { it.usage.totals.total }),
                        reporting = sub.reporting + 1,
                    )
                }

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
                subagent = sub.copy(hosts = fleet.agents.size),
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
            // Locale.US: `%d` renders Arabic-Indic digits under ar_EG, and this
            // is the "captured 2h 05m ago" stamp beside a token count that does not.
            if (hours < 24) return String.format(Locale.US, "%dh %02dm", hours, mins % 60)
            return "${hours / 24}d ${hours % 24}h"
        }

        /**
         * One window's rendered state, or null when it carries no percentage.
         * [pace] draws the even-pace day markers (XERK-536) — set ONLY for the
         * 7-day window (web `limitCard` gates the same draw on `key ===
         * "sevenDay"`). This is the guard, not the hub's `dayLabels` stripping:
         * the 5-hour bar must stay plain even if a `fiveHour.dayLabels` ever
         * reached a client past `normalizeLimits`.
         */
        fun limitView(
            win: com.xerktech.turma.model.LimitWindow?,
            nowSec: Long,
            pace: Boolean = false,
        ): LimitView? {
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
                pacing = if (pace) sevenDayPacing(win, nowSec) else null,
            )
        }

        /** How many even-pace slices the 7-day window is split into (web
         *  usage.html SEVEN_DAY_SLICES). */
        const val SEVEN_DAY_SLICES = 7

        /**
         * The even-pace day markers overlaid on the 7-day bar (web usage.html
         * `sevenDayPacing`). A fixed 7-day window ending at `resetsAt`, split
         * into seven 1/7 slices measured back from it; returns each day cell
         * (its agent-supplied weekday label and whether NOW falls in it) plus
         * the fraction of the week elapsed, or null when the window can't be
         * paced. The weekday NAMES come from the agent (its own timezone); which
         * slice is "today" and the pace fraction are timezone-free arithmetic
         * computed here at render time so they stay correct as the snapshot ages.
         */
        fun sevenDayPacing(win: com.xerktech.turma.model.LimitWindow?, nowSec: Long): SevenDayPacing? {
            val resets = win?.resetsAt ?: return null
            val labels = win.dayLabels
            if (labels.size != SEVEN_DAY_SLICES) return null
            val windowLen = SEVEN_DAY_SLICES.toLong() * 86400
            val windowStart = resets - windowLen
            val elapsed = nowSec - windowStart
            if (elapsed < 0 || elapsed >= windowLen) return null
            val todayIdx = minOf(SEVEN_DAY_SLICES - 1, (elapsed / 86400).toInt())
            val slices = labels.mapIndexed { i, label ->
                SevenDaySlice(label, (i + 1).toDouble() / SEVEN_DAY_SLICES, i == todayIdx)
            }
            return SevenDayPacing(slices, elapsed.toDouble() / windowLen)
        }

        /** How many host names a card's heading spells out before counting them. */
        const val LIMIT_HOSTS_SHOWN = 3

        /**
         * One card per SUBSCRIPTION that reports a usable snapshot, freshest
         * first (web usage.html `limitGroups`).
         *
         * A host reporting no snapshot is skipped entirely — an agent too old to
         * send the field, a login with no subscription windows, or one that
         * hasn't been probed yet all mean "this host can't tell you", not "0%
         * used" — and so is one whose snapshot is older than [LIMIT_MAX_AGE_SEC].
         *
         * Hosts logged into one Claude account read and spend the SAME 5h/7d
         * pool, so their snapshots are readings of a single thing and fold into
         * one card. Grouping is on the agent's opaque `subscription.key`; a host
         * that reports none keeps a card of its own and is never folded in with
         * another silent host, since "can't tell you" from two hosts does not
         * make them one plan.
         *
         * Within a group each window takes its FRESHEST reading rather than an
         * average or a maximum: every host reads the same server-side counter,
         * and across a window's reset the newest read is the only right answer
         * where a maximum would keep the pre-reset figure alive.
         */
        fun limitCards(fleet: FleetState, nowSec: Long): List<LimitCard> {
            // Freshest-first BEFORE folding, and a strict `>` when a window is
            // replaced, exactly as the web's limitEntries → limitGroups pair
            // does. Both halves matter for the parity rule: fold in fleet order
            // (or accept an equal capturedAt) and two hosts whose snapshots tie
            // to the second resolve to a different host on each client, showing
            // two different percentages for one subscription. Kotlin's sort is
            // stable and so is the browser's, so a tie keeps fleet order on
            // both.
            val ranked = fleet.agents.mapNotNull { a ->
                val lim = a.limits ?: return@mapNotNull null
                if (nowSec - lim.capturedAt > LIMIT_MAX_AGE_SEC) return@mapNotNull null
                if (lim.fiveHour?.usedPct == null && lim.sevenDay?.usedPct == null) return@mapNotNull null
                a to lim
            }.sortedByDescending { (_, lim) -> lim.capturedAt }

            // Insertion-ordered so ungrouped hosts keep their place among the
            // groups; the sort at the end is what actually orders the cards.
            val groups = mutableListOf<MutableLimitGroup>()
            val byKey = mutableMapOf<String, MutableLimitGroup>()
            for ((a, lim) in ranked) {
                val subKey = a.subscription?.key?.takeIf { it.isNotBlank() }
                val group = subKey?.let { byKey[it] } ?: MutableLimitGroup().also {
                    groups.add(it)
                    if (subKey != null) byKey[subKey] = it
                }
                group.hosts.add(LimitHost(a.device.ifBlank { a.key }, lim.capturedAt))
                group.capturedAt = maxOf(group.capturedAt, lim.capturedAt)
                // The card's name takes the FRESHEST reporter's label (XERK-541),
                // the same freshest-first + strict-`>` rule the windows use, so
                // hosts that ever disagree resolve identically on both clients.
                val label = a.subscription?.label?.takeIf { it.isNotBlank() }
                if (label != null && lim.capturedAt > group.labelAt) {
                    group.label = label
                    group.labelAt = lim.capturedAt
                }
                if (lim.fiveHour?.usedPct != null && lim.capturedAt > group.fiveHourAt) {
                    group.fiveHour = lim.fiveHour
                    group.fiveHourAt = lim.capturedAt
                }
                if (lim.sevenDay?.usedPct != null && lim.capturedAt > group.sevenDayAt) {
                    group.sevenDay = lim.sevenDay
                    group.sevenDayAt = lim.capturedAt
                }
            }
            return groups.map { g ->
                LimitCard(
                    hosts = g.hosts,
                    capturedAt = g.capturedAt,
                    label = g.label,
                    fiveHour = limitView(g.fiveHour, nowSec),
                    sevenDay = limitView(g.sevenDay, nowSec, pace = true),
                    fiveHourAt = if (g.fiveHour != null) g.fiveHourAt else g.capturedAt,
                    sevenDayAt = if (g.sevenDay != null) g.sevenDayAt else g.capturedAt,
                )
            }.sortedByDescending { it.capturedAt }
        }

        /** Accumulator behind [limitCards]; never leaves this file. */
        private class MutableLimitGroup {
            val hosts = mutableListOf<LimitHost>()
            var capturedAt = 0L
            var label = ""
            var labelAt = Long.MIN_VALUE
            var fiveHour: com.xerktech.turma.model.LimitWindow? = null
            var fiveHourAt = Long.MIN_VALUE
            var sevenDay: com.xerktech.turma.model.LimitWindow? = null
            var sevenDayAt = Long.MIN_VALUE
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
