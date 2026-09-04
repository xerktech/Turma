# ADR: the hub chooses which transcripts to archive, not the agent (XERK-431)

Status: accepted, shipping incrementally. The operative rules live in
`.claude/rules/agent-archive.md` (agent) and `.claude/rules/turma-archive.md` (hub); this file is
the *why*, the alternatives weighed, and the rollover plan.

## The problem this closes

Archive sync used to work by the agent GUESSING which ended transcripts to offer the hub each beat.
Because the manifest rides every (slow-cadence) beat it is capped (`ARCHIVE_MANIFEST_MAX`), so the
agent had to ROTATE a bounded window over its whole transcript universe and REMEMBER, per transcript,
what it had already offered — `_archive_offered` (a per-id "last offered" map), `_archive_cand_hwm`
(the high-water universe count the map is bounded against), `ARCHIVE_OFFERED_HARD_MAX`, a persisted
`archive-offered.json` (so a restart loop did not starve the tail, XERK-430), and `_archive_known`
(what the hub said it held, so the backlog slice could be chosen).

That memory's size had to be bounded against a set the agent could only ESTIMATE, and the bound was
wrong four times (XERK-424), each version looking obviously correct:

- a flat 5,000 — cannot cover the live set;
- `2 x` this beat's candidate count — computed at the trough of a busy/idle oscillation;
- any constant multiple — the needed factor tracks the peak/trough ratio, which is unbounded;
- the high-water CANDIDATE count — blind to running slugs (dropped before their files are listed).

The final version bounds on the high-water transcript UNIVERSE, which is right — but the whole thing
is the agent reconstructing, badly and in RAM, something the hub already knows exactly: **which
transcripts it is short of.** The hub's `sessions` table is durable, sized by its storage rather than
an agent's heap, survives an agent restart by construction, and cannot be evicted into the ambiguous
"never offered" state every agent-side bound had to work around.

## The inversion

The hub names what it wants; the agent's job becomes an ANSWER, not a guess.

- **Agent -> hub, each refresh beat: a cheap INVENTORY** `archiveInventory: [{i, s, r}]` — transcript
  id, its current rendered size `s`, its current raw-total `r` (0 while a running non-dsh session
  defers its raw sidecars, so the hub never raw-wants what the agent will not push). NO metadata: the
  repo/summary/worktree the hub needs for a browsable row already ride the DELTA push
  (`ingestChunk`'s `meta`), so the inventory carries only what the hub cannot already derive.
- **Hub -> agent: the WANT**, delivered as the existing `archiveHave` cursor map, but containing ONLY
  the transcripts the hub is short of (`bytesStored < s` OR `rawBytes < r`), plus `archiveRawHave`
  for those (walked from the hub's own raw store, `listRawFiles`). The agent pushes exactly those
  with the delta paths it already had — `_archive_deltas` / `_archive_raw_deltas` are UNCHANGED.
- A static capability marker `archiveOffer: "hub"` rides every reply, so the agent knows to send an
  inventory instead of a manifest.

This deletes, on the agent side (behind the capability flag now; removed after fleet rollover):
`_archive_offered` + its eviction, `_archive_cand_hwm` + the high-water logic,
`ARCHIVE_OFFERED_HARD_MAX` + its clamp + its warning, `archive-offered.json`, `_archive_known` +
`_note_archive_known`, and `_archive_window`'s backlog+rotation branch — "the whole 'what does the
bound have to cover' argument, which is where six QA passes went." It also fixes XERK-430
(restart-loop starvation) FOR FREE: the agent's inventory position is a single integer that may reset
to 0 on restart with no cost, because the fairness guarantee now lives in the hub's DURABLE
size-tracking, not in agent RAM.

## The two hard questions the ticket flagged, and how they are answered

### 1. "The hub does not know what the host HAS."

The ticket weighed two options: (1) the agent sends a cheap inventory and the hub diffs; (2) the hub
INFERS absence, which it warned against because "the hub has no row for X" and "X no longer exists on
the host" are indistinguishable — how XERK-280's cursor bug happens. We take option 1, and never
infer absence: a row the inventory stops mentioning is left exactly as it is (its archived bytes are
still valuable); it is simply never re-offered.

### 2. "Size the inventory carefully — it rides every beat."

The ticket's worry was that a "cheap FULL inventory" of the whole universe is UNBOUNDED in the host's
transcript count, and `manifestCursors` already caps at `ARCHIVE_MANIFEST_CURSOR_MAX` after a real
6.9s event-loop stall from ~974k ids in one beat. We resolve it WITHOUT a durable per-host inventory
+ delta protocol (which was the heavy alternative) by making the inventory a **bounded, rotating
window** — the newest `ARCHIVE_MANIFEST_RECENT` (so an ending session is offered promptly) plus a
round-robin slice of the rest, capped at `ARCHIVE_INVENTORY_MAX`. The hub answers with the subset of
THIS window it is short of.

The key insight that makes this correct without agent-side rotation memory: **`want` is the current
window intersected with the hub's durable size knowledge.** Completeness over the whole universe is
carried by the window ROTATING (every transcript enters a window periodically -> if short, wanted ->
pushed); the hub's durable `bytesStored`/`rawBytes` means it re-identifies short transcripts in every
window with no agent memory. Two properties fall out:

- **No schema change.** The hub compares the just-received `s`/`r` against the `bytesStored`/`rawBytes`
  it already stores; it never needs to persist `s`/`r`.
- **No oscillation trap.** The old rotation's limit cycles (XERK-424) came from a per-transcript
  offered-MEMORY interacting with an oscillating candidate count. The new window has no such memory;
  the oscillation-prone part (recently-active transcripts) is always covered by the recent slice (a
  just-ended session is newest by mtime), and the round-robin only walks the STABLE old backlog, which
  does not oscillate.

### Deleted-but-incomplete transcripts do not starve `want`

A transcript deleted on the host (Claude Code's 30-day cleanup, a removed slug) simply stops appearing
in any window, so it is never wanted — even if it was incomplete when it went. There is no
"want-forever" slot leak and therefore no need for an `archiveGone` report; the want set is recomputed
from the live inventory every beat, never accumulated.

## Backward compatibility and rollover

The hub is a single deployment; agents self-update gradually. So the matrix is:

- **New hub + OLD agent**: the old agent still sends `archiveManifest` with its rotation; the hub
  handles it exactly as before (`manifestCursors`). Unchanged, must stay for a release.
- **New hub + NEW agent**: the agent sends `archiveInventory`; the hub replies with the want.
- The agent tracks `archiveOffer` off every reply, so a hub ROLLBACK (the marker disappears) reverts
  it to the manifest path within one refresh beat — no stall.

**This PR keeps the old rotation code behind the `archiveOffer` capability flag.** Deleting it is a
follow-up once every hub in the fleet reports the capability (in practice: immediately after this
deploys, since there is one hub — but the defensive fallback is retained one release for rollback
safety). That follow-up is filed as its own ticket.

## What did NOT change

- The delta push itself (`ingestChunk`/`ingestRaw`, `_archive_deltas`/`_archive_raw_deltas`), all its
  size ceilings, the org-ownership gate (XERK-344/573), the raw layer's per-file cursor, the
  worker-thread discipline (XERK-395), the collision-drop (XERK-428), and the running-worktree
  rendered inclusion. The inversion changes only WHICH transcripts are offered, not how bytes move.
