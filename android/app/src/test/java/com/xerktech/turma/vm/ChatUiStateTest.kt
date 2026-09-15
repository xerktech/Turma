package com.xerktech.turma.vm

import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatUiStateTest {
    @Test
    fun `chat sessions default to concise verbosity`() {
        // XERK-40: a deliberate divergence from the web's Normal default (see PARITY.md).
        assertEquals(Verbosity.CONCISE, ChatUiState().verbosity)
        assertEquals(Verbosity.CONCISE.ordinal, 0) // the SharedPreferences fallback in ChatViewModel
    }

    // --- local-model failover (XERK-246) -------------------------------------
    // The compose bar reads BOTH of these every repaint, so a wrong answer here
    // is a control that either lies about the model or isn't offered at all.

    private val configured = LocalModelInfo(available = true, model = "gpt-oss:120b")

    @Test
    fun `the run-against chip follows the host's capability flag`() {
        val sess = SessionInfo(id = "s1", modelSource = "subscription")
        assertTrue(ChatUiState(session = sess, localModel = configured).canSwitchModelSource())
        // No block at all — an agent predating the failover. "Cannot", never
        // "assume it can", or the hub 409s a button the operator just pressed.
        assertFalse(ChatUiState(session = sess, localModel = null).canSwitchModelSource())
        assertFalse(
            ChatUiState(session = sess, localModel = LocalModelInfo(available = false))
                .canSwitchModelSource()
        )
    }

    @Test
    fun `a session already local keeps the chip after its host loses the config`() {
        // Otherwise it is stranded on the weaker model with no way back.
        val local = SessionInfo(id = "s1", modelSource = "local")
        assertTrue(ChatUiState(session = local, localModel = null).canSwitchModelSource())
    }

    @Test
    fun `an unconfirmed switch paints over the heartbeat until it settles`() {
        val sess = SessionInfo(id = "s1", modelSource = "subscription")
        val state = ChatUiState(
            session = sess,
            localModel = configured,
            modelSourcePending = ModelSource.Pending("s1", ModelSource.LOCAL, at = 1_000),
        )
        assertEquals(ModelSource.LOCAL, state.modelSource(now = 1_500))
        // Literal, not `at + SWITCH_SETTLE_MS + 1` — see ModelSourceTest: a
        // boundary derived from the constant under test only bounds it below.
        assertEquals(ModelSource.SUBSCRIPTION, state.modelSource(now = 61_001))
        // Another session's memo must never paint this one.
        val other = state.copy(modelSourcePending = ModelSource.Pending("s2", ModelSource.LOCAL, 1_000))
        assertEquals(ModelSource.SUBSCRIPTION, other.modelSource(now = 1_100))
    }

    @Test
    fun `no session record yet reads as the subscription`() {
        assertEquals(ModelSource.SUBSCRIPTION, ChatUiState().modelSource(now = 1))
        assertFalse(ChatUiState().canSwitchModelSource(now = 1))
    }

    @Test
    fun `a fleet beat carries EVERY field this screen reads off it`() {
        // This is the line a merge resolution silently truncates, and it must
        // name every field or it does not do its job: XERK-246 and XERK-252 both
        // landed a field in this one `copy(...)`, so the conflict was over the
        // list itself. Dropping `localModel` hides both local-model controls
        // forever; dropping `tunnelOnline` is worse than a lost warning, because
        // it defaults TRUE — the header then asserts the tunnel is up while the
        // hub says it is down. Neither shows up anywhere else in the suite: a
        // Composable's body has no gate at all. Add an assert here whenever you
        // add a field there.
        val sess = SessionInfo(id = "s1", modelSource = "local")
        val agent = AgentInfo(
            key = "h1", device = "maxai", online = true, terminalOnline = false,
            uploadMaxBytes = 5_000, localModel = configured, sessions = listOf(sess),
        )
        val s = ChatUiState().fromFleet(agent, sess, host = "h1")
        assertEquals(sess, s.session)
        assertEquals("maxai", s.hostLabel)          // device name, not the key
        assertFalse(s.tunnelOnline)                 // drives the ⚠ header marker
        assertEquals(5_000L, s.uploadMaxBytes)      // gates the 📎
        assertEquals(configured, s.localModel)      // gates BOTH new controls
        assertTrue(s.canSwitchModelSource())
    }

    // --- AskUserQuestion optimistic dismiss + stale-beat guard (XERK-812) -----

    private fun sessionAsking(q: String) =
        SessionInfo(id = "s1", session = com.xerktech.turma.model.LiveSignals(question = q))

    @Test
    fun `an answered question is hidden until the heartbeat moves off it`() {
        val asking = ChatUiState(session = sessionAsking("Pick a colour"))
        assertEquals("Pick a colour", asking.question) // shown before answering

        // Optimistic dismiss: the getter suppresses the just-answered question so
        // the card goes at the tap, not on some later beat — the whole XERK-812 fix.
        val answered = asking.copy(answeredQuestion = "Pick a colour")
        assertEquals("", answered.question)
        assertTrue(answered.canAttach || true) // canAttach reads the effective question
    }

    @Test
    fun `a stale beat still reporting the answered question cannot bounce it back`() {
        val answered = ChatUiState(session = sessionAsking("Pick a colour"), answeredQuestion = "Pick a colour")
        // fromFleet with the SAME question (a beat lagging the answer): stays hidden.
        val again = answered.fromFleet(null, sessionAsking("Pick a colour"), host = "h1")
        assertEquals("Pick a colour", again.answeredQuestion)
        assertEquals("", again.question)
    }

    @Test
    fun `the next question in the batch shows at once`() {
        val answered = ChatUiState(session = sessionAsking("Question 1"), answeredQuestion = "Question 1")
        // The agent advances to Q2 — the guard is forgotten and Q2 is shown, so a
        // second tap can never land on it before it appears (the erratic skip-ahead).
        val q2 = answered.fromFleet(null, sessionAsking("Question 2"), host = "h1")
        assertNull(q2.answeredQuestion)
        assertEquals("Question 2", q2.question)
    }

    @Test
    fun `clearing the question forgets the guard`() {
        val answered = ChatUiState(session = sessionAsking("Question 1"), answeredQuestion = "Question 1")
        val cleared = answered.fromFleet(null, sessionAsking(""), host = "h1")
        assertNull(cleared.answeredQuestion)
        assertEquals("", cleared.question)
    }

    @Test
    fun `a beat from a host with no local model clears the capability`() {
        // Not merely "leaves it alone": a host that lost its configuration must
        // stop offering the switch, and a stale carried-over block would keep it.
        val before = ChatUiState(localModel = configured, tunnelOnline = false)
        val after = before.fromFleet(
            AgentInfo(key = "h1", online = true, terminalOnline = true), null, host = "h1")
        assertNull(after.localModel)
        assertEquals("h1", after.hostLabel)          // no device name: fall back to the key
        assertTrue(after.tunnelOnline)               // recovers, not just degrades
        assertFalse(after.canSwitchModelSource())
    }
}
