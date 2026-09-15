package com.xerktech.turma.net

import com.xerktech.turma.harness.HubHarness
import com.xerktech.turma.harness.MainDispatcherRule
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * `FleetRepository` must never regress a record to an OLDER snapshot (XERK-812).
 *
 * The `/api/agents` poll and the `nudge()` fired after answering a question race,
 * and a response captured before the agent advanced to the next question can land
 * after we answered it. A blind `byKey.clear()` + overwrite then bounces the
 * stale question back onto the chat card — the erratic q3→q2 jump in the report.
 * The fix keeps a record we already hold fresher by `lastSeen` (stamped fresh on
 * every heartbeat), the Android analogue of the web's mergeSnapshot guard
 * (XERK-444), which this repo was wrongly assumed to be structurally immune to.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FleetFreshnessTest {

    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val hub = HubHarness()

    private fun snapshot(lastSeen: Long, question: String) = """
        {"now": $lastSeen, "agents": [{
          "key": "h1", "device": "h1", "online": true, "terminalOnline": true,
          "lastSeen": $lastSeen,
          "repos": [{"name": "Turma", "lastActivity": "2026-08-12T00:00:00Z"}],
          "sessions": [{ "id": "s1", "repo": "Turma", "session": { "question": "$question" } }]
        }]}
    """.trimIndent()

    private fun poll(lastSeen: Long, question: String) {
        hub.json("/api/agents", snapshot(lastSeen, question))
        runBlocking { hub.container.fleet.refresh() }
    }

    private fun currentQuestion(): String =
        hub.container.fleet.state.value.agents.first().sessions.first().session?.question ?: ""

    @Test
    fun `a stale poll cannot regress a record to an older question`() {
        poll(lastSeen = 200, question = "Q3")
        assertEquals("Q3", currentQuestion())

        // A poll whose response was captured earlier (older lastSeen) lands late —
        // it must NOT drag the record back to the already-answered question.
        poll(lastSeen = 100, question = "Q2")
        assertEquals("Q3", currentQuestion())

        // A genuinely newer beat still advances it (here: the question clears).
        poll(lastSeen = 300, question = "")
        assertEquals("", currentQuestion())
    }

    @Test
    fun `an equal-timestamp poll is accepted (not treated as stale)`() {
        poll(lastSeen = 200, question = "Q1")
        // Same lastSeen, different content: only STRICTLY older is rejected, so a
        // same-ms update still lands rather than being wrongly held back.
        poll(lastSeen = 200, question = "Q2")
        assertEquals("Q2", currentQuestion())
    }
}
