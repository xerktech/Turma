package com.xerktech.turma.core

import java.text.Normalizer
import java.util.Locale

/**
 * File attachments in the chat composer (XERK-234) — the pure half, ported 1:1
 * from the web composer's attachment block in `chat.js`.
 *
 * A file is uploaded to the hub the moment it is picked, so pressing Send is
 * instant and a file too big (or a host too old to take one) is refused while
 * there is still something on screen to look at. The message then carries the
 * staged ids; the agent writes the bytes to disk on its host and prefixes their
 * paths onto what it types into the session.
 */

enum class AttachStatus { UPLOADING, READY, ERROR }

/** One file staged for the next message. */
data class Attachment(
    val key: String,
    val name: String,
    val size: Long,
    val status: AttachStatus = AttachStatus.UPLOADING,
    val uploadId: String = "",
    val error: String = "",
)

object Uploads {
    /**
     * Files one message may carry. Mirrors the hub's UPLOAD_MAX_PER_MESSAGE,
     * which refuses past it — this only keeps the composer from staging a
     * message the hub was always going to reject.
     */
    const val MAX_PER_MESSAGE = 10

    /** Controls, format/bidi/zero-width, variation selectors: dropped outright. */
    private val INVISIBLE = Regex("[\\p{Cc}\\p{Cf}\\u034F\\uFE00-\\uFE0F\\x{E0100}-\\x{E01EF}]")
    /** Anything but letters, digits, marks of any script and `._ ()+-`: "_". */
    // Nd/Nl, not all of N: superscript digits would let "COM¹.txt" (a Windows device) through.
    private val BAD_NAME = Regex("[^\\p{L}\\p{Nd}\\p{Nl}\\p{Mn}\\p{Mc}._ ()+\\-]")
    private const val NAME_MAX = 100        // code points
    private const val NAME_MAX_BYTES = 240  // UTF-8 (ext4: 255, less the agent's dedup suffix)

    private fun utf8Len(s: String) = s.toByteArray(Charsets.UTF_8).size

    /**
     * A filename safe to send as the upload's `name`. The hub sanitizes too (and
     * the agent again, since a name off the wire is joined onto a path), but
     * doing it here means the chip shows the name the file will land under
     * rather than one the hub silently rewrote. Port of `safeUploadName`:
     * non-ASCII letters survive (XERK-2947), and lengths count code points so a
     * cut never splits a surrogate pair.
     */
    fun sanitizeUploadName(name: String?): String {
        var s = (name ?: "").substringAfterLast('/').substringAfterLast('\\')
        s = INVISIBLE.replace(s, "")
        // NFC after the drop, so a second pass (the hub's, the agent's) is a no-op.
        s = Normalizer.normalize(s, Normalizer.Form.NFC)
        s = BAD_NAME.replace(s, "_")
        // Dots and spaces off the front together: ". .bashrc" is not a dotfile.
        s = Regex("\\s+").replace(s, " ").trimStart('.', ' ').trim()
        val cps = s.codePoints().toArray()
        if (cps.size > NAME_MAX || utf8Len(s) > NAME_MAX_BYTES) {
            val dot = cps.lastIndexOf('.'.code)
            val ext = if (dot > 0 && cps.size - dot <= 12) cps.copyOfRange(dot, cps.size) else IntArray(0)
            val extStr = String(ext, 0, ext.size)
            var n = minOf(cps.size, NAME_MAX - ext.size)
            val budget = NAME_MAX_BYTES - utf8Len(extStr)
            while (n > 0 && utf8Len(String(cps, 0, n)) > budget) n--
            s = (String(cps, 0, n) + extStr).trim()  // a cut can end on a space
        }
        return s.ifEmpty { "upload" }
    }

    /** Chip-sized byte count: "812 B", "44 KB", "3.2 MB". Port of `fmtBytes`. */
    fun formatBytes(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${(n + 512) / 1024} KB"
        // Locale.US: the web's fmtBytes always writes "3.2 MB", and a chip
        // reading "3,2 MB" on a German phone is the same divergence fmtTokens
        // had.
        n < 10L * 1024 * 1024 -> String.format(Locale.US, "%.1f MB", n / (1024.0 * 1024.0))
        else -> "${n / (1024 * 1024)} MB"
    }

    /** Whether this host can take attachments at all (0 = agent predates them). */
    fun canAttach(uploadMaxBytes: Long): Boolean = uploadMaxBytes > 0

    /**
     * The staged ids for the message about to be sent, or **null** when one is
     * still uploading or has failed — the caller then holds the message rather
     * than sending it with a file silently missing. An empty list simply means
     * nothing is attached.
     */
    fun readyUploadIds(list: List<Attachment>): List<String>? {
        if (list.isEmpty()) return emptyList()
        if (list.any { it.status != AttachStatus.READY }) return null
        return list.mapNotNull { it.uploadId.ifBlank { null } }
    }

    /** Why [readyUploadIds] said no — the message the composer shows. */
    fun holdReason(list: List<Attachment>): String =
        if (list.any { it.status == AttachStatus.ERROR }) "remove the failed file"
        else "files still uploading"
}
