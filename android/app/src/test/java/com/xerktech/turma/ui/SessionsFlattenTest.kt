package com.xerktech.turma.ui

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.RepoInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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

    // ---- spawnTargets (the New-session picker's source list) -----------------

    private fun agentWithRepos(
        key: String, device: String, online: Boolean,
        repos: List<RepoInfo>, sessions: List<SessionInfo> = emptyList(),
    ) = AgentInfo(key = key, device = device, online = online, repos = repos, sessions = sessions)

    @Test fun `spawnTargets lists only online hosts with repos, device-labelled`() {
        val agents = listOf(
            agentWithRepos("h1", "MAXAI", true, listOf(RepoInfo(name = "turma"), RepoInfo(name = "docker"))),
            agentWithRepos("h2", "OFF", false, listOf(RepoInfo(name = "turma"))), // offline → dropped
            agentWithRepos("h3", "", true, emptyList()), // no repos → dropped
        )
        val targets = spawnTargets(agents)
        assertEquals(1, targets.size)
        assertEquals("h1", targets[0].key)
        assertEquals("MAXAI", targets[0].device)
        assertEquals(listOf("turma", "docker"), targets[0].repos.map { it.name })
    }

    @Test fun `spawnTargets blank device falls back to host key`() {
        val targets = spawnTargets(listOf(agentWithRepos("host-key", "", true, listOf(RepoInfo(name = "r")))))
        assertEquals("host-key", targets[0].device)
    }

    @Test fun `spawnTargets drops the repos-root while a root session runs`() {
        val root = RepoInfo(name = "(root)", root = true)
        val turma = RepoInfo(name = "turma")
        // Root busy: the pseudo-repo is hidden (only one root session per host).
        val busy = agentWithRepos(
            "h1", "MAXAI", true, listOf(root, turma),
            sessions = listOf(SessionInfo(id = "s", status = "running", root = true)),
        )
        assertEquals(listOf("turma"), spawnTargets(listOf(busy))[0].repos.map { it.name })

        // Root free (only a stopped root session): the pseudo-repo is offered.
        val free = agentWithRepos(
            "h1", "MAXAI", true, listOf(root, turma),
            sessions = listOf(SessionInfo(id = "s", status = "stopped", root = true)),
        )
        assertTrue(spawnTargets(listOf(free))[0].repos.any { it.root })
    }
}
