// Pure state -> text. No SDK, no fetch, no side effects — this is the whole UI,
// and it's fully unit-testable. Every screen is composed into at most GRID.ROWS
// lines of GRID.COLS chars so it always fits the G2 HUD.

import { GRID, GLYPH } from "./constants.js";
import { liveState, waitingCount } from "./sessions.js";
import type { SessionRef, LiveState } from "./types.js";
import type { AppState } from "./app.js";

const stateGlyph: Record<LiveState, string> = {
  working: GLYPH.working,
  waiting: GLYPH.waiting,
  idle: GLYPH.idle,
  stopped: GLYPH.stopped,
  error: GLYPH.error,
};

// --- text utilities ---------------------------------------------------------

export function wrap(text: string, cols: number = GRID.COLS): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= cols) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
    while (cur.length > cols) {
      // A single word longer than the line: hard-split it.
      lines.push(cur.slice(0, cols));
      cur = cur.slice(cols);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// Keep the selected row visible: return the slice of `n` items to show.
export function windowRange(count: number, sel: number, rows: number): [number, number] {
  if (count <= rows) return [0, count];
  let start = Math.max(0, sel - Math.floor(rows / 2));
  start = Math.min(start, count - rows);
  return [start, start + rows];
}

function fit(lines: string[]): string {
  return lines
    .slice(0, GRID.ROWS)
    .map((l) => (l.length > GRID.COLS ? l.slice(0, GRID.COLS) : l))
    .join("\n");
}

function shortHost(device: string | undefined): string {
  return (device || "?").split(/[.\-]/)[0].slice(0, 6);
}

// --- list screens -----------------------------------------------------------

// A generic selectable list: header line + windowed items with a ▸ cursor.
function listScreen(header: string, items: string[], sel: number, rows = GRID.ROWS - 1): string {
  const [a, b] = windowRange(items.length, sel, rows);
  const body = items.slice(a, b).map((text, i) => {
    const idx = a + i;
    const mark = idx === sel ? GLYPH.cursor : " ";
    return `${mark}${text}`.slice(0, GRID.COLS);
  });
  return fit([header, ...body]);
}

// --- per-screen renderers ---------------------------------------------------

function renderHome(st: AppState): string {
  const refs = st.refs;
  const run = refs.filter((r) => r.session.status === "running").length;
  const waiting = waitingCount(refs);
  // The flash message (e.g. "✓ spawn queued") takes over the header line for a
  // few seconds after an action, then app.ts clears it.
  const header = st.flash || `AGENTHUB ${run} run${waiting ? ` · ${waiting} ask` : ""}`;
  const items = refs.map((r) => sessionLine(r));
  items.push("+ New session");
  return listScreen(header.slice(0, GRID.COLS), items, st.home.sel);
}

function sessionLine(r: SessionRef): string {
  const g = stateGlyph[liveState(r.session)];
  const name = r.session.label || r.session.repo;
  return `${g} ${shortHost(r.device)}·${name} ${r.session.id}`;
}

function renderSession(st: AppState, ref: SessionRef): string {
  const s = ref.session;
  const ls = liveState(s);
  const header = `${s.id} ${s.repo} ${stateGlyph[ls]}${ls === "waiting" ? " ASK" : ""}`;
  const lines: string[] = [];
  const sig = s.session;
  if (sig?.question) {
    for (const l of wrap(`? ${sig.question}`)) lines.push(l);
  }
  for (const m of sig?.tail || []) {
    const who = m.role === "assistant" ? "cc" : "you";
    for (const l of wrap(`${who}: ${m.text}`)) lines.push(l);
  }
  if (!lines.length) lines.push(s.errorMsg ? `! ${s.errorMsg}` : "(no transcript yet)");

  const bodyRows = GRID.ROWS - 2; // header + footer
  const pages = Math.max(1, Math.ceil(lines.length / bodyRows));
  const page = Math.min(st.session.page, pages - 1);
  const slice = lines.slice(page * bodyRows, page * bodyRows + bodyRows);
  const footer = `[tap]menu ${page + 1}/${pages}`;
  return fit([header, ...slice, footer]);
}

function renderActions(st: AppState, ref: SessionRef): string {
  const header = `${ref.session.id} · actions`;
  return listScreen(header, actionLabels(actionsFor(ref)), st.actions.sel);
}

function renderReply(st: AppState, ref: SessionRef): string {
  const r = st.reply;
  const status = r.error ? `! ${r.error}` : r.listening ? "listening…" : r.sending ? "sending…" : "ready";
  const quote = r.text ? `"${r.text}"` : "(say your reply)";
  return fit([
    `Reply → ${ref.session.id}`,
    status,
    ...wrap(quote),
    "",
    "[tap]send [back]cancel",
  ]);
}

function renderConfirm(st: AppState, ref: SessionRef): string {
  const c = st.confirm;
  const warn =
    c.action === "delete"
      ? "Removes the branch too."
      : "Removes from hub; branch kept.";
  const opts = ["Cancel", `Confirm ${c.action}`];
  const body = opts.map((o, i) => `${i === st.confirm.sel ? GLYPH.cursor : " "}${o}`);
  return fit([`${c.action} ${ref.session.id}?`, warn, "", ...body]);
}

function renderNewHost(st: AppState): string {
  const hosts = onlineHosts(st);
  if (!hosts.length) return fit(["New session — host", "", "No hosts online.", "", "[back]"]);
  const items = hosts.map((h) => `${shortHost(h.device)} (${(h.repos || []).length} repos)`);
  return listScreen("New session — host", items, st.newHost.sel);
}

function renderNewRepo(st: AppState, hostDevice: string): string {
  const repos = reposFor(st, st.newRepo.hostKey);
  const items = [...repos.map((r) => r.name), "‹ back"];
  return listScreen(`${shortHost(hostDevice)} — repo`, items, st.newRepo.sel);
}

// --- action model (shared with app.ts) --------------------------------------

export type ActionId = "reply" | "restart" | "kill" | "start" | "delete" | "back";

export function actionsFor(ref: SessionRef): ActionId[] {
  const running = ref.session.status === "running";
  const acts: ActionId[] = [];
  if (running) acts.push("reply", "restart", "kill");
  else acts.push("start");
  acts.push("delete", "back");
  return acts;
}

function actionLabels(ids: ActionId[]): string[] {
  const label: Record<ActionId, string> = {
    reply: "Reply (voice)",
    restart: "Restart (clear ctx)",
    kill: "Kill (keep branch)",
    start: "Start",
    delete: "Delete",
    back: "‹ back",
  };
  return ids.map((id) => label[id]);
}

// --- host/repo helpers (also used by app.ts) --------------------------------

export function onlineHosts(st: AppState) {
  return st.agents.filter((a) => a.online && (a.repos || []).length);
}

export function reposFor(st: AppState, hostKey: string) {
  return st.agents.find((a) => a.key === hostKey)?.repos || [];
}

// --- entry point ------------------------------------------------------------

export function render(st: AppState): string {
  const sc = st.screen;
  switch (sc.name) {
    case "home":
      return renderHome(st);
    case "session": {
      const ref = st.currentRef();
      return ref ? renderSession(st, ref) : renderHome(st);
    }
    case "actions": {
      const ref = st.currentRef();
      return ref ? renderActions(st, ref) : renderHome(st);
    }
    case "reply": {
      const ref = st.currentRef();
      return ref ? renderReply(st, ref) : renderHome(st);
    }
    case "confirm": {
      const ref = st.currentRef();
      return ref ? renderConfirm(st, ref) : renderHome(st);
    }
    case "newHost":
      return renderNewHost(st);
    case "newRepo": {
      const host = st.agents.find((a) => a.key === st.newRepo.hostKey);
      return renderNewRepo(st, host?.device || st.newRepo.hostKey);
    }
  }
}
