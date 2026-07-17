package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xerktech.turma.core.LiveState
import com.xerktech.turma.model.PrInfo
import com.xerktech.turma.ui.theme.TurmaColors

@Composable
fun StateDot(state: LiveState, modifier: Modifier = Modifier) {
    val color = when (state) {
        LiveState.WORKING -> TurmaColors.working
        LiveState.WAITING -> TurmaColors.waiting
        LiveState.IDLE -> TurmaColors.idle
        LiveState.STOPPED -> TurmaColors.stopped
    }
    Box(modifier.size(10.dp).clip(CircleShape).background(color))
}

fun liveStateLabel(state: LiveState): String = when (state) {
    LiveState.WORKING -> "working"
    LiveState.WAITING -> "waiting"
    LiveState.IDLE -> "idle"
    LiveState.STOPPED -> "stopped"
}

/**
 * The PR's merge-readiness verdict (ready/blocked/pending/""), which the agent
 * derives from CI *and* mergeability together (_merge_ready in hub-agent.py) —
 * green CI on a conflicting branch is not a PR that can land. An agent
 * predating the field reports the CI half alone, so fall back to that rather
 * than dropping the mark.
 */
fun prReady(pr: PrInfo): String = pr.ready.ifEmpty {
    when (pr.checks.lowercase()) {
        "passing" -> "ready"
        "failing" -> "blocked"
        "pending" -> "pending"
        else -> ""
    }
}

/** GitHub-style PR pill: state color + #number + a ✓/✗/● merge-readiness mark. */
@Composable
fun PrBadge(pr: PrInfo, modifier: Modifier = Modifier) {
    val stateColor = when (pr.state.uppercase()) {
        "OPEN" -> TurmaColors.prOpen
        "DRAFT" -> TurmaColors.prDraft
        "MERGED" -> TurmaColors.prMerged
        "CLOSED" -> TurmaColors.prClosed
        else -> TurmaColors.stopped
    }
    val check = when (prReady(pr).lowercase()) {
        "ready" -> "✓" to TurmaColors.checkPass
        "blocked" -> "✗" to TurmaColors.checkFail
        "pending" -> "●" to TurmaColors.checkPending
        else -> "" to Color.Transparent
    }
    Row(
        modifier
            .clip(RoundedCornerShape(6.dp))
            .background(stateColor.copy(alpha = 0.18f))
            .padding(horizontal = 8.dp, vertical = 2.dp)
    ) {
        Text("#${pr.number}", color = stateColor, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        if (check.first.isNotEmpty()) {
            Text("  ${check.first}", color = check.second, fontSize = 12.sp)
        }
    }
}

@Composable
fun Pill(text: String, color: Color = MaterialTheme.colorScheme.surfaceVariant, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(color.copy(alpha = 0.5f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
