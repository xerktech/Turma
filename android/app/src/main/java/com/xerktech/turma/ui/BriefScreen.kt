package com.xerktech.turma.ui

import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.TriageEntry
import com.xerktech.turma.core.TriageFilter
import com.xerktech.turma.core.briefAt
import com.xerktech.turma.core.briefHeadline
import com.xerktech.turma.core.briefSections
import com.xerktech.turma.core.briefWhenLabel
import com.xerktech.turma.core.effectiveOrgs
import com.xerktech.turma.core.focusNames
import com.xerktech.turma.core.meetingArchivable
import com.xerktech.turma.core.meetingItemsSplit
import com.xerktech.turma.core.meetingLabelMissLabels
import com.xerktech.turma.core.meetingMetaLine
import com.xerktech.turma.core.meetingProgress
import com.xerktech.turma.core.meetingProject
import com.xerktech.turma.core.meetingStatusLine
import com.xerktech.turma.core.meetingsNeedProject
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.nextBriefMeeting
import com.xerktech.turma.core.orgName
import com.xerktech.turma.core.safeMeetingUrl
import com.xerktech.turma.core.triageBriefStatus
import com.xerktech.turma.core.triageBuckets
import com.xerktech.turma.core.triageEntries
import com.xerktech.turma.core.triageNext
import com.xerktech.turma.core.triageTitle
import com.xerktech.turma.model.DailyBrief
import com.xerktech.turma.model.DailyBriefSchedule
import com.xerktech.turma.model.Meeting
import com.xerktech.turma.net.FleetState
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import com.xerktech.turma.vm.MetaState
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.time.ZoneId
import java.util.Locale

/**
 * The Brief tab (XERK-2858, the web's two-pane triage of XERK-2857): every
 * org's meetings in one list — collapsible orgs, date buckets, Needs review /
 * All / Archived, search — with the Daily brief folded into each org's
 * daily-meeting entry. A phone shows one pane at a time: the list, an entry,
 * or an org's settings, Back returning to the list. [openSite] (a meetings
 * push) unfolds that org on Needs review.
 */
@Composable
fun BriefScreen(
    modifier: Modifier = Modifier,
    openSite: String? = null,
    onOpened: () -> Unit = {},
    vm: BriefViewModel = viewModel(),
    meetingsVm: MeetingsViewModel = viewModel(),
) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val stored by vm.orgFilter.collectAsStateWithLifecycle()
    val collapsed by meetingsVm.collapsed.collectAsStateWithLifecycle()

    val context = LocalContext.current
    LaunchedEffect(Unit) {
        // Messages land from OkHttp's threads; Toast wants the main looper.
        coroutineScope {
            launch { vm.messages.collect { toast(context, it) } }
            launch { meetingsVm.messages.collect { toast(context, it) } }
        }
    }

    var filter by rememberSaveable { mutableStateOf(TriageFilter.REVIEW) }
    var query by rememberSaveable { mutableStateOf("") }
    // The open entry as "site\u0000key", and the org whose settings are open.
    var selected by rememberSaveable { mutableStateOf("") }
    var settingsFor by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(openSite) {
        val s = openSite ?: return@LaunchedEffect
        filter = TriageFilter.REVIEW
        selected = ""
        settingsFor = ""
        if (s in collapsed) meetingsVm.toggleCollapsed(s)
        onOpened()
    }

    val sites = remember(fleet.agents) { mergeSites(fleet.agents) }
    val names = remember(sites) { sites.associate { it.siteKey to it.orgName } }
    val scoped = remember(stored, sites) { effectiveOrgs(stored, sites) }
    val now = remember(fleet) { System.currentTimeMillis() }
    val orgs = remember(fleet, scoped, sites) { triageOrgs(fleet, scoped, sites.map { it.siteKey }) }
    val entries = remember(fleet, orgs, now) {
        orgs.associateWith { s ->
            triageEntries(s, fleet.meetingProposals[s].orEmpty(), fleet.dailyBriefs[s].orEmpty(),
                fleet.dailyBriefSchedules[s], now)
        }
    }

    BackHandler(enabled = selected.isNotEmpty() || settingsFor.isNotEmpty()) {
        selected = ""
        settingsFor = ""
    }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Brief")
        when {
            settingsFor.isNotEmpty() -> OrgSettings(
                Modifier.weight(1f), settingsFor, orgName(settingsFor, names[settingsFor].orEmpty()),
                fleet, meetingsVm, now, onBack = { settingsFor = "" },
            )
            selected.isNotEmpty() -> {
                val site = selected.substringBefore('\u0000')
                val key = selected.substringAfter('\u0000')
                val e = entries[site]?.firstOrNull { it.key == key }
                if (e == null) {
                    // Gone from the store (evicted, or another org scope): back to the list.
                    LaunchedEffect(selected) { selected = "" }
                } else {
                    // Every org's list, in the order shown, so "Next" moves on
                    // across orgs once this one is reviewed.
                    val ordered = orgs.flatMap { s ->
                        triageBuckets(entries[s].orEmpty(), TriageFilter.ALL, "", now, ZoneId.systemDefault())
                            .flatMap { it.second }
                    }
                    EntryDetail(
                        Modifier.weight(1f), e, orgName(site, names[site].orEmpty()), now, fleet,
                        vm, meetingsVm,
                        next = triageNext(ordered, e),
                        onOpen = { n -> selected = "${n.siteKey}\u0000${n.key}" },
                        onBack = { selected = "" },
                    )
                }
            }
            else -> TriageList(
                Modifier.weight(1f), fleet, orgs, names, entries, collapsed, filter, query, now,
                onFilter = { filter = it }, onQuery = { query = it },
                onToggle = meetingsVm::toggleCollapsed,
                onOpen = { e -> selected = "${e.siteKey}\u0000${e.key}" },
                onSettings = { settingsFor = it },
            )
        }
    }
}

private fun toast(context: android.content.Context, msg: String) {
    Handler(Looper.getMainLooper()).post { Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
}

/**
 * The orgs the list shows: every org a host reports (so a fresh org's ⚙ is
 * reachable) plus any with meetings, briefs or a schedule, inside the
 * header's scope (empty = all).
 */
internal fun triageOrgs(fleet: FleetState, scoped: Set<String>, reported: List<String>): List<String> =
    (reported + fleet.meetingProposals.filterValues { it.isNotEmpty() }.keys + fleet.dailyBriefs.keys +
        fleet.dailyBriefSchedules.keys)
        .distinct().filter { scoped.isEmpty() || it in scoped }.sorted()

@Composable
private fun TriageList(
    modifier: Modifier,
    fleet: FleetState,
    orgs: List<String>,
    names: Map<String, String>,
    entries: Map<String, List<TriageEntry>>,
    collapsed: Set<String>,
    filter: TriageFilter,
    query: String,
    now: Long,
    onFilter: (TriageFilter) -> Unit,
    onQuery: (String) -> Unit,
    onToggle: (String) -> Unit,
    onOpen: (TriageEntry) -> Unit,
    onSettings: (String) -> Unit,
) {
    val zone = ZoneId.systemDefault()
    val locale = Locale.getDefault()
    val misses = remember(fleet.meetingLabelMisses) { meetingLabelMissLabels(fleet.meetingLabelMisses) }
    // The filter and search stay put above the list, as the web rail's header does.
    Column(modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (f in TriageFilter.entries) {
                    FilterChip(selected = f == filter, onClick = { onFilter(f) }, label = { Text(f.label) })
                }
            }
            OutlinedTextField(
                query, { onQuery(it.take(200)) }, Modifier.fillMaxWidth(),
                placeholder = { Text("Search meetings and proposals") }, singleLine = true,
            )
        }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (misses.isNotEmpty()) {
                item(key = "misses") {
                    Text(
                        "Tenir sent meetings for " + misses.joinToString(", ") { "\"$it\"" } +
                            ", which no org answers to. Give an org that label in its settings and they arrive.",
                        Modifier.fillMaxWidth()
                            .background(TurmaColors.critical.copy(alpha = 0.10f), RoundedCornerShape(10.dp))
                            .padding(10.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            if (orgs.isEmpty()) {
                item(key = "empty") {
                    Text(
                        "No org is reporting. Meetings and briefs need a host polling a tracker.",
                        Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            for (site in orgs) {
                val list = entries[site].orEmpty()
                val folded = site in collapsed
                val pending = list.filter { !it.archived }.sumOf { it.pending }
                item(key = "org:$site") {
                    OrgGroupHead(orgName(site, names[site].orEmpty()), pending, folded, { onToggle(site) }, { onSettings(site) })
                }
                if (folded) continue
                val buckets = triageBuckets(list, filter, query, now, zone)
                if (buckets.isEmpty()) {
                    item(key = "none:$site") {
                        Text(
                            when {
                                query.isNotBlank() -> "Nothing matches."
                                filter == TriageFilter.REVIEW -> "Nothing needs review."
                                filter == TriageFilter.ARCHIVED -> "No archived meetings."
                                else -> "No meetings yet — when Tenir sends one, its proposed work items show up here."
                            },
                            Modifier.padding(start = 8.dp, bottom = 4.dp),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                for ((bucket, rows) in buckets) {
                    item(key = "b:$site:${bucket.name}") {
                        SectionLabel(bucket.label, Modifier.padding(start = 4.dp, top = 4.dp))
                    }
                    for (e in rows) {
                        item(key = "e:$site:${e.key}") { EntryRow(e, now, zone, locale) { onOpen(e) } }
                    }
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

@Composable
private fun OrgGroupHead(name: String, pending: Int, folded: Boolean, onToggle: () -> Unit, onSettings: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp).clip8().clickable(onClick = onToggle)
            .semantics { contentDescription = if (folded) "Expand $name" else "Collapse $name" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (folded) Icons.Filled.ChevronRight else Icons.Filled.ExpandMore, null,
            Modifier.padding(horizontal = 4.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            name, Modifier.weight(1f).semantics { heading() },
            style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
        )
        if (pending > 0) CountPill(pending)
        IconButton(onClick = onSettings) {
            Icon(Icons.Outlined.Settings, "$name settings", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

private fun Modifier.clip8() = this.clip(RoundedCornerShape(8.dp))

@Composable
private fun CountPill(n: Int) {
    Text(
        "$n",
        Modifier.background(MaterialTheme.colorScheme.primary, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 1.dp),
        color = MaterialTheme.colorScheme.onPrimary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
    )
}

@Composable
private fun EntryRow(e: TriageEntry, now: Long, zone: ZoneId, locale: Locale, onClick: () -> Unit) {
    TurmaCard(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(triageTitle(e), fontWeight = FontWeight.SemiBold, maxLines = 2)
                Text(
                    entrySubline(e, now, zone, locale),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (e.pending > 0) CountPill(e.pending)
        }
    }
}

/** "Today 9:30 AM · Brief ready · 2 of 5 reviewed". */
internal fun entrySubline(e: TriageEntry, now: Long, zone: ZoneId, locale: Locale): String {
    val bits = mutableListOf<String>()
    if (e.at > 0) bits += briefWhenLabel(e.at, now, zone, locale)
    triageBriefStatus(e)?.let { bits += it }
    val m = e.meeting
    when {
        m == null -> if (e.daily && !e.upcoming) bits += "Not captured"
        m.status == "queued" || m.status == "running" -> bits += "Reading the captions…"
        m.status == "failed" -> bits += "Could not propose work items"
        else -> bits += meetingProgress(m) ?: "Nothing to propose"
    }
    if (e.archived) bits += "Archived"
    return bits.joinToString(" · ")
}

@Composable
private fun BackRow(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        GhostButton("‹ Back", onBack)
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

/** One entry worked on its own: a daily entry's brief on top, then the meeting's proposals. */
@Composable
private fun EntryDetail(
    modifier: Modifier,
    e: TriageEntry,
    org: String,
    now: Long,
    fleet: FleetState,
    vm: BriefViewModel,
    mvm: MeetingsViewModel,
    next: TriageEntry?,
    onOpen: (TriageEntry) -> Unit,
    onBack: () -> Unit,
) {
    val asking by vm.asking.collectAsStateWithLifecycle()
    val zone = ZoneId.systemDefault()
    val locale = Locale.getDefault()
    val site = e.siteKey
    Column(modifier.fillMaxSize()) {
        BackRow(org, onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(triageTitle(e), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold)
            if (e.daily) {
                val briefs = fleet.dailyBriefs[site].orEmpty()
                DailyPart(
                    e, now, zone, locale,
                    running = briefs.firstOrNull()?.status == "running",
                    asking = site in asking,
                    onRunNow = { vm.runNow(site) },
                )
            }
            val m = e.meeting
            if (m != null) {
                if (e.daily) HorizontalDivider()
                MeetingPart(site, m, mvm)
            }
            if (m == null || m.status == "ok" && e.pending == 0) {
                if (next != null) {
                    PrimaryButton("Next: ${triageTitle(next)} ›", { onOpen(next) }, Modifier.fillMaxWidth())
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}

/** A daily entry's brief: what it reads aloud, or why there is none, and Run now for the next meeting. */
@Composable
private fun DailyPart(
    e: TriageEntry,
    now: Long,
    zone: ZoneId,
    locale: Locale,
    running: Boolean,
    asking: Boolean,
    onRunNow: () -> Unit,
) {
    Text(
        (if (e.upcoming) "Next meeting " else "Meeting ") + briefWhenLabel(e.at, now, zone, locale),
        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (e.upcoming) {
        PrimaryButton(
            when {
                running -> "Writing…"
                asking -> "Asking…"
                else -> "Run now"
            },
            onClick = onRunNow, enabled = !running && !asking,
        )
    }
    val b = e.brief
    when {
        b == null -> Text(
            if (e.upcoming) "No brief yet. It is written before the meeting, or Run now writes one."
            else "No brief was written for this meeting.",
            style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        b.status == "ok" && briefSections(b).isNotEmpty() -> BriefReadAloud(b, now, zone, locale)
        else -> Text(
            briefHeadline(b),
            style = MaterialTheme.typography.bodyLarge,
            color = if (b.status == "failed") TurmaColors.critical else MaterialTheme.colorScheme.onSurface,
        )
    }
}

/** The brief to read aloud: large type, one block per section. */
@Composable
internal fun BriefReadAloud(b: DailyBrief, now: Long, zone: ZoneId, locale: Locale) {
    TurmaCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(
                (if (b.trigger == "manual") "Run now · " else "For ") + briefWhenLabel(briefAt(b), now, zone, locale),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            for ((label, text) in briefSections(b)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        label, Modifier.semantics { heading() },
                        style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    // Read-aloud size: legible at arm's length during the meeting.
                    Text(text, fontSize = 22.sp, lineHeight = 32.sp)
                }
            }
        }
    }
}

/** A captured meeting's review: progress, Archive, the pending proposals, reviewed ones on demand. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MeetingPart(site: String, m: Meeting, mvm: MeetingsViewModel) {
    val busy by mvm.busy.collectAsStateWithLifecycle()
    val errors by mvm.errors.collectAsStateWithLifecycle()
    val drafts by mvm.drafts.collectAsStateWithLifecycle()
    val meta by mvm.meta.collectAsStateWithLifecycle()
    val picks by mvm.picks.collectAsStateWithLifecycle()
    val archiving by mvm.archiving.collectAsStateWithLifecycle()
    val uri = LocalUriHandler.current
    val needsProject = meetingsNeedProject(listOf(m))
    LaunchedEffect(site, needsProject) { if (needsProject) mvm.ensureMeta(site) }
    val project = meetingProject(picks[site], (meta[site] as? MetaState.Projects)?.projects.orEmpty())
    val types = if (project.isEmpty()) null else meta[MeetingsViewModel.typesKey(site, project)]
    var showReviewed by rememberSaveable(site, m.meetingId) { mutableStateOf(false) }

    val metaLine = meetingMetaLine(m)
    if (metaLine.isNotEmpty()) {
        Text(metaLine, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        meetingProgress(m)?.let {
            Text(it, Modifier.padding(vertical = 5.dp), style = MaterialTheme.typography.labelLarge)
        }
        val url = safeMeetingUrl(m.tenirUrl)
        if (url.isNotEmpty()) GhostButton("Open in Tenir ↗", { uri.openUri(url) })
        if (meetingArchivable(m)) {
            val inFlight = "$site\u0000${m.meetingId}" in archiving
            val archived = m.archivedAt > 0
            GhostButton(
                if (inFlight) "Working…" else if (archived) "Unarchive meeting" else "Archive meeting",
                { mvm.archive(site, m, !archived) }, enabled = !inFlight,
            )
        }
    }
    if (needsProject) {
        ProjectTarget(meta[site], project, { mvm.setProject(site, it) }, { mvm.retryMeta(site) })
    }
    val status = meetingStatusLine(m)
    if (status != null) {
        Text(status.first, style = MaterialTheme.typography.bodyMedium,
            color = if (status.second) TurmaColors.critical else MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    val act = ItemActions(
        onApprove = { it, start -> mvm.review(site, m, it, "approve", start) },
        onReject = { mvm.review(site, m, it, "reject") },
        onReopen = { mvm.reopen(site, m, it) },
        onEdit = { mvm.startEdit(site, m, it) },
        onDraft = { it, f -> mvm.editDraft(MeetingsViewModel.itemKey(site, m.meetingId, it.id), f) },
        onCancel = { mvm.cancelEdit(MeetingsViewModel.itemKey(site, m.meetingId, it.id)) },
    )
    val (pending, reviewed) = meetingItemsSplit(m)
    val ui = { it: com.xerktech.turma.model.MeetingItem ->
        val k = MeetingsViewModel.itemKey(site, m.meetingId, it.id)
        ItemUi(k in busy, errors[k], drafts[k])
    }
    if (pending.isEmpty()) {
        Text("✓ Every proposal is reviewed.", color = TurmaColors.good, style = MaterialTheme.typography.bodyMedium)
    }
    for (it in pending) {
        TurmaCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp)) { ItemRow(m, it, ui(it), types, act) }
        }
    }
    if (reviewed.isNotEmpty()) {
        GhostButton(
            if (showReviewed) "Hide reviewed (${reviewed.size})" else "Show reviewed (${reviewed.size})",
            { showReviewed = !showReviewed },
        )
        if (showReviewed) {
            for (it in reviewed) {
                TurmaCard(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) { ItemRow(m, it, ui(it), types, act) }
                }
            }
        }
    }
}

private val WEEKDAY_LETTERS = listOf("S", "M", "T", "W", "T", "F", "S")

/**
 * One org's settings (the web's ⚙ drawer): where new tickets go, whose work
 * the meetings propose, the Tenir label, and the daily brief schedule with
 * the daily-meeting title keyword. Each section saves on its own.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OrgSettings(
    modifier: Modifier,
    site: String,
    org: String,
    fleet: FleetState,
    mvm: MeetingsViewModel,
    now: Long,
    onBack: () -> Unit,
) {
    val meta by mvm.meta.collectAsStateWithLifecycle()
    val picks by mvm.picks.collectAsStateWithLifecycle()
    val saving by mvm.saving.collectAsStateWithLifecycle()
    val saved by mvm.saved.collectAsStateWithLifecycle()
    LaunchedEffect(site) { mvm.ensureMeta(site) }
    val project = meetingProject(picks[site], (meta[site] as? MetaState.Projects)?.projects.orEmpty())
    fun k(what: String) = "$site\u0000$what"

    Column(modifier.fillMaxSize()) {
        BackRow("$org · settings", onBack)
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("$org settings", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold)

            SectionLabel("New tickets")
            ProjectTarget(meta[site], project, { mvm.setProject(site, it) }, { mvm.retryMeta(site) })

            // Whose work (XERK-2514): one name per line, since a name may hold a comma.
            SectionLabel("Whose work")
            val focus = fleet.meetingFocus[site]
            var names by rememberSaveable(site, focus) { mutableStateOf(focus?.names.orEmpty().joinToString("\n")) }
            var role by rememberSaveable(site, focus) { mutableStateOf(focus?.role.orEmpty()) }
            Text(
                "Meetings propose only these people's work (a decision always stays). Empty = everyone's.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                names, { names = it.take(600); mvm.clearSaved(site, "focus") }, Modifier.fillMaxWidth(),
                label = { Text("Names, one per line") }, minLines = 2,
            )
            OutlinedTextField(
                role, { role = it.take(300); mvm.clearSaved(site, "focus") }, Modifier.fillMaxWidth(),
                label = { Text("Role (optional)") }, singleLine = true,
            )
            SaveRow("focus", k("focus") in saving, k("focus") in saved) { mvm.saveFocus(site, focusNames(names), role) }

            // Tenir label (XERK-2638): blank goes back to the default slug.
            SectionLabel("Tenir label")
            val label = fleet.meetingLabels[site]
            var own by rememberSaveable(site, label) { mutableStateOf(if (label?.custom == true) label.label else "") }
            Text(
                when {
                    label == null -> "Tenir names this org by a label; this hub has not said which yet."
                    label.label.isEmpty() -> "This org has no label Tenir can use yet — give it one."
                    label.custom -> "Tenir sends this org's meetings as \"${label.label}\"."
                    else -> "Tenir sends this org's meetings as \"${label.label}\" (the default)."
                },
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                own, { own = it.take(40); mvm.clearSaved(site, "label") }, Modifier.fillMaxWidth(),
                label = { Text("Label (blank = default)") }, singleLine = true,
            )
            SaveRow("label", k("label") in saving, k("label") in saved) { mvm.saveLabel(site, own) }

            ScheduleSection(site, fleet.dailyBriefSchedules[site], now, k("schedule") in saving,
                k("schedule") in saved, { mvm.clearSaved(site, "schedule") }) { mvm.saveSchedule(site, it) }
            Spacer(Modifier.height(16.dp))
        }
    }
}

@Composable
private fun SaveRow(tag: String, busy: Boolean, done: Boolean, onSave: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        PrimaryButton(if (busy) "Saving…" else "Save", onSave, Modifier.testTag("save-$tag"), enabled = !busy)
        if (done) Text("Saved", color = TurmaColors.good, style = MaterialTheme.typography.bodyMedium)
    }
}

/** The daily brief schedule (XERK-2391) and the daily meeting's title keyword (XERK-2856). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScheduleSection(
    site: String,
    s: DailyBriefSchedule?,
    now: Long,
    busy: Boolean,
    done: Boolean,
    onEdit: () -> Unit,
    onSave: (kotlinx.serialization.json.JsonObject) -> Unit,
) {
    SectionLabel("Daily brief")
    var enabled by rememberSaveable(site, s) { mutableStateOf(s?.enabled ?: false) }
    var time by rememberSaveable(site, s) { mutableStateOf(s?.time?.ifEmpty { null } ?: "09:30") }
    var zone by rememberSaveable(site, s) { mutableStateOf(s?.timeZone?.ifEmpty { null } ?: ZoneId.systemDefault().id) }
    var days by rememberSaveable(site, s) { mutableStateOf(s?.weekdays ?: listOf(1, 2, 3, 4, 5)) }
    var lead by rememberSaveable(site, s) { mutableStateOf((s?.leadMinutes ?: 5).toString()) }
    var title by rememberSaveable(site, s) { mutableStateOf(s?.meetingTitle.orEmpty()) }
    Text(
        nextBriefMeeting(s, now)?.let { "Next meeting " + briefWhenLabel(it, now, ZoneId.systemDefault(), Locale.getDefault()) }
            ?: "No meeting scheduled",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Write a brief before each meeting", Modifier.weight(1f))
        Switch(enabled, { enabled = it; onEdit() })
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(time, { time = it.take(5); onEdit() }, Modifier.weight(1f),
            label = { Text("Meeting time (HH:MM)") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        OutlinedTextField(lead, { lead = it.filter(Char::isDigit).take(3); onEdit() }, Modifier.weight(1f),
            label = { Text("Brief, minutes before") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
    }
    OutlinedTextField(zone, { zone = it.take(64); onEdit() }, Modifier.fillMaxWidth(),
        label = { Text("Time zone") }, singleLine = true)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (d in 0..6) {
            FilterChip(
                selected = d in days,
                onClick = { days = if (d in days) days - d else (days + d).sorted(); onEdit() },
                label = { Text(WEEKDAY_LETTERS[d]) },
                modifier = Modifier.semantics {
                    contentDescription = java.time.DayOfWeek.of(if (d == 0) 7 else d)
                        .getDisplayName(java.time.format.TextStyle.FULL, Locale.getDefault())
                },
            )
        }
    }
    OutlinedTextField(title, { title = it.take(100); onEdit() }, Modifier.fillMaxWidth(),
        label = { Text("Daily meeting title contains") }, singleLine = true)
    Text(
        "A meeting at the scheduled time, or whose title contains this, is the daily meeting: its " +
            "proposals sit under that day's brief.",
        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    SaveRow("schedule", busy, done) {
        // The hub merges these over the stored schedule and validates the
        // whole (a 400 in its words), so nothing is checked twice here.
        onSave(buildJsonObject {
            put("enabled", enabled)
            put("time", time.trim())
            put("timeZone", zone.trim())
            putJsonArray("weekdays") { days.forEach { add(JsonPrimitive(it)) } }
            lead.toIntOrNull()?.let { put("leadMinutes", it) }
            put("meetingTitle", title.trim())
        })
    }
}
