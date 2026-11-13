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
import com.xerktech.turma.core.meetingsEmptyText
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

/*
 * The pieces of one meeting's review (XERK-2511, the web's meetings.js): a
 * proposal with its actions and state, the editor, the project pick. The
 * Brief screen's triage (BriefScreen.kt, XERK-2858) lays them out. Every
 * served string is plain Text, never markup; a link opens only an http(s) URL.
 */

/** One item's client-side state: a POST in flight, the hub's refusal, an open editor. */
data class ItemUi(val busy: Boolean, val error: String?, val draft: MeetingDraft?)

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
internal fun Picker(label: String, options: List<Pair<String, String>>, onPick: (String) -> Unit) {
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

/** What one proposal can do; the screen binds each to its org and meeting. */
class ItemActions(
    val onApprove: (MeetingItem, Boolean) -> Unit,
    val onReject: (MeetingItem) -> Unit,
    val onReopen: (MeetingItem) -> Unit,
    val onEdit: (MeetingItem) -> Unit,
    val onDraft: (MeetingItem, (MeetingDraft) -> MeetingDraft) -> Unit,
    val onCancel: (MeetingItem) -> Unit,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ItemRow(m: Meeting, it: MeetingItem, ui: ItemUi, types: MetaState?, act: ItemActions) {
    val onApprove = act.onApprove
    val onReject = act.onReject
    val onEdit = act.onEdit
    val onDraft = act.onDraft
    val onCancel = act.onCancel
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
        if (rejected) {
            // A rejected proposal sits under "show reviewed"; Reopen puts it back
            // to review (XERK-2856), rather than approving it from there.
            GhostButton(if (ui.busy) "Working…" else "Reopen", { act.onReopen(it) }, enabled = !ui.busy)
        } else if (meetingReviewable(it)) {
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
                    GhostButton("Reject", { onReject(it) }, enabled = !ui.busy)
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
