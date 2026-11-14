package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.TurmaJson
import kotlinx.serialization.decodeFromString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity with the web composer's attachment block in turma/public/chat.js and
 * the hub's safeUploadName (XERK-234).
 */
class UploadsTest {

    private fun att(
        key: String,
        status: AttachStatus,
        uploadId: String = "u-$key",
    ) = Attachment(key = key, name = "$key.png", size = 10, status = status, uploadId = uploadId)

    // --- name sanitising: the same answers the hub and agent give -----------

    @Test
    fun `a name can never escape the uploads directory`() {
        assertEquals("passwd", Uploads.sanitizeUploadName("../../etc/passwd"))
        assertEquals("a.png", Uploads.sanitizeUploadName("C:\\win\\a.png"))
        assertEquals("x.tar.gz", Uploads.sanitizeUploadName("/abs/x.tar.gz"))
    }

    @Test
    fun `an upload is never a dotfile, and never nameless`() {
        assertEquals("hidden.png", Uploads.sanitizeUploadName("  ..hidden.png"))
        assertEquals("upload", Uploads.sanitizeUploadName(""))
        assertEquals("upload", Uploads.sanitizeUploadName("."))
        assertEquals("upload", Uploads.sanitizeUploadName(null))
    }

    @Test
    fun `an over-long name keeps its extension`() {
        val long = "a".repeat(130) + ".png"
        val out = Uploads.sanitizeUploadName(long)
        assertEquals(100, out.length)
        assertTrue(out.endsWith(".png"))
    }

    @Test
    fun `letters of any script survive and invisibles are dropped`() {
        // XERK-2947. The same table as the hub's server.test.js and the agent's
        // TestSafeUploadName — the three must agree.
        val cases = listOf(
            "déjà vu (1).PNG" to "déjà vu (1).PNG",
            "e\u0301te\u0301.png" to "\u00e9t\u00e9.png",   // NFD in, NFC out
            "報告書.pdf" to "報告書.pdf",
            "Привет мир.txt" to "Привет мир.txt",
            "invoice\u202egnp.exe" to "invoicegnp.exe",     // bidi override
            "a\u200bb.png" to "ab.png",                     // zero-width
            "a\ufe0fb.png" to "ab.png",                     // variation selector
            "a\nb;rm -rf.txt" to "ab_rm -rf.txt",           // control dropped
            "\uD83D\uDCF7 shot.png" to "_ shot.png",        // one _ per code point
            "a\u00a0b.png" to "a_b.png",                    // non-ASCII space
            "a\uff0fb" to "a_b",                            // fullwidth solidus
            "\uD800x.png" to "_x.png",                      // lone surrogate
            "re\u00ad\u0301sume\u0301.pdf" to "r\u00e9sum\u00e9.pdf", // NFC after the drop
            "COM\u00b9.txt" to "COM_.txt",                  // a Windows device name
            ". .bashrc" to "bashrc",                         // never a dotfile
            ". .." to "upload",
        )
        for ((raw, want) in cases) {
            assertEquals(raw, want, Uploads.sanitizeUploadName(raw))
            // Idempotent: the hub and agent re-sanitize this answer.
            assertEquals(want, want, Uploads.sanitizeUploadName(want))
        }
        assertEquals("a".repeat(99), Uploads.sanitizeUploadName("a".repeat(99) + " " + "b".repeat(10)))
    }

    @Test
    fun `a cut counts code points and utf8 bytes`() {
        assertEquals("字".repeat(78) + ".png", Uploads.sanitizeUploadName("字".repeat(130) + ".png"))
        val astral = "\uD840\uDC00"
        assertEquals(astral.repeat(59) + ".png", Uploads.sanitizeUploadName(astral.repeat(130) + ".png"))
        assertEquals("é".repeat(96) + ".png", Uploads.sanitizeUploadName("é".repeat(130) + ".png"))
    }

    // --- the capability flag ------------------------------------------------

    @Test
    fun `an agent that reports no cap cannot take files`() {
        assertFalse(Uploads.canAttach(0))
        assertTrue(Uploads.canAttach(1 shl 20))
    }

    @Test
    fun `uploadMaxBytes decodes off the fleet payload, and defaults to zero`() {
        val withCap = TurmaJson.decodeFromString<AgentInfo>("""{"key":"h","uploadMaxBytes":33554432}""")
        assertEquals(33554432L, withCap.uploadMaxBytes)
        // An agent predating attachments sends no such key at all.
        val older = TurmaJson.decodeFromString<AgentInfo>("""{"key":"h"}""")
        assertEquals(0L, older.uploadMaxBytes)
        assertFalse(Uploads.canAttach(older.uploadMaxBytes))
    }

    // --- what may be sent ---------------------------------------------------

    @Test
    fun `nothing attached sends an empty list, not a hold`() {
        assertEquals(emptyList<String>(), Uploads.readyUploadIds(emptyList()))
    }

    @Test
    fun `every file ready sends their ids in order`() {
        val ids = Uploads.readyUploadIds(listOf(att("a", AttachStatus.READY), att("b", AttachStatus.READY)))
        assertEquals(listOf("u-a", "u-b"), ids)
    }

    @Test
    fun `a file still uploading holds the message`() {
        val list = listOf(att("a", AttachStatus.READY), att("b", AttachStatus.UPLOADING))
        assertNull(Uploads.readyUploadIds(list))
        assertEquals("files still uploading", Uploads.holdReason(list))
    }

    @Test
    fun `a failed file holds the message and says which problem it is`() {
        val list = listOf(att("a", AttachStatus.READY), att("b", AttachStatus.ERROR))
        assertNull(Uploads.readyUploadIds(list))
        assertEquals("remove the failed file", Uploads.holdReason(list))
    }

    // --- chip formatting ----------------------------------------------------

    @Test
    fun `sizes read the way the web chip reads them`() {
        assertEquals("812 B", Uploads.formatBytes(812))
        assertEquals("44 KB", Uploads.formatBytes(44 * 1024))
        assertEquals("3.0 MB", Uploads.formatBytes(3 * 1024 * 1024))
        assertEquals("32 MB", Uploads.formatBytes(32L * 1024 * 1024))
    }
}
