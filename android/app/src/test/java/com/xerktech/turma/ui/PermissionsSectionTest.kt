package com.xerktech.turma.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
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
        compose.onNodeWithText("Shall I delete legacy/?").assertExists()
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
        val at = text.text.indexOf(Permissions.BEHAVIOUR_NOTE_CODE)
        assertTrue(at > 0)
        val mono = text.spanStyles.filter { it.item.fontFamily == FontFamily.Monospace }
        assertEquals(listOf(at to at + Permissions.BEHAVIOUR_NOTE_CODE.length), mono.map { it.start to it.end })
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
}
