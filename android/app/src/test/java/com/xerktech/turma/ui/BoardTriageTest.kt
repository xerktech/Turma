package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Call-site tests for the Triage lane, verdict chip, detail-row picker, and
 * policy sheet (XERK-486 / XERK-488).
 *
 * The pure lane/verdict logic is pinned in [com.xerktech.turma.core.BoardTest];
 * these tests gate the COMPOSE wiring — that the lane column actually renders,
 * that the verdict chip reads the fleet's ticketTriageActions, that a pick in
 * the detail picker POSTs the hub's wire shape, and that the policy sheet
 * pre-fills from triagePolicies and POSTs the full five-knob patch.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    // The board is five 300dp columns wide and the detail/policy sheets run
    // taller than the default Robolectric viewport. assertIsDisplayed and
    // performClick both key off real window bounds, so without this the
    // off-screen columns and the below-the-fold sheet controls are "not
    // displayed" and simulated taps land on the wrong node.
    qualifiers = "w2000dp-h1600dp",
)
class BoardTriageTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val siteKey = "acme"

    private val jiraBlock = """
        {"available":true,"configured":true,"site":"Acme","siteKey":"acme",
         "user":"op","fetchedAt":"2026-09-01T00:00:00Z","source":"jira",
         "tickets":[
          {"key":"XERK-100","summary":"Untagged","status":"To Do","statusCategory":"todo",
           "priority":"P1","type":"task","project":"XERK","updated":"2026-09-01T00:00:00Z"},
          {"key":"XERK-101","summary":"Held ticket","status":"To Do","statusCategory":"todo",
           "priority":"P2","type":"task","project":"XERK","updated":"2026-09-01T01:00:00Z",
           "triage":{"priority":"P2","type":"task","actionable":true,"at":"2026-09-01T00:00:00Z","source":"hub"}},
          {"key":"XERK-102","summary":"Auto ticket","status":"To Do","statusCategory":"todo",
           "priority":"P2","type":"bug","project":"XERK","updated":"2026-09-01T02:00:00Z",
           "triage":{"priority":"P2","type":"bug","actionable":true,"at":"2026-09-01T00:00:00Z","source":"hub"}},
          {"key":"XERK-103","summary":"Moving","status":"In Progress","statusCategory":"inprogress",
           "priority":"P1","type":"task","project":"XERK","updated":"2026-09-01T03:00:00Z",
           "triage":{"priority":"P1","type":"task","actionable":true,"at":"2026-09-01T00:00:00Z","source":"hub"}}
         ]}
    """.trimIndent()

    private fun openBoard(
        triageActions: String? = """{"acme/XERK-101":{"action":"hold","at":1756684800000}}""",
        triagePolicies: String? = """{"acme":{"minPriority":"P1","excludeTypes":["chore"],"repoAllow":["Turma"],"repoDeny":["bench"],"rateMax":5}}""",
    ) {
        hub.json("/api/ws-token", """{"token":"t"}""")
        hub.seedFleet(
            HubHarness.fleetJson(
                host = "nas01",
                jira = jiraBlock,
                triageActions = triageActions,
                triagePolicies = triagePolicies,
            )
        )
        compose.setContent { BoardScreen() }
        compose.waitForIdle()
    }

    /**
     * The Triage lane column renders ahead of To Do, and the held ticket's
     * verdict chip is visible on the card.
     */
    @Test
    fun `the triage lane renders with the held chip visible`() {
        openBoard()

        // The lane header (uppercased by SectionLabel).
        compose.onNodeWithText("TRIAGE").assertIsDisplayed()

        // The verdict chip on the held card. The board renders from the
        // fleet's StateFlow via collectAsStateWithLifecycle; in a full-class
        // run the first frame may not have the chip composed/laid out yet
        // (openBoard has already seeded the data). Poll until the chip is
        // present AND displayed so the test is deterministic regardless of
        // ordering; the final assert still fails loudly if it never renders.
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            compose.waitForIdle()
            if (compose.onAllNodesWithText("⏸ held").fetchSemanticsNodes().isNotEmpty()) {
                try {
                    compose.onNodeWithText("⏸ held").assertIsDisplayed()
                    break
                } catch (e: AssertionError) {
                    // Present but not yet laid out; keep polling.
                }
            }
            Thread.sleep(25)
        }
        compose.onNodeWithText("⏸ held").assertIsDisplayed()

        // All four tickets are visible somewhere on the board.
        compose.onNodeWithText("XERK-100").assertIsDisplayed()
        compose.onNodeWithText("XERK-101").assertIsDisplayed()
        compose.onNodeWithText("XERK-102").assertIsDisplayed()
        compose.onNodeWithText("XERK-103").assertIsDisplayed()
    }

    /**
     * Opening the detail sheet for a held ticket shows the "⏸ held" picker
     * value and the "— set by you" annotation, confirming the fleet's
     * ticketTriageActions is wired into the UI.
     */
    @Test
    fun `the detail sheet shows the held verdict and marks it as operator-set`() {
        hub.json("/api/jira/$siteKey/XERK-101", """
            {"issue":{"key":"XERK-101","summary":"Held ticket","status":"To Do",
             "statusCategory":"todo","priority":"P2","type":"task",
             "description":"Held ticket description"}}
        """.trimIndent())
        openBoard()

        // Open the detail sheet for the held ticket.
        compose.onNodeWithText("XERK-101").performClick()
        compose.waitForIdle()

        // The Triage section label appears (column header + sheet section = 2 "TRIAGE").
        assertEquals(
            "expected 2 'TRIAGE' nodes (column header + detail sheet section)",
            2, compose.onAllNodesWithText("TRIAGE").fetchSemanticsNodes().size
        )

        // "— set by you" confirms the verdict came from the operator.
        compose.onNodeWithText("— set by you").assertIsDisplayed()

        // The picker value "⏸ held" appears twice: card chip + sheet picker.
        assertEquals(
            "expected 2 '⏸ held' nodes (card chip + sheet picker)",
            2, compose.onAllNodesWithText("⏸ held").fetchSemanticsNodes().size
        )
    }

    /**
     * Picking a verdict in the detail sheet POSTs the hub's wire shape to
     * /api/jira/{site}/{key}/triage.
     */
    @Test
    fun `picking a triage verdict POSTs the action to the hub`() {
        hub.json("/api/jira/$siteKey/XERK-100", """
            {"issue":{"key":"XERK-100","summary":"Untagged","status":"To Do",
             "statusCategory":"todo","priority":"P1","type":"task",
             "description":"Untagged ticket"}}
        """.trimIndent())
        hub.json("/api/jira/$siteKey/XERK-100/triage", """{"ok":true}""")

        // No triage actions — XERK-100 has no verdict (picker shows "Auto").
        openBoard(triageActions = null)

        // Open the detail sheet for the untriaged ticket.
        compose.onNodeWithText("XERK-100").performClick()
        compose.waitForIdle()

        // The Triage picker shows "Auto" (exact match, not the agent's "Auto — most available agent").
        compose.onNodeWithText("Auto", substring = false).assertIsDisplayed()

        // Open the picker and select "Hold".
        // performSemanticsAction bypasses touch-injection (Robolectric popups
        // don't receive dispatched touches); it invokes OnClick directly.
        compose.onNodeWithText("Auto", substring = false)
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        compose.onNodeWithText("Hold — never auto-start until released")
            .performSemanticsAction(SemanticsActions.OnClick)

        // Wait for the POST to arrive at the mock server.
        val req = hub.findRequest("/XERK-100/triage")
        assertEquals("POST", req.method)
        val body = req.body.readUtf8()
        assertTrue("body should contain action=hold: $body", body.contains("\"action\":\"hold\""))
        assertTrue("body should NOT contain clear: $body", !body.contains("\"clear\""))
    }

    /**
     * The policy sheet pre-fills from the fleet's triagePolicies and POSTs the
     * full five-knob patch on save.
     */
    @Test
    fun `the policy sheet pre-fills from the hub and POSTs the full patch on save`() {
        hub.json("/api/jira/$siteKey/triage-policy", """
            {"ok":true,"policy":{"minPriority":"P1","excludeTypes":["chore"],
             "repoAllow":["Turma"],"repoDeny":["bench"],"rateMax":5}}
        """.trimIndent())

        openBoard()

        // Open the policy sheet via the header Tune icon.
        compose.onNodeWithContentDescription("Triage policy").performClick()
        compose.waitForIdle()

        // The title is visible and the min-priority picker shows the seeded value.
        compose.onNodeWithText("Triage policy").assertIsDisplayed()
        compose.onNodeWithText("P1 and higher").assertIsDisplayed()

        // Save without changes — should POST the full patch matching the seeded policy.
        // performSemanticsAction: the sheet is a ModalBottomSheet popup, and
        // Robolectric's touch-injection does not reach popup windows, but the
        // OnClick action invocation does (same handler the real click runs).
        compose.onNodeWithText("Save policy").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()

        val req = hub.findRequest("/acme/triage-policy")
        assertEquals("POST", req.method)
        val body = req.body.readUtf8()
        assertTrue("body should contain minPriority P1: $body", body.contains("\"minPriority\":\"P1\""))
        assertTrue("body should contain excludeTypes chore: $body", body.contains("\"chore\""))
        assertTrue("body should contain repoAllow Turma: $body", body.contains("\"Turma\""))
        assertTrue("body should contain repoDeny bench: $body", body.contains("\"bench\""))
        assertTrue("body should contain rateMax 5: $body", body.contains("\"rateMax\":5"))
    }

    // The rateMax validation boundary (1..50, empty = default) is gated by the
    // pure `rateMaxError` test in core/BoardTest — the compose-level
    // text-input path is not exercised here.
}
