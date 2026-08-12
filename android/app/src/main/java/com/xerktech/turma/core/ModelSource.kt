package com.xerktech.turma.core

import com.xerktech.turma.model.AgentInfo
import com.xerktech.turma.model.LocalModelInfo
import com.xerktech.turma.model.SessionInfo

/**
 * Which model a session runs against, and how the chat compose bar paints it —
 * the port of web `chat.js`'s `localModelOffered` / `currentModelSource` /
 * `modelSourceLabel` / `modelSourceOpts` (XERK-246).
 *
 * Running out of Claude usage stops every session on a host at once; this is the
 * control that moves one onto the host's self-hosted model instead, keeping its
 * conversation. On a phone that matters most precisely when it matters at all —
 * usage runs out while you are away from a desk.
 */
object ModelSource {

    const val SUBSCRIPTION = "subscription"
    const val LOCAL = "local"

    /**
     * How long an unconfirmed switch keeps painting its own value. The switch
     * relaunches Claude with `--resume`, so the heartbeat can take several beats
     * to agree; without a memo the chip springs back to the old value and reads
     * as a control that did nothing. It AGES OUT so a switch that never lands
     * can't pin the chip on a lie forever.
     */
    const val SWITCH_SETTLE_MS = 60_000L

    /** An in-flight switch: what was asked for, when, and for which session. */
    data class Pending(val sessionId: String, val value: String, val at: Long)

    /**
     * Should the "run against" control be shown at all?
     *
     * Gated on the HOST's capability flag exactly as the composer's 📎 is gated
     * on `uploadMaxBytes` — an agent reporting nothing cannot do it, so offering
     * the switch would queue a command it silently drops (the hub 409s too).
     *
     * The second half is not redundant: a session already running `local` keeps
     * the control even if its host later lost the configuration, so there is
     * always a visible way back to the subscription.
     */
    fun offered(local: LocalModelInfo?, current: String): Boolean =
        local?.available == true || current == LOCAL

    /**
     * The source to paint: an unexpired [pending] for THIS session outranks the
     * heartbeat, else what the agent reports. Blank (an agent predating the
     * failover) reads as the subscription — the only thing it can run.
     */
    fun current(session: SessionInfo?, pending: Pending?, now: Long): String {
        // The id must MATCH, not merely be equal-to-blank: a memo with no
        // session id would otherwise be honoured against every record-less
        // session at once. The web refuses it the same way (chat.js `mine`).
        val id = session?.id.orEmpty()
        if (pending != null && id.isNotBlank() && pending.sessionId == id &&
            now - pending.at < SWITCH_SETTLE_MS
        ) {
            return pending.value
        }
        return session?.modelSource?.takeIf { it.isNotBlank() } ?: SUBSCRIPTION
    }

    /** Has [pending] outlived [SWITCH_SETTLE_MS]? */
    fun expired(pending: Pending?, now: Long): Boolean =
        pending != null && now - pending.at >= SWITCH_SETTLE_MS

    /**
     * Retire a memo the heartbeat has caught up with, or one that has aged out.
     *
     * The same "clears on its own completion signal, not a blind timer" rule the
     * dashboard's per-session pending follows; [SWITCH_SETTLE_MS] is only the
     * backstop for a switch that never lands. A memo for a DIFFERENT session is
     * never judged by this session's record — but it IS aged out, since the TTL
     * is about the memo, not about whose record answers it.
     *
     * Expiry has to retire the memo from the STORE, not merely stop [current]
     * from honouring it. Reading the clock inside a Composable makes the TTL a
     * silent event: Compose skips recomposition while the state compares equal,
     * so on a quiet fleet nothing re-evaluates it and the expired value stays on
     * screen. Measured: the whole "run against" control vanishing on an
     * unconfirmed switch away from `local` and never coming back — still gone at
     * t+120s, with the bar reading `model: default` while the session was in
     * fact still on the self-hosted model. Dropping the memo is a state CHANGE,
     * which is what makes the control repaint. The web has no equivalent bug
     * because `onPoll` recomputes `localModelOffered()` unconditionally on every
     * beat (`sessions.html`).
     */
    fun settle(pending: Pending?, session: SessionInfo?, now: Long): Pending? {
        if (pending == null) return null
        if (expired(pending, now)) return null
        if (session?.id != pending.sessionId) return pending
        return if (session.modelSource == pending.value) null else pending
    }

    /**
     * The memo to keep once the POST has come back.
     *
     * A refusal DROPS it rather than letting it age out: the hub 409s a host
     * with no local model, and a chip that keeps claiming a switch that was
     * rejected is worse than one that never moved — it is the same lie the TTL
     * exists to bound, just held for a full minute with the answer already in
     * hand. Pure so the rule is pinned by a test; inline in the ViewModel it was
     * the one decision a mutation could still delete unnoticed.
     */
    fun afterAttempt(pending: Pending?, ok: Boolean): Pending? = if (ok) pending else null

    /**
     * What the compose bar says after a command comes back.
     *
     * A blanket "✓ queued" on a discarded result is how `setModel`/`setMode`
     * reported the hub's 409 — the one it added deliberately so an out-of-parity
     * client could not silently drop the command — as a success. Pure and here
     * rather than inline in the ViewModel for the same reason [afterAttempt] is:
     * a decision inlined at a call site is one a mutation deletes unnoticed,
     * because a ViewModel call site has no gate in this project.
     *
     * [hubMessage] is the hub's own words (`hubErrorMessage`), preferred over
     * [failed] whenever it has any: "hub unreachable" for an 8ms 409 sends you
     * looking at the network for a refusal the hub already explained.
     */
    fun outcomeMessage(ok: Boolean, hubMessage: String?, queued: String, failed: String): String =
        if (ok) queued else "✗ " + (hubMessage?.takeIf { it.isNotBlank() } ?: failed)

    /**
     * The `modelSource` a spawn should carry, or null to omit it.
     *
     * Only "local" is ever sent: "subscription" is what a spawn already meant,
     * so omitting it keeps a bare spawn byte-identical to what it was before the
     * failover existed.
     */
    fun spawnValue(source: String?): String? = source?.takeIf { it == LOCAL }

    /**
     * Should the spawn composer offer a "Run against" row? Unlike [offered]
     * there is no session yet, so the host's capability flag is the whole rule.
     */
    fun composerOffers(local: LocalModelInfo?): Boolean = local?.available == true

    /**
     * The self-hosted model of the host a spawn is TARGETING — never the fleet's
     * first, which is the shape of a bug this repo has shipped before (a union
     * built over the wrong loop, `PARITY.md`/qa.md §5.7). The failover is
     * configured per host, so offering the row off some other host's block would
     * queue a `local` spawn the target 409s or silently drops.
     */
    fun hostLocalModel(agents: List<AgentInfo>, host: String): LocalModelInfo? =
        agents.firstOrNull { it.key == host }?.localModel

    /**
     * Human label for a source. A local session reads as the MODEL NAME, not the
     * word "local": it is a weaker model than Claude, and nobody should have to
     * wonder which one wrote a turn.
     */
    fun label(source: String, local: LocalModelInfo?): String =
        if (source == LOCAL) local?.model?.takeIf { it.isNotBlank() } ?: "local model"
        else "Subscription"

    /**
     * The chip's leading glyph, matching the web's ☁ / 🏠 (`chat.js`). It is the
     * at-a-glance answer to "which model wrote this turn", which the colour
     * alone can't give a colour-blind reader.
     */
    fun glyph(source: String): String = if (source == LOCAL) "🏠" else "☁"

    /** Menu rows as (value, label) pairs, in the web menu's order. */
    fun options(local: LocalModelInfo?): List<Pair<String, String>> =
        listOf(
            SUBSCRIPTION to "Claude subscription",
            LOCAL to (local?.model?.takeIf { it.isNotBlank() } ?: "Self-hosted model"),
        )

    /**
     * Is the Claude model picker meaningful for a RUNNING session's compose bar?
     * It is not on the local model: every alias it could offer — "Default"
     * included, since that resolves to the shared login's default — is one the
     * self-hosted endpoint refuses, so the chip states the fixed model instead
     * of offering a menu that can only break the session. Mirrors web
     * `cc-model-fixed`.
     *
     * The SPAWN composer deliberately does not use this — see [composerOffers]'
     * call site — because there the alias is stored for a session that may later
     * move back to the subscription, and the web sends it either way.
     */
    fun modelPickable(source: String): Boolean = source != LOCAL
}
