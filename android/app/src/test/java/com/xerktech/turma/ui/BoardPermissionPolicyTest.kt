package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.vm.BoardViewModel
import com.xerktech.turma.vm.PermissionPolicyUi
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Call-site tests for the board's permission policy sheet (XERK-1566) — the
 * Android port of board.html's `permissionRules*` panel. The text rides its OWN
 * route (`GET|POST /api/jira/<site>/permission-policy`), never `/api/agents`, so
 * these drive that route over the real HTTP stack: the load, a save, the hub's
 * refusal words (XERK-264) with the operator's edit kept (or as a message once
 * the sheet was dismissed mid-save), "Use default" as
 * `{text:null}`, an absent-field body, and the org-less view with no entry. The
 * entry is a labelled item in the header's ⋮ overflow, never a header icon.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    // Same viewport as BoardTriageTest: the board is five 300dp columns wide
    // and the sheet runs taller than Robolectric's default window.
    qualifiers = "w2000dp-h1600dp",
)
class BoardPermissionPolicyTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val route = "/api/jira/acme/permission-policy"

    /** Generous: the first composition in a fresh Robolectric JVM is slow. */
    private val WAIT_MS = 30_000L

    private val jiraBlock = """
        {"available":true,"configured":true,"site":"Acme","siteKey":"acme",
         "user":"op","fetchedAt":"2026-09-01T00:00:00Z","source":"jira",
         "tickets":[
          {"key":"XERK-100","summary":"Untagged","status":"To Do","statusCategory":"todo",
           "priority":"P1","type":"task","project":"XERK","updated":"2026-09-01T00:00:00Z"}
         ]}
    """.trimIndent()

    /** Every POST body the hub saw, in order (the dispatcher drains the buffer). */
    private val posts = CopyOnWriteArrayList<String>()

    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code)
        .setHeader("Content-Type", "application/json").setBody(body)

    /** Serve [get] to a GET and [post] (given the body) to a POST on the route. */
    private fun serve(get: () -> MockResponse, post: (String) -> MockResponse = { get() }) {
        hub.route(route) { req ->
            if (req.method == "POST") {
                val body = req.body.readUtf8()
                posts += body
                post(body)
            } else {
                get()
            }
        }
    }

    private fun openBoard(jira: String? = jiraBlock) {
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(HubHarness.fleetJson(host = "nas01", jira = jira))
        // A VM bound to THIS test's Application, never `viewModel()`'s default:
        // under Robolectric that handed a later test a BoardViewModel still
        // reading an earlier test's container, so the board showed a stale fleet.
        val vm = BoardViewModel(hub.app)
        compose.setContent { BoardScreen(vm = vm) }
        compose.waitForIdle()
    }

    /** Open the header's ⋮ overflow menu. */
    private fun openOverflow() {
        compose.onNodeWithContentDescription("More").performClick()
        compose.waitForIdle()
    }

    /**
     * Open the sheet through the ⋮ overflow's labelled entry and wait out its GET
     * (the field reads "Loading…" until then).
     */
    private fun openSheet() {
        openOverflow()
        click("Permission policy")
        compose.waitUntil(WAIT_MS) {
            compose.onAllNodesWithText("Loading…").fetchSemanticsNodes().isEmpty()
        }
    }

    /**
     * Close the sheet through its own Cancel and wait for it to go, so every
     * test ends at rest (and Cancel is exercised as the way out).
     */
    private fun closeSheet() {
        if (compose.onAllNodesWithText("Cancel").fetchSemanticsNodes().isNotEmpty()) {
            click("Cancel")
        }
        compose.waitUntil(WAIT_MS) {
            compose.onAllNodesWithText("Save policy").fetchSemanticsNodes().isEmpty()
        }
    }

    private fun waitForText(text: String, substring: Boolean = false) {
        compose.waitUntil(WAIT_MS) {
            compose.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty()
        }
    }

    private fun click(text: String) {
        compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }

    @Test
    fun `the sheet loads the org's text from its own route`() {
        serve({ json(200, """{"ok":true,"text":"Allow npm test.","isDefault":false,"defaultText":"D"}""") })
        openBoard()
        openSheet()

        waitForText("Allow npm test.")
        compose.onNodeWithText("Permission policy").assertIsDisplayed()
        // The status is its OWN line (an exact-text node), never mid-explanation.
        compose.onNodeWithText("A custom policy.").assertIsDisplayed()
        // The explanation claims only the deterministic refusal (XERK-1595).
        compose.onNodeWithText(PERMISSION_POLICY_EXPLANATION).assertIsDisplayed()
        assertTrue(
            PERMISSION_POLICY_EXPLANATION.contains(
                "Commands it recognises as force pushes, merges, pushes to main or production " +
                    "changes are refused before the model is asked, whatever this text says.",
            ),
        )
        assertTrue(!PERMISSION_POLICY_EXPLANATION.contains("never auto-approved"))
        compose.onAllNodesWithText("never auto-approved", substring = true).assertCountEquals(0)
        // A custom text can drop back to the default.
        compose.onNodeWithText("Use default").assertIsEnabled()
        compose.onNodeWithText("Save policy").assertIsEnabled()
        closeSheet()
    }

    @Test
    fun `save POSTs the edited text and shows what the hub stored`() {
        serve(
            get = { json(200, """{"ok":true,"text":"old","isDefault":true}""") },
            post = { json(200, """{"ok":true,"text":"Allow cargo test.","isDefault":false}""") },
        )
        openBoard()
        openSheet()
        waitForText("old")

        compose.onNode(hasSetTextAction() and hasText("Policy")).performTextReplacement("Allow cargo test.")
        click("Save policy")

        compose.waitUntil(WAIT_MS) { posts.isNotEmpty() }
        assertEquals("""{"text":"Allow cargo test."}""", posts.single())
        // Success closes the sheet (the triage sheet's pattern).
        compose.waitUntil(WAIT_MS) {
            compose.onAllNodesWithText("Save policy").fetchSemanticsNodes().isEmpty()
        }
    }

    @Test
    fun `a refused save shows the hub's words and keeps the edit`() {
        serve(
            get = { json(200, """{"ok":true,"text":"old","isDefault":true}""") },
            post = { HubHarness.refusal("policy text is longer than 16000 characters", code = 413) },
        )
        openBoard()
        openSheet()
        waitForText("old")

        compose.onNode(hasSetTextAction() and hasText("Policy")).performTextReplacement("my edit")
        click("Save policy")

        waitForText("policy text is longer than 16000 characters")
        // Nothing reported saved: the sheet stays open with the operator's edit.
        compose.onNodeWithText("my edit").assertIsDisplayed()
        compose.onNodeWithText("Save policy").assertIsEnabled()
        assertEquals(1, posts.size)
        closeSheet()
    }

    @Test
    fun `use default POSTs a null text and shows the default`() {
        serve(
            get = { json(200, """{"ok":true,"text":"custom","isDefault":false}""") },
            post = { json(200, """{"ok":true,"text":"The default.","isDefault":true}""") },
        )
        openBoard()
        openSheet()
        waitForText("custom")

        click("Use default")

        waitForText("The default.")
        assertEquals("""{"text":null}""", posts.single())
        compose.onNodeWithText("Showing the default policy.").assertIsDisplayed()
        compose.onNodeWithText("Use default").assertIsNotEnabled()
        closeSheet()
    }

    @Test
    fun `a body with absent fields reads as an empty default policy`() {
        serve({ json(200, """{"ok":true}""") })
        openBoard()
        openSheet()

        compose.onNodeWithText("Showing the default policy.").assertIsDisplayed()
        // An absent `text` reads empty, never "null" or a stale value.
        compose.onNode(hasSetTextAction() and hasText("Policy"))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithText("Use default").assertIsNotEnabled()
        compose.onNodeWithText("Save policy").assertIsEnabled()
        closeSheet()
    }

    @Test
    fun `a refused load shows the hub's words and cannot be saved over`() {
        serve({ HubHarness.refusal("no host reports that Jira org", code = 404) })
        openBoard()
        openSheet()

        waitForText("no host reports that Jira org")
        compose.onNodeWithText("Save policy").assertIsNotEnabled()
        compose.onNodeWithText("Use default").assertIsNotEnabled()
        assertTrue(posts.isEmpty())
        closeSheet()
    }

    @Test
    fun `a refusal landing after the sheet was dismissed still reaches the operator`() {
        // The sheet can be swiped away / backed out of mid-save; its error line
        // goes with it, so the hub's words must arrive as a message instead
        // (board.html's permissionRequest toasts a refusal open or closed).
        val gate = CountDownLatch(1)
        serve(
            get = { json(200, """{"ok":true,"text":"old","isDefault":true}""") },
            post = {
                gate.await(WAIT_MS, TimeUnit.MILLISECONDS)
                HubHarness.refusal("policy text is longer than 16000 characters", code = 413)
            },
        )
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(HubHarness.fleetJson(host = "nas01", jira = jiraBlock))
        val vm = BoardViewModel(hub.app)
        vm.loadPermissionPolicy("acme")
        hub.awaitFlow(vm.permission) { it.loaded }

        val message = hub.expectMessage(vm.messages) { it.startsWith("✗") }
        assertNotNull(vm.savePermissionPolicy("my edit", close = true))
        hub.awaitValue { posts.firstOrNull() }
        vm.closePermissionPolicy()
        gate.countDown()

        assertEquals("✗ policy text is longer than 16000 characters", message())
        // The dismissed sheet's state stays reset: a reopen starts clean.
        assertEquals(PermissionPolicyUi(), vm.permission.value)
    }

    @Test
    fun `the entry is a labelled overflow item, not a header icon`() {
        openBoard()
        // No header icon: a fourth one squeezed the org filter to a bare "…".
        compose.onNodeWithContentDescription("Permission policy").assertDoesNotExist()
        compose.onNodeWithText("Permission policy").assertDoesNotExist()
        openOverflow()
        compose.onNodeWithText("Permission policy").assertIsDisplayed()
        compose.onNodeWithText("Sign out").assertIsDisplayed()
    }

    @Test
    fun `an org-less board offers no permission policy entry`() {
        openBoard(jira = null)
        compose.onNodeWithContentDescription("Permission policy").assertDoesNotExist()
        openOverflow()
        // The ⋮ menu still opens (Sign out), with no policy entry in it.
        compose.onNodeWithText("Sign out").assertIsDisplayed()
        compose.onNodeWithText("Permission policy").assertDoesNotExist()
    }
}
