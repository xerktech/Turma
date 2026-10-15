package com.xerktech.turma.ui

import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The chat's header and footer against the WINDOW and its insets (rollup XERK-1701), on
 * the real [ChatScreen] with real system-bar / keyboard insets dispatched to the view:
 *  - the short-window decision reads the window, not the room the keyboard leaves (a
 *    tablet with its keyboard up keeps the large title and the host · repo line);
 *  - a short window takes the smaller title, and its meta line folds while typing;
 *  - the footer stays above the navigation bar;
 *  - a landscape phone at font 2.0 with the keyboard up keeps the whole compose box
 *    below the bar, and a pending question stays reachable in the footer;
 *  - the tunnel-offline marker is never cut, and host · repo never vanishes beside it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)   // real text measurement: the meta row is laid out by width
class ChatWindowFitTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val host = "nas01"
    private val session = "s1"
    private val root = "root"
    private val options = (1..6).joinToString(",") { "\"Option number $it\"" }

    // Lets a test take the chat out of composition and bring it back (its VM is kept).
    private val chatShown = mutableStateOf(true)

    private fun open(
        widthDp: Int, heightDp: Int, fontScale: Float = 1f,
        sessionBlock: String = "{}", tunnelOnline: Boolean = true,
        // The two-pane layout: MainScaffold has already consumed the status bar.
        statusConsumed: Boolean = false,
    ) {
        hub.json("/api/agents/$host/sessions/$session/history", """{"entries":[],"truncated":false,"pending":false}""")
        hub.json("/api/ws-token", """{"token":"t"}""")
        val fleet = HubHarness.fleetJson(
            host = host,
            sessions = """{ "id": "$session", "repo": "Turma", "status": "running", "worktree": "wt",
                            "model": "opus", "permissionMode": "auto", "session": $sessionBlock }""",
        )
        hub.seedFleet(if (tunnelOnline) fleet else fleet.replace("\"terminalOnline\": true", "\"terminalOnline\": false"))
        compose.setContent {
            val d = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(d.density, fontScale)) {
                val consumed = if (statusConsumed) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier
                Box(Modifier.requiredSize(widthDp.dp, heightDp.dp).testTag(root).then(consumed)) {
                    // The app's scaffold reads the insets too, keeping them current while the chat
                    // itself is out of composition; this stands in for it.
                    Box(Modifier.imePadding())
                    if (chatShown.value) ChatScreen(host = host, sessionId = session, onBack = {}, onTerminal = {})
                }
            }
        }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Message…", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitForIdle()
    }

    /** Dispatch system-bar / keyboard insets (dp) to the composition, as the OS would. */
    private fun insets(statusDp: Int = 0, navDp: Int = 0, imeDp: Int = 0) {
        compose.runOnUiThread {
            val px = { dp: Int -> (dp * compose.activity.resources.displayMetrics.density).toInt() }
            val insets = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, px(statusDp), 0, 0))
                .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, px(navDp)))
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, px(imeDp)))
                .setVisible(WindowInsetsCompat.Type.ime(), imeDp > 0)
                .build()
            val content = compose.activity.findViewById<ViewGroup>(android.R.id.content)
            ViewCompat.dispatchApplyWindowInsets(content.getChildAt(0), insets)
        }
        compose.waitForIdle()
    }

    private fun shown(tag: String) =
        compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    /** A node's extent in root dp from its position and MEASURED size — never clipped. */
    private fun unclipped(n: SemanticsNode): DpRect = with(compose.density) {
        val top = n.positionInRoot.y.toDp()
        val left = n.positionInRoot.x.toDp()
        DpRect(left, top, left + n.size.width.toDp(), top + n.size.height.toDp())
    }

    private fun titleHeight(): Dp =
        unclipped(compose.onNodeWithTag(CHAT_TITLE_TAG, useUnmergedTree = true).fetchSemanticsNode()).height

    private fun layout(tag: String): TextLayoutResult {
        val out = mutableListOf<TextLayoutResult>()
        val node = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode()
        node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(out)
        return out.single()
    }

    @Test fun `a tablet with its keyboard up keeps the large title and the meta line`() {
        // 1280x800dp landscape; a keyboard leaving 400dp above it is still a tall WINDOW.
        open(widthDp = 1280, heightDp = 800)
        val before = titleHeight()
        insets(imeDp = 400)
        assertTrue("host · repo line hidden with the keyboard up on a tablet", shown(CHAT_META_TAG))
        assertEquals("the title shrank with the keyboard up on a tablet", before, titleHeight())
    }

    @Test fun `a landscape phone takes the small title and folds the meta line while typing`() {
        open(widthDp = 914, heightDp = 411)
        // titleMedium's 24sp line, not titleLarge's 28sp.
        assertEquals(24.dp, titleHeight())
        assertTrue("meta line shown with no keyboard", shown(CHAT_META_TAG))
        insets(imeDp = 250)
        assertFalse("meta line still shown with the keyboard up in a short window", shown(CHAT_META_TAG))
        assertEquals(24.dp, titleHeight())
    }

    @Test fun `the footer stays above the navigation bar`() {
        open(widthDp = 411, heightDp = 800)
        insets(navDp = 48)
        val rootB = compose.onNodeWithTag(root).getBoundsInRoot()
        val footer = compose.onNodeWithTag(CHAT_FOOTER_TAG).getBoundsInRoot()
        assertTrue("footer bottom ${footer.bottom} under the navigation bar (from ${rootB.bottom - 48.dp})",
            footer.bottom <= rootB.bottom - 48.dp + 1.dp)
    }

    /** Landscape phone, keyboard up: 411dp tall, status 24dp, keyboard 262dp (font 2.0 default). */
    private fun landscapeTyping(
        sessionBlock: String = "{}", fontScale: Float = 2f, imeDp: Int = 262, statusConsumed: Boolean = false,
    ) {
        open(widthDp = 914, heightDp = 411, fontScale = fontScale, sessionBlock = sessionBlock, statusConsumed = statusConsumed)
        insets(statusDp = 24, imeDp = imeDp)
    }

    @Test fun `a landscape phone at font 2 with the keyboard up shows the whole compose box`() =
        wholeComposeBox(2f, imeDp = 262)

    // 131dp of room: the bar's 64dp + its 24dp status strip + the box don't fit, so the bar
    // steps aside; counted without its status strip, it stayed and covered the box.
    @Test fun `a taller keyboard at font 1 shows the whole compose box`() =
        wholeComposeBox(1f, imeDp = 280)

    // Same room in the two-pane layout, whose scaffold consumed the status bar: the bar is
    // 64dp there and fits beside the box, so it stays (the raw inset over-counted it away).
    @Test fun `a two-pane chat keeps its bar while typing when bar and box fit`() {
        landscapeTyping(fontScale = 1f, imeDp = 280, statusConsumed = true)
        val barH = unclipped(compose.onNodeWithTag(CHAT_TOP_BAR_TAG).fetchSemanticsNode()).height
        assertTrue("the bar stepped aside (height $barH) though it fits beside the box", barH >= 56.dp)
        assertComposeBoxWhole(280)
    }

    private fun wholeComposeBox(fontScale: Float, imeDp: Int) {
        landscapeTyping(fontScale = fontScale, imeDp = imeDp)
        // The bar stepped aside: what is left in its slot is exactly the status strip,
        // measured with its padding (the footer's room is the window less that).
        val strip = unclipped(compose.onNodeWithTag(CHAT_TOP_BAR_TAG).fetchSemanticsNode())
        assertEquals("status strip in the bar's place", 24f, strip.height.value, 0.5f)
        assertComposeBoxWhole(imeDp)
    }

    private fun assertComposeBoxWhole(imeDp: Int) {
        val rootB = compose.onNodeWithTag(root).getBoundsInRoot()
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        val box = unclipped(compose.onNode(hasSetTextAction()).fetchSemanticsNode())
        val keyboardTop = rootB.bottom - imeDp.dp
        assertTrue("compose box top ${box.top} hidden under the top bar (bottom ${bar.bottom})", box.top >= bar.bottom - 0.5.dp)
        assertTrue("compose box bottom ${box.bottom} under the keyboard ($keyboardTop)", box.bottom <= keyboardTop + 0.5.dp)
    }

    @Test fun `a landscape phone at font 2 with the keyboard up keeps a question reachable`() =
        questionReachable(2f)

    // At font 1.0 the bar and the compose box both fit, so the bar stepping aside is the
    // sheet's doing; and the cap alone leaves the sheet nothing: the typing floor holds it.
    @Test fun `a landscape phone at font 1 with the keyboard up keeps a question reachable`() =
        questionReachable(1f)

    // A taller keyboard leaves the cap next to nothing even with the bar aside (111dp of room):
    // the typing floor is what keeps the sheet there at all.
    @Test fun `a taller keyboard still leaves a question reachable`() =
        questionReachable(1f, imeDp = 300)

    private fun questionReachable(fontScale: Float, imeDp: Int = 262) {
        landscapeTyping("""{ "question": "Which one?", "questionOptions": [ $options ] }""", fontScale, imeDp)
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        // The bar stepped aside, the chips yielded: the sheet's foot shows above the box...
        val sheet = compose.onNodeWithTag(WAITING_SHEET_TAG).getBoundsInRoot()
        assertTrue("sheet visible height ${sheet.height}", sheet.height >= 16.dp)
        assertTrue("sheet top ${sheet.top} over the top bar (${bar.bottom})", sheet.top >= bar.bottom - 0.5.dp)
        // ...and scrolling brings its first option into view.
        compose.onNodeWithText("Option number 1").performScrollTo().assertIsDisplayed()
        val opt = compose.onNodeWithText("Option number 1").getBoundsInRoot()
        assertTrue("option ${opt.top} under the top bar (${bar.bottom})", opt.top >= bar.bottom - 0.5.dp)
    }

    // The boundary of the bar-fit check, full-screen at font 1.0: bar 64 + status 24, box row
    // 56 + the compact footer's 4dp padding = 148dp. Exactly that much room keeps the bar...
    @Test fun `the bar stays when bar and box fit exactly`() {
        assertTrue(chatBarFits(room = 148.dp, bar = 88.dp, input = 60.dp))
        assertFalse(chatBarFits(room = 147.dp, bar = 88.dp, input = 60.dp))
        landscapeTyping(fontScale = 1f, imeDp = 411 - 148)
        val barH = unclipped(compose.onNodeWithTag(CHAT_TOP_BAR_TAG).fetchSemanticsNode()).height
        assertTrue("the bar stepped aside (height $barH) with room for both", barH >= 56.dp)
        assertComposeBoxWhole(411 - 148)
    }

    // ...and 2dp less, which only the footer's padding overflows, steps it aside.
    @Test fun `the bar fit counts the compose footer's padding`() =
        wholeComposeBox(1f, imeDp = 411 - 146)

    private val permission = (1..4).joinToString(",") { """{"number":$it,"label":"Choice $it"}""" }.let {
        """{ "panePrompt": { "prompt": "Do you want to proceed?", "detail": "Bash command",
             "id": "0123456789abcdef0123456789abcdef", "options": [ $it ] } }"""
    }

    /**
     * The landscape two-pane chat (283dp tall under the scaffold's bars, status consumed) at
     * font 2.0, keyboard DOWN, tunnel offline: the header's three lines plus the chips and the
     * box left the cap nothing, so the sheet was 0dp. A pending sheet comes first.
     */
    private fun twoPaneSheet(sessionBlock: String, firstOption: String, tunnelOnline: Boolean = false) {
        open(widthDp = 600, heightDp = 283, fontScale = 2f, sessionBlock = sessionBlock,
            tunnelOnline = tunnelOnline, statusConsumed = true)
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        val sheet = compose.onNodeWithTag(WAITING_SHEET_TAG).getBoundsInRoot()
        assertTrue("sheet visible height ${sheet.height}", sheet.height >= 64.dp)
        assertTrue("sheet top ${sheet.top} over the top bar (${bar.bottom})", sheet.top >= bar.bottom - 0.5.dp)
        // The sheet takes ALL the room between the bar and the box (the floor): the cap
        // alone kept a strip of transcript above it and left the sheet less.
        assertTrue("sheet top ${sheet.top} leaves a gap under the bar (${bar.bottom})", sheet.top <= bar.bottom + 1.dp)
        // host · repo yields to the sheet; the tunnel warning stays, alone, only when down.
        assertEquals("tunnel marker", !tunnelOnline, shown(CHAT_MARKER_TAG))
        assertFalse("host · repo still takes a line", shown(CHAT_META_TAG))
        compose.onNodeWithText(firstOption).performScrollTo().assertIsDisplayed()
        assertComposeBoxWhole(0)
    }

    @Test fun `a two-pane chat at font 2 keeps a pending question visible`() =
        twoPaneSheet("""{ "question": "Which one?", "questionOptions": [ $options ] }""", "Option number 1")

    @Test fun `a two-pane chat at font 2 keeps a pending permission prompt visible`() =
        twoPaneSheet(permission, "1. Choice 1")

    // Tunnel up: the header is the title alone (no blank meta line, no "live" marker).
    @Test fun `a two-pane chat with its tunnel up keeps only the title above a pending question`() =
        twoPaneSheet("""{ "question": "Which one?", "questionOptions": [ $options ] }""", "Option number 1",
            tunnelOnline = true)

    /** A node's unclipped extent must lie between the bar's bottom and the compose box's top. */
    private fun assertOpenAndWhole(text: String) {
        val bar = unclipped(compose.onNodeWithTag(CHAT_TOP_BAR_TAG).fetchSemanticsNode())
        val box = unclipped(compose.onNode(hasSetTextAction()).fetchSemanticsNode())
        val t = unclipped(compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode())
        assertTrue("\"$text\" top ${t.top} hidden under the bar (bottom ${bar.bottom})", t.top >= bar.bottom - 0.5.dp)
        assertTrue("\"$text\" bottom ${t.bottom} under the compose box (top ${box.top})", t.bottom <= box.top + 0.5.dp)
        // ...and not cut by its own sheet's viewport: the clipped bounds are the whole text.
        val seen = compose.onNodeWithText(text, useUnmergedTree = true).getBoundsInRoot()
        assertEquals("\"$text\" cut by its sheet ($seen vs $t)", t.height.value, seen.height.value, 0.5f)
    }

    /**
     * A pending sheet's question / prompt shows on OPEN, keyboard down, unclipped and without
     * any scrolling, in every short window: a sheet floor as tall as the whole footer overflowed
     * it by the compose row, and the overflow hid the question under the bar (rollup XERK-1701).
     * Two-pane: 600x283dp, status consumed by the scaffold. Single-pane: a short 686x308dp phone.
     */
    private fun sheetOnOpen(fontScale: Float, twoPane: Boolean, permissionPrompt: Boolean) {
        val block = if (permissionPrompt) permission else """{ "question": "Which one?", "questionOptions": [ $options ] }"""
        if (twoPane) {
            open(widthDp = 600, heightDp = 283, fontScale = fontScale, sessionBlock = block,
                tunnelOnline = false, statusConsumed = true)
        } else {
            open(widthDp = 686, heightDp = 308, fontScale = fontScale, sessionBlock = block, tunnelOnline = false)
            insets(statusDp = 24, navDp = 24)
        }
        assertOpenAndWhole(if (permissionPrompt) "Do you want to proceed?" else "Which one?")
    }

    @Test fun `a question shows on open in a two-pane chat at font 1`() = sheetOnOpen(1f, twoPane = true, permissionPrompt = false)
    @Test fun `a question shows on open in a two-pane chat at font 1_3`() = sheetOnOpen(1.3f, twoPane = true, permissionPrompt = false)
    @Test fun `a question shows on open in a two-pane chat at font 2`() = sheetOnOpen(2f, twoPane = true, permissionPrompt = false)
    @Test fun `a permission prompt shows on open in a two-pane chat at font 1`() = sheetOnOpen(1f, twoPane = true, permissionPrompt = true)
    @Test fun `a permission prompt shows on open in a two-pane chat at font 1_3`() = sheetOnOpen(1.3f, twoPane = true, permissionPrompt = true)
    @Test fun `a permission prompt shows on open in a two-pane chat at font 2`() = sheetOnOpen(2f, twoPane = true, permissionPrompt = true)
    @Test fun `a question shows on open in a single-pane short chat at font 1`() = sheetOnOpen(1f, twoPane = false, permissionPrompt = false)
    @Test fun `a question shows on open in a single-pane short chat at font 1_3`() = sheetOnOpen(1.3f, twoPane = false, permissionPrompt = false)
    @Test fun `a question shows on open in a single-pane short chat at font 2`() = sheetOnOpen(2f, twoPane = false, permissionPrompt = false)
    @Test fun `a permission prompt shows on open in a single-pane short chat at font 1`() = sheetOnOpen(1f, twoPane = false, permissionPrompt = true)
    @Test fun `a permission prompt shows on open in a single-pane short chat at font 1_3`() = sheetOnOpen(1.3f, twoPane = false, permissionPrompt = true)
    @Test fun `a permission prompt shows on open in a single-pane short chat at font 2`() = sheetOnOpen(2f, twoPane = false, permissionPrompt = true)

    // Typing too: the sheet sits whole above the box, its question unclipped.
    @Test fun `a question shows unclipped while typing in a landscape phone`() {
        landscapeTyping("""{ "question": "Which one?", "questionOptions": [ $options ] }""", fontScale = 1f)
        assertOpenAndWhole("Which one?")
    }

    /**
     * The chat composed FRESH with the keyboard already up and a sheet pending (back from the
     * terminal, a rotation): its very first frame already has the bar aside. A guard keeping the
     * bar until the compose row was measured flashed it for a frame.
     */
    @Test fun `a chat composed with the keyboard up and a sheet pending never flashes its bar`() {
        landscapeTyping("""{ "question": "Which one?", "questionOptions": [ $options ] }""", fontScale = 1f)
        compose.runOnIdle { chatShown.value = false }
        compose.waitForIdle()
        compose.mainClock.autoAdvance = false
        compose.runOnIdle { chatShown.value = true }
        // Step frame by frame to the first one in which the chat is on screen.
        var titles = 0
        var frames = 0
        while (frames < 30 && compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isEmpty()) {
            compose.mainClock.advanceTimeByFrame()
            frames++
        }
        titles = compose.onAllNodesWithTag(CHAT_TITLE_TAG, useUnmergedTree = true).fetchSemanticsNodes().size
        compose.mainClock.autoAdvance = true
        assertTrue("the chat never composed", frames < 30)
        assertEquals("the bar flashed on the chat's first frame", 0, titles)
    }

    @Test fun `the tunnel-offline marker stays whole and host-repo stays readable at font 2`() {
        open(widthDp = 411, heightDp = 800, fontScale = 2f, tunnelOnline = false)
        val bar = compose.onNodeWithTag(CHAT_TOP_BAR_TAG).getBoundsInRoot()
        val mark = layout(CHAT_MARKER_TAG)
        assertTrue("marker cut: \"${mark.layoutInput.text}\" lines=${mark.lineCount} ow=${mark.didOverflowWidth} oh=${mark.didOverflowHeight} size=${mark.size} c=${mark.layoutInput.constraints} bar=${bar} title=${titleHeight()}", !mark.hasVisualOverflow && !mark.isLineEllipsized(mark.lineCount - 1))
        assertTrue("marker text", mark.layoutInput.text.text.contains("⚠ tunnel offline"))
        val meta = unclipped(compose.onNodeWithTag(CHAT_META_TAG, useUnmergedTree = true).fetchSemanticsNode())
        val markB = unclipped(compose.onNodeWithTag(CHAT_MARKER_TAG, useUnmergedTree = true).fetchSemanticsNode())
        assertTrue("host · repo squeezed to ${meta.width}", meta.width >= 48.dp)
        assertTrue("host · repo height ${meta.height}", meta.height >= 31.dp)
        assertTrue("marker bottom ${markB.bottom} spills past the bar (${bar.bottom})", markB.bottom <= bar.bottom + 1.dp)
        // host · repo either fits or ends in an ellipsis — never cut mid-word.
        val m = layout(CHAT_META_TAG)
        assertFalse("host · repo clipped without an ellipsis", m.hasVisualOverflow && !m.isLineEllipsized(0))
    }

    @Test fun `the marker shares the line when it fits`() {
        open(widthDp = 914, heightDp = 800, tunnelOnline = false)
        val meta = unclipped(compose.onNodeWithTag(CHAT_META_TAG, useUnmergedTree = true).fetchSemanticsNode())
        val markB = unclipped(compose.onNodeWithTag(CHAT_MARKER_TAG, useUnmergedTree = true).fetchSemanticsNode())
        assertEquals("one line", meta.top.value, markB.top.value, 1.5f)
        assertTrue(chatMetaOneLine(metaWidth = 300, markWidth = 50, available = 200))
        assertFalse(chatMetaOneLine(metaWidth = 300, markWidth = 120, available = 200))
        assertTrue(chatMetaOneLine(metaWidth = 80, markWidth = 120, available = 200))
    }
}
