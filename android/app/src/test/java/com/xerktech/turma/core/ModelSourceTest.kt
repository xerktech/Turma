package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
        // The boundary is a LITERAL, not `at + SWITCH_SETTLE_MS + 1`: derived
        // from the constant it only bounds the TTL from below, and raising it to
        // 16.7 hours — a chip pinned on a lie for the rest of the day, the exact
        // failure the constant exists to prevent — would keep the test green.
        assertEquals(60_000L, ModelSource.SWITCH_SETTLE_MS)
        assertEquals(ModelSource.LOCAL, ModelSource.current(sess, pending, 60_999))
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(sess, pending, 61_001))
    }

    @Test fun `a memo for another session never paints this one`() {
        val sess = SessionInfo(id = "s1", modelSource = "subscription")
        val other = ModelSource.Pending("s2", ModelSource.LOCAL, at = 1_000)
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(sess, other, 1_100))
    }

    @Test fun `a memo retires on the heartbeat agreeing, not on a blind timer`() {
        val p = ModelSource.Pending("s1", ModelSource.LOCAL, at = 1_000)
        val inside = 1_500L
        // Heartbeat still reports the old value: hold.
        assertEquals(p, ModelSource.settle(p, SessionInfo(id = "s1", modelSource = "subscription"), inside))
        // Heartbeat caught up: retire, well inside the TTL.
        assertNull(ModelSource.settle(p, SessionInfo(id = "s1", modelSource = "local"), inside))
        // A memo is never judged by a DIFFERENT session's record.
        assertEquals(p, ModelSource.settle(p, SessionInfo(id = "s2", modelSource = "local"), inside))
        assertEquals(p, ModelSource.settle(p, null, inside))
        assertNull(ModelSource.settle(null, SessionInfo(id = "s1"), inside))
    }

    @Test fun `an expired memo is retired from the store, not merely ignored on read`() {
        // The TTL cannot live only in `current`, which is read from a Composable
        // body: Compose skips recomposition while the state compares equal, so on
        // a quiet fleet nothing re-reads the clock and the expired value stays on
        // screen. Measured as the whole "run against" control vanishing on an
        // unconfirmed switch and never returning — t+120s and still gone.
        // Retiring the memo is a STATE CHANGE, which is what repaints it.
        val p = ModelSource.Pending("s1", ModelSource.LOCAL, at = 1_000)
        val held = SessionInfo(id = "s1", modelSource = "subscription")
        assertEquals(p, ModelSource.settle(p, held, 60_999))
        assertNull(ModelSource.settle(p, held, 61_001))
        // Ageing out is about the MEMO, so it applies even when this session's
        // record cannot speak to it — otherwise a memo left by a switch on
        // another session would never be collected at all.
        assertEquals(p, ModelSource.settle(p, SessionInfo(id = "s2"), 60_999))
        assertNull(ModelSource.settle(p, SessionInfo(id = "s2"), 61_001))
        assertNull(ModelSource.settle(p, null, 61_001))
        // `expired` is the same boundary `current` honours, so the memo can never
        // be retired while it is still being painted, nor painted after it is
        // retired. Both directions asserted at the boundary.
        assertEquals(false, ModelSource.expired(p, 60_999))
        assertEquals(true, ModelSource.expired(p, 61_001))
        assertEquals(false, ModelSource.expired(null, 61_001))
        // The EXACT boundary, not just either side of it: asserting 60_999 and
        // 61_001 alone leaves `>=` vs `>` a free choice, and that mutation
        // survived a battery. The TTL is inclusive — at exactly one full
        // SWITCH_SETTLE_MS the memo is spent.
        assertEquals(true, ModelSource.expired(p, 61_000))
        assertNull(ModelSource.settle(p, held, 61_000))
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(held, p, 61_000))
        assertEquals(ModelSource.LOCAL, ModelSource.current(held, p, 60_999))
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(held, p, 61_001))
    }

    @Test fun `a refused command reports the hub's own words, never a blanket queued`() {
        // setModel/setMode discarded their result and always said "✓ queued", so
        // the 409 the hub added for a session on the self-hosted model — added
        // precisely so an out-of-parity client could not silently drop the
        // command — painted as a success.
        val q = "✓ model queued"
        val f = "could not set the model"
        assertEquals(q, ModelSource.outcomeMessage(true, null, null, q, f))
        assertEquals(q, ModelSource.outcomeMessage(true, "", "", q, f))
        assertEquals("✗ session runs on the self-hosted model",
            ModelSource.outcomeMessage(false, null, "session runs on the self-hosted model", q, f))
        // A genuinely unanswered request has no hub words: fall back, and do NOT
        // reach for a network phrase the hub never said.
        assertEquals("✗ $f", ModelSource.outcomeMessage(false, null, null, q, f))
        assertEquals("✗ $f", ModelSource.outcomeMessage(false, null, "   ", q, f))
        // A refusal the hub answered 200 with. Branching on the HTTP status
        // alone is what made this bug the first time; `FleetViewModel.run`
        // already reads `OkResponse.error` and this side must agree.
        assertEquals("✗ agent refused the model",
            ModelSource.outcomeMessage(true, "agent refused the model", null, q, f))
        // Body error outranks the transport message when somehow both exist.
        assertEquals("✗ agent refused the model",
            ModelSource.outcomeMessage(false, "agent refused the model", "Bad Request", q, f))
    }

    @Test fun `a refused switch drops the memo instead of letting it age out`() {
        val p = ModelSource.Pending("s1", ModelSource.LOCAL, at = 1_000)
        // The hub 409s a host with no local model. Holding the memo for a full
        // minute with the answer already in hand is the same lie the TTL bounds.
        assertEquals(p, ModelSource.afterAttempt(p, ok = true))
        assertNull(ModelSource.afterAttempt(p, ok = false))
        assertNull(ModelSource.afterAttempt(null, ok = true))
    }

    @Test fun `a spawn sends the source only when it is local`() {
        // "subscription" is what a spawn already meant, so omitting it keeps a
        // bare spawn byte-identical to what it was before the failover existed.
        assertEquals("local", ModelSource.spawnValue(ModelSource.LOCAL))
        assertNull(ModelSource.spawnValue(ModelSource.SUBSCRIPTION))
        assertNull(ModelSource.spawnValue(""))
        assertNull(ModelSource.spawnValue(null))
    }

    @Test fun `the spawn composer offers the row only on a host reporting one`() {
        assertTrue(ModelSource.composerOffers(configured))
        assertFalse(ModelSource.composerOffers(unconfigured))
        assertFalse(ModelSource.composerOffers(null))
    }

    @Test fun `the composer reads the TARGET host's model, not the fleet's first`() {
        // "The wrong loop" is a shape this repo has shipped before, and the
        // composer's dialog only ever sees one host: offering another host's
        // model would queue a `local` spawn the target 409s or drops.
        val other = LocalModelInfo(available = true, model = "qwen3-coder:30b")
        val fleet = listOf(
            AgentInfo(key = "h0", localModel = other),
            AgentInfo(key = "h1", localModel = configured),
            AgentInfo(key = "h2", localModel = null),
        )
        assertEquals(configured, ModelSource.hostLocalModel(fleet, "h1"))
        assertEquals(other, ModelSource.hostLocalModel(fleet, "h0"))
        assertNull(ModelSource.hostLocalModel(fleet, "h2"))
        assertNull(ModelSource.hostLocalModel(fleet, "nosuchhost"))
        assertNull(ModelSource.hostLocalModel(emptyList(), "h1"))
    }

    @Test fun `a memo with no session id is never honoured`() {
        // Else it would paint every record-less session at once.
        val blank = ModelSource.Pending("", ModelSource.LOCAL, at = 0)
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(null, blank, 1))
        assertEquals(ModelSource.SUBSCRIPTION, ModelSource.current(SessionInfo(id = ""), blank, 1))
    }

    @Test fun `the chip carries the web's cloud-or-house glyph`() {
        // The colour alone can't answer "which model wrote this turn" for a
        // colour-blind reader.
        assertEquals("🏠", ModelSource.glyph(ModelSource.LOCAL))
        assertEquals("☁", ModelSource.glyph(ModelSource.SUBSCRIPTION))
    }

    @Test fun `a local session reads as the model name, not the word local`() {
        // It is a weaker model than Claude; nobody should have to wonder which
        // one wrote a turn.
        assertEquals("gpt-oss:120b", ModelSource.label(ModelSource.LOCAL, configured))
        assertEquals("Subscription", ModelSource.label(ModelSource.SUBSCRIPTION, configured))
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
