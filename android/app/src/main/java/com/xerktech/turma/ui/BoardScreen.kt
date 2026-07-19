package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import android.widget.Toast
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.AutoStartState
import com.xerktech.turma.core.BOARD_CATEGORIES
import com.xerktech.turma.core.BoardSite
import com.xerktech.turma.core.autoStartState
import com.xerktech.turma.core.categoryOf
import com.xerktech.turma.core.filterSites
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.orgColorIndex
import com.xerktech.turma.core.orgName
import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BoardViewModel

@Composable
fun BoardScreen(modifier: Modifier = Modifier, vm: BoardViewModel = viewModel()) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val orgFilter by vm.orgFilter.collectAsStateWithLifecycle()
    val sites = remember(fleet) { mergeSites(fleet.agents) }
    // Org colors stay stable across filtering — keyed on every org, not the shown one.
    val allKeys = sites.map { it.siteKey }
    val shown = remember(sites, orgFilter) { filterSites(sites, orgFilter) }
    var detail by remember { mutableStateOf<Pair<BoardSite, JiraTicket>?>(null) }

    val context = LocalContext.current
    LaunchedEffect(Unit) { vm.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Board") {
            IconButton(onClick = { vm.refresh() }, enabled = !refreshing) {
                if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.Filled.Refresh, "Refresh")
            }
        }
        if (sites.isEmpty() || sites.all { it.tickets.isEmpty() }) {
            Text(
                if (fleet.agents.any { it.jira?.configured == true }) "No tickets."
                else "No ticket-board-configured hosts.",
                Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            // Pinned above the (horizontally-scrolling) columns: an "All orgs" chip
            // plus one per org, labelled by org name, ticket-counted, and colored by
            // the org's stable palette slot. Mirrors board.html's `#chips` row.
            OrgFilterBar(
                sites, allKeys, orgFilter,
                autoOf = { autoStartState(fleet.agents, fleet.autoStartOrgs, it) },
                onToggleAuto = { site, enabled -> vm.setAutoStart(site, enabled) },
                onPick = { vm.setOrg(it) },
            )
            Row(
                Modifier.fillMaxSize().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for ((cat, title) in BOARD_CATEGORIES) {
                    // Newest-updated first, matching board.js `ticketSort`.
                    val cards = shown
                        .flatMap { site -> site.tickets.filter { categoryOf(it) == cat }.map { site to it } }
                        .sortedByDescending { it.second.updated }
                    KanbanColumn(cat, title, cards, allKeys) { site, t -> detail = site to t }
                }
            }
        }
    }

    detail?.let { (site, ticket) ->
        // The Agent pin lives on the fleet payload (hub-owned), not the ticket,
        // so it's resolved here where the fleet state is in scope.
        val pin = com.xerktech.turma.core.agentPinOf(fleet.ticketAgents, site.siteKey, ticket.key)
        TicketDetailSheet(site, ticket, pin, vm, onDismiss = { detail = null })
    }
}

/**
 * The pinned org filter row: "All orgs" + one chip per org. Labelled by org
 * name (the siteKey's `.atlassian.net` stripped), ticket-counted, colored by
 * the org's stable palette slot, and flagged offline when no reporting host is
 * online. Selecting one filters the board to that org's `siteKey`; the choice
 * persists in the ViewModel. Mirrors board.html's `#chips` row.
 */
@Composable
private fun OrgFilterBar(
    sites: List<BoardSite>,
    allKeys: List<String>,
    orgFilter: String,
    autoOf: (String) -> AutoStartState,
    onToggleAuto: (String, Boolean) -> Unit,
    onPick: (String) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OrgChip("All orgs", null, null, offline = false, active = orgFilter.isBlank(),
            auto = null, onToggleAuto = {}) { onPick("") }
        for (s in sites) {
            OrgChip(
                label = orgName(s.siteKey),
                color = TurmaColors.series[orgColorIndex(s.siteKey, allKeys) % TurmaColors.series.size],
                count = s.tickets.size,
                offline = !s.online,
                active = orgFilter == s.siteKey,
                // The auto-start toggle (XERK-41) is a segment INSIDE the chip.
                auto = autoOf(s.siteKey),
                onToggleAuto = { enabled -> onToggleAuto(s.siteKey, enabled) },
            ) { onPick(s.siteKey) }
        }
    }
}

/**
 * One org chip as a single pill: a filter segment plus, for a real org, an
 * auto-start toggle segment (XERK-41) divided from it by an inner line — a port
 * of board.html's segmented `.org-chip`. The auto segment reflects the effective
 * opt-in (hub toggle OR a legacy agent env); a tap writes the hub toggle, and an
 * env-forced org shows it on and locked (dimmed, not clickable).
 */
@Composable
private fun OrgChip(
    label: String,
    color: Color?,
    count: Int?,
    offline: Boolean,
    active: Boolean,
    auto: AutoStartState?,
    onToggleAuto: (Boolean) -> Unit,
    onClick: () -> Unit,
) {
    val accent = color ?: MaterialTheme.colorScheme.primary
    val stroke = if (active) accent else MaterialTheme.colorScheme.outline
    Row(
        Modifier
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(999.dp))
            .border(1.dp, stroke, RoundedCornerShape(999.dp)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Filter segment.
        Row(
            Modifier
                .background(if (active) accent.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surface)
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (color != null) Box(Modifier.size(8.dp).clip(CircleShape).background(color))
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
                color = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (count != null) Text(
                "$count",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (offline) Text(
                "⚠",
                style = MaterialTheme.typography.labelMedium,
                color = TurmaColors.waiting,
            )
        }
        // Auto-start toggle segment (real orgs only), divided by an inner line.
        if (auto != null) {
            Box(Modifier.width(1.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outline))
            val on = auto.on
            Row(
                Modifier
                    .background(if (on) accent.copy(alpha = 0.12f) else MaterialTheme.colorScheme.surface)
                    .then(if (auto.envForced) Modifier.alpha(0.6f) else Modifier.clickable { onToggleAuto(!auto.hubOn) })
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Box(Modifier.size(7.dp).clip(CircleShape)
                    .background(if (on) accent else MaterialTheme.colorScheme.onSurfaceVariant))
                Text(
                    "auto",
                    style = MaterialTheme.typography.labelMedium,
                    color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun KanbanColumn(
    cat: String,
    title: String,
    cards: List<Pair<BoardSite, JiraTicket>>,
    allKeys: List<String>,
    onOpen: (BoardSite, JiraTicket) -> Unit,
) {
    Column(Modifier.width(300.dp).fillMaxSize()) {
        Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            SectionLabel(title)
            Spacer(Modifier.width(6.dp))
            Text("${cards.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(cards, key = { it.second.key }) { (site, t) ->
                TicketCard(t, TurmaColors.series[orgColorIndex(site.siteKey, allKeys) % TurmaColors.series.size]) { onOpen(site, t) }
            }
        }
    }
}

@Composable
private fun TicketCard(t: JiraTicket, orgColor: Color, onClick: () -> Unit) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Column(Modifier.clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(orgColor))
                Text(t.project, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                Text(t.key, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(t.summary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 4)
            RepoChip(t)
        }
    }
}

/** The repo the agent triaged the ticket to — plain (cloned), dashed (clonable), or muted "no repo". */
@Composable
private fun RepoChip(t: JiraTicket) {
    val g = t.repoGuess ?: return
    when {
        g.repo == null -> Text("no repo", style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else -> Pill(g.repo!!, dashed = !g.cloned, mono = true)
    }
}

/**
 * The Repo row of the detail sheet: the triaged repo + its rationale, a
 * "Start session" action when it's cloned, and a "Change" picker that pins the
 * repo by hand. Mirrors board.js repoFieldHtml + ticketStartHtml + repoPickerHtml.
 */
@Composable
private fun RepoSection(site: BoardSite, t: JiraTicket, vm: BoardViewModel) {
    var editing by remember(t.key) { mutableStateOf(false) }
    val g = t.repoGuess
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Repo")
        when {
            g == null -> Text("Not triaged yet", style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
            g.repo == null -> Text(
                if (g.manual) "No repository — set by you" else "No repository fits this ticket",
                style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Pill(g.repo!!, dashed = !g.cloned, mono = true)
                    if (!g.cloned) Text("(not cloned)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (g.manual) Text("— set by you", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (g.reason.isNotBlank() && !g.manual) Text(g.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            // Start is only offered on a triaged, cloned repo (the hub 409s otherwise).
            if (g?.repo != null && g.cloned) {
                GhostButton("▶ Start session", onClick = { vm.startSession(site.siteKey, t.key) })
            }
            GhostButton(if (editing) "Cancel" else "Change repo", onClick = { editing = !editing })
        }
        if (editing) {
            RepoPicker(site, t) { repo, auto ->
                vm.setRepo(site.siteKey, t.key, repo, auto)
                editing = false
            }
        }
    }
}

@Composable
private fun RepoPicker(site: BoardSite, t: JiraTicket, onPick: (repo: String?, auto: Boolean) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val g = t.repoGuess
    val current = if (g?.manual == true) (g.repo ?: "No repository fits") else "Let the agent decide"
    Box {
        GhostButton("▾ $current", onClick = { open = true })
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("Let the agent decide") },
                onClick = { open = false; onPick(null, true) },
            )
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("No repository fits") },
                onClick = { open = false; onPick(null, false) },
            )
            for (o in site.repoOptions.filter { it.name.isNotBlank() }) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(o.name + if (!o.cloned) "  (not cloned)" else "", fontFamily = FontFamily.Monospace) },
                    onClick = { open = false; onPick(o.name, false) },
                )
            }
        }
    }
    if (site.repoOptions.none { it.name.isNotBlank() }) {
        Text("No repos reported for this org", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * The Agent row of the detail sheet (XERK-38): which HOST this ticket's
 * sessions spawn on — the operator's rare multi-agent-org override of the
 * hub's most-available routing. Mirrors board.js agentFieldHtml +
 * agentPickerHtml: auto is the stated default, a pin says "set by you", and a
 * pinned host that's offline or gone is said rather than hidden (the hub
 * refuses to reroute around a dead pin).
 */
@Composable
private fun AgentSection(
    site: BoardSite,
    t: JiraTicket,
    pin: com.xerktech.turma.model.TicketAgentPin?,
    vm: BoardViewModel,
) {
    val opt = pin?.let { p -> site.hostOptions.find { it.key == p.host } }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Agent")
        if (pin == null) {
            Text(
                "Auto — most available agent",
                style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Pill(opt?.name ?: pin.host, mono = true)
                val note = when {
                    opt == null -> "(no longer reports this org)"
                    !opt.online -> "(offline)"
                    else -> null
                }
                if (note != null) Text(note, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("— set by you", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // Nothing to pick and nothing to release -> no picker (matches the web
        // row going read-only).
        if (site.hostOptions.isNotEmpty() || pin != null) {
            AgentPicker(site, pin) { host -> vm.setTicketAgent(site.siteKey, t.key, host) }
        }
    }
}

/** A pick IS the save, same contract as [RepoPicker]; null = release to auto. */
@Composable
private fun AgentPicker(site: BoardSite, pin: com.xerktech.turma.model.TicketAgentPin?, onPick: (host: String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val current = pin?.let { p -> site.hostOptions.find { it.key == p.host }?.name ?: p.host }
        ?: "Auto — most available agent"
    Box {
        GhostButton("▾ $current", onClick = { open = true })
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("Auto — most available agent") },
                onClick = { open = false; onPick(null) },
            )
            for (h in site.hostOptions) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(h.name + if (!h.online) "  (offline)" else "", fontFamily = FontFamily.Monospace) },
                    onClick = { open = false; onPick(h.key) },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TicketDetailSheet(
    site: BoardSite,
    t: JiraTicket,
    pin: com.xerktech.turma.model.TicketAgentPin?,
    vm: BoardViewModel,
    onDismiss: () -> Unit,
) {
    val siteKey = site.siteKey
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val detail by produceState<com.xerktech.turma.model.JiraIssueDetail?>(initialValue = null, siteKey, t.key) {
        value = vm.fetchIssue(siteKey, t.key)
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp, 0.dp, 20.dp, 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(t.key, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Pill(t.status)
                if (t.priority.isNotBlank()) Pill(t.priority)
            }
            Text(t.summary, style = MaterialTheme.typography.titleMedium)
            RepoSection(site, t, vm)
            AgentSection(site, t, pin, vm)
            val d = detail
            if (d == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text("Loading details…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else {
                if (d.description.isNotBlank()) {
                    SectionLabel("Description")
                    Text(d.description, style = MaterialTheme.typography.bodyMedium)
                }
                if (d.comments.isNotEmpty()) {
                    SectionLabel("Comments (${d.commentTotal.takeIf { it > 0 } ?: d.comments.size})")
                    for (c in d.comments) {
                        Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Text(c.author, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                            Text(c.body, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
