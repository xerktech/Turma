package com.xerktech.turma.ui

import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.VerbosityPrefs
import com.xerktech.turma.core.buildItems
import com.xerktech.turma.core.liveState
import com.xerktech.turma.core.scopedAgents
import com.xerktech.turma.core.sessionBranch
import com.xerktech.turma.core.sessionName
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.ClosedSessionInfo
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.vm.ArchiveViewModel
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
    // An ENDED session opened for read-only review (XERK-70): its transcript id
    // (the archive handle) + the closed record's id (for Resume). Distinct from
    // the live selection above — the two are mutually exclusive, so picking one
    // clears the other.
    var endHost by rememberSaveable { mutableStateOf<String?>(null) }
    var endTid by rememberSaveable { mutableStateOf<String?>(null) }
    var endId by rememberSaveable { mutableStateOf<String?>(null) }
    // A live subagent's transcript drilled into from the open session's status bar
    // (web openSubagentView): scoped to the live selection above, so Back returns to
    // that session's chat. Cleared whenever a different session/ended row is picked.
    var subType by rememberSaveable { mutableStateOf<String?>(null) }
    var subLabel by rememberSaveable { mutableStateOf<String?>(null) }
    val select: (String, String) -> Unit = { h, s ->
        endHost = null; endTid = null; endId = null; subType = null; subLabel = null; selHost = h; selId = s
    }
    val selectEnded: (String, String, String) -> Unit = { h, tid, id ->
        selHost = null; selId = null; subType = null; subLabel = null; endHost = h; endTid = tid; endId = id
    }
    val clearSub: () -> Unit = { subType = null; subLabel = null }
    val clear: () -> Unit = {
        selHost = null; selId = null; endHost = null; endTid = null; endId = null; subType = null; subLabel = null
    }
    val hasLive = !selHost.isNullOrEmpty() && !selId.isNullOrEmpty()
    val hasEnded = !endHost.isNullOrEmpty() && !endId.isNullOrEmpty()
    val hasSub = subType != null && hasLive
    val hasSel = hasLive || hasEnded

    val detail: @Composable () -> Unit = {
        // key() so switching sessions rebuilds the detail subtree (fresh VM + reveal).
        key(selHost, selId, endHost, endId, subType, subLabel) {
            when {
                hasSub -> SubagentView(
                    host = selHost.orEmpty(),
                    sessionId = selId.orEmpty(),
                    type = subType.orEmpty(),
                    label = subLabel.orEmpty(),
                    onBack = clearSub,
                )
                hasEnded -> EndedSessionView(
                    host = endHost.orEmpty(),
                    transcriptId = endTid.orEmpty(),
                    closedId = endId.orEmpty(),
                    onBack = clear,
                    onResumed = select,
                    showBack = !wide,
                )
                else -> ChatScreen(
                    host = selHost.orEmpty(),
                    sessionId = selId.orEmpty(),
                    onBack = clear,
                    onTerminal = { onTerminal(selHost.orEmpty(), selId.orEmpty()) },
                    showBack = !wide,
                    onOpenSubagent = { t, l -> subType = t; subLabel = l },
                )
            }
        }
    }

    // Narrow full-screen chat is selection state, not a nav destination, so the
    // Android back button would otherwise pop the whole Sessions tab. Intercept it
    // to clear the selection — Back returns to the list, like the top-bar arrow
    // (XERK-66). Scoped to the narrow case, where the arrow (showBack) also shows.
    BackHandler(enabled = !wide && hasSel) { if (hasSub) clearSub() else clear() }

    when {
        // Narrow + a session picked: full-screen chat, no bottom nav (web parity).
        !wide && hasSel -> detail()

        // Wide: list on the left, chat (or an empty prompt) on the right.
        wide -> MainScaffold(TopDest.SESSIONS, onNavigate) { m ->
            Row(m.fillMaxSize()) {
                SessionsListPane(
                    selectedKey = selKey(selHost, selId) ?: selKey(endHost, endId),
                    onSelect = select,
                    onSelectEnded = selectEnded,
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
            SessionsListPane(
                selectedKey = null, onSelect = select, onSelectEnded = selectEnded,
                onOpenArchive = onOpenArchive, modifier = m,
            )
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
    onSelectEnded: (String, String, String) -> Unit = { _, _, _ -> },
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
                        ClosedSessionCard(
                            c,
                            selected = selectedKey == c.host + "/" + c.closed.id,
                            // Tap the card body to review the chat read-only; the
                            // Resume button re-launches it live (XERK-70).
                            onOpen = { onSelectEnded(c.host, c.closed.transcriptId, c.closed.id) },
                            onResume = { vm.resume(c.host, c.closed.id); onSelect(c.host, c.closed.id) },
                        )
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ClosedSessionCard(c: FlatClosed, selected: Boolean, onOpen: () -> Unit, onResume: () -> Unit) {
    val cardMod = Modifier.fillMaxWidth().then(
        if (selected)
            Modifier.border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(14.dp))
        else Modifier,
    )
    TurmaCard(cardMod) {
        Row(
            // Tapping the card body opens the read-only chat review; Resume stays a
            // separate action (XERK-70), the same split the web ended row has.
            Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StateDot(com.xerktech.turma.core.LiveState.STOPPED)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(closedName(c.closed), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${c.device} · ${c.closed.repo.ifBlank { "—" }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                if (c.closed.prs.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        c.closed.prs.forEach { PrBadge(it) }
                    }
                }
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

/**
 * The read-only review of an ENDED session's conversation (XERK-70), the web
 * ended-session stage's counterpart (`#transcriptPane` in sessions.html): the
 * archived transcript rendered through the SAME `buildItems`/`ChatItemView`
 * engine the live chat uses, with a PR-chip + Resume bar and a verbosity control
 * — but deliberately NO compose box and no terminal (there is no live pty).
 *
 * The transcript is fetched from the hub's durable archive by transcript id, so
 * it opens even when the session's host is offline; Resume is gated on the host
 * being online. A record with no `transcriptId` (an agent predating the snapshot)
 * shows "no conversation recorded" and stays Resume-only.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun EndedSessionView(
    host: String,
    transcriptId: String,
    closedId: String,
    onBack: () -> Unit,
    onResumed: (String, String) -> Unit,
    showBack: Boolean,
    fleetVm: FleetViewModel = viewModel(),
    archiveVm: ArchiveViewModel = viewModel(),
) {
    val fleet by fleetVm.fleet.collectAsStateWithLifecycle()
    val arch by archiveVm.state.collectAsStateWithLifecycle()
    val agent = fleet.agents.firstOrNull { it.key == host }
    val closed = agent?.closedSessions?.firstOrNull { it.id == closedId }
    val online = agent?.online == true
    var verbosity by remember { mutableStateOf(Verbosity.VERBOSE) }

    // Keep the fleet polling in the narrow full-screen case, where the list pane
    // (which normally does this) isn't composed — the closed lookup + online gate
    // read the live snapshot. start() no-ops if already polling.
    LaunchedEffect(Unit) { fleetVm.start() }
    // Load once per transcript; drop it on the way out so a later re-open reloads.
    LaunchedEffect(transcriptId) { if (transcriptId.isNotBlank()) archiveVm.openTranscript(transcriptId) }
    DisposableEffect(transcriptId) { onDispose { archiveVm.closeTranscript() } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(closed?.let { closedName(it) } ?: "Ended session", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${agent?.device?.ifBlank { host } ?: host} · ${closed?.repo?.ifBlank { "—" } ?: "—"}",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                        )
                    }
                },
                navigationIcon = {
                    if (showBack) IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = {
                    VerbosityMenu(verbosity) { verbosity = it }
                    GhostButton("Resume", { fleetVm.resume(host, closedId); onResumed(host, closedId) }, enabled = online)
                },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            // PR chips (each links out to GitHub) on the stage bar, like the web.
            closed?.prs?.takeIf { it.isNotEmpty() }?.let { prs ->
                FlowRow(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) { prs.forEach { PrBadge(it) } }
            }
            // Guard on the loaded transcript's OWN id so a stale one from the
            // previously-open ended session never flashes before this one loads.
            val ready = arch.open?.takeIf { it.transcriptId == transcriptId }
            when {
                transcriptId.isBlank() -> EndedMessage("No conversation was recorded for this session.")
                ready != null -> {
                    val items = buildItems(ready.entries, VerbosityPrefs.forPreset(verbosity))
                    SelectionContainer(Modifier.fillMaxSize()) {
                        LazyColumn(
                            Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) { items(items.size) { i -> ChatItemView(items[i]) } }
                    }
                }
                arch.openLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> EndedMessage(
                    "This conversation hasn't reached the hub's archive yet — it syncs within a few minutes. Resume still works.",
                )
            }
        }
    }
}

/**
 * Read-only view of one live background agent's transcript (web `openSubagentView`
 * in sessions.html), reached by tapping a subagent row in the live chat's status
 * bar. Always drilled into FROM an open session, so Back returns to that chat (the
 * web's `subagentReturn`). Renders through the same `buildItems`/`ChatItemView`
 * engine and verbosity control as the ended-session review; no compose box.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SubagentView(
    host: String,
    sessionId: String,
    type: String,
    label: String,
    onBack: () -> Unit,
    vm: com.xerktech.turma.vm.SubagentViewModel = viewModel(),
) {
    val ui by vm.state.collectAsStateWithLifecycle()
    var verbosity by remember { mutableStateOf(Verbosity.VERBOSE) }
    LaunchedEffect(host, sessionId, type, label) { vm.open(host, sessionId, type, label) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(type.ifBlank { "Agent" }, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            label.ifBlank { "background agent" },
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Session") }
                },
                actions = { VerbosityMenu(verbosity) { verbosity = it } },
            )
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when {
                ui.entries.isNotEmpty() -> {
                    val items = buildItems(ui.entries, VerbosityPrefs.forPreset(verbosity))
                    SelectionContainer(Modifier.fillMaxSize()) {
                        LazyColumn(
                            Modifier.fillMaxSize(),
                            contentPadding = PaddingValues(12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) { items(items.size) { i -> ChatItemView(items[i]) } }
                    }
                }
                ui.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                else -> EndedMessage("Agent transcript unavailable.")
            }
        }
    }
}

@Composable
private fun EndedMessage(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(24.dp),
        )
    }
}
