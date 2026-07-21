package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.scopedAgents
import com.xerktech.turma.vm.UsageViewModel

/** Compact token count: 1.2M / 3.4k / 850. Mirrors the web UI's fmtTokens. */
fun fmtTokens(n: Long): String = when {
    n >= 1_000_000_000 -> "%.1fB".format(n / 1e9)
    n >= 1_000_000 -> "%.1fM".format(n / 1e6)
    n >= 1_000 -> "%.1fk".format(n / 1e3)
    else -> n.toString()
}

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
    var tab by remember { mutableIntStateOf(0) }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Usage")
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Stat("Today", ui.today)
            Stat("This week", ui.week)
            Stat("All-time", ui.total)
        }
        TabRow(selectedTabIndex = tab, containerColor = MaterialTheme.colorScheme.background) {
            Tab(selected = tab == 0, onClick = { tab = 0 }, text = { Text("By repo") })
            Tab(selected = tab == 1, onClick = { tab = 1 }, text = { Text("By host") })
            Tab(selected = tab == 2, onClick = { tab = 2 }, text = { Text("By model") })
        }
        val rows: List<Triple<String, Long, Long>> = when (tab) {
            0 -> ui.byRepo.map { Triple(it.repo, it.today, it.total) }
            1 -> ui.byHost.map { Triple(it.host, it.today, it.total) }
            else -> ui.byModel.map { Triple(it.model, it.today, it.total) }
        }
        val maxTotal = rows.maxOfOrNull { it.third }?.takeIf { it > 0 } ?: 1L
        LazyColumn(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(rows.size) { i ->
                val (name, today, total) = rows[i]
                UsageRow(name, today, total, total.toDouble() / maxTotal)
            }
            if (rows.isEmpty()) item {
                Text(
                    // An org whose hosts reported nothing yet vs a fleet that has:
                    // only the first has a way out, and it's the header control.
                    if (fleet.agents.isNotEmpty() && org.isNotBlank())
                        "No usage reported for this org. Pick another org (or “All orgs”) in the header."
                    else "No usage recorded yet.",
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
private fun UsageRow(name: String, today: Long, total: Long, fraction: Double) {
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
                    .background(MaterialTheme.colorScheme.primary)
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
