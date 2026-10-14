package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import com.xerktech.turma.model.PrInfo
import com.xerktech.turma.ui.theme.TurmaTheme
import com.xerktech.turma.vm.MicState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Colour CALL SITES no other test reads (rollup XERK-1701). `StatusTextColorsTest`
 * pins the tokens and `pillInk`; these pin that the screens actually pass them:
 *  - the triage "⏸ held" chip passes the amber FILL (Pill inks it via `pillInk`);
 *  - the PR badge's pending "●" is the amber TEXT colour, not the fill;
 *  - the ◼ Stop-turn icon on the chat footer and the terminal input bar is tinted
 *    the amber text colour.
 * Light theme throughout: that is where the fill and the text colour differ.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)   // real drawing: the tint and fill are read in pixels
class ColourCallSiteTest {

    @get:Rule
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val amberText = 0x8A5A00
    private val amberFill = 0xFAB219

    private fun light(content: @Composable () -> Unit) = compose.setContent {
        TurmaTheme(darkTheme = false) { Box(Modifier.background(Color.White)) { content() } }
    }

    private fun hex(rgb: Int) = "#%06X".format(rgb and 0xFFFFFF)

    private fun textColor(node: SemanticsNode): String {
        val out = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(out)
        return hex(out.single().layoutInput.style.color.toArgb())
    }

    /** The drawn pixel at [at] (root px), read by drawing the content view by hand —
     *  Robolectric never delivers the frame `captureToImage` waits for. */
    private fun pixel(at: Offset): Int {
        compose.waitForIdle()
        val view = compose.activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
        var px = 0
        compose.runOnUiThread {
            val bmp = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bmp))
            px = bmp.getPixel(at.x.toInt(), at.y.toInt())
        }
        return px and 0xFFFFFF
    }

    /** Each channel within [tol] of [want] — the edge of antialiasing, never a colour change. */
    private fun assertNear(what: String, want: Int, got: Int, tol: Int = 3) {
        val ok = (0..2).all { ((want shr (it * 8)) and 0xFF) - ((got shr (it * 8)) and 0xFF) in -tol..tol }
        assertEquals(what, hex(want), if (ok) hex(want) else hex(got))
    }

    /** [fill] at alpha 0.16 over white — a coloured [Pill]'s background on a white page. */
    private fun washOnWhite(fill: Int) = (0..2).fold(0) { acc, i ->
        val c = (fill shr (i * 8)) and 0xFF
        acc or (Math.round(0.16f * c + 0.84f * 255).toInt() shl (i * 8))
    }

    @Test fun `the held triage chip is tinted with the amber fill and inked in amber text`() {
        light { TriageVerdictPill("hold") }
        val node = compose.onNodeWithText("⏸ held").fetchSemanticsNode()
        assertEquals(hex(amberText), textColor(node))
        // The node's bounds are the TEXT's; 4dp left of them is inside the pill's 8dp
        // side padding — clear of the 1dp border and of the glyphs (⏸ is a colour emoji).
        val inset = with(compose.density) { 4.dp.toPx() }
        val bg = pixel(Offset(node.boundsInRoot.left - inset, node.boundsInRoot.center.y))
        assertNear("held chip fill (amber wash, not the text colour's)", washOnWhite(amberFill), bg)
    }

    @Test fun `a pending PR badge marks its dot in the amber text colour`() {
        light { PrBadge(PrInfo(url = "https://github.com/o/r/pull/7", number = 7, state = "OPEN", ready = "pending")) }
        assertEquals(hex(amberText), textColor(compose.onNodeWithText("  ●", useUnmergedTree = true).fetchSemanticsNode()))
    }

    @Test fun `the chat footer's Stop turn icon is tinted the amber text colour`() {
        light {
            ChatFooter(
                session = null, draft = "", mic = MicState.IDLE, busy = true,
                attachments = emptyList(), canAttach = false,
                onDraft = {}, onSend = {}, onStop = {}, onMicStart = {}, onMicStop = {},
                onModel = {}, onMode = {}, localModel = null, dsh = null,
                modelSource = "subscription", canSwitchModelSource = false, onModelSource = {},
                onAttach = {}, onRemoveAttachment = {},
            )
        }
        val icon = compose.onNodeWithContentDescription("Stop turn").fetchSemanticsNode()
        // The ◼ glyph is a solid square centred in its 24dp box: its centre pixel is the tint.
        assertNear("chat Stop tint", amberText, pixel(icon.boundsInRoot.center))
    }

    @Test fun `the terminal bar's Stop turn icon is tinted the amber text colour`() {
        light { TerminalInputBar(text = "", busy = true, onText = {}, onSend = {}, onStop = {}) }
        val icon = compose.onNodeWithContentDescription("Stop turn").fetchSemanticsNode()
        assertNear("terminal Stop tint", amberText, pixel(icon.boundsInRoot.center))
    }
}
