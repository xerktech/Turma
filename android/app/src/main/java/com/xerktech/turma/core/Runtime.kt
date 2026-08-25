package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.DshInfo

/**
 * Which runtime a session runs on, and how the spawn composer offers the choice
 * — the port of web `sessions.html`'s dsh selector gate (XERK-460). The runtime
 * is presentational per-session state; this object owns only the two pure rules
 * the composer needs, mirroring [ModelSource]'s `composerOffers`/`spawnValue`.
 */
object Runtime {

    const val CLAUDE = "claude"
    const val DSH = "dsh"

    /**
     * Should the spawn composer offer a "Runtime" row at all? Gated on the
     * HOST's dsh capability flag exactly as [ModelSource.composerOffers] is on
     * `localModel.available` — a host that cannot launch dsh renders no choice,
     * so nobody can pick a runtime the host would only ack and drop (the hub
     * 409s it too).
     */
    fun composerOffers(dsh: DshInfo?): Boolean = dsh?.available == true

    /**
     * The `agentType` a spawn should carry, or null to omit it. Only "dsh" is
     * ever sent: "claude" is what a spawn already meant, so omitting it keeps a
     * bare spawn byte-identical to what it was before dsh existed.
     */
    fun spawnValue(agentType: String?): String? = agentType?.takeIf { it == DSH }

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
        agents.firstOrNull { it.key == host }?.dsh

    /**
     * Is a session on a non-default (dsh) runtime, i.e. does its card carry a
     * runtime badge? A claude session (the default, and every session predating
     * the field, which reports "") gets none, so the common card is unchanged.
     */
    fun isDsh(agentType: String?): Boolean = agentType == DSH
}
