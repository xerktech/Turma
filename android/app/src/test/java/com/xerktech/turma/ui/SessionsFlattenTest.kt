package com.xerktech.turma.ui

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsFlattenTest {

    private fun agent(key: String, device: String, online: Boolean, sessions: List<SessionInfo>) =
        AgentInfo(key = key, device = device, online = online, sessions = sessions)

    @Test fun `flattens sessions across hosts, running first`() {
        val agents = listOf(
            agent("h1", "MAXAI", true, listOf(
                SessionInfo(id = "a", status = "stopped", summary = "Idle one", repo = "turma"),
                SessionInfo(id = "b", status = "running", summary = "Busy one", repo = "turma"),
            )),
            agent("h2", "BOX", true, listOf(
                SessionInfo(id = "c", status = "running", summary = "Other", repo = "docker"),
            )),
        )
        val rows = flattenSessions(agents, "")
        assertEquals(3, rows.size)
        // running sessions sort ahead of stopped.
        assertEquals("running", rows[0].session.status)
        assertEquals("running", rows[1].session.status)
        assertEquals("stopped", rows[2].session.status)
    }

    @Test fun `query filters by summary, repo, or device`() {
        val agents = listOf(
            agent("h1", "MAXAI", true, listOf(
                SessionInfo(id = "a", status = "running", summary = "Fix login", repo = "turma"),
                SessionInfo(id = "b", status = "running", summary = "Docker stuff", repo = "dockerops"),
            )),
        )
        assertEquals(listOf("a"), flattenSessions(agents, "login").map { it.session.id })
        assertEquals(listOf("b"), flattenSessions(agents, "dockerops").map { it.session.id })
        assertEquals(2, flattenSessions(agents, "maxai").size) // device match
        assertEquals(0, flattenSessions(agents, "nomatch").size)
    }
}
