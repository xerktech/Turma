package com.xerktech.turma.core

import com.xerktech.turma.model.GitState
import com.xerktech.turma.model.LiveSignals
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsTest {

    private val now = 1_000_000L

    @Test fun `paneBusy true means working regardless of freshness`() {
        val s = SessionInfo(status = "running", session = LiveSignals(paneBusy = true, transcriptAgeSec = 9999.0))
        assertEquals(LiveState.WORKING, liveState(s, now, now))
    }

    @Test fun `paneBusy false means idle even with fresh transcript`() {
        val s = SessionInfo(status = "running", session = LiveSignals(paneBusy = false, transcriptAgeSec = 1.0))
        assertEquals(LiveState.IDLE, liveState(s, now, now))
    }

    @Test fun `falls back to transcript freshness when paneBusy unknown`() {
        val fresh = SessionInfo(status = "running", session = LiveSignals(paneBusy = null, transcriptAgeSec = 5.0))
        assertEquals(LiveState.WORKING, liveState(fresh, now, now))
        val stale = SessionInfo(status = "running", session = LiveSignals(paneBusy = null, transcriptAgeSec = 200.0))
        assertEquals(LiveState.IDLE, liveState(stale, now, now))
    }

    @Test fun `a pending question wins over working`() {
        val s = SessionInfo(status = "running", session = LiveSignals(paneBusy = true, question = "Proceed?"))
        assertEquals(LiveState.WAITING, liveState(s, now, now))
    }

    @Test fun `stopped session is STOPPED`() {
        assertEquals(LiveState.STOPPED, liveState(SessionInfo(status = "stopped"), now, now))
    }

    @Test fun `branch shows detached until the agent branches`() {
        assertEquals("detached", sessionBranch(SessionInfo(git = GitState(branch = "HEAD"))))
        assertEquals("feat/x", sessionBranch(SessionInfo(git = GitState(branch = "feat/x"))))
    }

    @Test fun `name prefers summary then label then worktree`() {
        assertEquals("Fix login", sessionName(SessionInfo(summary = "Fix login", label = "l", worktreePath = "/a/b")))
        assertEquals("mylabel", sessionName(SessionInfo(label = "mylabel", worktreePath = "/a/wt-9")))
        assertEquals("wt-9", sessionName(SessionInfo(worktreePath = "/a/wt-9")))
    }

    // ---- workLine (web index.html workLine/unpushedCommits, XERK-78) ---------

    private fun sessWork(
        pushed: Boolean? = null, aheadOfBase: Int? = null, aheadOfRemote: Int? = null,
        baseRef: String? = null, dirty: Int = 0,
    ) = SessionInfo(
        work = com.xerktech.turma.model.WorkInfo(
            baseRef = baseRef, aheadOfBase = aheadOfBase, pushed = pushed, aheadOfRemote = aheadOfRemote,
        ),
        git = GitState(dirtyFiles = dirty),
    )

    @Test fun `workLine is null when nothing is known`() {
        assertEquals(null, workLine(SessionInfo()))
        assertEquals(null, workLine(sessWork()))
    }

    @Test fun `unpushed commits or dirty files read as risk`() {
        val risky = workLine(sessWork(pushed = false, aheadOfBase = 3, baseRef = "main", dirty = 2))!!
        assertEquals("3 commits ahead of main · not pushed · 2 dirty files", risky.text)
        assertEquals(true, risky.risk)
        // Singulars singular.
        val one = workLine(sessWork(pushed = false, aheadOfBase = 1, dirty = 1))!!
        assertEquals("1 commit ahead · not pushed · 1 dirty file", one.text)
    }

    @Test fun `pushed and clean reads safe`() {
        val safe = workLine(sessWork(pushed = true, aheadOfBase = 2, aheadOfRemote = 0, baseRef = "main"))!!
        assertEquals("2 commits ahead of main · pushed", safe.text)
        assertEquals(false, safe.risk)
        // Pushed with unknown sync says so rather than claiming either way.
        val unknown = workLine(sessWork(pushed = true, aheadOfBase = 2, aheadOfRemote = null))!!
        assertEquals("2 commits ahead · pushed · sync unknown", unknown.text)
        assertEquals(false, unknown.risk)
        // Pushed but with commits origin doesn't have yet: risk again.
        val behind = workLine(sessWork(pushed = true, aheadOfBase = 5, aheadOfRemote = 2))!!
        assertEquals("5 commits ahead · 2 unpushed", behind.text)
        assertEquals(true, behind.risk)
    }

    // --- eligibleMoveTargets (XERK-101) --------------------------------------

    private fun agent(
        key: String,
        online: Boolean = true,
        org: String = "org.a",
        repos: List<String> = listOf("repoX"),
        sessions: List<SessionInfo> = emptyList(),
    ) = com.xerktech.turma.model.AgentInfo(
        key = key, device = key, online = online,
        jira = com.xerktech.turma.model.JiraBlock(siteKey = org),
        repos = repos.map { com.xerktech.turma.model.RepoInfo(name = it) },
        sessions = sessions,
    )

    @Test fun `move targets are online same-org hosts with the repo, minus the source`() {
        val sess = SessionInfo(id = "s1", status = "running", repo = "repoX")
        val agents = listOf(
            agent("src", sessions = listOf(sess)),
            agent("ok"),                              // eligible
            agent("off", online = false),             // offline
            agent("otherOrg", org = "org.b"),         // different org
            agent("noRepo", repos = listOf("other")), // lacks the repo
        )
        val targets = eligibleMoveTargets(agents, "src", sess).map { it.key }
        assertEquals(listOf("ok"), targets)
    }

    @Test fun `no eligible targets when the org has only the source host`() {
        val sess = SessionInfo(id = "s1", status = "running", repo = "repoX")
        val agents = listOf(agent("src", sessions = listOf(sess)))
        assertEquals(emptyList<String>(), eligibleMoveTargets(agents, "src", sess).map { it.key })
    }
}
