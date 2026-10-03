package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
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

    // XERK-245: a session that delegated work and ended its own turn paints no
    // interrupt hint, so paneBusy reads false while a background agent is still
    // running — and the card said idle, and it qualified as Ready for review,
    // buzzing the phone mid-run.
    @Test fun `live background agents mean working even with paneBusy false`() {
        val bg = LiveSignals(
            paneBusy = false, transcriptAgeSec = 999.0,
            agents = listOf(com.xerktech.turma.model.LiveAgent(type = "qa", label = "QA it")),
        )
        val s = SessionInfo(status = "running", session = bg)
        assertEquals(LiveState.WORKING, liveState(s, now, now))
        // Behind the offline gate, like paneBusy: a host that died mid-run must
        // not leave its sessions reading working forever.
        assertEquals(LiveState.IDLE, liveState(s, now - 120_000L, now))
        // An empty list is "no agents"; an older agent reports none at all.
        assertEquals(
            LiveState.IDLE,
            liveState(SessionInfo(status = "running",
                session = LiveSignals(paneBusy = false, transcriptAgeSec = 999.0)), now, now),
        )
    }

    // The card's wording, which no test covered — a QA mutation pass removed the
    // background-agent branch of liveStateLabel and every gate stayed green.
    @Test fun `liveStateLabel names background agents and pluralizes them`() {
        val one = LiveSignals(agents = listOf(com.xerktech.turma.model.LiveAgent(type = "Explore")))
        val two = LiveSignals(agents = listOf(
            com.xerktech.turma.model.LiveAgent(type = "Explore"),
            com.xerktech.turma.model.LiveAgent(type = "general-purpose"),
        ))
        assertEquals("1 background agent",
            com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, one))
        assertEquals("2 background agents",
            com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, two))
        // A background shell rides `agents` as a `shell` row (web backgroundWorkLabel).
        val shell = LiveSignals(agents = listOf(com.xerktech.turma.model.LiveAgent(type = "shell")))
        assertEquals("1 background shell",
            com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, shell))
        val mixed = LiveSignals(agents = listOf(
            com.xerktech.turma.model.LiveAgent(type = "shell"),
            com.xerktech.turma.model.LiveAgent(type = "Explore"),
        ))
        assertEquals("2 background tasks",
            com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, mixed))
        // No agents, or a state that isn't WORKING: the plain state word.
        assertEquals("working",
            com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, LiveSignals()))
        assertEquals("working", com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, null))
        assertEquals("idle", com.xerktech.turma.ui.liveStateLabel(LiveState.IDLE, one))
        assertEquals("waiting", com.xerktech.turma.ui.liveStateLabel(LiveState.WAITING, one))
    }

    // XERK-538: a QA / QA-delta pass reads "QA Review" while the card stays
    // WORKING (Active) — matching the web's qaReviewing/agentWorkLabel.
    @Test fun `liveStateLabel reads QA Review for a QA agent`() {
        val qa = LiveSignals(agents = listOf(com.xerktech.turma.model.LiveAgent(type = "qa")))
        // qa-delta wins even beside an ordinary agent.
        val delta = LiveSignals(agents = listOf(
            com.xerktech.turma.model.LiveAgent(type = "Explore"),
            com.xerktech.turma.model.LiveAgent(type = "qa-delta"),
        ))
        assertEquals("QA Review", com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, qa))
        assertEquals("QA Review", com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, delta))
        // Only while WORKING — an idle/waiting card keeps its plain word.
        assertEquals("idle", com.xerktech.turma.ui.liveStateLabel(LiveState.IDLE, qa))
    }

    @Test fun `a session waiting on background agents is not ready for review`() {
        val bg = SessionInfo(
            status = "running",
            session = LiveSignals(
                paneBusy = false, transcriptAgeSec = 5.0, lastRole = "assistant",
                agents = listOf(com.xerktech.turma.model.LiveAgent(type = "qa", label = "QA it")),
            ),
        )
        assertEquals(false, readyForReview(bg, liveState(bg, now, now)))
        // Once the agent finishes the list empties and it qualifies as before.
        val done = bg.copy(session = bg.session!!.copy(agents = emptyList()))
        assertEquals(true, readyForReview(done, liveState(done, now, now)))
    }

    // ---- background shell kinds (XERK-1570) ----------------------------------
    // Only WORK keeps a session working; a session whose live rows are all waits
    // is HOLDING (not working, not ready for review) until it stalls.

    private fun shell(kind: String, label: String = "", eta: Long? = null) =
        com.xerktech.turma.model.LiveAgent(type = "shell", label = label, kind = kind, eta = eta)
    private fun waitingOn(vararg rows: com.xerktech.turma.model.LiveAgent, ageSec: Double = 5.0) = SessionInfo(
        status = "running",
        session = LiveSignals(paneBusy = false, transcriptAgeSec = ageSec, lastRole = "assistant", agents = rows.toList()),
    )

    @Test fun `only work rows count as working`() {
        // A sleep with an ETA ahead: holding, not working, not ready for review.
        val timed = waitingOn(shell("wait-timed", "Sleep", eta = now + 600_000L))
        assertEquals(false, sessionWorking(timed, now, now))
        assertEquals(LiveState.HOLDING, liveState(timed, now, now))
        assertEquals(false, readyForReview(timed, liveState(timed, now, now)))
        // A CI watch, freshly launched: holding too.
        assertEquals(LiveState.HOLDING, liveState(waitingOn(shell("wait-external", "Watch CI")), now, now))
        // A work shell, an explicit "work", or a row with no kind (an older agent) is work.
        assertEquals(LiveState.WORKING, liveState(waitingOn(shell("work", "Run tests")), now, now))
        assertEquals(LiveState.WORKING, liveState(waitingOn(shell("")), now, now))
        // A wait beside real work is working.
        assertEquals(LiveState.WORKING,
            liveState(waitingOn(shell("wait-timed", eta = now + 600_000L), shell("work")), now, now))
        // paneBusy still wins: its own turn is running.
        val busy = waitingOn(shell("wait-external")).let { it.copy(session = it.session!!.copy(paneBusy = true)) }
        assertEquals(LiveState.WORKING, liveState(busy, now, now))
        // With paneBusy unknown, a fresh transcript does NOT make a wait-only session working.
        val unknown = waitingOn(shell("wait-external")).let { it.copy(session = it.session!!.copy(paneBusy = null)) }
        assertEquals(false, sessionWorking(unknown, now, now))
    }

    @Test fun `a wait stalls past its eta or after long silence, and then reads ready for review`() {
        // ETA passed (plus the 2-minute grace) with nothing written since: stalled → IDLE.
        val overdue = waitingOn(shell("wait-timed", eta = now - 180_000L), ageSec = 600.0)
        assertEquals(true, sessionWait(overdue, now, now)?.stalled)
        assertEquals(LiveState.IDLE, liveState(overdue, now, now))
        assertEquals(true, readyForReview(overdue, liveState(overdue, now, now)))
        // Within the grace it is still holding.
        val justPast = waitingOn(shell("wait-timed", eta = now - 30_000L), ageSec = 600.0)
        assertEquals(LiveState.HOLDING, liveState(justPast, now, now))
        // No ETA: holding until 45 minutes of transcript silence.
        assertEquals(LiveState.HOLDING, liveState(waitingOn(shell("wait-external"), ageSec = 44 * 60.0), now, now))
        assertEquals(LiveState.IDLE, liveState(waitingOn(shell("wait-external"), ageSec = 46 * 60.0), now, now))
        // An offline host's waits read nothing — IDLE, like its stale paneBusy.
        assertEquals(null, sessionWait(waitingOn(shell("wait-external")), now - 120_000L, now))
    }

    @Test fun `liveStateLabel says what a holding session waits on`() {
        val timed = LiveSignals(agents = listOf(shell("wait-timed", "Sleep", eta = now + 12 * 60_000L)))
        assertEquals("⏳ waiting · Sleep · 12m left", com.xerktech.turma.ui.liveStateLabel(LiveState.HOLDING, timed, now))
        val ci = LiveSignals(agents = listOf(shell("wait-external", "Watch CI")))
        assertEquals("⏳ waiting · Watch CI", com.xerktech.turma.ui.liveStateLabel(LiveState.HOLDING, ci, now))
        val two = LiveSignals(agents = listOf(shell("wait-external"), shell("wait-timed")))
        assertEquals("⏳ waiting on 2 background shells", com.xerktech.turma.ui.liveStateLabel(LiveState.HOLDING, two, now))
        // XERK-1571: no ETA, but a startedAt — how long it has been waiting, off the oldest row.
        val started = LiveSignals(agents = listOf(
            shell("wait-external", "Watch CI on PR #412").copy(startedAt = now - 12 * 60_000L)))
        assertEquals("⏳ waiting · Watch CI on PR #412 · 12m",
            com.xerktech.turma.ui.liveStateLabel(LiveState.HOLDING, started, now))
        val twoStarted = LiveSignals(agents = listOf(
            shell("wait-external").copy(startedAt = now - 5 * 60_000L),
            shell("wait-timed").copy(startedAt = now - 20 * 60_000L)))
        assertEquals("⏳ waiting on 2 background shells · 20m",
            com.xerktech.turma.ui.liveStateLabel(LiveState.HOLDING, twoStarted, now))
        // A working card names only its WORK rows.
        val mixed = LiveSignals(agents = listOf(shell("work"), shell("wait-external")))
        assertEquals("1 background shell", com.xerktech.turma.ui.liveStateLabel(LiveState.WORKING, mixed, now))
    }

    // ---- attention (XERK-1571) ----------------------------------------------

    @Test fun `a pending wake sleeps — holding, never ready for review, labelled until when`() {
        val wakeAt = now + 30 * 60_000L
        val asleep = SessionInfo(
            status = "running",
            session = LiveSignals(paneBusy = false, transcriptAgeSec = 5.0, lastRole = "assistant", wakeAt = wakeAt),
        )
        assertEquals(true, sessionSleeping(asleep, now))
        assertEquals(LiveState.HOLDING, liveState(asleep, now, now))
        assertEquals(false, readyForReview(asleep, liveState(asleep, now, now)))
        assertEquals(
            "💤 sleeping until ${clockTime(wakeAt)}",
            com.xerktech.turma.ui.liveStateLabel(LiveState.HOLDING, asleep.session, now),
        )
        // A due wake no longer sleeps; working outranks a sleep.
        assertEquals(LiveState.IDLE, liveState(asleep, now, wakeAt + 1))
        val busy = asleep.copy(session = asleep.session!!.copy(paneBusy = true))
        assertEquals(LiveState.WORKING, liveState(busy, now, now))
        // "14:05"-shaped local clock time.
        assertEquals(true, Regex("^\\d\\d:\\d\\d$").matches(clockTime(wakeAt)))
    }

    private fun att(state: String, since: Long?, why: String? = null) =
        com.xerktech.turma.model.Attention(state = state, since = since, why = why)

    @Test fun `needsYou lists the hub's needs-you running sessions, oldest wait first`() {
        val agents = listOf(
            AgentInfo(key = "h", sessions = listOf(
                SessionInfo(id = "new", status = "running", attention = att("needs-you:review", now - 60_000L)),
                SessionInfo(id = "old", status = "running", attention = att("needs-you:stalled", now - 3_600_000L)),
                SessionInfo(id = "busy", status = "running", attention = att("working", now - 10L)),
                SessionInfo(id = "zzz", status = "running", attention = att("sleeping", now - 10L)),
                SessionInfo(id = "stopped", status = "stopped", attention = att("needs-you:review", 1L)),
                SessionInfo(id = "olderHub", status = "running"),
            )),
        )
        assertEquals(listOf("old", "new"), needsYou(agents).map { it.session.id })
        assertEquals("stalled", needsYouChip("needs-you:stalled"))
        assertEquals(null, needsYouChip("waiting"))
    }

    @Test fun `attentionWhy says why and for how long`() {
        assertEquals("PR open · CI passing · waiting 12m",
            attentionWhy(att("needs-you:review", now - 12 * 60_000L, "PR open · CI passing"), now))
        // A question/permission already reads "waiting"; a stall says it stalled.
        assertEquals("Ship it? · for 3m", attentionWhy(att("needs-you:question", now - 3 * 60_000L, "Ship it?"), now))
        assertEquals("Bash: rm -rf build · for 3m",
            attentionWhy(att("needs-you:permission", now - 3 * 60_000L, "Bash: rm -rf build"), now))
        assertEquals("stalled 3m", attentionWhy(att("needs-you:stalled", now - 3 * 60_000L), now))
        assertEquals("", attentionWhy(att("working", now), now))
        assertEquals("", attentionWhy(null, now))
    }

    @Test fun `attentionLabel names a needs-you state, never idle`() {
        assertEquals("review · PR open · CI passing", attentionLabel(att("needs-you:review", now, "PR open · CI passing")))
        assertEquals("stalled · Watch CI", attentionLabel(att("needs-you:stalled", now, "Watch CI")))
        assertEquals("waiting for your answer", attentionLabel(att("needs-you:question", now, "Ship it?")))
        assertEquals("waiting for your permission", attentionLabel(att("needs-you:permission", now, "Bash: ls")))
        assertEquals("review", attentionLabel(att("needs-you:review", now)))
        assertEquals(null, attentionLabel(att("working", now)))
        assertEquals(null, attentionLabel(null))
        assertEquals(true, attentionStalled(att("needs-you:stalled", now)))
        assertEquals(false, attentionStalled(att("needs-you:review", now)))
    }

    @Test fun `sortedBySince puts the oldest first and keeps since-less rows in place after them`() {
        val rows = listOf("a" to null, "b" to 30L, "c" to null, "d" to 10L)
        val out = sortedBySince(rows) { r -> r.second?.let { att("needs-you:review", it) } }
        assertEquals(listOf("d", "b", "a", "c"), out.map { it.first })
    }

    // ---- readyForReview (XERK-224) ------------------------------------------
    // The port of the web's rule (turma/public/sessions.html), which the hub's
    // ready-for-review alert mirrors again — all three decide the same group.

    private fun quiet(
        lastRole: String = "",
        prs: List<com.xerktech.turma.model.PrInfo> = emptyList(),
        newWork: Boolean = false,
    ) = SessionInfo(
        status = "running", prs = prs, newWorkSincePrs = newWork,
        session = LiveSignals(paneBusy = false, lastRole = lastRole),
    )
    private fun pr(state: String) = com.xerktech.turma.model.PrInfo(url = "u$state", state = state)

    @Test fun `readyForReview takes a question, an unlanded PR, or a finished turn`() {
        assertEquals(true, readyForReview(quiet(), LiveState.WAITING))
        assertEquals(false, readyForReview(quiet(), LiveState.WORKING))
        assertEquals(false, readyForReview(quiet(), LiveState.STOPPED))
        // The no-PR research task — the case a PR-only rule would miss.
        assertEquals(true, readyForReview(quiet(lastRole = "assistant"), LiveState.IDLE))
        // Nothing written yet, or the last word was the operator's: not review-ready.
        assertEquals(false, readyForReview(quiet(), LiveState.IDLE))
        assertEquals(false, readyForReview(quiet(lastRole = "user"), LiveState.IDLE))
    }

    @Test fun `readyForReview judges a PR-bearing session on the PR alone`() {
        assertEquals(true, readyForReview(quiet(prs = listOf(pr("OPEN"))), LiveState.IDLE))
        assertEquals(true, readyForReview(quiet(prs = listOf(pr("DRAFT"))), LiveState.IDLE))
        // An unfetched state must never be what drops work off the list.
        assertEquals(true, readyForReview(quiet(prs = listOf(pr(""))), LiveState.IDLE))
        // Merging (or closing) IS the review — park it in Idle until verified.
        assertEquals(false, readyForReview(quiet(prs = listOf(pr("MERGED"))), LiveState.IDLE))
        assertEquals(false, readyForReview(quiet(prs = listOf(pr("CLOSED"))), LiveState.IDLE))
        assertEquals(true, readyForReview(quiet(prs = listOf(pr("MERGED"), pr("OPEN"))), LiveState.IDLE))
        // A landed PR outranks the finished turn that opened it, else merging
        // could never move a session out of the section.
        assertEquals(false, readyForReview(quiet("assistant", listOf(pr("MERGED"))), LiveState.IDLE))
    }

    @Test fun `readyForReview lets a merged PR stop hiding the session's next task`() {
        // A session is a conversation, not a pull request: hand the same one a
        // new task after the merge and the PR it already shipped must not bury
        // the result (XERK-224).
        val merged = listOf(pr("MERGED"))
        assertEquals(false, readyForReview(quiet("assistant", merged), LiveState.IDLE))
        assertEquals(
            "new work after the merge is still work awaiting review",
            true,
            readyForReview(quiet("assistant", merged, newWork = true), LiveState.IDLE),
        )
        // The expiry only lifts the demotion — it is not itself a qualifier.
        assertEquals(false, readyForReview(quiet("user", merged, newWork = true), LiveState.IDLE))
        // And an unlanded PR is decided before the question is even asked.
        assertEquals(true, readyForReview(quiet("user", listOf(pr("MERGED"), pr("OPEN"))), LiveState.IDLE))
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

    @Test fun `no git block is unknown, not detached`() {
        // XERK-1538: the agent serves git:null until its first read answers.
        assertEquals("", sessionBranch(SessionInfo(git = null)))
        assertEquals("truenas · Turma", sessionHeaderMeta("truenas", SessionInfo(repo = "Turma")))
    }

    @Test fun `delete confirm treats unknown dirty as maybe-dirty`() {
        assertEquals("Confirm delete — uncommitted changes will be lost",
            deleteConfirmText(SessionInfo(git = GitState(dirtyFiles = 2))))
        assertEquals("Confirm delete", deleteConfirmText(SessionInfo(git = GitState(dirtyFiles = 0))))
        assertEquals("Confirm delete — may have uncommitted changes",
            deleteConfirmText(SessionInfo(git = null)))
        assertEquals("Confirm delete", deleteConfirmText(SessionInfo(git = null, root = true)))
    }

    @Test fun `name prefers summary then label then worktree`() {
        assertEquals("Fix login", sessionName(SessionInfo(summary = "Fix login", label = "l", worktreePath = "/a/b")))
        assertEquals("mylabel", sessionName(SessionInfo(label = "mylabel", worktreePath = "/a/wt-9")))
        assertEquals("wt-9", sessionName(SessionInfo(worktreePath = "/a/wt-9")))
        // A Windows agent reports a backslash worktreePath; the basename must not
        // be the whole path (XERK-666).
        assertEquals("9a183", sessionName(SessionInfo(worktreePath = "C:\\Users\\me\\git\\.turma\\worktrees\\Turma\\9a183")))
    }

    @Test fun `card repo label names the repo, or says repos root in words`() {
        assertEquals("Turma", sessionRepoLabel(SessionInfo(repo = "Turma")))
        // A repos-root session: by the flag, and by the agent's "(root)" sentinel
        // (a closed/resumable record can carry the name without the flag).
        assertEquals("repos root", sessionRepoLabel(SessionInfo(repo = "(root)", root = true)))
        assertEquals("repos root", sessionRepoLabel(SessionInfo(repo = "(root)")))
        // Nothing reported at all — never blank, so the row can't lose a separator.
        assertEquals("?", sessionRepoLabel(SessionInfo(repo = "")))
    }

    @Test fun `header meta joins host repo and branch, dropping blanks`() {
        assertEquals(
            "truenas · Turma · XERK-121",
            sessionHeaderMeta("truenas", SessionInfo(repo = "Turma", git = GitState(branch = "XERK-121"))),
        )
        // No repo (repos-root) or no branch (detached) still reads cleanly.
        assertEquals("truenas · detached", sessionHeaderMeta("truenas", SessionInfo(repo = "", git = GitState(branch = "HEAD"))))
        assertEquals(
            "truenas · Turma · detached",
            sessionHeaderMeta("truenas", SessionInfo(repo = "Turma", git = GitState(branch = "HEAD"))),
        )
    }

    // ---- liveMarker / tunnelOnlineOf (web's tunnel chip, XERK-252) -----------

    @Test fun `a host with no tunnel outranks our own open socket`() {
        // The hub holds our /live socket across a control-channel flap, so
        // `connected` stays true while nothing flows. Saying "live" there claims
        // a stream that has stopped.
        assertEquals("⚠ tunnel offline", liveMarker(tunnelOnline = false, connected = true))
        assertEquals("⚠ tunnel offline", liveMarker(tunnelOnline = false, connected = false))
    }

    @Test fun `a healthy host marks live only while our socket is up`() {
        assertEquals("live", liveMarker(tunnelOnline = true, connected = true))
        assertEquals("", liveMarker(tunnelOnline = true, connected = false))
    }

    @Test fun `a host missing from the payload is unknown, never offline`() {
        // Nothing heard about the host is not a fault we may claim (and it is
        // the state every screen starts in, before the first fleet payload).
        assertEquals(true, tunnelOnlineOf(null))
        assertEquals(true, tunnelOnlineOf(AgentInfo(key = "h1", terminalOnline = true)))
        assertEquals(false, tunnelOnlineOf(AgentInfo(key = "h1", terminalOnline = false)))
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
        // The hub-decided org (XERK-349). Null models an older hub that never
        // served it, so `orgOf` falls back to the claimed `jira.siteKey` (=[org]).
        decidedOrg: String? = null,
        repos: List<String> = listOf("repoX"),
        sessions: List<SessionInfo> = emptyList(),
    ) = com.xerktech.turma.model.AgentInfo(
        key = key, device = key, online = online,
        org = decidedOrg,
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

    // --- XERK-349: keys on the hub-decided `org`, not the claimed siteKey ------

    @Test fun `the decided org is preferred over the claimed siteKey`() {
        // Both hosts are BOUND to acme (decided "acme") but declaring a stale/
        // absent siteKey this beat — the hub still serves org="acme". The move is
        // eligible on the decision, though the claimed siteKeys differ, matching
        // the hub's `sameDecidedOrg`. A claimed-siteKey rule would wrongly hide it.
        val sess = SessionInfo(id = "s1", status = "running", repo = "repoX")
        val agents = listOf(
            agent("src", org = "stale.a", decidedOrg = "acme", sessions = listOf(sess)),
            agent("ok", org = "stale.b", decidedOrg = "acme"),
        )
        assertEquals(listOf("ok"), eligibleMoveTargets(agents, "src", sess).map { it.key })
    }

    @Test fun `a host the hub decided has no org is never a target`() {
        // A drifted or never-bound host is served org="" (present, empty). It must
        // NOT be pooled with a host that merely CLAIMS the same siteKey — the hub
        // refuses that move (`sameDecidedOrg` needs a non-empty shared org), so
        // the menu must hide it too. Here the drifted host still claims acme.
        val sess = SessionInfo(id = "s1", status = "running", repo = "repoX")
        val agents = listOf(
            agent("src", decidedOrg = "acme", sessions = listOf(sess)),
            agent("peer", decidedOrg = "acme"),                 // eligible
            agent("drifted", org = "acme", decidedOrg = ""),    // claims acme, decided ""
        )
        assertEquals(listOf("peer"), eligibleMoveTargets(agents, "src", sess).map { it.key })
    }

    @Test fun `an org-less source offers nothing`() {
        // The source's own decided org is "" (never bound). Even a peer claiming
        // the same siteKey is not offered — org-less hosts are alone, mirroring
        // the peer roster and the hub's non-empty requirement.
        val sess = SessionInfo(id = "s1", status = "running", repo = "repoX")
        val agents = listOf(
            agent("src", decidedOrg = "", sessions = listOf(sess)),
            agent("peer", decidedOrg = ""),
        )
        assertEquals(emptyList<String>(), eligibleMoveTargets(agents, "src", sess).map { it.key })
    }
}
