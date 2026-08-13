package com.xerktech.turma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import android.widget.Toast
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import kotlinx.coroutines.launch
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.BOARD_CATEGORIES
import com.xerktech.turma.core.BoardSite
import com.xerktech.turma.core.CreateMetaFetch
import com.xerktech.turma.core.CreateResultFetch
import com.xerktech.turma.core.PrioEmphasis
import com.xerktech.turma.core.MoveState
import com.xerktech.turma.core.StartControl
import com.xerktech.turma.core.StartState
import com.xerktech.turma.core.TicketSession
import com.xerktech.turma.core.ageStr
import com.xerktech.turma.core.boardColumnOf
import com.xerktech.turma.core.categoryOf
import com.xerktech.turma.core.createDirty
import com.xerktech.turma.core.createLabelWord
import com.xerktech.turma.core.edgeScrollStep
import com.xerktech.turma.core.filterSites
import com.xerktech.turma.core.mergeSites
import com.xerktech.turma.core.orgColorMap
import com.xerktech.turma.core.orgName
import com.xerktech.turma.core.overdueOf
import com.xerktech.turma.core.prioClass
import com.xerktech.turma.core.splitLabels
import com.xerktech.turma.core.ticketSessionIndex
import com.xerktech.turma.core.ticketSessionLabel
import com.xerktech.turma.core.ticketSessionState
import com.xerktech.turma.core.ticketSessionsOf
import com.xerktech.turma.core.queueView
import com.xerktech.turma.core.queuedTicketOf
import com.xerktech.turma.core.ticketStartControl
import com.xerktech.turma.model.CreateTicketRequest
import com.xerktech.turma.model.JiraTicket
import com.xerktech.turma.model.QueuedTicket
import com.xerktech.turma.ui.theme.TurmaColors
import com.xerktech.turma.vm.BoardViewModel
import kotlinx.coroutines.launch

/** In-flight drag of a card across columns (XERK-141). Held by BoardScreen; the
 *  ghost follows [pointer] (window coords) and drops into [overCat]. */
private data class DragState(
    val site: BoardSite,
    val ticket: JiraTicket,
    val fromCat: String,
    val pointer: Offset,
    val size: IntSize,
    val overCat: String?,
)

/** Edge auto-scroll while dragging (XERK-179): zone width (web EDGE_SCROLL_PX)
 *  and the scroll speed at the strip's very edge. */
private val DRAG_EDGE_ZONE = 48.dp
private val DRAG_EDGE_MAX_SPEED = 1000.dp // per second, at full zone depth

@Composable
fun BoardScreen(
    modifier: Modifier = Modifier,
    vm: BoardViewModel = viewModel(),
    // Where a session chip opens: a running session in its live chat, anything
    // else in the read-only ended review (web board.js sessionChipHtml hrefs).
    onOpenChat: (host: String, sessionId: String) -> Unit = { _, _ -> },
    onOpenEnded: (host: String, transcriptId: String) -> Unit = { _, _ -> },
) {
    LaunchedEffect(Unit) { vm.start() }
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val orgFilter by vm.orgFilter.collectAsStateWithLifecycle()
    val starts by vm.starts.collectAsStateWithLifecycle()
    val moves by vm.moves.collectAsStateWithLifecycle()
    // Tickets waiting for a free session slot (XERK-296): the hub's own list,
    // through this client's in-flight optimism over it.
    val queueAdds by vm.queueAdds.collectAsStateWithLifecycle()
    val queueDrops by vm.queueDrops.collectAsStateWithLifecycle()
    val ticketQueue = remember(fleet.ticketQueue, queueAdds, queueDrops) {
        queueView(fleet.ticketQueue, queueAdds, queueDrops)
    }
    val sites = remember(fleet) { mergeSites(fleet.agents) }
    // Ticket -> sessions reverse index over the whole fleet payload (XERK-78).
    val sessionIndex = remember(fleet) { ticketSessionIndex(fleet.agents) }
    val now = fleet.now.takeIf { it > 0 } ?: System.currentTimeMillis()
    // One assignment of unique per-org colors over the whole org set, shared by
    // the header control and the columns so an org is one color everywhere
    // (XERK-48).
    val colorMap = remember(sites, fleet.orgColors) {
        orgColorMap(sites.map { it.siteKey }, fleet.orgColors)
    }
    // The scope is the header control's (XERK-62); filterSites self-heals picks
    // no org still reports, exactly as `effectiveOrgs` does for the other screens.
    val shown = remember(sites, orgFilter) { filterSites(sites, orgFilter) }
    var detail by remember { mutableStateOf<Pair<BoardSite, JiraTicket>?>(null) }

    val context = LocalContext.current
    LaunchedEffect(Unit) { vm.messages.collect { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() } }

    Column(modifier.fillMaxSize()) {
        ScreenHeader("Board") {
            // The New-ticket button moved into the shared ScreenHeader (XERK-150),
            // so it's on every screen — see NewTicketAction. Only Refresh is
            // board-specific now.
            IconButton(onClick = { vm.refresh() }, enabled = !refreshing) {
                if (refreshing) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.Filled.Refresh, "Refresh")
            }
        }
        if (sites.isEmpty() || shown.all { it.tickets.isEmpty() }) {
            Text(
                when {
                    // The scoped org reporting nothing is a different story from a
                    // fleet with no tickets at all, and the way out is the header.
                    sites.isNotEmpty() && shown.size < sites.size ->
                        "No tickets for the selected orgs. Change the org filter (or pick “All orgs”) in the header."
                    fleet.agents.any { it.jira?.configured == true } -> "No tickets."
                    else -> "No ticket-board-configured hosts."
                },
                Modifier.padding(16.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            // Drag-and-drop status change (XERK-141): long-press a card, drag it
            // onto another column, drop to change its status. The board area is a
            // Box so the dragged "ghost" card can float above the columns; each
            // column reports its window bounds so the drop resolves to a column,
            // and `moves` (the VM's optimistic override) keeps a dropped card in
            // its new column until the board's own poll catches up.
            var drag by remember { mutableStateOf<DragState?>(null) }
            val colBounds = remember { mutableStateMapOf<String, Rect>() }
            var boxBounds by remember { mutableStateOf(Rect.Zero) }
            val hScroll = rememberScrollState()
            // Auto-scroll the strip while the drag hovers near an edge (XERK-179,
            // board.html edgeScroll): the long-press drag owns the gesture, so the
            // strip must scroll itself for a card to reach an off-screen column —
            // the columns slide under the held finger. A frame loop rather than a
            // per-move step, so it keeps scrolling while the finger holds still;
            // each column re-reports its bounds as it moves, so the drop target is
            // re-resolved even though the pointer itself hasn't moved.
            val density = LocalDensity.current
            LaunchedEffect(drag != null) {
                if (drag == null) return@LaunchedEffect
                val edgePx = with(density) { DRAG_EDGE_ZONE.toPx() }
                val speedPx = with(density) { DRAG_EDGE_MAX_SPEED.toPx() }
                var last = 0L
                while (drag != null) {
                    val now = withFrameNanos { it }
                    val dt = if (last == 0L) 0f else (now - last) / 1_000_000_000f
                    last = now
                    val d = drag ?: break
                    val step = edgeScrollStep(d.pointer.x, boxBounds.left, boxBounds.right, edgePx, speedPx * dt)
                    if (step != 0f) hScroll.scrollBy(step)
                    val over = colBounds.entries.firstOrNull { it.value.contains(d.pointer) }?.key
                    if (over != d.overCat) drag = d.copy(overCat = over)
                }
            }
            Box(
                Modifier.fillMaxSize().onGloballyPositioned { boxBounds = it.boundsInWindow() },
            ) {
                Row(
                    Modifier.fillMaxSize().horizontalScroll(hScroll).padding(horizontal = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    for ((cat, title) in BOARD_CATEGORIES) {
                        // Newest-updated first, matching board.js `ticketSort`; a
                        // live drag override lands the card in its dropped column.
                        val cards = shown
                            .flatMap { site -> site.tickets
                                .filter { boardColumnOf(it, moves[BoardViewModel.startKey(site.siteKey, it.key)]) == cat }
                                .map { site to it } }
                            .sortedByDescending { it.second.updated }
                        KanbanColumn(
                            cat, title, cards, colorMap, now,
                            sessionIndex = sessionIndex,
                            starts = starts,
                            moves = moves,
                            queue = ticketQueue,
                            dropTarget = drag != null && drag!!.overCat == cat && drag!!.fromCat != cat,
                            draggingKey = drag?.let { BoardViewModel.startKey(it.site.siteKey, it.ticket.key) },
                            onBounds = { r -> colBounds[cat] = r },
                            onStart = { site, t -> vm.startSession(site.siteKey, t.key) },
                            onCancelQueued = { site, t -> vm.cancelQueued(site.siteKey, t.key) },
                            onOpenSession = { s ->
                                if (s.status == "running" && s.id.isNotBlank()) onOpenChat(s.host, s.id)
                                else if (s.transcriptId.isNotBlank()) onOpenEnded(s.host, s.transcriptId)
                            },
                            onOpen = { site, t -> detail = site to t },
                            onDragStart = { site, t, size, rootPos ->
                                drag = DragState(site, t, cat, rootPos, size, cat)
                            },
                            onDragDelta = { delta ->
                                drag = drag?.let { d ->
                                    val p = d.pointer + delta
                                    d.copy(pointer = p,
                                        overCat = colBounds.entries.firstOrNull { it.value.contains(p) }?.key)
                                }
                            },
                            onDragEnd = {
                                drag?.let { d ->
                                    if (d.overCat != null && d.overCat != d.fromCat) {
                                        vm.moveTicket(d.site.siteKey, d.ticket.key, d.overCat)
                                    }
                                }
                                drag = null
                            },
                            onDragCancel = { drag = null },
                        )
                    }
                }
                // The floating ghost of the card being dragged, following the finger.
                drag?.let { d ->
                    val local = d.pointer - boxBounds.topLeft
                    TurmaCard(
                        Modifier
                            .width(280.dp)
                            .offset { IntOffset(
                                (local.x - d.size.width / 2f).roundToInt(),
                                (local.y - d.size.height / 2f).roundToInt()) }
                            .alpha(0.95f),
                    ) {
                        Text(
                            "${d.ticket.key}  ${d.ticket.summary}",
                            Modifier.padding(12.dp),
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 2,
                        )
                    }
                }
            }
        }
    }

    detail?.let { (site, ticket) ->
        // The Agent/Model pins live on the fleet payload (hub-owned), not the
        // ticket, so they're resolved here where the fleet state is in scope.
        val pin = com.xerktech.turma.core.agentPinOf(fleet.ticketAgents, site.siteKey, ticket.key)
        val modelPin = com.xerktech.turma.core.modelPinOf(fleet.ticketModels, site.siteKey, ticket.key)
        TicketDetailSheet(site, ticket, pin, modelPin, vm, onDismiss = { detail = null })
    }
}

/**
 * The "New ticket" action, carried by the shared [ScreenHeader] so a ticket can
 * be created from any of the four top-level screens (XERK-150) — the web mounts
 * it in the site header's `#hdrNewTicket` slot beside the org filter for the same
 * reason. It used to be a board-only button.
 *
 * It reads the shared fleet stream itself (like [OrgFilterAction]) rather than
 * being handed data, so it works wherever the header renders. Hidden until a
 * host reports a tracker org to create against, as the web slot collapses.
 *
 * A LABELED accent pill reading "New ticket", matching the web's rounded button.
 * Text-only, no icon: the words are what make it obvious, and dropping the icon
 * keeps the pill as small as possible in the narrow phone header (an icon alone
 * wasn't clear, and a `+` collided with the "New session" `+` the Sessions and
 * Dashboard headers carry — so the label carries the meaning on its own).
 */
@Composable
fun NewTicketAction(vm: BoardViewModel = viewModel()) {
    val fleet by vm.fleet.collectAsStateWithLifecycle()
    val orgFilter by vm.orgFilter.collectAsStateWithLifecycle()
    val sites = remember(fleet) { mergeSites(fleet.agents) }
    if (sites.isEmpty()) return
    var creating by remember { mutableStateOf(false) }
    Surface(
        onClick = { creating = true },
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
    ) {
        Text(
            "New ticket",
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
        )
    }
    if (creating) {
        // Default the form's org to the header scope when it names a real one,
        // else the first org — the web openCreate's pick.
        val initial = sites.firstOrNull { it.siteKey in orgFilter }?.siteKey ?: sites.first().siteKey
        CreateTicketSheet(sites, initial, vm, onDismiss = { creating = false })
    }
}

@Composable
private fun KanbanColumn(
    cat: String,
    title: String,
    cards: List<Pair<BoardSite, JiraTicket>>,
    colorMap: Map<String, Int>,
    now: Long,
    sessionIndex: Map<String, List<TicketSession>>,
    starts: Map<String, StartState>,
    moves: Map<String, MoveState>,
    queue: List<QueuedTicket>,
    dropTarget: Boolean,
    draggingKey: String?,
    onBounds: (Rect) -> Unit,
    onStart: (BoardSite, JiraTicket) -> Unit,
    onCancelQueued: (BoardSite, JiraTicket) -> Unit,
    onOpenSession: (TicketSession) -> Unit,
    onOpen: (BoardSite, JiraTicket) -> Unit,
    onDragStart: (BoardSite, JiraTicket, IntSize, Offset) -> Unit,
    onDragDelta: (Offset) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
) {
    // A card can be dropped anywhere over the whole column, so the WHOLE column
    // reports its window bounds (not just the list) — else the gaps between
    // cards would read as "no target".
    var colMod = Modifier.width(300.dp).fillMaxSize().onGloballyPositioned { onBounds(it.boundsInWindow()) }
    if (dropTarget) {
        colMod = colMod
            .clip(RoundedCornerShape(8.dp))
            .border(2.dp, MaterialTheme.colorScheme.primary, RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.06f))
    }
    Column(colMod) {
        Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            SectionLabel(title)
            Spacer(Modifier.width(6.dp))
            Text("${cards.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(cards, key = { it.second.key }) { (site, t) ->
                val moveKey = BoardViewModel.startKey(site.siteKey, t.key)
                TicketCard(
                    t,
                    TurmaColors.series[(colorMap[site.siteKey] ?: 0) % TurmaColors.series.size],
                    now = now,
                    sessions = ticketSessionsOf(sessionIndex, site.siteKey, t.key),
                    start = starts[moveKey],
                    move = moves[moveKey],
                    queued = queuedTicketOf(queue, site.siteKey, t.key),
                    dragging = draggingKey == moveKey,
                    onOpenSession = onOpenSession,
                    onStart = { onStart(site, t) },
                    onCancelQueued = { onCancelQueued(site, t) },
                    onDragStart = { size, pos -> onDragStart(site, t, size, pos) },
                    onDragDelta = onDragDelta,
                    onDragEnd = onDragEnd,
                    onDragCancel = onDragCancel,
                    onClick = { onOpen(site, t) },
                )
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun TicketCard(
    t: JiraTicket,
    orgColor: Color,
    now: Long,
    sessions: List<TicketSession>,
    start: StartState?,
    move: MoveState?,
    queued: QueuedTicket?,
    dragging: Boolean,
    onStart: () -> Unit,
    onCancelQueued: () -> Unit,
    onOpenSession: (TicketSession) -> Unit,
    onDragStart: (IntSize, Offset) -> Unit,
    onDragDelta: (Offset) -> Unit,
    onDragEnd: () -> Unit,
    onDragCancel: () -> Unit,
    onClick: () -> Unit,
) {
    // The card's own window position, so a long-press's card-local start offset
    // can be reported to the drag controller in the same window coords the
    // column bounds are measured in.
    var cardPos by remember { mutableStateOf(Offset.Zero) }
    var cardSize by remember { mutableStateOf(IntSize.Zero) }
    val dragMod = Modifier.pointerInput(t.key) {
        detectDragGesturesAfterLongPress(
            onDragStart = { local -> onDragStart(cardSize, cardPos + local) },
            onDrag = { change, delta -> change.consume(); onDragDelta(delta) },
            onDragEnd = { onDragEnd() },
            onDragCancel = { onDragCancel() },
        )
    }
    TurmaCard(
        Modifier
            .fillMaxWidth()
            .onGloballyPositioned { cardPos = it.positionInWindow(); cardSize = it.size }
            .then(dragMod)
            .alpha(if (dragging) 0.35f else 1f),
        tint = orgColor, // subtle org tint on the card fill (XERK-142)
    ) {
        Column(Modifier.clickable(onClick = onClick).padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            // Top row (web .kc-top): org dot + project, issue type, age … key.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(orgColor))
                Text(t.project, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (t.type.isNotBlank()) {
                    Text(t.type, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(ageStr(t.updated, now), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                Text(t.key, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(t.summary, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 4)
            // Meta row (web .kc-meta): status + priority pills, due/overdue,
            // repo chip, session chips + start control.
            androidx.compose.foundation.layout.FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (t.status.isNotBlank()) Pill(t.status)
                if (t.priority.isNotBlank()) {
                    Pill(
                        t.priority,
                        color = when (prioClass(t.priority)) {
                            PrioEmphasis.HIGH -> MaterialTheme.colorScheme.error
                            PrioEmphasis.LOW -> MaterialTheme.colorScheme.onSurfaceVariant
                            PrioEmphasis.NONE -> null
                        },
                    )
                }
                t.dueDate?.takeIf { it.isNotBlank() }?.let { due ->
                    Pill("due $due", color = if (overdueOf(t, now)) MaterialTheme.colorScheme.error else null)
                }
                RepoChip(t)
                sessions.forEach { s -> TicketSessionChip(s, onClick = { onOpenSession(s) }) }
                TicketStartControl(t, sessions, start, queued, onStart, onCancelQueued)
                // A drag in flight / just landed, or a failed one (XERK-141).
                if (move?.error != null) {
                    Text("couldn't move", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                } else if (move?.pending == true) {
                    Text("moving…", style = MaterialTheme.typography.labelSmall, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/**
 * One of a ticket's sessions, as a chip linking into it (board.js
 * `sessionChipHtml`): a run-state dot + the branch-first label. Tapping a
 * running chip opens the live chat, anything else the read-only ended review; a
 * chip with no transcript (killed before its first turn) isn't tappable.
 */
@Composable
private fun TicketSessionChip(s: TicketSession, onClick: () -> Unit) {
    val state = ticketSessionState(s)
    val dot = when (state) {
        "running" -> TurmaColors.working
        "queued" -> TurmaColors.waiting
        "failed" -> MaterialTheme.colorScheme.error
        else -> TurmaColors.stopped
    }
    val tappable = (s.status == "running" && s.id.isNotBlank()) || s.transcriptId.isNotBlank()
    Row(
        Modifier
            .clip(RoundedCornerShape(7.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(7.dp))
            .then(if (tappable) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(dot))
        Text(
            ticketSessionLabel(s),
            style = MaterialTheme.typography.labelSmall,
            fontFamily = FontFamily.Monospace,
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 140.dp),
            color = if (state == "running") MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The card's start control (board.js `ticketStartHtml`): nothing without a
 * triaged repo, "⏳ starting…" while a spawn is in flight, else a live button —
 * "Start session" / "Start (clone first)" for an uncloned repo (the hub clones
 * on demand, XERK-14), compacted to "+" once the ticket already has sessions.
 * A failed start renders its reason BESIDE the still-live button.
 */
@Composable
private fun TicketStartControl(
    t: JiraTicket,
    sessions: List<TicketSession>,
    start: StartState?,
    queued: QueuedTicket?,
    onStart: () -> Unit,
    onCancelQueued: () -> Unit,
) {
    when (val c = ticketStartControl(t, sessions.size, start, queued)) {
        null -> {}
        // Waiting in the hub's queue: no host chosen and no session created, so
        // the only control that applies is taking it back out of the line.
        is StartControl.Queued -> {
            c.error?.let {
                Text(
                    "⚠ $it",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Text(
                when {
                    c.expired -> "⌛ gave up waiting"
                    c.blocked -> "⏳ queued · blocked"
                    c.position > 1 -> "⏳ queued · #${c.position}"
                    else -> "⏳ queued"
                },
                style = MaterialTheme.typography.labelMedium,
                color = if (c.blocked) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            c.reason?.takeIf { it.isNotBlank() }?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                    maxLines = 2,
                )
            }
            GhostButton("✕", onClick = onCancelQueued)
            // "It gave up" is only useful next to the way to ask again.
            if (c.expired) GhostButton("☐ Start session", onClick = onStart)
        }
        is StartControl.Busy -> Text(
            "⏳ starting…",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        is StartControl.Button -> {
            c.error?.let {
                Text(
                    "⚠ $it",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            GhostButton(
                when {
                    c.more -> "+"
                    c.clone -> "☐ Start (clone first)"
                    else -> "☐ Start session"
                },
                onClick = onStart,
            )
        }
    }
}

/** The repo the agent triaged the ticket to — plain (cloned), dashed (clonable), or muted "no repo". */
@Composable
private fun RepoChip(t: JiraTicket) {
    val g = t.repoGuess ?: return
    when {
        g.repo == null -> Text("no repo", style = MaterialTheme.typography.labelMedium, fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else -> Pill(g.repo!!, dashed = !g.cloned, mono = true)
    }
}

/**
 * A detail-sheet field's current value rendered AS the control that changes it:
 * a pill-shaped chip with a trailing ▾ that opens the field's dropdown on tap,
 * instead of a value plus a separate "Change" button. Used by the Status, Repo,
 * Agent and Model rows. When [enabled] is false it's a plain read-only pill (no
 * ▾, not clickable) — a field with nothing to pick. This is a mobile-native
 * interaction the web board doesn't share; see android/PARITY.md.
 */
@Composable
private fun SelectableValue(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    mono: Boolean = false,
    dashed: Boolean = false,
    italic: Boolean = false,
) {
    val fg = if (enabled) MaterialTheme.colorScheme.onSurface
             else MaterialTheme.colorScheme.onSurfaceVariant
    val border = if (dashed) fg.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outline
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(7.dp))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(1.dp, border, RoundedCornerShape(7.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(
            text,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
            fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
            color = fg,
        )
        if (enabled) {
            Text("▾", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary)
        }
    }
}

/**
 * The Repo row of the detail sheet: the triaged repo + its rationale, a
 * "Start session" action when it's cloned, and the repo value itself as the
 * pin-by-hand picker. Mirrors board.js repoFieldHtml + ticketStartHtml +
 * repoPickerHtml (the tap-the-value interaction is Android-only; see PARITY.md).
 */
@Composable
private fun RepoSection(site: BoardSite, t: JiraTicket, vm: BoardViewModel) {
    val g = t.repoGuess
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Repo")
        // The value IS the picker: tapping it opens the pin-by-hand dropdown.
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            RepoPicker(site, t) { repo, auto -> vm.setRepo(site.siteKey, t.key, repo, auto) }
            if (g?.repo != null && !g.cloned) Text("(not cloned)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (g?.manual == true) Text("— set by you", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (g?.repo != null && g.reason.isNotBlank() && !g.manual) {
            Text(g.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // Start is offered on any triaged repo — an uncloned one is a live start
        // too: the hub routes to the most-available host, which clones on demand
        // and queues the session behind the clone (XERK-14).
        if (g?.repo != null) {
            GhostButton(
                if (g.cloned) "▶ Start session" else "▶ Start (clone first)",
                onClick = { vm.startSession(site.siteKey, t.key) },
            )
        }
    }
}

/** The repo value rendered as the picker (a pick IS the save). */
@Composable
private fun RepoPicker(site: BoardSite, t: JiraTicket, onPick: (repo: String?, auto: Boolean) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val g = t.repoGuess
    // The chip label is the current answer: a pinned/guessed repo name, or the
    // state when there's no repo (matching the web row's phrasing).
    val label = when {
        g == null -> "Not triaged yet"
        g.repo == null -> if (g.manual) "No repository fits" else "No repository fits this ticket"
        else -> g.repo!!
    }
    Box {
        SelectableValue(
            label, onClick = { open = true },
            mono = g?.repo != null, dashed = g?.repo != null && !g.cloned,
            italic = g?.repo == null,
        )
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("Let the agent decide") },
                onClick = { open = false; onPick(null, true) },
            )
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("No repository fits") },
                onClick = { open = false; onPick(null, false) },
            )
            for (o in site.repoOptions.filter { it.name.isNotBlank() }) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(o.name + if (!o.cloned) "  (not cloned)" else "", fontFamily = FontFamily.Monospace) },
                    onClick = { open = false; onPick(o.name, false) },
                )
            }
        }
    }
}

/**
 * The Agent row of the detail sheet (XERK-38): which HOST this ticket's
 * sessions spawn on — the operator's rare multi-agent-org override of the
 * hub's most-available routing. Mirrors board.js agentFieldHtml +
 * agentPickerHtml: auto is the stated default, a pin says "set by you", and a
 * pinned host that's offline or gone is said rather than hidden (the hub
 * refuses to reroute around a dead pin).
 */
@Composable
private fun AgentSection(
    site: BoardSite,
    t: JiraTicket,
    pin: com.xerktech.turma.model.TicketAgentPin?,
    vm: BoardViewModel,
) {
    val opt = pin?.let { p -> site.hostOptions.find { it.key == p.host } }
    // Nothing to pick and nothing to release -> read-only (matches the web row).
    val editable = site.hostOptions.isNotEmpty() || pin != null
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Agent")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            // The value IS the picker.
            AgentPicker(site, pin, enabled = editable) { host -> vm.setTicketAgent(site.siteKey, t.key, host) }
            if (pin != null) {
                val note = when {
                    opt == null -> "(no longer reports this org)"
                    !opt.online -> "(offline)"
                    else -> null
                }
                if (note != null) Text(note, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("— set by you", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * The Model row of the detail sheet (XERK-123): which MODEL this ticket's session
 * runs — the operator's override of the login's default. Mirrors board.js
 * modelFieldHtml + modelPickerHtml: Default is the stated default (naming what it
 * resolves to when probed), a pin says "set by you".
 */
@Composable
private fun ModelSection(
    site: BoardSite,
    t: JiraTicket,
    pin: com.xerktech.turma.model.TicketModelPin?,
    vm: BoardViewModel,
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Model")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            // The value IS the picker; it's always offerable (static family
            // aliases), matching the web row's always-editable Model field.
            ModelPicker(site, pin) { model -> vm.setTicketModel(site.siteKey, t.key, model) }
            if (pin != null) {
                Text("— set by you", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** The model value rendered as the picker; a pick IS the save, null = default. */
@Composable
private fun ModelPicker(site: BoardSite, pin: com.xerktech.turma.model.TicketModelPin?, onPick: (model: String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    // A pinned alias off the probed list is carried back so it can stay current,
    // the same orphan handling the web picker does.
    val choices = com.xerktech.turma.core.modelChoices(site.models).toMutableList()
    pin?.model?.takeIf { it.isNotBlank() && it !in choices }?.let { choices.add(0, it) }
    val current = pin?.let { com.xerktech.turma.core.prettyModel(it.model) }
        ?: ("Default" + (site.models.defaultLabel.takeIf { it.isNotBlank() }
            ?.let { " (${com.xerktech.turma.core.prettyModel(it)})" } ?: ""))
    Box {
        SelectableValue(current, onClick = { open = true }, mono = pin != null)
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val def = site.models.defaultLabel.takeIf { it.isNotBlank() }
                ?.let { " (${com.xerktech.turma.core.prettyModel(it)})" } ?: ""
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("Default$def") },
                onClick = { open = false; onPick(null) },
            )
            for (m in choices) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(com.xerktech.turma.core.prettyModel(m)) },
                    onClick = { open = false; onPick(m) },
                )
            }
        }
    }
}

/** The agent value rendered as the picker; a pick IS the save, null = auto. */
@Composable
private fun AgentPicker(
    site: BoardSite,
    pin: com.xerktech.turma.model.TicketAgentPin?,
    enabled: Boolean = true,
    onPick: (host: String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val current = pin?.let { p -> site.hostOptions.find { it.key == p.host }?.name ?: p.host }
        ?: "Auto — most available agent"
    Box {
        SelectableValue(current, onClick = { open = true }, enabled = enabled, mono = pin != null)
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("Auto — most available agent") },
                onClick = { open = false; onPick(null) },
            )
            for (h in site.hostOptions) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(h.name + if (!h.online) "  (offline)" else "", fontFamily = FontFamily.Monospace) },
                    onClick = { open = false; onPick(h.key) },
                )
            }
        }
    }
}

/**
 * The Status row of the detail sheet (XERK-138): the one board field that writes
 * back to Jira/Azure. Mirrors board.js statusFieldHtml + statusPickerHtml — the
 * current status, plus a picker of the changes the board offers (the fetched
 * detail's statusOptions) once an ONLINE host can deliver the write. While a
 * change is in flight the pill shows the optimistic target; on success the sheet
 * re-fetches (the new status brings new options), on failure the reason shows.
 */
@Composable
private fun StatusSection(
    site: BoardSite,
    t: JiraTicket,
    detail: com.xerktech.turma.model.JiraIssueDetail?,
    vm: BoardViewModel,
    onDetailChange: (com.xerktech.turma.model.JiraIssueDetail) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var pending by remember(t.key) { mutableStateOf<String?>(null) }
    var error by remember(t.key) { mutableStateOf<String?>(null) }
    val options = detail?.statusOptions ?: emptyList()
    val editable = com.xerktech.turma.core.statusChangeable(site.online, options)
    val current = (detail?.status?.takeIf { it.isNotBlank() }) ?: t.status
    val onPick: (com.xerktech.turma.model.StatusOption) -> Unit = { opt ->
        error = null
        pending = opt.name
        scope.launch {
            val err = vm.saveStatus(site.siteKey, t.key, opt.id)
            if (err != null) {
                error = err
                pending = null
            } else {
                onDetailChange(vm.fetchIssue(site.siteKey, t.key))
                pending = null
            }
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SectionLabel("Status")
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            when {
                // Mid-change: the optimistic target as a plain (non-tappable) pill.
                pending != null -> {
                    Pill(pending!!)
                    Text("— saving…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                // Editable: the status value IS the picker.
                editable -> StatusPicker(options, current, onPick)
                // Nothing to change to (older agent / offline): read-only pill.
                else -> Pill(current)
            }
        }
        if (error != null) {
            Text("Couldn't save — $error", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

/** The status value rendered as the picker; a pick IS the save. */
@Composable
private fun StatusPicker(
    options: List<com.xerktech.turma.model.StatusOption>,
    current: String,
    onPick: (com.xerktech.turma.model.StatusOption) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        SelectableValue(current.ifBlank { "Set status" }, onClick = { open = true })
        androidx.compose.material3.DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text(if (current.isNotBlank()) "$current (current)" else "Keep current") },
                onClick = { open = false },
            )
            for (o in options) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text(o.name) },
                    onClick = { open = false; onPick(o) },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TicketDetailSheet(
    site: BoardSite,
    t: JiraTicket,
    pin: com.xerktech.turma.model.TicketAgentPin?,
    modelPin: com.xerktech.turma.model.TicketModelPin?,
    vm: BoardViewModel,
    onDismiss: () -> Unit,
) {
    val siteKey = site.siteKey
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    // Held in mutable state (not produceState) so a status change (XERK-138) can
    // replace it with the re-fetched issue — the new status brings new options.
    var detail by remember(siteKey, t.key) { mutableStateOf<com.xerktech.turma.model.JiraIssueDetail?>(null) }
    LaunchedEffect(siteKey, t.key) { detail = vm.fetchIssue(siteKey, t.key) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp, 0.dp, 20.dp, 32.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(t.key, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Pill(t.status)
                if (t.priority.isNotBlank()) Pill(t.priority)
            }
            Text(t.summary, style = MaterialTheme.typography.titleMedium)
            StatusSection(site, t, detail, vm, onDetailChange = { detail = it })
            RepoSection(site, t, vm)
            AgentSection(site, t, pin, vm)
            ModelSection(site, t, modelPin, vm)
            val d = detail
            if (d == null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Text("Loading details…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            } else if (!d.error.isNullOrBlank()) {
                Text(
                    "Couldn't load details: ${d.error}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            } else {
                if (d.description.isNotBlank()) {
                    SectionLabel("Description")
                    Text(d.description, style = MaterialTheme.typography.bodyMedium)
                }
                if (d.comments.isNotEmpty()) {
                    SectionLabel("Comments (${d.commentTotal.takeIf { it > 0 } ?: d.comments.size})")
                    for (c in d.comments) {
                        Column(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Text(c.author, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                            Text(c.body, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/**
 * The New-ticket form (XERK-137) — the board's one write path, source-agnostic
 * across Jira and Azure DevOps. A port of board.html's create modal: an
 * org/project/type cascade (project + type metadata fetched on demand, the same
 * 202-poll as the detail sheet), a title/description/labels form worded per
 * source, then a submit that POSTs and polls the outcome. All state is local to
 * the sheet, like the web modal.
 *
 * Dismissal is guarded (XERK-218): while the form holds typed, un-created text,
 * a swipe-down / back press / scrim tap / Cancel raises a "Discard this
 * ticket?" dialog instead of silently dropping the draft.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreateTicketSheet(
    sites: List<BoardSite>,
    initialSiteKey: String,
    vm: BoardViewModel,
    onDismiss: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current

    var siteKey by remember { mutableStateOf(initialSiteKey) }
    val site = sites.firstOrNull { it.siteKey == siteKey } ?: sites.first()
    val source = site.source

    var meta by remember { mutableStateOf<CreateMetaFetch?>(null) }   // null = loading
    var project by remember { mutableStateOf("") }
    var types by remember { mutableStateOf<CreateMetaFetch?>(null) }  // null = none loaded
    var issueType by remember { mutableStateOf("") }
    var summary by remember { mutableStateOf("") }
    var description by remember { mutableStateOf("") }
    var labels by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var created by remember { mutableStateOf<CreateResultFetch.Created?>(null) }
    var confirmDiscard by remember { mutableStateOf(false) }

    // An accidental swipe-down — or back press, scrim tap, Cancel — on a form
    // holding typed text must not throw it away (XERK-218): every dismissal is
    // gated on createDirty and raises a "Discard this ticket?" dialog instead.
    // The delegated vars read through their remembered MutableStates, so these
    // lambdas always see the current text.
    fun dirty() = createDirty(summary, description, labels, created != null)
    val sheet = rememberModalBottomSheetState(
        skipPartiallyExpanded = true,
        // Vetoes a dirty swipe-down before it settles hidden; the sheet springs
        // back up under the dialog.
        confirmValueChange = { target ->
            if (target == SheetValue.Hidden && dirty()) { confirmDiscard = true; false } else true
        },
    )
    // The dismiss paths that arrive as a plain request (back press, scrim tap,
    // the Cancel button) go through the same gate.
    val requestDismiss = { if (dirty()) { confirmDiscard = true } else onDismiss() }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text("Discard this ticket?") },
            text = { Text("It hasn't been created yet — closing now loses what you've typed.") },
            confirmButton = {
                TextButton(onClick = { confirmDiscard = false; onDismiss() }) {
                    Text("Discard", color = TurmaColors.critical)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDiscard = false }) { Text("Keep editing") }
            },
        )
    }

    // Projects (+ labels) reload when the org changes; a lone project auto-selects.
    LaunchedEffect(siteKey) {
        meta = null; project = ""; issueType = ""; types = null; error = ""
        val m = vm.fetchCreateMeta(siteKey, null)
        meta = m
        (m as? CreateMetaFetch.Projects)?.projects?.singleOrNull()?.let { project = it.key }
    }
    // Types reload when the project changes; a lone type auto-selects.
    LaunchedEffect(siteKey, project) {
        if (project.isBlank()) { types = null; return@LaunchedEffect }
        issueType = ""; types = null
        val ty = vm.fetchCreateMeta(siteKey, project)
        types = ty
        (ty as? CreateMetaFetch.Types)?.types?.singleOrNull()?.let { issueType = it.id }
    }

    ModalBottomSheet(onDismissRequest = requestDismiss, sheetState = sheet) {
        val done = created
        if (done != null) {
            Column(
                Modifier.fillMaxWidth().padding(20.dp, 0.dp, 20.dp, 32.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Ticket created", style = MaterialTheme.typography.titleMedium)
                Text(
                    if (done.warning.isNotBlank()) "Created ${done.key}. \u26a0 ${done.warning}."
                    else "Created ${done.key}. It'll appear on the board on the next poll.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (done.warning.isNotBlank()) TurmaColors.warning
                            else Color.Unspecified,
                )
                if (done.url.isNotBlank()) {
                    GhostButton("Open ${done.key} ↗", onClick = { uriHandler.openUri(done.url) })
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { created = null; summary = ""; description = ""; labels = "" }) {
                        Text("Create another")
                    }
                    Spacer(Modifier.weight(1f))
                    PrimaryButton("Done", onClick = onDismiss)
                }
            }
            return@ModalBottomSheet
        }
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp, 0.dp, 20.dp, 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("New ticket", style = MaterialTheme.typography.titleMedium)

            if (sites.size > 1) {
                CreatePicker(
                    "Org",
                    sites.map { it.siteKey to (orgName(it.siteKey, it.orgName) + if (!it.online) " (offline)" else "") },
                    siteKey,
                ) { siteKey = it }
            }

            when (val m = meta) {
                null -> LoadingRow("Loading projects…")
                is CreateMetaFetch.Error -> ErrorRow("Couldn't load projects: ${m.message}")
                is CreateMetaFetch.Projects ->
                    if (m.projects.isEmpty()) DimRow("No projects you can create in for this org.")
                    else CreatePicker(
                        "Project",
                        m.projects.map { it.key to if (it.name.isNotBlank() && it.name != it.key) "${it.name} (${it.key})" else it.key },
                        project,
                    ) { project = it }
                else -> {}
            }

            if (project.isNotBlank()) {
                when (val ty = types) {
                    null -> LoadingRow("Loading types…")
                    is CreateMetaFetch.Error -> ErrorRow("Couldn't load types: ${ty.message}")
                    is CreateMetaFetch.Types ->
                        if (ty.types.isEmpty()) DimRow("No issue types reported for this project.")
                        else CreatePicker(
                            "Type",
                            ty.types.map { it.id to it.name.ifBlank { it.id } },
                            issueType,
                        ) { issueType = it }
                    else -> {}
                }
            }

            OutlinedTextField(
                summary, { summary = it },
                label = { Text("Title") }, singleLine = true,
                keyboardOptions = SentenceCapsKeyboard,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                description, { description = it },
                label = { Text("Description (optional)") }, minLines = 3, maxLines = 8,
                keyboardOptions = SentenceCapsKeyboard,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                labels, { labels = it },
                label = { Text("${createLabelWord(source, true)}s — comma-separated (optional)") },
                keyboardOptions = SentenceCapsKeyboard,
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )

            if (error.isNotBlank()) ErrorRow("Couldn't create: $error")

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = requestDismiss, enabled = !busy) { Text("Cancel") }
                Spacer(Modifier.weight(1f))
                val canSubmit = project.isNotBlank() && issueType.isNotBlank() && summary.isNotBlank() && !busy
                PrimaryButton(
                    if (busy) "Creating…" else "Create ticket",
                    enabled = canSubmit,
                    onClick = {
                        busy = true; error = ""
                        scope.launch {
                            val req = CreateTicketRequest(
                                project = project, issueType = issueType,
                                summary = summary.trim(), description = description,
                                labels = splitLabels(labels, source),
                            )
                            when (val out = vm.submitCreate(siteKey, req)) {
                                is CreateResultFetch.Created -> created = out
                                is CreateResultFetch.Error -> error = out.message
                                CreateResultFetch.Pending -> error = "the create didn't complete in time"
                            }
                            busy = false
                        }
                    },
                )
            }
        }
    }
}

/** One dropdown row of (value, display-label) pairs; a pick calls [onSelect]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CreatePicker(
    label: String,
    options: List<Pair<String, String>>,
    selectedValue: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selectedLabel = options.firstOrNull { it.first == selectedValue }?.second ?: ""
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selectedLabel,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            for ((value, text) in options) {
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); expanded = false })
            }
        }
    }
}

@Composable
private fun LoadingRow(text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ErrorRow(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
}

@Composable
private fun DimRow(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
