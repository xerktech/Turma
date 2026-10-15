package com.xerktech.turma.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
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
    // Muted, matching the web `.dot.idle` — a quiet session with nothing asking
    // to be looked at. It used to be the accent, which is now what the
    // Ready-for-review dot beside it needs (XERK-224).
    val idle = Muted
    val review = AccentDark
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

    /**
     * The categorical slots (org tints, chart lines) for the current theme, as the
     * web's `--s1..--s8` are redefined for dark: the dark set on a light page tinted
     * every org card a shade off the web's. Composable so no call site can keep one
     * theme's palette across a theme switch.
     */
    @Composable
    fun series(): List<Color> = if (isLight()) ChartSeriesLight else ChartSeries

    /**
     * Amber as TEXT (web `--warning-text`): the fill is under 2:1 on a light card,
     * so light steps down to [WarningTextLight]; dark keeps the fill.
     */
    @Composable
    fun waitingText(): Color =
        if (MaterialTheme.colorScheme.surface.luminance() > 0.5f) WarningTextLight else Warning

    // Status TEXT as the web's `--good-text` / `--accent-text` / `--critical-text`
    // (app.css): the fills drop under 4.5:1 as small text on the dark surface, so
    // dark steps them up; light keeps the web's own values (rollup XERK-1701).
    @Composable
    fun workingText(): Color = if (isLight()) Good else GoodTextDark
    @Composable
    fun reviewText(): Color = if (isLight()) AccentTextLight else AccentTextDark
    @Composable
    fun criticalText(): Color = if (isLight()) Critical else CriticalTextDark

    @Composable
    private fun isLight() = MaterialTheme.colorScheme.surface.luminance() > 0.5f
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
