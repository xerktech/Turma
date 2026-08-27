package com.xerktech.turma.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * The dsh Trajectory SCREEN composes (XERK-498) — the render path the VM/format
 * tests do not reach. It drives the real `TrajectoryScreen` over a seeded
 * `/api/dsh/<tid>/trajectory`, so the header card, turn cards and call rows are
 * actually composed. The edge branches (empty turns, a null-`ok` call, the 404
 * "not synced yet" message) are the ones a live viewer hits on a running dsh
 * session and are exercised here rather than only read.
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
    fun `it composes the header, turns and tool calls`() {
        // Two calls, one with a null `ok` (still running) — the "•" branch — and a
        // Long token count that must not be narrowed to Int (the trajNum overload).
        open(
            """
            {"transcriptId":"tr1","title":"my dsh session","model":"deepseek",
             "durationMs":1500,
             "totals":{"turns":1,"steps":2,"toolCalls":2,"errors":0,
                       "tokens":{"input":3000000000,"output":5,"cacheRead":0,"cacheWrite":0}},
             "turns":[{"turn":1,"startedAt":1000,"endedAt":1600,"reason":"stop","steps":2,
                       "tokens":{"input":12,"output":5},
                       "calls":[{"name":"bash","callId":"c1","at":1100,"ok":true,"args":"ls","durationMs":40},
                                {"name":"read_file","callId":"c2","at":1200,"ok":null,"args":"x.txt"}]}]}
            """.trimIndent(),
        )
        compose.onNodeWithText("Turn 1").assertExists()
        compose.onNodeWithText("bash").assertExists()
        compose.onNodeWithText("read_file").assertExists()
        // The 3e9 input token count renders in full (grouped), proving the Long
        // path is not truncated through Int.
        compose.onNodeWithText("3,000,000,000", substring = true).assertExists()
    }

    @Test
    fun `an empty turn list says so instead of rendering nothing`() {
        open(
            """{"transcriptId":"tr1","title":"quiet","totals":{"turns":0,"steps":0,"toolCalls":0,
                "errors":0,"tokens":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}},"turns":[]}""",
        )
        compose.onNodeWithText("No turns recorded yet.").assertExists()
    }

    @Test
    fun `a 404 shows the not-synced-yet message, not an error`() {
        open("""{"error":"no dsh trajectory for this session"}""", code = 404)
        compose.onNodeWithText("No dsh trajectory yet", substring = true).assertExists()
    }
}
