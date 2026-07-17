package com.xerktech.turma.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Analytics
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/** The four top-level destinations — mirrors the web's phone bottom-nav. */
enum class TopDest(val route: String, val label: String, val icon: ImageVector) {
    DASHBOARD("dashboard", "Dashboard", Icons.Filled.GridView),
    SESSIONS("sessions", "Sessions", Icons.Filled.Terminal),
    BOARD("board", "Board", Icons.Filled.ViewKanban),
    USAGE("usage", "Usage", Icons.Filled.Analytics),
}

/**
 * Shared shell for the four top-level screens: no title bar (the "Turma" header
 * is intentionally gone), just the content plus the web-style bottom nav. Detail
 * screens (chat/terminal) render without this, so the bar hides there.
 */
@Composable
fun MainScaffold(
    current: TopDest,
    onNavigate: (TopDest) -> Unit,
    content: @Composable (Modifier) -> Unit,
) {
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = { TurmaBottomNav(current, onNavigate) },
    ) { pad ->
        content(Modifier.fillMaxSize().padding(pad))
    }
}

@Composable
private fun TurmaBottomNav(current: TopDest, onNavigate: (TopDest) -> Unit) {
    NavigationBar(
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
    ) {
        for (dest in TopDest.entries) {
            NavigationBarItem(
                selected = dest == current,
                onClick = { if (dest != current) onNavigate(dest) },
                icon = { Icon(dest.icon, dest.label) },
                label = { Text(dest.label) },
                alwaysShowLabel = true,
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = MaterialTheme.colorScheme.onPrimary,
                    selectedTextColor = MaterialTheme.colorScheme.primary,
                    indicatorColor = MaterialTheme.colorScheme.primary,
                    unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                ),
            )
        }
    }
}
