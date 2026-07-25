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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.xerktech.turma.model.RepoInfo

private val MODELS = listOf("default", "opus", "sonnet", "haiku")
private val MODES = listOf("auto", "acceptEdits", "plan", "bypassPermissions", "default")

@Composable
fun SpawnDialog(
    host: String,
    repo: String,
    isRoot: Boolean,
    onDismiss: () -> Unit,
    onSpawn: (prompt: String, label: String, baseRef: String, model: String, mode: String) -> Unit,
) {
    var prompt by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var baseRef by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("default") }
    var mode by remember { mutableStateOf("auto") }

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
                        modifier = Modifier.weight(1f),
                    )
                    VoiceButton(onText = { prompt = listOf(prompt, it).filter { s -> s.isNotBlank() }.joinToString(" ") })
                }
                OutlinedTextField(label, { label = it }, label = { Text("Label (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (!isRoot) {
                    OutlinedTextField(
                        baseRef, { baseRef = it },
                        label = { Text("Base branch (default: repo default)") },
                        singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                }
                DropdownField("Model", MODELS, model) { model = it }
                DropdownField("Permission mode", MODES, mode) { mode = it }
            }
        },
        confirmButton = { TextButton(onClick = { onSpawn(prompt, label, baseRef, model, mode) }) { Text("Spawn") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DropdownField(label: String, options: List<String>, selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { opt ->
                DropdownMenuItem(text = { Text(opt) }, onClick = { onSelect(opt); expanded = false })
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
fun CloneBar(agent: com.xerktech.turma.model.AgentInfo, onClone: (String) -> Unit) {
    val gh = agent.github
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
            Text(
                "Clone from GitHub" + gh?.login?.takeIf { it.isNotBlank() }?.let { " · as $it" }.orEmpty(),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        if (expanded) {
            if (gh == null || !gh.available) {
                Text(
                    "No GitHub credentials on this host — cloning unavailable.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            } else {
                ClonePicker(agent, gh, onClone)
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

/** The expanded clone panel: search + multi-select list + free-text + Clone. */
@Composable
private fun ClonePicker(
    agent: com.xerktech.turma.model.AgentInfo,
    gh: com.xerktech.turma.model.GithubInfo,
    onClone: (String) -> Unit,
) {
    var search by remember { mutableStateOf("") }
    var free by remember { mutableStateOf("") }
    val picks = remember { mutableStateListOf<String>() }

    val present = agent.repos.map { it.name }.toSet()
    val candidates = com.xerktech.turma.core.cloneCandidates(gh.repos, present, search)
    val specs = com.xerktech.turma.core.cloneSpecs(picks.toSet(), free)

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (gh.repos.isNotEmpty()) {
            OutlinedTextField(
                search, { search = it },
                label = { Text("Search repos…") }, singleLine = true,
                enabled = agent.online, modifier = Modifier.fillMaxWidth(),
            )
        }
        // Bounded so a login with hundreds of repos can't push the rest of the
        // host's tree off the screen; the search box is how you reach the tail.
        Column(
            Modifier.fillMaxWidth().heightIn(max = 200.dp).verticalScroll(rememberScrollState()),
        ) {
            when {
                gh.repos.isEmpty() -> Text(
                    "No repos found${gh.login.takeIf { it.isNotBlank() }?.let { " for $it" }.orEmpty()} — " +
                        "type an owner/repo below to clone.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                candidates.isEmpty() -> Text(
                    "No repos match “$search”.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> for (c in candidates) {
                    val pickable = agent.online && !c.alreadyHere
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = pickable) {
                            if (!picks.remove(c.nameWithOwner)) picks.add(c.nameWithOwner)
                        },
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                    ) {
                        Checkbox(
                            checked = c.nameWithOwner in picks,
                            onCheckedChange = { on ->
                                if (on) picks.add(c.nameWithOwner) else picks.remove(c.nameWithOwner)
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
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            OutlinedTextField(
                free, { free = it },
                label = { Text("or owner/repo") }, singleLine = true,
                enabled = agent.online, modifier = Modifier.weight(1f),
            )
            TextButton(
                onClick = {
                    specs.forEach(onClone)
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
