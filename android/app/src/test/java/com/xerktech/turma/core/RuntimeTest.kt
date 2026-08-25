package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.DshInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure runtime-selection rules (XERK-460), the mirror of `ModelSourceTest`.
 * The composer's call site is pinned separately in `ui/SpawnComposerTest`; these
 * pin the rules themselves.
 */
class RuntimeTest {

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
}
