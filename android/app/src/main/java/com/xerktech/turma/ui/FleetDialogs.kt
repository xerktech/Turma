package com.xerktech.turma.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.core.Runtime
import com.xerktech.turma.model.DshInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.RepoInfo

private val MODELS = listOf("default", "opus", "sonnet", "haiku")
private val MODES = listOf("auto", "acceptEdits", "plan", "bypassPermissions", "default")

/**
 * The "New session" composer (web `sessions.html`'s spawn options block).
 *
 * [localModel] is the target HOST's self-hosted-model block (XERK-246): when it
 * reports one, the composer offers a "Run against" row, because spawning onto
 * the local model is how new work starts once Claude usage is gone — without it
 * you could fail existing sessions over from a phone but not begin anything.
 * Absent, the row is hidden rather than shown-and-refused (the hub 409s it).
 */
@Composable
fun SpawnDialog(
    host: String,
    repo: String,
    isRoot: Boolean,
    localModel: LocalModelInfo? = null,
    dsh: DshInfo? = null,
    onDismiss: () -> Unit,
    onSpawn: (prompt: String, label: String, baseRef: String, model: String, mode: String, modelSource: String, localModel: String, agentType: String) -> Unit,
) {
    var prompt by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var baseRef by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("default") }
    var mode by remember { mutableStateOf("auto") }
    var modelSource by remember { mutableStateOf(ModelSource.SUBSCRIPTION) }
    var agentType by remember { mutableStateOf(Runtime.CLAUDE) }
    val sourceOpts = remember(localModel) { ModelSource.options(localModel) }
    val runtimeOpts = remember { Runtime.options() }
    // The chosen endpoint model for a LOCAL spawn (XERK-489), defaulting to the
    // host default. The context override is web-only for now (see PARITY.md).
    val localOpts = remember(localModel) { ModelSource.localOptions(localModel) }
    var localModelId by remember(localModel) {
        mutableStateOf(ModelSource.currentLocalModel(null, localModel).ifBlank {
            localOpts.firstOrNull()?.first ?: ""
        })
    }
    // Never keep a choice the operator can no longer see. If the host stops
    // reporting a local model while the composer is open, the "Run against" row
    // disappears — and a `local` left behind in state would spawn into a
    // guaranteed 409 with nothing on screen explaining it or able to change it.
    LaunchedEffect(localModel?.available) {
        if (!ModelSource.composerOffers(localModel)) modelSource = ModelSource.SUBSCRIPTION
    }
    // Same for the runtime: if the host stops offering dsh while the composer is
    // open, the "Runtime" row disappears, so a `dsh` left in state would spawn
    // into a guaranteed 409 with nothing on screen to explain or change it.
    LaunchedEffect(dsh?.available) {
        if (!Runtime.composerOffers(dsh)) agentType = Runtime.CLAUDE
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (isRoot) "New root session" else "New session · $repo") },
        text = {
            Column(
                Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    OutlinedTextField(
                        prompt, { prompt = it },
                        label = { Text("Initial task prompt (optional)") },
                        keyboardOptions = SentenceCapsKeyboard,
                        modifier = Modifier.weight(1f),
                    )
                    VoiceButton(onText = { prompt = listOf(prompt, it).filter { s -> s.isNotBlank() }.joinToString(" ") })
                }
                OutlinedTextField(label, { label = it }, label = { Text("Label (optional)") }, keyboardOptions = SentenceCapsKeyboard, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (!isRoot) {
                    OutlinedTextField(
                        baseRef, { baseRef = it },
                        label = { Text("Base branch (default: repo default)") },
                        keyboardOptions = SentenceCapsKeyboard,
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                }
                // The Model picker stays for a local spawn, matching the web
                // composer (sessions.html), which offers and sends it whatever
                // the source. The agent drops `--model` for a local session
                // itself, and the alias is what that session goes back to if it
                // is ever switched to the subscription — so discarding it here
                // would silently give an Android-spawned session a different
                // model from a web-spawned one. Only the CHAT bar fixes the
                // model, because there the picker would break a live session.
                // Runtime leads the model/permission rows when offered: it picks
                // WHICH agent runs, on the same capability gate as "Run against".
                if (Runtime.composerOffers(dsh)) {
                    DropdownField(
                        label = "Runtime",
                        options = runtimeOpts.map { it.first },
                        selected = agentType,
                        optionLabel = { v -> runtimeOpts.firstOrNull { it.first == v }?.second ?: v },
                    ) { agentType = it }
                }
                DropdownField("Model", MODELS, model) { model = it }
                DropdownField("Permission mode", MODES, mode) { mode = it }
                if (ModelSource.composerOffers(localModel)) {
                    DropdownField(
                        label = "Run against",
                        options = sourceOpts.map { it.first },
                        selected = modelSource,
                        optionLabel = { v -> sourceOpts.firstOrNull { it.first == v }?.second ?: v },
                    ) { modelSource = it }
                }
                // When "local" is chosen, reveal the endpoint's discovered models
                // (XERK-489), mirroring the web composer's revealed dropdown.
                if (modelSource == ModelSource.LOCAL && ModelSource.localModelPickable(localModel)) {
                    DropdownField(
                        label = "Self-hosted model",
                        options = localOpts.map { it.first },
                        selected = localModelId.ifBlank { localOpts.firstOrNull()?.first ?: "" },
                        optionLabel = { v -> localOpts.firstOrNull { it.first == v }?.second ?: v },
                    ) { localModelId = it }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                onSpawn(prompt, label, baseRef, model, mode, modelSource,
                    if (modelSource == ModelSource.LOCAL) localModelId else "", agentType)
            }) {
                Text("Spawn")
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/**
 * A read-only `<select>`. [optionLabel] separates what a row READS from the
 * value it SENDS, for a field whose wire values aren't labels ("subscription" →
 * "Claude subscription"); by default they are the same string.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DropdownField(
    label: String,
    options: List<String>,
    selected: String,
    optionLabel: (String) -> String = { it },
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = optionLabel(selected),
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { opt ->
                DropdownMenuItem(text = { Text(optionLabel(opt)) }, onClick = { onSelect(opt); expanded = false })
            }
        }
    }
}

/**
 * The "New session" picker for the Sessions page (web sessions.html #spawn): pick
 * an ONLINE host and one of its repos, which then opens [SpawnDialog] for that
 * target. The dashboard spawns per-repo in place; the Sessions page has no repo
 * tree, so this two-step picker stands in for it.
 */
@Composable
fun NewSessionPickerDialog(
    targets: List<SpawnHost>,
    onDismiss: () -> Unit,
    onPick: (host: String, repo: String, isRoot: Boolean) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New session") },
        text = {
            if (targets.isEmpty()) {
                Text("No online host with a repo to spawn in.")
            } else {
                Column(
                    Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    targets.forEach { h ->
                        SectionLabel(h.device, Modifier.padding(top = 8.dp, bottom = 2.dp))
                        h.repos.forEach { repo ->
                            Text(
                                if (repo.root) "⌂ Repos root" else repo.name,
                                Modifier.fillMaxWidth()
                                    .clickable { onPick(h.key, repo.name, repo.root) }
                                    .padding(vertical = 10.dp),
                            )
                            HorizontalDivider()
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
fun ResumeDialog(repo: RepoInfo, onDismiss: () -> Unit, onPick: (transcriptId: String, cwd: String) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Resume a session · ${repo.name}") },
        text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                if (repo.resumable.isEmpty()) Text("No resumable history.")
                repo.resumable.forEach { r ->
                    Column(
                        Modifier.fillMaxWidth().clickable { onPick(r.transcriptId, r.cwd) }.padding(vertical = 8.dp),
                    ) {
                        Text(r.summary.ifBlank { r.transcriptId })
                        Text(
                            r.cwd, style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    HorizontalDivider()
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
fun SessionActionsDialog(
    session: com.xerktech.turma.model.SessionInfo,
    onDismiss: () -> Unit,
    onOpen: () -> Unit,
    onKill: () -> Unit,
    onStart: () -> Unit,
    onRestart: () -> Unit,
    onResume: () -> Unit,
    onDelete: () -> Unit,
) {
    val running = session.status == "running"
    val queued = session.status == "queued"
    // Destructive actions arm on the first tap and fire on the second (the web
    // card's two-click confirm); delete warns when uncommitted work would go.
    val dirty = session.git?.dirtyFiles ?: 0
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(com.xerktech.turma.core.sessionName(session)) },
        text = {
            Column {
                when {
                    // A queued session has no worktree/pane yet — the only
                    // action is cancelling it (the same kill path).
                    queued -> ConfirmActionRow("Cancel queued session", "Confirm cancel", onKill)
                    running -> {
                        ActionRow("Open chat", onOpen)
                        ConfirmActionRow("Restart (clear context)", "Confirm restart", onRestart)
                        ConfirmActionRow("Kill", "Confirm kill", onKill)
                    }
                    else -> {
                        ActionRow("Open chat", onOpen)
                        ActionRow("Start", onStart)
                        ActionRow("Resume", onResume)
                        ConfirmActionRow(
                            "Delete",
                            if (dirty > 0) "Confirm delete — uncommitted changes will be lost" else "Confirm delete",
                            onDelete,
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}

@Composable
private fun ActionRow(label: String, onClick: () -> Unit) {
    Text(
        label,
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 12.dp),
    )
}

/** Two-tap arm/confirm row for a destructive action; auto-disarms after 3.5s. */
@Composable
private fun ConfirmActionRow(label: String, confirmLabel: String, onConfirm: () -> Unit) {
    var armed by remember { mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(armed) {
        if (armed) { kotlinx.coroutines.delay(3500); armed = false }
    }
    Text(
        if (armed) confirmLabel else label,
        Modifier.fillMaxWidth()
            .clickable { if (armed) { armed = false; onConfirm() } else armed = true }
            .padding(vertical = 12.dp),
        color = if (armed) MaterialTheme.colorScheme.error else androidx.compose.ui.graphics.Color.Unspecified,
    )
}

/**
 * The host's "Clone from GitHub" bar (web index.html `cloneBar`/`cloneBody`):
 * a collapsed header naming the gh login, expanding to a searchable multi-select
 * of the repos that login can clone plus a free-text `owner/repo` box. Below it,
 * always visible, sit the agent's clone-job rows — without them a queued clone
 * gives no feedback at all until the repo silently appears in the tree.
 *
 * Availability is the agent's `github.available`; a host reporting no creds gets
 * the greyed note instead of the picker, and an OFFLINE host can browse but not
 * fire (the clone rides the heartbeat, so it would just hang).
 */
@Composable
fun CloneBar(agent: com.xerktech.turma.model.AgentInfo, onClone: (String, String?) -> Unit) {
    val sources = com.xerktech.turma.core.cloneSources(agent.github, agent.gitSources)
    val avail = sources.any { it.available }
    var expanded by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth().padding(10.dp, 2.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(vertical = 6.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore, null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // One source names itself; several go generic (the per-source
            // labels move into the list) — core.cloneBarTitle, JVM-tested.
            Text(
                com.xerktech.turma.core.cloneBarTitle(sources),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (expanded) {
            if (!avail) {
                Text(
                    com.xerktech.turma.core.cloneUnavailableNote(sources),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            } else {
                ClonePicker(agent, sources, onClone)
            }
        }
        // Job rows stay visible while collapsed — they are the answer to "did my
        // clone work", which is exactly when the panel is shut again.
        for (job in agent.clones) {
            val row = com.xerktech.turma.core.cloneJobRow(job)
            Row(
                Modifier.fillMaxWidth().padding(vertical = 2.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (!row.done && !row.failed) {
                    CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                }
                Text(
                    row.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = when {
                        row.failed -> MaterialTheme.colorScheme.error
                        row.done -> com.xerktech.turma.ui.theme.TurmaColors.good
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
        }
    }
}

/** The expanded clone panel: search + multi-select list (grouped by source when
 *  several report, XERK-155) + free-text + Clone. */
@Composable
private fun ClonePicker(
    agent: com.xerktech.turma.model.AgentInfo,
    sources: List<com.xerktech.turma.core.CloneSource>,
    onClone: (String, String?) -> Unit,
) {
    var search by remember { mutableStateOf("") }
    var free by remember { mutableStateOf("") }
    val picks = remember { mutableStateListOf<String>() }

    val present = agent.repos.map { it.name }.toSet()
    val avail = sources.filter { it.available }
    val multi = sources.size > 1
    val groups = avail.map { s ->
        s to com.xerktech.turma.core.cloneCandidates(s.repos, present, search, s.source)
    }
    val total = avail.sumOf { it.repos.size }
    val shownTotal = groups.sumOf { it.second.size }
    val ghUser = sources.firstOrNull { it.source == "github" }?.user
    val specs = com.xerktech.turma.core.cloneSpecs(picks.toSet(), free)

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (total > 0) {
            OutlinedTextField(
                search, { search = it },
                label = { Text("Search repos…") }, singleLine = true,
                keyboardOptions = SentenceCapsKeyboard,
                enabled = agent.online, modifier = Modifier.fillMaxWidth(),
            )
        }
        // Bounded so a login with hundreds of repos can't push the rest of the
        // host's tree off the screen; the search box is how you reach the tail.
        Column(
            Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
        ) {
            when {
                total == 0 -> Text(
                    "No repos found${ghUser?.let { " for $it" }.orEmpty()} — " +
                        "type an owner/repo below to clone.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                shownTotal == 0 -> Text(
                    "No repos match “$search”.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> for ((src, candidates) in groups) {
                    if (candidates.isEmpty()) continue
                    // A group heading only when several sources report — a
                    // GitHub-only host keeps its flat list.
                    if (multi) {
                        Text(
                            src.label + src.user?.let { " · as $it" }.orEmpty(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 6.dp, bottom = 2.dp),
                        )
                    }
                    for (c in candidates) {
                        val pickKey = com.xerktech.turma.core.clonePickKey(c.source, c.nameWithOwner)
                        val pickable = agent.online && !c.alreadyHere
                        Row(
                            Modifier.fillMaxWidth().clickable(enabled = pickable) {
                                if (!picks.remove(pickKey)) picks.add(pickKey)
                            },
                            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                        ) {
                            Checkbox(
                                checked = pickKey in picks,
                                onCheckedChange = { on ->
                                    if (on) picks.add(pickKey) else picks.remove(pickKey)
                                },
                                enabled = pickable,
                            )
                            Text(
                                c.nameWithOwner + (if (c.isPrivate) " 🔒" else "") +
                                    (if (c.alreadyHere) " · already here" else ""),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (c.alreadyHere) MaterialTheme.colorScheme.onSurfaceVariant
                                else androidx.compose.ui.graphics.Color.Unspecified,
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
        }
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            OutlinedTextField(
                free, { free = it },
                label = { Text("or owner/repo") }, singleLine = true,
                keyboardOptions = SentenceCapsKeyboard,
                enabled = agent.online, modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = {
                    specs.forEach { onClone(it.repo, it.source) }
                    picks.clear(); free = ""; search = ""
                },
                enabled = agent.online && specs.isNotEmpty(),
            ) {
                Text(if (specs.size > 1) "Clone ${specs.size}" else "Clone")
            }
        }
        if (!agent.online) {
            Text(
                "Host offline — cloning resumes when it reconnects.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    message: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(message) },
        confirmButton = { TextButton(onClick = onConfirm) { Text(confirmLabel) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
