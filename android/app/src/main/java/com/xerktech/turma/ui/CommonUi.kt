package com.xerktech.turma.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xerktech.turma.core.LiveState
import com.xerktech.turma.model.PrInfo
import com.xerktech.turma.ui.theme.TurmaColors

// ---- surfaces / structure --------------------------------------------------

/** The web's card: surface fill, hairline border, 14px radius. */
@Composable
fun TurmaCard(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) { content() }
}

/** Small uppercase muted section label, like the web's section headers. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.8.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

// ---- buttons ---------------------------------------------------------------

/** Solid accent primary button (web `.btn.primary`). */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        shape = RoundedCornerShape(11.dp),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) { Text(text, fontWeight = FontWeight.SemiBold) }
}

/**
 * Quiet accent action (web `.btn.ghost`). A clickable Text rather than a
 * TextButton so it doesn't carry Material's 48dp minimum touch target — that
 * kept list rows (Resume/Prune) tall. Compact by design.
 */
@Composable
fun GhostButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Text(
        text,
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.Medium,
    )
}

// ---- fields ----------------------------------------------------------------

/** Text field styled to the web `.field`: field-fill, hairline border, accent focus. */
@Composable
fun TurmaField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        visualTransformation = visualTransformation,
        modifier = modifier,
        shape = RoundedCornerShape(11.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
            focusedBorderColor = MaterialTheme.colorScheme.primary,
            unfocusedBorderColor = MaterialTheme.colorScheme.outline,
        ),
    )
}

// ---- status / badges -------------------------------------------------------

/** Glowing status light (web `.status-dot`): a solid core with a soft halo. */
@Composable
fun StatusLight(color: Color, modifier: Modifier = Modifier, size: Int = 10) {
    Box(modifier.size((size + 8).dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size((size + 6).dp).clip(CircleShape).background(color.copy(alpha = 0.22f)))
        Box(Modifier.size(size.dp).clip(CircleShape).background(color))
    }
}

@Composable
fun StateDot(state: LiveState, modifier: Modifier = Modifier) {
    StatusLight(
        color = when (state) {
            LiveState.WORKING -> TurmaColors.working
            LiveState.WAITING -> TurmaColors.waiting
            LiveState.IDLE -> TurmaColors.idle
            LiveState.STOPPED -> TurmaColors.stopped
        },
        modifier = modifier,
    )
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

/**
 * GitHub-style PR pill: state color + #number + a ✓/✗/● merge-readiness mark.
 * Tapping it opens the PR in the system's default external browser (ACTION_VIEW
 * via LocalUriHandler) — never an in-app WebView.
 */
@Composable
fun PrBadge(pr: PrInfo, modifier: Modifier = Modifier) {
    val uriHandler = LocalUriHandler.current
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
            .clip(RoundedCornerShape(7.dp))
            .background(stateColor.copy(alpha = 0.16f))
            .border(1.dp, stateColor.copy(alpha = 0.35f), RoundedCornerShape(7.dp))
            .then(if (pr.url.isNotBlank()) Modifier.clickable { runCatching { uriHandler.openUri(pr.url) } } else Modifier)
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("#${pr.number}", color = stateColor, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        if (check.first.isNotEmpty()) Text("  ${check.first}", color = check.second, fontSize = 12.sp)
    }
}

/** Neutral or colored pill/chip (web `.pill`). Set [dashed] for the "clonable but not present" repo chip. */
@Composable
fun Pill(
    text: String,
    modifier: Modifier = Modifier,
    color: Color? = null,
    dashed: Boolean = false,
    mono: Boolean = false,
) {
    val fg = color ?: MaterialTheme.colorScheme.onSurfaceVariant
    val border = if (dashed) fg.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outline
    Text(
        text,
        modifier = modifier
            .clip(RoundedCornerShape(7.dp))
            .background((color ?: MaterialTheme.colorScheme.surfaceVariant).copy(alpha = if (color != null) 0.16f else 1f))
            .border(1.dp, border, RoundedCornerShape(7.dp))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        fontSize = 12.sp,
        fontWeight = FontWeight.Medium,
        fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
        color = fg,
    )
}
