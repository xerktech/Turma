package com.xerktech.turma.ui

import com.xerktech.turma.model.AgentInfo
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `codingAgentLabel` mirrors index.html `codingAgent()`'s `/^(\S+)\s+\((.+)\)$/` over a
 * JS-trimmed version string. Rollup XERK-1701: the JVM's and a device's `\s`/`.`/trim
 * are not JavaScript's, so the same header read differently on the two clients.
 */
class CodingAgentLabelTest {
    private fun label(v: String) = codingAgentLabel(AgentInfo(key = "h", claudeVersion = v))

    @Test fun `parses the version the way the web does`() {
        assertEquals("Claude Code 2.1.3", label("2.1.3 (Claude Code)"))
        assertEquals("Claude Code 2.1.3", label("2.1.3"))
        assertEquals("–", label("  "))
        // NBSP separates (JS \s); BOM is trimmed (JS trim); NEL is in JS's `.`.
        assertEquals("Claude Code 2.1", label("2.1\u00A0(Claude Code)"))
        assertEquals("Claude Code 2.1", label("\uFEFF2.1 (Claude Code)\uFEFF"))
        assertEquals("Claude\u0085Code 2.1", label("2.1 (Claude\u0085Code)"))
        // U+001C is not JS whitespace: not trimmed, so the version is not "(...)"-final.
        assertEquals("Claude Code 2.1 (x)\u001C", label("2.1 (x)\u001C"))
    }

    private fun structured(name: String, version: String) = codingAgentLabel(
        AgentInfo(key = "h", claudeVersion = "9.9 (Fallback)", codingAgent = com.xerktech.turma.model.CodingAgent(name, version))
    )

    /** index.html: `c && c.version` and `c.name || "Claude Code"` — JS truthiness, where only
     *  "" is falsy, so a whitespace-only field is used as given, never treated as absent. */
    @Test fun `the structured fields follow JS truthiness`() {
        assertEquals("Codex 1.2", structured("Codex", "1.2"))
        assertEquals("Claude Code 1.2", structured("", "1.2"))
        assertEquals("Fallback 9.9", structured("Codex", ""))
        assertEquals("Claude Code  ", structured("", " "))
        assertEquals("  1.2", structured(" ", "1.2"))
    }
}
