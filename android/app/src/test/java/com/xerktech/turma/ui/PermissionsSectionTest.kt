package com.xerktech.turma.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.em
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.xerktech.turma.core.Permissions
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.PermissionGroup
import com.xerktech.turma.model.PermissionRow
import com.xerktech.turma.model.PermissionSummary
import com.xerktech.turma.vm.UsageViewModel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The "Permission prompts (7 days)" section (XERK-1576), composed in isolation
 * so a short viewport can never leave it an uncomposed LazyColumn row. Wording
 * is usage.html's `permissionsCardHtml`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PermissionsSectionTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val now = 2_000_000_000_000L

    private val populated = PermissionSummary(
        days = 7,
        top = listOf(
            PermissionGroup(kind = "dialog", dialogKind = "permission", tool = "Bash", head = "git status",
                count = 3, allowed = 2, denied = 1, open = 0, medianWaitMs = 45_000.0,
                suggestedRule = "Bash(git status:*)"),
            PermissionGroup(kind = "ask-in-chat", prompt = "Shall I delete `legacy/`?", count = 2,
                open = 0, suggestedRule = "model behaviour: see CLAUDE.md step 0"),
            PermissionGroup(kind = "classifier-denied", tool = "Bash", head = "curl", count = 1,
                allowed = 0, denied = 1, open = 0, noRuleReason = "not on the read-only list",
                denyReason = "network egress"),
        ),
        recent = listOf(
            PermissionRow(host = "nas01", kind = "dialog", head = "git status", answer = "allow",
                waitedMs = 45_000.0, openedAt = (now - 120_000).toDouble(), closedAt = now.toDouble()),
        ),
    )

    private fun show(ui: UsageViewModel.PermissionsUi) {
        // Scrollable, as on the screen, so a node below the fold can be scrolled to.
        compose.setContent {
            Column(Modifier.verticalScroll(rememberScrollState())) { PermissionsSection(ui, nowMs = now) }
        }
        compose.waitForIdle()
    }

    @Test
    fun `the populated card shows each group, its numbers, rule and the ask note`() {
        show(UsageViewModel.PermissionsUi(view = populated))
        compose.onNodeWithText("Permission prompts (7 days)").assertExists()
        compose.onNodeWithText("git status").assertExists()
        compose.onNodeWithText("Count 3").assertExists()
        compose.onNodeWithText("Allowed / denied 2 / 1").assertExists()
        compose.onNodeWithText("Median wait 45s").assertExists()
        compose.onNodeWithText(Permissions.ruleDisplay("Bash(git status:*)")).assertExists()
        // The ask: its question rendered (no backticks), no answers cell, the pointer row + one note.
        compose.onNodeWithText(permProseText("Shall I delete `legacy/`?").text).assertExists()
        compose.onNodeWithText(Permissions.BEHAVIOUR_ROW).assertExists()
        compose.onNodeWithText("Asked in chat has no setting to copy", substring = true).assertExists()
        // The classifier block: no rule, and why it was blocked.
        compose.onNodeWithText("no safe rule — review it").assertExists()
        compose.onNodeWithText("Blocked: network egress").assertExists()
    }

    @Test
    fun `Copy puts the raw rule on the clipboard`() {
        show(UsageViewModel.PermissionsUi(view = populated))
        compose.onNodeWithText("Copy").performScrollTo().performClick()
        compose.waitForIdle()
        val clip = (hub.app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
        assertEquals("Bash(git status:*)", clip?.getItemAt(0)?.text?.toString())
    }

    // Real text metrics: legacy graphics measures text with stub fonts, so sizes there mean nothing.
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test
    fun `Copy is a compact button no taller than the rule box beside it`() {
        // The web's `.perm-copy` sits level with the rule's code box; a Material
        // button's 40dp minimum would stand twice its height and gap the stats line.
        show(UsageViewModel.PermissionsUi(view = populated))
        val copy = compose.onNodeWithText("Copy").performScrollTo().getBoundsInRoot()
        val rule = compose.onNodeWithText(Permissions.ruleDisplay("Bash(git status:*)")).getBoundsInRoot()
        val copyH = copy.bottom - copy.top
        // The rule node's bounds are its text; its box adds 2dp of padding above and below.
        val ruleH = rule.bottom - rule.top + 4.dp
        assertTrue("Copy $copy vs rule $rule", copyH <= ruleH + 1.dp)
        assertTrue("Copy $copyH is a 40dp Material button", copyH < 32.dp)
        compose.onNodeWithText("Copy").assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    }

    @Test
    fun `the ask note shows the CLAUDE md path as code, as the web does`() {
        show(UsageViewModel.PermissionsUi(view = populated))
        val text = compose.onNodeWithText("Asked in chat has no setting to copy", substring = true)
            .fetchSemanticsNode().config[SemanticsProperties.Text].single()
        val path = Permissions.unbreakable(Permissions.BEHAVIOUR_NOTE_CODE)
        val at = text.text.indexOf(path)
        assertTrue(at > 0)
        val mono = text.spanStyles.filter { it.item.fontFamily == FontFamily.Monospace }
        assertEquals(listOf(at to at + path.length), mono.map { it.start to it.end })
        assertTrue(text.spanStyles.any { it.item.fontWeight == FontWeight.Bold && it.start == 0 })
    }

    @Test
    fun `recent prompts open under their disclosure with host, wait and age`() {
        show(UsageViewModel.PermissionsUi(view = populated))
        compose.onNodeWithText("nas01").assertDoesNotExist()
        compose.onNodeWithText("▸ Recent prompts (1)").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("nas01").assertExists()
        compose.onNodeWithText("waited 45s · allow").assertExists()
        compose.onNodeWithText("2m ago").assertExists()
    }

    @Test
    fun `the open disclosure survives an org change's loading state`() {
        // The web's `permRecentOpen` is page-level: a scope change repaints the
        // card through "Loading…" and the list comes back still open.
        var ui by mutableStateOf(UsageViewModel.PermissionsUi(view = populated))
        compose.setContent {
            Column(Modifier.verticalScroll(rememberScrollState())) { PermissionsSection(ui, nowMs = now) }
        }
        compose.onNodeWithText("▸ Recent prompts (1)").performScrollTo().performClick()
        compose.waitForIdle()
        compose.onNodeWithText("nas01").assertExists()
        ui = UsageViewModel.PermissionsUi()
        compose.waitForIdle()
        compose.onNodeWithText("Loading…").assertExists()
        ui = UsageViewModel.PermissionsUi(view = populated)
        compose.waitForIdle()
        compose.onNodeWithText("▾ Recent prompts (1)").assertExists()
        compose.onNodeWithText("nas01").assertExists()
    }

    @Test
    fun `an empty window says so for the selected orgs`() {
        show(UsageViewModel.PermissionsUi(view = PermissionSummary(days = 7)))
        compose.onNodeWithText("No permission prompts recorded in the last 7 days for the selected orgs.")
            .assertExists()
    }

    @Test
    fun `a refused read shows the hub's words, never a blank section`() {
        // The real refusal, through the real stack and view model.
        hub.route("/api/permissions") { HubHarness.refusal("permission ledger unavailable", code = 503) }
        val vm = UsageViewModel(hub.app)
        runBlocking { vm.refreshPermissions(listOf("acme")).join() }
        show(vm.permissions.value)
        compose.onNodeWithText("Could not load permission prompts (permission ledger unavailable).")
            .assertExists()
    }

    @Test
    fun `before the first answer the card says loading`() {
        show(UsageViewModel.PermissionsUi())
        compose.onNodeWithText("Loading…").assertExists()
    }

    private fun textLayout(node: SemanticsNode): TextLayoutResult {
        val out = mutableListOf<TextLayoutResult>()
        node.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(out)
        return out.single()
    }

    @Test
    fun `an ask's inline code is a mono run padded and tagged as one chip`() {
        // Web `permProseHtml` + `.perm-subj code`: rendered (no backticks), mono at
        // 0.92em, and boxed — the box (padding included) is the tagged range.
        show(UsageViewModel.PermissionsUi(view = populated))
        val text = compose.onNodeWithText(permProseText("Shall I delete `legacy/`?").text)
            .fetchSemanticsNode().config[SemanticsProperties.Text].single()
        assertEquals("Shall I delete \u202Flegacy/\u202F?", text.text)
        val code = text.text.indexOf("legacy/")
        val mono = text.spanStyles.single { it.item.fontFamily == FontFamily.Monospace }
        assertEquals(code to code + "legacy/".length, mono.start to mono.end)
        assertEquals(0.92.em, mono.item.fontSize)
        val chip = text.getStringAnnotations(PERM_CODE_TAG, 0, text.length).single()
        assertEquals(code - 1 to code + "legacy/".length + 1, chip.start to chip.end)
    }

    // Real text metrics + real drawing: legacy graphics neither lays out nor paints text faithfully.
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test
    fun `an ask's inline code is drawn as a hairline box on the page background`() {
        // Distinct theme colours so the chip's fill (page background) and its hairline
        // (outlineVariant) can be told apart from the card and the glyphs in pixels.
        val fill = Color(0xFFFFFF00)
        val hairline = Color(0xFFFF0000)
        compose.setContent {
            MaterialTheme(colorScheme = lightColorScheme(background = fill, outlineVariant = hairline)) {
                Column(Modifier.background(Color.White).verticalScroll(rememberScrollState())) {
                    PermissionsSection(UsageViewModel.PermissionsUi(view = populated), nowMs = now)
                }
            }
        }
        compose.waitForIdle()
        val subject = compose.onNodeWithText(permProseText("Shall I delete `legacy/`?").text)
        val rect = codeChipRects(textLayout(subject.fetchSemanticsNode()), 1f).single()
        assertTrue("chip $rect starts after the prose", rect.left > 0f && rect.width > 0f)
        // Drawn by hand: Robolectric never delivers the frame `captureToImage` waits for.
        val bounds = subject.fetchSemanticsNode().boundsInRoot
        val view = compose.activity.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0)
        lateinit var bmp: android.graphics.Bitmap
        compose.runOnUiThread {
            bmp = android.graphics.Bitmap.createBitmap(view.width, view.height, android.graphics.Bitmap.Config.ARGB_8888)
            view.draw(android.graphics.Canvas(bmp))
        }
        val x0 = bounds.left.toInt()
        val width = bounds.width.toInt()
        val y = bounds.top.toInt() + rect.center.y.toInt()
        val row = (0 until width).map { Color(bmp.getPixel(x0 + it, y)) }
        fun reddish(c: Color) = c.red > 0.75f && c.green < 0.5f && c.blue < 0.5f
        fun yellowish(c: Color) = c.red > 0.8f && c.green > 0.8f && c.blue < 0.35f
        val l = rect.left.toInt()
        val r = rect.right.toInt().coerceAtMost(width - 1)
        assertTrue("a hairline at the chip's left edge", (maxOf(0, l - 1)..l + 2).any { reddish(row[it]) })
        assertTrue("a hairline at the chip's right edge", (r - 2..minOf(width - 1, r + 1)).any { reddish(row[it]) })
        assertTrue("the page background inside the chip", (l + 1 until r).any { yellowish(row[it]) })
        // Only the code run is boxed: nothing of it on the prose before it.
        assertTrue("no box on the prose", (0 until l - 2).none { reddish(row[it]) || yellowish(row[it]) })
    }

    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test
    fun `the CLAUDE md path in the ask note never breaks across lines at phone widths`() {
        // At 411dp the path split after `~/.claude/`; it must move to the next line whole.
        var width by mutableStateOf(411)
        compose.setContent {
            Column(Modifier.requiredWidth(width.dp).verticalScroll(rememberScrollState())) {
                PermissionsSection(UsageViewModel.PermissionsUi(view = populated), nowMs = now)
            }
        }
        for (w in 260..520 step 2) {
            width = w
            compose.waitForIdle()
            val layout = textLayout(
                compose.onNodeWithText("Asked in chat has no setting to copy", substring = true).fetchSemanticsNode(),
            )
            // The path is the note's one mono run.
            val code = layout.layoutInput.text.spanStyles.single { it.item.fontFamily == FontFamily.Monospace }
            assertEquals(Permissions.BEHAVIOUR_NOTE_CODE,
                layout.layoutInput.text.text.substring(code.start, code.end).replace(Permissions.WORD_JOINER, ""))
            assertEquals("path split at ${w}dp", layout.getLineForOffset(code.start), layout.getLineForOffset(code.end - 1))
        }
    }

    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Test
    fun `a recent row keeps its subject beside the chip and wraps it there, an ask included`() {
        // Web phone `.perm-recent .perm-subj { flex: 1 1 0 }`: the subject takes the
        // width the chip leaves and wraps INSIDE it — never dropped to its own line.
        val ask = "Shall I go ahead and open the pull request against main now that every test passes?"
        val cmd = "git log --oneline --decorate --graph --all --max-count=200 -- android/app/src/main/java"
        val view = populated.copy(
            top = populated.top.take(1),
            recent = listOf(
                PermissionRow(host = "k8x-2", kind = "ask-in-chat", prompt = ask, openedAt = (now - 60_000).toDouble()),
                PermissionRow(host = "nas01", kind = "dialog", head = cmd, answer = "allow", waitedMs = 5_000.0,
                    openedAt = (now - 120_000).toDouble(), closedAt = now.toDouble()),
            ),
        )
        compose.setContent {
            Column(Modifier.requiredWidth(360.dp).verticalScroll(rememberScrollState())) {
                PermissionsSection(UsageViewModel.PermissionsUi(view = view), nowMs = now)
            }
        }
        compose.onNodeWithText("▸ Recent prompts (2)").performScrollTo().performClick()
        compose.waitForIdle()
        for ((label, subject) in listOf("Asked in chat" to ask, "Dialog" to cmd)) {
            // The recent row's chip is the lowest one carrying that label (a group above may share it).
            val chip = compose.onAllNodesWithText(label).fetchSemanticsNodes().maxBy { it.boundsInRoot.top }.boundsInRoot
            val subj = compose.onNodeWithText(subject).fetchSemanticsNode().boundsInRoot
            assertTrue("$label: subject $subj beside chip $chip", subj.left >= chip.right)
            assertTrue("$label: subject $subj starts on the chip's line $chip", subj.top < chip.bottom)
            assertTrue("$label: subject $subj wraps in its column", subj.height > chip.height * 1.5f)
        }
    }
}
