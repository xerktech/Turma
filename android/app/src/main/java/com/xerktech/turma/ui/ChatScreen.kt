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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
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
                state.turnStatus?.takeIf { state.liveTurn.isNotBlank() }?.let { st ->
                    Text(
                        "${st.verb.ifBlank { "working" }}… ${st.hint}".trim(),
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
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
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(pad),
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
private fun VerbosityMenu(current: Verbosity, onSelect: (Verbosity) -> Unit) {
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
