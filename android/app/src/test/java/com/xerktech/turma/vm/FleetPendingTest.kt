package com.xerktech.turma.vm

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.SessionInfo
import com.xerktech.turma.vm.FleetViewModel.Companion.pendKey
import com.xerktech.turma.vm.FleetViewModel.Companion.reconcilePending
import com.xerktech.turma.vm.FleetViewModel.SessPending
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The dashboard's optimistic per-session pending — a pure port of web
 * index.html `reconcilePending`: each kind clears on the completion signal it
 * actually has, with a TTL backstop, so the busy state ends exactly when the
 * fleet reflects the change.
 */
class FleetPendingTest {

    private fun fleet(vararg sessions: SessionInfo) =
        listOf(AgentInfo(key = "h1", sessions = sessions.toList()))

    private fun pend(kind: String, at: Long = 0, restartCount: Int = 0) =
        mapOf(pendKey("h1", "s1") to SessPending(kind, at, restartCount))

    @Test fun `kill and delete clear when the session disappears`() {
        // Still reported: hold.
        assertEquals(1, reconcilePending(pend("kill"), fleet(SessionInfo(id = "s1", status = "running")), 1000).size)
        // Gone from the list: cleared.
        assertTrue(reconcilePending(pend("kill"), fleet(), 1000).isEmpty())
        assertTrue(reconcilePending(pend("delete"), fleet(), 1000).isEmpty())
    }

    @Test fun `start clears only once the session runs, resume once it reappears`() {
        assertEquals(1, reconcilePending(pend("start"), fleet(SessionInfo(id = "s1", status = "stopped")), 1000).size)
        assertTrue(reconcilePending(pend("start"), fleet(SessionInfo(id = "s1", status = "running")), 1000).isEmpty())
        // Resume re-registers the id, even as "error" — the card then shows why.
        assertEquals(1, reconcilePending(pend("resume"), fleet(), 1000).size)
        assertTrue(reconcilePending(pend("resume"), fleet(SessionInfo(id = "s1", status = "error")), 1000).isEmpty())
    }

    @Test fun `restart clears on the restartCount bump, not a blind timer`() {
        val p = pend("restart", restartCount = 2)
        assertEquals(1, reconcilePending(p, fleet(SessionInfo(id = "s1", status = "running", restartCount = 2)), 1000).size)
        assertTrue(reconcilePending(p, fleet(SessionInfo(id = "s1", status = "running", restartCount = 3)), 1000).isEmpty())
    }

    @Test fun `the TTL backstop reaps an entry with no signal`() {
        val s = SessionInfo(id = "s1", status = "running")
        // Under the TTL: held. Past it: reaped even though nothing changed.
        assertEquals(1, reconcilePending(pend("kill", at = 0), fleet(s), 44_000).size)
        assertTrue(reconcilePending(pend("kill", at = 0), fleet(s), 46_000).isEmpty())
        // Restart's shorter TTL (the fallback for an agent with no restartCount).
        assertTrue(reconcilePending(pend("restart", at = 0), fleet(s), 16_000).isEmpty())
    }
}
