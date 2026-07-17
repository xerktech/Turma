package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.BOARD_CATEGORIES
import com.xerktech.turma.core.BoardSite
import com.xerktech.turma.core.categoryOf
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.orgColorIndex
import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BoardViewModel

@Composable
fun BoardScreen(modifier: Modifier = Modifier, vm: BoardViewModel = viewModel()) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val sites = remember(fleet) { mergeSites(fleet.agents) }
    val allKeys = sites.map { it.siteKey }
    var detail by remember { mutableStateOf<Pair<String, JiraTicket>?>(null) }

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
                else "No Jira-configured hosts.",
                Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Row(
                Modifier.fillMaxSize().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for ((cat, title) in BOARD_CATEGORIES) {
                    val cards = sites.flatMap { site -> site.tickets.filter { categoryOf(it) == cat }.map { site to it } }
                    KanbanColumn(cat, title, cards, allKeys) { site, t -> detail = site.siteKey to t }
                }
            }
        }
    }

    detail?.let { (siteKey, ticket) ->
        TicketDetailSheet(siteKey, ticket, vm, onDismiss = { detail = null })
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TicketDetailSheet(siteKey: String, t: JiraTicket, vm: BoardViewModel, onDismiss: () -> Unit) {
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
            t.repoGuess?.let { g ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    SectionLabel("Repo")
                    RepoChip(t)
                    if (g.reason.isNotBlank()) Text(g.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
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
