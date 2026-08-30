package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.DshInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.LocalModelOption
import com.xerktech.turma.model.QwenInfo
import com.xerktech.turma.model.SessionInfo

/**
 * Which runtime a session runs on, and how the spawn composer offers the choice
 * — the port of web `sessions.html`'s dsh selector gate (XERK-460). The runtime
 * is presentational per-session state; this object owns only the two pure rules
 * the composer needs, mirroring [ModelSource]'s `composerOffers`/`spawnValue`.
 */
object Runtime {

    /**
     * Fleet-wide kill switch for ALL dsh (DeepSeek Harness, XERK-460) functionality.
     * When false, every dsh surface is hidden/refused — the composer's dsh row, the
     * board's dsh runtime pin, the dsh model dropdowns and the presentational dsh
     * card marker — WITHOUT removing any of the machinery, so flipping it back to
     * true restores dsh with no code change. This is an in-CODE flag (not env, not a
     * build flavour); the agent (Python) and hub carry the same-named flag, so the
     * fleet turns dsh off in one place per component. It is a `var` ONLY so tests can
     * flip it to exercise the retained dsh behavior; production ships it false.
     */
    var DSH_ENABLED: Boolean = false

    /**
     * Fleet-wide kill switch for ALL qwen (Qwen Code, XERK-504) functionality —
     * the qwen twin of [DSH_ENABLED]. When false the composer's qwen runtime row
     * is hidden and a spawn cannot select it, WITHOUT removing the plumbing, so
     * flipping it true (once [Qwen B]'s launcher lands and is verified) restores
     * qwen with no code change. In-CODE flag; the agent (Python) and hub carry
     * the same-named flag. `var` only so tests can flip it. Shipped true once the
     * XERK-520 end-to-end gate verified qwen on real Qwen Code.
     */
    var QWEN_ENABLED: Boolean = true

    const val CLAUDE = "claude"
    const val DSH = "dsh"
    const val QWEN = "qwen"

    // The spawn composer collapses the old Runtime (claude/dsh) + "Run against"
    // (subscription/local) pair into ONE Runtime picker (XERK-503), matching web
    // `sessions.html`. Its three values map onto the existing agentType/modelSource
    // wire fields (spawnAgentType/spawnModelSource), so the backend contract for
    // the claude/local split is unchanged. LOCAL is a UI-only runtime value here,
    // distinct from an `agentType` (which is only ever "claude"/"dsh").
    const val LOCAL = "local"

    /**
     * The composer's Runtime rows: "Claude Code" always, "Claude Code Local" when
     * the host reports a local endpoint, "dsh" when it offers dsh. The caller
     * shows the picker only when there is more than one row (a plain subscription
     * host has one runtime, so nothing to choose).
     */
    fun composerRuntimes(
        local: LocalModelInfo?,
        dsh: DshInfo?,
        qwen: QwenInfo? = null,
    ): List<Pair<String, String>> =
        buildList {
            add(CLAUDE to "Claude Code")
            if (local?.available == true) add(LOCAL to "Claude Code Local")
            if (DSH_ENABLED && dsh?.available == true) add(DSH to "dsh")
            if (QWEN_ENABLED && qwen?.available == true) add(QWEN to "Qwen Code")
        }

    /** The `agentType` a chosen composer runtime spawns as, or null to omit it
     *  (only "dsh"/"qwen" are ever sent; "claude"/"local" are Claude sessions). */
    fun spawnAgentType(runtime: String): String? = when (runtime) {
        DSH -> DSH
        QWEN -> QWEN
        else -> null
    }

    /** The `modelSource` a chosen composer runtime spawns as, or null to omit it
     *  (only "local" is sent; a bare/dsh spawn carries no source). */
    fun spawnModelSource(runtime: String): String? = if (runtime == LOCAL) LOCAL else null

    /**
     * Should the spawn composer offer a "Runtime" row at all? Gated on the
     * HOST's dsh capability flag exactly as [ModelSource.composerOffers] is on
     * `localModel.available` — a host that cannot launch dsh renders no choice,
     * so nobody can pick a runtime the host would only ack and drop (the hub
     * 409s it too).
     */
    fun composerOffers(dsh: DshInfo?): Boolean = DSH_ENABLED && dsh?.available == true

    /**
     * The `agentType` a spawn should carry, or null to omit it. Only a
     * non-default runtime ("dsh"/"qwen") is sent: "claude" is what a spawn
     * already meant, so omitting it keeps a bare spawn byte-identical to what it
     * was before these runtimes existed.
     */
    fun spawnValue(agentType: String?): String? = agentType?.takeIf { it == DSH || it == QWEN }

    /** Menu rows as (value, label) pairs, in the web menu's order. */
    fun options(): List<Pair<String, String>> =
        listOf(CLAUDE to "Claude Code", DSH to "dsh")

    /**
     * The dsh capability of the host a spawn is TARGETING — never the fleet's
     * first, the same "wrong loop" hazard [ModelSource.hostLocalModel] guards
     * against. dsh is offered per host, so gating off another host's block would
     * queue a `dsh` spawn the target 409s.
     */
    fun hostDsh(agents: List<AgentInfo>, host: String): DshInfo? =
        if (!DSH_ENABLED) null else agents.firstOrNull { it.key == host }?.dsh

    /**
     * The qwen (Qwen Code, XERK-504) capability of the host a spawn is TARGETING
     * — the qwen twin of [hostDsh], never the fleet's first (the same "wrong
     * loop" hazard), since qwen is offered per host.
     */
    fun hostQwen(agents: List<AgentInfo>, host: String): QwenInfo? =
        if (!QWEN_ENABLED) null else agents.firstOrNull { it.key == host }?.qwen

    /**
     * Is a session on a non-default (dsh) runtime, i.e. does its card carry a
     * runtime badge? A claude session (the default, and every session predating
     * the field, which reports "") gets none, so the common card is unchanged.
     */
    fun isDsh(agentType: String?): Boolean = DSH_ENABLED && agentType == DSH

    /**
     * Is a session on the qwen runtime — the qwen twin of [isDsh], so the
     * chat footer renders a fixed "⚙ Qwen Code" chip instead of the
     * Claude alias picker.
     */
    fun isQwen(agentType: String?): Boolean = QWEN_ENABLED && agentType == QWEN

    // ---- dsh model list (XERK-503/504) --------------------------------------
    // A dsh session offers the endpoint's DISCOVERED models (DshInfo.models), not
    // Claude aliases — the same shape [ModelSource]'s local helpers use, so the
    // spawn composer and the chat footer render a dsh model dropdown the same way
    // they render the local one.

    /** The discovered dsh models, or empty for an older agent / pre-discovery. */
    fun dshModels(dsh: DshInfo?): List<LocalModelOption> = dsh?.models ?: emptyList()

    /** Is there a discovered dsh list to pick from? Empty keeps a fixed label. */
    fun dshModelPickable(dsh: DshInfo?): Boolean = dshModels(dsh).isNotEmpty()

    /** The dsh model this session runs: its stored pick, else the host default. */
    fun currentDshModel(session: SessionInfo?, dsh: DshInfo?): String =
        session?.model?.takeIf { it.isNotBlank() }
            ?: dsh?.defaultModel?.takeIf { it.isNotBlank() }
            ?: ""

    /** "128k"-style short window, matching [ModelSource.fmtCtx]. */
    private fun fmtCtx(n: Int?): String = ModelSource.fmtCtx(n)

    /** Menu rows for the dsh dropdown as (id, "id · 128k") pairs. */
    fun dshOptions(dsh: DshInfo?): List<Pair<String, String>> =
        dshModels(dsh).map { m ->
            val k = fmtCtx(m.contextTokens)
            m.id to (m.id + if (k.isNotEmpty()) " · $k" else "")
        }

    /** The chip label for a dsh session: its model + window (dsh has no
     *  per-session context override, so the window is the model's served one). */
    fun dshModelLabel(session: SessionInfo?, dsh: DshInfo?): String {
        val id = currentDshModel(session, dsh).ifBlank { "dsh model" }
        val ctx = dshModels(dsh).firstOrNull { it.id == id }?.contextTokens ?: dsh?.contextTokens
        val k = fmtCtx(ctx)
        return if (k.isNotEmpty()) "$id · $k" else id
    }

    /** The chip label for a qwen session (XERK-506): the model the host
     *  configured (QWEN_MODEL) or the hub carried on the session — qwen has
     *  NO discovered model list, so the footer chip is always fixed. */
    fun qwenModelLabel(session: SessionInfo?): String =
        session?.model?.trim()?.ifBlank { null } ?: "qwen model"

    /** The dsh runtime capability of the host a chat session runs on. */
    fun hostDshFor(agents: List<AgentInfo>, host: String): DshInfo? =
        if (!DSH_ENABLED) null else agents.firstOrNull { it.key == host }?.dsh
}
