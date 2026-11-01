package com.xerktech.turma.ui

import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.ReviewTone
import com.xerktech.turma.core.effectiveOrgs
import com.xerktech.turma.core.meetingClock
import com.xerktech.turma.core.meetingKindLabel
import com.xerktech.turma.core.meetingMetaLine
import com.xerktech.turma.core.meetingMomentUrl
import com.xerktech.turma.core.meetingOrgs
import com.xerktech.turma.core.meetingProject
import com.xerktech.turma.core.meetingReviewLines
import com.xerktech.turma.core.meetingReviewable
import com.xerktech.turma.core.meetingStatusLine
import com.xerktech.turma.core.meetingsNeedProject
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.orgName
import com.xerktech.turma.core.safeMeetingUrl
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.model.MeetingItem
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.MeetingDraft
import com.xerktech.turma.vm.MeetingsViewModel
import com.xerktech.turma.vm.MetaState

/**
 * Meetings (XERK-2511, the web's /meetings page, XERK-2510): the work items an
 * org host proposed from a meeting Tenir captured, each approved (a ticket on
 * the org's board, or a decision added to the decisions log), edited then
 * approved, or rejected. Scoped by the header's org pick. Every served string is
 * plain Text, never markup; a link opens only an http(s) URL.
 */
@Composable
fun MeetingsScreen(modifier: Modifier = Modifier, vm: MeetingsViewModel = viewModel()) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val stored by vm.orgFilter.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.errors.collectAsStateWithLifecycle()
    val drafts by vm.drafts.collectAsStateWithLifecycle()
    val meta by vm.meta.collectAsStateWithLifecycle()
    val picks by vm.picks.collectAsStateWithLifecycle()

    val context = LocalContext.current
    LaunchedEffect(Unit) {
        vm.messages.collect { msg ->
            Handler(Looper.getMainLooper()).post { Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    val sites = remember(fleet.agents) { mergeSites(fleet.agents) }
    val names = remember(sites) { sites.associate { it.siteKey to it.orgName } }
    val scoped = remember(stored, sites) { effectiveOrgs(stored, sites) }
    val orgs = remember(fleet.meetingProposals, scoped) { meetingOrgs(fleet.meetingProposals, scoped) }
    for (s in orgs) {
        val needs = meetingsNeedProject(fleet.meetingProposals[s].orEmpty())
        LaunchedEffect(s, needs) { if (needs) vm.ensureMeta(s) }
    }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Meetings")
        if (orgs.isEmpty()) {
            Text(
                "No meetings yet — when Tenir sends one, its proposed work items show up here.",
                Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            for (site in orgs) {
                val list = fleet.meetingProposals[site].orEmpty()
                val project = meetingProject(picks[site], (meta[site] as? MetaState.Projects)?.projects.orEmpty())
                val types = if (project.isEmpty()) null else meta[MeetingsViewModel.typesKey(site, project)]
                item(key = "org:$site") {
                    OrgHead(
                        name = orgName(site, names[site].orEmpty()),
                        target = if (meetingsNeedProject(list)) {
                            { ProjectTarget(meta[site], project, { vm.setProject(site, it) }, { vm.retryMeta(site) }) }
                        } else null,
                    )
                }
                items(list, key = { "m:$site:${it.meetingId}" }) { m ->
                    MeetingCard(
                        m = m,
                        itemState = { it ->
                            val k = MeetingsViewModel.itemKey(site, m.meetingId, it.id)
                            ItemUi(k in busy, errors[k], drafts[k])
                        },
                        types = types,
                        onApprove = { it, start -> vm.review(site, m, it, "approve", start) },
                        onReject = { vm.review(site, m, it, "reject") },
                        onEdit = { vm.startEdit(site, m, it) },
                        onDraft = { it, f -> vm.editDraft(MeetingsViewModel.itemKey(site, m.meetingId, it.id), f) },
                        onCancel = { vm.cancelEdit(MeetingsViewModel.itemKey(site, m.meetingId, it.id)) },
                    )
                }
            }
            item(key = "note") {
                Text(
                    "Nothing reaches the board until you approve: Approve creates the ticket on that org's " +
                        "board, a decision is added to the org's decisions log, and Reject sets it aside.",
                    Modifier.padding(vertical = 8.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/** One item's client-side state: a POST in flight, the hub's refusal, an open editor. */
data class ItemUi(val busy: Boolean, val error: String?, val draft: MeetingDraft?)

@Composable
private fun OrgHead(name: String, target: (@Composable () -> Unit)?) {
    Column(Modifier.fillMaxWidth().padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            name,
            Modifier.semantics { heading() },
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
        )
        target?.invoke()
    }
}

/** "New tickets go to <project>": the org's projects, the viewer's pick kept on this phone. */
@Composable
internal fun ProjectTarget(state: MetaState?, current: String, onPick: (String) -> Unit, onRetry: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("New tickets go to", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        when (state) {
            null, MetaState.Loading -> Text("… loading projects", style = MaterialTheme.typography.bodyMedium)
            is MetaState.Error -> {
                Text(state.message, Modifier.weight(1f, fill = false), color = TurmaColors.critical,
                    style = MaterialTheme.typography.bodyMedium)
                GhostButton("Retry", onRetry)
            }
            is MetaState.Projects -> Picker(
                label = state.projects.firstOrNull { it.key == current }
                    ?.let { if (it.name.isNotEmpty()) "${it.name} (${it.key})" else it.key } ?: "Pick a project",
                options = state.projects.map { it.key to (if (it.name.isNotEmpty()) "${it.name} (${it.key})" else it.key) },
                onPick = onPick,
            )
            is MetaState.Types -> Unit
        }
    }
}

/** A text button opening a menu of options; [onPick] gets the option's value. */
@Composable
private fun Picker(label: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            "$label ▾",
            Modifier.clip(RoundedCornerShape(8.dp)).clickable { open = true }.padding(horizontal = 6.dp, vertical = 4.dp),
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for ((value, text) in options) {
                DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onPick(value) })
            }
        }
    }
}

@Composable
internal fun MeetingCard(
    m: Meeting,
    itemState: (MeetingItem) -> ItemUi,
    types: MetaState?,
    onApprove: (MeetingItem, Boolean) -> Unit,
    onReject: (MeetingItem) -> Unit,
    onEdit: (MeetingItem) -> Unit,
    onDraft: (MeetingItem, (MeetingDraft) -> MeetingDraft) -> Unit,
    onCancel: (MeetingItem) -> Unit,
) {
    val uri = LocalUriHandler.current
    TurmaCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Text(m.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold)
                val url = safeMeetingUrl(m.tenirUrl)
                if (url.isNotEmpty()) GhostButton("Open in Tenir ↗", { uri.openUri(url) })
            }
            val metaLine = meetingMetaLine(m)
            if (metaLine.isNotEmpty()) {
                Text(metaLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val status = meetingStatusLine(m)
            if (status != null) {
                Text(status.first, style = MaterialTheme.typography.bodyMedium,
                    color = if (status.second) TurmaColors.critical else MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                m.items.forEachIndexed { i, it ->
                    if (i > 0) HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    ItemRow(m, it, itemState(it), types, onApprove, onReject, onEdit, onDraft, onCancel)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemRow(
    m: Meeting,
    it: MeetingItem,
    ui: ItemUi,
    types: MetaState?,
    onApprove: (MeetingItem, Boolean) -> Unit,
    onReject: (MeetingItem) -> Unit,
    onEdit: (MeetingItem) -> Unit,
    onDraft: (MeetingItem, (MeetingDraft) -> MeetingDraft) -> Unit,
    onCancel: (MeetingItem) -> Unit,
) {
    val uri = LocalUriHandler.current
    val decision = it.kind == "decision"
    val rejected = it.review?.state == "rejected"
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val (bg, fg) = when (it.kind) {
                "bug" -> TurmaColors.critical.copy(alpha = 0.14f) to TurmaColors.critical
                "decision" -> TurmaColors.good.copy(alpha = 0.14f) to TurmaColors.good
                else -> MaterialTheme.colorScheme.primary.copy(alpha = 0.12f) to MaterialTheme.colorScheme.primary
            }
            Text(
                meetingKindLabel(it.kind).uppercase(),
                Modifier.background(bg, RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 1.dp),
                color = fg, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
            )
            Text(it.title, Modifier.weight(1f), fontWeight = FontWeight.SemiBold,
                color = if (rejected) muted else MaterialTheme.colorScheme.onSurface)
        }
        if (it.description.isNotEmpty()) {
            Text(it.description, style = MaterialTheme.typography.bodyMedium,
                color = if (rejected) muted else MaterialTheme.colorScheme.onSurface)
        }
        val facts = buildList {
            if (it.suggestedAssignee.isNotEmpty()) add("Owner: ${it.suggestedAssignee}")
            if (it.due.isNotEmpty()) add("Due: ${it.due}")
            if (it.repoGuess.isNotEmpty()) add("Repo: ${it.repoGuess}")
            if (it.duplicateKeys.isNotEmpty()) add("May duplicate ${it.duplicateKeys.joinToString(", ")}")
        }
        if (facts.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (f in facts) Text(f, style = MaterialTheme.typography.bodySmall, color = muted)
            }
        }
        for (q in it.quotes.filter { q -> q.text.isNotEmpty() }) {
            Row(Modifier.padding(start = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    (if (q.speaker.isNotEmpty()) "${q.speaker}: " else "") + "“${q.text}”",
                    Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                )
                if (q.atMs >= 0) {
                    val at = meetingMomentUrl(m.tenirUrl, q.atMs)
                    if (at.isNotEmpty()) GhostButton("▸ ${meetingClock(q.atMs)}", { uri.openUri(at) })
                    else Text(" ${meetingClock(q.atMs)}", style = MaterialTheme.typography.bodySmall, color = muted)
                }
            }
        }
        val lines = meetingReviewLines(it)
        if (lines.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (l in lines) {
                    Text(l.text, style = MaterialTheme.typography.bodyMedium, color = when (l.tone) {
                        ReviewTone.GOOD -> TurmaColors.good
                        ReviewTone.BAD -> TurmaColors.critical
                        ReviewTone.NEUTRAL -> muted
                    })
                }
            }
        }
        if (meetingReviewable(it)) {
            val d = ui.draft
            if (d != null) {
                Editor(it, d, ui.busy, types, { f -> onDraft(it, f) }, { start -> onApprove(it, start) }) { onCancel(it) }
            } else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    PrimaryButton(
                        if (ui.busy) "Working…" else if (decision) "Log decision" else "Approve",
                        { onApprove(it, false) }, enabled = !ui.busy,
                    )
                    if (!decision) GhostButton("Approve + start session", { onApprove(it, true) }, enabled = !ui.busy)
                    GhostButton("Edit", { onEdit(it) }, enabled = !ui.busy)
                    if (!rejected) GhostButton("Reject", { onReject(it) }, enabled = !ui.busy)
                }
            }
        }
        ui.error?.let { e -> Text(e, color = TurmaColors.critical, style = MaterialTheme.typography.bodySmall) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Editor(
    it: MeetingItem,
    d: MeetingDraft,
    busy: Boolean,
    types: MetaState?,
    onDraft: ((MeetingDraft) -> MeetingDraft) -> Unit,
    onApprove: (Boolean) -> Unit,
    onCancel: () -> Unit,
) {
    val decision = it.kind == "decision"
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            d.title, { v -> onDraft { x -> x.copy(title = v.take(200)) } },
            Modifier.fillMaxWidth(), label = { Text("Title") }, singleLine = true,
        )
        OutlinedTextField(
            d.description, { v -> onDraft { x -> x.copy(description = if (decision) v.take(290) else v) } },
            Modifier.fillMaxWidth(), label = { Text(if (decision) "Detail" else "Description") }, minLines = 4,
        )
        if (!decision) {
            when (types) {
                is MetaState.Types -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Type", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Picker(
                        label = types.types.firstOrNull { t -> t.id == d.issueType }?.let { t -> t.name.ifEmpty { t.id } }
                            ?: "Default for a ${meetingKindLabel(it.kind)}",
                        options = types.types.map { t -> t.id to t.name.ifEmpty { t.id } },
                        onPick = { v -> onDraft { x -> x.copy(issueType = v) } },
                    )
                }
                is MetaState.Error -> Text(types.message, color = TurmaColors.critical, style = MaterialTheme.typography.bodySmall)
                else -> Text(
                    if (types == null) "Pick a project above first." else "Loading issue types…",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            PrimaryButton(if (decision) "Log decision" else "Approve", { onApprove(false) }, enabled = !busy)
            if (!decision) GhostButton("Approve + start session", { onApprove(true) }, enabled = !busy)
            GhostButton("Cancel", onCancel)
        }
    }
}
