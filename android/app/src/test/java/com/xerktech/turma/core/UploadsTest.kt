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
    fun `characters outside the safe set become underscores`() {
        assertEquals("d_j_ vu (1).PNG", Uploads.sanitizeUploadName("déjà vu (1).PNG"))
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
