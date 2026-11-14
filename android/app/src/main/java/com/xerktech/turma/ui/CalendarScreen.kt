package com.xerktech.turma.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import androidx.compose.material.icons.filled.ChevronLeft
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ClosedCaption
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
 * XERK-2897/2898/2899): a read-only, Teams-mobile-style week of every org's
 * Outlook events, Tenir's impromptu captures and holidays. A phone shows Day or
 * 3 days under a week day strip, ‹ › and swipe moving it; a wide screen
 * (tablet / unfolded foldable) the Work week or full Week. A tap opens the
 * event's detail — Outlook's details and a linked capture reviewed in place with
 * the notes review's own controls (MeetingPart), never a fork. Every served
 * string is plain Text; a link opens only an http(s) (join: https) URL.
 * Logic: core/Calendar.kt; data: vm/CalendarViewModel.kt.
 */

private val SLOT_DP = 24.dp           // one 30-minute row, as the web's 24px
private val HOUR_DP = SLOT_DP * 2
private val DAY_DP = HOUR_DP * 24
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

    var detailKey by rememberSaveable { mutableStateOf("") }
    var detailLast by remember { mutableStateOf<CalendarEvent?>(null) }
    var scrollTo by remember { mutableStateOf(-1.0) }
    var picker by rememberSaveable { mutableStateOf(false) }

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

    BackHandler(enabled = detail != null) { closeDetail() }

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
        Column(m) {
            CalToolbar(
                weekly, mode, days, anchor, cvm.today(), locale,
                onToday = { revealWeek = false; go(cvm.today()) },
                onStep = { dir -> go(calStep(anchor, mode, dir)) },
                onPicker = { picker = true },
                onMode = { revealWeek = false; cvm.setMode(weekly, it) },
                onDay = { go(it) },
            )
            CalNotices(range, now, zone, locale)
            WeekGrid(
                Modifier.weight(1f), weekly, days, range, now, zone, locale, fleet, keys, names, colors,
                detailKey = detail?.key, scrollTo = scrollTo, onScrolled = { scrollTo = -1.0 },
                onOpen = ::openDetail,
                onSwipe = { dir -> go(calStep(anchor, mode, dir)) },
            )
        }
    }
    val panel: @Composable (Modifier, CalendarEvent) -> Unit = { m, ev ->
        key(ev.key) {
            CalendarDetail(
                m, ev, side, now, zone, locale, fleet, names, range.events, cvm, bvm, mvm,
                onClose = ::closeDetail, onOpenNotes = onOpenNotes, dailyFor = dailyFor,
            )
        }
    }
    when {
        detail == null -> grid(modifier.fillMaxSize())
        side -> Row(modifier.fillMaxSize()) {
            grid(Modifier.weight(1f).fillMaxHeight())
            VerticalDivider()
            panel(Modifier.width(400.dp).fillMaxHeight(), detail)
        }
        else -> panel(modifier.fillMaxSize(), detail)
    }
}

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
) {
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
    onOpen: (CalendarEvent) -> Unit,
    onSwipe: (Int) -> Unit,
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
    val offOf = days.associateWith { calOffOrgs(it, range.holidays, keys.toSet()) }
    // The grid opens at working hours (8 AM in view); a reveal scrolls to its event.
    LaunchedEffect(Unit) { scroll.scrollTo(with(density) { (HOUR_DP * CAL_WORK_FROM_H - 12.dp).roundToPx() }) }
    LaunchedEffect(scrollTo) {
        if (scrollTo >= 0) {
            scroll.animateScrollTo(with(density) { ((SLOT_DP * (scrollTo / 30).toFloat()) - HOUR_DP).roundToPx().coerceAtLeast(0) })
            onScrolled()
        }
    }
    val swipePx = with(density) { 60.dp.toPx() }
    Column(
        modifier.fillMaxWidth().semantics { contentDescription = "Calendar, ${calRangeLabel(days, locale)}" }
            // Swipe left/right moves like › / ‹; a swipe never also opens the event under it.
            .pointerInput(days.first(), days.size) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    var last = down.position
                    while (true) {
                        val ev = awaitPointerEvent(PointerEventPass.Initial)
                        val c = ev.changes.firstOrNull { it.id == down.id } ?: break
                        last = c.position
                        if (!c.pressed) {
                            val dx = last.x - down.position.x
                            val dy = last.y - down.position.y
                            if (kotlin.math.abs(dx) > swipePx && kotlin.math.abs(dx) > 2 * kotlin.math.abs(dy)) {
                                c.consume()
                                onSwipe(if (dx < 0) 1 else -1)
                            }
                            break
                        }
                    }
                }
            },
    ) {
        // Day headers: date + weekday; today in the accent with a top bar; a day off says so.
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.width(gutter))
            for (d in days) {
                val isToday = d == today
                val off = offOf[d].orEmpty()
                Column(
                    Modifier.weight(1f)
                        .padding(horizontal = 2.dp)
                        .semantics(mergeDescendants = true) {}
                        .testTag("cal-dh-${calDayKey(d)}"),
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
            for (d in days) {
                Column(
                    Modifier.weight(1f).then(if (offOf[d].orEmpty().isNotEmpty()) Modifier.hatch(offShade) else Modifier)
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
                            aria = calAria(ev, d, orgLabel(ev.org), badge, zone, locale),
                        ) { onOpen(ev) }
                    }
                }
            }
        }
        // The timed grid: 30-minute rows, working hours unshaded, a red now-line on today.
        Box(Modifier.weight(1f).fillMaxWidth().verticalScroll(scroll).testTag("cal-scroll")) {
            Row(Modifier.fillMaxWidth().height(DAY_DP)) {
                Box(Modifier.width(gutter).fillMaxHeight()) {
                    for (h in 1 until 24) {
                        Text(
                            DateTimeFormatter.ofPattern("h a", locale).format(java.time.LocalTime.of(h, 0)),
                            Modifier.offset(y = HOUR_DP * h - 7.dp).padding(start = 4.dp),
                            fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                for (d in days) {
                    val isToday = d == today
                    val off = offOf[d].orEmpty().isNotEmpty()
                    val surface = MaterialTheme.colorScheme.surface
                    BoxWithConstraints(
                        Modifier.weight(1f).fillMaxHeight()
                            .drawBehind {
                                drawRect(offShade)
                                val hp = HOUR_DP.toPx()
                                drawRect(surface, Offset(0f, hp * CAL_WORK_FROM_H),
                                    androidx.compose.ui.geometry.Size(size.width, hp * (CAL_WORK_UNTIL_H - CAL_WORK_FROM_H)))
                                for (h in 0 until 24) drawLine(outline, Offset(0f, hp * h), Offset(size.width, hp * h), 0.5.dp.toPx())
                                drawLine(outline, Offset(0f, 0f), Offset(0f, size.height), 0.5.dp.toPx())
                            }
                            .then(if (off) Modifier.hatch(offShade) else Modifier)
                            .testTag("cal-col-${calDayKey(d)}"),
                    ) {
                        val w = maxWidth
                        for (seg in calDaySegments(range.events, d, zone)) {
                            val ev = seg.ev
                            val badge = calBadge(ev, fleet.meetingProposals)
                            val h = SLOT_DP * ((seg.bottom - seg.top) / 30).toFloat() - 2.dp
                            EventBlock(
                                segModifier(seg, w, h), ev, now, colorOf(ev.org), badge, short = h < SHORT_DP,
                                open = ev.key == detailKey,
                                aria = calAria(ev, d, orgLabel(ev.org), badge, zone, locale),
                                meta = listOf(calSpan(ev.startMs ?: 0, ev.endMs ?: 0, zone, locale), ev.location)
                                    .filter { it.isNotEmpty() }.joinToString(" · "),
                            ) { onOpen(ev) }
                        }
                        if (isToday) {
                            val y = SLOT_DP * (calWallMinutes(now, d, zone) / 30).toFloat()
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

private fun segModifier(seg: CalSeg, colWidth: Dp, height: Dp): Modifier {
    val left = colWidth * (seg.col.toFloat() / seg.cols)
    val width = colWidth * (seg.span.toFloat() / seg.cols)
    return Modifier.offset(x = left + 1.dp, y = SLOT_DP * (seg.top / 30).toFloat())
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
                Text(
                    calTitle(ev), Modifier.weight(1f, fill = false), fontSize = if (short) 11.sp else 12.sp, fontWeight = FontWeight.SemiBold,
                    maxLines = if (short) 1 else 2, overflow = TextOverflow.Ellipsis,
                    lineHeight = if (short) 12.sp else 14.sp,
                    textDecoration = if (st.canceled) TextDecoration.LineThrough else null,
                )
                Spacer(Modifier.weight(0.001f))
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
) {
    val uri = LocalUriHandler.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val hostOrg: (String) -> String = { h -> fleet.agents.firstOrNull { it.key == h }?.org.orEmpty() }
    val orgLabel: (String) -> String = { s -> if (s.isEmpty()) "No org" else com.xerktech.turma.core.orgName(s, names[s].orEmpty()) }
    var descOpen by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxSize().testTag("cal-detail")) {
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
            if (state.isNotEmpty()) Text(state.joinToString(" · "), color = TurmaColors.warning, fontWeight = FontWeight.SemiBold)
            DetailRow("When", calWhenText(ev, zone, locale))
            calMovedFrom(ev)?.let { o ->
                DetailRow("Moved", "from ${calLongDay(calDay(o, zone), locale)}, ${calTime(o, zone, locale)}")
            }
            if (ev.tenir && ev.moved) DetailRow("Moved", "its Outlook event moved to another time")
            DetailRow("Org", orgLabel(ev.org))
            if (ev.recurring) DetailRow("Repeats", "Part of a recurring series")
            DetailRow("Where", ev.location)
            DetailRow(
                "Organizer",
                if (ev.organizer.isNotEmpty() && ev.organizerEmail.isNotEmpty()) "${ev.organizer} (${ev.organizerEmail})" else ev.organizer,
            )
            DetailRow("You", calMyResponse(ev.myResponse))
            DetailRow(
                "Calendar",
                if (ev.tenir) "Captured by Tenir — not on Outlook"
                else if (ev.host.isNotEmpty()) "Outlook on ${bareKey(ev.host)}" else "",
            )
            val cats = ev.categories.filter { it.isNotEmpty() }
            if (cats.isNotEmpty()) DetailRow("Categories", cats.joinToString(", "))
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
                SectionLabel("Attendees")
                for (a in people) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(a.name.ifEmpty { a.email }, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyMedium)
                        val role = when (a.role) { "optional" -> "optional"; "resource" -> "room"; else -> "" }
                        if (role.isNotEmpty()) Text(role, style = MaterialTheme.typography.bodySmall, color = muted)
                        val resp = calAttendeeResponse(a.response)
                        if (resp.isNotEmpty()) {
                            Text(resp, style = MaterialTheme.typography.bodySmall, color = when (a.response) {
                                "accepted", "organizer" -> TurmaColors.good
                                "declined" -> TurmaColors.critical
                                "tentative" -> TurmaColors.warning
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
                MeetingPart(spec!!.site, m, mvm)
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
            if (!ev.tenir && calCapturesOf(ev).isEmpty() && (ev.startMs ?: 0) < now) {
                Text("Tenir captured nothing for this event.", style = MaterialTheme.typography.bodySmall, color = muted)
            }
            Spacer(Modifier.height(12.dp))
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
