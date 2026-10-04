package com.xerktech.turma.model

import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * `GET /api/permissions` (XERK-1563) decodes on its own call (XERK-1576), so an
 * older hub (fewer fields) or a newer one (a kind this build never saw) must
 * still decode, and a wrong-typed field costs this one decode — never the fleet.
 */
class PermissionDecodeTest {

    private fun decode(json: String) = TurmaJson.decodeFromString<PermissionSummary>(json)

    @Test fun `the full shape the hub serves decodes field for field`() {
        val s = decode(
            """
            {"days":7,
             "top":[
              {"kind":"dialog","dialogKind":"permission","tool":"Bash","head":"git status","count":3,
               "allowed":2,"denied":1,"open":0,"medianWaitMs":45000,"lastAt":1759500000000,
               "suggestedRule":"Bash(git status:*)"},
              {"kind":"ask-in-chat","dialogKind":null,"tool":null,"head":null,"count":2,"allowed":null,
               "denied":null,"open":1,"medianWaitMs":null,"lastAt":1759500000001,
               "suggestedRule":"model behaviour: see CLAUDE.md step 0","prompt":"Shall I push?"},
              {"kind":"classifier-denied","tool":"Bash","head":"curl","count":1,"allowed":0,"denied":1,
               "open":0,"medianWaitMs":null,"lastAt":1,"suggestedRule":null,
               "noRuleReason":"not on the read-only list","denyReason":"network egress"}],
             "recent":[
              {"host":"nas01","id":"p1","sessionId":"s1","kind":"dialog","dialogKind":"permission",
               "tool":"Bash","head":"git status","answer":"allow","via":"pane","waitedMs":45000,
               "openedAt":1759500000000,"closedAt":1759500045000}]}
            """.trimIndent(),
        )
        assertEquals(7, s.days)
        assertEquals(3, s.top.size)
        val g = s.top[0]
        assertEquals("dialog", g.kind)
        assertEquals("git status", g.head)
        assertEquals(3, g.count)
        assertEquals(2, g.allowed)
        assertEquals(1, g.denied)
        assertEquals(45000.0, g.medianWaitMs!!, 0.0)
        assertEquals("Bash(git status:*)", g.suggestedRule)
        // An ask's allowed/denied stay null ("can't tell"), never a 0/0 "ignored".
        assertNull(s.top[1].allowed)
        assertNull(s.top[1].denied)
        assertEquals("Shall I push?", s.top[1].prompt)
        assertEquals(1, s.top[1].open)
        assertEquals("network egress", s.top[2].denyReason)
        assertEquals("not on the read-only list", s.top[2].noRuleReason)
        val r = s.recent.single()
        assertEquals("nas01", r.host)
        assertEquals("allow", r.answer)
        assertEquals(45000.0, r.waitedMs!!, 0.0)
        assertEquals(1759500045000.0, r.closedAt!!, 0.0)
    }

    @Test fun `a judged row decodes its verdict and reason, and tolerates both absent`() {
        val s = decode(
            """
            {"days":7,
             "top":[{"kind":"judged","tool":"Bash","head":"rm","count":2,"allowed":1,"denied":1,"open":0,
                     "medianWaitMs":3000,"lastAt":5,"suggestedRule":null}],
             "recent":[
              {"host":"nas01","id":"j1","sessionId":"s1","kind":"judged","tool":"Bash","head":"rm",
               "answer":"allow","waitedMs":3000,"openedAt":5,"closedAt":8,
               "verdict":"allow","judgeReason":"build output only"},
              {"host":"nas01","id":"j2","sessionId":"s1","kind":"judged","tool":"Bash","head":"rm",
               "openedAt":4}]}
            """.trimIndent(),
        )
        assertEquals("judged", s.top.single().kind)
        assertNull(s.top.single().suggestedRule)
        val (with, without) = s.recent
        assertEquals("judged", with.kind)
        assertEquals("allow", with.verdict)
        assertEquals("build output only", with.judgeReason)
        assertNull(without.verdict)
        assertNull(without.judgeReason)
    }

    @Test fun `every field absent decodes to its can't-tell default`() {
        val s = decode("{}")
        assertEquals(0, s.days)
        assertTrue(s.top.isEmpty())
        assertTrue(s.recent.isEmpty())
        val bare = decode("""{"top":[{}],"recent":[{}]}""")
        val g = bare.top.single()
        assertEquals("", g.kind)
        assertEquals(0, g.count)
        assertNull(g.allowed)
        assertNull(g.open)
        assertNull(g.medianWaitMs)
        assertNull(g.suggestedRule)
        val r = bare.recent.single()
        assertEquals("", r.host)
        assertNull(r.openedAt)
        assertNull(r.waitedMs)
        assertNull(r.verdict)
        assertNull(r.judgeReason)
    }

    @Test fun `a kind this build has never seen, and unknown keys, still decode`() {
        val s = decode(
            """{"days":7,"future":true,"top":[{"kind":"sandbox-escape","count":4,"newField":{"x":1}}],
                "recent":[{"kind":"sandbox-escape","host":"h","openedAt":1.5}]}""",
        )
        assertEquals("sandbox-escape", s.top.single().kind)
        assertEquals(4, s.top.single().count)
        // A fractional time (the hub floors today) must not throw either.
        assertEquals(1.5, s.recent.single().openedAt!!, 0.0)
    }

    @Test fun `a wrong-typed field rejects this endpoint's decode — and only this one`() {
        for (bad in listOf(
            """{"top":"nope"}""",
            """{"top":[{"count":"many"}]}""",
            """{"recent":[{"waitedMs":{"ms":1}}]}""",
        )) {
            try {
                decode(bad)
                fail("expected $bad to be refused")
            } catch (_: SerializationException) {
                // expected: the Usage screen's permission section shows a load failure
            }
        }
        // The same hub's fleet payload is a DIFFERENT decode, untouched by it.
        val fleet = TurmaJson.decodeFromString<AgentsResponse>("""{"now":1,"agents":[{"key":"h"}]}""")
        assertEquals("h", fleet.agents.single().key)
    }
}
