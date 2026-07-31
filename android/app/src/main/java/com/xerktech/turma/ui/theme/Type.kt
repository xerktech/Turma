package com.xerktech.turma.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.xerktech.turma.R

/**
 * Self-hosted Inter (sans) + Space Grotesk (display) — the same two families the
 * web client bundles. Space Grotesk heads titles/wordmarks; Inter carries body.
 */
val Inter = FontFamily(
    Font(R.font.inter_regular, FontWeight.Normal),
    Font(R.font.inter_medium, FontWeight.Medium),
    Font(R.font.inter_semibold, FontWeight.SemiBold),
    Font(R.font.inter_bold, FontWeight.Bold),
)

val SpaceGrotesk = FontFamily(
    Font(R.font.space_grotesk_medium, FontWeight.Medium),
    Font(R.font.space_grotesk_semibold, FontWeight.SemiBold),
    Font(R.font.space_grotesk_bold, FontWeight.Bold),
)

// Body/label styles use Inter; headline/title styles use Space Grotesk with the
// web's tight tracking (-0.01em) so headings match the dashboard's feel.
val TurmaTypography = Typography().run {
    val display = { s: TextStyle -> s.copy(fontFamily = SpaceGrotesk, letterSpacing = (-0.2).sp) }
    val body = { s: TextStyle -> s.copy(fontFamily = Inter) }
    copy(
        displayLarge = display(displayLarge), displayMedium = display(displayMedium), displaySmall = display(displaySmall),
        headlineLarge = display(headlineLarge), headlineMedium = display(headlineMedium), headlineSmall = display(headlineSmall),
        titleLarge = display(titleLarge).copy(fontWeight = FontWeight.SemiBold),
        titleMedium = display(titleMedium).copy(fontWeight = FontWeight.SemiBold),
        titleSmall = body(titleSmall).copy(fontWeight = FontWeight.SemiBold),
        bodyLarge = body(bodyLarge), bodyMedium = body(bodyMedium), bodySmall = body(bodySmall),
        labelLarge = body(labelLarge), labelMedium = body(labelMedium), labelSmall = body(labelSmall),
    )
}
