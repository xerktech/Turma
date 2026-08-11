package com.xerktech.turma.core

import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The local-model failover control (XERK-246), ported from web `chat.js`.
 * The rules that matter are the two gates — a host that can't fail over must not
 * be offered the switch, and a session already on the local model must always
 * keep a way back — plus the memo that stops a slow relaunch reading as a dead
 * button without letting it lie forever.
 */
class ModelSourceTest {

    private val configured = LocalModelInfo(available = true, model = "gpt-oss:120b", contextTokens = 81920)
    private val unconfigured = LocalModelInfo(available = false)

    @Test fun `the control follows the host's capability flag`() {
        assertTrue(ModelSource.offered(configured, ModelSource.SUBSCRIPTION))
        assertFalse(ModelSource.offered(unconfigured, ModelSource.SUBSCRIPTION))
        // An agent predating the failover reports no block at all — "cannot",
        // never "assume it can".
        assertFalse(ModelSource.offered(null, ModelSource.SUBSCRIPTION))
    }

    @Test fun `a session already local keeps the control after its host loses the config`() {
        // Otherwise it is stranded on the weaker model with no way back.
        assertTrue(ModelSource.offered(null, ModelSource.LOCAL))
        assertTrue(ModelSource.offered(unconfigured, ModelSource.LOCAL))
    }

    @Test fun `a blank model source reads as the subscription`() {
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(SessionInfo(id = "s1"), null, 0))
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(null, null, 0))
        assertEquals(
            ModelSource.LOCAL,
            ModelSource.current(SessionInfo(id = "s1", modelSource = "local"), null, 0),
        )
    }

    @Test fun `an unconfirmed switch paints its own value until it settles`() {
        val sess = SessionInfo(id = "s1", modelSource = "subscription")
        val pending = ModelSource.Pending("s1", ModelSource.LOCAL, at = 1_000)
        // The relaunch takes several beats; without the memo the chip springs
        // back and reads as a control that did nothing.
        assertEquals(ModelSource.LOCAL, ModelSource.current(sess, pending, 1_500))
        // ...but it ages out, so a switch that never lands can't pin it on a lie.
        assertEquals(
            ModelSource.SUBSCRIPTION,
            ModelSource.current(sess, pending, 1_000 + ModelSource.SWITCH_SETTLE_MS + 1),
        )
    }

    @Test fun `a memo for another session never paints this one`() {
        val sess = SessionInfo(id = "s1", modelSource = "subscription")
        val other = ModelSource.Pending("s2", ModelSource.LOCAL, at = 1_000)
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(sess, other, 1_100))
    }

    @Test fun `a local session reads as the model name, not the word local`() {
        // It is a weaker model than Claude; nobody should have to wonder which
        // one wrote a turn.
        assertEquals("gpt-oss:120b", ModelSource.label(ModelSource.LOCAL, configured))
        assertEquals("subscription", ModelSource.label(ModelSource.SUBSCRIPTION, configured))
        // A host that stopped reporting a name still labels the row honestly.
        assertEquals("local model", ModelSource.label(ModelSource.LOCAL, null))
        assertEquals("Self-hosted model", ModelSource.options(null)[1].second)
        assertEquals("gpt-oss:120b", ModelSource.options(configured)[1].second)
        assertEquals(
            listOf(ModelSource.SUBSCRIPTION, ModelSource.LOCAL),
            ModelSource.options(configured).map { it.first },
        )
    }

    @Test fun `the Claude model picker is hidden on the local model`() {
        // Every alias it could offer — "default" included, since that resolves to
        // the shared login's default — is one the self-hosted endpoint refuses.
        assertFalse(ModelSource.modelPickable(ModelSource.LOCAL))
        assertTrue(ModelSource.modelPickable(ModelSource.SUBSCRIPTION))
    }
}
