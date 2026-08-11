package com.xerktech.turma.vm

import com.xerktech.turma.core.ModelSource
import com.xerktech.turma.core.Verbosity
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals(
            ModelSource.SUBSCRIPTION,
            state.modelSource(now = 1_000 + ModelSource.SWITCH_SETTLE_MS + 1),
        )
        // Another session's memo must never paint this one.
        val other = state.copy(modelSourcePending = ModelSource.Pending("s2", ModelSource.LOCAL, 1_000))
        assertEquals(ModelSource.SUBSCRIPTION, other.modelSource(now = 1_100))
    }

    @Test
    fun `no session record yet reads as the subscription`() {
        assertEquals(ModelSource.SUBSCRIPTION, ChatUiState().modelSource(now = 1))
        assertFalse(ChatUiState().canSwitchModelSource(now = 1))
    }
}
