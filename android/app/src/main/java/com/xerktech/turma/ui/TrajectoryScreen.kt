package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.model.DshTrajectory
import com.xerktech.turma.model.TrajCall
import com.xerktech.turma.model.TrajTurn
import com.xerktech.turma.vm.TrajectoryViewModel
import kotlin.math.roundToInt

/**
 * A dsh session's read-only Trajectory (XERK-498) — the Android port of the web
 * `renderTrajectory` (`sessions.html`). It REPLACES the ttyd terminal for a
 * headless dsh session (there is no pty to attach to): the chat header's action
 * routes a dsh session here instead of to `TerminalScreen`, which for a dsh
 * session opened an empty page. Turns render newest-first, each with its tool
 * calls, mirroring the web.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrajectoryScreen(
    host: String,
    transcriptId: String,
    onBack: () -> Unit,
    vm: TrajectoryViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(transcriptId) { vm.load(transcriptId) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            state.data?.title?.takeIf { it.isNotBlank() } ?: "Trajectory",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (host.isNotBlank()) {
                            Text(
                                host,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                },
                actions = {
                    IconButton(onClick = { vm.load(transcriptId, force = true) }) {
                        Icon(Icons.Filled.Refresh, "Refresh")
                    }
                },
            )
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            val data = state.data
            when {
                state.loading && data == null ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                data != null -> TrajectoryBody(data)
                state.notSynced -> TrajMessage(
                    "No dsh trajectory yet — a running session syncs its native log to the archive " +
                        "within a few beats. Tap ↻ Refresh in a moment.",
                )
                state.error != null -> TrajMessage(state.error!!)
                else -> TrajMessage("Empty trajectory.")
            }
        }
    }
}

@Composable
private fun TrajectoryBody(d: DshTrajectory) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item { TrajectoryHeader(d) }
        // Newest turn first — a live viewer watches the latest (web slice().reverse()).
        val turns = d.turns.asReversed()
        if (turns.isEmpty()) {
            item { TrajMessage("No turns recorded yet.") }
        } else {
            items(turns, key = { it.turn }) { TurnCard(it) }
        }
    }
}

@Composable
private fun TrajectoryHeader(d: DshTrajectory) {
    val t = d.totals
    val tok = t.tokens
    TurmaCard {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                d.title?.takeIf { it.isNotBlank() } ?: "dsh session",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            TrajTags {
                d.model?.takeIf { it.isNotBlank() }?.let { TrajTag(it) }
                TrajTag("${trajNum(t.turns)} turns")
                TrajTag("${trajNum(t.toolCalls)} tool calls")
                if (t.errors > 0) TrajTag("${trajNum(t.errors)} errors", error = true)
                TrajTag("↑${trajNum(tok.input)} ↓${trajNum(tok.output)} tok")
                d.durationMs?.let { TrajTag(trajMs(it)) }
            }
            if (d.truncated) {
                Text(
                    "Showing the most recent activity — this session’s log is large and was truncated.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun TurnCard(tn: TrajTurn) {
    TurmaCard {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            TrajTags {
                Text(
                    "Turn ${tn.turn}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                TrajTag("${trajNum(tn.steps)} steps")
                TrajTag("${tn.calls.size} calls")
                if (tn.tokens.input > 0 || tn.tokens.output > 0) {
                    TrajTag("↑${trajNum(tn.tokens.input)} ↓${trajNum(tn.tokens.output)}")
                }
                if (tn.startedAt != null && tn.endedAt != null) TrajTag(trajMs(tn.endedAt - tn.startedAt))
                tn.reason?.takeIf { it.isNotBlank() }?.let { TrajTag(it, error = it == "error") }
            }
            if (tn.calls.isEmpty()) {
                Text(
                    "no tool calls",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                tn.calls.forEach { CallRow(it) }
            }
        }
    }
}

@Composable
private fun CallRow(c: TrajCall) {
    val errored = c.ok == false
    val mark = when (c.ok) {
        false -> "✗"
        true -> "✓"
        else -> "•"
    }
    val markColor = if (errored) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(mark, color = markColor, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
            Text(
                c.name.ifBlank { "?" },
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp,
                color = if (errored) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
            c.durationMs?.let {
                Text(
                    trajMs(it),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (c.args.isNotBlank()) {
            Text(
                c.args,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                    .padding(horizontal = 8.dp, vertical = 4.dp),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A wrapping row of small tags (the web `.traj-h-meta` / `.traj-t-head`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TrajTags(content: @Composable () -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) { content() }
}

@Composable
private fun TrajTag(text: String, error: Boolean = false) {
    Pill(text, color = if (error) MaterialTheme.colorScheme.error else null, mono = true)
}

@Composable
private fun TrajMessage(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * Web `trajNum`: a thousands-grouped count. The hub floors every count it emits
 * non-negative, so a negative here is nonsense and renders "0" (the web renders
 * the raw number; the difference is unreachable). Token counts are [Long] — the
 * cache windows genuinely can exceed [Int.MAX_VALUE] — so this must NOT narrow
 * them; the [Int] overload only exists for the step/turn/call counts.
 */
internal fun trajNum(n: Long): String =
    if (n < 0) "0" else "%,d".format(n)

internal fun trajNum(n: Int): String = trajNum(n.toLong())

/**
 * Web `trajMs`: a compact duration. Under 1s → "Nms"; under 60s → "N.Ns" / "Ns";
 * else "Mm SSs". `ms` is dsh's own event epoch-ms delta, so it can be fractional.
 */
internal fun trajMs(ms: Double): String {
    if (!ms.isFinite() || ms < 0) return ""
    if (ms < 1000) return "${ms.roundToInt()}ms"
    val s = ms / 1000.0
    if (s < 60) return if (s < 10) "%.1fs".format(s) else "${s.roundToInt()}s"
    val mins = (s / 60).toInt()
    val secs = (s % 60).roundToInt()
    return "${mins}m${secs.toString().padStart(2, '0')}s"
}
