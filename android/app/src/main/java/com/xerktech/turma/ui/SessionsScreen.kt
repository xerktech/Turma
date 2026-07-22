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
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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

// ---- the ended-sessions merge (web sessions.html collect(), XERK-78) ---------
//
// A session is "ended" if it is over but still resumable, and that covers three
// records the agent reports through DIFFERENT channels — killed (its closed
// record), stopped (a non-running registry record), and resumable (the durable
// per-repo transcript scan). The operator draws no distinction, so they land in
// one list, deduped on <host>::<transcriptId> with the registry-backed record
// winning (only it knows the session's id, PRs and rename), sorted most
// recently ended first. `kind` is what Resume dispatches on: closed → resume
// (same id), stopped → start, resumable → resumeTranscript at its origin cwd.

/** Which channel reported an ended session — decides its Resume dispatch. */
enum class EndedKind { STOPPED, CLOSED, RESUMABLE }

data class EndedSession(
    val host: String,
    val device: String,
    val online: Boolean,
    val kind: EndedKind,
    /** Session id for a registry-backed record; "t:<transcriptId>" for a
     *  resumable row (it never had one — the transcript is its only identity). */
    val id: String,
    val transcriptId: String,
    val repo: String,
    val name: String,
    val status: String = "",
    val errorMsg: String = "",
    /** ISO ended stamp (closedAt / stoppedAt / endedTs); "" when unrecorded. */
    val endedAt: String = "",
    /** Sort key parsed from [endedAt]; 0 (oldest) for an undated record. */
    val endedMs: Long = 0,
    val prs: List<com.xerktech.turma.model.PrInfo> = emptyList(),
    /** The origin cwd a resumable row relaunches at (resumeTranscript body). */
    val cwd: String = "",
)

/** The sidebar's three lists in one pass — running, queued (FIFO), ended. */
data class SessionLists(
    val running: List<FlatSession>,
    val queued: List<FlatSession>,
    val ended: List<EndedSession>,
)

private fun parseIso(s: String): Long =
    if (s.isBlank()) 0 else runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrDefault(0)

fun collectSessions(agents: List<AgentInfo>, query: String): SessionLists {
    val q = query.trim().lowercase()
    fun matches(vararg fields: String) =
        q.isEmpty() || fields.joinToString(" ").lowercase().contains(q)

    val running = ArrayList<FlatSession>()
    val queued = ArrayList<FlatSession>()
    val ended = ArrayList<EndedSession>()
    // <host>::<transcriptId> of every session a registry-backed record covers —
    // a killed session is reported through BOTH its closed record and (once the
    // slow scan catches up) `resumable`, and the two must collapse to one row.
    val carded = HashSet<String>()
    fun key(host: String, tid: String) = "$host::$tid"

    for (a in agents) {
        val host = a.key
        val device = a.device.ifBlank { a.key }
        for (s in a.sessions) {
            if (s.transcriptId.isNotBlank()) carded.add(key(host, s.transcriptId))
            val flat = FlatSession(host, device, a.online, a.lastSeen, s)
            val nameMatch = matches(sessionName(s), s.repo, sessionBranch(s), device)
            when (s.status) {
                "running" -> if (nameMatch) running.add(flat)
                // Upcoming, not ended: a record with no worktree yet, provisioned
                // when a slot frees / its clone lands (the agent's _drain_queue).
                "queued" -> if (nameMatch) queued.add(flat)
                else -> if (nameMatch) ended.add(
                    EndedSession(
                        host = host, device = device, online = a.online,
                        kind = EndedKind.STOPPED, id = s.id,
                        transcriptId = s.transcriptId, repo = s.repo,
                        name = sessionName(s), status = s.status, errorMsg = s.errorMsg,
                        endedAt = s.stoppedAt, endedMs = parseIso(s.stoppedAt),
                        prs = s.prs,
                    ),
                )
            }
        }
        for (c in a.closedSessions) {
            if (c.transcriptId.isNotBlank()) carded.add(key(host, c.transcriptId))
            if (!matches(closedName(c), c.repo, c.branch, device)) continue
            ended.add(
                EndedSession(
                    host = host, device = device, online = a.online,
                    kind = EndedKind.CLOSED, id = c.id,
                    transcriptId = c.transcriptId, repo = c.repo,
                    name = closedName(c),
                    endedAt = c.closedAt, endedMs = parseIso(c.closedAt),
                    prs = c.prs,
                ),
            )
        }
    }
    // Second pass, so a resumable row is only ever a fallback for a session no
    // record above already speaks for.
    for (a in agents) {
        for (r in a.repos) for (t in r.resumable) {
            if (t.transcriptId.isBlank() || !carded.add(key(a.key, t.transcriptId))) continue
            val name = t.summary.ifBlank { t.transcriptId.take(8) }
            if (!matches(name, t.repo, a.device.ifBlank { a.key })) continue
            ended.add(
                EndedSession(
                    host = a.key, device = a.device.ifBlank { a.key }, online = a.online,
                    kind = EndedKind.RESUMABLE, id = "t:" + t.transcriptId,
                    transcriptId = t.transcriptId, repo = t.repo,
                    name = name,
                    endedAt = t.endedTs, endedMs = parseIso(t.endedTs),
                    prs = t.prs,
                    cwd = t.cwd,
                ),
            )
        }
    }
    // Most recently ended first; ties (and undated records) fall back to the id
    // so the order is at least stable across beats. Queued oldest-first — FIFO,
    // the order the agent's _drain_queue will start them.
    ended.sortWith(compareByDescending<EndedSession> { it.endedMs }.thenBy { it.id })
    queued.sortBy { it.session.queuedAt }
    return SessionLists(running, queued, ended)
}

/** Human text for why a queued session hasn't started yet (web queuedReasonText). */
fun queuedReasonText(reason: String): String = when (reason) {
    "capacity" -> "waiting for a free session slot"
    "awaiting-clone" -> "cloning the repo first"
    "root-busy" -> "waiting for the repos-root slot"
    else -> "waiting to start"
}

/** The row's state word: killed/stopped/failed/ended (web endedRow `state`). */
fun endedStateText(e: EndedSession): String = when {
    e.kind == EndedKind.CLOSED -> "killed"
    // A resumable row is a bare transcript: nothing recorded WHY it ended, only
    // that it did, so it says the one thing that's true of all of them.
    e.kind == EndedKind.RESUMABLE -> "ended"
    e.status == "error" -> "failed"
    else -> "stopped"
}

/** One running session tagged with its live state — the row unit for the ranked
 *  Active/Idle lists. */
data class RankedSession(val flat: FlatSession, val state: com.xerktech.turma.core.LiveState)

/** Attention rank for the running lists — waiting, then working, then idle,
 *  matching the web sidebar's KIND_ORDER. */
private val KIND_RANK = mapOf(
    com.xerktech.turma.core.LiveState.WAITING to 0,
    com.xerktech.turma.core.LiveState.WORKING to 1,
    com.xerktech.turma.core.LiveState.IDLE to 2,
)

/**
 * The running sessions split into the web sessions sidebar's two live groups —
 * Active (attention-worthy: waiting + working) and Idle — each ranked as the web's
 * `collect()` does: attention-first by [KIND_RANK], then freshest activity first.
 * Freshest-first is ascending transcript age; a session with no transcript yet
 * (null age) sorts first, exactly as the web's `?? -1` fallback. Returns
 * (active, idle). Only status=="running" sessions are ranked here; stopped/queued
 * records are handled separately by the caller.
 */
fun rankRunning(rows: List<FlatSession>, now: Long): Pair<List<RankedSession>, List<RankedSession>> {
    val running = rows.asSequence()
        .filter { it.session.status == "running" }
        .map { RankedSession(it, liveState(it.session, it.hostLastSeen, now)) }
        .sortedWith(
            compareBy<RankedSession> { KIND_RANK[it.state] ?: 3 }
                .thenBy { it.flat.session.session?.transcriptAgeSec ?: -1.0 },
        )
        .toList()
    return running.filter { it.state != com.xerktech.turma.core.LiveState.IDLE } to
        running.filter { it.state == com.xerktech.turma.core.LiveState.IDLE }
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
    // An ENDED session opened for read-only review (XERK-70): keyed on its
    // transcript id, the one handle all three ended channels share (the view
    // itself re-resolves the entry — and its Resume dispatch — from the fleet).
    // Distinct from the live selection above — the two are mutually exclusive,
    // so picking one clears the other.
    var endHost by rememberSaveable { mutableStateOf<String?>(null) }
    var endTid by rememberSaveable { mutableStateOf<String?>(null) }
    // A live subagent's transcript drilled into from the open session's status bar
    // (web openSubagentView): scoped to the live selection above, so Back returns to
    // that session's chat. Cleared whenever a different session/ended row is picked.
    var subType by rememberSaveable { mutableStateOf<String?>(null) }
    var subLabel by rememberSaveable { mutableStateOf<String?>(null) }
    val select: (String, String) -> Unit = { h, s ->
        endHost = null; endTid = null; subType = null; subLabel = null; selHost = h; selId = s
    }
    val selectEnded: (String, String) -> Unit = { h, tid ->
        selHost = null; selId = null; subType = null; subLabel = null; endHost = h; endTid = tid
    }
    val clearSub: () -> Unit = { subType = null; subLabel = null }
    val clear: () -> Unit = {
        selHost = null; selId = null; endHost = null; endTid = null; subType = null; subLabel = null
    }
    val hasLive = !selHost.isNullOrEmpty() && !selId.isNullOrEmpty()
    val hasEnded = !endHost.isNullOrEmpty() && !endTid.isNullOrEmpty()
    val hasSub = subType != null && hasLive
    val hasSel = hasLive || hasEnded

    val detail: @Composable () -> Unit = {
        // key() so switching sessions rebuilds the detail subtree (fresh VM + reveal).
        key(selHost, selId, endHost, endTid, subType, subLabel) {
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
                    selectedKey = selKey(selHost, selId) ?: selKey(endHost, endTid),
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
    onSelectEnded: (String, String) -> Unit = { _, _ -> },
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
    // Running / queued / ended in one pass (web sessions.html collect()): the
    // live lists carry only running sessions; queued get their own section; a
    // non-running registry record lands in Ended with the killed + resumable
    // channels, deduped on <host>::<transcriptId>.
    val lists = remember(agents, query) { collectSessions(agents, query) }
    // The live sessions split into the web's Active (waiting/working) and Idle
    // sections, each ranked attention-first / freshest-first (XERK-73).
    val (active, idle) = remember(lists, now) { rankRunning(lists.running, now) }
    val queued = lists.queued
    val ended = lists.ended
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
            val anyRows = lists.running.isNotEmpty() || queued.isNotEmpty()
            if (!anyRows && ended.isEmpty()) {
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
            // Queued sessions: waiting for a slot, a clone, or the root slot.
            // Above the live lists — they're the work about to start. Cancelable
            // but not attachable (there's no pane yet).
            if (queued.isNotEmpty()) {
                item(key = "queued-header") { SectionLabel("Queued (${queued.size})", Modifier.padding(top = 6.dp, bottom = 2.dp)) }
                items(queued, key = { "q:" + it.host + "/" + it.session.id }) { r ->
                    QueuedSessionCard(r, now, onCancel = { vm.kill(r.host, r.session.id) })
                }
            }
            // Active: sessions wanting attention (waiting on you, or working). The
            // header shows even when empty, so "nothing active right now" reads as
            // a state rather than a missing section — matching the web sidebar.
            if (anyRows || ended.isNotEmpty()) {
                item(key = "active-header") { SectionLabel("Active (${active.size})", Modifier.padding(top = 6.dp, bottom = 2.dp)) }
                if (active.isEmpty()) {
                    item(key = "active-empty") {
                        Text(
                            if (idle.isNotEmpty()) "No active sessions. See Idle below." else "No active sessions.",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(vertical = 4.dp),
                        )
                    }
                }
                items(active, key = { "a:" + it.flat.host + "/" + it.flat.session.id }) { r ->
                    SessionListCard(
                        r.flat, now,
                        selected = selectedKey == r.flat.host + "/" + r.flat.session.id,
                        onKill = { vm.kill(r.flat.host, r.flat.session.id) },
                        onRename = { name -> vm.setSummary(r.flat.host, r.flat.session.id, name) },
                        onClick = { onSelect(r.flat.host, r.flat.session.id) },
                    )
                }
            }
            // Idle: live and attachable, just quiet — shown only when non-empty.
            if (idle.isNotEmpty()) {
                item(key = "idle-header") { SectionLabel("Idle (${idle.size})", Modifier.padding(top = 6.dp, bottom = 2.dp)) }
                items(idle, key = { "i:" + it.flat.host + "/" + it.flat.session.id }) { r ->
                    SessionListCard(
                        r.flat, now,
                        selected = selectedKey == r.flat.host + "/" + r.flat.session.id,
                        onKill = { vm.kill(r.flat.host, r.flat.session.id) },
                        onRename = { name -> vm.setSummary(r.flat.host, r.flat.session.id, name) },
                        onClick = { onSelect(r.flat.host, r.flat.session.id) },
                    )
                }
            }
            // Ended sessions: over but resumable, whatever channel reported them
            // (stopped / killed / the durable transcript scan) — its own
            // collapsible section, most recently ended first.
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
                    items(ended, key = { "ended:" + it.host + "/" + it.id }) { e ->
                        EndedSessionRow(
                            e, now,
                            selected = selectedKey == e.host + "/" + e.transcriptId,
                            // Tap the card body to review the chat read-only; the
                            // Resume button re-launches it live (XERK-70).
                            onOpen = { onSelectEnded(e.host, e.transcriptId) },
                            onResume = { resumeEnded(vm, e); if (e.kind != EndedKind.RESUMABLE) onSelect(e.host, e.id) },
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

fun closedName(c: ClosedSessionInfo): String =
    c.summary.ifBlank { c.label.ifBlank { c.branch.ifBlank { c.id.take(6) } } }

/**
 * Bring an ended session back, dispatching on which channel reported it (web
 * resumeEnded): a KILLED session was dropped from the registry and comes back
 * via `resume` (same id); a merely stopped one still has its record and just
 * needs `start`; one recovered by the transcript scan has no record at all, so
 * `resumeTranscript` relaunches it at its own origin cwd under a NEW id.
 */
fun resumeEnded(vm: FleetViewModel, e: EndedSession) = when (e.kind) {
    EndedKind.CLOSED -> vm.resume(e.host, e.id)
    EndedKind.STOPPED -> vm.start(e.host, e.id)
    EndedKind.RESUMABLE -> vm.resumeTranscript(e.host, e.transcriptId, e.cwd)
}

/**
 * A queued session card (web queuedCard): not attachable (no pane yet), so the
 * body is inert — it shows the wait reason + how long it's been queued, and the
 * one action is an inline arm/confirm Cancel (the same kill path; a queued
 * record has no worktree to tear down).
 */
@Composable
private fun QueuedSessionCard(r: FlatSession, now: Long, onCancel: () -> Unit) {
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(KILL_ARM_MS); armed = false } }
    TurmaCard(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().padding(start = 10.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StateDot(com.xerktech.turma.core.LiveState.WAITING)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(sessionName(r.session), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val ticket = r.session.ticket?.key?.takeIf { it.isNotBlank() }?.let { " · $it" }.orEmpty()
                Text(
                    "${r.session.id} · ${r.session.repo.ifBlank { "?" }} · ${r.device}$ticket",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                val since = r.session.queuedAt.takeIf { it.isNotBlank() }
                    ?.let { " · " + com.xerktech.turma.core.ageStr(it, now) }.orEmpty()
                Text(
                    queuedReasonText(r.session.queuedReason) + since,
                    style = MaterialTheme.typography.bodySmall,
                    color = com.xerktech.turma.ui.theme.TurmaColors.waiting,
                    maxLines = 1,
                )
            }
            GhostButton(
                if (armed) "Confirm" else "Cancel",
                onClick = { if (armed) { armed = false; onCancel() } else armed = true },
            )
        }
    }
}

/** One ended session's row, whatever channel reported it (web endedRow). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EndedSessionRow(e: EndedSession, now: Long, selected: Boolean, onOpen: () -> Unit, onResume: () -> Unit) {
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
                Text(e.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                // A resumable row is keyed on a 36-char transcript UUID; shorten it
                // to the same visual weight as a session id (web endedRowId).
                val rowId = if (e.kind == EndedKind.RESUMABLE) e.transcriptId.take(8) else e.id
                Text(
                    "$rowId · ${e.repo.ifBlank { "—" }} · ${e.device}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                val when_ = e.endedAt.takeIf { it.isNotBlank() }
                    ?.let { com.xerktech.turma.core.ageStr(it, now) }.orEmpty()
                Text(
                    endedStateText(e) + if (when_.isNotBlank()) " $when_" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
                if (e.status == "error" && e.errorMsg.isNotBlank()) {
                    Text(
                        e.errorMsg,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        maxLines = 2,
                    )
                }
                if (e.prs.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        e.prs.forEach { PrBadge(it) }
                    }
                }
            }
            // Resume needs the host online (it rides the heartbeat as a command);
            // reading the conversation does not, so the card stays clickable.
            GhostButton("Resume", onResume, enabled = e.online)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionListCard(
    r: FlatSession,
    now: Long,
    selected: Boolean,
    onKill: () -> Unit,
    onRename: (String) -> Unit,
    onClick: () -> Unit,
) {
    val cardMod = Modifier.fillMaxWidth().then(
        if (selected)
            Modifier.border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(14.dp))
        else Modifier,
    )
    // Rename swaps the card for an inline field (web sessions.html ⋯ → Rename).
    var renaming by remember { mutableStateOf(false) }
    // Painted until the agent reports the new name back on its next heartbeat, or a
    // TTL passes — a rename that never lands (dead host, lost command) must not pin
    // a name the session doesn't have (web renameOptimistic).
    var optimistic by remember { mutableStateOf<String?>(null) }
    val liveName = sessionName(r.session)
    LaunchedEffect(optimistic, liveName) {
        val want = optimistic ?: return@LaunchedEffect
        if (liveName == want) { optimistic = null; return@LaunchedEffect }
        kotlinx.coroutines.delay(RENAME_OPTIMISTIC_MS)
        if (optimistic == want) optimistic = null
    }

    if (renaming) {
        SessionRenameCard(
            cardMod,
            initial = optimistic ?: liveName,
            onCancel = { renaming = false },
            onSubmit = { name ->
                renaming = false
                optimistic = name  // pin exactly what was asked for (blank clears)
                onRename(name)
            },
        )
        return
    }

    TurmaCard(cardMod) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 10.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StateDot(liveState(r.session, r.hostLastSeen, now))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    optimistic?.ifBlank { null } ?: liveName,
                    fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
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
            // Per-card overflow menu (web sessions.html ⋯): Rename + arm/confirm Kill.
            SessionCardMenu(onRename = { renaming = true }, onKill = onKill)
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
 * Keyed on the TRANSCRIPT id — the one handle all three ended channels share
 * (web findEndedByTranscript) — and re-resolves the entry from the fleet each
 * beat, so Resume dispatches on however the session ended (killed → resume,
 * stopped → start, resumable → resumeTranscript). The transcript is fetched
 * from the hub's durable archive, so it opens even when the session's host is
 * offline; Resume is gated on the host being online.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun EndedSessionView(
    host: String,
    transcriptId: String,
    onBack: () -> Unit,
    onResumed: (String, String) -> Unit,
    showBack: Boolean,
    fleetVm: FleetViewModel = viewModel(),
    archiveVm: ArchiveViewModel = viewModel(),
) {
    val fleet by fleetVm.fleet.collectAsStateWithLifecycle()
    val arch by archiveVm.state.collectAsStateWithLifecycle()
    val agent = fleet.agents.firstOrNull { it.key == host }
    // The ended entry this transcript belongs to, whatever channel reports it
    // right now. It can legitimately be missing (the session was resumed and is
    // running again, or the fleet moved on) — the archived conversation still
    // renders; only Resume needs the entry.
    val entry = remember(fleet.agents, host, transcriptId) {
        collectSessions(fleet.agents, "").ended.firstOrNull { it.host == host && it.transcriptId == transcriptId }
    }
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
                        Text(entry?.name ?: "Ended session", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${agent?.device?.ifBlank { host } ?: host} · ${entry?.repo?.ifBlank { "—" } ?: "—"}",
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
                    entry?.let { e ->
                        GhostButton(
                            "Resume",
                            {
                                resumeEnded(fleetVm, e)
                                // A resumable row comes back under a NEW id only the
                                // agent knows, so there is no session to select yet.
                                if (e.kind != EndedKind.RESUMABLE) onResumed(host, e.id) else onBack()
                            },
                            enabled = online,
                        )
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            // PR chips (each links out to GitHub) on the stage bar, like the web.
            entry?.prs?.takeIf { it.isNotEmpty() }?.let { prs ->
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

/** Rename-mode form the card swaps to: seeded field + Cancel/Save. */
@Composable
private fun SessionRenameCard(
    modifier: Modifier,
    initial: String,
    onCancel: () -> Unit,
    onSubmit: (String) -> Unit,
) {
    var draft by remember { mutableStateOf(initial) }
    TurmaCard(modifier) {
        Column(Modifier.fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            TurmaField(draft, { draft = it }, "Session name", Modifier.fillMaxWidth())
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.weight(1f))
                GhostButton("Cancel", onCancel)
                GhostButton("Save", onClick = { onSubmit(draft.trim()) })
            }
        }
    }
}

/**
 * The card's ⋯ menu. Rename opens the inline field; Kill arms then confirms
 * (web killArmedId): the first tap turns the item into a red "Confirm kill" for
 * [KILL_ARM_MS], and only a second tap within that window kills the session, so a
 * mis-tap can't destroy it. Closing the menu disarms.
 */
@Composable
private fun SessionCardMenu(onRename: () -> Unit, onKill: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(KILL_ARM_MS); armed = false } }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Filled.MoreVert, "Session actions") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false; armed = false }) {
            DropdownMenuItem(
                text = { Text("Rename…") },
                onClick = { open = false; armed = false; onRename() },
            )
            DropdownMenuItem(
                text = {
                    Text(
                        if (armed) "Confirm kill" else "Kill",
                        color = MaterialTheme.colorScheme.error,
                        fontWeight = if (armed) FontWeight.SemiBold else FontWeight.Normal,
                    )
                },
                onClick = { if (armed) { armed = false; open = false; onKill() } else armed = true },
            )
        }
    }
}

private const val KILL_ARM_MS = 3500L
private const val RENAME_OPTIMISTIC_MS = 10_000L
