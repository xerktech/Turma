package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.CloneInfo
import com.xerktech.turma.model.GithubInfo
import com.xerktech.turma.model.GithubRepo
import com.xerktech.turma.model.TurmaJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Parity with turma/public/index.html's cloneBar/cloneBody/cloneRepo (XERK-126). */
class CloneTest {

    private fun repo(nwo: String, private_: Boolean = false) =
        GithubRepo(nameWithOwner = nwo, name = nwo.substringAfterLast('/'), isPrivate = private_)

    // --- the decode bug itself ---------------------------------------------

    @Test
    fun `github availability decodes the agent's own key`() {
        // Captured verbatim from a live agent's collect_github(): the key is
        // `available`, and there is no `ok` key at all. Decoding the wrong name
        // left EVERY host reading as credential-less, which is XERK-126.
        val gh = TurmaJson.decodeFromString(
            GithubInfo.serializer(),
            """{"available":true,"login":"xerhab","repos":[
                 {"nameWithOwner":"xerktech/Turma","name":"Turma","description":"",
                  "isPrivate":false,"updatedAt":"2026-07-25T18:53:24Z"}]}""",
        )
        assertTrue(gh.available)
        assertEquals("xerhab", gh.login)
        assertEquals("xerktech/Turma", gh.repos.single().nameWithOwner)
    }

    @Test
    fun `an unconfigured host still decodes to unavailable`() {
        // The agent sends login:null on a host with no creds; the decoder must
        // coerce it rather than throw and take the whole agent payload with it.
        val gh = TurmaJson.decodeFromString(
            GithubInfo.serializer(),
            """{"available":false,"login":null,"repos":[]}""",
        )
        assertFalse(gh.available)
        assertEquals("", gh.login)
    }

    @Test
    fun `github block survives inside a whole agent payload`() {
        val a = TurmaJson.decodeFromString(
            AgentInfo.serializer(),
            """{"key":"h1","online":true,
                "github":{"available":true,"login":"octocat",
                          "repos":[{"nameWithOwner":"octocat/Hello","name":"Hello","isPrivate":true}]},
                "clones":[{"repo":"octocat/Hello","name":"Hello","status":"cloning"}]}""",
        )
        assertTrue(a.github!!.available)
        assertEquals("Hello", a.github!!.repos.single().name)
        assertEquals("cloning", a.clones.single().status)
    }

    // --- candidate list -----------------------------------------------------

    @Test
    fun `candidates mark repos the host already has`() {
        val out = cloneCandidates(
            listOf(repo("octocat/Hello"), repo("octocat/World")),
            present = setOf("Hello"),
        )
        assertEquals(listOf(true, false), out.map { it.alreadyHere })
        // Present repos stay listed rather than vanishing — "already here" is
        // the useful answer; a missing row reads as a lost repo.
        assertEquals(2, out.size)
    }

    @Test
    fun `search matches owner and repo case-insensitively`() {
        val repos = listOf(repo("octocat/Hello"), repo("xerktech/Turma"))
        assertEquals(listOf("xerktech/Turma"), cloneCandidates(repos, emptySet(), "XERK").map { it.nameWithOwner })
        assertEquals(listOf("octocat/Hello"), cloneCandidates(repos, emptySet(), "hello").map { it.nameWithOwner })
        assertEquals(2, cloneCandidates(repos, emptySet(), "  ").size)
    }

    @Test
    fun `candidates carry the private marker through`() {
        assertTrue(cloneCandidates(listOf(repo("o/p", private_ = true)), emptySet()).single().isPrivate)
    }

    // --- spec parsing -------------------------------------------------------

    @Test
    fun `repo name strips git suffix and trailing slashes`() {
        assertEquals("Hello", cloneRepoName("octocat/Hello"))
        assertEquals("Hello", cloneRepoName("octocat/Hello.git"))
        assertEquals("Hello", cloneRepoName("octocat/Hello/"))
        assertEquals("Hello", cloneRepoName("https://github.com/octocat/Hello.git"))
        assertEquals("", cloneRepoName("   "))
    }

    @Test
    fun `specs combine picks and the free-text box`() {
        assertEquals(
            listOf("octocat/Hello", "octocat/World", "other/Thing"),
            cloneSpecs(setOf("octocat/World", "octocat/Hello"), "other/Thing"),
        )
    }

    @Test
    fun `specs drop blanks and duplicate destinations`() {
        assertEquals(emptyList<String>(), cloneSpecs(emptySet(), "   "))
        // Same landing dir typed twice must fire one POST, not two.
        assertEquals(listOf("octocat/Hello"), cloneSpecs(setOf("octocat/Hello"), "octocat/Hello.git"))
        assertEquals(listOf("octocat/Hello"), cloneSpecs(setOf("octocat/Hello"), "/"))
    }

    // --- job rows -----------------------------------------------------------

    @Test
    fun `job rows mirror the web's three states`() {
        val running = cloneJobRow(CloneInfo(repo = "octocat/Hello", status = "cloning"))
        assertEquals("Cloning octocat/Hello…", running.text)
        assertFalse(running.done); assertFalse(running.failed)

        val done = cloneJobRow(CloneInfo(repo = "octocat/Hello", name = "Hello", status = "done"))
        assertTrue(done.done)
        assertTrue(done.text.contains("Hello"))

        val failed = cloneJobRow(CloneInfo(repo = "octocat/Hello", status = "error", error = "auth"))
        assertTrue(failed.failed)
        assertTrue(failed.text.contains("auth"))
    }

    @Test
    fun `a failed job with no reason still says something`() {
        assertTrue(cloneJobRow(CloneInfo(repo = "o/p", status = "error")).text.contains("unknown error"))
    }

    @Test
    fun `an unknown status reads as still running rather than disappearing`() {
        val row = cloneJobRow(CloneInfo(repo = "o/p", status = "queued"))
        assertFalse(row.done); assertFalse(row.failed)
    }
}
