/**
 * Typed channel registry — the single source of truth for every name that
 * flows between the Turma background JSContext and its phone WebView.
 *
 * This replaces upstream's same-JS-context seam (the phone UI called `App`
 * methods directly and observed AppOptions.onState/onEnterSession/onRichTail
 * in-process). Here the same observer/command surface crosses the
 * background<->WebView channel bus:
 *
 *   observers  -> broadcast channels (background -> UI)
 *   commands   -> the "turma:cmd" RPC (UI -> background)
 *   hub REST   -> the "turma:fetch" RPC (the UI's HubClient keeps its
 *                 upstream `fetchFn` injection seam; the background does the
 *                 real fetch, which has no CORS)
 *   config     -> RPC-proxied KeyValueStorage (same `turma.glasses.config`
 *                 key upstream used) + a config-changed nudge
 */

import type { Rpc } from "@mentra/miniapp/ui";

import type { TailEntry } from "../core/types.ts";
import type { PhoneStatePayload } from "./phone-state.ts";

/** Whether the background is running the signed-in App or waiting for setup. */
export type BackgroundPhase = "setup" | "running";

export interface ProxyFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** String bodies only — the background fetch polyfill takes strings. */
  body?: string;
}

export interface ProxyFetchResponse {
  status: number;
  ok: boolean;
  bodyText: string;
}

export type PhoneCommand =
  | { kind: "enterSession"; sessionId: string; hostKey?: string }
  | { kind: "setOrgFilter"; siteKey: string }
  | { kind: "setAutoStartOrg"; siteKey: string; enabled: boolean };

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  /** Fired after every glasses repaint (AppOptions.onState). */
  "turma:state": PhoneStatePayload;
  /** Fired on a genuine session enter on the glasses (onEnterSession). */
  "turma:enter-session": { hostKey: string; sessionId: string };
  /** The focused session's raw rich tail entries (onRichTail). */
  "turma:rich-tail": { sessionId: string; entries: TailEntry[] };
  /** Phase changes (sign-in completed in another surface, sign-out, …). */
  "turma:phase": { phase: BackgroundPhase };

  // ── UI → background (RPC) ──────────────────────────────────────────────

  /** Proxied hub fetch — see ProxyFetchRequest. */
  "turma:fetch": Rpc<ProxyFetchRequest, ProxyFetchResponse>;
  /** KeyValueStorage over session.storage. */
  "turma:storage-get": Rpc<{ key: string }, { value: string | null }>;
  "turma:storage-set": Rpc<{ key: string; value: string }, { ok: true }>;
  /**
   * The UI persisted a new config (sign-in or sign-out): reload it and
   * restart/stop the App accordingly. Resolves with the settled phase.
   */
  "turma:config-changed": Rpc<Record<string, never>, { phase: BackgroundPhase }>;
  /** App command surface (enterSession / setOrgFilter / setAutoStartOrg). */
  "turma:cmd": Rpc<PhoneCommand, { ok: boolean }>;
  /** Hydration snapshot for a freshly opened WebView. */
  "turma:get-state": Rpc<Record<string, never>, { phase: BackgroundPhase; state: PhoneStatePayload | null }>;
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>;
}
