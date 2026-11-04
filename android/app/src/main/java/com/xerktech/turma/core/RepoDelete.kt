package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.RepoDeleteInfo
import com.xerktech.turma.model.RepoInfo

/**
 * Per-repo Delete (XERK-2675), a port of web index.html repoBlock's delete rules
 * (XERK-2672). Pure so the gating is pinned by tests, not by driving the app.
 */
object RepoDelete {
    /** What the confirm dialog must say before anything is destroyed. */
    const val CONFIRM_MESSAGE =
        "Deletes this repo and its session worktrees from the host. Uncommitted changes and " +
            "unpushed commits or branches in the repo and its worktrees are lost. " +
            "Session transcripts are kept."

    /**
     * Offer Delete only on an online host, never for the repos root, and only when
     * the agent reports `repoDeletes` — an older agent acks the command and never
     * acts on it (the hub 409s it), so the button would be a lie there.
     */
    fun canDelete(agent: AgentInfo, repo: RepoInfo): Boolean =
        agent.online && !repo.root && agent.repoDeletes != null

    /** The agent's latest delete record for [repo], or null. */
    fun record(agent: AgentInfo, repo: String): RepoDeleteInfo? =
        agent.repoDeletes?.firstOrNull { it.repo == repo }

    /** True while the agent is still working on it — the button stays busy. */
    fun live(r: RepoDeleteInfo?): Boolean = r != null && (r.status == "syncing" || r.status == "deleting")

    /** Busy from the tap ([pending]) until the agent's record says it's done. */
    fun busy(r: RepoDeleteInfo?, pending: Boolean): Boolean = pending || live(r)

    /** Prune needs a live host to carry the command (web repoBlock canPrune). */
    fun canPrune(online: Boolean, repo: RepoInfo): Boolean = online && !repo.root

    /** The note under the repo row: the error on error, else the summary. */
    fun note(r: RepoDeleteInfo?): String? = when {
        r == null -> null
        r.status == "error" -> r.error?.ifBlank { null } ?: "delete failed"
        else -> r.summary.ifBlank { null } ?: if (r.status == "done") "deleted" else null
    }
}
