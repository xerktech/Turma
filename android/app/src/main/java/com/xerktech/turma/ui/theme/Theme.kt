package com.xerktech.turma.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val Accent = Color(0xFF7AA2F7)
private val AccentDark = Color(0xFF3D59A1)

private val DarkColors = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF0B0E14),
    secondary = Color(0xFF9ECE6A),
    background = Color(0xFF0B0E14),
    onBackground = Color(0xFFC0CAF5),
    surface = Color(0xFF12161F),
    onSurface = Color(0xFFC0CAF5),
    surfaceVariant = Color(0xFF1A1F2B),
    onSurfaceVariant = Color(0xFF9AA5CE),
    error = Color(0xFFF7768E),
)

private val LightColors = lightColorScheme(
    primary = AccentDark,
    background = Color(0xFFF5F6FA),
    surface = Color(0xFFFFFFFF),
    error = Color(0xFFC53B53),
)

/** Turma status/PR/state colors shared across the UI. */
object TurmaColors {
    val working = Color(0xFF9ECE6A)
    val idle = Color(0xFF7AA2F7)
    val waiting = Color(0xFFE0AF68)
    val stopped = Color(0xFF565F89)
    val prOpen = Color(0xFF9ECE6A)
    val prDraft = Color(0xFF565F89)
    val prMerged = Color(0xFFBB9AF7)
    val prClosed = Color(0xFFF7768E)
    val checkPass = Color(0xFF9ECE6A)
    val checkFail = Color(0xFFF7768E)
    val checkPending = Color(0xFFE0AF68)
}

@Composable
fun TurmaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            window.statusBarColor = colors.background.toArgb()
            window.navigationBarColor = colors.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }
    MaterialTheme(colorScheme = colors, content = content)
}
