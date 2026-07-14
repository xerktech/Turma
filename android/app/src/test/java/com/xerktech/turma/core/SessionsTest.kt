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
}
