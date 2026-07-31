package com.xerktech.turma.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.xerktech.turma.net.Updater
import com.xerktech.turma.vm.UpdateViewModel

/**
 * The in-app update banner (XERK-11): a slim card that surfaces on the Dashboard
 * when a newer APK is published to GitHub, with a one-tap Download & Install. A
 * stopgap until the app ships on Google Play. Hidden entirely when there's
 * nothing to offer, so it costs no space in the common case.
 */
@Composable
fun UpdateBanner(vm: UpdateViewModel = viewModel(), modifier: Modifier = Modifier) {
    val state by vm.state.collectAsStateWithLifecycle()
    // Re-check when the Dashboard shows (throttled in the Updater), so a long-lived
    // app still notices a release without a cold start.
    LaunchedEffect(Unit) { vm.check() }
    AnimatedVisibility(visible = state !is Updater.State.Hidden) {
        // Snapshot so the closure below sees a stable, smart-cast value.
        when (val s = state) {
            is Updater.State.Hidden -> {}
            else -> BannerCard(s, onAct = vm::act, onDismiss = vm::dismiss, modifier = modifier)
        }
    }
}

@Composable
private fun BannerCard(
    state: Updater.State,
    onAct: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp),
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.SystemUpdate,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    title(state),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                subtitle(state)?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }
                (state as? Updater.State.Downloading)?.pct?.let { pct ->
                    Spacer(Modifier.size(6.dp))
                    LinearProgressIndicator(
                        progress = { pct / 100f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            Spacer(Modifier.size(8.dp))
            TrailingAction(state, onAct, onDismiss)
        }
    }
}

@Composable
private fun TrailingAction(state: Updater.State, onAct: () -> Unit, onDismiss: () -> Unit) {
    when (state) {
        is Updater.State.Downloading -> CircularProgressIndicator(
            modifier = Modifier.size(24.dp),
            strokeWidth = 2.dp,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
        else -> Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            // No dismiss on a downloaded/ready update — the work is done; the only
            // sensible action left is to finish installing it.
            if (state is Updater.State.Available) {
                TextButton(onClick = onDismiss) {
                    Text("Later", color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
            Button(
                onClick = onAct,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            ) { Text(actionLabel(state)) }
        }
    }
}

private fun title(state: Updater.State): String = when (state) {
    is Updater.State.Available -> "Update available — v${state.version}"
    is Updater.State.Downloading -> "Downloading v${state.version}…"
    is Updater.State.ReadyToInstall -> "Ready to install — v${state.version}"
    is Updater.State.Failed -> "Update failed"
    Updater.State.Hidden -> ""
}

private fun subtitle(state: Updater.State): String? = when (state) {
    is Updater.State.ReadyToInstall ->
        if (state.needsPermission) "Allow Turma to install apps, then tap Install." else null
    is Updater.State.Failed -> state.message
    else -> null
}

private fun actionLabel(state: Updater.State): String = when (state) {
    is Updater.State.Available -> "Update"
    is Updater.State.ReadyToInstall -> "Install"
    is Updater.State.Failed -> "Retry"
    else -> ""
}
