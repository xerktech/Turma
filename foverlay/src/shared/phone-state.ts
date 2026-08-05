// Serialization helpers for the background -> phone state channel.
//
// Upstream the phone UI rendered straight from the App's AppState object
// (same JS context). Across the channel bus only plain JSON travels, so the
// background serializes the subset the phone actually reads
// (phone/render.ts + phone/phone.ts):
//
//   agents (full — Board.mergeSites/liveState/siteKeyOf read them),
//   orgFilter, orgColors, autoStartOrgs, screen + session identity,
//   liveTurn, flash, now.
//
// Deliberately NOT serialized: transcripts/reveal (the phone keeps its own
// rich buffer fed by turma:rich-tail), pending, loadingHistory, and the
// glasses-only per-screen cursor states — the phone never reads them, and
// they're the bulk of the state's weight on every 80ms reveal tick.
//
// The UI side hydrates the payload back into a full-shaped AppState (via
// createInitialState) so phone/phone.ts and phone/render.ts keep their
// upstream `AppState` typing untouched.

import { createInitialState, newSessionState, type AppState } from "../core/app.ts";
import type { AgentInfo } from "../core/types.ts";

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
}

export function serializePhoneState(state: AppState): PhoneStatePayload {
  return {
    now: state.now,
    screen: state.screen,
    session: state.session ? { hostKey: state.session.hostKey, sessionId: state.session.sessionId } : null,
    agents: state.agents,
    orgFilter: state.orgFilter,
    orgColors: state.orgColors,
    autoStartOrgs: state.autoStartOrgs,
    liveTurn: state.liveTurn,
    flash: state.flash,
    flashUntil: state.flashUntil,
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
  };
}
