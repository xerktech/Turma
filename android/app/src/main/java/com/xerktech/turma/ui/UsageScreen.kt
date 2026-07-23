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
import com.xerktech.turma.core.scopedAgents
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.UsageViewModel

/** Compact token count: 1.2M / 3.4k / 850. Mirrors the web UI's fmtTokens. */
fun fmtTokens(n: Long): String = when {
    n >= 1_000_000_000 -> "%.1fB".format(n / 1e9)
    n >= 1_000_000 -> "%.1fM".format(n / 1e6)
    n >= 1_000 -> "%.1fk".format(n / 1e3)
    else -> n.toString()
}

/** One chart/legend series — the selected grouping's rows in stable paint order. */
private data class UsageSeries(
    val skey: String,
    val label: String,
    val today: Long,
    val total: Long,
    val days: Map<String, Long>,
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
    val ui = remember(fleet, org) {
        UsageViewModel.compute(fleet.copy(agents = scopedAgents(fleet.agents, org)))
    }
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
            0 -> ui.byRepo.map { UsageSeries(it.skey, it.repo, it.today, it.total, it.days) }
                .sortedWith(compareBy({ it.label }, { it.skey }))
            1 -> ui.byHost.map { UsageSeries(it.skey, it.host, it.today, it.total, it.days) }
                .sortedWith(compareBy({ it.label }, { it.skey }))
            // Models keep biggest-consumer-first (no chart, no legend).
            else -> ui.byModel.map { UsageSeries("model::" + it.model, it.model, it.today, it.total, emptyMap()) }
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
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Stat("Today", ui.today)
            Stat("This week", ui.week)
            Stat("All-time", ui.total)
        }
        TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
            Tab(selected = tab == 0, onClick = { setTab(0) }, text = { Text("By repo") })
            Tab(selected = tab == 1, onClick = { setTab(1) }, text = { Text("By host") })
            Tab(selected = tab == 2, onClick = { setTab(2) }, text = { Text("By model") })
        }
        LazyColumn(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
                UsageRow(s.label, s.today, s.total, s.total.toDouble() / maxTotal, color)
            }
            if (rows.isEmpty()) item {
                Text(
                    // An org whose hosts reported nothing yet vs a fleet that has:
                    // only the first has a way out, and it's the header control.
                    when {
                        ordered.isNotEmpty() -> "All series are toggled off — tap the legend to bring one back."
                        fleet.agents.isNotEmpty() && org.isNotBlank() ->
                            "No usage reported for this org. Pick another org (or “All orgs”) in the header."
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

@Composable
private fun UsageRow(name: String, today: Long, total: Long, fraction: Double, color: androidx.compose.ui.graphics.Color) {
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
    }
}
