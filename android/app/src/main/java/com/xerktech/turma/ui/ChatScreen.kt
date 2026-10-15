package com.xerktech.turma.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.unit.Dp
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Constraints
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.Analytics
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.AttachStatus
import com.xerktech.turma.core.Attachment
import com.xerktech.turma.core.ChatItem
import com.xerktech.turma.core.Uploads
import com.xerktech.turma.core.TextSize
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.buildItems
import com.xerktech.turma.core.liveMarker
import com.xerktech.turma.core.sessionHeaderMeta
import com.xerktech.turma.core.sessionName
import com.xerktech.turma.model.TailEntry
import com.xerktech.turma.vm.ChatViewModel
import com.xerktech.turma.vm.MicState

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChatScreen(
    host: String,
    sessionId: String,
    onBack: () -> Unit,
    onTerminal: () -> Unit,
    // A dsh session is HEADLESS (no ttyd), so its header shows a Trajectory
    // action instead of Terminal (XERK-498), carrying the session's transcript
    // id — what `/api/dsh/<tid>/trajectory` reads. Default no-op keeps previews
    // and any caller that only wants the terminal happy.
    onTrajectory: (transcriptId: String) -> Unit = {},
    showBack: Boolean = true,
    onOpenSubagent: (String, String) -> Unit = { _, _ -> },
) {
    val context = LocalContext.current
    val app = context.applicationContext as TurmaApplication
    // Key the VM per (host, session): when the two-pane detail swaps to a
    // different session this yields a fresh ChatViewModel rather than reusing the
    // previous session's store entry.
    val vm: ChatViewModel = viewModel(
        key = "chat:$host:$sessionId",
        factory = ChatViewModel.factory(app, host, sessionId),
    )
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) { vm.onEnter() }
    LaunchedEffect(Unit) { vm.messages.collect { snackbar.showSnackbar(it) } }
    // Stop this session's live tail/dictation the moment its chat leaves the
    // composition (detail pane swapped, or navigated away) — the keyed VM object
    // may linger in the store, but its sockets must not.
    DisposableEffect(host, sessionId) { onDispose { vm.onLeave() } }

    val displayEntries = remember(state.entries, state.liveTurn) {
        if (state.liveTurn.isNotBlank())
            state.entries + TailEntry(id = ChatViewModel.LIVE_TURN_ID, role = "assistant", text = state.liveTurn)
        else state.entries
    }
    val items = remember(displayEntries, state.verbosity) {
        buildItems(displayEntries, state.prefs)
    }

    val listState = rememberLazyListState()
    // Stick-to-bottom (web chat.js `stickBottom` + the #chatJump pill): the
    // transcript follows the tail only while the reader is AT the tail —
    // scrolling up unpins, so a growing live turn stops yanking the view back
    // down, and the "Jump to latest" pill below re-pins. Re-pinned the moment
    // the reader returns to the bottom, like the web's scroll listener.
    var stickBottom by remember { mutableStateOf(true) }
    // Plain ref, not state: marks OUR programmatic scroll so the observer below
    // doesn't read the auto-scroll itself as the reader scrolling away.
    val autoScrolling = remember { arrayOf(false) }
    LaunchedEffect(listState) {
        androidx.compose.runtime.snapshotFlow {
            listState.isScrollInProgress to listState.canScrollForward
        }.collect { (scrolling, canFwd) ->
            if (!autoScrolling[0] && (scrolling || !canFwd)) stickBottom = !canFwd
        }
    }
    // Keyed on `items` (not just its size) so a growing live turn keeps the tail
    // in view too, exactly as the web pins on every repaint.
    LaunchedEffect(items) {
        if (stickBottom && items.isNotEmpty()) {
            autoScrolling[0] = true
            try { listState.scrollToItem(items.size - 1) } finally { autoScrolling[0] = false }
        }
    }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    // The top bar's and the compose footer's MEASURED heights, for the waiting
    // sheets' cap ([waitingSheetCap]) — both grow with the font scale.
    val density = androidx.compose.ui.platform.LocalDensity.current
    var topBarPx by remember { mutableIntStateOf(0) }
    var footerPx by remember { mutableIntStateOf(0) }

    // Lift the whole screen above the soft keyboard (XERK-76): the app is
    // edge-to-edge, so without this the IME simply overlays the compose box
    // and you can't see what you're typing. imePadding consumes the inset,
    // so the bottomBar (footer + question sheet) lands right on the keyboard.
    // The navigation bar likewise: on the full-screen phone route nothing else
    // reserves it, and the gesture handle drew over the compose box. (In the
    // two-pane layout MainScaffold has already consumed it, so this pads 0 there.)
    BoxWithConstraints(Modifier.navigationBarsPadding()) {
    // The chat's height WITHOUT the keyboard: whether this is a short window is a
    // property of the window, not of the room the keyboard leaves — measured inside
    // imePadding, a tablet's keyboard read as a landscape phone (rollup XERK-1701).
    val windowHeight = maxHeight
    BoxWithConstraints(Modifier.imePadding()) {
    val imeUp = WindowInsets.isImeVisible
    val fit = chatHeaderFit(windowHeight, imeUp)
    // Typing in a short window: the compose box outranks everything else (#66).
    val compact = fit.shortWindow && imeUp
    // The header's two lines must FIT its bar (rollup XERK-1701 #64.1): a fixed 64dp
    // bar clipped the host · repo · tunnel line at a large font scale and let it spill
    // in landscape. So a short window takes the smaller title style, the bar grows to
    // the lines' real height at this font scale, and with the keyboard up in a short
    // window the meta line folds away so the composer keeps the room (#66).
    val sheetUp = state.question.isNotBlank() || state.panePrompt != null
    // A question / permission pending in a short window comes first, keyboard up or down:
    // the header keeps only the title (plus the tunnel warning, alone, when the tunnel is
    // down), the chip row yields, and the sheet gets a floor — else a landscape two-pane
    // chat at a large font left the sheet 0dp (rollup XERK-1701).
    val sheetFirst = sheetUp && fit.shortWindow
    val showMeta = state.session != null && fit.showMeta && (!sheetFirst || !state.tunnelOnline)
    val titleStyle = if (fit.shortWindow) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleLarge
    val metaStyle = MaterialTheme.typography.bodySmall
    // The meta line takes a second line for the tunnel marker when one line can't hold
    // both (set by the title slot, which is where the width is known).
    var metaLines by remember { mutableIntStateOf(1) }
    // Each line's RENDERED height at this font scale, measured: the style's lineHeight
    // undershoots the drawn line at a large (non-linear) font scale.
    val lineMeasurer = rememberTextMeasurer()
    val barHeight = with(density) {
        val titleLine = lineMeasurer.measure("Ag", titleStyle, maxLines = 1).size.height.toDp()
        val metaLine = lineMeasurer.measure("Ag", metaStyle.copy(fontFamily = FontFamily.Monospace), maxLines = 1).size.height.toDp()
        chatTopBarHeight(titleLine, if (showMeta) metaLine * metaLines else 0.dp)
    }
    // The compose box's own row, measured: the one thing that must stay whole.
    var inputRowPx by remember { mutableIntStateOf(0) }
    // The status-bar strip the bar pads itself by, MEASURED where the bar sits: the raw
    // inset over-counts in the two-pane layout, whose scaffold has already consumed it.
    var statusStripPx by remember { mutableIntStateOf(0) }
    Box(
        // Measured OUTSIDE the padding, so the size is the padding itself.
        Modifier.onSizeChanged { statusStripPx = it.height }
            .windowInsetsPadding(TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top)),
    )
    val statusBarTop = with(density) { statusStripPx.toDp() }
    // Typing in a short window, the top bar steps aside (until the keyboard goes) when
    // there is no room for both it and the compose box (a landscape phone at a large font
    // scale) — rather than cover the box being typed into — and while a question or
    // permission sheet is pending, so the sheet shows above the box instead of only
    // being reachable by scrolling an off-screen footer.
    val showBar = !compact || (!sheetUp &&
        chatBarFits(maxHeight, statusBarTop + barHeight, with(density) { inputRowPx.toDp() } + CHAT_FOOTER_COMPACT_PAD))
    // The footer never grows past the room under the top bar: taller (landscape with
    // the keyboard up, or a large font scale) it scrolls, pinned to its BOTTOM so the
    // compose box stays in view and the chips scroll away, instead of drawing over
    // the top bar (rollup XERK-1701 #66).
    val footerMax = with(density) { (maxHeight - topBarPx.toDp()).coerceAtLeast(0.dp) }
    // A question / permission sheet never collapses to nothing in a short window: it may
    // take ALL the room above the compose footer (the chip row gives way to it). Never
    // more: a sheet as tall as the whole footer overflowed it by the compose row, and,
    // pinned to the bottom, that overflow hid the question's own first lines under the bar.
    // Typing on a short phone can leave next to no room above the box at all: then the
    // sheet takes the whole footer and is reached by scrolling it, never squeezed to 0.
    val sheetMax = with(density) {
        val aboveBox = (footerMax - footerPx.toDp()).coerceAtLeast(0.dp)
        val floor = if (aboveBox >= CHAT_SHEET_MIN) aboveBox else footerMax
        waitingSheetCap(maxHeight, topBarPx.toDp(), footerPx.toDp()).let { if (sheetFirst) maxOf(it, floor) else it }
    }
    val footerScroll = rememberScrollState()
    Scaffold(
        topBar = {
            if (!showBar) {
                // Just the status-bar strip (the bar's own inset), measured like the bar.
                Box(
                    Modifier.fillMaxWidth()
                        .onSizeChanged { topBarPx = it.height }
                        .testTag(CHAT_TOP_BAR_TAG)
                        .windowInsetsPadding(TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top)),
                )
            } else TopAppBar(
                modifier = Modifier.onSizeChanged { topBarPx = it.height }.testTag(CHAT_TOP_BAR_TAG),
                expandedHeight = barHeight,
                title = {
                    Column {
                        Text(state.session?.let { sessionName(it) } ?: "Session", maxLines = 1,
                            overflow = TextOverflow.Ellipsis, style = titleStyle,
                            modifier = Modifier.testTag(CHAT_TITLE_TAG))
                        state.session?.takeIf { showMeta }?.let {
                            // Host · repo · branch (XERK-121), then whether
                            // anything is reaching us (core `liveMarker`, the
                            // web's tunnel chip). The marker is its OWN Text and
                            // the meta line is what gives way: appended to that
                            // ellipsized line, a warning nobody can read is
                            // worse than a truncated branch name. When one line
                            // can't hold the whole marker beside a readable meta
                            // ([chatMetaOneLine]), the marker takes its own line.
                            val hostLabel = state.hostLabel.ifBlank { host }
                            val mark = liveMarker(state.tunnelOnline, state.connected)
                            val markColor = if (state.tunnelOnline) Color.Unspecified else MaterialTheme.colorScheme.error
                            val meta = sessionHeaderMeta(hostLabel, it)
                            BoxWithConstraints {
                                val measurer = rememberTextMeasurer()
                                val mono = metaStyle.copy(fontFamily = FontFamily.Monospace)
                                if (sheetFirst) {
                                    // Only the warning (showMeta is false otherwise), on as few lines as fit.
                                    val lines = measurer.measure(
                                        mark, mono, maxLines = 2, constraints = Constraints(maxWidth = constraints.maxWidth),
                                    ).lineCount
                                    SideEffect { metaLines = lines }
                                    Text(
                                        mark, style = mono, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                        color = markColor, modifier = Modifier.testTag(CHAT_MARKER_TAG),
                                    )
                                    return@BoxWithConstraints
                                }
                                val oneLine = mark.isEmpty() || chatMetaOneLine(
                                    metaWidth = measurer.measure(meta, mono, maxLines = 1).size.width,
                                    markWidth = measurer.measure(" · $mark", mono, maxLines = 1).size.width,
                                    available = constraints.maxWidth,
                                )
                                // On its own line the marker wraps at a word (two lines at most)
                                // rather than lose its end: "⚠ tunnel" / "offline" at a large font.
                                val markLines = if (oneLine) 0 else measurer.measure(
                                    mark, mono, maxLines = 2, constraints = Constraints(maxWidth = constraints.maxWidth),
                                ).lineCount
                                SideEffect { metaLines = 1 + markLines }
                                if (oneLine) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(
                                            meta, style = mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.weight(1f, fill = false).testTag(CHAT_META_TAG),
                                        )
                                        if (mark.isNotEmpty()) {
                                            Text(
                                                " · $mark", style = mono, maxLines = 1, color = markColor,
                                                modifier = Modifier.testTag(CHAT_MARKER_TAG),
                                            )
                                        }
                                    }
                                } else {
                                    Column {
                                        Text(
                                            meta, style = mono, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.testTag(CHAT_META_TAG),
                                        )
                                        // Ellipsized only when even two lines of its own are too narrow.
                                        Text(
                                            mark, style = mono, maxLines = 2, overflow = TextOverflow.Ellipsis,
                                            color = markColor, modifier = Modifier.testTag(CHAT_MARKER_TAG),
                                        )
                                    }
                                }
                            }
                        }
                    }
                },
                navigationIcon = {
                    if (showBack) {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                    }
                },
                actions = {
                    ChatSettingsMenu(state.verbosity) { vm.setVerbosity(it) }
                    // A dsh session has no ttyd terminal (XERK-498) — the web
                    // hides "Terminal ▸" and shows "Trajectory ▸" instead. Match
                    // it: route a dsh session to its read-only Trajectory rather
                    // than to an empty terminal. A claude session keeps Terminal.
                    val sess = state.session
                    if (com.xerktech.turma.core.Runtime.isDsh(sess?.agentType)) {
                        // A dsh session pins its id at launch (D3), so transcriptId
                        // is present in practice; guard anyway — navigating with an
                        // empty {tid} segment would not match the route.
                        IconButton(onClick = {
                            val tid = sess?.transcriptId.orEmpty()
                            if (tid.isNotBlank()) onTrajectory(tid)
                        }) {
                            Icon(Icons.Filled.Analytics, "Trajectory")
                        }
                    } else {
                        IconButton(onClick = onTerminal) { Icon(Icons.Filled.Terminal, "Terminal") }
                    }
                    // Kill the session you're in (web chatKill): arm/confirm, then
                    // leave the view — the card drops on the agent's next beat.
                    KillAction(onKill = { vm.kill(); onBack() })
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Column(
                Modifier.heightIn(max = footerMax)
                    .verticalScroll(footerScroll, reverseScrolling = true)
                    .testTag(CHAT_FOOTER_TAG),
            ) {
                // The live working-status bar (web chat.js updateLiveStatus): spinner
                // + gerund verb + ↑/↓ token counters + elapsed, Claude Code's rotating
                // tip / active-task hint lines, and the live agent-manager list. Shown
                // whenever a status frame is present (i.e. while generating) — the
                // agent list can be non-empty even when the live text is blank.
                //
                // It ALSO stays up with no status at all while background agents run
                // (XERK-245): delegating ends the session's own turn, so `status`
                // clears while the work continues, and the bar used to vanish exactly
                // when it was most needed. `main` is the conversation already on
                // screen, so a list carrying only it does not raise the bar.
                val bgAgents = state.liveAgents.any { it.type.isNotBlank() && it.type != "main" }
                val st = state.turnStatus
                when {
                    st != null -> LiveStatusBar(st, state.liveAgents, onOpenSubagent)
                    bgAgents -> BackgroundAgentsBar(state.liveAgents, onOpenSubagent)
                    else -> {}
                }
                if (state.question.isNotBlank()) {
                    val opts = state.questionOptionsRich.ifEmpty {
                        state.questionOptions.map { com.xerktech.turma.model.QuestionOption(label = it) }
                    }
                    QuestionSheet(
                        maxHeight = sheetMax,
                        question = state.question,
                        header = state.questionHeader,
                        index = state.questionIndex,
                        total = state.questionTotal,
                        options = opts,
                        multi = state.questionMulti,
                        onAnswerSingle = { vm.answerOption(it) },
                        onAnswerMulti = { vm.answerMulti(it) },
                    )
                }
                state.panePrompt?.let { p -> PanePromptSheet(p, sheetMax, onPick = vm::answerPanePrompt) }
                Box(Modifier.onSizeChanged { footerPx = it.height }) {
                ChatFooter(
                    compact = compact,
                    showChips = !sheetFirst,
                    inputRowModifier = Modifier.onSizeChanged { inputRowPx = it.height },
                    session = state.session,
                    draft = state.draft,
                    mic = state.mic,
                    attachments = state.attachments,
                    canAttach = state.canAttach,
                    // Working right now: prefer the live turn frames (fast), fall back
                    // to the heartbeat's paneBusy. Drives the separate ◼ Stop button —
                    // suppressed while a question is pending (the draft answers it).
                    busy = (state.liveTurn.isNotBlank() || state.session?.session?.paneBusy == true) &&
                        state.question.isBlank() && state.panePrompt == null,
                    onDraft = vm::setDraft,
                    onSend = vm::submitDraft,
                    onStop = vm::stop,
                    onMicStart = vm::startDictation,
                    onMicStop = vm::stopDictation,
                    onModel = vm::setModel,
                    onMode = vm::setMode,
                    localModel = state.localModel,
                    dsh = state.dsh,
                    modelSource = state.modelSource(),
                    canSwitchModelSource = state.canSwitchModelSource(),
                    onModelSource = vm::setModelSource,
                    onAttach = vm::attach,
                    onRemoveAttachment = vm::removeAttachment,
                )
                }
            }
        },
    ) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            // Wrap the transcript so its text is selectable + copyable, matching the
            // web chat, which relies on native browser selection to copy session text
            // (XERK-64). Long-press selects; tap still toggles tool/thinking cards.
            SelectionContainer(Modifier.fillMaxSize()) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(10.dp, 6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (state.hasMore) {
                        item { Text("· earlier history ·", Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
                    }
                    items(items.size) { i -> ChatItemView(items[i]) }
                }
            }
            // The "jump to latest" pill (web #chatJump): shown only while the
            // reader is scrolled up; tapping it snaps to the tail and re-pins.
            if (!stickBottom) {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = RoundedCornerShape(16.dp),
                    tonalElevation = 4.dp,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 10.dp)
                        .clip(RoundedCornerShape(16.dp))
                        .clickable {
                            stickBottom = true
                            scope.launch {
                                if (items.isNotEmpty()) listState.scrollToItem(items.size - 1)
                            }
                        },
                ) {
                    Text(
                        "↓ Jump to latest",
                        Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                    )
                }
            }
        }
    }
    }
    }
}

/**
 * The pinned live working-status bar — the Android port of the web chat's
 * `#chatStatus` (chat.js `updateLiveStatus` + `agentsHtml`). Mirrors the terminal's
 * bottom status region while a turn is generating:
 *  - a spinner + the gerund verb ("Cogitating…"), with elapsed + ↑/↓ token
 *    counters pushed to the right (all display strings scraped off the pane);
 *  - Claude Code's rotating tip / active-task footer as de-emphasized hint lines
 *    (an active-task checklist arrives newline-joined — one row per to-do item);
 *  - the live agent-manager list when expanded: "main" as a plain marker, each
 *    background subagent a tappable row that opens its transcript read-only.
 */
@Composable
private fun LiveStatusBar(
    status: com.xerktech.turma.model.TurnStatus,
    liveAgents: List<com.xerktech.turma.model.AgentRow>,
    onOpenSubagent: (String, String) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 7.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 2.dp)
                Text(
                    "${status.verb.ifBlank { "Working" }}…",
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodySmall,
                )
                // Elapsed + token counters, right-aligned and monospace (web .toks).
                Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f))
                    if (status.elapsed.isNotBlank()) TokChip(status.elapsed, MaterialTheme.colorScheme.onSurfaceVariant)
                    if (status.up.isNotBlank()) TokChip("↑ ${status.up}", MaterialTheme.colorScheme.primary)
                    if (status.down.isNotBlank()) TokChip("↓ ${status.down}", MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // One hint/tip row per line — each clipped to a single line (web .cc-hint)
            // so a long tip or a to-do checklist never crowds the composer.
            status.hint.split("\n").filter { it.isNotBlank() }.forEach { line ->
                Text(
                    line,
                    Modifier.padding(start = 21.dp).fillMaxWidth(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            // The frame's list wins; `status.agents` is the older-agent fallback.
            val rows = liveAgents.ifEmpty { status.agents }
            if (rows.isNotEmpty()) AgentsList(rows, onOpenSubagent)
        }
    }
}

/**
 * The same bar with no running turn behind it: the session delegated work and
 * ended its own turn, so there is no verb or token counter to show, but agents
 * are still going (XERK-245). Mirrors the web's "Background agents…" row.
 */
@Composable
private fun BackgroundAgentsBar(
    agents: List<com.xerktech.turma.model.AgentRow>,
    onOpenSubagent: (String, String) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 7.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 2.dp)
                Text(
                    // A background shell is not an agent, and a WAITING one is not
                    // work (XERK-1570) — web chat.js `backgroundBarVerb`.
                    backgroundBarVerb(agents) + "…",
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            AgentsList(agents, onOpenSubagent)
        }
    }
}

/** A shell kind that is a wait (XERK-1570); "" (absent) or "work" is work. */
internal fun isWaitKind(kind: String): Boolean = kind == "wait-timed" || kind == "wait-external"

/**
 * The background bar's verb — web chat.js `backgroundBarVerb`: "Waiting" when
 * every background row is a wait, else "Background tasks" / "Background agents".
 */
internal fun backgroundBarVerb(agents: List<com.xerktech.turma.model.AgentRow>): String {
    val bg = agents.filter { it.type.isNotBlank() && it.type != "main" }
    if (bg.isNotEmpty() && bg.all { isWaitKind(it.kind) }) return "Waiting"
    return "Background " + if (bg.any { it.type == "shell" }) "tasks" else "agents"
}

@Composable
private fun TokChip(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        fontFamily = FontFamily.Monospace,
        color = color,
        maxLines = 1,
    )
}

/**
 * The live agent list scraped from the pane (web `agentsHtml`). "main" (the parent
 * conversation, already on screen) is a plain marker; every other row is a button
 * that opens that background agent's transcript. `sel` marks the focused agent.
 */
@Composable
private fun AgentsList(
    agents: List<com.xerktech.turma.model.AgentRow>,
    onOpenSubagent: (String, String) -> Unit,
) {
    Column(Modifier.padding(start = 21.dp, top = 2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            "AGENTS",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        agents.forEach { a ->
            // A background shell has no transcript to open either (web agentsHtml).
            val isMain = (a.type == "main" && a.label.isBlank()) || a.type == "shell"
            val rowMod = Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(5.dp))
                .then(if (isMain) Modifier else Modifier.clickable { onOpenSubagent(a.type, a.label) })
                .padding(horizontal = 4.dp, vertical = 2.dp)
            Row(rowMod, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                // Filled accent dot for the focused agent (sel), hollow otherwise.
                Box(
                    Modifier.size(8.dp).clip(androidx.compose.foundation.shape.CircleShape)
                        .then(
                            if (a.sel) Modifier.background(MaterialTheme.colorScheme.primary)
                            else Modifier.border(1.5.dp, MaterialTheme.colorScheme.onSurfaceVariant, androidx.compose.foundation.shape.CircleShape),
                        ),
                )
                // A waiting shell says so in place of "shell" (web agentsHtml, XERK-1570).
                Text(
                    if (a.type == "shell" && isWaitKind(a.kind)) "waiting" else a.type,
                    fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium,
                )
                if (a.label.isNotBlank()) {
                    Text(
                        a.label,
                        Modifier.weight(1f),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** The least room a pending sheet may show in above the compose box before it falls back to scrolling. */
internal val CHAT_SHEET_MIN = 40.dp

@Composable
private fun QuestionSheet(
    maxHeight: androidx.compose.ui.unit.Dp,
    question: String,
    header: String,
    index: Int?,
    total: Int?,
    options: List<com.xerktech.turma.model.QuestionOption>,
    multi: Boolean,
    onAnswerSingle: (Int) -> Unit,
    onAnswerMulti: (List<Int>) -> Unit,
) {
    val picks = remember(question) { mutableStateListOf<Int>() }
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        modifier = Modifier.fillMaxWidth().testTag(WAITING_SHEET_TAG),
    ) {
        Column(
            Modifier.heightIn(max = maxHeight).verticalScroll(remember(question) { ScrollState(0) }).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (header.isNotBlank() || (total != null && total > 1)) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (header.isNotBlank()) Pill(header, color = MaterialTheme.colorScheme.primary)
                    if (total != null && total > 1) {
                        Text("${(index ?: 0) + 1} of $total", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            Text(question, fontWeight = FontWeight.Medium)
            options.forEachIndexed { i, opt ->
                val selected = picks.contains(i)
                QuestionOptionCard(opt, multi, selected) {
                    if (multi) { if (selected) picks.remove(i) else picks.add(i) } else onAnswerSingle(i)
                }
            }
            if (multi) {
                PrimaryButton("Submit selection", onClick = { onAnswerMulti(picks.toList()) }, enabled = picks.isNotEmpty())
            }
            Text("…or type a custom answer below.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * The tallest a question / permission sheet may grow before it scrolls. The
 * Scaffold's bottomBar is measured against the whole window, so a sheet taller
 * than what is left between the top bar and the compose footer draws OVER the
 * top bar (landscape, or a large font scale: Kill and Terminal untappable).
 * Both are MEASURED, since they grow with the font scale; [CHAT_SHEET_GAP] keeps
 * a strip of transcript visible. Never more than half the window. Typing in a
 * short window leaves nothing, so the chat raises the cap there to the footer's
 * own height: the footer scrolls, and the sheet stays reachable inside it.
 */
internal fun waitingSheetCap(window: Dp, topBar: Dp, footer: Dp): Dp =
    minOf(window / 2, window - topBar - footer - CHAT_SHEET_GAP).coerceAtLeast(0.dp)

internal val CHAT_SHEET_GAP = 24.dp

// Test handles for the header / footer / sheet bounds checks.
internal const val CHAT_TOP_BAR_TAG = "chatTopBar"
internal const val CHAT_FOOTER_TAG = "chatFooter"
internal const val WAITING_SHEET_TAG = "waitingSheet"
internal const val CHAT_TITLE_TAG = "chatTitle"
internal const val CHAT_META_TAG = "chatMeta"
internal const val CHAT_MARKER_TAG = "chatLiveMarker"

/** Below this the chat is a short window (a landscape phone): smaller title, and the
 *  meta line yields to the composer while the keyboard is up. */
internal val CHAT_SHORT_WINDOW = 480.dp

/** The compose footer's vertical padding while typing in a short window. */
internal val CHAT_FOOTER_COMPACT_PAD = 4.dp

/** How the chat header fits a window of [window] height (WITHOUT the keyboard). */
internal data class ChatHeaderFit(val shortWindow: Boolean, val showMeta: Boolean)

/**
 * A short window takes the smaller title; with the keyboard up there, the meta line
 * folds away. [window] is the chat's height without the keyboard: a tablet with its
 * keyboard up is still a tall window and keeps both header lines.
 */
internal fun chatHeaderFit(window: Dp, imeVisible: Boolean): ChatHeaderFit {
    val short = window < CHAT_SHORT_WINDOW
    return ChatHeaderFit(shortWindow = short, showMeta = !(short && imeVisible))
}

/** Whether a top bar of [bar] (status strip included) and the compose box's [input]
 *  both fit the [room] left above the keyboard. When not, the bar steps aside. */
internal fun chatBarFits(room: Dp, bar: Dp, input: Dp): Boolean = bar + input <= room

/**
 * Whether the header's meta line and its tunnel marker share one line: when the whole
 * line fits, or the marker (separator included) takes at most half the width, leaving
 * host · repo at least the other half to ellipsize in. Otherwise the marker takes its
 * own line, so it is never cut and host · repo never shrinks to nothing.
 */
internal fun chatMetaOneLine(metaWidth: Int, markWidth: Int, available: Int): Boolean =
    metaWidth + markWidth <= available || markWidth * 2 <= available

/**
 * The chat top bar's height for a title line and a meta line of these heights (0 when
 * the meta line is hidden): Material's 64dp, or taller when the lines at this font
 * scale need it — a fixed 64dp clipped the meta line at font scale 2.0.
 */
internal fun chatTopBarHeight(titleLine: Dp, metaLine: Dp): Dp =
    maxOf(64.dp, titleLine + metaLine + 16.dp)

/**
 * The TUI's blocking dialog — a tool-permission request or a plan approval —
 * in the same place as the question sheet (web chat.js panePromptHtml): the
 * dialog's question, the context it asks about, and one card per numbered
 * option, the TUI cursor's row outlined. Tapping a card answers by its number.
 */
@Composable
private fun PanePromptSheet(
    prompt: com.xerktech.turma.model.PanePrompt,
    maxHeight: androidx.compose.ui.unit.Dp,
    onPick: (Int) -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        modifier = Modifier.fillMaxWidth().testTag(WAITING_SHEET_TAG),
    ) {
        Column(
            Modifier.heightIn(max = maxHeight).verticalScroll(remember(prompt) { ScrollState(0) }).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // The pill shares the prompt's line: stacked, it alone filled a short window's
            // sheet and pushed the prompt itself out of view (rollup XERK-1701).
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Pill("waiting", color = MaterialTheme.colorScheme.primary)
                Text(prompt.prompt, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
            }
            if (prompt.detail.isNotBlank()) {
                Text(
                    prompt.detail,
                    Modifier.fillMaxWidth()
                        .heightIn(max = 180.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .verticalScroll(rememberScrollState())
                        .horizontalScroll(rememberScrollState())
                        .padding(8.dp),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
            prompt.options.forEach { opt ->
                QuestionOptionCard(
                    com.xerktech.turma.model.QuestionOption(label = "${opt.number}. ${opt.label}"),
                    multi = false, selected = opt.selected,
                ) { onPick(opt.number) }
            }
        }
    }
}

@Composable
private fun QuestionOptionCard(
    opt: com.xerktech.turma.model.QuestionOption,
    multi: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val border = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
    var previewOpen by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .border(1.dp, border, RoundedCornerShape(10.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onClick).padding(10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (multi) {
                Icon(
                    if (selected) Icons.Filled.CheckBox else Icons.Filled.CheckBoxOutlineBlank, null,
                    tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
            Column(Modifier.weight(1f)) {
                Text(opt.label, fontWeight = FontWeight.Medium, fontSize = 14.sp)
                if (opt.description.isNotBlank()) {
                    Text(opt.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        // The collapsible preview mockup the TUI shows (chat.js q-prev-wrap). A
        // separate tap target so opening the preview never answers the question.
        if (opt.preview.isNotBlank()) {
            Text(
                if (previewOpen) "Hide preview" else "Show preview",
                Modifier.clickable { previewOpen = !previewOpen }.padding(horizontal = 10.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary,
            )
            if (previewOpen) {
                Text(
                    opt.preview,
                    Modifier.fillMaxWidth()
                        .padding(horizontal = 10.dp)
                        .padding(bottom = 10.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .horizontalScroll(rememberScrollState())
                        .padding(8.dp),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ChatFooter(
    session: com.xerktech.turma.model.SessionInfo?,
    // Typing in a short window: tighter vertical padding, so the box fits (#66).
    compact: Boolean = false,
    // False while a question / permission sheet needs the room above the box.
    showChips: Boolean = true,
    inputRowModifier: Modifier = Modifier,
    draft: String,
    mic: MicState,
    busy: Boolean,
    attachments: List<Attachment>,
    canAttach: Boolean,
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicStart: () -> Unit,
    onMicStop: () -> Unit,
    onModel: (String) -> Unit,
    onMode: (String) -> Unit,
    localModel: com.xerktech.turma.model.LocalModelInfo?,
    dsh: com.xerktech.turma.model.DshInfo?,
    modelSource: String,
    canSwitchModelSource: Boolean,
    onModelSource: (String) -> Unit,
    onAttach: (List<android.net.Uri>) -> Unit,
    onRemoveAttachment: (String) -> Unit,
) {
    val context = LocalContext.current
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onMicStart()
    }
    // Any type: the ticket asks for images AND documents, and the agent writes
    // whatever arrives to disk for the session to read (XERK-234).
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris -> onAttach(uris) }
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = if (compact) CHAT_FOOTER_COMPACT_PAD else 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Model / mode / PR sit ABOVE the input box. Every PR the session opened
        // shows (newest first — the freshest link leads), matching the web footer
        // chip (chat.js prFooterChip); FlowRow wraps them on a narrow phone.
        if (showChips) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          // A dsh session runs a DIFFERENT runtime, not the Claude subscription/
          // local split (XERK-504): a read-only "⚙ dsh" runtime chip (a dsh
          // conversation can't switch to a Claude runtime live) + a live dropdown
          // of the host's DISCOVERED dsh models, and NO permission-mode chip (dsh
          // manages its own approvals).
          if (com.xerktech.turma.core.Runtime.isDsh(session?.agentType)) {
            if (com.xerktech.turma.core.Runtime.dshModelPickable(dsh)) {
                val dopts = com.xerktech.turma.core.Runtime.dshOptions(dsh)
                MenuChip(
                    label = "model: " + com.xerktech.turma.core.Runtime.dshModelLabel(session, dsh),
                    options = dopts.map { it.first },
                    onSelect = onModel,
                    optionLabel = { v -> dopts.firstOrNull { it.first == v }?.second ?: v },
                    accent = true,
                )
            } else {
                StaticChip(
                    "model: ${com.xerktech.turma.core.Runtime.currentDshModel(session, dsh).ifBlank { "dsh model" }}",
                    why = "This host's dsh model. Its model list has not been discovered yet.",
                )
            }
            // The runtime chip: read-only, matching the web footer's "⚙ dsh".
            StaticChip("⚙ dsh", why = "Runs on the dsh (DeepSeek Harness) runtime, not Claude Code")
            session?.prs?.asReversed()?.forEach { PrBadge(it) }
            return@FlowRow
          }
            // On the local model the Claude alias picker is useless — every alias
            // it offers is one that endpoint refuses. Instead a LOCAL session
            // picks from the endpoint's DISCOVERED models (XERK-489), a live
            // dropdown (each "id · 128k"); selecting one posts the id to /model,
            // which the agent applies with that model's served window. With no
            // discovered list yet (older agent / pre-discovery) it keeps the fixed
            // label (web: cc-model-fixed).
            if (com.xerktech.turma.core.ModelSource.modelPickable(modelSource)) {
                MenuChip("model: ${session?.model?.ifBlank { "default" } ?: "default"}", listOf("default", "opus", "sonnet", "haiku"), onModel)
            } else if (com.xerktech.turma.core.ModelSource.localModelPickable(localModel)) {
                val lopts = com.xerktech.turma.core.ModelSource.localOptions(localModel)
                MenuChip(
                    label = "model: " + com.xerktech.turma.core.ModelSource.localModelLabel(session, localModel),
                    options = lopts.map { it.first },
                    onSelect = onModel,
                    optionLabel = { v -> lopts.firstOrNull { it.first == v }?.second ?: v },
                    accent = true,
                )
            } else {
                // No discovered list yet — name the configured model (web: the
                // fixed cc-model label `cur || "local model"`), NOT the source
                // label, which now reads "Other".
                StaticChip(
                    "model: ${com.xerktech.turma.core.ModelSource.currentLocalModel(session, localModel).ifBlank { "local model" }}",
                    why = "This host's self-hosted model. Its model list has not been discovered yet.",
                )
            }
            // A repos-root session may never switch INTO bypassPermissions
            // (XERK-309, matching web `chat.js`): it runs directly in the repos
            // root with no worktree; the hub 409s the live switch either way.
            val modeChoices = listOf("auto", "acceptEdits", "plan", "bypassPermissions", "default")
                .filter { it != "bypassPermissions" || session?.root != true }
            MenuChip("mode: ${session?.permissionMode?.ifBlank { "auto" } ?: "auto"}", modeChoices, onMode)
            // "Run against" — the local-model failover (XERK-246). Hidden on a
            // host whose agent doesn't report one, exactly as the 📎 is hidden on
            // one that can't take files: the hub 409s the command either way.
            if (canSwitchModelSource) {
                val opts = com.xerktech.turma.core.ModelSource.options(localModel)
                MenuChip(
                    label = com.xerktech.turma.core.ModelSource.glyph(modelSource) + " run: " +
                        com.xerktech.turma.core.ModelSource.label(modelSource, localModel),
                    options = opts.map { it.first },
                    onSelect = onModelSource,
                    optionLabel = { v -> opts.firstOrNull { it.first == v }?.second ?: v },
                    // A local session is marked, and in the warn colour: it is a
                    // weaker model, and nobody should have to wonder which one
                    // wrote a turn.
                    accent = modelSource == com.xerktech.turma.core.ModelSource.LOCAL,
                )
            }
            session?.prs?.asReversed()?.forEach { PrBadge(it) }
        }
        // Context-fullness meter (XERK-489 Phase 4), below the chips and above the
        // box — the chat counterpart of the web compose footer's meter. Renders
        // nothing until a turn is measured.
        session?.let { ContextMeterBar(it, Modifier.fillMaxWidth()) }
        // Files staged for the next message, above the box so adding one doesn't
        // shove the text field around (web: the .compose-attach strip).
        if (attachments.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                attachments.forEach { a -> AttachmentChip(a, onRemoveAttachment) }
            }
        }
        Row(inputRowModifier, verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft, onValueChange = onDraft,
                placeholder = { Text("Message…") },
                keyboardOptions = SentenceCapsKeyboard,
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
            // Hidden entirely on a host whose agent can't take files, rather
            // than shown-and-failing (see ChatUiState.canAttach).
            if (canAttach) {
                IconButton(onClick = { filePicker.launch(arrayOf("*/*")) }) {
                    Icon(Icons.Filled.AttachFile, "Attach a file")
                }
            }
            IconButton(onClick = {
                when (mic) {
                    MicState.IDLE -> {
                        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                        if (granted) onMicStart() else permLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }
                    MicState.RECORDING -> onMicStop()
                    MicState.FINALIZING -> {}
                }
            }) {
                when (mic) {
                    MicState.IDLE -> Icon(Icons.Filled.Mic, "Dictate")
                    MicState.RECORDING -> Icon(Icons.Filled.Stop, "Stop", tint = MaterialTheme.colorScheme.error)
                    MicState.FINALIZING -> CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }
            // Split compose bar (XERK-33): Send ALWAYS sends — mid-turn the
            // message just queues — and a separate warning-coloured Stop appears
            // beside it while a turn is in flight. On a phone the button is the
            // only way to send, so mid-turn queueing must not require stopping
            // first. Stop is suppressed during a pending question (XERK-21): the
            // draft then routes to the answer, and stopping would destroy it.
            if (busy) {
                IconButton(onClick = onStop) {
                    Icon(Icons.Filled.Stop, "Stop turn", tint = com.xerktech.turma.ui.theme.TurmaColors.waitingText())
                }
            }
            // A message can be attachments alone, so Send lights up for either.
            IconButton(onClick = onSend, enabled = draft.isNotBlank() || attachments.isNotEmpty()) {
                Icon(Icons.AutoMirrored.Filled.Send, if (busy) "Send (queues mid-turn)" else "Send")
            }
        }
    }
}

/**
 * One staged file: name, then its size — or "uploading…" while it is on its way
 * up, or why it failed. ✕ removes it. Port of the web chip (`attachmentsHtml`).
 */
@Composable
private fun AttachmentChip(a: Attachment, onRemove: (String) -> Unit) {
    val failed = a.status == AttachStatus.ERROR
    val border = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.outlineVariant
    Row(
        Modifier.clip(RoundedCornerShape(999.dp))
            .border(1.dp, border, RoundedCornerShape(999.dp))
            .padding(start = 10.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            a.name,
            Modifier.widthIn(max = 160.dp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelMedium,
            color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
        )
        Text(
            when (a.status) {
                AttachStatus.UPLOADING -> "uploading…"
                AttachStatus.ERROR -> a.error.ifBlank { "failed" }
                AttachStatus.READY -> Uploads.formatBytes(a.size)
            },
            Modifier.widthIn(max = 140.dp),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelSmall,
            color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        IconButton(onClick = { onRemove(a.key) }, modifier = Modifier.size(28.dp)) {
            Icon(Icons.Filled.Close, "Remove ${a.name}", Modifier.size(16.dp))
        }
    }
}

/**
 * The chat settings menu behind the top-bar ⚙/Tune button: verbosity (per-session,
 * via [onSelect]) plus the fleet-wide chat text size (XERK-144, read/written
 * through [LocalTextSize] so no call site has to thread the store). Selecting an
 * option applies it and keeps the menu open, so both settings are adjustable in
 * one visit; tap away to dismiss.
 */
@Composable
internal fun ChatSettingsMenu(current: Verbosity, onSelect: (Verbosity) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val textSize = LocalTextSize.current
    IconButton(onClick = { open = true }) { Icon(Icons.Filled.Tune, "Settings") }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        MenuSectionHeader("Verbosity")
        Verbosity.entries.forEach { v ->
            DropdownMenuItem(
                text = { Text(v.name.lowercase().replaceFirstChar { it.uppercase() } + if (v == current) "  ✓" else "") },
                onClick = { onSelect(v) },
            )
        }
        HorizontalDivider()
        MenuSectionHeader("Text size")
        TextSize.entries.forEach { s ->
            DropdownMenuItem(
                text = { Text(s.label + if (s == textSize.current) "  ✓" else "") },
                onClick = { textSize.set(s) },
            )
        }
    }
}

@Composable
private fun MenuSectionHeader(label: String) {
    Text(
        label,
        Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/**
 * A compose-bar setting: the current value, tapped to open its menu.
 *
 * [optionLabel] separates what a row READS from the value it SENDS, for a
 * setting whose wire value isn't a label ("subscription" → "Claude
 * subscription"). [accent] tints the chip for a value worth noticing.
 */
@Composable
private fun MenuChip(
    label: String,
    options: List<String>,
    onSelect: (String) -> Unit,
    optionLabel: (String) -> String = { it },
    accent: Boolean = false,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            label,
            Modifier
                .background(
                    if (accent) com.xerktech.turma.ui.theme.TurmaColors.waiting.copy(alpha = 0.22f)
                    else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                    RoundedCornerShape(6.dp),
                )
                .clickable { open = true }
                .padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.bodySmall,
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o ->
                DropdownMenuItem(text = { Text(optionLabel(o)) }, onClick = { onSelect(o); open = false })
            }
        }
    }
}

/** A compose-bar chip stating a setting that isn't the operator's to change. */
@Composable
private fun StaticChip(label: String, why: String) {
    // An inert chip beside two live ones reads as broken unless it says why. The
    // web puts this in a hover title; a phone has no hover, so it goes to the
    // accessibility layer. It has to sit on a MERGING wrapper rather than on the
    // Text itself — Text writes its own semantics last, so a contentDescription
    // in the same modifier chain never reaches the tree.
    Box(
        Modifier
            .semantics(mergeDescendants = true) { contentDescription = "$label. $why" }
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp)
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
