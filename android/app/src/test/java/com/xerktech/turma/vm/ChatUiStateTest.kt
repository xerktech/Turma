package com.xerktech.turma.vm

import com.xerktech.turma.core.Verbosity
import org.junit.Assert.assertEquals
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

    // XERK-252. The open chat is never closed by an unreachable host — it says
    // why it has gone quiet instead, and the notice clears itself.
    @Test
    fun `a reachable host raises no hold notice`() {
        assertNull(ChatUiState(hostLabel = "hostA").holdNotice)
    }

    @Test
    fun `a dead terminal tunnel is worded apart from an offline host`() {
        val tunnel = ChatUiState(hostLabel = "hostA", terminalOnline = false).holdNotice
        assertTrue(tunnel!!.contains("hostA's terminal tunnel is down"))
        assertTrue(tunnel.contains("holding this session"))

        val offline = ChatUiState(hostLabel = "hostA", hostOnline = false).holdNotice
        assertTrue(offline!!.contains("hostA is offline"))
    }

    // An offline host is the bigger fact: its tunnel is down as a consequence,
    // so saying "tunnel down" about a host that isn't reporting at all would
    // understate it.
    @Test
    fun `offline wins over the tunnel when both are false`() {
        val both = ChatUiState(hostLabel = "hostA", hostOnline = false, terminalOnline = false).holdNotice
        assertTrue(both!!.contains("is offline"))
    }

    // A beat carrying no record for this host tells us nothing about it; the
    // defaults must read as "as far as we know, fine" rather than as a fault.
    @Test
    fun `a state with no host news holds nothing`() {
        assertNull(ChatUiState().holdNotice)
    }
}
