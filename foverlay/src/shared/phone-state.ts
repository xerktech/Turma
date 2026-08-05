// Serialization helpers for the background -> phone state channel.
//
// Upstream the phone UI rendered straight from the App's AppState object
// (same JS context). Across the channel bus only plain JSON travels, so the
// background serializes the subset the phone actually reads
// (phone/render.ts + phone/phone.ts + the vendored board engine):
//
//   agents (SLIMMED — see slimAgent), orgFilter, orgColors, autoStartOrgs,
//   screen + session identity, liveTurn, flash, now.
//
// Deliberately NOT serialized: transcripts/reveal (the phone keeps its own
// rich buffer fed by turma:rich-tail), pending, loadingHistory, and the
// glasses-only per-screen cursor states — the phone never reads them, and
// they're the bulk of the state's weight on every 80ms reveal tick.
//
// The agents array is slimmed to what the phone renders (XERK-215): the raw
// fleet payload is hundreds of KB (a real 6-host fleet measured ~800 KB —
// repos[].resumable alone was half of it), and every byte here is
// JSON-stringified repeatedly on its way through the channel bus and then
// injected into the WebView as a script string, inside a JSContext with a
// hard 32 MB heap. Shipping the full payload per repaint is what broke the
// phone companion on real fleets. If the phone grows a new read, widen
// slimAgent's keep-list — never revert to passing `state.agents` through.
//
// The UI side hydrates the payload back into a full-shaped AppState (via
// createInitialState) so phone/phone.ts and phone/render.ts keep their
// upstream `AppState` typing untouched.

import { createInitialState, newSessionState, type AppState } from "../core/app.ts";
import type { AgentInfo, LiveSignals, RepoInfo, SessionInfo } from "../core/types.ts";

export interface PhoneStatePayload {
  now: number;
  screen: AppState["screen"];
  session: { hostKey: string; sessionId: string } | null;
  agents: AgentInfo[];
  orgFilter: string;
  orgColors: Record<string, number>;
  autoStartOrgs: Record<string, boolean>;
  liveTurn: { sessionId: string; text: string } | null;
  flash: string | null;
  flashUntil: number;
  // The App's hub-unreachable state (pollErrorActive). The glasses surface it
  // as a flash; the phone renders a persistent banner — without this, a
  // failing poll loop is INVISIBLE on the phone: it just looks like an empty
  // fleet (XERK-215).
  pollError?: boolean;
}

// The phone's transcript is fed by turma:rich-tail + on-demand history, so the
// cached tail on each session's live signals — the heaviest per-session field —
// never reaches the phone. Everything else on the signals (question state,
// paneBusy, ...) is what liveState/the question sheet read, and rides intact.
function slimLive(live: LiveSignals | null | undefined): LiveSignals | null {
  if (!live) return live ?? null;
  if (!live.tail || live.tail.length === 0) return live;
  return { ...live, tail: [] };
}

function slimSession(s: SessionInfo): SessionInfo {
  return { ...s, session: slimLive(s.session) };
}

// Repos are on the phone for exactly one reader: the board engine's
// ticketSessionIndex, whose resumable channel puts ended-session chips on
// ticket cards. Only ticketed entries matter to it, and only the fields
// sessionChipHtml renders — everything else (branches, paths, the unticketed
// bulk of resumable) stays behind.
function slimRepos(repos: RepoInfo[] | undefined): RepoInfo[] {
  const out: RepoInfo[] = [];
  for (const r of repos ?? []) {
    const resumable = Array.isArray(r.resumable) ? (r.resumable as Record<string, unknown>[]) : [];
    const ticketed = resumable.filter((t) => (t?.ticket as { key?: string } | undefined)?.key);
    if (ticketed.length === 0) continue;
    out.push({
      name: r.name,
      path: r.path,
      resumable: ticketed.map((t) => {
        // Chip fields only. The ticket sub-object keeps the index key
        // (key+siteKey) and the branch the chip is labelled with; the entry's
        // own summary is a label/tooltip fallback, so a prompt-derived
        // multi-hundred-byte one is capped — measured on a real fleet these
        // summaries alone were ~140 KB of the payload.
        const ticket = t.ticket as { key?: string; siteKey?: string; branch?: string } | undefined;
        const summary = typeof t.summary === "string" && t.summary.length > 140 ? `${t.summary.slice(0, 139)}…` : t.summary;
        return {
          ticket: ticket ? { key: ticket.key, siteKey: ticket.siteKey, branch: ticket.branch } : ticket,
          transcriptId: t.transcriptId,
          endedTs: t.endedTs,
          summary,
          summaryManual: t.summaryManual,
          label: t.label,
          status: t.status,
        };
      }),
    });
  }
  return out;
}

// Explicit keep-list, not a drop-list: a new heavy heartbeat block must not
// leak onto the phone by default. Kept small blocks the board engine reads:
// jira (tickets/repoOptions/siteKey), models (the org model picker),
// commands (the start-button sweep).
function slimAgent(a: AgentInfo): AgentInfo {
  return {
    key: a.key,
    device: a.device,
    online: a.online,
    repos: slimRepos(a.repos),
    sessions: (a.sessions ?? []).map(slimSession),
    closedSessions: a.closedSessions ?? [],
    jira: a.jira,
    models: a.models,
    commands: a.commands,
  } as AgentInfo;
}

export function serializePhoneState(state: AppState): PhoneStatePayload {
  return {
    now: state.now,
    screen: state.screen,
    session: state.session ? { hostKey: state.session.hostKey, sessionId: state.session.sessionId } : null,
    agents: state.agents.map(slimAgent),
    orgFilter: state.orgFilter,
    orgColors: state.orgColors,
    autoStartOrgs: state.autoStartOrgs,
    liveTurn: state.liveTurn,
    flash: state.flash,
    flashUntil: state.flashUntil,
    pollError: state.pollErrorActive,
  };
}

export function hydratePhoneState(payload: PhoneStatePayload): AppState {
  const base = createInitialState(payload.now);
  return {
    ...base,
    screen: payload.screen,
    session: payload.session ? newSessionState(payload.session.hostKey, payload.session.sessionId) : null,
    agents: payload.agents,
    orgFilter: payload.orgFilter,
    orgColors: payload.orgColors,
    autoStartOrgs: payload.autoStartOrgs,
    liveTurn: payload.liveTurn,
    flash: payload.flash,
    flashUntil: payload.flashUntil,
    pollErrorActive: !!payload.pollError,
  };
}

// Decides whether a repaint changed anything the phone can see. App.onState
// fires on EVERY glasses repaint — including the 80ms reveal ticks of a
// streaming turn — but those mutate only transcripts/reveal, which the phone
// payload doesn't carry. Broadcasting the (even slimmed) payload per tick
// floods the WebView bridge for nothing, so the background sends only when
// one of the serialized fields actually changed. Reference compares are
// enough: App.poll replaces `agents` wholesale each poll, and every mutation
// path builds fresh objects. `now` is deliberately NOT compared — it moves on
// every repaint and rides along whenever a real change sends.
// Newline can appear in neither a host key nor a session id, so it is a safe
// compound-key separator (and it keeps this file plain text, unlike a NUL).
function sessionKeyOf(state: AppState): string {
  return state.session ? `${state.session.hostKey}\n${state.session.sessionId}` : "";
}

// ---- chunked state pull (XERK-215) -----------------------------------------
// The host→WebView inject leg silently drops large frames on real devices:
// every frame observed to traverse it is RPC-reply sized (~1 KB), while the
// state broadcasts (~300 KB slimmed, ~800 KB before) never arrive. These
// helpers split one serialized PhoneStatePayload into small RPC replies the
// UI reassembles — the transport shape that provably works.

// Small enough that a chunk's inject (with its double-JSON-escape overhead)
// stays within the same order as the RPC replies known to get through.
export const STATE_CHUNK_CHARS = 16 * 1024;

export interface StateChunk {
  v: number;
  total: number;
  seq: number;
  chunk: string;
}

// One serialized snapshot being served out in slices. Rebuilt when a pull
// starts over at seq 0 (or on the first request), never mid-pull, so a
// serving cycle is internally consistent; `v` lets the puller detect a roll.
export interface ChunkedSnapshot {
  v: number;
  json: string;
}

export function nextChunkedSnapshot(prev: ChunkedSnapshot | null, state: AppState): ChunkedSnapshot {
  return { v: (prev?.v ?? 0) + 1, json: JSON.stringify(serializePhoneState(state)) };
}

export function stateChunkOf(snap: ChunkedSnapshot, seq: number, chunkChars: number = STATE_CHUNK_CHARS): StateChunk {
  const total = Math.max(1, Math.ceil(snap.json.length / chunkChars));
  const bounded = Math.max(0, Math.min(seq, total - 1));
  return { v: snap.v, total, seq: bounded, chunk: snap.json.slice(bounded * chunkChars, (bounded + 1) * chunkChars) };
}

// Reassembles a pulled sequence back into the payload. Returns null when the
// chunks don't form one consistent snapshot (a version rolled mid-pull, a
// slice missing) — the puller just tries again next tick.
export function assembleStateChunks(chunks: StateChunk[]): PhoneStatePayload | null {
  if (chunks.length === 0) return null;
  const v = chunks[0]!.v;
  const total = chunks[0]!.total;
  if (chunks.length !== total) return null;
  const parts: string[] = [];
  for (let i = 0; i < total; i++) {
    const c = chunks[i]!;
    if (c.v !== v || c.seq !== i) return null;
    parts.push(c.chunk);
  }
  try {
    return JSON.parse(parts.join("")) as PhoneStatePayload;
  } catch {
    return null;
  }
}

export function createPhoneStateGate(): (state: AppState) => boolean {
  let prev: {
    agents: AppState["agents"];
    screen: AppState["screen"];
    sessionKey: string;
    orgFilter: string;
    orgColors: AppState["orgColors"];
    autoStartOrgs: AppState["autoStartOrgs"];
    liveTurn: AppState["liveTurn"];
    flash: string | null;
    flashUntil: number;
    pollError: boolean;
  } | null = null;
  return (state: AppState): boolean => {
    const sessionKey = sessionKeyOf(state);
    if (
      prev &&
      prev.agents === state.agents &&
      prev.screen === state.screen &&
      prev.sessionKey === sessionKey &&
      prev.orgFilter === state.orgFilter &&
      prev.orgColors === state.orgColors &&
      prev.autoStartOrgs === state.autoStartOrgs &&
      prev.liveTurn === state.liveTurn &&
      prev.flash === state.flash &&
      prev.flashUntil === state.flashUntil &&
      prev.pollError === state.pollErrorActive
    ) {
      return false;
    }
    prev = {
      agents: state.agents,
      screen: state.screen,
      sessionKey,
      orgFilter: state.orgFilter,
      orgColors: state.orgColors,
      autoStartOrgs: state.autoStartOrgs,
      liveTurn: state.liveTurn,
      flash: state.flash,
      flashUntil: state.flashUntil,
      pollError: state.pollErrorActive,
    };
    return true;
  };
}
