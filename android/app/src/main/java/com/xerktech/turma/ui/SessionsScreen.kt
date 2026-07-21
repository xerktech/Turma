package com.xerktech.turma.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.liveState
import com.xerktech.turma.core.scopedAgents
import com.xerktech.turma.core.sessionBranch
import com.xerktech.turma.core.sessionName
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.ClosedSessionInfo
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.vm.FleetViewModel

/** One session flattened together with the host that owns it — the row unit. */
data class FlatSession(
    val host: String,
    val device: String,
    val online: Boolean,
    val hostLastSeen: Long,
    val session: SessionInfo,
)

/** Flatten every host's sessions into a single searchable list, running first. */
fun flattenSessions(
    agents: List<com.xerktech.turma.model.AgentInfo>,
    query: String,
): List<FlatSession> {
    val q = query.trim().lowercase()
    val all = agents.flatMap { a ->
        a.sessions.map { FlatSession(a.key, a.device.ifBlank { a.key }, a.online, a.lastSeen, it) }
    }
    val filtered = if (q.isEmpty()) all else all.filter {
        sessionName(it.session).lowercase().contains(q) ||
            it.session.repo.lowercase().contains(q) ||
            sessionBranch(it.session).lowercase().contains(q) ||
            it.device.lowercase().contains(q)
    }
    return filtered.sortedBy { it.session.status != "running" }
}

/** An online host and the repos a new session can be spawned in on it. */
data class SpawnHost(val key: String, val device: String, val repos: List<com.xerktech.turma.model.RepoInfo>)

/**
 * The spawn picker's source list — mirrors the web sessions sidebar's "New
 * session" section (each ONLINE host, its repos as spawn buttons). The repos-root
 * pseudo-repo is dropped while that host already runs a root session (only one is
 * allowed per host), matching the dashboard's hidden "+ New session" there. A host
 * left with no spawnable repo is omitted.
 */
fun spawnTargets(agents: List<AgentInfo>): List<SpawnHost> =
    agents.filter { it.online }
        .map { a ->
            val repos = a.repos.filter { repo ->
                !repo.root || a.sessions.none { it.root && it.status == "running" }
            }
            SpawnHost(a.key, a.device.ifBlank { a.key }, repos)
        }
        .filter { it.repos.isNotEmpty() }

/** Identity of the session currently open in the detail pane. */
private fun selKey(host: String?, id: String?): String? =
    if (!host.isNullOrEmpty() && !id.isNullOrEmpty()) "$host/$id" else null

/**
 * The adaptive Sessions screen. Selection is hoisted here and [rememberSaveable],
 * so it survives the configuration change a foldable's fold/unfold triggers — the
 * same session stays open as the layout reflows between the two forms:
 *  - wide (tablet / unfolded): list-detail two-pane, like the web sessions page;
 *  - narrow (phone / folded): the list, or a full-screen chat once a session is
 *    picked (bottom-nav dropped, matching the web's full-screen terminal).
 */
@Composable
fun SessionsRoute(
    wide: Boolean,
    onNavigate: (TopDest) -> Unit,
    onTerminal: (String, String) -> Unit,
    onOpenArchive: () -> Unit = {},
) {
    var selHost by rememberSaveable { mutableStateOf<String?>(null) }
    var selId by rememberSaveable { mutableStateOf<String?>(null) }
    val select: (String, String) -> Unit = { h, s -> selHost = h; selId = s }
    val clear: () -> Unit = { selHost = null; selId = null }
    val hasSel = !selHost.isNullOrEmpty() && !selId.isNullOrEmpty()

    val detail: @Composable () -> Unit = {
        // key() so switching sessions rebuilds the chat subtree (fresh VM + reveal).
        key(selHost, selId) {
            ChatScreen(
                host = selHost.orEmpty(),
                sessionId = selId.orEmpty(),
                onBack = clear,
                onTerminal = { onTerminal(selHost.orEmpty(), selId.orEmpty()) },
                showBack = !wide,
            )
        }
    }

    when {
        // Narrow + a session picked: full-screen chat, no bottom nav (web parity).
        !wide && hasSel -> detail()

        // Wide: list on the left, chat (or an empty prompt) on the right.
        wide -> MainScaffold(TopDest.SESSIONS, onNavigate) { m ->
            Row(m.fillMaxSize()) {
                SessionsListPane(
                    selectedKey = selKey(selHost, selId),
                    onSelect = select,
                    onOpenArchive = onOpenArchive,
                    modifier = Modifier.width(360.dp).fillMaxHeight(),
                )
                VerticalDivider()
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    if (hasSel) detail() else DetailEmpty()
                }
            }
        }

        // Narrow, nothing picked: just the list.
        else -> MainScaffold(TopDest.SESSIONS, onNavigate) { m ->
            SessionsListPane(selectedKey = null, onSelect = select, onOpenArchive = onOpenArchive, modifier = m)
        }
    }
}

/** Placeholder shown in the wide detail pane before a session is picked. */
@Composable
private fun DetailEmpty() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            "Select a session to open its conversation.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(24.dp),
        )
    }
}

@Composable
fun SessionsListPane(
    selectedKey: String?,
    onSelect: (String, String) -> Unit,
    onOpenArchive: () -> Unit = {},
    modifier: Modifier = Modifier,
    vm: FleetViewModel = viewModel(),
) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val org by vm.orgFilter.collectAsStateWithLifecycle()
    var query by remember { mutableStateOf("") }
    val now = fleet.now.takeIf { it > 0 } ?: System.currentTimeMillis()
    // Scoped by the header's org control (XERK-62) before anything is built from
    // it, so the lists AND the new-session host picker narrow together — a host
    // polls exactly one org, so scoping the agent list scopes all three.
    val agents = remember(fleet.agents, org) { scopedAgents(fleet.agents, org) }
    val rows = remember(agents, query) { flattenSessions(agents, query) }
    val ended = remember(agents, query) { flattenClosed(agents, query) }
    var endedOpen by remember { mutableStateOf(false) }
    // New-session picker: pick an online host + repo, then the spawn composer.
    var pickerOpen by remember { mutableStateOf(false) }
    var spawnFor by remember { mutableStateOf<Triple<String, String, Boolean>?>(null) }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Sessions") {
            IconButton(onClick = { pickerOpen = true }) { Icon(Icons.Filled.Add, "New session") }
            // Full-history archive + FTS search (offline hosts included) — the
            // live box below only filters the sessions currently in the fleet.
            IconButton(onClick = onOpenArchive) { Icon(Icons.Filled.Search, "Search all history") }
        }
        TurmaField(query, { query = it }, "Filter these sessions", Modifier.fillMaxWidth().padding(10.dp, 2.dp))
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(10.dp, 4.dp, 10.dp, 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (rows.isEmpty() && ended.isEmpty()) {
                item {
                    Text(
                        when {
                            // Say which of the two it is: a fleet with no sessions
                            // reads very differently from one the org filter
                            // narrowed to nothing, and only one has a way out.
                            fleet.agents.isNotEmpty() && agents.isEmpty() ->
                                "No hosts report this org. Pick another org (or “All orgs”) in the header."
                            fleet.loading -> "Loading…"
                            else -> "No sessions."
                        },
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(rows, key = { it.host + "/" + it.session.id }) { r ->
                SessionListCard(r, now, selected = selectedKey == r.host + "/" + r.session.id) {
                    onSelect(r.host, r.session.id)
                }
            }
            // Ended sessions: killed but resumable — its own collapsible section.
            if (ended.isNotEmpty()) {
                item(key = "ended-header") {
                    Row(
                        Modifier.fillMaxWidth().clickable { endedOpen = !endedOpen }.padding(top = 6.dp, bottom = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Icon(
                            if (endedOpen) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        SectionLabel("Ended sessions (${ended.size})")
                    }
                }
                if (endedOpen) {
                    items(ended, key = { "closed:" + it.host + "/" + it.closed.id }) { c ->
                        ClosedSessionCard(c) { vm.resume(c.host, c.closed.id); onSelect(c.host, c.closed.id) }
                    }
                }
            }
        }
    }

    if (pickerOpen) {
        NewSessionPickerDialog(
            targets = remember(agents) { spawnTargets(agents) },
            onDismiss = { pickerOpen = false },
            onPick = { host, repo, isRoot -> pickerOpen = false; spawnFor = Triple(host, repo, isRoot) },
        )
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
}

data class FlatClosed(val host: String, val device: String, val closed: ClosedSessionInfo)

fun flattenClosed(agents: List<AgentInfo>, query: String): List<FlatClosed> {
    val q = query.trim().lowercase()
    val all = agents.flatMap { a -> a.closedSessions.map { FlatClosed(a.key, a.device.ifBlank { a.key }, it) } }
    return if (q.isEmpty()) all else all.filter {
        (it.closed.summary + " " + it.closed.label + " " + it.closed.repo + " " + it.closed.branch + " " + it.device)
            .lowercase().contains(q)
    }
}

fun closedName(c: ClosedSessionInfo): String =
    c.summary.ifBlank { c.label.ifBlank { c.branch.ifBlank { c.id.take(6) } } }

@Composable
private fun ClosedSessionCard(c: FlatClosed, onResume: () -> Unit) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StateDot(com.xerktech.turma.core.LiveState.STOPPED)
            Column(Modifier.weight(1f)) {
                Text(closedName(c.closed), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${c.device} · ${c.closed.repo.ifBlank { "—" }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
            GhostButton("Resume", onResume)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionListCard(r: FlatSession, now: Long, selected: Boolean, onClick: () -> Unit) {
    val cardMod = Modifier.fillMaxWidth().then(
        if (selected)
            Modifier.border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(14.dp))
        else Modifier,
    )
    TurmaCard(cardMod) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StateDot(liveState(r.session, r.hostLastSeen, now))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(sessionName(r.session), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(r.device, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    Text(
                        "· ${sessionBranch(r.session)}",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // PRs on their own row at the BOTTOM of the card, not the right side.
                if (r.session.prs.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        r.session.prs.forEach { PrBadge(it) }
                    }
                }
            }
        }
    }
}
