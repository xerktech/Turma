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

private val LightScheme = lightColorScheme(
    primary = AccentLight,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCE9F9),
    onPrimaryContainer = Color(0xFF0B3B6E),
    secondary = AccentLight,
    onSecondary = Color.White,
    background = PageLight,
    onBackground = InkLight,
    surface = SurfaceLight,
    onSurface = InkLight,
    surfaceVariant = Color(0xFFF0EFEA),
    onSurfaceVariant = Ink2Light,
    surfaceContainerHighest = FieldLight,
    outline = HairlineLight,
    outlineVariant = HairlineLight,
    error = Critical,
    onError = Color.White,
    scrim = Color(0x66000000),
)

private val DarkScheme = darkColorScheme(
    primary = AccentDark,
    onPrimary = Color(0xFF06121F),
    primaryContainer = Color(0xFF16324F),
    onPrimaryContainer = Color(0xFFCFE2FA),
    secondary = AccentDark,
    onSecondary = Color(0xFF06121F),
    background = PageDark,
    onBackground = InkDark,
    surface = SurfaceDark,
    onSurface = InkDark,
    surfaceVariant = Color(0xFF232321),
    onSurfaceVariant = Ink2Dark,
    surfaceContainerHighest = FieldDark,
    outline = HairlineDark,
    outlineVariant = HairlineDark,
    error = Color(0xFFE66767),
    onError = Color(0xFF1A0606),
    scrim = Color(0x99000000),
)

/**
 * Semantic status/PR/chart colors shared across the UI. These are theme-agnostic
 * in the web tokens (good/warning/critical are never redefined for dark), so a
 * plain object is safe — only the Material scheme above flips with the theme.
 */
object TurmaColors {
    val working = Good
    val idle = AccentDark
    val waiting = Warning
    val stopped = Muted
    val good = Good
    val warning = Warning
    val critical = Critical
    val prOpen = Good
    val prDraft = Muted
    val prMerged = Purple
    val prClosed = Critical
    val checkPass = Good
    val checkFail = Critical
    val checkPending = Warning
    val series = ChartSeries
}

@Composable
fun TurmaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkScheme else LightScheme
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            window.statusBarColor = Color.Transparent.toArgb()
            window.navigationBarColor = Color.Transparent.toArgb()
            val insets = WindowCompat.getInsetsController(window, view)
            insets.isAppearanceLightStatusBars = !darkTheme
            insets.isAppearanceLightNavigationBars = !darkTheme
        }
    }
    MaterialTheme(colorScheme = colors, typography = TurmaTypography, content = content)
}
