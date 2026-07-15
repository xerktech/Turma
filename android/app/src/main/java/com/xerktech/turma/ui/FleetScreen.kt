package com.xerktech.turma.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FleetScreen(
    onOpenChat: (String, String) -> Unit,
    onUsage: () -> Unit,
    onArchive: () -> Unit,
    onSettings: () -> Unit,
    vm: FleetViewModel = viewModel(),
) {
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) { vm.start() }
    LaunchedEffect(Unit) { vm.messages.collect { snackbar.showSnackbar(it) } }

    // UI-only expansion + dialog state.
    val expandedHosts = remember { mutableStateMapOf<String, Boolean>() }
    var spawnFor by remember { mutableStateOf<Triple<String, String, Boolean>?>(null) } // host, repo, isRoot
    var resumeFor by remember { mutableStateOf<Pair<String, RepoInfo>?>(null) }
    var actionsFor by remember { mutableStateOf<Pair<String, SessionInfo>?>(null) }
    var pruneFor by remember { mutableStateOf<Pair<String, String>?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Turma") },
                actions = {
                    IconButton(onClick = onArchive) { Icon(Icons.Filled.Search, "Search / archive") }
                    IconButton(onClick = onUsage) { Icon(Icons.Filled.BarChart, "Usage") }
                    IconButton(onClick = { vm.refresh() }) { Icon(Icons.Filled.Refresh, "Refresh") }
                    IconButton(onClick = onSettings) { Icon(Icons.Filled.Settings, "Settings") }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad)) {
            if (fleet.agents.isEmpty()) {
                item {
                    Text(
                        if (fleet.loading) "Loading fleet…" else (fleet.error ?: "No hosts reporting."),
                        Modifier.padding(24.dp),
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
                HorizontalDivider()
            }
        }
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
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onToggle).padding(16.dp, 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null)
            Text(agent.device.ifBlank { agent.key }, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Pill(if (agent.online) "online" else "offline")
        }
        AnimatedVisibility(expanded) {
            Column(Modifier.fillMaxWidth()) {
                CloneBar(agent, onClone = { repo -> onClone(agent.key, repo) })
                for (repo in agent.repos) {
                    val sessions = agent.sessions.filter { if (repo.root) it.root else (!it.root && it.repo == repo.name) }
                    RepoSection(
                        host = agent.key, repo = repo, sessions = sessions, now = now, hostLastSeen = agent.lastSeen,
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

@Composable
private fun RepoSection(
    host: String,
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
    Column(Modifier.fillMaxWidth().padding(start = 12.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(8.dp, 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                if (repo.root) "⌂ Repos root" else repo.name,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            // One root session at a time — hide "+ New" once a root session exists.
            val rootBusy = repo.root && sessions.any { it.status == "running" }
            if (!rootBusy) {
                IconButton(onClick = onQuickSpawn) { Icon(Icons.Filled.Add, "New session") }
                IconButton(onClick = onComposeSpawn) { Icon(Icons.Filled.Tune, "New session with options") }
            }
            if (repo.resumable.isNotEmpty()) TextButton(onClick = onResume) { Text("Resume") }
            if (!repo.root) TextButton(onClick = onPrune) { Text("Prune") }
        }
        for (s in sessions) {
            SessionRow(
                session = s,
                state = liveState(s, hostLastSeen, now),
                onClick = { onOpenSession(s) },
                onActions = { onSessionActions(s) },
            )
        }
    }
}

@Composable
private fun SessionRow(session: SessionInfo, state: LiveState, onClick: () -> Unit, onActions: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StateDot(state)
        Column(Modifier.weight(1f)) {
            Text(sessionName(session), fontWeight = FontWeight.Medium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    sessionBranch(session),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text("· ${liveStateLabel(state)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                session.usage?.today?.total?.takeIf { it > 0 }?.let {
                    Text(
                        "· ${fmtTokens(it)} today",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        session.prs.firstOrNull()?.let { PrBadge(it) }
        IconButton(onClick = onActions) { Icon(Icons.Filled.MoreVert, "Actions", modifier = Modifier.size(20.dp)) }
    }
}
