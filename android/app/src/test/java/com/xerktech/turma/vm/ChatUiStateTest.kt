package com.xerktech.turma.vm

import com.xerktech.turma.core.Verbosity
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatUiStateTest {
    @Test
    fun `chat sessions default to concise verbosity`() {
        // XERK-40: a deliberate divergence from the web's Normal default (see PARITY.md).
        assertEquals(Verbosity.CONCISE, ChatUiState().verbosity)
        assertEquals(Verbosity.CONCISE.ordinal, 0) // the SharedPreferences fallback in ChatViewModel
    }
}
