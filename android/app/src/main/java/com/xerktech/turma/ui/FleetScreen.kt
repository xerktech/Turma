package com.xerktech.turma.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.LiveState
import com.xerktech.turma.core.liveState
import com.xerktech.turma.core.sessionBranch
import com.xerktech.turma.core.sessionName
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.RepoInfo
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.vm.FleetViewModel

@Composable
fun FleetScreen(
    onOpenChat: (String, String) -> Unit,
    modifier: Modifier = Modifier,
    vm: FleetViewModel = viewModel(),
) {
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) { vm.start() }
    LaunchedEffect(Unit) { vm.messages.collect { snackbar.showSnackbar(it) } }

    val expandedHosts = remember { mutableStateMapOf<String, Boolean>() }
    var spawnFor by remember { mutableStateOf<Triple<String, String, Boolean>?>(null) }
    var resumeFor by remember { mutableStateOf<Pair<String, RepoInfo>?>(null) }
    var actionsFor by remember { mutableStateOf<Pair<String, SessionInfo>?>(null) }
    var pruneFor by remember { mutableStateOf<Pair<String, String>?>(null) }

    Box(modifier) {
        Column(Modifier.fillMaxSize()) {
            ScreenHeader("Dashboard") {
                IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, "Refresh") }
            }
            LazyColumn(
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(8.dp, 2.dp, 8.dp, 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (fleet.agents.isEmpty()) {
                    item {
                        Text(
                            if (fleet.loading) "Loading fleet…" else (fleet.error ?: "No hosts reporting."),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(fleet.agents, key = { it.key }) { agent ->
                    HostSection(
                        agent = agent,
                        now = fleet.now.takeIf { it > 0 } ?: System.currentTimeMillis(),
                        expanded = expandedHosts[agent.key] ?: true,
                        onToggle = { expandedHosts[agent.key] = !(expandedHosts[agent.key] ?: true) },
                        onQuickSpawn = { host, repo -> vm.spawn(host, repo) },
                        onComposeSpawn = { host, repo, isRoot -> spawnFor = Triple(host, repo, isRoot) },
                        onResume = { host, repo -> resumeFor = host to repo },
                        onPrune = { host, repo -> pruneFor = host to repo },
                        onClone = { host, repo -> vm.clone(host, repo) },
                        onOpenSession = onOpenChat,
                        onSessionActions = { host, s -> actionsFor = host to s },
                    )
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(16.dp))
    }

    spawnFor?.let { (host, repo, isRoot) ->
        SpawnDialog(
            host = host, repo = repo, isRoot = isRoot,
            onDismiss = { spawnFor = null },
            onSpawn = { prompt, label, baseRef, model, mode ->
                vm.spawn(host, repo, prompt, label, baseRef, model, mode); spawnFor = null
            },
        )
    }
    resumeFor?.let { (host, repo) ->
        ResumeDialog(repo = repo, onDismiss = { resumeFor = null }, onPick = { tid, cwd ->
            vm.resumeTranscript(host, tid, cwd); resumeFor = null
        })
    }
    actionsFor?.let { (host, s) ->
        SessionActionsDialog(
            session = s,
            onDismiss = { actionsFor = null },
            onOpen = { onOpenChat(host, s.id); actionsFor = null },
            onKill = { vm.kill(host, s.id); actionsFor = null },
            onStart = { vm.start(host, s.id); actionsFor = null },
            onRestart = { vm.restart(host, s.id); actionsFor = null },
            onResume = { vm.resume(host, s.id); actionsFor = null },
            onDelete = { vm.delete(host, s.id); actionsFor = null },
        )
    }
    pruneFor?.let { (host, repo) ->
        ConfirmDialog(
            title = "Prune $repo?",
            message = "Removes worktrees whose commits are merged into the default branch and deletes merged local branches. Unmerged or dirty work is left alone.",
            confirmLabel = "Prune",
            onConfirm = { vm.prune(host, repo); pruneFor = null },
            onDismiss = { pruneFor = null },
        )
    }
}

/** The coding agent a host runs, for its header — mirrors index.html codingAgent(). */
fun codingAgentLabel(a: AgentInfo): String {
    val c = a.codingAgent
    if (c != null && c.version.isNotBlank()) return "${c.name.ifBlank { "Claude Code" }} ${c.version}"
    val raw = a.claudeVersion.trim()
    if (raw.isEmpty()) return "–"
    val m = Regex("^(\\S+)\\s+\\((.+)\\)$").find(raw)
    return if (m != null) "${m.groupValues[2]} ${m.groupValues[1]}" else "Claude Code $raw"
}

@Composable
private fun HostSection(
    agent: AgentInfo,
    now: Long,
    expanded: Boolean,
    onToggle: () -> Unit,
    onQuickSpawn: (String, String) -> Unit,
    onComposeSpawn: (String, String, Boolean) -> Unit,
    onResume: (String, RepoInfo) -> Unit,
    onPrune: (String, String) -> Unit,
    onClone: (String, String) -> Unit,
    onOpenSession: (String, String) -> Unit,
    onSessionActions: (String, SessionInfo) -> Unit,
) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(10.dp, 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Column(Modifier.weight(1f)) {
                    Text(agent.device.ifBlank { agent.key }, style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    Text(
                        "${codingAgentLabel(agent)} · Turma ${agent.agentVersion.ifBlank { "–" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
                Pill(if (agent.online) "online" else "offline", color = if (agent.online) com.xerktech.turma.ui.theme.TurmaColors.good else null)
            }
            AnimatedVisibility(expanded) {
                Column(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
                    CloneBar(agent, onClone = { repo -> onClone(agent.key, repo) })
                    for (repo in agent.repos) {
                        val sessions = agent.sessions.filter { if (repo.root) it.root else (!it.root && it.repo == repo.name) }
                        RepoSection(
                            repo = repo, sessions = sessions, now = now, hostLastSeen = agent.lastSeen,
                            onQuickSpawn = { onQuickSpawn(agent.key, repo.name) },
                            onComposeSpawn = { onComposeSpawn(agent.key, repo.name, repo.root) },
                            onResume = { onResume(agent.key, repo) },
                            onPrune = { onPrune(agent.key, repo.name) },
                            onOpenSession = { s -> onOpenSession(agent.key, s.id) },
                            onSessionActions = { s -> onSessionActions(agent.key, s) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RepoSection(
    repo: RepoInfo,
    sessions: List<SessionInfo>,
    now: Long,
    hostLastSeen: Long,
    onQuickSpawn: () -> Unit,
    onComposeSpawn: () -> Unit,
    onResume: () -> Unit,
    onPrune: () -> Unit,
    onOpenSession: (SessionInfo) -> Unit,
    onSessionActions: (SessionInfo) -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 30.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                if (repo.root) "⌂ Repos root" else repo.name,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
            )
            val rootBusy = repo.root && sessions.any { it.status == "running" }
            if (!rootBusy) {
                IconButton(onClick = onQuickSpawn, modifier = Modifier.size(32.dp)) { Icon(Icons.Filled.Add, "New session", Modifier.size(18.dp)) }
                IconButton(onClick = onComposeSpawn, modifier = Modifier.size(32.dp)) { Icon(Icons.Filled.Tune, "New session with options", Modifier.size(18.dp)) }
            }
            if (repo.resumable.isNotEmpty()) GhostButton("Resume", onResume)
            if (!repo.root) GhostButton("Prune", onPrune)
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(bottom = 4.dp)) {
            for (s in sessions) {
                SessionCard(
                    session = s,
                    state = liveState(s, hostLastSeen, now),
                    onClick = { onOpenSession(s) },
                    onActions = { onSessionActions(s) },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionCard(session: SessionInfo, state: LiveState, onClick: () -> Unit, onActions: () -> Unit) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 10.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            StateDot(state)
            // Name on one ellipsized line; branch/state/tokens wrap in a FlowRow;
            // any PR pill(s) sit on their OWN line below the info — never squeezing
            // the name into a many-line, oversized card.
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    sessionName(session),
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        sessionBranch(session),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text("· ${liveStateLabel(state)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    session.usage?.today?.total?.takeIf { it > 0 }?.let {
                        Text("· ${fmtTokens(it)} today", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    }
                }
                if (session.prs.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        session.prs.forEach { PrBadge(it) }
                    }
                }
            }
            IconButton(onClick = onActions) { Icon(Icons.Filled.MoreVert, "Actions", modifier = Modifier.size(20.dp)) }
        }
    }
}

/** Slim page header used on the top-level screens in place of the removed app bar. */
@Composable
fun ScreenHeader(title: String, actions: @Composable () -> Unit = {}) {
    Row(
        // Tight to the status bar: the Scaffold already insets past it, so only a
        // hair of top padding here keeps the title hugging the status bar.
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 2.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.weight(1f))
        actions()
    }
}
