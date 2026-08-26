package com.xerktech.turma.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xerktech.turma.core.ContextMeter
import com.xerktech.turma.core.LiveState
import com.xerktech.turma.core.hasLiveAgents
import com.xerktech.turma.model.LiveSignals
import com.xerktech.turma.model.PrInfo
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.ui.theme.TurmaColors

// ---- surfaces / structure --------------------------------------------------

/**
 * The web's card: surface fill, hairline border, 14px radius.
 *
 * [tint] is an optional org colour (XERK-142): when set, the fill is that colour
 * blended a little way into the surface (opaque, so it never washes the card out)
 * — the same subtle org tint the web board/sessions/dashboard cards carry, so a
 * card's org reads at a glance on every surface. Null → plain surface.
 */
@Composable
fun TurmaCard(modifier: Modifier = Modifier, tint: Color? = null, content: @Composable () -> Unit) {
    val surface = MaterialTheme.colorScheme.surface
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(14.dp),
        color = if (tint != null) lerp(surface, tint, ORG_TINT_AMOUNT) else surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) { content() }
}

/** How far an org colour is mixed into a card's surface — matches the web's 12%. */
const val ORG_TINT_AMOUNT = 0.12f

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

/**
 * Arm-then-confirm "Kill" for a chat/terminal top bar (web sessions.html
 * chatKill/termKill). The first tap arms — the label becomes "Confirm kill" in
 * the error colour for [ARM_MS] — and only a second tap within that window calls
 * [onKill], so a mis-tap can't destroy a session. The arm auto-disarms on
 * timeout, matching the web's 3.5s.
 */
@Composable
fun KillAction(onKill: () -> Unit, modifier: Modifier = Modifier) {
    var armed by remember { mutableStateOf(false) }
    LaunchedEffect(armed) { if (armed) { kotlinx.coroutines.delay(ARM_MS); armed = false } }
    TextButton(
        onClick = { if (armed) { armed = false; onKill() } else armed = true },
        modifier = modifier,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
    ) { Text(if (armed) "Confirm kill" else "Kill") }
}

private const val ARM_MS = 3500L

// ---- fields ----------------------------------------------------------------

/**
 * Keyboard options for prose text fields — auto-capitalize the first letter of
 * each sentence (XERK-166). This matches mobile browsers, which default
 * `<input>`/`<textarea>` to `autocapitalize="sentences"` on the web UI; Compose
 * defaults to [KeyboardCapitalization.None], so Android needs it set explicitly.
 * Structured/identifier fields (the login URL/username/password) opt out.
 */
val SentenceCapsKeyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences)

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
        keyboardOptions = SentenceCapsKeyboard,
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

/**
 * A search box styled like [TurmaField] (web `.searchbox`): a leading magnifier,
 * and a clear "×" once there is something to clear.
 *
 * The placeholder rides in the label so the box keeps its meaning while typing,
 * and the keyboard's action is Search rather than a newline — this is the whole
 * search affordance on the Sessions screen (XERK-243), not a decorative filter.
 */
@Composable
fun TurmaSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    onSearch: () -> Unit = {},
) {
    val keyboard = LocalSoftwareKeyboardController.current
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        leadingIcon = { Icon(Icons.Filled.Search, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingIcon = {
            if (value.isNotEmpty()) {
                IconButton(onClick = { onValueChange("") }) { Icon(Icons.Filled.Close, "Clear search") }
            }
        },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); onSearch() }),
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
 * The same word, except that a session working because of BACKGROUND AGENTS
 * rather than its own turn says which — matching the web's `agentWorkLabel`
 * (sessions.html). Without it a session whose own turn has ended reads a bare
 * "working" with nothing on screen explaining what is still running (XERK-245).
 */
fun liveStateLabel(state: LiveState, live: LiveSignals?): String {
    if (state == LiveState.WORKING && hasLiveAgents(live)) {
        val n = live?.agents?.size ?: 0
        return if (n == 1) "1 background agent" else "$n background agents"
    }
    return liveStateLabel(state)
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
 * The pill's number label. A bare `{url}` chip (no status fetched yet) falls
 * back to the number in the URL — GitHub `/pull/<n>`, GitLab
 * `/-/merge_requests/<n>` (XERK-162) or Azure DevOps `/pullrequest/<n>`
 * (XERK-226) — else a plain "PR", mirroring the web renderers' fallback.
 * GitLab and Azure DevOps number their requests !n, not #n (in ADO #n is a
 * WORK ITEM) — the sigil follows the URL's platform, mirroring the agent's
 * `_pr_ref` and the web renderers.
 */
fun prNumberLabel(pr: PrInfo): String {
    val m = Regex("""/pull/(\d+)|/-/merge_requests/(\d+)|/pullrequest/(\d+)""",
        RegexOption.IGNORE_CASE).find(pr.url)
    val sigil = if (m != null && m.groupValues[1].isEmpty()) "!" else "#"
    if (pr.number != 0) return "$sigil${pr.number}"
    if (m == null) return "PR"
    return sigil + m.groupValues.drop(1).first { it.isNotEmpty() }
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
        Text(prNumberLabel(pr), color = stateColor, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
        if (check.first.isNotEmpty()) Text("  ${check.first}", color = check.second, fontSize = 12.sp)
    }
}

/**
 * The dsh runtime badge (web `runtimeMarkHtml` / `.runtime-mark`, XERK-460) —
 * a neutral accent pill shown ONLY on a non-default (dsh) session card, so a
 * glance at the list says which sessions run on the dsh runtime. A Claude
 * session — the default, and every session predating the field — carries none,
 * so the common card is unchanged; the caller gates on [Runtime.isDsh].
 */
@Composable
fun RuntimeBadge(modifier: Modifier = Modifier) {
    Pill("⚙ dsh", modifier, color = MaterialTheme.colorScheme.primary)
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

/**
 * The context-fullness meter (XERK-489 Phase 4) — a thin bar + "N% context",
 * warn ~85%, danger near the ~95% auto-compaction. Shared by the session card
 * (FleetScreen) and the chat bar (ChatScreen), mirroring the web's card + compose
 * footer. Renders nothing until a turn is measured. A subscription session's
 * window is Claude Code's 200k assumption, marked "~".
 */
@Composable
fun ContextMeterBar(session: SessionInfo, modifier: Modifier = Modifier) {
    val m = ContextMeter.read(session) ?: return
    val color = when (m.level) {
        ContextMeter.Level.DANGER -> TurmaColors.critical
        ContextMeter.Level.WARN -> TurmaColors.warning
        ContextMeter.Level.OK -> MaterialTheme.colorScheme.primary
    }
    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        LinearProgressIndicator(
            progress = { m.fraction },
            color = color,
            trackColor = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.weight(1f).height(4.dp),
        )
        Text(
            "${m.pct}%${if (m.approx) " ~" else ""} context",
            style = MaterialTheme.typography.bodySmall,
            color = if (m.level == ContextMeter.Level.OK) MaterialTheme.colorScheme.onSurfaceVariant else color,
        )
    }
}
