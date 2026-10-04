package com.xerktech.turma.ui

import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xerktech.turma.core.Permissions
import com.xerktech.turma.model.PermissionGroup
import com.xerktech.turma.model.PermissionRow
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.UsageViewModel

/**
 * "Permission prompts (7 days)" (XERK-1576) — the Android port of usage.html's
 * permission card (`permissionsCardHtml`) in its phone layout: each group a
 * stacked block (kind + subject; count / answers / median wait; the rule and
 * its Copy), then the one note for asks, then the "Recent prompts" disclosure.
 * Follows the header's org filter only, never the grouping tabs above it.
 */
@Composable
internal fun PermissionsSection(
    ui: UsageViewModel.PermissionsUi,
    nowMs: Long = ui.at.takeIf { it > 0 } ?: System.currentTimeMillis(),
) {
    val view = ui.view
    val days = view?.days?.takeIf { it > 0 } ?: Permissions.DAYS
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // The card's small print shares bodySmall's line height, not the default
    // bodyLarge one a bare 12sp Text would inherit (double-spaced rows).
    ProvideTextStyle(MaterialTheme.typography.bodySmall) {
        Column(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp)) {
            Text(
                "Permission prompts ($days days)",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(Permissions.NOTE, style = MaterialTheme.typography.bodySmall, color = muted)
            // A first read that failed says so, in the hub's words; "Loading…"
            // there would wait forever.
            val empty = when {
                view == null && !ui.error.isNullOrEmpty() -> "Could not load permission prompts (${ui.error})."
                view == null -> "Loading…"
                view.top.isEmpty() -> "No permission prompts recorded in the last $days days for the selected orgs."
                else -> null
            }
            if (empty != null || view == null) {
                Text(
                    empty.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = muted,
                    modifier = Modifier.padding(top = 6.dp),
                )
                return@Column
            }
            view.top.forEachIndexed { i, g ->
                if (i > 0) HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
                PermGroupBlock(g)
            }
            if (view.top.any(Permissions::isBehaviour)) {
                Text(
                    behaviourNote(),
                    style = MaterialTheme.typography.bodySmall,
                    color = muted,
                    modifier = Modifier.padding(top = 12.dp),
                )
            }
            if (view.recent.isNotEmpty()) RecentPrompts(view.recent, nowMs)
        }
    }
}

/**
 * The asks note as the web renders `PERM_BEHAVIOUR_NOTE`: the lead-in bold and
 * the `~/.claude/CLAUDE.md` path in mono, the rest plain.
 */
private fun behaviourNote(): AnnotatedString = buildAnnotatedString {
    val lead = "Asked in chat"
    val body = Permissions.BEHAVIOUR_NOTE.removePrefix(lead)
    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(lead) }
    val code = Permissions.BEHAVIOUR_NOTE_CODE
    val at = body.indexOf(code)
    if (at < 0) {
        append(body)
    } else {
        append(body.substring(0, at))
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(code) }
        append(body.substring(at + code.length))
    }
}

/** The kind chip: a classifier block reads critical, an ask warning, the rest plain. */
@Composable
private fun PermKindChip(kind: String, dialogKind: String?) {
    val color = when (Permissions.kindStyle(kind)) {
        "classifier-denied" -> TurmaColors.critical
        "ask-in-chat" -> TurmaColors.warning
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val plain = Permissions.kindStyle(kind) == "dialog"
    Text(
        Permissions.kindLabel(kind, dialogKind),
        fontSize = 11.sp,
        fontWeight = FontWeight.SemiBold,
        color = color,
        modifier = Modifier
            .border(1.dp, if (plain) MaterialTheme.colorScheme.outlineVariant else color, RoundedCornerShape(50))
            .background(if (plain) MaterialTheme.colorScheme.background else Color.Transparent, RoundedCornerShape(50))
            .padding(horizontal = 7.dp, vertical = 1.dp),
    )
}

/** A command/tool subject is mono; an ask's question is prose with its `code` spans rendered. */
@Composable
private fun PermSubject(kind: String, head: String?, text: String, modifier: Modifier = Modifier) {
    val prose = Permissions.subjectIsProse(kind, head)
    val annotated = if (prose) buildAnnotatedString {
        for ((run, code) in Permissions.proseRuns(text)) {
            if (code) withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(run) } else append(run)
        }
    } else AnnotatedString(text)
    Text(
        annotated,
        fontSize = if (prose) 13.sp else 12.sp,
        fontFamily = if (prose) null else FontFamily.Monospace,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = modifier,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PermGroupBlock(g: PermissionGroup) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        PermKindChip(g.kind, g.dialogKind)
        PermSubject(g.kind, g.head, Permissions.subject(g), Modifier.padding(top = 4.dp))
        if (!g.tool.isNullOrEmpty() && !g.head.isNullOrEmpty() && g.tool != g.head) {
            Text(g.tool, fontSize = 11.sp, color = muted, modifier = Modifier.padding(top = 2.dp))
        }
        // One line of count / answers / median wait, each labelled (web data-label).
        FlowRow(
            Modifier.padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            PermStat("Count", g.count.toString())
            // An answered ask has no allow/deny answer at all: no bare "—" under a label.
            if (!Permissions.answerless(g)) PermStat("Allowed / denied", Permissions.answers(g))
            PermStat("Median wait", Permissions.wait(g.medianWaitMs))
        }
        PermRule(g)
    }
}

@Composable
private fun PermStat(label: String, value: String) {
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("$label ") }
            append(value)
        },
        fontSize = 12.sp,
        color = MaterialTheme.colorScheme.onSurface,
    )
}

/** The rule and its Copy on one line, or why there is none (web `permRuleHtml`). */
@Composable
private fun PermRule(g: PermissionGroup) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (val rule = Permissions.rule(g)) {
        is Permissions.Rule.Copyable -> Row(
            Modifier.fillMaxWidth().padding(top = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // The rule shrinks and wraps inside its box; Copy keeps its place beside it.
            Text(
                Permissions.ruleDisplay(rule.rule),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier
                    .weight(1f, fill = false)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp))
                    .background(MaterialTheme.colorScheme.background, RoundedCornerShape(4.dp))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
            CopyRuleButton(rule.rule)
        }
        is Permissions.Rule.None -> Column(Modifier.padding(top = 6.dp)) {
            Text(rule.text, fontSize = 12.sp, color = muted)
            if (rule.why != null) Text(rule.why, fontSize = 11.5.sp, color = muted, modifier = Modifier.padding(top = 3.dp))
        }
    }
}

/**
 * Copies the RAW rule (never the display copy with its wrap hints). Android 13+
 * confirms a copy with its own system overlay; below that the platform shows
 * nothing, so a short toast stands in for it. A compact bordered button the
 * height of the rule box beside it (web `.perm-copy`), not a Material button,
 * whose 40dp minimum would stand twice the rule's height.
 */
@Composable
private fun CopyRuleButton(rule: String) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    Text(
        "Copy",
        fontSize = 11.5.sp,
        maxLines = 1,
        softWrap = false,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(4.dp))
            .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(4.dp))
            .clickable(role = Role.Button, onClickLabel = "Copy this rule") {
                clipboard.setText(AnnotatedString(rule))
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
                }
            }
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}

/**
 * "Recent prompts (N)", collapsed by default. Its open state survives the
 * card's refresh and recomposition (the web's `permRecentOpen`).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecentPrompts(recent: List<PermissionRow>, nowMs: Long) {
    var open by rememberSaveable { mutableStateOf(false) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Text(
            (if (open) "▾ " else "▸ ") + "Recent prompts (${recent.size})",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.fillMaxWidth().clickable { open = !open }.padding(vertical = 6.dp),
        )
        if (!open) return@Column
        recent.forEachIndexed { i, r ->
            if (i > 0) HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
            Column(Modifier.fillMaxWidth().padding(vertical = 7.dp)) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    PermKindChip(r.kind, r.dialogKind)
                    PermSubject(r.kind, r.head, Permissions.subject(r))
                }
                // Host · wait/answer · age on a line of their own, host first.
                FlowRow(
                    Modifier.padding(top = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    for (m in Permissions.recentMeta(r, nowMs)) Text(m, fontSize = 11.5.sp, color = muted)
                }
            }
        }
    }
}
