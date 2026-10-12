package com.xerktech.turma.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `GET /api/model-quality` (XERK-1839): per (work class, model) how ticket
 * sessions turned out, FLEET-WIDE, plus — only when one org is named with
 * `rows=1` — that org's newest per-session [rows]. Web twin: usage.html's
 * "Model quality" card (`modelQualityCardHtml`, XERK-1849).
 *
 * Decoded on ITS OWN call, never inside the atomic `/api/agents` decode. Every
 * field is optional with a default and every count/time is lenient (`Double`
 * for times), so an older or newer hub still decodes. [rework], [shadow] and
 * [promotion] are served once XERK-1845/1847/1848 ship; absent until then.
 */
@Serializable
data class ModelQualityView(
    val windowDays: Int = 0,
    val groups: List<ModelQualityGroup> = emptyList(),
    val rows: List<ModelQualityRow> = emptyList(),
)

@Serializable
data class ModelQualityGroup(
    val cls: String = "",
    val model: String = "",
    val sessions: Int = 0,
    val good: Int = 0,
    val bad: Int = 0,
    val pending: Int = 0,
    @SerialName("no-change") val noChange: Int = 0,
    val undelivered: Int = 0,
    /** Why the bad sessions were bad: reason → count. */
    val reasons: Map<String, Int> = emptyMap(),
    val rework: ModelQualityRework? = null,
    val shadow: ModelQualityShadow? = null,
    val promotion: String? = null,
)

/** Rework medians per session (XERK-1845). */
@Serializable
data class ModelQualityRework(
    val qaPasses: Double? = null,
    val ciRounds: Double? = null,
)

/** Graded shadow pairs (XERK-1847), and how many the candidate lost to Opus. */
@Serializable
data class ModelQualityShadow(
    val pairs: Int = 0,
    val candidateOnlyBad: Int = 0,
)

/** One ticket session of the named org. */
@Serializable
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

@Serializable
data class ModelQualityPr(
    val url: String = "",
    val state: String? = null,
)
