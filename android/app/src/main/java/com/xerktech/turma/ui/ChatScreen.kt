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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.TurmaApplication
import com.xerktech.turma.core.ChatItem
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.buildItems
import com.xerktech.turma.core.sessionBranch
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
    val revealNewestId = if (state.liveTurn.isNotBlank()) ChatViewModel.LIVE_TURN_ID else state.entries.lastOrNull()?.key
    val items = remember(displayEntries, state.verbosity, state.reveal) {
        buildItems(displayEntries, state.prefs, revealNewestId, state.reveal.shown)
    }

    val listState = rememberLazyListState()
    LaunchedEffect(items.size) {
        if (items.isNotEmpty()) listState.animateScrollToItem(items.size - 1)
    }

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
                            Text(
                                sessionBranch(it) + if (state.connected) " · live" else "",
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                            )
                        }
                    }
                },
                navigationIcon = {
                    if (showBack) {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
                    }
                },
                actions = {
                    VerbosityMenu(state.verbosity) { vm.setVerbosity(it) }
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
                state.turnStatus?.let { st -> LiveStatusBar(st, onOpenSubagent) }
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
                )
            }
        },
    ) { pad ->
        // Wrap the transcript so its text is selectable + copyable, matching the
        // web chat, which relies on native browser selection to copy session text
        // (XERK-64). Long-press selects; tap still toggles tool/thinking cards.
        SelectionContainer(Modifier.fillMaxSize().padding(pad)) {
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
            if (status.agents.isNotEmpty()) AgentsList(status.agents, onOpenSubagent)
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
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicStart: () -> Unit,
    onMicStop: () -> Unit,
    onModel: (String) -> Unit,
    onMode: (String) -> Unit,
) {
    val context = LocalContext.current
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onMicStart()
    }
    Column(Modifier.fillMaxWidth().padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // Model / mode / PR sit ABOVE the input box. Every PR the session opened
        // shows (newest first — the freshest link leads), matching the web footer
        // chip (chat.js prFooterChip); FlowRow wraps them on a narrow phone.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            MenuChip("model: ${session?.model?.ifBlank { "default" } ?: "default"}", listOf("default", "opus", "sonnet", "haiku"), onModel)
            MenuChip("mode: ${session?.permissionMode?.ifBlank { "auto" } ?: "auto"}", listOf("auto", "acceptEdits", "plan", "bypassPermissions", "default"), onMode)
            session?.prs?.asReversed()?.forEach { PrBadge(it) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = draft, onValueChange = onDraft,
                placeholder = { Text("Message…") },
                modifier = Modifier.weight(1f),
                maxLines = 4,
            )
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
            IconButton(onClick = onSend, enabled = draft.isNotBlank()) {
                Icon(Icons.AutoMirrored.Filled.Send, if (busy) "Send (queues mid-turn)" else "Send")
            }
        }
    }
}

@Composable
internal fun VerbosityMenu(current: Verbosity, onSelect: (Verbosity) -> Unit) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) { Icon(Icons.Filled.Tune, "Verbosity") }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        Verbosity.entries.forEach { v ->
            DropdownMenuItem(
                text = { Text(v.name.lowercase().replaceFirstChar { it.uppercase() } + if (v == current) "  ✓" else "") },
                onClick = { onSelect(v); open = false },
            )
        }
    }
}

@Composable
private fun MenuChip(label: String, options: List<String>, onSelect: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Text(
            label,
            Modifier
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(6.dp))
                .clickable { open = true }
                .padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.bodySmall,
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o -> DropdownMenuItem(text = { Text(o) }, onClick = { onSelect(o); open = false }) }
        }
    }
}
