package com.xerktech.turma.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.core.VerbosityPrefs
import com.xerktech.turma.core.buildItems
import com.xerktech.turma.vm.ArchiveViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ArchiveScreen(onBack: () -> Unit, vm: ArchiveViewModel = viewModel()) {
    val ui by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.loadList() }

    ui.open?.let { t ->
        val items = buildItems(t.entries, VerbosityPrefs.forPreset(Verbosity.VERBOSE))
        Scaffold(topBar = {
            TopAppBar(
                title = { Text(t.summary.ifBlank { t.repo }) },
                navigationIcon = { IconButton(onClick = { vm.closeTranscript() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        }) { pad ->
            LazyColumn(
                Modifier.fillMaxSize().padding(pad),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) { items(items.size) { i -> ChatItemView(items[i]) } }
        }
        return
    }

    Scaffold(topBar = {
        TopAppBar(
            title = { Text("Search & archive") },
            navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
        )
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            OutlinedTextField(
                value = ui.query, onValueChange = vm::onQuery,
                label = { Text("Search ended sessions") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(12.dp),
            )
            if (ui.openLoading || ui.searching) CircularProgressIndicator(Modifier.padding(12.dp))
            LazyColumn(Modifier.fillMaxSize()) {
                if (ui.query.trim().length >= 2) {
                    ui.groups.forEach { group ->
                        item {
                            Text(
                                group.repo.ifBlank { group.remoteKey }, Modifier.padding(16.dp, 8.dp),
                                fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary,
                            )
                        }
                        items(group.matches.size) { i ->
                            val m = group.matches[i]
                            Column(Modifier.fillMaxWidth().clickable { vm.openTranscript(m.transcriptId) }.padding(16.dp, 6.dp)) {
                                Text(m.summary.ifBlank { m.transcriptId }, fontWeight = FontWeight.Medium)
                                Text(stripMarks(m.snippet), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text("${m.host} · ${m.role}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            HorizontalDivider()
                        }
                    }
                } else {
                    items(ui.sessions.size) { i ->
                        val s = ui.sessions[i]
                        Column(Modifier.fillMaxWidth().clickable { vm.openTranscript(s.transcriptId) }.padding(16.dp, 8.dp)) {
                            Text(s.summary.ifBlank { s.repo }, fontWeight = FontWeight.Medium)
                            Text(
                                "${s.repo} · ${s.host} · ${s.msgCount} msgs",
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        HorizontalDivider()
                    }
                    if (ui.sessions.isEmpty() && !ui.loadingList) {
                        item { Text("No archived sessions yet.", Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                }
            }
        }
    }
}

private fun stripMarks(s: String): String = s.replace("<mark>", "").replace("</mark>", "")
