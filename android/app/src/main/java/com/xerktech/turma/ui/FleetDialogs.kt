package com.xerktech.turma.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
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
                        Text(r.summary.ifBlank { r.label.ifBlank { r.transcriptId } })
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
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(com.xerktech.turma.core.sessionName(session)) },
        text = {
            Column {
                ActionRow("Open chat", onOpen)
                if (running) {
                    ActionRow("Restart (clear context)", onRestart)
                    ActionRow("Kill", onKill)
                } else {
                    ActionRow("Start", onStart)
                    ActionRow("Resume", onResume)
                    ActionRow("Delete", onDelete)
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

@Composable
fun CloneBar(agent: com.xerktech.turma.model.AgentInfo, onClone: (String) -> Unit) {
    val gh = agent.github
    Column(Modifier.fillMaxWidth().padding(10.dp, 2.dp)) {
        if (gh == null || !gh.ok) {
            Text("Cloning unavailable — this host reports no GitHub credentials.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            var repo by remember { mutableStateOf("") }
            val present = agent.repos.map { it.name }.toSet()
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                OutlinedTextField(
                    repo, { repo = it },
                    label = { Text("Clone owner/repo") }, singleLine = true, modifier = Modifier.weight(1f),
                )
                TextButton(onClick = { if (repo.isNotBlank()) { onClone(repo.trim()); repo = "" } }, enabled = repo.isNotBlank()) {
                    Text("Clone")
                }
            }
            if (gh.repos.isNotEmpty()) {
                DropdownField(
                    "Or pick a repo",
                    gh.repos.map { it.nameWithOwner }.filter { it.substringAfterLast('/') !in present },
                    "select…",
                ) { onClone(it) }
            }
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
