package com.xerktech.turma.data

import com.xerktech.turma.core.ModelSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * XERK-246: the model-source memo has to be the SAME object every time a chat
 * asks for it, or leaving the chat screen and coming back mid-switch destroys it
 * — the chip then springs back to the old value and reads as a control that did
 * nothing, which is the whole reason the memo exists.
 *
 * Same shape and same reasoning as [DraftStoreTest]; a fresh flow per call is a
 * change nothing else in the suite would notice.
 */
class ModelSwitchStoreTest {

    private fun pending(v: String) = ModelSource.Pending("s1", v, at = 1_000)

    @Test
    fun `re-entering a chat gets the same memo object back`() {
        val store = ModelSwitchStore()
        val first = store.of("hostA", "sess1")
        first.value = pending(ModelSource.LOCAL)

        // What a leave-and-return does: ask the store again.
        val afterReturn = store.of("hostA", "sess1")
        assertSame(first, afterReturn)
        assertEquals(ModelSource.LOCAL, afterReturn.value?.value)
    }

    @Test
    fun `memos are per session, and per host`() {
        val store = ModelSwitchStore()
        store.of("hostA", "sess1").value = pending(ModelSource.LOCAL)
        // Session ids are unique per host, not fleet-wide, so the host has to be
        // part of the key — else one host's switch paints another's session.
        assertNull(store.of("hostA", "sess2").value)
        assertNull(store.of("hostB", "sess1").value)
        assertNotSame(store.of("hostA", "sess1"), store.of("hostB", "sess1"))
    }

    @Test
    fun `a session that never switched starts with no memo`() {
        assertNull(ModelSwitchStore().of("hostA", "fresh").value)
    }
}
