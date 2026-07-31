package com.xerktech.turma.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * XERK-122: the chat and terminal screens each have a compose box over the same
 * session, so the draft they edit has to be one shared object — otherwise
 * stepping into the terminal to read the pane eats what you were typing.
 */
class DraftStoreTest {
    @Test
    fun `both screens of one session get the same draft`() {
        val store = DraftStore()
        val chat = store.of("hostA", "sess1")
        val terminal = store.of("hostA", "sess1")

        assertSame(chat, terminal)
        chat.value = "check the logs and then"
        assertEquals("check the logs and then", terminal.value)
        terminal.value = "" // sending from either box clears the draft for both
        assertEquals("", chat.value)
    }

    @Test
    fun `drafts are per session, and per host`() {
        val store = DraftStore()
        store.of("hostA", "sess1").value = "one"
        store.of("hostA", "sess2").value = "two"
        // Session ids are unique per host, not fleet-wide (the shared ~/.claude
        // syncs transcripts), so the host has to be part of the key.
        store.of("hostB", "sess1").value = "three"

        assertEquals("one", store.of("hostA", "sess1").value)
        assertEquals("two", store.of("hostA", "sess2").value)
        assertEquals("three", store.of("hostB", "sess1").value)
        assertNotSame(store.of("hostA", "sess1"), store.of("hostB", "sess1"))
    }

    @Test
    fun `a session with no draft starts empty`() {
        assertEquals("", DraftStore().of("hostA", "fresh").value)
    }
}
