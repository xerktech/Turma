package com.xerktech.turma.model

import kotlinx.serialization.Serializable

/**
 * `GET /api/permissions` (XERK-1563): the permission prompts that held a
 * session over the last [days], grouped with the allow rule that would retire
 * each ([top]), plus the newest rows ([recent]). Web twin: usage.html's
 * "Permission prompts" card (`permissionsCardHtml`).
 *
 * Decoded on ITS OWN call, never inside the atomic `/api/agents` decode, so a
 * wrong-typed field here costs the Usage screen this one section and nothing
 * else. Every field is optional with a default, and `kind` is a plain string
 * rather than an enum, so an older hub (fewer fields) or a newer one (a kind
 * this build has never seen) still decodes. Times and waits are `Double`: the
 * hub floors them today, but a fractional one must not throw the decode.
 */
@Serializable
data class PermissionSummary(
    val days: Int = 0,
    val top: List<PermissionGroup> = emptyList(),
    val recent: List<PermissionRow> = emptyList(),
)

/** One group of the top table: prompts that asked about the same thing. */
@Serializable
data class PermissionGroup(
    /** `dialog` / `classifier-denied` / `ask-in-chat` / `judged`, or a kind this build doesn't know. */
    val kind: String = "",
    val dialogKind: String? = null,
    val tool: String? = null,
    val head: String? = null,
    /** An ask-in-chat group's newest question (it has no tool or head). */
    val prompt: String? = null,
    val count: Int = 0,
    /** Null for an ask (answered in prose, never allow/deny) — "can't tell", not 0. */
    val allowed: Int? = null,
    val denied: Int? = null,
    /** Rows still holding their session; absent on an older hub. */
    val open: Int? = null,
    val medianWaitMs: Double? = null,
    val lastAt: Double? = null,
    val suggestedRule: String? = null,
    /** Why a Bash head gets no rule ("review it"). */
    val noRuleReason: String? = null,
    /** Why the auto-mode classifier blocked it. */
    val denyReason: String? = null,
)

/** One of the newest prompt rows, with the host it held. */
@Serializable
data class PermissionRow(
    val host: String = "",
    val id: String = "",
    val sessionId: String = "",
    val kind: String = "",
    val dialogKind: String? = null,
    val tool: String? = null,
    val head: String? = null,
    val prompt: String? = null,
    val denyReason: String? = null,
    val answer: String? = null,
    val via: String? = null,
    val waitedMs: Double? = null,
    val openedAt: Double? = null,
    val closedAt: Double? = null,
    /** A `judged` row's verdict (XERK-1566): `allow` or `stand`; absent on any other row. */
    val verdict: String? = null,
    /** Why the permission judge decided as it did; absent when it gave no reason. */
    val judgeReason: String? = null,
)
