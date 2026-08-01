// Typed access to the web dashboard's OWN rendering engines, vendored verbatim
// (XERK-171 full parity). turma/public/chat.js and board.js are the source of
// truth the Android app mirrors; rather than hand-roll (and drift from) a third
// renderer, the phone drives these in-process — fed by the plugin's HubClient.
//
// They are pure, side-effect-free at import (verified: no fetch/socket/DOM at
// load — only function definitions + a `window.Turma*` / `module.exports`
// assignment), so importing them for their pure functions is safe. The copies
// under vendor/*.cjs must stay byte-identical to turma/public/*.js — vendor.test
// asserts it, so CI fails the moment they drift.

// The vendored files are classic-script CJS (module.exports). The glasses
// package is type:module, so they carry the .cjs extension to be read as CJS by
// both Node (vitest) and Vite's commonjs interop. They ship no types.
// @ts-expect-error vendored classic script, no type declarations
import chatMod from "./chat.cjs";
// @ts-expect-error vendored classic script, no type declarations
import boardMod from "./board.cjs";

// A transcript entry as buildItems consumes it — the rich `blocks[]` the hub's
// /history and /live already deliver (see hub-agent.py _entry_blocks). Only the
// fields the render pipeline reads are modelled; the rest pass through.
export interface RichBlock {
  t: string;
  text?: string;
  [key: string]: unknown;
}
export interface RichEntry {
  id?: string;
  uuid?: string;
  role: string;
  text?: string;
  blocks?: RichBlock[];
}

export interface Verbosity {
  preset: "concise" | "normal" | "verbose";
  show: { thinking: boolean; tools: boolean; outputs: boolean };
}

// The pure subset of chat.js the phone uses. (Node/module.exports surface.)
interface ChatEngine {
  buildItems(entries: RichEntry[]): unknown[];
  itemsToHtml(items: unknown[]): string;
  renderProse(text: string): string;
  // Delegated code-block copy handler (XERK-183): true when it handled a
  // .md-copy click, so the phone's shared root listener can early-out.
  copyCodeClick(e: Event): boolean;
  prettyModel(model: string | null | undefined): string;
  // The web's own transcript merge (id-keyed, richer/longer copy wins) so the
  // phone accumulates history + live deltas exactly as the web does.
  mergeTail(existing: RichEntry[], incoming: RichEntry[]): RichEntry[];
  __setVerbosity(v: Verbosity): void;
  __setNoExpand(on: boolean): void;
}

// The pure subset of board.js the phone uses.
interface BoardEngine {
  boardHtml(sites: unknown[], filter: string, opts: Record<string, unknown>): string;
  detailHtml(ticket: unknown, detail: unknown, opts: Record<string, unknown>): string;
  mergeSites(agents: unknown[]): BoardSite[];
  categoryOf(ticket: unknown): string;
  // Drag-drop optimistic-move sweep: "clear" once the poll reflects the move,
  // else "hold" (board.js).
  moveSweepVerdict(move: unknown, realCat: string, now: number, settleMs: number, errorTtlMs: number): string;
  ticketSort(a: unknown, b: unknown): number;
  orgColorMap(allKeys: string[], pins?: Record<string, number>): Map<string, string>;
  orgColor(siteKey: string, allKeys?: string[] | null, pins?: Record<string, number>): string;
  orgName(siteKey: string, override?: string | null): string;
  ticketSessionIndex(agents: unknown[]): Map<string, unknown[]>;
  ticketSessionsOf(idx: Map<string, unknown[]>, siteKey: string, key: string): unknown[];
  ageStr(iso: string, now?: number): string;
  createFormHtml(state: Record<string, unknown>): string;
  SLOTS: number;
  [key: string]: unknown;
}

// Ported from newticket.js (NOT on board.js): split a labels/tags string. Jira
// splits on whitespace+commas; Azure tags on commas only (a tag can hold spaces).
// Deduped, capped at 20 — matches the web exactly (newticket.test's rules).
export function splitLabels(raw: string | undefined, source: string): string[] {
  const parts = source === "azure" ? String(raw || "").split(",") : String(raw || "").split(/[,\s]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out.slice(0, 20);
}

export interface BoardSite {
  siteKey: string;
  orgName?: string;
  source?: string;
  online?: boolean;
  tickets: { key: string; [key: string]: unknown }[];
  hosts?: unknown[];
  repoOptions?: unknown[];
  hostOptions?: unknown[];
  models?: { available?: string[]; defaultLabel?: string };
  [key: string]: unknown;
}

export const Chat = chatMod as ChatEngine;
export const Board = boardMod as BoardEngine;

// Render a rich transcript to HTML at a given verbosity — the exact web/Android
// output (bubbles, tool cards, thinking, code, PR/interrupt marks). `noExpand`
// hides the "Show more…" buttons (there's no lazy /history to expand into here).
export function renderTranscript(entries: RichEntry[], verbosity: Verbosity): string {
  Chat.__setVerbosity(verbosity);
  Chat.__setNoExpand(true);
  return Chat.itemsToHtml(Chat.buildItems(entries));
}
