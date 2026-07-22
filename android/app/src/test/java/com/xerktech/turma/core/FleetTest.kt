package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.Capacity
import com.xerktech.turma.model.LiveSignals
import com.xerktech.turma.model.ModelUsage
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.model.UsageBucket
import com.xerktech.turma.model.UsageInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/** Parity with turma/public/index.html's summary-tile reducers. */
class FleetTest {

    private fun bucket(total: Long) = UsageBucket(input = total)

    private fun agent(
        key: String,
        online: Boolean = true,
        device: String = key,
        usage: UsageInfo? = null,
        sessions: List<SessionInfo> = emptyList(),
        capacity: Capacity? = null,
    ) = AgentInfo(key = key, device = device, online = online, sessions = sessions, usage = usage,
        capacity = capacity)

    private fun session(status: String, question: String = "", usage: UsageInfo? = null) =
        SessionInfo(id = status, status = status, usage = usage, session = LiveSignals(question = question))

    @Test fun `fleet tokens sum the persistent usage block per window`() {
        val a = agent("h1", usage = UsageInfo(today = bucket(10), week = bucket(20), totals = bucket(100)))
        val b = agent("h2", usage = UsageInfo(today = bucket(5), week = bucket(7), totals = bucket(50)))
        val agents = listOf(a, b)
        assertEquals(15, fleetTokens(agents, UsageWindow.TODAY))
        assertEquals(27, fleetTokens(agents, UsageWindow.WEEK))
        assertEquals(150, fleetTokens(agents, UsageWindow.TOTALS))
    }

    @Test fun `a host with no usage block falls back to summing its sessions`() {
        val old = agent("old", usage = null, sessions = listOf(
            session("running", usage = UsageInfo(today = bucket(3))),
            session("stopped", usage = UsageInfo(today = bucket(4))),
        ))
        assertEquals(7, fleetTokens(listOf(old), UsageWindow.TODAY))
    }

    @Test fun `top models merge by name across hosts, biggest first, cleaned`() {
        val a = agent("h1", usage = UsageInfo(models = listOf(
            ModelUsage("claude-opus-4-8-20260101", totals = bucket(100)),
            ModelUsage("claude-haiku-4-5", totals = bucket(10)),
        )))
        val b = agent("h2", usage = UsageInfo(models = listOf(
            ModelUsage("claude-haiku-4-5", totals = bucket(50)),
        )))
        // opus 100 vs haiku 60 -> opus first; claude- prefix and -YYYYMMDD stripped.
        assertEquals("opus-4-8, haiku-4-5", fleetTopModels(listOf(a, b)))
    }

    @Test fun `top models is a dash when nothing reported`() {
        assertEquals("–", fleetTopModels(listOf(agent("h1"))))
    }

    @Test fun `summary counts hosts, running, and waiting-on-you`() {
        val a = agent("h1", online = true, sessions = listOf(
            session("running", question = "Which option?"),
            session("running"),
            session("stopped", question = "ignored — not running"),
        ))
        val b = agent("h2", online = false)
        val s = fleetSummary(listOf(a, b))
        assertEquals(1, s.hostsOnline)
        assertEquals(2, s.hostsTotal)
        assertEquals(2, s.running)
        assertEquals(3, s.totalSessions)
        assertEquals(1, s.waiting) // only the running one with a question
    }

    @Test fun `max sessions sums the per-agent cap across the org's hosts`() {
        val a = agent("h1", capacity = Capacity(maxSessions = 4))
        val b = agent("h2", capacity = Capacity(maxSessions = 6))
        assertEquals(10, fleetSummary(listOf(a, b)).maxSessions)
    }

    @Test fun `max sessions is null when no host reports a capacity block`() {
        assertEquals(null, fleetSummary(listOf(agent("old"))).maxSessions)
    }

    @Test fun `max sessions sums only the hosts that report a capacity block`() {
        val a = agent("h1", capacity = Capacity(maxSessions = 4))
        val b = agent("old") // pre-capacity agent, no ceiling reported
        assertEquals(4, fleetSummary(listOf(a, b)).maxSessions)
    }
}
