package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.DshInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.LocalModelOption
import com.xerktech.turma.model.QwenInfo
import com.xerktech.turma.model.SessionInfo
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The pure runtime-selection rules (XERK-460), the mirror of `ModelSourceTest`.
 * The composer's call site is pinned separately in `ui/SpawnComposerTest`; these
 * pin the rules themselves.
 */
class RuntimeTest {

    // dsh ships DISABLED fleet-wide (Runtime.DSH_ENABLED = false). The dsh
    // machinery is RETAINED, so these tests prove it still works when enabled;
    // reset in @After so the flag can't leak into any other test.
    @Before fun enableDsh() { Runtime.DSH_ENABLED = true }
    @After fun resetDsh() { Runtime.DSH_ENABLED = false; Runtime.QWEN_ENABLED = false }

    @Test fun `with the kill switch OFF every dsh surface refuses`() {
        Runtime.DSH_ENABLED = false
        val dsh = DshInfo(available = true)
        val agents = listOf(AgentInfo(key = "b", dsh = dsh))
        assertFalse(Runtime.composerOffers(dsh))
        assertFalse(Runtime.isDsh("dsh"))
        assertNull(Runtime.hostDsh(agents, "b"))
        assertNull(Runtime.hostDshFor(agents, "b"))
        // The composer's Runtime rows drop dsh even when the host reports it.
        assertFalse(Runtime.composerRuntimes(null, dsh).any { it.first == "dsh" })
    }

    @Test fun `composerOffers follows the host capability flag, absent means cannot`() {
        assertTrue(Runtime.composerOffers(DshInfo(available = true)))
        assertFalse(Runtime.composerOffers(DshInfo(available = false)))
        // Absent block (a pre-dsh agent) is "cannot do it", never "assume it can".
        assertFalse(Runtime.composerOffers(null))
    }

    @Test fun `spawnValue sends only dsh, never the default claude`() {
        assertEquals("dsh", Runtime.spawnValue("dsh"))
        // claude is what a spawn already meant, so it is omitted to keep a bare
        // spawn byte-identical.
        assertNull(Runtime.spawnValue("claude"))
        assertNull(Runtime.spawnValue(null))
        assertNull(Runtime.spawnValue(""))
    }

    @Test fun `isDsh badges only a dsh session`() {
        assertTrue(Runtime.isDsh("dsh"))
        assertFalse(Runtime.isDsh("claude"))
        // "" is what an agent predating the field reports (coerced hub-side).
        assertFalse(Runtime.isDsh(""))
        assertFalse(Runtime.isDsh(null))
    }

    @Test fun `hostDsh reads the TARGET host, never the fleet's first`() {
        val agents = listOf(
            AgentInfo(key = "a", dsh = DshInfo(available = false)),
            AgentInfo(key = "b", dsh = DshInfo(available = true)),
        )
        assertEquals(false, Runtime.hostDsh(agents, "a")?.available)
        assertEquals(true, Runtime.hostDsh(agents, "b")?.available)
        assertNull(Runtime.hostDsh(agents, "missing"))
    }

    // ---- the unified Runtime picker (XERK-503) -------------------------------

    @Test fun `composerRuntimes offers only the runtimes the host reports`() {
        // Plain subscription host -> just Claude Code (the caller then hides the
        // one-option picker).
        assertEquals(listOf("claude"), Runtime.composerRuntimes(null, null).map { it.first })
        // A local endpoint adds "Claude Code Local".
        assertEquals(
            listOf("claude" to "Claude Code", "local" to "Claude Code Local"),
            Runtime.composerRuntimes(LocalModelInfo(available = true), null),
        )
        // dsh adds "dsh"; both present -> all three, in order.
        assertEquals(
            listOf("claude", "local", "dsh"),
            Runtime.composerRuntimes(LocalModelInfo(available = true), DshInfo(available = true))
                .map { it.first },
        )
        // A non-available block does not add its row.
        assertEquals(
            listOf("claude"),
            Runtime.composerRuntimes(LocalModelInfo(available = false), DshInfo(available = false))
                .map { it.first },
        )
    }

    @Test fun `a chosen runtime maps onto the agentType and modelSource wire fields`() {
        // Claude Code: nothing sent (bare spawn unchanged).
        assertNull(Runtime.spawnAgentType("claude"))
        assertNull(Runtime.spawnModelSource("claude"))
        // Claude Code Local: modelSource local, still a claude agent.
        assertNull(Runtime.spawnAgentType("local"))
        assertEquals("local", Runtime.spawnModelSource("local"))
        // dsh: agentType dsh, no modelSource.
        assertEquals("dsh", Runtime.spawnAgentType("dsh"))
        assertNull(Runtime.spawnModelSource("dsh"))
    }

    // ---- the qwen (Qwen Code, XERK-504/506 [Qwen A]) runtime ------------------

    @Test fun `qwen runtime mirrors the dsh selection plumbing`() {
        Runtime.QWEN_ENABLED = true
        val qwen = QwenInfo(available = true)
        val agents = listOf(
            AgentInfo(key = "a", qwen = QwenInfo(available = false)),
            AgentInfo(key = "b", qwen = qwen),
        )
        // The composer's Runtime rows add "Qwen Code" when the host offers it,
        // gated on the host's own flag like dsh.
        assertEquals(
            listOf("claude" to "Claude Code", "qwen" to "Qwen Code"),
            Runtime.composerRuntimes(null, null, qwen),
        )
        assertFalse(Runtime.composerRuntimes(null, null, QwenInfo(available = false))
            .any { it.first == "qwen" })
        // spawnAgentType/spawnValue send "qwen" (a non-default runtime), never claude.
        assertEquals("qwen", Runtime.spawnAgentType("qwen"))
        assertEquals("qwen", Runtime.spawnValue("qwen"))
        assertNull(Runtime.spawnModelSource("qwen"))
        // hostQwen reads the TARGET host, never the fleet's first.
        assertEquals(false, Runtime.hostQwen(agents, "a")?.available)
        assertEquals(true, Runtime.hostQwen(agents, "b")?.available)
        assertNull(Runtime.hostQwen(agents, "missing"))
    }

    @Test fun `with the qwen kill switch OFF every qwen surface refuses`() {
        Runtime.QWEN_ENABLED = false
        val qwen = QwenInfo(available = true)
        val agents = listOf(AgentInfo(key = "b", qwen = qwen))
        // The row is dropped and the target-host lookup returns null even when the
        // host reports the capability — the fleet-wide kill switch wins first.
        assertFalse(Runtime.composerRuntimes(null, null, qwen).any { it.first == "qwen" })
        assertNull(Runtime.hostQwen(agents, "b"))
    }

    @Test fun `isQwen badges only a qwen session, and the label needs no host lookup`() {
        Runtime.QWEN_ENABLED = true
        assertTrue(Runtime.isQwen("qwen"))
        assertFalse(Runtime.isQwen("claude"))
        assertFalse(Runtime.isQwen("dsh"))
        // "" is what an agent predating the field reports (coerced hub-side).
        assertFalse(Runtime.isQwen(""))
        assertFalse(Runtime.isQwen(null))
        // Qwen has NO discovered model list (capability-flag-only), so the footer
        // label is the session's own model with a generic fallback — no
        // DshInfo-style host lookup involved.
        assertEquals("qwen3-coder", Runtime.qwenModelLabel(SessionInfo(id = "s", model = "qwen3-coder")))
        assertEquals("qwen model", Runtime.qwenModelLabel(SessionInfo(id = "s", model = "")))
        assertEquals("qwen model", Runtime.qwenModelLabel(null))
        Runtime.QWEN_ENABLED = false
        assertFalse(Runtime.isQwen("qwen"))
    }

    // ---- dsh model list (XERK-503/504) ---------------------------------------

    @Test fun `dsh model helpers mirror the local ones over the discovered set`() {
        val dsh = DshInfo(
            available = true, defaultModel = "deepseek-chat",
            models = listOf(
                LocalModelOption("deepseek-chat", 128000),
                LocalModelOption("qwen3-coder", 32768),
            ),
        )
        assertTrue(Runtime.dshModelPickable(dsh))
        assertFalse(Runtime.dshModelPickable(DshInfo(available = true, models = emptyList())))
        // Options are "id · Nk".
        assertEquals(listOf("deepseek-chat", "qwen3-coder"), Runtime.dshOptions(dsh).map { it.first })
        assertEquals("qwen3-coder · 33k", Runtime.dshOptions(dsh)[1].second)
        // The session's own model wins over the host default.
        assertEquals("qwen3-coder", Runtime.currentDshModel(SessionInfo(id = "s", model = "qwen3-coder"), dsh))
        assertEquals("deepseek-chat", Runtime.currentDshModel(SessionInfo(id = "s", model = ""), dsh))
        assertEquals("deepseek-chat · 128k", Runtime.dshModelLabel(SessionInfo(id = "s", model = "deepseek-chat"), dsh))
    }
}
