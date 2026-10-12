package com.xerktech.turma.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * `GET /api/model-quality` (XERK-1839): per (work class, model) how ticket
 * sessions turned out, FLEET-WIDE, plus — only when one org is named with
 * `rows=1` — that org's newest per-session [rows]. Web twin: usage.html's
 * "Model quality" card (`modelQualityCardHtml`, XERK-1849).
 *
 * Read on ITS OWN call, never inside the atomic `/api/agents` decode, and read
 * FIELD BY FIELD ([parse]) rather than decoded: a wrong-typed field (a later
 * seam's shape, a null element) drops to its default, as the web treats it,
 * instead of failing the whole card. [rework], [shadow] and [promotion] are
 * served once XERK-1845/1847/1848 ship; absent until then.
 */
data class ModelQualityView(
    val windowDays: Int = 0,
    val groups: List<ModelQualityGroup> = emptyList(),
    val rows: List<ModelQualityRow> = emptyList(),
)

data class ModelQualityGroup(
    val cls: String = "",
    val model: String = "",
    val sessions: Int = 0,
    val good: Int = 0,
    val bad: Int = 0,
    val pending: Int = 0,
    val noChange: Int = 0,
    val undelivered: Int = 0,
    /** Why the bad sessions were bad: reason → count. */
    val reasons: Map<String, Int> = emptyMap(),
    /** Rework signal → its median over the sessions that reported it (XERK-1845). */
    val rework: Map<String, ModelQualityRework> = emptyMap(),
    val shadow: ModelQualityShadow? = null,
    val promotion: String? = null,
)

/** One rework signal: its [median] over the [n] sessions that reported it. */
data class ModelQualityRework(
    val median: Double,
    val n: Int = 0,
)

/** Graded shadow pairs (XERK-1847), and how many the candidate lost to Opus. */
data class ModelQualityShadow(
    val pairs: Int = 0,
    val candidateOnlyBad: Int = 0,
)

/** One ticket session of the named org. */
data class ModelQualityRow(
    val issue: String = "",
    val host: String = "",
    val repo: String? = null,
    val cls: String = "",
    val model: String = "",
    val outcome: String = "",
    val reason: String? = null,
    val updatedAt: Double? = null,
    val prs: List<ModelQualityPr> = emptyList(),
)

data class ModelQualityPr(
    val url: String = "",
    val state: String? = null,
)

// ---- the lenient reader -------------------------------------------------------

private fun JsonElement?.obj() = this as? JsonObject
private fun JsonElement?.list() = (this as? JsonArray).orEmpty()
private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.num(): Double? =
    (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }
/** A non-negative count, clamped to Int; anything else reads 0. */
private fun JsonElement?.count(): Int = num()?.takeIf { it >= 0 }?.coerceAtMost(Int.MAX_VALUE.toDouble())?.toInt() ?: 0

/** The route's answer, every field read leniently (web `modelQualityCardHtml`'s guards). */
fun parseModelQuality(e: JsonElement?): ModelQualityView {
    val o = e.obj() ?: return ModelQualityView()
    return ModelQualityView(
        windowDays = o["windowDays"].count(),
        groups = o["groups"].list().mapNotNull { it.obj()?.let(::parseGroup) },
        rows = o["rows"].list().mapNotNull { it.obj()?.let(::parseRow) },
    )
}

private fun parseGroup(g: JsonObject) = ModelQualityGroup(
    cls = g["cls"].str().orEmpty(),
    model = g["model"].str().orEmpty(),
    sessions = g["sessions"].count(),
    good = g["good"].count(),
    bad = g["bad"].count(),
    pending = g["pending"].count(),
    noChange = g["no-change"].count(),
    undelivered = g["undelivered"].count(),
    reasons = g["reasons"].obj()?.mapValues { it.value.count() }.orEmpty(),
    // A signal with no usable median is left out, never read as 0 (web `mqSignal`).
    rework = g["rework"].obj()?.mapNotNull { (k, v) ->
        v.obj()?.let { o -> o["median"].num()?.let { k to ModelQualityRework(it, o["n"].count()) } }
    }?.toMap().orEmpty(),
    shadow = g["shadow"].obj()?.let { ModelQualityShadow(it["pairs"].count(), it["candidateOnlyBad"].count()) },
    promotion = g["promotion"].str(),
)

private fun parseRow(r: JsonObject) = ModelQualityRow(
    issue = r["issue"].str().orEmpty(),
    host = r["host"].str().orEmpty(),
    repo = r["repo"].str(),
    cls = r["cls"].str().orEmpty(),
    model = r["model"].str().orEmpty(),
    outcome = r["outcome"].str().orEmpty(),
    reason = r["reason"].str(),
    updatedAt = r["updatedAt"].num(),
    prs = r["prs"].list().mapNotNull { p ->
        p.obj()?.let { ModelQualityPr(it["url"].str().orEmpty(), it["state"].str()) }
    },
)
