package com.xerktech.turma.ui

import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.BriefPage
import com.xerktech.turma.core.briefAt
import com.xerktech.turma.core.briefHeadline
import com.xerktech.turma.core.briefPage
import com.xerktech.turma.core.briefSections
import com.xerktech.turma.core.briefWhenLabel
import com.xerktech.turma.core.effectiveOrgs
import com.xerktech.turma.core.meetingsPending
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.nextBriefMeeting
import com.xerktech.turma.core.orgName
import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.ZoneId
import java.util.Locale

/** The Brief screen's two panes, as the web Brief page's sub-tabs (XERK-2623). */
enum class BriefPane(val label: String) { BRIEF("Daily brief"), MEETINGS("Meetings") }

/**
 * The Brief tab: the Daily brief and the Meetings review (XERK-2623), one pane
 * each, as the web's /brief and its #meetings. The pane lives in TurmaApp so a
 * meetings push can open it.
 */
@Composable
fun BriefScreen(
    modifier: Modifier = Modifier,
    pane: BriefPane = BriefPane.BRIEF,
    onPane: (BriefPane) -> Unit = {},
    vm: BriefViewModel = viewModel(),
    meetingsVm: MeetingsViewModel = viewModel(),
) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val stored by vm.orgFilter.collectAsStateWithLifecycle()
    val sites = remember(fleet.agents) { mergeSites(fleet.agents) }
    val scoped = remember(stored, sites) { effectiveOrgs(stored, sites) }
    val pending = remember(fleet.meetingProposals, scoped) { meetingsPending(fleet.meetingProposals, scoped) }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Brief")
        TabRow(selectedTabIndex = pane.ordinal, containerColor = MaterialTheme.colorScheme.background) {
            for (p in BriefPane.entries) {
                Tab(
                    selected = p == pane,
                    onClick = { onPane(p) },
                    text = { Text(if (p == BriefPane.MEETINGS && pending > 0) "${p.label} ($pending)" else p.label) },
                )
            }
        }
        when (pane) {
            BriefPane.BRIEF -> DailyBriefPane(Modifier.weight(1f), vm)
            BriefPane.MEETINGS -> MeetingsPane(Modifier.weight(1f), meetingsVm)
        }
    }
}

/**
 * The Daily Brief (XERK-2397, the web's Brief page): one org's latest standup
 * summary in large type to read aloud at the meeting, when the next meeting is,
 * Run now, and the earlier briefs as headlines. The org is the header's pick
 * when it names exactly one; otherwise a chip row picks among the fleet's orgs.
 * Schedules are edited on the web only (android/PARITY.md).
 */
@Composable
private fun DailyBriefPane(modifier: Modifier, vm: BriefViewModel) {
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val stored by vm.orgFilter.collectAsStateWithLifecycle()
    val asking by vm.asking.collectAsStateWithLifecycle()

    val context = LocalContext.current
    LaunchedEffect(Unit) {
        // Messages land from OkHttp's threads; Toast wants the main looper.
        vm.messages.collect { msg ->
            Handler(Looper.getMainLooper()).post {
                Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
            }
        }
    }

    val sites = remember(fleet.agents) { mergeSites(fleet.agents) }
    val scoped = remember(stored, sites) { effectiveOrgs(stored, sites) }
    // Offered orgs: the header's scope when it applies, else every org.
    val offered = remember(sites, scoped) {
        if (scoped.isEmpty()) sites else sites.filter { it.siteKey in scoped }
    }
    var picked by rememberSaveable { mutableStateOf("") }
    val siteKey = when {
        offered.any { it.siteKey == picked } -> picked
        else -> offered.firstOrNull { !fleet.dailyBriefs[it.siteKey].isNullOrEmpty() }?.siteKey
            ?: offered.firstOrNull()?.siteKey.orEmpty()
    }
    val now = remember(fleet) { System.currentTimeMillis() }
    val page = remember(fleet.dailyBriefs, siteKey) { briefPage(fleet.dailyBriefs[siteKey].orEmpty()) }
    val nextMeeting = remember(fleet.dailyBriefSchedules, siteKey, now) {
        nextBriefMeeting(fleet.dailyBriefSchedules[siteKey], now)
    }

    Column(modifier.fillMaxSize()) {
        if (offered.size > 1) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
                    .padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (s in offered) {
                    FilterChip(
                        selected = s.siteKey == siteKey,
                        onClick = { picked = s.siteKey },
                        label = { Text(orgName(s.siteKey, s.orgName)) },
                    )
                }
            }
        }
        if (siteKey.isEmpty()) {
            Text(
                "No org is reporting. A brief needs a host polling a tracker.",
                Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Column
        }
        BriefBody(
            page = page,
            nextMeeting = nextMeeting,
            now = now,
            running = page.running != null,
            asking = siteKey in asking,
            onRunNow = { vm.runNow(siteKey) },
        )
    }
}

/** Everything below the header for one org; split out so tests render it directly. */
@Composable
fun BriefBody(
    page: BriefPage,
    nextMeeting: Long?,
    now: Long,
    running: Boolean,
    asking: Boolean,
    onRunNow: () -> Unit,
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (nextMeeting != null) "Next meeting " + briefWhenLabel(nextMeeting, now, zone, locale)
                else "No meeting scheduled",
                Modifier.weight(1f),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            PrimaryButton(
                when {
                    running -> "Writing…"
                    asking -> "Asking…"
                    else -> "Run now"
                },
                onClick = onRunNow,
                enabled = !running && !asking,
            )
        }
        page.failed?.let { f ->
            Text(
                briefHeadline(f),
                color = TurmaColors.critical,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        val shown = page.shown
        if (shown == null) {
            Text(
                if (running) "The first brief is being written." else "No brief yet. Run now writes one.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            BriefReadAloud(shown, now, zone, locale)
        }
        if (page.earlier.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            SectionLabel("Earlier briefs")
            for (b in page.earlier) {
                TurmaCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            briefWhenLabel(briefAt(b), now, zone, locale) +
                                if (b.trigger == "manual") " · Run now" else "",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            briefHeadline(b),
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (b.status == "failed") TurmaColors.critical
                            else MaterialTheme.colorScheme.onSurface,
                        )
                    }
                }
            }
        }
    }
}

/** The brief to read aloud: large type, one block per section. */
@Composable
private fun BriefReadAloud(b: DailyBrief, now: Long, zone: ZoneId, locale: Locale) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                (if (b.trigger == "manual") "Run now · " else "For ") +
                    briefWhenLabel(briefAt(b), now, zone, locale),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            for ((label, text) in briefSections(b)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        label,
                        Modifier.semantics { heading() },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    // Read-aloud size: legible at arm's length during the meeting.
                    Text(text, fontSize = 22.sp, lineHeight = 32.sp)
                }
            }
        }
    }
}
