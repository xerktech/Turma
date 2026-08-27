package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import com.xerktech.turma.model.TrajCall
import com.xerktech.turma.model.TrajTurn
import com.xerktech.turma.model.TrajTurnTokens
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * The dsh Trajectory render path (XERK-498) — what the VM/format tests do not
 * reach. Split so nothing depends on a LazyColumn's viewport: the WHOLE screen
 * is composed over a seeded `/api/dsh/<tid>/trajectory` and asserted on its
 * always-composed header (item 0) + the non-lazy empty/404 messages; the turn
 * card and its call rows are exercised as an ISOLATED composable, so a short CI
 * viewport can neither leave a row uncomposed nor drop the scroll action (both
 * of which broke a scroll-based version — see `.claude/rules/android.md`).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TrajectoryScreenTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<ComponentActivity>()

    private val tid = "tr1"
    private var savedLocale: Locale = Locale.getDefault()

    // Robolectric shares one JVM across the suite, so restore the default locale
    // (grouping separators depend on it) rather than leaking US into later tests.
    @Before
    fun pinLocale() {
        savedLocale = Locale.getDefault()
        Locale.setDefault(Locale.US)
    }

    @After
    fun restoreLocale() {
        Locale.setDefault(savedLocale)
    }

    private fun open(json: String, code: Int = 200) {
        hub.json("/api/dsh/$tid/trajectory", json, code = code)
        compose.setContent { TrajectoryScreen(host = "nas01", transcriptId = tid, onBack = {}) }
        compose.waitForIdle()
    }

    @Test
    fun `the screen composes and renders the header token totals in full`() {
        // The header is LazyColumn item 0 — always composed, so `assertExists`
        // needs no scroll. The 3e9 input token renders in full (grouped), which
        // proves the whole screen composed over the real fetch AND that the Long
        // token path is not narrowed through Int.
        open(
            """
            {"transcriptId":"tr1","title":"my dsh session","model":"deepseek","durationMs":1500,
             "totals":{"turns":1,"steps":2,"toolCalls":2,"errors":0,
                       "tokens":{"input":3000000000,"output":5,"cacheRead":0,"cacheWrite":0}},
             "turns":[{"turn":1,"steps":2,"tokens":{"input":12,"output":5},"calls":[]}]}
            """.trimIndent(),
        )
        compose.onNodeWithText("3,000,000,000", substring = true).assertExists()
        compose.onNodeWithText("deepseek").assertExists()
    }

    @Test
    fun `an empty turn list says so instead of rendering nothing`() {
        // Header "quiet" + the one-line message both fit any viewport, so the
        // message item composes without a scroll.
        open(
            """{"transcriptId":"tr1","title":"quiet","totals":{"turns":0,"steps":0,"toolCalls":0,
                "errors":0,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}},"turns":[]}""",
        )
        compose.onNodeWithText("No turns recorded yet.").assertExists()
    }

    @Test
    fun `a 404 shows the not-synced-yet message, not an error`() {
        // The 404 branch renders outside the LazyColumn (a centered Box), so it
        // is always composed.
        open("""{"error":"no dsh trajectory for this session"}""", code = 404)
        compose.onNodeWithText("No dsh trajectory yet", substring = true).assertExists()
    }

    @Test
    fun `a turn card renders its tool calls, including a still-running one`() {
        // TurnCard in ISOLATION (not inside the screen's LazyColumn), so it is
        // always composed regardless of viewport. `read_file` has a null `ok`
        // (still running) — the "•" branch — beside a completed `bash`.
        val turn = TrajTurn(
            turn = 7,
            steps = 2,
            reason = "stop",
            tokens = TrajTurnTokens(input = 12, output = 5),
            calls = listOf(
                TrajCall(name = "bash", callId = "c1", ok = true, args = "ls", durationMs = 40.0),
                TrajCall(name = "read_file", callId = "c2", ok = null, args = "x.txt"),
            ),
        )
        compose.setContent { TurnCard(turn) }
        compose.waitForIdle()
        compose.onNodeWithText("Turn 7").assertExists()
        compose.onNodeWithText("bash").assertExists()
        compose.onNodeWithText("read_file").assertExists()
        compose.onNodeWithText("ls").assertExists()
    }
}
