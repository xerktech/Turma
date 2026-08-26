package com.xerktech.turma.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    host: String,
    sessionId: String,
    onBack: () -> Unit,
    onTerminal: () -> Unit,
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

    Scaffold(
        // Lift the whole screen above the soft keyboard (XERK-76): the app is
        // edge-to-edge, so without this the IME simply overlays the compose box
        // and you can't see what you're typing. imePadding consumes the inset,
        // so the bottomBar (footer + question sheet) lands right on the keyboard.
        modifier = Modifier.imePadding(),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(state.session?.let { sessionName(it) } ?: "Session", maxLines = 1)
                        state.session?.let {
                            // Host · repo · branch (XERK-121), then whether
                            // anything is reaching us (core `liveMarker`, the
                            // web's tunnel chip). The marker is its OWN Text and
                            // the meta line is what gives way: appended to that
                            // ellipsized line, a warning nobody can read is
                            // worse than a truncated branch name.
                            val hostLabel = state.hostLabel.ifBlank { host }
                            val mark = liveMarker(state.tunnelOnline, state.connected)
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    sessionHeaderMeta(hostLabel, it),
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                if (mark.isNotEmpty()) {
                                    Text(
                                        " · " + mark,
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace,
                                        maxLines = 1,
                                        color = if (state.tunnelOnline) Color.Unspecified
                                                else MaterialTheme.colorScheme.error,
                                    )
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
                    IconButton(onClick = onTerminal) { Icon(Icons.Filled.Terminal, "Terminal") }
                    // Kill the session you're in (web chatKill): arm/confirm, then
                    // leave the view — the card drops on the agent's next beat.
                    KillAction(onKill = { vm.kill(); onBack() })
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Column {
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
                ChatFooter(
                    session = state.session,
                    draft = state.draft,
                    mic = state.mic,
                    attachments = state.attachments,
                    canAttach = state.canAttach,
                    // Working right now: prefer the live turn frames (fast), fall back
                    // to the heartbeat's paneBusy. Drives the separate ◼ Stop button —
                    // suppressed while a question is pending (the draft answers it).
                    busy = (state.liveTurn.isNotBlank() || state.session?.session?.paneBusy == true) &&
                        state.question.isBlank(),
                    onDraft = vm::setDraft,
                    onSend = vm::submitDraft,
                    onStop = vm::stop,
                    onMicStart = vm::startDictation,
                    onMicStop = vm::stopDictation,
                    onModel = vm::setModel,
                    onMode = vm::setMode,
                    localModel = state.localModel,
                    modelSource = state.modelSource(),
                    canSwitchModelSource = state.canSwitchModelSource(),
                    onModelSource = vm::setModelSource,
                    onAttach = vm::attach,
                    onRemoveAttachment = vm::removeAttachment,
                )
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
                    "Background agents…",
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            AgentsList(agents, onOpenSubagent)
        }
    }
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
            val isMain = a.type == "main" && a.label.isBlank()
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
                Text(a.type, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.labelMedium)
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

@Composable
private fun QuestionSheet(
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
    Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
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
private fun ChatFooter(
    session: com.xerktech.turma.model.SessionInfo?,
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
    Column(Modifier.fillMaxWidth().padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // Model / mode / PR sit ABOVE the input box. Every PR the session opened
        // shows (newest first — the freshest link leads), matching the web footer
        // chip (chat.js prFooterChip); FlowRow wraps them on a narrow phone.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
            MenuChip("mode: ${session?.permissionMode?.ifBlank { "auto" } ?: "auto"}", listOf("auto", "acceptEdits", "plan", "bypassPermissions", "default"), onMode)
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
        Row(verticalAlignment = Alignment.CenterVertically) {
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
                    Icon(Icons.Filled.Stop, "Stop turn", tint = com.xerktech.turma.ui.theme.TurmaColors.waiting)
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
