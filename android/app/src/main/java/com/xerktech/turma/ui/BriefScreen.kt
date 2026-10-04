package com.xerktech.turma.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.BRIEF_SECTIONS
import com.xerktech.turma.core.briefDur
import com.xerktech.turma.core.briefItemMeta
import com.xerktech.turma.core.briefLiveOrgs
import com.xerktech.turma.core.briefOrgs
import com.xerktech.turma.core.briefPrUrl
import com.xerktech.turma.core.briefSection
import com.xerktech.turma.core.briefSectionCount
import com.xerktech.turma.core.briefSpendWindow
import com.xerktech.turma.core.orgName
import com.xerktech.turma.core.briefDecisionLines
import com.xerktech.turma.model.BriefItem
import com.xerktech.turma.model.OrgBrief
import com.xerktech.turma.model.OrgDecision
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BriefViewModel

/**
 * The per-org brief (XERK-1573) — web `brief.html`. One card per org in the
 * header's scope: its newest brief's headline counts, each section (needs you,
 * stalled, waiting, starts next, finished, closed as stale) and the spend, plus
 * "Brief now". The hub compiles the brief; this is a thin renderer over
 * `core/Brief.kt`.
 */
@Composable
fun BriefScreen(
    modifier: Modifier = Modifier,
    onOpenChat: (String, String) -> Unit = { _, _ -> },
    onOpenEnded: (host: String, transcriptId: String) -> Unit = { _, _ -> },
    vm: BriefViewModel = viewModel(),
) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val org by vm.orgFilter.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val errors by vm.errors.collectAsStateWithLifecycle()
    val sites = remember(fleet.briefs, fleet.agents, org) { briefOrgs(fleet.briefs, fleet.agents, org) }
    val live = remember(fleet.agents) { briefLiveOrgs(fleet.agents) }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Brief")
        LazyColumn(
            Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (sites.isEmpty()) item {
                Text(
                    "No org to brief — no host reports a tracker org yet.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(12.dp),
                )
            }
            items(sites.size, key = { sites[it] }) { i ->
                val site = sites[i]
                OrgBriefCard(
                    site = site,
                    brief = fleet.briefs[site]?.firstOrNull(),
                    earlier = (fleet.briefs[site]?.size ?: 1) - 1,
                    now = maxOf(fleet.now, System.currentTimeMillis()),
                    busy = site in busy,
                    canBrief = site in live,
                    error = errors[site],
                    decisions = fleet.decisions[site].orEmpty(),
                    onBriefNow = { vm.briefNow(site) },
                    onOpenChat = onOpenChat,
                    onOpenEnded = onOpenEnded,
                )
            }
        }
    }
}

@Composable
private fun OrgBriefCard(
    site: String,
    brief: OrgBrief?,
    earlier: Int,
    now: Long,
    busy: Boolean,
    canBrief: Boolean,
    error: String?,
    decisions: List<OrgDecision>,
    onBriefNow: () -> Unit,
    onOpenChat: (String, String) -> Unit,
    onOpenEnded: (String, String) -> Unit,
) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(orgName(site), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    if (brief != null) {
                        Text(
                            "${briefDur(now - brief.at)} ago · covers the last ${briefDur(brief.at - brief.since)}" +
                                if (brief.trigger == "manual") " · on demand" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                if (canBrief) {
                    OutlinedButton(onClick = onBriefNow, enabled = !busy) {
                        Text(if (busy) "Compiling…" else "Brief now")
                    }
                } else {
                    Text(
                        "no host in this org",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (error != null) {
                Text(error, style = MaterialTheme.typography.bodySmall, color = TurmaColors.critical)
            }
            if (brief == null) {
                Text(
                    "No brief yet — the hub compiles one every few hours, or tap Brief now.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            } else {
                BriefBody(brief, earlier, now, onOpenChat, onOpenEnded)
            }
            BriefDecisions(decisions, now)
        }
    }
}

/**
 * The org's decisions log (XERK-1574) — web `decisionsHtml`: the newest few,
 * newest first. Read-only here; recording a note is web-only (android/PARITY.md).
 */
@Composable
private fun BriefDecisions(decisions: List<OrgDecision>, now: Long) {
    if (decisions.isEmpty()) return
    Column {
        Text(
            "DECISIONS  ${decisions.size}",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
        )
        for ((title, meta) in briefDecisionLines(decisions, now)) {
            Column(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                Text(title, style = MaterialTheme.typography.bodyMedium)
                Text(meta, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BriefBody(
    brief: OrgBrief,
    earlier: Int,
    now: Long,
    onOpenChat: (String, String) -> Unit,
    onOpenEnded: (String, String) -> Unit,
) {
    Column {
        // The model-written summary (XERK-1574), labelled as such, above the
        // sections it was written from — web `narrativeHtml`.
        val narrative = brief.narrative
        if (!narrative.isNullOrBlank()) {
            Column(Modifier.fillMaxWidth().padding(top = 10.dp)) {
                Text(
                    "SUMMARY · WRITTEN BY A MODEL FROM THE SECTIONS BELOW",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(narrative, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(top = 2.dp))
            }
        }
        FlowRow(
            Modifier.fillMaxWidth().padding(top = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            val c = brief.counts
            BriefStat("Needs you", c.needsYou, if (c.needsYou > 0) TurmaColors.warning else null)
            BriefStat("Stalled", c.stalled, if (c.stalled > 0) TurmaColors.critical else null)
            BriefStat("Waiting", c.waiting, null)
            BriefStat("Finished", c.finished, null)
            BriefStat("Intake", c.intake, null)
            BriefStat("Resolved", c.outflow, null)
        }
        // Needs you always shows (an empty one is the good news); the others only
        // when they have rows — web brief.html's section rule.
        val shown = BRIEF_SECTIONS.filter { (key, _) -> key == "needsYou" || briefSection(brief, key).isNotEmpty() }
        for ((key, heading) in shown) {
            val rows = briefSection(brief, key)
            val total = briefSectionCount(brief, key)
            val sub = if (key == "nextUp" && !brief.autoStart) " · auto-start is off for this org" else ""
            Text(
                "${heading.uppercase()}  $total$sub",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp, bottom = 2.dp),
            )
            if (rows.isEmpty()) {
                Text("Nothing is waiting on you.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            for (row in rows) BriefRow(key, row, now, onOpenChat, onOpenEnded)
            if (total > rows.size) {
                Text("+${total - rows.size} more", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (brief.spend.isNotEmpty()) {
            Text("SPEND", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp, bottom = 2.dp))
            for (s in brief.spend) {
                val bits = mutableListOf(s.label)
                briefSpendWindow("5h", s.fiveHourPct, s.fiveHourResetsAt, now)?.let { bits += it }
                briefSpendWindow("7d", s.sevenDayPct, s.sevenDayResetsAt, now)?.let { bits += it }
                if (s.paused) bits += "auto-start paused"
                Text(bits.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                    color = if (s.paused) TurmaColors.warning else Color.Unspecified)
            }
        }
        if (earlier > 0) {
            Text("$earlier earlier brief${if (earlier == 1) "" else "s"} kept on the hub",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 10.dp))
        }
    }
}

@Composable
private fun BriefStat(label: String, n: Long, color: Color?) {
    Column {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("$n", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
            color = color ?: Color.Unspecified)
    }
}

@Composable
private fun BriefRow(
    section: String,
    item: BriefItem,
    now: Long,
    onOpenChat: (String, String) -> Unit,
    onOpenEnded: (String, String) -> Unit,
) {
    val uri = LocalUriHandler.current
    val host = item.host
    val sid = item.sessionId
    val tid = item.transcriptId
    val url = item.url
    val prUrl = briefPrUrl(item)
    // Same targets as the web rows: a live session opens its chat, an ended one
    // its read-only review, a PR its page — and a Done ticket its folded merged PR
    // (web links the row's "merged PR").
    val onClick: (() -> Unit)? = when {
        item.kind == "ticket" && prUrl != null -> {
            { uri.openUri(prUrl) }
        }
        item.kind == "session" && section != "finished" && host != null && sid != null -> {
            { onOpenChat(host, sid) }
        }
        item.kind == "session" && section == "finished" && host != null && !tid.isNullOrBlank() -> {
            { onOpenEnded(host, tid) }
        }
        item.kind == "pr" && url != null && (url.startsWith("https://") || url.startsWith("http://")) -> {
            { uri.openUri(url) }
        }
        else -> null
    }
    Column(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = 5.dp),
    ) {
        val key = item.key
        Text(
            if (item.kind == "ticket" && key != null) "$key  ${item.title}" else item.title,
            style = MaterialTheme.typography.bodyMedium,
            color = if (onClick != null) MaterialTheme.colorScheme.primary else Color.Unspecified,
        )
        val meta = briefItemMeta(section, item, now)
        if (meta.isNotEmpty()) {
            Text(meta, style = MaterialTheme.typography.bodySmall,
                color = when {
                    section == "stalled" -> TurmaColors.critical
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                })
        }
    }
}
