package com.xerktech.turma.core

import com.xerktech.turma.model.ModelQualityGroup
import com.xerktech.turma.model.ModelQualityPr
import com.xerktech.turma.model.ModelQualityRework
import com.xerktech.turma.model.ModelQualityShadow
import com.xerktech.turma.model.TurmaJson
import com.xerktech.turma.model.parseModelQuality
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Ports of usage.html's `mq*` helpers (XERK-1849); each case mirrors the web test. */
class ModelQualityTest {
    private fun g(cls: String, model: String, sessions: Int = 0, good: Int = 0, bad: Int = 0) =
        ModelQualityGroup(cls = cls, model = model, sessions = sessions, good = good, bad = bad)

    @Test fun `bad rate counts only decided sessions`() {
        assertNull(ModelQuality.badRate(g("bug", "opus", sessions = 5)))
        assertEquals(0.25, ModelQuality.badRate(g("bug", "sonnet", good = 3, bad = 1))!!, 1e-9)
        assertEquals("25%", ModelQuality.pct(0.25))
        assertEquals("—", ModelQuality.pct(null))
    }

    @Test fun `the Opus column is the same class's Opus rate, absent for Opus itself`() {
        val groups = listOf(g("bug", "opus", good = 7, bad = 1), g("bug", "sonnet", good = 1, bad = 1),
            g("task", "haiku", good = 1))
        val base = ModelQuality.baselines(groups)
        assertEquals(0.125, ModelQuality.opusRate(groups[1], base)!!, 1e-9)
        assertNull(ModelQuality.opusRate(groups[0], base))
        assertNull(ModelQuality.opusRate(groups[2], base))
    }

    @Test fun `classes order by total sessions with Opus first inside each`() {
        val out = ModelQuality.ordered(listOf(
            g("story", "opus", sessions = 5), g("bug", "sonnet", sessions = 12),
            g("bug", "opus", sessions = 3), g("bug", "haiku", sessions = 4)))
        assertEquals(listOf("bug/opus", "bug/sonnet", "bug/haiku", "story/opus"), out.map { "${it.cls}/${it.model}" })
    }

    @Test fun `rework shadow and status read only what the hub serves`() {
        val plain = g("bug", "sonnet")
        assertEquals("—", ModelQuality.shadow(plain))
        assertEquals("—", ModelQuality.status(plain))
        assertEquals("baseline", ModelQuality.status(g("bug", "opus")))
        assertTrue(ModelQuality.reworkStats(plain).isEmpty())
        val served = plain.copy(rework = mapOf("ciRounds" to ModelQualityRework(2.0, 3), "qaRuns" to ModelQualityRework(1.5, 4)),
            shadow = ModelQualityShadow(pairs = 23, candidateOnlyBad = 1), promotion = "candidate")
        assertEquals(listOf("QA runs" to "1.5", "CI rounds" to "2"), ModelQuality.reworkStats(served))
        assertEquals("—", ModelQuality.median(Double.NaN))
        assertEquals("300000000", ModelQuality.median(3e8))
        assertEquals("23 · 1 worse", ModelQuality.shadow(served))
        assertEquals("candidate", ModelQuality.status(served))
    }

    @Test fun `a PR link needs an http url`() {
        assertEquals("#412" to "merged", ModelQuality.prLabel(ModelQualityPr("https://github.com/a/b/pull/412", "MERGED")))
        assertNull(ModelQuality.prLabel(ModelQualityPr("javascript:alert(1)")))
        assertEquals("pending", ModelQuality.outcomeOf("weird"))
    }

    @Test fun `the hub's answer decodes, no-change included, extra fields ignored`() {
        val v = parseModelQuality(TurmaJson.parseToJsonElement(
            """{"windowDays":90,"groups":[{"cls":"bug","model":"opus","sessions":3,"good":1,"bad":1,"pending":0,
              "no-change":1,"undelivered":0,"reasons":{"reopened":1},"future":true}],
              "rows":[{"key":"x","site":"s","issue":"A-1","host":"h","sid":"s1","cls":"bug","model":"opus",
              "firstSeen":1,"updatedAt":2.5,"outcome":"bad","reason":"reopened",
              "prs":[{"url":"https://x/pull/1","state":"MERGED","mergedAt":3}]}]}"""))
        assertEquals(1, v.groups[0].noChange)
        assertEquals("1 no change", ModelQuality.other(v.groups[0]))
        assertEquals("A-1", v.rows[0].issue)
        assertEquals(1, v.rows[0].prs.size)
    }

    @Test fun `a wrong-typed field drops to its default instead of failing the card`() {
        val v = parseModelQuality(TurmaJson.parseToJsonElement(
            """{"windowDays":90.5,"groups":[null,{"cls":"bug","model":"sonnet","sessions":1.5,"good":3000000000,
              "promotion":{"x":1},"rework":{"qaRuns":{"median":"n/a","n":2},"qaFail":[1],"ciRounds":{"median":2,"n":3}},"reasons":{"x":null}}],
              "rows":[null,{"issue":"A-1","updatedAt":"x","prs":[null]}]}"""))
        assertEquals(90, v.windowDays)
        val g = v.groups.single()
        assertEquals(1, g.sessions)
        assertEquals(Int.MAX_VALUE, g.good)
        assertNull(g.promotion)
        assertEquals(mapOf("ciRounds" to ModelQualityRework(2.0, 3)), g.rework)
        assertEquals(mapOf("x" to 0), g.reasons)
        assertNull(v.rows.single().updatedAt)
        assertTrue(v.rows.single().prs.isEmpty())
        assertEquals(0, parseModelQuality(TurmaJson.parseToJsonElement("[1]")).groups.size)
        assertEquals(0, parseModelQuality(TurmaJson.parseToJsonElement(
            """{"groups":[{"cls":"bug","model":"opus","bad":-3}]}""")).groups.single().bad)
    }

    @Test fun `rework with no figures adds no column, as on the web`() {
        val v = parseModelQuality(TurmaJson.parseToJsonElement(
            """{"groups":[{"cls":"bug","model":"opus","rework":{"qaRuns":{"median":null,"n":0}}}]}"""))
        assertTrue(ModelQuality.reworkStats(v.groups.single()).isEmpty())
    }
}
