package com.xerktech.turma.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.xerktech.turma.core.ADMIN_ONLY_NOTE
import com.xerktech.turma.core.meLabel
import com.xerktech.turma.model.Me

/**
 * What an ADMIN-ONLY account sees (XERK-2553): the admin role and no tenant of
 * its own, so the hub serves it no host, session or ticket, and the admin panel
 * is web-only. Covers the whole app rather than leaving every tab an empty fleet
 * that reads like a broken hub. Web twin: nav.js `adminOnlyNoteHtml`.
 */
@Composable
fun AdminOnlyScreen(me: Me?, onSignOut: () -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                "Administrator account",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold,
            )
            val label = meLabel(me)
            if (label.isNotEmpty()) {
                Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(ADMIN_ONLY_NOTE, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
            Text(
                "User and group administration is in the web dashboard.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Button(onClick = onSignOut) { Text("Sign out") }
        }
    }
}
