package com.xerktech.turma.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.xerktech.turma.core.liveState
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

@Composable
fun SessionsScreen(
    onOpenChat: (String, String) -> Unit,
    modifier: Modifier = Modifier,
    vm: FleetViewModel = viewModel(),
) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    var query by remember { mutableStateOf("") }
    val now = fleet.now.takeIf { it > 0 } ?: System.currentTimeMillis()
    val rows = remember(fleet, query) { flattenSessions(fleet.agents, query) }
    val ended = remember(fleet, query) { flattenClosed(fleet.agents, query) }
    var endedOpen by remember { mutableStateOf(false) }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Sessions")
        TurmaField(query, { query = it }, "Search sessions", Modifier.fillMaxWidth().padding(10.dp, 2.dp))
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(10.dp, 4.dp, 10.dp, 12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (rows.isEmpty() && ended.isEmpty()) {
                item {
                    Text(
                        if (fleet.loading) "Loading…" else "No sessions.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items(rows, key = { it.host + "/" + it.session.id }) { r ->
                SessionListCard(r, now) { onOpenChat(r.host, r.session.id) }
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
                        ClosedSessionCard(c) { vm.resume(c.host, c.closed.id); onOpenChat(c.host, c.closed.id) }
                    }
                }
            }
        }
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
private fun SessionListCard(r: FlatSession, now: Long, onClick: () -> Unit) {
    TurmaCard(Modifier.fillMaxWidth()) {
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
