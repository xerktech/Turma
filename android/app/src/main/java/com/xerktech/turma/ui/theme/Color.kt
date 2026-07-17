package com.xerktech.turma.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Design tokens ported verbatim from the web client's `turma/public/app.css`
 * (the `:root` warm-paper light palette and the `prefers-color-scheme: dark`
 * overrides), so the Android app reads as the same product as the dashboard.
 */

// ---- warm-paper light ------------------------------------------------------
val PageLight = Color(0xFFF9F9F7)
val SurfaceLight = Color(0xFFFCFCFB)
val InkLight = Color(0xFF0B0B0B)
val Ink2Light = Color(0xFF52514E)
val HairlineLight = Color(0xFFE1E0D9)
val AccentLight = Color(0xFF2A78D6)
val FieldLight = Color(0xFFFFFFFF)

// ---- dark ------------------------------------------------------------------
val PageDark = Color(0xFF0D0D0D)
val SurfaceDark = Color(0xFF1A1A19)
val InkDark = Color(0xFFFFFFFF)
val Ink2Dark = Color(0xFFC3C2B7)
val HairlineDark = Color(0xFF2C2C2A)
val AccentDark = Color(0xFF3987E5)
val FieldDark = Color(0xFF111110)

// muted is identical across both themes in the web tokens.
val Muted = Color(0xFF898781)

// ---- semantic (shared across both themes — the web never redefines these) --
val Good = Color(0xFF12A312)
val Warning = Color(0xFFFAB219)
val Critical = Color(0xFFD03B3B)
// A mid purple that reads on both surfaces (web --s5 is #4a3aa7 / #9085e9).
val Purple = Color(0xFF7D6FE0)

// ---- validated categorical chart slots (web --s1..--s8, dark stepping) -----
val ChartSeries = listOf(
    Color(0xFF3987E5), // s1 blue
    Color(0xFF199E70), // s2 green
    Color(0xFFC98500), // s3 amber
    Color(0xFF2E9E2E), // s4 green-2
    Color(0xFF9085E9), // s5 violet
    Color(0xFFE66767), // s6 red
    Color(0xFFD55181), // s7 pink
    Color(0xFFD95926), // s8 orange
)
