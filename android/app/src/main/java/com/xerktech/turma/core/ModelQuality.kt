package com.xerktech.turma.core

import com.xerktech.turma.model.ModelQualityGroup
import com.xerktech.turma.model.ModelQualityPr
import kotlin.math.roundToInt

/**
 * The Usage screen's "Model quality" card (XERK-1849), ported from usage.html's
 * `mq*` helpers. The web page is the source of truth; keep wording and order in
 * step with it.
 */
object ModelQuality {
    /** How often an open card re-reads its route (web `MQ_REFRESH_MS`). */
    const val REFRESH_MS = 60_000L

    /** The defect window when the hub does not say (the ledger's default). */
    const val DEFAULT_WINDOW_DAYS = 90

    fun note(days: Int) = "How ticket sessions turned out, per work class (the ticket's type) and model, " +
        "pooled across every org. Good = merged with no reopen for $days days; bad = reopened after Done " +
        "or every PR closed unmerged. Bad rate is bad ÷ (good + bad); the Opus column is that rate for Opus " +
        "on the same class — the bar a cheaper model has to meet."

    const val PICK_ORG = "Pick one org in the header to list its sessions."

    /** Outcome → label (web `MQ_OUTCOME_LABEL`); an unknown outcome reads pending. */
    val OUTCOME_LABELS = mapOf(
        "good" to "good", "bad" to "bad", "pending" to "pending",
        "no-change" to "no change", "undelivered" to "undelivered",
    )

    fun outcomeOf(o: String) = if (o in OUTCOME_LABELS) o else "pending"

    /** Bad share of the DECIDED sessions (good + bad); null while none is decided (web `mqBadRate`). */
    fun badRate(g: ModelQualityGroup): Double? {
        val decided = g.good + g.bad
        return if (decided > 0) g.bad.toDouble() / decided else null
    }

    fun pct(r: Double?): String = if (r == null) "—" else "${(r * 100).roundToInt()}%"

    /** Opus's bad rate per class (web `mqBaselines`). */
    fun baselines(groups: List<ModelQualityGroup>): Map<String, Double?> =
        groups.filter { it.model == "opus" }.associate { it.cls to badRate(it) }

    /** The Opus cell for [g]: null for Opus itself or a class with no decided Opus session. */
    fun opusRate(g: ModelQualityGroup, base: Map<String, Double?>): Double? =
        if (g.model == "opus") null else base[g.cls]

    /** A served median, one decimal, or "—" (web `mqMedian`). */
    fun median(v: Double?): String {
        if (v == null || !v.isFinite() || v < 0) return "—"
        // A large one is whole (Int rounding would saturate it; web `mqMedian` likewise).
        if (v >= 1e6) return String.format(java.util.Locale.ROOT, "%.0f", v)
        val r = (v * 10).roundToInt() / 10.0
        return if (r == Math.floor(r)) r.toLong().toString() else r.toString()
    }

    /** "23 · 1 worse", or "—" with no graded pair (web `mqShadow`). */
    fun shadow(g: ModelQualityGroup): String {
        val s = g.shadow ?: return "—"
        if (s.pairs <= 0) return "—"
        return "${s.pairs}" + if (s.candidateOnlyBad > 0) " · ${s.candidateOnlyBad} worse" else ""
    }

    /** Promotion status; Opus is the baseline every class starts on (web `mqStatus`). */
    fun status(g: ModelQualityGroup): String = when {
        !g.promotion.isNullOrEmpty() -> g.promotion
        g.model == "opus" -> "baseline"
        else -> "—"
    }

    /** "3 no change · 1 undelivered", or "" (the web's sub-line under class · model). */
    fun other(g: ModelQualityGroup): String = listOfNotNull(
        g.noChange.takeIf { it > 0 }?.let { "$it no change" },
        g.undelivered.takeIf { it > 0 }?.let { "$it undelivered" },
    ).joinToString(" · ")

    /** Rework signals in display order, with their labels (web `MQ_REWORK`). */
    val REWORK = listOf(
        "qaRuns" to "QA runs", "qaFail" to "QA failed", "ciRounds" to "CI rounds",
        "changesRequested" to "Changes requested",
    )

    /** The rework stats [g] carries, label → median, in [REWORK] order (the web phone layout). */
    fun reworkStats(g: ModelQualityGroup): List<Pair<String, String>> =
        REWORK.mapNotNull { (k, label) -> g.rework[k]?.let { label to median(it.median) } }

    /** Whether any group carries shadow figures (web `mqColumns`). */
    fun hasShadow(groups: List<ModelQualityGroup>) = groups.any { it.shadow != null }

    /** Classes by total sessions, Opus first inside each, then by sessions (web `mqOrdered`). */
    fun ordered(groups: List<ModelQualityGroup>): List<ModelQualityGroup> {
        val totals = groups.groupBy { it.cls }.mapValues { (_, l) -> l.sumOf { it.sessions } }
        return groups.sortedWith(
            compareByDescending<ModelQualityGroup> { totals[it.cls] ?: 0 }
                .thenBy { it.cls }
                .thenByDescending { it.model == "opus" }
                .thenByDescending { it.sessions }
                .thenBy { it.model },
        )
    }

    private val PR_NUM = Regex("/(\\d+)/?$")
    private val HTTP = Regex("^https?://", RegexOption.IGNORE_CASE)

    /** A PR as its link text ("#412", else "PR") plus lower-cased state (web `mqPrLinks`). */
    fun prLabel(p: ModelQualityPr): Pair<String, String>? {
        if (!HTTP.containsMatchIn(p.url)) return null
        val n = PR_NUM.find(p.url)?.groupValues?.get(1)
        return (if (n != null) "#$n" else "PR") to (p.state?.lowercase().orEmpty())
    }
}
