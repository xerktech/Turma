package com.xerktech.turma.ui

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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.xerktech.turma.core.ModelQuality
import com.xerktech.turma.core.Permissions
import com.xerktech.turma.core.orgName
import com.xerktech.turma.model.ModelQualityGroup
import com.xerktech.turma.model.ModelQualityRow
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.UsageViewModel

/**
 * "Model quality" (XERK-1849) — the Android port of usage.html's card
 * (`modelQualityCardHtml`) in its phone layout: each (class, model) a stacked
 * block of labelled counts, then the org-scoped "Sessions in <org>" disclosure,
 * or the hint to pick one org. Groups are fleet-wide whatever the header picks.
 */
@Composable
internal fun ModelQualitySection(
    ui: UsageViewModel.ModelQualityUi,
    nowMs: Long = ui.at.takeIf { it > 0 } ?: System.currentTimeMillis(),
) {
    val view = ui.view
    var rowsOpen by rememberSaveable { mutableStateOf(false) }
    val days = view?.windowDays?.takeIf { it > 0 } ?: ModelQuality.DEFAULT_WINDOW_DAYS
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    ProvideTextStyle(MaterialTheme.typography.bodySmall) {
        Column(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 6.dp)) {
            Text("Model quality", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface)
            Text(ModelQuality.note(days), color = muted)
            val groups = view?.groups.orEmpty().filter { it.cls.isNotEmpty() && it.model.isNotEmpty() }
            val empty = when {
                view == null && !ui.error.isNullOrEmpty() -> "Could not load model quality (${ui.error})."
                view == null -> "Loading…"
                groups.isEmpty() -> "No ticket sessions recorded yet."
                else -> null
            }
            if (empty != null || view == null) {
                Text(empty.orEmpty(), color = muted, modifier = Modifier.padding(top = 6.dp))
                return@Column
            }
            val base = ModelQuality.baselines(groups)
            val rework = ModelQuality.hasRework(groups)
            val shadow = ModelQuality.hasShadow(groups)
            ModelQuality.ordered(groups).forEachIndexed { i, g ->
                if (i > 0) HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
                GroupBlock(g, ModelQuality.opusRate(g, base), rework, shadow)
            }
            if (ui.org.isEmpty()) {
                Text(ModelQuality.PICK_ORG, color = muted, modifier = Modifier.padding(top = 12.dp))
            } else if (view.rows.isEmpty()) {
                Text("No ticket sessions recorded for ${orgName(ui.org)}.", color = muted, modifier = Modifier.padding(top = 12.dp))
            } else {
                SessionRows(orgName(ui.org), view.rows, nowMs, rowsOpen) { rowsOpen = it }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GroupBlock(g: ModelQualityGroup, opus: Double?, rework: Boolean, shadow: Boolean) {
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(g.cls) }
                append("  ")
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)) {
                    append(g.model)
                }
            },
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.onSurface,
        )
        val other = ModelQuality.other(g)
        if (other.isNotEmpty()) Text(other, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Stat("Sessions", g.sessions.toString())
            Stat("Good", g.good.toString(), TurmaColors.good)
            Stat("Bad", g.bad.toString(), if (g.bad > 0) TurmaColors.critical else null)
            Stat("Pending", g.pending.toString())
            Stat("Bad rate", ModelQuality.pct(ModelQuality.badRate(g)))
            // No Opus figure for Opus itself or a class with none decided: no bare "—".
            if (opus != null) Stat("Opus", ModelQuality.pct(opus))
            if (rework) {
                Stat("QA passes", ModelQuality.median(g.rework?.qaPasses))
                Stat("CI rounds", ModelQuality.median(g.rework?.ciRounds))
            }
            if (shadow) Stat("Shadow pairs", ModelQuality.shadow(g))
            val status = ModelQuality.status(g)
            if (status != "—") Stat("Status", status)
        }
    }
}

@Composable
private fun Stat(label: String, value: String, color: Color? = null) {
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("$label ") }
            withStyle(SpanStyle(color = color ?: MaterialTheme.colorScheme.onSurface)) { append(value) }
        },
        fontSize = 12.sp,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SessionRows(
    org: String,
    rows: List<ModelQualityRow>,
    nowMs: Long,
    open: Boolean,
    setOpen: (Boolean) -> Unit,
) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val uri = LocalUriHandler.current
    Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Text(
            (if (open) "▾ " else "▸ ") + "Sessions in $org (${rows.size})",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.fillMaxWidth().clickable { setOpen(!open) }.padding(vertical = 6.dp),
        )
        if (!open) return@Column
        rows.forEachIndexed { i, r ->
            if (i > 0) HorizontalDivider(thickness = 1.dp, color = MaterialTheme.colorScheme.outlineVariant)
            FlowRow(
                Modifier.fillMaxWidth().padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(r.issue.ifEmpty { "—" }, fontFamily = FontFamily.Monospace, fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface)
                OutcomeChip(ModelQuality.outcomeOf(r.outcome))
                val meta = listOf(
                    "${r.cls.ifEmpty { "other" }} · ${r.model.ifEmpty { "default" }}",
                    r.reason.orEmpty(), r.host, r.repo.orEmpty(),
                )
                for (m in meta) if (m.isNotEmpty()) Text(m, fontSize = 11.5.sp, color = muted)
                for (p in r.prs) {
                    val (label, state) = ModelQuality.prLabel(p) ?: continue
                    Row {
                        Text(label, fontSize = 11.5.sp, color = MaterialTheme.colorScheme.primary,
                            textDecoration = TextDecoration.Underline,
                            modifier = Modifier.clickable { runCatching { uri.openUri(p.url) } })
                        if (state.isNotEmpty()) Text(" $state", fontSize = 11.5.sp, color = muted)
                    }
                }
                val at = r.updatedAt?.takeIf { it.isFinite() && it > 0 }
                if (at != null) {
                    Text(Permissions.fmtDuration(Math.round((nowMs - at) / 1000.0)) + " ago", fontSize = 11.5.sp, color = muted)
                }
            }
        }
    }
}

@Composable
private fun OutcomeChip(outcome: String) {
    val color = when (outcome) {
        "good" -> TurmaColors.good
        "bad" -> TurmaColors.critical
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(
        ModelQuality.OUTCOME_LABELS[outcome].orEmpty(),
        fontSize = 11.sp,
        color = color,
        modifier = Modifier.border(1.dp, color, RoundedCornerShape(50)).padding(horizontal = 6.dp),
    )
}
