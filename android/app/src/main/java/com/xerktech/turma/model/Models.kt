package com.xerktech.turma.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Wire shapes mirrored from the Turma hub (turma/server.js `serializeAgent`,
 * the heartbeat session record, and the transcript `blocks[]`). Ported from
 * glasses/src/types.ts. Every field has a default and the shared [TurmaJson]
 * decoder ignores unknown keys, so an older/newer hub never breaks decoding.
 */

@Serializable
data class AgentsResponse(
    val now: Long = 0,
    val agents: List<AgentInfo> = emptyList(),
    // Ticket -> pinned host (XERK-38), keyed "<siteKey>/<issueKey>": which
    // agent a ticket's sessions spawn on, when the operator overrode the hub's
    // most-available routing. Hub-owned and durable; absent on older hubs.
    val ticketAgents: Map<String, TicketAgentPin> = emptyMap(),
    // Per-org auto-start opt-in (XERK-41), keyed by siteKey, value always true
    // (presence = enabled). The hub-owned switch on each board org chip; hub-only
    // (no agent flag). Absent on older hubs.
    val autoStartOrgs: Map<String, Boolean> = emptyMap(),
)

/** One ticket->agent pin (the web board's Agent row; hub ticket-agents store). */
@Serializable
data class TicketAgentPin(val host: String = "", val at: Long = 0)

@Serializable
data class CodingAgent(val name: String = "", val version: String = "")

@Serializable
data class AgentInfo(
    val key: String = "",
    val device: String = "",
    // The coding agent this host runs + this Turma agent build's version, both
    // shown in the host header (web index.html codingAgent()/agentVersion).
    val claudeVersion: String = "",
    val agentVersion: String = "",
    val codingAgent: CodingAgent? = null,
    val lastSeen: Long = 0,
    // ISO-8601 string on the wire (agent's now_iso()), NOT epoch — the hub, web
    // client, and glasses all treat it as a string. Typing it Long made
    // kotlinx.serialization throw on the whole /api/agents payload.
    val startedAt: String = "",
    val online: Boolean = false,
    val terminalOnline: Boolean = false,
    // Set (non-null) during an ANNOUNCED update restart (XERK-29): the host is
    // briefly silent on purpose, so this reads as "updating", not an outage.
    val updating: UpdatingInfo? = null,
    val repos: List<RepoInfo> = emptyList(),
    val sessions: List<SessionInfo> = emptyList(),
    val usage: UsageInfo? = null,
    val repoUsage: List<RepoUsage> = emptyList(),
    val github: GithubInfo? = null,
    val clones: List<CloneInfo> = emptyList(),
    val commands: List<CommandInfo> = emptyList(),
    val jira: JiraBlock? = null,
    // Killed-but-resumable sessions (hub-agent _closed_payload) — the web's
    // "Ended sessions" list.
    val closedSessions: List<ClosedSessionInfo> = emptyList(),
    // This host's session ceiling and what is against it (hub-agent
    // _capacity_payload). `maxSessions` is a PER-AGENT cap, summed across an org's
    // hosts for the dashboard's session-count tile (XERK-72). Null on a
    // pre-capacity agent.
    val capacity: Capacity? = null,
)

/** A host's session ceiling and live counts (hub-agent `_capacity_payload`). */
@Serializable
data class Capacity(
    val maxSessions: Int = 0,
    val running: Int = 0,
    val queued: Int = 0,
    val free: Int = 0,
    val rootRunning: Boolean = false,
)

/** An announced in-progress update restart (XERK-29); present only during the grace window. */
@Serializable
data class UpdatingInfo(
    val version: String = "",
    val until: Long = 0,
)

@Serializable
data class ClosedSessionInfo(
    val id: String = "",
    val repo: String = "",
    val branch: String = "",
    val root: Boolean = false,
    val summary: String = "",
    // Whether [summary] is an operator's own rename rather than a generated
    // name — it decides the board chip's label precedence (a human's name wins
    // over the branch), and must not change just because the session was killed.
    val summaryManual: Boolean = false,
    val label: String = "",
    val createdAt: String = "",
    val closedAt: String = "",
    // The Jira ticket this session worked, snapshotted onto the closed record
    // (hub-agent _closed_payload → {key, siteKey, url, summary, branch}); null
    // when the session had no ticket. Was mistyped as a plain String, so decoding
    // the WHOLE /api/agents payload threw for any host with a killed ticket-backed
    // session — hiding every such host from the fleet (only the per-host SSE push,
    // which decodes hosts one at a time, kept the ticket-free ones visible).
    val ticket: TicketRef? = null,
    // The conversation this session had, so the Ended-sessions view can open it
    // read-only from the hub's archive (GET /api/archive/<transcriptId>). Blank on
    // records written by an agent predating the snapshot (_closed_payload); the
    // card then falls back to Resume-only (no click-to-review).
    val transcriptId: String = "",
    // PR-status objects this session opened, same shape/type as SessionInfo.prs —
    // rendered as chips on the ended card and the read-only review's stage bar.
    val prs: List<PrInfo> = emptyList(),
)

/** A session's Jira ticket link (SessionInfo/ClosedSessionInfo `ticket`). */
@Serializable
data class TicketRef(
    val key: String = "",
    val siteKey: String = "",
    val url: String = "",
    val summary: String = "",
    val branch: String? = null,
)

// ---- Jira board (the agent's `jira` heartbeat block; see hub-agent collect_jira) --

@Serializable
data class JiraBlock(
    val available: Boolean = false,
    val configured: Boolean = false,
    val site: String = "",
    val siteKey: String = "",
    val user: String = "",
    val fetchedAt: String = "",
    val error: String? = null,
    val truncated: Boolean = false,
    // The operator's org-label override (agent BOARD_ORG_NAME); "" falls back to
    // the siteKey-derived name. Presentational only — see core.orgName.
    val orgName: String = "",
    val tickets: List<JiraTicket> = emptyList(),
    // The repos the board's manual "Change" picker offers — exactly what the
    // agent's set_jira_repo allowlists, so the two can't drift (hub-agent
    // _triage_candidates → jira.repoOptions).
    val repoOptions: List<RepoOption> = emptyList(),
)

@Serializable
data class RepoOption(
    val name: String = "",
    val cloned: Boolean = false,
    val nameWithOwner: String? = null,
    val description: String = "",
)

@Serializable
data class JiraTicket(
    val key: String = "",
    val url: String = "",
    val summary: String = "",
    val status: String = "",
    val statusCategory: String = "", // todo | inprogress | done
    val priority: String = "",
    val type: String = "",
    val project: String = "",
    val projectName: String = "",
    val labels: List<String> = emptyList(),
    val updated: String = "",
    val created: String = "",
    val dueDate: String? = null,
    val parentKey: String? = null,
    val repoGuess: RepoGuess? = null,
)

@Serializable
data class RepoGuess(
    val repo: String? = null,
    val cloned: Boolean = false,
    val nameWithOwner: String? = null,
    val reason: String = "",
    val at: String = "",
    // The operator pinned this repo by hand (vs. the model's guess). A manual pin
    // has no `reason` and preselects in the picker; see board.js repoFieldHtml.
    val manual: Boolean = false,
)

/** On-demand issue detail (GET /api/jira/<siteKey>/<key>); kept lenient. */
@Serializable
data class JiraIssueDetail(
    val key: String = "",
    val summary: String = "",
    val status: String = "",
    val statusCategory: String = "",
    val priority: String = "",
    val type: String = "",
    val description: String = "",
    val assignee: String = "",
    val reporter: String = "",
    val labels: List<String> = emptyList(),
    val comments: List<JiraComment> = emptyList(),
    val commentTotal: Int = 0,
    val parentKey: String? = null,
    val url: String = "",
    val error: String? = null,
    val stale: Boolean = false,
)

/**
 * The GET /api/jira/<siteKey>/<key> response envelope: the hub wraps the issue
 * under `issue` (plus `fetchedAt`/`stale`), or returns `{error}`, or 202
 * `{pending}` while the owning host fetches it on demand. Decoding the top-level
 * body straight into [JiraIssueDetail] silently loses every field (the issue is
 * nested), so the envelope is unwrapped explicitly — see BoardViewModel.fetchIssue.
 */
@Serializable
data class JiraIssueEnvelope(
    val issue: JiraIssueDetail? = null,
    val error: String? = null,
    val stale: Boolean = false,
    val pending: Boolean = false,
)

@Serializable
data class JiraComment(
    val author: String = "",
    val body: String = "",
    val created: String = "",
)

@Serializable
data class RepoInfo(
    val name: String = "",
    val root: Boolean = false,
    // ISO-8601 string (agent ranks repos by comparing these as strings), not epoch.
    val lastActivity: String = "",
    val resumable: List<ResumableInfo> = emptyList(),
)

/**
 * One transcript from the agent's per-repo resumable scan (`_resumable_report`),
 * the DURABLE ended-sessions channel: re-derived every slow beat from the
 * transcripts on disk, so it outlives the registry, closed.json's cap, and an
 * agent wipe. Wire shape: {transcriptId, cwd, repo, root, origin, slug, summary,
 * endedTs, ticket, prs}. (It previously declared `ts`/`source` fields that are
 * not on the wire and decoded nothing.)
 */
@Serializable
data class ResumableInfo(
    val transcriptId: String = "",
    val cwd: String = "",
    val repo: String = "",
    val root: Boolean = false,
    val summary: String = "",
    // The last message's own transcript timestamp (ISO-8601) — the ended list's
    // sort key (XERK-73); falls back agent-side to file mtime.
    val endedTs: String = "",
    // The Jira ticket this conversation worked, from the agent's durable
    // transcript→ticket ledger; null for an ordinary session.
    val ticket: TicketRef? = null,
    // The PRs this conversation opened, from the agent's durable PR ledger —
    // the only channel still carrying them once the closed record aged out.
    val prs: List<PrInfo> = emptyList(),
)

@Serializable
data class GithubInfo(
    val ok: Boolean = false,
    val login: String = "",
    // Wire sends objects ({nameWithOwner, name, isPrivate, ...}), not bare
    // strings — the agent's collect_github()/_gh_clonable_repos().
    val repos: List<GithubRepo> = emptyList(),
)

@Serializable
data class GithubRepo(
    val nameWithOwner: String = "",
    val name: String = "",
    val description: String = "",
    val isPrivate: Boolean = false,
    val updatedAt: String = "",
)

@Serializable
data class CloneInfo(
    val repo: String = "",
    val status: String = "",
)

@Serializable
data class CommandInfo(
    val type: String = "",
    val cmdId: String = "",
    val sessionId: String = "",
    val repo: String = "",
)

@Serializable
data class SessionInfo(
    val id: String = "",
    val status: String = "",
    val repo: String = "",
    val worktreePath: String = "",
    val branch: String = "",
    val git: GitState? = null,
    val summary: String = "",
    val label: String = "",
    val root: Boolean = false,
    val rcName: String = "",
    val ttydPort: Int = 0,
    val model: String = "",
    val permissionMode: String = "",
    val usage: UsageInfo? = null,
    val prs: List<PrInfo> = emptyList(),
    val session: LiveSignals? = null,
    // The Jira ticket this session was spawned to work (hub-agent
    // _session_payload `ticket`); the board reverse-indexes it into per-ticket
    // session chips. Null for an ordinary session.
    val ticket: TicketRef? = null,
    // The hub command that created this session (spawn / spawnTicket /
    // resumeTranscript) — what the board's start sweep matches its optimistic
    // pending against. "" for sessions predating the echo.
    val spawnCmdId: String = "",
    // The conversation this session is having — the id the Ended list dedupes
    // on and the ended read-only view opens by. "" from an older agent.
    val transcriptId: String = "",
    val createdAt: String = "",
    val stoppedAt: String = "",
    val errorMsg: String = "",
    // Why a `queued` session is waiting (capacity / awaiting-clone / root-busy)
    // and since when; "" for any session that isn't queued.
    val queuedReason: String = "",
    val queuedAt: String = "",
    // Bumps on a "Restart (clear context)" — the completion signal the
    // dashboard's optimistic restart pending clears on.
    val restartCount: Int = 0,
    // The live branch's relation to its base/origin — the work-risk line.
    val work: WorkInfo? = null,
)

@Serializable
data class GitState(
    val repoName: String = "",
    val branch: String = "",
    // Uncommitted-change count from `git status --porcelain` in the worktree.
    val dirtyFiles: Int = 0,
)

/**
 * "Is this work safe yet?" facts for a session's branch (hub-agent
 * branch_sync_info): commits past the base branch, whether the branch was ever
 * pushed, and commits not yet on origin. Every field degrades to null (branch
 * not born yet, no origin, unfetchable counts) rather than lying with a zero.
 */
@Serializable
data class WorkInfo(
    val baseRef: String? = null,
    val aheadOfBase: Int? = null,
    val pushed: Boolean? = null,
    val aheadOfRemote: Int? = null,
)

/** The live TUI probe on a running session (`session.session`); null when stopped. */
@Serializable
data class LiveSignals(
    val paneBusy: Boolean? = null,
    val transcriptAgeSec: Double? = null,
    val lastRole: String = "",
    val lastHasToolUse: Boolean = false,
    val bridgeAttached: Boolean = false,
    val question: String = "",
    val questionOptions: List<String> = emptyList(),
    // Rich AskUserQuestion picker (hub-agent session_report): option cards with
    // descriptions/previews, a header chip, n-of-N progress, and multiSelect.
    val questionOptionsRich: List<QuestionOption> = emptyList(),
    val questionHeader: String = "",
    val questionIndex: Int? = null,
    val questionTotal: Int? = null,
    val questionMulti: Boolean = false,
    val newPrUrls: List<String> = emptyList(),
    val tail: List<TailEntry> = emptyList(),
)

@Serializable
data class QuestionOption(
    val label: String = "",
    val description: String = "",
    val preview: String = "",
)

@Serializable
data class PrInfo(
    val url: String = "",
    val number: Int = 0,
    val state: String = "",
    val title: String = "",
    /** The CI rollup alone: passing / failing / pending / "". */
    val checks: String = "",
    /** GitHub's own mergeability: MERGEABLE / CONFLICTING / UNKNOWN / "". */
    val mergeable: String = "",
    /**
     * Merge readiness — CI *and* mergeability together (_merge_ready in
     * hub-agent.py): ready / blocked / pending / "". Empty from an agent
     * predating the field, which reports [checks] alone.
     */
    val ready: String = "",
)

@Serializable
data class UsageInfo(
    val today: UsageBucket = UsageBucket(),
    /** Rolling 7 UTC days ending today, pre-sliced agent-side. */
    val week: UsageBucket = UsageBucket(),
    val totals: UsageBucket = UsageBucket(),
    /**
     * Per-day buckets, "YYYY-MM-DD" (UTC) -> bucket, the last ~60 days
     * (hub-agent HISTORY_DAYS) — what the usage page's 30-day stacked daily
     * chart is built from. Empty from an agent predating the field.
     */
    val days: Map<String, UsageBucket> = emptyMap(),
    /** ISO timestamp of the newest transcript entry counted into this block. */
    val lastActivity: String = "",
    /** Per-model token counts, biggest consumer first. */
    val models: List<ModelUsage> = emptyList(),
)

/**
 * One window's token counts. The names match the wire exactly (`input`,
 * `output`, …) — they were `inputTokens`/`outputTokens` without a @SerialName,
 * so they never decoded and every figure read zero.
 */
@Serializable
data class UsageBucket(
    val input: Long = 0,
    val output: Long = 0,
    val cacheWrite: Long = 0,
    val cacheRead: Long = 0,
) {
    val total: Long get() = input + output + cacheWrite + cacheRead
}

@Serializable
data class ModelUsage(
    val model: String = "",
    val today: UsageBucket = UsageBucket(),
    val week: UsageBucket = UsageBucket(),
    val totals: UsageBucket = UsageBucket(),
)

@Serializable
data class RepoUsage(
    val repo: String = "",
    val remoteKey: String = "",
    val usage: UsageInfo = UsageInfo(),
)

/**
 * A committed transcript entry. Live frames key on [id]; archive/history key on
 * [uuid] — [key] returns whichever is present (matches chat.js buildItems).
 */
@Serializable
data class TailEntry(
    val id: String = "",
    val uuid: String = "",
    val role: String = "",
    val text: String = "",
    val ts: String = "", // ISO-8601 timestamp from the transcript entry, not epoch
    val blocks: List<Block> = emptyList(),
) {
    val key: String get() = id.ifEmpty { uuid }
}

// ---- transcript blocks (polymorphic on the "t" discriminator) ----------------
// Modeled as an OPEN polymorphic hierarchy (not sealed) so [TurmaJson] can map
// an unrecognized block type to [UnknownBlock] instead of throwing.

@Serializable
abstract class Block

@Serializable
@SerialName("text")
data class TextBlock(val text: String = "", val truncated: Boolean = false) : Block()

@Serializable
@SerialName("thinking")
data class ThinkingBlock(val text: String = "", val truncated: Boolean = false) : Block()

@Serializable
@SerialName("tool_use")
data class ToolUseBlock(
    val id: String = "",
    val name: String = "",
    val input: JsonElement? = null,
    val truncated: Boolean = false,
) : Block()

@Serializable
@SerialName("tool_result")
data class ToolResultBlock(
    val forId: String = "",
    val text: String = "",
    val isError: Boolean = false,
    val truncated: Boolean = false,
) : Block()

@Serializable
@SerialName("task_notification")
data class TaskNotificationBlock(
    val summary: String = "",
    val status: String = "",
    val result: String = "",
    val truncated: Boolean = false,
) : Block()

@Serializable
@SerialName("__unknown")
data class UnknownBlock(val ignored: String = "") : Block()

// ---- WebSocket frame shapes --------------------------------------------------

@Serializable
data class TailFrame(
    val type: String = "",
    val entries: List<TailEntry> = emptyList(),
    val text: String = "",
    val status: TurnStatus? = null,
)

@Serializable
data class TurnStatus(
    val verb: String = "",
    // Token counters and elapsed are DISPLAY STRINGS on the wire ("1.2k", "340",
    // "12s", or "" when absent) — parsePaneStatus in tunnel-agent.js scrapes them
    // straight off the TUI, it does not emit numbers. Typing them as Long made
    // decodeFromString<TailFrame> throw on every real status frame (coerceInputValues
    // won't turn "1.2k"/"" into a Long), and LiveTail swallows that exception and
    // drops the WHOLE turn frame — so the status footer never rendered.
    val up: String = "",
    val down: String = "",
    val elapsed: String = "",
    val hint: String = "",
    // The live agent-manager list scraped from the pane (parseAgentList in
    // tunnel-agent.js): "main" plus each background subagent. Present only when the
    // TUI's agent list is expanded below the input box; absent otherwise.
    val agents: List<AgentRow> = emptyList(),
)

/** One row of the pane's live agent list: {sel,type,label} (tunnel-agent.js). */
@Serializable
data class AgentRow(
    val sel: Boolean = false,
    val type: String = "",
    val label: String = "",
)

@Serializable
data class WsTokenResponse(
    val token: String = "",
    val expiresInSec: Long = 0,
)

@Serializable
data class AudioResult(
    val type: String = "",
    val transcript: Transcript = Transcript(),
    val durationMs: Long = 0,
    val bytes: Long = 0,
    val capped: Boolean = false,
) {
    @Serializable
    data class Transcript(
        val text: String = "",
        val language: String = "",
        val unavailable: Boolean = false,
        val reason: String = "",
    )
}

@Serializable
data class HistoryResponse(
    val entries: List<TailEntry> = emptyList(),
    val truncated: Boolean = false,
    val fetchedAt: Long = 0,
    val pending: Boolean = false,
    val cmdId: String = "",
)

// ---- archive / search --------------------------------------------------------

@Serializable
data class SearchResponse(
    val query: String = "",
    val groups: List<SearchGroup> = emptyList(),
)

@Serializable
data class SearchGroup(
    val remoteKey: String = "",
    val repo: String = "",
    val matches: List<SearchMatch> = emptyList(),
)

@Serializable
data class SearchMatch(
    val transcriptId: String = "",
    val host: String = "",
    val summary: String = "",
    val role: String = "",
    val ts: String = "", // ISO-8601 timestamp, not epoch
    val uuid: String = "",
    val snippet: String = "",
)

@Serializable
data class ArchiveListResponse(
    val sessions: List<ArchiveSession> = emptyList(),
)

@Serializable
data class ArchiveSession(
    val transcriptId: String = "",
    val host: String = "",
    val remoteKey: String = "",
    val repo: String = "",
    val worktree: String = "",
    val summary: String = "",
    val createdAt: String = "", // ISO-8601 (archive.js stores TEXT), not epoch
    val endedTs: String = "",
    val msgCount: Int = 0,
)

@Serializable
data class ArchiveTranscript(
    val transcriptId: String = "",
    val repo: String = "",
    val host: String = "",
    val summary: String = "",
    val endedTs: String = "", // ISO-8601 (archive.js stores TEXT), not epoch
    val createdAt: String = "",
    val entries: List<TailEntry> = emptyList(),
)
