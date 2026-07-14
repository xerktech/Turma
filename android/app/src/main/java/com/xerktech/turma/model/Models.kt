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
)

@Serializable
data class AgentInfo(
    val key: String = "",
    val device: String = "",
    val lastSeen: Long = 0,
    val startedAt: Long = 0,
    val online: Boolean = false,
    val terminalOnline: Boolean = false,
    val repos: List<RepoInfo> = emptyList(),
    val sessions: List<SessionInfo> = emptyList(),
    val usage: UsageInfo? = null,
    val repoUsage: List<RepoUsage> = emptyList(),
    val github: GithubInfo? = null,
    val clones: List<CloneInfo> = emptyList(),
    val commands: List<CommandInfo> = emptyList(),
)

@Serializable
data class RepoInfo(
    val name: String = "",
    val root: Boolean = false,
    val lastActivity: Long = 0,
    val resumable: List<ResumableInfo> = emptyList(),
)

@Serializable
data class ResumableInfo(
    val transcriptId: String = "",
    val cwd: String = "",
    val summary: String = "",
    val label: String = "",
    val ts: Long = 0,
    val source: String = "",
)

@Serializable
data class GithubInfo(
    val ok: Boolean = false,
    val login: String = "",
    val repos: List<String> = emptyList(),
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
)

@Serializable
data class GitState(
    val repoName: String = "",
    val branch: String = "",
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
    val newPrUrls: List<String> = emptyList(),
    val tail: List<TailEntry> = emptyList(),
)

@Serializable
data class PrInfo(
    val url: String = "",
    val number: Int = 0,
    val state: String = "",
    val title: String = "",
    val checks: String = "",
)

@Serializable
data class UsageInfo(
    val today: UsageBucket = UsageBucket(),
    /** Rolling 7 UTC days ending today, pre-sliced agent-side. */
    val week: UsageBucket = UsageBucket(),
    val totals: UsageBucket = UsageBucket(),
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
    val ts: Long = 0,
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
    val up: Long = 0,
    val down: Long = 0,
    val elapsed: Long = 0,
    val hint: String = "",
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
    val ts: Long = 0,
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
    val createdAt: Long = 0,
    val endedTs: Long = 0,
    val msgCount: Int = 0,
)

@Serializable
data class ArchiveTranscript(
    val transcriptId: String = "",
    val repo: String = "",
    val host: String = "",
    val summary: String = "",
    val endedTs: Long = 0,
    val createdAt: Long = 0,
    val entries: List<TailEntry> = emptyList(),
)
