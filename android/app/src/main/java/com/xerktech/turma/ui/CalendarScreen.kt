package com.xerktech.turma.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.withFrameNanos
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Constraints
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import com.xerktech.turma.core.calReminderText
import com.xerktech.turma.core.calSlotDp
import com.xerktech.turma.core.calZoomClamp
import com.xerktech.turma.core.calZoomStep
import kotlin.math.roundToInt
import androidx.compose.foundation.gestures.awaitFirstDown
import com.xerktech.turma.core.calDefaultOrgs
import com.xerktech.turma.core.calDefaultStart
import com.xerktech.turma.core.calDraftOf
import com.xerktech.turma.core.calNewEventDraft
import com.xerktech.turma.core.calOrgsOf
import com.xerktech.turma.core.calSlotStart
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.ClosedCaption
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.xerktech.turma.core.CAL_DAILY_EVENT_MS
import com.xerktech.turma.core.CAL_OPEN_AT_H
import com.xerktech.turma.core.CAL_WORK_FROM_H
import com.xerktech.turma.core.CAL_WORK_UNTIL_H
import com.xerktech.turma.core.CalMode
import com.xerktech.turma.core.CalRange
import com.xerktech.turma.core.CalSeg
import com.xerktech.turma.core.CalTarget
import com.xerktech.turma.core.NotesTarget
import com.xerktech.turma.core.TriageEntry
import com.xerktech.turma.core.bareKey
import com.xerktech.turma.core.calAria
import com.xerktech.turma.core.calAttendeeResponse
import com.xerktech.turma.core.calBadge
import com.xerktech.turma.core.calBandEvents
import com.xerktech.turma.core.calCapturesOf
import com.xerktech.turma.core.calCollect
import com.xerktech.turma.core.calDay
import com.xerktech.turma.core.calDayKey
import com.xerktech.turma.core.calDaySegments
import com.xerktech.turma.core.calEventOrg
import com.xerktech.turma.core.calInBand
import com.xerktech.turma.core.calLinkCandidates
import com.xerktech.turma.core.calLongDay
import com.xerktech.turma.core.calMeetingOf
import com.xerktech.turma.core.calMovedFrom
import com.xerktech.turma.core.calMyResponse
import com.xerktech.turma.core.calNoticeText
import com.xerktech.turma.core.calNotesTarget
import com.xerktech.turma.core.calOffOrgs
import com.xerktech.turma.core.calPanelSpec
import com.xerktech.turma.core.calRangeLabel
import com.xerktech.turma.core.calRevealFind
import com.xerktech.turma.core.calSafeHttps
import com.xerktech.turma.core.calSpan
import com.xerktech.turma.core.calStep
import com.xerktech.turma.core.calSwipeNeighbours
import com.xerktech.turma.core.calSwipeStep
import com.xerktech.turma.core.calStyle
import com.xerktech.turma.core.calTime
import com.xerktech.turma.core.calTitle
import com.xerktech.turma.core.calVisibleDays
import com.xerktech.turma.core.calWallMinutes
import com.xerktech.turma.core.calWeekStart
import com.xerktech.turma.core.calWeekdayLabel
import com.xerktech.turma.core.calWhenText
import com.xerktech.turma.core.meetingTitle
import com.xerktech.turma.core.safeMeetingUrl
import com.xerktech.turma.model.CalendarEvent
import com.xerktech.turma.net.FleetState
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BriefViewModel
import com.xerktech.turma.vm.CalendarViewModel
import com.xerktech.turma.vm.MeetingsViewModel
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * The Meetings tab's Calendar view (XERK-2900, the web's calendar.js of
 * XERK-2897/2898/2899): a Teams-mobile-style week of every org's
 * Outlook events, Tenir's impromptu captures and holidays — and the Turma-made
 * events (XERK-2972): ＋ or a tap on an empty slot opens the editor
 * (CalendarEventEditor.kt), and an editable one's detail offers Edit / Delete. A phone shows Day or
 * 3 days under a week day strip, ‹ › and a finger-following swipe moving it (a day at a
 * time on a phone, XERK-2980); a wide screen
 * (tablet / unfolded foldable) the Work week or full Week. A tap opens the
 * event's detail — Outlook's details and a linked capture reviewed in place with
 * the notes review's own controls (MeetingPart), never a fork. Every served
 * string is plain Text; a link opens only an http(s) (join: https) URL.
 * Logic: core/Calendar.kt; data: vm/CalendarViewModel.kt.
 */

private val SHORT_DP = 34.dp          // shorter than this, a block shows its title alone

/** The neutral colour of an unassigned event (the web's `--muted`). */
@Composable
private fun neutral(): Color = MaterialTheme.colorScheme.onSurfaceVariant

/**
 * The Calendar view. [reveal] is a notes-review "Open in calendar" to honour
 * (consumed through [onRevealed]); [onOpenNotes] answers "Open in notes review";
 * [dailyFor] finds an org's daily entry for a daily-meeting event's brief.
 */
/**
 * Tablets and foldables get the week. The app's [wide] (Expanded, ≥840dp) is not
 * enough on its own: a portrait tablet (~800dp) or an unfolded foldable (~670dp)
 * is Medium, and a Day view there wastes the screen. So the calendar measures
 * itself: the week modes from [CAL_WEEK_MIN_WIDTH] (the web's 760px narrow
 * line, in dp for a phone held sideways too), the detail beside the grid only
 * where both fit ([CAL_SIDE_MIN_WIDTH]); below that the detail is full screen.
 */
internal val CAL_WEEK_MIN_WIDTH = 600.dp
internal val CAL_SIDE_MIN_WIDTH = 840.dp

@Composable
internal fun CalendarView(
    modifier: Modifier,
    wide: Boolean,
    fleet: FleetState,
    scoped: Set<String>,
    names: Map<String, String>,
    colors: Map<String, Int>,
    cvm: CalendarViewModel,
    bvm: BriefViewModel,
    mvm: MeetingsViewModel,
    reveal: CalTarget?,
    onRevealed: () -> Unit,
    onOpenNotes: (NotesTarget) -> Unit,
    dailyFor: (String, Long) -> TriageEntry?,
) {
    BoxWithConstraints(modifier) {
        CalendarBody(
            Modifier.fillMaxSize(), weekly = wide || maxWidth >= CAL_WEEK_MIN_WIDTH,
            side = wide || maxWidth >= CAL_SIDE_MIN_WIDTH,
            fleet, scoped, names, colors, cvm, bvm, mvm, reveal, onRevealed, onOpenNotes, dailyFor,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalendarBody(
    modifier: Modifier,
    weekly: Boolean,
    side: Boolean,
    fleet: FleetState,
    scoped: Set<String>,
    names: Map<String, String>,
    colors: Map<String, Int>,
    cvm: CalendarViewModel,
    bvm: BriefViewModel,
    mvm: MeetingsViewModel,
    reveal: CalTarget?,
    onRevealed: () -> Unit,
    onOpenNotes: (NotesTarget) -> Unit,
    dailyFor: (String, Long) -> TriageEntry?,
) {
    val zone = ZoneId.systemDefault()
    val locale = Locale.getDefault()
    val weeks by cvm.weeks.collectAsStateWithLifecycle()
    val modes by cvm.modes.collectAsStateWithLifecycle()
    val zoom by cvm.zoom.collectAsStateWithLifecycle()
    var now by remember { mutableStateOf(cvm.now()) }
    // The now-line and "past" dimming move with the clock.
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = cvm.now() } }
    LaunchedEffect(fleet) { now = cvm.now() }
    DisposableEffect(Unit) {
        cvm.setActive(true)
        onDispose { cvm.setActive(false) }
    }

    var anchorDay by rememberSaveable { mutableStateOf(cvm.today().toEpochDay()) }
    val anchor = LocalDate.ofEpochDay(anchorDay)
    // A weekend meeting revealed into Work week shows Week until a mode pick (web XERK-2899 QA).
    var revealWeek by rememberSaveable { mutableStateOf(false) }
    val picked = modes[weekly] ?: CalMode.of(null, weekly)
    val mode = if (weekly && revealWeek) CalMode.WEEK else picked
    val days = calVisibleDays(anchor, mode)
    val keys = remember(scoped) { scoped.sorted() }
    LaunchedEffect(days, keys) { cvm.show(days, keys) }
    val range = calCollect(days, zone) { weeks[cvm.weekKey(it, keys)] }
    // The days a swipe slides in, drawn off-screen either side (XERK-2980); they are in the
    // fetched weeks already (`calWantedWeeks`), so the grid reads them from the same cache.
    val (before, after) = calSwipeNeighbours(anchor, mode)
    val stripRange = calCollect(before + days + after, zone) { weeks[cvm.weekKey(it, keys)] }

    var detailKey by rememberSaveable { mutableStateOf("") }
    var detailLast by remember { mutableStateOf<CalendarEvent?>(null) }
    var scrollTo by remember { mutableStateOf(-1.0) }
    // The minute at the grid's top, held HERE (rollup XERK-2953): on a phone the detail and the
    // editor replace the grid, so a scroll remembered inside it came back at 8 AM on every close.
    // A minute, not pixels: the zoom or the pane can differ when the grid comes back. Negative
    // until the operator first sees the grid (it then opens at 8 AM). Saveable: a rotation too.
    var topMin by rememberSaveable { mutableStateOf(-1.0) }
    var picker by rememberSaveable { mutableStateOf(false) }
    var hostSetOpen by rememberSaveable { mutableStateOf(false) }
    // The Turma-event editor (XERK-2972), full screen while open; its state is the view model's.
    val editor by cvm.editor.collectAsStateWithLifecycle()
    val orgOptions = remember(names) {
        names.keys.sorted().map { it to com.xerktech.turma.core.orgName(it, names[it].orEmpty()) }
    }
    fun newEvent(day: LocalDate, start: java.time.LocalTime) {
        cvm.openEditor(calNewEventDraft(day, start, zone, calDefaultOrgs(keys, names.keys)))
    }

    fun go(d: LocalDate) { anchorDay = d.toEpochDay() }
    fun openDetail(ev: CalendarEvent) {
        if (ev.key != detailKey) cvm.clearLinkErrors()
        detailKey = ev.key
        detailLast = ev
    }
    fun closeDetail() { detailKey = ""; detailLast = null }

    // "Open in calendar" (XERK-2899): move to the week, then open the event once it is read.
    LaunchedEffect(reveal) {
        val t = reveal ?: return@LaunchedEffect
        val d = calDay(t.startMs, zone)
        go(d)
        revealWeek = weekly && picked == CalMode.WORK && d.dayOfWeek.value >= DayOfWeek.SATURDAY.value
        closeDetail()
    }
    // Judged only once the grid shows the target's day: the range of the week
    // being left must never answer "not there" for it.
    if (reveal != null && calDay(reveal.startMs, zone) in days) {
        val hit = calRevealFind(range.events, reveal)
        LaunchedEffect(hit?.key, range.have, range.loading) {
            if (hit != null) {
                openDetail(hit)
                if (!calInBand(hit)) scrollTo = calWallMinutes(hit.startMs ?: 0, calDay(hit.startMs ?: 0, zone), zone)
                onRevealed()
            } else if (range.have && !range.loading) onRevealed()   // read, and not there: stay on its week
        }
    }

    // The open event as the newest read has it; a Tenir entry a (re)link merged
    // into an event follows it there.
    val detail: CalendarEvent? = if (detailKey.isEmpty()) null else {
        range.events.firstOrNull { it.key == detailKey }
            ?: detailLast?.takeIf { it.tenir && range.have }?.let { last ->
                range.events.firstOrNull { e ->
                    !e.tenir && calCapturesOf(e).any { it.site == last.site && it.meetingId == last.meetingId }
                }
            }
            ?: detailLast
    }
    if (detail != null && detail.key != detailKey) LaunchedEffect(detail.key) { detailKey = detail.key; detailLast = detail }
    else if (detail != null && detail !== detailLast) LaunchedEffect(detail) { detailLast = detail }

    BackHandler(enabled = detail != null && editor == null) { closeDetail() }

    if (picker) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = anchor.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { picker = false },
            confirmButton = {
                TextButton({
                    state.selectedDateMillis?.let { go(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    picker = false
                }) { Text("Go") }
            },
            dismissButton = { TextButton({ picker = false }) { Text("Cancel") } },
        ) { DatePicker(state, Modifier.testTag("cal-date-picker")) }
    }

    val grid: @Composable (Modifier) -> Unit = { m ->
        BoxWithConstraints(m) {
        // A short, wide pane (a phone in landscape) has room for an hour or two of grid, and a
        // FAB there covers a column's corner at every scroll (rollup XERK-2953): New event moves
        // into the toolbar instead.
        val fabless = maxHeight < maxWidth && maxHeight < CAL_FAB_MIN_HEIGHT
        val newHere = { newEvent(anchor, calDefaultStart(anchor, cvm.now(), zone)) }
        Column(Modifier.fillMaxSize()) {
            CalToolbar(
                weekly, mode, days, anchor, cvm.today(), locale,
                onToday = { revealWeek = false; go(cvm.today()) },
                onStep = { dir -> go(calStep(anchor, mode, dir)) },
                onPicker = { picker = true },
                onMode = { revealWeek = false; cvm.setMode(weekly, it) },
                onDay = { go(it) },
                settingsOpen = hostSetOpen,
                onSettings = { hostSetOpen = !hostSetOpen },
                onNew = newHere.takeIf { fabless },
            )
            if (hostSetOpen) HostSettings(range.hostRows, names, cvm)
            CalNotices(range, now, zone, locale)
            WeekGrid(
                Modifier.weight(1f), weekly, days, before, after, stripRange, now, zone, locale, fleet, keys, names, colors,
                detailKey = detail?.key, scrollTo = scrollTo, onScrolled = { scrollTo = -1.0 },
                topMin = topMin, onTopMin = { topMin = it },
                zoomHours = zoom, onZoom = { h, end -> cvm.setZoom(h, save = end) },
                onOpen = ::openDetail,
                onSwipe = { dir -> go(calSwipeStep(anchor, mode, dir)) },
                onSlot = { d, min -> newEvent(d, calSlotStart(min)) },
            )
        }
            if (!fabless) FloatingActionButton(
                newHere, Modifier.align(Alignment.BottomEnd).padding(16.dp).testTag("cal-new-event"),
            ) { Icon(Icons.Filled.Add, "New event") }
        }
    }
    val panel: @Composable (Modifier, CalendarEvent) -> Unit = { m, ev ->
        key(ev.key) {
            val series = TurmaColors.series()
            CalendarDetail(
                m, ev, colors[ev.org]?.let { series[it % series.size] },
                side, now, zone, locale, fleet, names, range.events, cvm, bvm, mvm,
                onClose = ::closeDetail, onOpenNotes = onOpenNotes, dailyFor = dailyFor,
                onEdit = { e, scope -> cvm.openEditor(com.xerktech.turma.core.calDraftFor(e, zone, scope)) },
            )
        }
    }
    val draft = editor
    when {
        draft != null -> CalendarEventEditor(modifier.fillMaxSize(), draft, orgOptions, cvm)
        detail == null -> grid(modifier.fillMaxSize())
        side -> Row(modifier.fillMaxSize()) {
            grid(Modifier.weight(1f).fillMaxHeight())
            VerticalDivider()
            panel(Modifier.width(400.dp).fillMaxHeight(), detail)
        }
        else -> panel(modifier.fillMaxSize(), detail)
    }
}

private val CAL_FAB_MIN_HEIGHT = 480.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CalToolbar(
    wide: Boolean,
    mode: CalMode,
    days: List<LocalDate>,
    anchor: LocalDate,
    today: LocalDate,
    locale: Locale,
    onToday: () -> Unit,
    onStep: (Int) -> Unit,
    onPicker: () -> Unit,
    onMode: (CalMode) -> Unit,
    onDay: (LocalDate) -> Unit,
    settingsOpen: Boolean,
    onSettings: () -> Unit,
    onNew: (() -> Unit)? = null,
) {
    // The per-host calendar settings toggle (XERK-2929, the web's ⚙), after New event when the
    // pane is too short for the FAB.
    val gear: @Composable () -> Unit = {
        if (onNew != null) IconButton(onNew, Modifier.testTag("cal-new-event")) { Icon(Icons.Filled.Add, "New event") }
        IconButton(onSettings, Modifier.testTag("cal-settings").semantics { selected = settingsOpen }) {
            Icon(Icons.Outlined.Settings, "Calendar settings")
        }
    }
    val unit = if (mode.weekly) "week" else if (mode == CalMode.THREE) "3 days" else "day"
    val modes = CalMode.entries.filter { it.wide == wide }
    // The web's `tri-chip` mode pick.
    val modeRow: @Composable () -> Unit = {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (m in modes) {
                FilterChip(
                    selected = m == mode, onClick = { onMode(m) },
                    label = { Text(m.label, maxLines = 1, fontSize = 13.sp) },
                    modifier = Modifier.testTag("cal-mode-${m.name}"),
                )
            }
        }
    }
    // The range label opens the date picker: months (and years) forward and back.
    val label: @Composable (String, Modifier) -> Unit = { text, m ->
        Text(
            "$text ▾",
            m.clip(RoundedCornerShape(8.dp)).clickable(onClickLabel = "Pick a date", onClick = onPicker)
                .padding(horizontal = 6.dp, vertical = 6.dp).testTag("cal-range"),
            style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
    if (wide) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            GhostButton("Today", onToday, Modifier.testTag("cal-today"))
            IconButton({ onStep(-1) }, Modifier.testTag("cal-prev")) { Icon(Icons.Filled.ChevronLeft, "Previous $unit") }
            IconButton({ onStep(1) }, Modifier.testTag("cal-next")) { Icon(Icons.Filled.ChevronRight, "Next $unit") }
            label(calRangeLabel(days, locale), Modifier.weight(1f, fill = false))
            Spacer(Modifier.weight(1f))
            modeRow()
            gear()
        }
        return
    }
    // A phone: month + Today + Day / 3 days, then the week's day strip (Teams mobile).
    Row(
        Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        label(DateTimeFormatter.ofPattern("MMMM yyyy", locale).format(anchor), Modifier.weight(1f))
        GhostButton("Today", onToday, Modifier.testTag("cal-today"))
        modeRow()
        gear()
    }
    val shown = days.toSet()
    Row(Modifier.fillMaxWidth().padding(horizontal = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton({ onStep(-1) }, Modifier.size(36.dp).testTag("cal-prev")) { Icon(Icons.Filled.ChevronLeft, "Previous $unit") }
        val ws = calWeekStart(anchor)
        for (i in 0 until 7) {
            val d = ws.plusDays(i.toLong())
            val on = d in shown
            val isToday = d == today
            Column(
                Modifier.weight(1f).clip(RoundedCornerShape(10.dp))
                    .background(if (on) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f) else Color.Transparent)
                    .clickable { onDay(d) }.padding(vertical = 4.dp)
                    .semantics {
                        contentDescription = calLongDay(d, locale) + if (isToday) ", today" else ""
                        selected = on
                    }
                    .testTag("cal-strip-${calDayKey(d)}"),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    d.dayOfWeek.getDisplayName(java.time.format.TextStyle.NARROW, locale),
                    fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "${d.dayOfMonth}",
                    Modifier.then(if (isToday) Modifier.background(MaterialTheme.colorScheme.primary, CircleShape) else Modifier)
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                    fontWeight = FontWeight.SemiBold,
                    color = if (isToday) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        IconButton({ onStep(1) }, Modifier.size(36.dp).testTag("cal-next")) { Icon(Icons.Filled.ChevronRight, "Next $unit") }
    }
}

/** The read's own error, stale-host notices, truncation and the first load. */
@Composable
private fun CalNotices(range: CalRange, now: Long, zone: ZoneId, locale: Locale) {
    val notes = buildList {
        if (range.err.isNotEmpty()) add(range.err to TurmaColors.critical)
        for (n in range.notices) {
            add(calNoticeText(n, now, zone, locale) to if (n.syncing && !n.offline && n.error.isEmpty()) null else TurmaColors.warning)
        }
        if (range.truncated) add("This range holds more events than the hub serves at once; some are not shown." to TurmaColors.warning)
        if (!range.have && range.loading) add("Loading the calendar…" to null)
    }
    if (notes.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for ((text, tone) in notes) {
            Text(
                text,
                Modifier.fillMaxWidth()
                    .background((tone ?: MaterialTheme.colorScheme.primary).copy(alpha = 0.10f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 10.dp, vertical = 6.dp).testTag("cal-note"),
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/** Diagonal stripes over the box, the web's hatched tentative event / day off. */
private fun Modifier.hatch(color: Color): Modifier = this.clipToBounds().drawBehind {
    val step = 7.dp.toPx()
    var x = -size.height
    while (x < size.width) {
        drawLine(color, Offset(x, size.height), Offset(x + size.height, 0f), strokeWidth = 1.5.dp.toPx())
        x += step
    }
}

@Composable
private fun WeekGrid(
    modifier: Modifier,
    wide: Boolean,
    days: List<LocalDate>,
    before: List<LocalDate>,
    after: List<LocalDate>,
    range: CalRange,
    now: Long,
    zone: ZoneId,
    locale: Locale,
    fleet: FleetState,
    keys: List<String>,
    names: Map<String, String>,
    colors: Map<String, Int>,
    detailKey: String?,
    scrollTo: Double,
    onScrolled: () -> Unit,
    topMin: Double,
    onTopMin: (Double) -> Unit,
    zoomHours: Float,
    onZoom: (hours: Float, end: Boolean) -> Unit,
    onOpen: (CalendarEvent) -> Unit,
    onSwipe: (Int) -> Unit,
    onSlot: (LocalDate, Int) -> Unit,
) {
    val today = calDay(now, zone)
    val gutter = if (wide) 56.dp else 44.dp
    val outline = MaterialTheme.colorScheme.outlineVariant
    val offShade = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)
    val density = LocalDensity.current
    val scroll = rememberScrollState()
    val series = TurmaColors.series()
    val colorOf: (String) -> Color? = { org -> colors[org]?.let { series[it % series.size] } }
    val orgLabel: (String) -> String = { s -> if (s.isEmpty()) "No org" else com.xerktech.turma.core.orgName(s, names[s].orEmpty()) }
    // A Turma event of several orgs is ONE block naming every org (XERK-2972).
    val orgsLabel: (CalendarEvent) -> String = { ev -> calOrgsOf(ev).ifEmpty { listOf("") }.joinToString(", ") { orgLabel(it) } }
    // The grid draws [strip]: the shown days plus, off-screen, the ones a swipe slides in
    // (XERK-2980). Those are hidden from TalkBack and carry no test tags.
    val strip = before + days + after
    val shownDays = days.toSet()
    fun Modifier.shown(d: LocalDate, tag: String? = null): Modifier =
        if (d !in shownDays) clearAndSetSemantics {} else if (tag != null) testTag(tag) else this
    val offOf = strip.associateWith { calOffOrgs(it, range.holidays, keys.toSet()) }
    // How far the days are dragged, in px, and the strip it was dragged on (its first day AND its
    // length, so a mode pick that keeps the first day is a new strip too). Read only when placing
    // them, so a drag relayouts the strip and never recomposes the grid. Keyed so a settle can leave
    // it at its end: the new days, a frame later, ignore it. Zeroing it in the settle instead placed
    // the OLD days unshifted for a frame (a flash, QA).
    var shift by remember { mutableStateOf(0L to 0f) }
    val stripKey = days.first().toEpochDay() * 8 + days.size
    val stripFirst by rememberUpdatedState(stripKey)
    fun shiftNow(): Float = shift.let { (d, px) -> if (d == stripFirst) px else 0f }
    // Once the new days are on screen, forget the old strip's offset: ‹ back to that day later
    // must not find it again.
    LaunchedEffect(stripKey) { if (shift.first != stripKey) shift = stripKey to 0f }
    var gridW by remember { mutableIntStateOf(0) }
    val colPx = (gridW - with(density) { gutter.toPx() }).coerceAtLeast(0f) / days.size
    val reach by rememberUpdatedState(before.size * colPx to after.size * colPx)
    val swipeTo by rememberUpdatedState(onSwipe)
    val scope = rememberCoroutineScope()
    var settling by remember { mutableStateOf<Job?>(null) }
    // The step a running settle will take once it lands; a new touch lands it at once.
    var landing by remember { mutableStateOf<(() -> Unit)?>(null) }
    val flingPx = with(density) { 400.dp.toPx() }
    // Released: on to the next / previous days past a third of the step or on a fling, else back.
    // [step] false (a pinch took over) always goes back.
    fun settle(vx: Float, step: Boolean = true) {
        val (back, on) = reach
        val from = shiftNow()
        val dir = when {
            !step -> 0
            kotlin.math.abs(vx) > flingPx -> if (vx < 0) 1 else -1
            from < 0 && -from > on / 3 -> 1
            from > 0 && from > back / 3 -> -1
            else -> 0
        }
        val target = when (dir) { 1 -> -on; -1 -> back; else -> 0f }
        val day = stripFirst
        // Steps only if the strip is still the one dragged: ‹ › or a mode pick mid-settle wins.
        val land = {
            landing = null
            if (stripFirst == day) { if (dir != 0) swipeTo(dir); shift = day to target }
        }
        landing = land
        settling = scope.launch {
            animate(from, target, animationSpec = tween(220, easing = FastOutSlowInEasing)) { v, _ -> if (stripFirst == day) shift = day to v }
            land()
        }
    }
        Column(
        modifier.fillMaxWidth().semantics { contentDescription = "Calendar, ${calRangeLabel(days, locale)}" }
            .onSizeChanged { gridW = it.width }
            // The days follow a horizontal drag (XERK-2980); a drag never also opens the event
            // under it, and a pinch zooms, never swipes.
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    // A touch mid-settle lands it now, so a quick second swipe moves on from the
                    // landed days. A tap then is swallowed: Compose picked its target at the down,
                    // on the days still moving, so letting it through opened the wrong day (QA).
                    val interrupted = settling?.isActive == true
                    if (interrupted) { settling?.cancel(); landing?.invoke() }
                    val velocity = VelocityTracker().apply { addPosition(down.uptimeMillis, down.position) }
                    val slop = viewConfiguration.touchSlop
                    var dragging = false
                    while (true) {
                        val ev = awaitPointerEvent(PointerEventPass.Initial)
                        val c = ev.changes.firstOrNull { it.id == down.id }
                        if (c == null || ev.changes.count { it.pressed } > 1) {
                            if (dragging) settle(0f, step = false)   // a pinch zooms, never swipes
                            break
                        }
                        velocity.addPosition(c.uptimeMillis, c.position)
                        val dx = c.position.x - down.position.x
                        val dy = c.position.y - down.position.y
                        if (!dragging) {
                            if (kotlin.math.abs(dx) > slop && kotlin.math.abs(dx) > 2 * kotlin.math.abs(dy)) dragging = true
                            else if (kotlin.math.abs(dy) > slop) break   // a vertical scroll's
                        }
                        if (dragging) {
                            c.consume()
                            val (back, on) = reach
                            shift = stripFirst to dx.coerceIn(-on, back)
                        }
                        if (!c.pressed) {
                            if (dragging) settle(velocity.calculateVelocity().x)
                            else if (interrupted) c.consume()   // a consumed up cancels the tap
                            break
                        }
                    }
                }
            },
    ) {
        // Day headers: date + weekday; today in the accent with a top bar; a day off says so.
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.width(gutter))
            DayStrip(Modifier.weight(1f), strip, before.size, days.size, { shiftNow() }) { d ->
                val isToday = d == today
                val off = offOf[d].orEmpty()
                Column(
                    Modifier.shown(d, "cal-dh-${calDayKey(d)}")
                        .padding(horizontal = 2.dp)
                        .semantics(mergeDescendants = true) {},
                ) {
                    Box(
                        Modifier.fillMaxWidth().height(3.dp)
                            .background(if (isToday) MaterialTheme.colorScheme.primary else Color.Transparent),
                    )
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            "${d.dayOfMonth}", fontSize = 20.sp, fontWeight = FontWeight.SemiBold,
                            color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            calWeekdayLabel(d, short = !wide && days.size > 1, locale = locale),
                            Modifier.padding(bottom = 3.dp), fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (off.isNotEmpty()) {
                        Text(
                            "Day off" + if (keys.size == 1) "" else " · " + off.joinToString(", ") { orgLabel(it) },
                            fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
        // The all-day band: holidays, then all-day / ≥24h events, one chip per day.
        Row(Modifier.fillMaxWidth().heightIn(min = 22.dp).border(0.5.dp, outline)) {
            Text(
                "All day", Modifier.width(gutter).padding(4.dp), fontSize = 10.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            DayStrip(Modifier.weight(1f), strip, before.size, days.size, { shiftNow() }) { d ->
                Column(
                    Modifier.shown(d).then(if (offOf[d].orEmpty().isNotEmpty()) Modifier.hatch(offShade) else Modifier)
                        .padding(1.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    for (h in range.holidays.filter { it.date == calDayKey(d) }) {
                        Text(
                            h.name, Modifier.fillMaxWidth()
                                .background(TurmaColors.good.copy(alpha = 0.16f), RoundedCornerShape(4.dp))
                                .padding(horizontal = 4.dp, vertical = 1.dp).testTag("cal-hol"),
                            fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    for (ev in calBandEvents(range.events, d, zone)) {
                        val badge = calBadge(ev, fleet.meetingProposals)
                        EventBlock(
                            Modifier.fillMaxWidth().height(22.dp), ev, now, colorOf(ev.org), badge, short = true,
                            open = ev.key == detailKey,
                            aria = calAria(ev, d, orgsLabel(ev), badge, zone, locale),
                        ) { onOpen(ev) }
                    }
                }
            }
        }
        // The timed grid: 30-minute rows, working hours unshaded, a red now-line on today.
        // The zoom (XERK-2954) is how many hours fill the pane: a pinch, or TalkBack's actions.
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val paneDp = maxHeight.value
            val slot = calSlotDp(paneDp, zoomHours).dp
            val hourDp = slot * 2
            // The grid opens with 8 AM at the top (its label clear); a reveal scrolls to its event.
            // Back from a detail or the editor (or a rotation) it reopens where the operator left it.
            val slotPxNow by rememberUpdatedState(with(density) { slot.toPx() })
            LaunchedEffect(Unit) {
                scroll.scrollTo(
                    if (topMin >= 0) (slotPxNow * topMin / 30).roundToInt()
                    else with(density) { (hourDp * CAL_OPEN_AT_H - 8.dp).roundToPx() },
                )
                androidx.compose.runtime.snapshotFlow { scroll.value / slotPxNow * 30.0 }.collect { onTopMin(it) }
            }
            LaunchedEffect(scrollTo) {
                if (scrollTo >= 0) {
                    scroll.animateScrollTo(with(density) { ((slot * (scrollTo / 30).toFloat()) - hourDp).roundToPx().coerceAtLeast(0) })
                    onScrolled()
                }
            }
            // A zoom holds the minute under the fingers (or the pane's middle) in place; any
            // other row-height change (the pane resized by a notice, a rotation) holds the
            // minute at the top. The scroll moves once the new rows are laid out.
            // Never-equal: each zoom step's hold is its own write, so the identity check below
            // tells a newer step's hold (often an EQUAL pair, the minute kept) from its own.
            var hold by remember { mutableStateOf<Pair<Double, Float>?>(null, androidx.compose.runtime.neverEqualPolicy()) }
            var lastSlotPx by remember { mutableStateOf(0f) }
            LaunchedEffect(slot) {
                val was = lastSlotPx
                lastSlotPx = with(density) { slot.toPx() }
                val held = hold
                val (min, y) = held ?: (if (was > 0f) scroll.value / was * 30.0 to 0f else return@LaunchedEffect)
                withFrameNanos { }
                // A raw delta, never scrollTo: that takes the scroll's lock and cancels a fling in
                // flight. A swipe landing at a vertical flick's down changes the band (so the pane)
                // under it, and this hold then killed the flick (QA, emulator).
                val to = with(density) { (slot.toPx() * min / 30 - y).roundToInt().coerceAtLeast(0) }
                scroll.dispatchRawDelta((to - scroll.value).toFloat())
                // Only the hold this pass applied: the next pinch move can land before this
                // frame (one per frame on a 120 Hz panel) and set the next step's hold, which
                // clearing it here dropped to the top-hold fallback (rollup XERK-2953, measured).
                if (hold === held) hold = null
            }
            val hours by rememberUpdatedState(zoomHours)
            fun zoomTo(h: Float, y: Float, end: Boolean) {
                val next = calZoomClamp(h)
                if (next != hours) {
                    // A hold not yet applied keeps its minute: the scroll still stands for the
                    // rows before it, so reading the minute off it now would drift the anchor
                    // (two pinch moves inside one frame, rollup XERK-2953).
                    val pending = hold?.first
                    val slotPx = with(density) { calSlotDp(paneDp, hours).dp.toPx() }
                    hold = (pending ?: ((scroll.value + y) / slotPx * 30.0)) to y
                }
                onZoom(next, end)
            }
            val midPx = constraints.maxHeight / 2f
            Box(
                Modifier.fillMaxSize()
                    .pointerInput(paneDp) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                            var pinched = false
                            while (true) {
                                val ev = awaitPointerEvent(PointerEventPass.Initial)
                                if (ev.changes.none { it.pressed }) break
                                if (ev.changes.count { it.pressed } < 2) continue
                                val z = ev.calculateZoom()
                                if (z != 1f && z > 0f) {
                                    pinched = true
                                    zoomTo(hours / z, ev.calculateCentroid(useCurrent = true).y, end = false)
                                }
                                ev.changes.forEach { it.consume() }  // the scroll never pans mid-pinch
                            }
                            if (pinched) onZoom(hours, true)
                        }
                    }
                    .semantics {
                        customActions = listOfNotNull(
                            calZoomStep(zoomHours, 1)?.let { h -> CustomAccessibilityAction("Zoom in") { zoomTo(h, midPx, true); true } },
                            calZoomStep(zoomHours, -1)?.let { h -> CustomAccessibilityAction("Zoom out") { zoomTo(h, midPx, true); true } },
                        )
                    }
                    .verticalScroll(scroll).testTag("cal-scroll"),
            ) {
                // Room below midnight for the New event FAB (16dp margin + 56dp + 16dp): the last
                // hours scroll clear of it, so a late block's corner is never under it (XERK-2953).
                Row(Modifier.fillMaxWidth().padding(bottom = 88.dp).height(hourDp * 24)) {
                    Box(Modifier.width(gutter).fillMaxHeight()) {
                        for (h in 1 until 24) {
                            Text(
                                DateTimeFormatter.ofPattern("h a", locale).format(java.time.LocalTime.of(h, 0)),
                                Modifier.offset(y = hourDp * h - 7.dp).padding(start = 4.dp),
                                fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    DayStrip(Modifier.weight(1f).fillMaxHeight(), strip, before.size, days.size, { shiftNow() }) { d ->
                        val isToday = d == today
                        val off = offOf[d].orEmpty().isNotEmpty()
                        val surface = MaterialTheme.colorScheme.surface
                        BoxWithConstraints(
                            Modifier.fillMaxHeight()
                                .drawBehind {
                                    drawRect(offShade)
                                    val hp = hourDp.toPx()
                                    drawRect(surface, Offset(0f, hp * CAL_WORK_FROM_H),
                                        androidx.compose.ui.geometry.Size(size.width, hp * (CAL_WORK_UNTIL_H - CAL_WORK_FROM_H)))
                                    for (h in 0 until 24) drawLine(outline, Offset(0f, hp * h), Offset(size.width, hp * h), 0.5.dp.toPx())
                                    drawLine(outline, Offset(0f, 0f), Offset(0f, size.height), 0.5.dp.toPx())
                                }
                                .then(if (off) Modifier.hatch(offShade) else Modifier)
                                // A tap on an empty slot starts a new event there (XERK-2972); a block's
                                // own click consumes its tap first, so this hears only the gaps. Only a
                                // TAP: a touch that moved past the slop (a short swipe under the day
                                // step) or was held past the long-press timeout opens nothing, as the
                                // web drops a moved touch (rollup XERK-2953).
                                .pointerInput(d, slot) {
                                    awaitEachGesture {
                                        val down = awaitFirstDown()
                                        val up = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                                            awaitSlotTap(down, viewConfiguration.touchSlop)
                                        }
                                        if (up != null) {
                                            up.consume()
                                            onSlot(d, (down.position.y / slot.toPx() * 30).toInt())
                                        }
                                    }
                                }
                                .shown(d, "cal-col-${calDayKey(d)}"),
                        ) {
                            val w = maxWidth
                            for (seg in calDaySegments(range.events, d, zone)) {
                                val ev = seg.ev
                                val badge = calBadge(ev, fleet.meetingProposals)
                                val h = slot * ((seg.bottom - seg.top) / 30).toFloat() - 2.dp
                                EventBlock(
                                    segModifier(seg, w, h, slot), ev, now, colorOf(ev.org), badge, short = h < SHORT_DP,
                                    open = ev.key == detailKey,
                                    aria = calAria(ev, d, orgsLabel(ev), badge, zone, locale),
                                    meta = listOf(calSpan(ev.startMs ?: 0, ev.endMs ?: 0, zone, locale), ev.location)
                                        .filter { it.isNotEmpty() }.joinToString(" · "),
                                ) { onOpen(ev) }
                            }
                            if (isToday) {
                                val y = slot * (calWallMinutes(now, d, zone) / 30).toFloat()
                                val red = TurmaColors.critical
                                Box(
                                    Modifier.fillMaxWidth().height(2.dp).offset(y = y - 1.dp)
                                        .drawBehind {
                                            drawRect(red)
                                            drawCircle(red, 4.dp.toPx(), Offset(0f, size.height / 2))
                                        }
                                        .testTag("cal-now").clearAndSetSemantics {},
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * One row of [strip]'s day cells, [shown] of them filling the width, the first [lead] to its left
 * and the rest to its right, all moved by [shift] px and clipped to the row (XERK-2980). Each
 * [cell] must emit one layout node; it is measured at its column's exact width.
 */
@Composable
private fun DayStrip(
    modifier: Modifier,
    strip: List<LocalDate>,
    lead: Int,
    shown: Int,
    shift: () -> Float,
    cell: @Composable (LocalDate) -> Unit,
) {
    Layout({ for (d in strip) key(d) { cell(d) } }, modifier.clipToBounds()) { ms, c ->
        val col = c.maxWidth.toFloat() / shown
        val cells = ms.mapIndexed { i, m ->
            val x0 = ((i - lead) * col).roundToInt()
            val w = ((i - lead + 1) * col).roundToInt() - x0
            x0 to m.measure(Constraints(w, w, c.minHeight, c.maxHeight))
        }
        // Only the shown days size the row: an off-screen day's all-day chips must not grow it.
        val h = (cells.subList(lead, lead + shown).maxOfOrNull { it.second.height } ?: 0)
            .coerceIn(c.minHeight, c.maxHeight)
        layout(c.maxWidth, h) {
            val dx = shift().roundToInt()
            for ((x, p) in cells) p.placeRelative(x + dx, 0)
        }
    }
}

private fun segModifier(seg: CalSeg, colWidth: Dp, height: Dp, slot: Dp): Modifier {
    val left = colWidth * (seg.col.toFloat() / seg.cols)
    val width = colWidth * (seg.span.toFloat() / seg.cols)
    return Modifier.offset(x = left + 1.dp, y = slot * (seg.top / 30).toFloat())
        .width((width - 4.dp).coerceAtLeast(8.dp)).height(height.coerceAtLeast(10.dp))
}

/**
 * One event, Teams-style: a 22% tint of its org colour with a 4dp solid left bar
 * (unassigned = neutral); tentative / not responded hatched; free / declined
 * outlined; canceled struck through; past dimmed; a Tenir-only capture marked by a
 * caption glyph; a capture's pending proposals (or a spinner while it is read) badged.
 */
@Composable
private fun EventBlock(
    modifier: Modifier,
    ev: CalendarEvent,
    now: Long,
    orgColor: Color?,
    badge: com.xerktech.turma.core.CalBadge,
    short: Boolean,
    open: Boolean,
    aria: String,
    meta: String = "",
    onClick: () -> Unit,
) {
    val st = calStyle(ev, now)
    val c = orgColor ?: neutral()
    val shape = RoundedCornerShape(4.dp)
    val fill = when {
        st.free -> Modifier.background(MaterialTheme.colorScheme.surface, shape).border(1.dp, c, shape)
        st.tentative -> Modifier.background(MaterialTheme.colorScheme.surface, shape).border(1.dp, c.copy(alpha = 0.6f), shape)
            .clip(shape).hatch(c.copy(alpha = 0.22f))
        else -> Modifier.background(c.copy(alpha = 0.22f), shape)
    }
    Row(
        modifier.alpha(if (st.past) 0.6f else 1f).clip(shape).then(fill)
            .then(if (open) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, shape) else Modifier)
            .clickable(onClick = onClick)
            .testTag("cal-ev")
            .clearAndSetSemantics { contentDescription = aria; role = Role.Button },
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(c))
        // A short block centres one line with no vertical padding, so a 15-minute meeting's title is whole.
        Column(
            Modifier.weight(1f).fillMaxHeight().padding(horizontal = 4.dp, vertical = if (short) 0.dp else 2.dp),
            verticalArrangement = if (short) Arrangement.Center else Arrangement.Top,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (st.tenir) {
                    Icon(Icons.Outlined.ClosedCaption, null, Modifier.size(12.dp).padding(end = 2.dp))
                }
                // A repeating event wears the recurring glyph, an Outlook occurrence and a Turma series alike (XERK-2973).
                if (ev.recurring) {
                    Icon(Icons.Outlined.Repeat, null, Modifier.size(11.dp).padding(end = 1.dp).testTag("cal-recur"))
                }
                Text(
                    calTitle(ev), Modifier.weight(1f, fill = false), fontSize = if (short) 11.sp else 12.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = if (short) 1 else 2, overflow = TextOverflow.Ellipsis,
                    lineHeight = if (short) 12.sp else 14.sp,
                    textDecoration = if (st.canceled) TextDecoration.LineThrough else null,
                )
                Spacer(Modifier.weight(0.001f))
                // Several orgs share this one block (XERK-2972): "+N" beside the title.
                val more = calOrgsOf(ev).size - 1
                if (more > 0) {
                    Text(
                        "+$more", Modifier.padding(start = 2.dp).testTag("cal-multi-org"), fontSize = 10.sp,
                        fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                // A Turma event's Outlook copy failed or is being written (XERK-2987).
                when (val m = com.xerktech.turma.core.calOutlookMark(ev)) {
                    "failed", "pending" -> Text(
                        if (m == "failed") "!" else "…", Modifier.padding(start = 2.dp).testTag("cal-olk-$m"),
                        fontSize = 11.sp, fontWeight = FontWeight.Bold,
                        color = if (m == "failed") TurmaColors.criticalText() else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                CalBadgeView(badge)
            }
            if (!short && meta.isNotEmpty()) {
                Text(meta, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, lineHeight = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun CalBadgeView(b: com.xerktech.turma.core.CalBadge) {
    when {
        b.pending > 0 -> Row(
            Modifier.background(MaterialTheme.colorScheme.primary, RoundedCornerShape(50)).padding(horizontal = 4.dp)
                .testTag("cal-badge"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.AutoMirrored.Filled.List, null, Modifier.size(10.dp), tint = MaterialTheme.colorScheme.onPrimary)
            Text("${b.pending}", fontSize = 10.sp, color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.SemiBold)
        }
        b.reading -> CircularProgressIndicator(Modifier.size(10.dp).testTag("cal-reading"), strokeWidth = 1.5.dp)
    }
}

/** The detail panel's background: exactly a session card's org tint ([orgCardColor], XERK-2939). */
internal fun calPanelTint(orgColor: Color?, surface: Color): Color = orgCardColor(orgColor, surface)

/** A text color on that panel: half [c], half [ink] in sRGB, the web's `color-mix(… 50%, var(--ink))`. */
internal fun calOnTint(c: Color, ink: Color): Color = c.copy(alpha = 0.5f).compositeOver(ink)

/**
 * The event's detail (XERK-2898): Outlook's details, Join, Open in notes review,
 * attendees and the description, then a linked capture's summary + proposals
 * reviewed in place by the notes review's own [MeetingPart], a daily meeting's
 * brief, and the relink controls. A phone shows it full screen (Back closes it);
 * a wide screen beside the grid.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CalendarDetail(
    modifier: Modifier,
    ev: CalendarEvent,
    orgColor: Color?,
    wide: Boolean,
    now: Long,
    zone: ZoneId,
    locale: Locale,
    fleet: FleetState,
    names: Map<String, String>,
    events: List<CalendarEvent>,
    cvm: CalendarViewModel,
    bvm: BriefViewModel,
    mvm: MeetingsViewModel,
    onClose: () -> Unit,
    onOpenNotes: (NotesTarget) -> Unit,
    dailyFor: (String, Long) -> TriageEntry?,
    // The event, and for an occurrence of a series the events it is for (XERK-2973; "" = a plain event).
    onEdit: (CalendarEvent, String) -> Unit,
) {
    val uri = LocalUriHandler.current
    val eventBusy by cvm.eventBusy.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf(false) }
    var askScope by remember { mutableStateOf("") }   // "edit" | "delete" for an occurrence of a series
    // The panel wears its event's org tint, as its grid block does (XERK-2939); no org = plain.
    // Its text colors are pulled toward ink so they stay ≥4.5:1 on every tint (web `.cal-detail`).
    val cs = MaterialTheme.colorScheme
    val tint = calPanelTint(orgColor, cs.surface)
    val onTint: (Color) -> Color = { calOnTint(it, cs.onSurface) }
    val muted = onTint(cs.onSurfaceVariant)
    val hostOrg: (String) -> String = { h -> fleet.agents.firstOrNull { it.key == h }?.org.orEmpty() }
    val orgLabel: (String) -> String = { s -> if (s.isEmpty()) "No org" else com.xerktech.turma.core.orgName(s, names[s].orEmpty()) }
    var descOpen by rememberSaveable { mutableStateOf(false) }
    var attOpen by rememberSaveable { mutableStateOf(false) }   // collapsed by default (XERK-2942)
    MaterialTheme(colorScheme = cs.copy(primary = onTint(cs.primary), onSurfaceVariant = muted)) {
    Column(modifier.fillMaxSize().background(tint).testTag("cal-detail")) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                calTitle(ev), Modifier.weight(1f).semantics { heading() },
                style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold,
            )
            IconButton(onClose, Modifier.testTag("cal-detail-close")) {
                Icon(Icons.Filled.Close, if (wide) "Close" else "Back to the calendar")
            }
        }
        Column(
            Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            val state = buildList {
                if (ev.canceled) add("Canceled")
                if (ev.busy == "tentative" && ev.myResponse != "tentative") add("Tentative")
                if (ev.busy == "free") add("Free")
                if (ev.busy == "outOfOffice") add("Out of office")
            }
            if (state.isNotEmpty()) Text(state.joinToString(" · "), color = onTint(TurmaColors.waitingText()), fontWeight = FontWeight.SemiBold)
            DetailRow("When", calWhenText(ev, zone, locale))
            calMovedFrom(ev)?.let { o ->
                DetailRow("Moved", "from ${calLongDay(calDay(o, zone), locale)}, ${calTime(o, zone, locale)}")
            }
            if (ev.tenir && ev.moved) DetailRow("Moved", "its Outlook event moved to another time")
            // Locked (XERK-2964): an Outlook event's org is its host's, shown, never picked.
            // A Turma event names every org it belongs to (XERK-2972).
            val evOrgs = calOrgsOf(ev)
            if (ev.turma && evOrgs.size > 1) DetailRow("Orgs", evOrgs.joinToString(", ") { orgLabel(it) })
            else DetailRow("Org", orgLabel(ev.org))
            if (ev.recurring) {
                // A Turma series says its rule as the editor does; an Outlook one only that it repeats (XERK-2973).
                val rule = if (ev.turma) com.xerktech.turma.core.calRuleOf(ev.recurrence) else null
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Repeats", Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Icon(Icons.Outlined.Repeat, null, Modifier.size(16.dp))
                    Text(
                        if (rule != null) com.xerktech.turma.core.calRepeatSummary(rule, com.xerktech.turma.core.calAnchorDay(ev, zone))
                        else "Part of a recurring series",
                        Modifier.weight(1f).testTag("cal-repeats"), style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            DetailRow("Where", ev.location)
            DetailRow(
                "Organizer",
                if (ev.organizer.isNotEmpty() && ev.organizerEmail.isNotEmpty()) "${ev.organizer} (${ev.organizerEmail})" else ev.organizer,
            )
            DetailRow("You", calMyResponse(ev.myResponse))
            val olk = com.xerktech.turma.core.calOutlookStates(ev)
            DetailRow(
                "Calendar",
                if (ev.tenir) "Captured by Tenir — not on Outlook"
                else if (ev.turma) (if (olk != null) "Made in Turma" else "Made in Turma — not on Outlook")
                else if (ev.host.isNotEmpty()) "Outlook on ${bareKey(ev.host)}" else "",
            )
            // Each org's copy in Outlook (XERK-2987), the error in Outlook's own words.
            if (!olk.isNullOrEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("Outlook", Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.weight(1f)) {
                        for (x in olk) {
                            Text(
                                if (olk.size == 1) x.text else "${orgLabel(x.org)}: ${x.text}",
                                Modifier.testTag("cal-olk-row"),
                                style = MaterialTheme.typography.bodyMedium,
                                color = when (x.state) {
                                    "failed" -> onTint(TurmaColors.criticalText())
                                    "written" -> MaterialTheme.colorScheme.onSurface
                                    else -> onTint(MaterialTheme.colorScheme.onSurfaceVariant)
                                },
                            )
                        }
                    }
                }
            }
            if (ev.turma) calReminderText(ev.reminderMinutes).takeIf { it.isNotEmpty() }?.let { DetailRow("Reminder", it) }
            if (ev.turma && !ev.private && ev.sensitivity == "private") DetailRow("Privacy", "Private: only you see its details")
            val cats = ev.categories.filter { it.isNotEmpty() }
            if (cats.isNotEmpty()) DetailRow("Categories", cats.joinToString(", "))
            // Only a Turma event the hub says this caller may change offers these (XERK-2972);
            // an Outlook event is changed in Outlook.
            if (ev.canEdit) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    // An occurrence of a series first asks which events (XERK-2973), as Teams does.
                    GhostButton("Edit", { if (ev.turmaOccurrence) askScope = "edit" else onEdit(ev, "") }, Modifier.testTag("cal-edit"), enabled = !eventBusy)
                    GhostButton("Delete", { if (ev.turmaOccurrence) askScope = "delete" else confirmDelete = true }, Modifier.testTag("cal-delete"), enabled = !eventBusy)
                }
            }
            if (askScope.isNotEmpty()) {
                val del = askScope == "delete"
                androidx.compose.material3.AlertDialog(
                    onDismissRequest = { askScope = "" },
                    title = { Text(if (del) "Delete which events?" else "Edit which events?") },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("“${calTitle(ev)}” repeats.", style = MaterialTheme.typography.bodyMedium)
                            for ((scope, label) in listOf("occurrence" to "This event", "following" to "This and following", "series" to "All events")) {
                                TextButton({
                                    askScope = ""
                                    if (del) cvm.deleteEvent(ev.id, scope) { r -> if (r is com.xerktech.turma.vm.EventResult.Deleted) onClose() }
                                    else onEdit(ev, scope)
                                }, Modifier.fillMaxWidth().testTag("cal-scope-$scope"), enabled = !eventBusy) {
                                    Text(label, Modifier.fillMaxWidth(), color = if (del) TurmaColors.critical else Color.Unspecified)
                                }
                            }
                        }
                    },
                    confirmButton = {},
                    dismissButton = { TextButton({ askScope = "" }, Modifier.testTag("cal-scope-cancel")) { Text("Cancel") } },
                )
            }
            if (confirmDelete) {
                androidx.compose.material3.AlertDialog(
                    onDismissRequest = { confirmDelete = false },
                    title = { Text("Delete this event?") },
                    text = { Text("“${calTitle(ev)}” is removed for every org it belongs to.") },
                    confirmButton = {
                        TextButton({
                            confirmDelete = false
                            cvm.deleteEvent(ev.id) { r -> if (r is com.xerktech.turma.vm.EventResult.Deleted) onClose() }
                        }, Modifier.testTag("cal-delete-confirm")) { Text("Delete") }
                    },
                    dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel") } },
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val join = calSafeHttps(ev.joinUrl)
                if (join.isNotEmpty()) GhostButton("Join meeting ↗", { uri.openUri(join) }, Modifier.testTag("cal-join"))
                calNotesTarget(ev, now)?.let { t ->
                    GhostButton("Open in notes review", { onOpenNotes(t) }, Modifier.testTag("cal-open-notes"))
                }
            }
            val notes = buildList {
                if (ev.private) add("A private event: its details are withheld.")
                if (ev.tenir && ev.calendarEventMissing) add("The Outlook event it was linked to is no longer on the calendar.")
                if (ev.tenir && ev.ambiguous) add("More than one Outlook event fits this capture; link the right one below.")
            }
            for (n in notes) Text(n, style = MaterialTheme.typography.bodySmall, color = muted)
            val people = ev.attendees.filter { it.name.isNotEmpty() || it.email.isNotEmpty() }
            if (people.isNotEmpty()) {
                GhostButton((if (attOpen) "▾" else "▸") + " Attendees (${people.size})", { attOpen = !attOpen }, Modifier.testTag("cal-attendees"))
                if (attOpen) for (a in people) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(a.name.ifEmpty { a.email }, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium)
                        val role = when (a.role) { "optional" -> "optional"; "resource" -> "room"; else -> "" }
                        if (role.isNotEmpty()) Text(role, style = MaterialTheme.typography.bodySmall, color = muted)
                        val resp = calAttendeeResponse(a.response)
                        if (resp.isNotEmpty()) {
                            Text(resp, style = MaterialTheme.typography.bodySmall, color = when (a.response) {
                                "accepted", "organizer" -> onTint(TurmaColors.workingText())
                                "declined" -> onTint(TurmaColors.criticalText())
                                "tentative" -> onTint(TurmaColors.waitingText())
                                else -> muted
                            })
                        }
                    }
                }
            }
            if (ev.body.isNotBlank()) {
                GhostButton((if (descOpen) "▾" else "▸") + " Description", { descOpen = !descOpen }, Modifier.testTag("cal-desc"))
                // Outlook's text as written, plain: Compose draws it, never parses it.
                if (descOpen) Text(ev.body.trim(), style = MaterialTheme.typography.bodyMedium)
            }

            // The capture part: one org's linked captures, reviewed in place, and a daily meeting's brief.
            val spec = calPanelSpec(ev, hostOrg)
            val caps = spec?.meetingIds.orEmpty().mapNotNull { id -> fleet.meetingProposals[spec!!.site]?.firstOrNull { it.meetingId == id } }
            val daily = spec?.takeIf { it.dailyAt > 0 }?.let { dailyFor(it.site, it.dailyAt) }
            if (daily != null && daily.daily) {
                HorizontalDivider()
                Text("Daily brief", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                val briefs = fleet.dailyBriefs[daily.siteKey].orEmpty()
                val asking by bvm.asking.collectAsStateWithLifecycle()
                DailyPart(
                    daily, now, zone, locale,
                    running = briefs.firstOrNull()?.status == "running",
                    asking = daily.siteKey in asking,
                    onRunNow = { bvm.runNow(daily.siteKey) },
                )
            }
            for (m in caps) {
                HorizontalDivider()
                Text(meetingTitle(m), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                MeetingPart(spec!!.site, m, mvm, textOn = onTint)
            }
            // What a Tenir entry says when the snapshot no longer carries its row.
            if (ev.tenir && caps.isEmpty()) {
                HorizontalDivider()
                if (ev.status == "queued" || ev.status == "running") Text("Reading the captions…", color = muted)
                val ppl = ev.participants.filter { it.isNotEmpty() }
                if (ppl.isNotEmpty()) Text(ppl.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = muted)
                if (ev.summary.isNotBlank()) {
                    for (p in ev.summary.trim().split(Regex("\n{2,}")).map { it.trim() }.filter { it.isNotEmpty() }) {
                        Text(p, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                val url = safeMeetingUrl(ev.tenirUrl)
                if (url.isNotEmpty()) GhostButton("Open in Tenir ↗", { uri.openUri(url) })
            }
            for (c in calCapturesOf(ev)) {
                RelinkControls(ev, c, fleet, events, zone, locale, cvm, hostOrg)
            }
            if (!ev.tenir && !ev.turma && calCapturesOf(ev).isEmpty() && (ev.startMs ?: 0) < now) {
                Text("Tenir captured nothing for this event.", style = MaterialTheme.typography.bodySmall, color = muted)
            }
            Spacer(Modifier.height(12.dp))
        }
    }
    }
}

/**
 * Each host's calendar settings (XERK-2929, the web's `hostSettingsHtml`): whether its
 * private events are shown, saved at once. Its org is shown, never set: every event
 * takes its host's org (XERK-2964).
 */
@Composable
private fun HostSettings(rows: Map<String, com.xerktech.turma.model.CalendarHost>, names: Map<String, String>, cvm: CalendarViewModel) {
    val busy by cvm.setBusy.collectAsStateWithLifecycle()
    val errs by cvm.setErr.collectAsStateWithLifecycle()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val orgLabel: (String) -> String = { s -> com.xerktech.turma.core.orgName(s, names[s].orEmpty()) }
    val list = rows.values.sortedBy { it.device.ifEmpty { it.host } }
    TurmaCard(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).testTag("cal-host-settings")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (list.isEmpty()) {
                Text("No host has synced a calendar yet.", style = MaterialTheme.typography.bodySmall, color = muted)
                return@Column
            }
            for (h in list) {
                val k = h.host
                val on = k !in busy
                HorizontalDivider()
                Text(h.device.ifEmpty { h.host }, fontWeight = FontWeight.SemiBold)
                Text(
                    if (h.org.isNotEmpty()) orgLabel(h.org) else "No org",
                    Modifier.testTag("cal-host-org-$k"), style = MaterialTheme.typography.bodySmall, color = muted,
                )
                CheckRow(
                    "Show private events", h.showPrivate,
                    { cvm.saveHost(k, buildJsonObject { put("showPrivate", it) }) },
                    Modifier.testTag("cal-host-private-$k"), enabled = on,
                )
                errs[k]?.let { Text(it, color = TurmaColors.critical, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
}

@Composable
private fun DetailRow(k: String, v: String) {
    if (v.isEmpty()) return
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(k, Modifier.width(84.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(v, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Relink a capture (`POST .../meetings/<mid>/calendar`): move it to another
 * same-day Outlook event of its org, Unlink it for good, or hand it back to the
 * matcher ("Match automatically", only once an operator chose).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RelinkControls(
    ev: CalendarEvent,
    c: com.xerktech.turma.model.CalendarCapture,
    fleet: FleetState,
    events: List<CalendarEvent>,
    zone: ZoneId,
    locale: Locale,
    cvm: CalendarViewModel,
    hostOrg: (String) -> String,
) {
    val busy by cvm.linkBusy.collectAsStateWithLifecycle()
    val errs by cvm.linkErr.collectAsStateWithLifecycle()
    val k = "${c.site}\u0000${c.meetingId}"
    val m = calMeetingOf(fleet.meetingProposals, c)
    val title = if (ev.tenir) calTitle(ev) else c.title.ifEmpty { m?.let { meetingTitle(it) } ?: "Tenir capture" }
    val linked = !ev.tenir || ev.calendarEventId.isNotEmpty()
    val cands = calLinkCandidates(c.site, ev.startMs ?: 0, if (ev.tenir) "" else ev.key, events, zone, hostOrg)
    val picks = remember { mutableStateMapOf<String, String>() }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val pick = cands.firstOrNull { it.key == picks[k] }
    val inFlight = k in busy
    TurmaCard(Modifier.fillMaxWidth().testTag("cal-link")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (ev.tenir) "This capture" else "Tenir capture: $title", fontWeight = FontWeight.SemiBold)
            if (cands.isEmpty()) {
                Text("No other Outlook event that day to link it to.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Picker(
                    label = pick?.let { "${calTime(it.startMs ?: 0, zone, locale)} · ${calTitle(it)}" }
                        ?: if (linked) "Move it to another event…" else "Link it to an Outlook event…",
                    options = cands.map { it.key to "${calTime(it.startMs ?: 0, zone, locale)} · ${calTitle(it)}" },
                    onPick = { picks[k] = it },
                )
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (cands.isNotEmpty()) {
                    GhostButton(if (inFlight) "Working…" else "Link", {
                        val t = pick ?: return@GhostButton
                        val job = cvm.relink(c.site, c.meetingId, buildJsonObject { put("eventId", t.id) }, "Linking the capture")
                        // The pick is cleared only once the link held (the web keeps it on a refusal).
                        scope.launch { job?.join(); if (k !in cvm.linkErr.value) picks.remove(k) }
                    }, Modifier.testTag("cal-link-go"), enabled = pick != null && !inFlight)
                }
                if (linked) {
                    GhostButton("Unlink", {
                        cvm.relink(c.site, c.meetingId, buildJsonObject { put("eventId", JsonNull) }, "Unlinking the capture")
                    }, Modifier.testTag("cal-link-unlink"), enabled = !inFlight)
                }
                if (m?.calendarBy == "operator") {
                    GhostButton("Match automatically", {
                        cvm.relink(c.site, c.meetingId, buildJsonObject { put("auto", JsonPrimitive(true)) }, "Matching the capture")
                    }, Modifier.testTag("cal-link-auto"), enabled = !inFlight)
                }
            }
            errs[k]?.let { Text(it, color = TurmaColors.critical, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

/** A daily entry is the daily meeting's when its scheduled time is within 20 min of [at]. */
internal fun dailyEntryNear(entries: List<TriageEntry>, at: Long): TriageEntry? =
    entries.firstOrNull { it.daily && kotlin.math.abs(it.at - at) <= CAL_DAILY_EVENT_MS }

/**
 * The rest of an empty-slot tap after its [down]: the up, or null once the touch
 * moved past [slop], a second finger landed, or anything else consumed it.
 */
private suspend fun androidx.compose.ui.input.pointer.AwaitPointerEventScope.awaitSlotTap(
    down: androidx.compose.ui.input.pointer.PointerInputChange,
    slop: Float,
): androidx.compose.ui.input.pointer.PointerInputChange? {
    while (true) {
        val ev = awaitPointerEvent()
        val c = ev.changes.firstOrNull { it.id == down.id } ?: return null
        if (c.isConsumed || ev.changes.count { it.pressed } > 1) return null
        if ((c.position - down.position).getDistance() > slop) return null
        if (!c.pressed) return c
    }
}
