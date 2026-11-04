package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.AgentsResponse
import com.xerktech.turma.model.RepoDeleteInfo
import com.xerktech.turma.model.RepoInfo
import com.xerktech.turma.model.TurmaJson
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Per-repo Delete (XERK-2675) — the Android port of the web Delete cases in
 * turma/tests/dashboard-prune.test.js (XERK-2672): when the control is offered,
 * when it stays busy, and what the note says.
 */
class RepoDeleteTest {

    private val repo = RepoInfo(name = "Turma")
    private val capable = AgentInfo(key = "h1", online = true, repoDeletes = emptyList())

    @Test fun `offered on an online host whose agent reports repoDeletes`() {
        assertTrue(RepoDelete.canDelete(capable, repo))
    }

    @Test fun `never offered for the repos root`() {
        assertFalse(RepoDelete.canDelete(capable, RepoInfo(name = "", root = true)))
    }

    @Test fun `never offered on an offline host`() {
        assertFalse(RepoDelete.canDelete(capable.copy(online = false), repo))
    }

    @Test fun `never offered by an agent that predates repo delete`() {
        // It would ack and never act; the hub 409s it.
        assertFalse(RepoDelete.canDelete(capable.copy(repoDeletes = null), repo))
    }

    @Test fun `busy while syncing or deleting, released on done or error`() {
        assertTrue(RepoDelete.live(RepoDeleteInfo(repo = "Turma", status = "syncing")))
        assertTrue(RepoDelete.live(RepoDeleteInfo(repo = "Turma", status = "deleting")))
        assertFalse(RepoDelete.live(RepoDeleteInfo(repo = "Turma", status = "done")))
        assertFalse(RepoDelete.live(RepoDeleteInfo(repo = "Turma", status = "error")))
        assertFalse(RepoDelete.live(null))
    }

    @Test fun `note shows the error on error, else the summary`() {
        assertEquals("push failed", RepoDelete.note(RepoDeleteInfo(status = "error", error = "push failed", summary = "syncing")))
        assertEquals("delete failed", RepoDelete.note(RepoDeleteInfo(status = "error")))
        assertEquals("pushing 2 branches", RepoDelete.note(RepoDeleteInfo(status = "syncing", summary = "pushing 2 branches")))
        assertNull(RepoDelete.note(null))
    }

    @Test fun `the record is matched by repo name`() {
        val a = capable.copy(repoDeletes = listOf(RepoDeleteInfo(repo = "Other", status = "deleting")))
        assertNull(RepoDelete.record(a, "Turma"))
        assertEquals("deleting", RepoDelete.record(a, "Other")!!.status)
    }

    @Test fun `the confirm names what is lost and what is kept`() {
        val m = RepoDelete.CONFIRM_MESSAGE
        assertTrue(m.contains("Uncommitted changes"))
        assertTrue(m.contains("unpushed commits or branches"))
        assertTrue(m.contains("worktrees"))
        assertTrue(m.contains("transcripts are kept"))
    }

    @Test fun `repoDeletes decodes leniently and its absence stays null`() {
        val body = """
            { "now": 1, "agents": [
              { "key": "old", "online": true },
              { "key": "new", "online": true, "repoDeletes": [
                { "repo": "Turma", "status": "error", "error": null, "summary": null, "at": "2026-11-04T00:00:00Z", "extra": 1 },
                { "repo": "X", "status": "deleting" }
              ] }
            ] }
        """.trimIndent()
        val agents = TurmaJson.decodeFromString<AgentsResponse>(body).agents
        assertNull(agents[0].repoDeletes)
        val d = agents[1].repoDeletes!!
        assertEquals(2, d.size)
        assertNull(d[0].error)
        assertEquals("", d[0].summary)
        assertEquals("2026-11-04T00:00:00Z", d[0].at)
        assertEquals("", d[1].at)
    }

    /** The REAL root entry, as hub-agent root_repo_entry() sends it: `isRoot`, not `root`. */
    @Test fun `the wire's repos-root entry is never offered Delete or Prune`() {
        val body = """
            { "now": 1, "agents": [ { "key": "h", "online": true, "repoDeletes": [],
              "repos": [ { "name": "(root)", "isRoot": true }, { "name": "Turma" } ] } ] }
        """.trimIndent()
        val a = TurmaJson.decodeFromString<AgentsResponse>(body).agents[0]
        val root = a.repos[0]
        assertTrue(root.root)
        assertFalse(RepoDelete.canDelete(a, root))
        assertFalse(RepoDelete.canPrune(true, root))
        assertTrue(RepoDelete.canDelete(a, a.repos[1]))
    }

    @Test fun `a malformed repoDeletes never blanks the fleet`() {
        for (bad in listOf("{}", "\"x\"", "[1]", "[null]", "[{\"repo\":{}}]", "[{\"status\":[]}]", "[{\"at\":{}}]")) {
            val body = """{ "now": 1, "agents": [ { "key": "h", "online": true, "repoDeletes": $bad }, { "key": "g" } ] }"""
            val agents = TurmaJson.decodeFromString<AgentsResponse>(body).agents
            assertEquals("fleet lost for $bad", listOf("h", "g"), agents.map { it.key })
        }
        // A non-array is not "supports delete": it reads as null, so no button.
        for (bad in listOf("{}", "\"x\"", "true")) {
            val body = """{ "now": 1, "agents": [ { "key": "h", "online": true, "repoDeletes": $bad } ] }"""
            assertNull("$bad", TurmaJson.decodeFromString<AgentsResponse>(body).agents[0].repoDeletes)
        }
        // A good row next to a bad one survives alone.
        val mixed = """{ "now": 1, "agents": [ { "key": "h", "repoDeletes": [ {"repo":{}}, {"repo":"Turma","status":"done"} ] } ] }"""
        assertEquals(listOf("Turma"), TurmaJson.decodeFromString<AgentsResponse>(mixed).agents[0].repoDeletes!!.map { it.repo })
    }

    @Test fun `busy from the tap until the agent's record says done`() {
        // Tapped, no record yet: busy.
        assertTrue(RepoDelete.busy(null, pending = true))
        // A stale done record still showing while the command is in flight: busy.
        assertTrue(RepoDelete.busy(RepoDeleteInfo(status = "done"), pending = true))
        // Pending cleared by a new record, agent still working: busy.
        assertTrue(RepoDelete.busy(RepoDeleteInfo(status = "deleting"), pending = false))
        assertFalse(RepoDelete.busy(RepoDeleteInfo(status = "error"), pending = false))
        assertFalse(RepoDelete.busy(null, pending = false))
    }

    @Test fun `prune needs an online host and a real repo`() {
        assertTrue(RepoDelete.canPrune(true, repo))
        assertFalse(RepoDelete.canPrune(false, repo))
        assertFalse(RepoDelete.canPrune(true, RepoInfo(name = "(root)", root = true)))
    }
}
