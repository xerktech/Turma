package com.xerktech.turma.ui

import com.xerktech.turma.core.LiveState
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.LiveSignals
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

    // ---- rankRunning (the Active / Idle sections, XERK-73) -------------------

    private fun flat(
        id: String, status: String = "running",
        question: String = "", paneBusy: Boolean? = null, ageSec: Double? = null,
    ) = FlatSession(
        host = "h", device = "BOX", online = true, hostLastSeen = 1_000L,
        session = SessionInfo(
            id = id, status = status,
            session = LiveSignals(paneBusy = paneBusy, question = question, transcriptAgeSec = ageSec),
        ),
    )

    @Test fun `rankRunning splits active (waiting+working) from idle, dropping non-running`() {
        val (active, idle) = rankRunning(
            listOf(
                flat("idleOne", paneBusy = false),
                flat("workOne", paneBusy = true),
                flat("waitOne", question = "pick one"),
                flat("stoppedOne", status = "stopped"),
            ),
            now = 1_000L,
        )
        // Active is waiting before working (attention-first, web KIND_ORDER).
        assertEquals(listOf("waitOne", "workOne"), active.map { it.flat.session.id })
        assertEquals(listOf(LiveState.WAITING, LiveState.WORKING), active.map { it.state })
        assertEquals(listOf("idleOne"), idle.map { it.flat.session.id })
        // The stopped session is in neither list.
        assertTrue(active.none { it.flat.session.id == "stoppedOne" })
    }

    @Test fun `rankRunning orders freshest-first within a kind, null age first`() {
        val (active, _) = rankRunning(
            listOf(
                flat("stale", paneBusy = true, ageSec = 90.0),
                flat("fresh", paneBusy = true, ageSec = 3.0),
                flat("brandNew", paneBusy = true, ageSec = null), // no transcript yet
            ),
            now = 1_000L,
        )
        // Same kind (all working): smallest age first, and a null age (never
        // written) sorts ahead of any aged one — exactly the web's `?? -1`.
        assertEquals(listOf("brandNew", "fresh", "stale"), active.map { it.flat.session.id })
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
