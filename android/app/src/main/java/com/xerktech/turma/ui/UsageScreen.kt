package com.xerktech.turma.ui

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.util.Locale
import com.xerktech.turma.core.scopedAgents
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.UsageViewModel

/**
 * Compact token count: 1.2M / 3.4k / 850. Mirrors the web UI's fmtTokens, and
 * has to agree with it DIGIT FOR DIGIT — the same fleet totals are on the web
 * Usage page's headline strip and the dashboard's tiles, and an operator
 * reading 1.1k in the browser and 1.2k on the phone can't tell which is wrong.
 *
 * Two things it must not do, both of which `"%.1fk".format(n / 1e3)` did:
 * round a Double (Java rounds its shortest decimal HALF_UP, JS `toFixed`
 * rounds the binary value, and they disagree on every `.x5` boundary), and
 * format in the default locale (which renders `1,2k` in de_DE and `١٫٢k` in
 * ar_EG). Integer arithmetic settles both — and splitting whole from remainder
 * keeps `n * 10` from overflowing on an absurd count off the wire.
 */
fun fmtTokens(n: Long): String {
    for ((unit, suffix) in listOf(1_000_000_000L to "B", 1_000_000L to "M", 1_000L to "k")) {
        if (n >= unit) {
            var whole = n / unit
            var tenths = (n % unit * 10 + unit / 2) / unit
            if (tenths == 10L) { whole += 1; tenths = 0 }
            return "$whole.$tenths$suffix"
        }
    }
    return n.toString()
}

/** One chart/legend series — the selected grouping's rows in stable paint order. */
private data class UsageSeries(
    val skey: String,
    val label: String,
    val today: Long,
    val total: Long,
    val days: Map<String, Long>,
    val cache: UsageViewModel.CacheSummary = UsageViewModel.CacheSummary(),
)

@Composable
fun UsageScreen(modifier: Modifier = Modifier, vm: UsageViewModel = viewModel()) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val org by vm.orgFilter.collectAsStateWithLifecycle()
    // Scoped by the header's org control (XERK-62) before the totals are built,
    // so both groupings stay consistent: "By host" drops the other orgs' hosts,
    // and "By repo" charts only what the scoped org's hosts spent — a repo two
    // orgs share reads as that org's share of it, which is the point of scoping.
    val scoped = remember(fleet, org) { scopedAgents(fleet.agents, org) }
    val ui = remember(scoped) { UsageViewModel.compute(fleet.copy(agents = scoped)) }
    // Grouping pick + legend toggles persist across visits (web usage.html's
    // localStorage `turma-usage-mode` / `turma-hidden-sessions`).
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("turma_usage", Context.MODE_PRIVATE) }
    var tab by remember { mutableIntStateOf(prefs.getInt("mode", 0)) }
    var hidden by remember { mutableStateOf(prefs.getStringSet("hidden", emptySet())!!.toSet()) }
    fun setTab(t: Int) { tab = t; prefs.edit().putInt("mode", t).apply() }
    fun toggleHidden(next: Set<String>) { hidden = next; prefs.edit().putStringSet("hidden", next).apply() }

    // The selected grouping's series in STABLE order (label, then key) — paint
    // is assigned by this order (web assignPaint), so toggling one series never
    // repaints the survivors. "By model" has no per-day data, so no chart.
    val ordered: List<UsageSeries> = remember(ui, tab) {
        when (tab) {
            // Chartable groupings sort by (label, key) — the stable paint order.
            0 -> ui.byRepo.map { UsageSeries(it.skey, it.label, it.today, it.total, it.days, it.cache) }
                .sortedWith(compareBy({ it.label }, { it.skey }))
            1 -> ui.byHost.map { UsageSeries(it.skey, it.host, it.today, it.total, it.days, it.cache) }
                .sortedWith(compareBy({ it.label }, { it.skey }))
            // Models keep biggest-consumer-first (no chart, no legend).
            else -> ui.byModel.map { UsageSeries("model::" + it.model, it.model, it.today, it.total, emptyMap(), it.cache) }
        }
    }
    val visible = remember(ordered, hidden) { ordered.filter { it.skey !in hidden } }
    // Paint is assigned by position in the FULL ordered list, not the visible
    // one, so toggling a series never repaints the survivors (web assignPaint).
    val paint = remember(ordered) {
        ordered.mapIndexed { i, s -> s.skey to TurmaColors.series[i % TurmaColors.series.size] }.toMap()
    }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Usage")
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Stat("Today", ui.today)
                Stat("This week", ui.week)
                Stat("All-time", ui.total)
            }
            // Fleet-wide cache split: how much of the all-time prompt traffic was
            // served from cache rather than paid for fresh.
            CacheLine(ui.cache)
            // …and how much of it went to background agents rather than to the
            // sessions' own turns.
            SubagentLine(ui.subagent)
        }
        TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
            Tab(selected = tab == 0, onClick = { setTab(0) }, text = { Text("By repo") })
            Tab(selected = tab == 1, onClick = { setTab(1) }, text = { Text("By host") })
            Tab(selected = tab == 2, onClick = { setTab(2) }, text = { Text("By model") })
        }
        LazyColumn(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            // Subscription headroom (XERK-247) leads the list, above the token
            // series, because it answers a different question: not what was
            // spent, but how much of the plan's 5h/7d windows is left. It sits
            // outside the grouping tabs — it is per host either way — and it is
            // rendered whether or not any tokens have been charted.
            // The scoped list, not the whole fleet: the empty-state copy has to
            // agree with the cards above it, which are org-scoped (web parity).
            item(key = "limits") { LimitsSection(ui.limits, scoped.isNotEmpty()) }
            // Legend = filter: each item toggles its series; the group label
            // toggles them all (web legendEl). Persisted, and it rescopes the
            // chart AND the rows below.
            if (tab < 2 && ordered.isNotEmpty()) {
                item(key = "legend") {
                    UsageLegend(
                        group = if (tab == 0) "Repos" else "Hosts",
                        series = ordered,
                        paint = paint,
                        hidden = hidden,
                        onToggle = { skey ->
                            toggleHidden(if (skey in hidden) hidden - skey else hidden + skey)
                        },
                        onToggleGroup = {
                            val keys = ordered.map { it.skey }
                            val anyVisible = keys.any { it !in hidden }
                            toggleHidden(if (anyVisible) hidden + keys else hidden - keys.toSet())
                        },
                    )
                }
                item(key = "chart") { UsageChart(visible, paint) }
            }
            val rows = visible
            val maxTotal = rows.maxOfOrNull { it.total }?.takeIf { it > 0 } ?: 1L
            items(rows.size, key = { rows[it].skey }) { i ->
                val s = rows[i]
                val color = if (tab < 2) paint[s.skey] ?: MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.primary
                UsageRow(s.label, s.today, s.total, s.total.toDouble() / maxTotal, color, s.cache)
            }
            if (rows.isEmpty()) item {
                Text(
                    // An org whose hosts reported nothing yet vs a fleet that has:
                    // only the first has a way out, and it's the header control.
                    when {
                        ordered.isNotEmpty() -> "All series are toggled off — tap the legend to bring one back."
                        fleet.agents.isNotEmpty() && org.isNotEmpty() ->
                            "No usage reported for the selected orgs. Change the org filter (or pick “All orgs”) in the header."
                        else -> "No usage recorded yet."
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            // The descriptive footer the web moved from the dashboard to here.
            item {
                Text(
                    USAGE_FOOTER,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 16.dp, bottom = 8.dp),
                )
            }
        }
    }
}

/**
 * The Claude subscription limits section (web usage.html `renderLimits`): one
 * card per SUBSCRIPTION reporting the 5-hour and 7-day windows, each with the
 * percentage used, a bar coloured by headroom, the countdown to reset, and how
 * long ago the snapshot was captured. These are snapshots, not live numbers,
 * which is why the capture age is on every card rather than implied.
 */
@Composable
private fun LimitsSection(cards: List<UsageViewModel.LimitCard>, anyAgents: Boolean) {
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(
            "Claude subscription limits",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurface,
        )
        if (cards.isEmpty()) {
            Text(
                if (anyAgents)
                    "No limit snapshot yet. Hosts capture the 5-hour and 7-day windows from " +
                        "Claude Code itself while a session is running, so one appears within a " +
                        "few minutes of the next session. A login without a Claude subscription " +
                        "(an API key, Bedrock or Vertex) has no such windows and never reports any."
                else "No agents are reporting.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )
            return
        }
        Text(
            "one shared pool across claude.ai and Claude Code · one card per subscription",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val nowSec = System.currentTimeMillis() / 1000
        for (card in cards) LimitCardView(card, nowSec)
    }
}

@Composable
private fun LimitCardView(card: UsageViewModel.LimitCard, nowSec: Long) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(card.host, style = MaterialTheme.typography.bodyMedium)
            val ageSec = nowSec - card.capturedAt
            Text(
                // "captured", not "updated": this is when the host last read the
                // windows out of Claude Code, not when the screen refreshed.
                "captured ${UsageViewModel.fmtDuration(ageSec)} ago",
                style = MaterialTheme.typography.bodySmall,
                color = if (ageSec > UsageViewModel.LIMIT_STALE_SEC) TurmaColors.warning
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // Only worth saying when the card IS a consolidation: with one host the
        // heading already names it and its age is the line above.
        if (card.hosts.size > 1) {
            Text(
                "shared by " + card.hosts.joinToString(", ") {
                    "${it.host} (${UsageViewModel.fmtDuration(nowSec - it.capturedAt)} ago)"
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        LimitRow("Session (5h)", card.fiveHour,
            (nowSec - card.fiveHourAt).takeIf { card.fiveHourAt < card.capturedAt })
        LimitRow("Weekly (7d)", card.sevenDay,
            (nowSec - card.sevenDayAt).takeIf { card.sevenDayAt < card.capturedAt })
    }
}

/**
 * One window's row. [readAgeSec] is this window's OWN age, passed only when the
 * reading is older than the card's stamp — which happens on a consolidated card
 * whose freshest host didn't report this window, where showing the figure under
 * the head's age would be presenting somebody else's freshness as its own.
 */
@Composable
private fun LimitRow(label: String, view: UsageViewModel.LimitView?, readAgeSec: Long? = null) {
    if (view == null) return
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val color = when {
        view.expired -> muted
        view.level == UsageViewModel.LimitView.Level.CRIT -> TurmaColors.critical
        view.level == UsageViewModel.LimitView.Level.WARN -> TurmaColors.warning
        else -> MaterialTheme.colorScheme.primary
    }
    Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = muted)
            Text(
                view.pctLabel + (if (view.reset.isEmpty()) "" else " · ${view.reset}") +
                    (readAgeSec?.let { " · read ${UsageViewModel.fmtDuration(it)} ago" } ?: ""),
                style = MaterialTheme.typography.bodySmall,
                color = if (view.expired) muted else MaterialTheme.colorScheme.onSurface,
            )
        }
        Box(
            Modifier.fillMaxWidth().height(6.dp).padding(top = 2.dp)
                .clip(RoundedCornerShape(3.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            // An expired window draws nothing: its percentage described a window
            // that has since rolled over.
            val fraction = if (view.expired) 0f else (view.pct / 100.0).toFloat()
            if (fraction > 0f) {
                Box(
                    Modifier.fillMaxWidth(fraction).fillMaxHeight()
                        .clip(RoundedCornerShape(3.dp)).background(color)
                )
            }
        }
    }
}

/**
 * The 30-day stacked daily chart (web usage.html `buildChart`): one bar per UTC
 * day, ending at the newest day any series reports, each visible series a
 * stacked segment in its stable legend color. No per-day data (older agents)
 * renders a short note instead of an empty box.
 */
@Composable
private fun UsageChart(visible: List<UsageSeries>, paint: Map<String, androidx.compose.ui.graphics.Color>) {
    val dates = remember(visible) { UsageViewModel.dateWindow(visible.map { it.days }) }
    if (dates.isEmpty()) {
        Text(
            "No per-day usage reported yet (agents report it within ~5 minutes of starting).",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(vertical = 8.dp),
        )
        return
    }
    val maxDay = dates.maxOf { d -> visible.sumOf { it.days[d] ?: 0 } }
    val yMax = UsageViewModel.niceMax(maxDay)
    val track = MaterialTheme.colorScheme.surfaceVariant
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Text(
                fmtTokens(yMax),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Canvas(Modifier.fillMaxWidth().height(180.dp)) {
            val n = dates.size
            val gap = 2.dp.toPx()
            val barW = (size.width - gap * (n - 1)) / n
            dates.forEachIndexed { i, d ->
                var y = size.height
                val x = i * (barW + gap)
                visible.forEach { s ->
                    val v = s.days[d] ?: 0
                    if (v <= 0) return@forEach
                    val h = (v.toDouble() / yMax * size.height).toFloat()
                    y -= h
                    drawRect(
                        color = paint[s.skey] ?: TurmaColors.series[0],
                        topLeft = Offset(x, y),
                        size = Size(barW, h),
                    )
                }
                // Hairline baseline tick so an empty day still reads as a day.
                drawRect(color = track, topLeft = Offset(x, size.height - 1), size = Size(barW, 1f))
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(dates.first(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(dates.last(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun UsageLegend(
    group: String,
    series: List<UsageSeries>,
    paint: Map<String, androidx.compose.ui.graphics.Color>,
    hidden: Set<String>,
    onToggle: (String) -> Unit,
    onToggleGroup: () -> Unit,
) {
    FlowRow(
        Modifier.fillMaxWidth().padding(top = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            group,
            Modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onToggleGroup).padding(horizontal = 4.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        series.forEach { s ->
            val off = s.skey in hidden
            Row(
                Modifier.clip(RoundedCornerShape(6.dp)).clickable { onToggle(s.skey) }.padding(horizontal = 4.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(
                    Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(
                        (paint[s.skey] ?: TurmaColors.series[0]).copy(alpha = if (off) 0.3f else 1f),
                    ),
                )
                Text(
                    s.label,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = if (off) 0.5f else 1f),
                    maxLines = 1,
                )
            }
        }
    }
}

private const val USAGE_FOOTER =
    "The subscription limits at the top are the 5-hour session window and the 7-day weekly window " +
        "of your Claude plan — a single pool shared across claude.ai, Claude Code and every other " +
        "Claude surface, so it moves for work done anywhere, not just here. There is no API for " +
        "those numbers: each host captures them from its own Claude Code and reports the snapshot, " +
        "which is why every card carries the moment it was taken and goes amber once it ages. " +
        "Claude Code computes them from the sessions on that machine, so they can trail the real " +
        "server-side counter — read them as headroom at a glance, not as the authoritative " +
        "balance. There is one card per subscription, not per host: hosts logged into the same " +
        "Claude account are reading and spending the same pool, so they fold into one card " +
        "listing them all, and each window shows the freshest reading any of them took. A host " +
        "whose agent is too old to say which account it's on stays on a card of its own. " +
        "Token figures are parsed from the Claude transcripts on each host and count every session it " +
        "has ever run — killed, deleted and pruned work included. Each host multiplexes worktree-backed " +
        "sessions. A new session gets a randomly-named worktree checked out in detached HEAD off the " +
        "latest default branch — the app creates no branch; the running agent branches its own work when " +
        "it's ready, and that live branch shows on the card. The ⌂ Repos root entry starts a session " +
        "directly at the repos root (spanning every repo), with no worktree or branch, one per host at a " +
        "time. \"Clone from GitHub\" pulls a repo into the repos root so it joins the list. \"+ New " +
        "session\" spawns instantly with today's defaults; the composer adds an initial prompt, a label, " +
        "and options (base branch, model, permission mode). Kill removes a session from the hub but keeps " +
        "its worktree, conversation and usage history — the \"Resume\" picker re-attaches to it. Delete " +
        "removes the worktree; committed branches survive, only uncommitted files are lost. \"Restart " +
        "(clear context)\" relaunches with a fresh transcript; Start continues the previous conversation. " +
        "\"Prune\" removes worktrees and branches merged into the default branch, leaving anything unmerged " +
        "or dirty untouched."

@Composable
private fun Stat(label: String, tokens: Long) {
    Column {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(fmtTokens(tokens), style = MaterialTheme.typography.headlineSmall)
    }
}

/**
 * The cache split under a token figure (web usage.html `cacheSubLine`). Omitted
 * entirely when a series reports no cache traffic — an older agent sends none,
 * and a bare "0 cached · 0 written" would read as caching being broken rather
 * than simply unreported.
 */
@Composable
private fun CacheLine(cache: UsageViewModel.CacheSummary) {
    if (!cache.any) return
    val hit = cache.hitPct
    Text(
        "${fmtTokens(cache.read)} cached · ${fmtTokens(cache.write)} written" +
            (if (hit == null) "" else " · $hit% hit"),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * The delegated share of the figures above (web usage.html `subagentCard`,
 * XERK-302). Says "of" rather than "plus" on purpose: these tokens are already
 * inside every total on this screen, and a reader who adds them back
 * double-counts.
 *
 * Omitted entirely when no host in view reports the split — an agent predating
 * the field can't answer, and "0% delegated" would be an answer.
 */
@Composable
private fun SubagentLine(sub: UsageViewModel.SubagentSplit) {
    if (!sub.any) return
    // The web card's three windows, in the one line this screen has room for. A
    // window with no spend has no share to take, so it is dropped rather than
    // drawn as 0% — same distinction the card makes with a dash.
    // Locale.US, not the device locale: these sit beside fmtTokens' output on
    // the same line and mirror the web card, which always renders "0.0%". An
    // ar-EG phone drew "today ٠٫٠%" next to a correct "9.0B".
    val windows = listOfNotNull(
        sub.todayPct?.let { String.format(Locale.US, "today %.1f%%", it) },
        sub.weekPct?.let { String.format(Locale.US, "7d %.1f%%", it) },
        sub.totalPct?.let { String.format(Locale.US, "all-time %.1f%%", it) },
    )
    if (windows.isEmpty()) return
    Text(
        "${fmtTokens(sub.total)} delegated to sub-agents · " + windows.joinToString(" · ") +
            (if (sub.partial) " (${sub.reporting} of ${sub.hosts} hosts report it)" else ""),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun UsageRow(
    name: String,
    today: Long,
    total: Long,
    fraction: Double,
    color: androidx.compose.ui.graphics.Color,
    cache: UsageViewModel.CacheSummary = UsageViewModel.CacheSummary(),
) {
    Column(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(name, Modifier.weight(1f), maxLines = 1)
            Text(fmtTokens(total), style = MaterialTheme.typography.bodyMedium)
        }
        Box(
            Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Box(
                Modifier.fillMaxHeight().clip(RoundedCornerShape(3.dp))
                    .background(color)
                    .fillMaxWidth(fraction.coerceIn(0.02, 1.0).toFloat())
            )
        }
        if (today > 0) Text(
            "today ${fmtTokens(today)}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        CacheLine(cache)
    }
}
