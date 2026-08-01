// Native phone companion controller (XERK-171). Mounts the Sessions/Board UI
// into the phone DOM, renders from the glasses App's polled state, and drives
// everything IN-PROCESS (App.enterSession/setOrgFilter, shared HubClient). The
// session transcript is rendered through the web's OWN chat.js engine (vendored,
// see vendor/engines.ts) so it matches the web/Android exactly — full tool
// cards, thinking, code, PR/interrupt marks — fed by the phone's own rich buffer
// (history via getHistory + live deltas via App.onRichTail).
import "./phone.css";
import "../vendor/chat.css";
import type { App, AppState } from "../app.ts";
import type { HubClient } from "../hub-client.ts";
import type { TailEntry } from "../types.ts";
import { phoneHtml, transcriptEntries, type PhoneTab, type PhoneView, type VerbosityPreset } from "./render.ts";
import { Chat, renderTranscript, type RichEntry, type Verbosity } from "../vendor/engines.ts";

export interface PhoneHandle {
  render(state: AppState): void;
  enterFromGlasses(hostKey: string, sessionId: string): void;
  // Wire to App.onRichTail — accumulate the focused session's live rich blocks.
  richTail(sessionId: string, entries: TailEntry[]): void;
}

export interface MountPhoneOpts {
  root: HTMLElement;
  app: App;
  client: HubClient;
  onSignOut?: () => void;
}

const VERB_SHOW: Record<VerbosityPreset, Verbosity> = {
  concise: { preset: "concise", show: { thinking: false, tools: false, outputs: false } },
  normal: { preset: "normal", show: { thinking: false, tools: true, outputs: false } },
  verbose: { preset: "verbose", show: { thinking: true, tools: true, outputs: true } },
};

export function mountPhone({ root, app, client, onSignOut }: MountPhoneOpts): PhoneHandle {
  const view: PhoneView = { tab: "sessions", inSession: false, verbosity: "normal", showTerminal: false, menu: "closed" };
  let orgOpen = false;
  let last: AppState = app.getState();

  // Per-session rich transcript buffer (history + live, blocks intact), merged
  // with the web's own mergeTail so it accumulates exactly as the web does.
  const buffers = new Map<string, RichEntry[]>();
  const historyDone = new Set<string>();
  const termPlanted = new Set<string>();

  function focused(): { host: string; id: string } | null {
    if (last.screen === "session" && last.session) return { host: last.session.hostKey, id: last.session.sessionId };
    return null;
  }

  // ---- transcript ----------------------------------------------------------
  function fillTranscript(): void {
    const f = focused();
    const scroller = root.querySelector<HTMLElement>("#ph-transcript");
    if (!f || !scroller) return;
    const entries = transcriptEntries((buffers.get(f.id) as RichEntry[]) ?? [], last.liveTurn, f.id) as RichEntry[];
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    scroller.innerHTML = entries.length
      ? renderTranscript(entries, VERB_SHOW[view.verbosity])
      : `<div class="ph-empty">No messages yet. Say something below to get the agent going.</div>`;
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  async function ensureHistory(host: string, id: string): Promise<void> {
    if (historyDone.has(id)) return;
    historyDone.add(id);
    for (let attempt = 0; attempt < 8; attempt++) {
      let res;
      try {
        res = await client.getHistory(host, id);
      } catch {
        historyDone.delete(id); // let a later open retry
        return;
      }
      if (res.status === 200) {
        const merged = mergeInto(id, res.body.entries as RichEntry[]);
        buffers.set(id, merged);
        if (focused()?.id === id) fillTranscript();
        return;
      }
      // 202 pending — the agent is fetching; wait and retry.
      await new Promise((r) => setTimeout(r, 900));
      if (focused()?.id !== id) return; // left the session
    }
  }

  function mergeInto(id: string, incoming: RichEntry[]): RichEntry[] {
    const existing = buffers.get(id) ?? [];
    // The web's own transcript merge (id-keyed, richer copy wins).
    // engines.renderTranscript uses chat.js; reuse its mergeTail via the module.
    return mergeTail(existing, incoming);
  }

  // ---- terminal ------------------------------------------------------------
  async function ensureTerminal(): Promise<void> {
    const f = focused();
    if (!f || !view.showTerminal || termPlanted.has(f.id)) return;
    const frame = root.querySelector<HTMLIFrameElement>("#ph-term");
    if (!frame) return;
    termPlanted.add(f.id);
    await client.loginForCookie(); // plant the hub session cookie for the iframe
    frame.src = client.termUrl(f.id);
  }

  // ---- paint ---------------------------------------------------------------
  function paint(): void {
    if (view.inSession && !focused()) view.inSession = false;

    const inp = root.querySelector<HTMLTextAreaElement>("#ph-input");
    const hadFocus = inp && document.activeElement === inp;
    const draft = inp ? inp.value : "";
    const selStart = inp ? inp.selectionStart : 0;
    const selEnd = inp ? inp.selectionEnd : 0;

    root.innerHTML = phoneHtml(last, view, orgOpen);

    const inp2 = root.querySelector<HTMLTextAreaElement>("#ph-input");
    if (inp2) {
      inp2.value = draft;
      if (hadFocus) {
        inp2.focus();
        try { inp2.setSelectionRange(selStart, selEnd); } catch { /* detached */ }
      }
      autoGrow(inp2);
    }
    if (view.inSession) {
      fillTranscript();
      void ensureTerminal();
      updateStop();
    }
  }

  function updateStop(): void {
    // Show Stop while the focused session is working (paneBusy), like the web.
    const f = focused();
    const stop = root.querySelector<HTMLElement>("[data-stop]");
    if (!stop) return;
    const live = f && last.agents.find((a) => a.key === f.host)?.sessions.find((s) => s.id === f.id);
    const busy = !!live?.session?.paneBusy && !live?.session?.question;
    stop.hidden = !busy;
  }

  function autoGrow(el: HTMLTextAreaElement): void {
    if (el.offsetParent === null) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  // ---- events --------------------------------------------------------------
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const enter = t.closest<HTMLElement>("[data-enter]");
    if (enter) {
      const id = enter.dataset.enter!;
      const host = enter.dataset.host;
      app.enterSession(id, host);
      view.inSession = true;
      view.showTerminal = false;
      view.menu = "closed";
      paint();
      if (host) void ensureHistory(host, id);
      return;
    }
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) { view.tab = tab.dataset.tab as PhoneTab; view.inSession = false; orgOpen = false; paint(); return; }
    if (t.closest("[data-back]")) { view.inSession = false; view.menu = "closed"; paint(); return; }
    if (t.closest("[data-term-toggle]")) { view.showTerminal = !view.showTerminal; paint(); return; }
    const verb = t.closest<HTMLElement>("[data-verb]");
    if (verb) { view.verbosity = verb.dataset.verb as VerbosityPreset; paint(); return; }
    if (t.closest("[data-stop]")) { const f = focused(); if (f) void client.interrupt(f.host, f.id).catch(() => {}); return; }
    // ⋯ session actions menu (Rename / Kill).
    if (t.closest("[data-sess-menu]")) { view.menu = view.menu === "closed" ? "open" : "closed"; paint(); return; }
    if (t.closest("[data-menu-rename]")) { view.menu = "renaming"; paint(); const r = root.querySelector<HTMLInputElement>("#ph-rename"); if (r) { r.focus(); r.select(); } return; }
    if (t.closest("[data-menu-cancel]")) { view.menu = "closed"; paint(); return; }
    if (t.closest("[data-menu-save]")) {
      const f = focused();
      const r = root.querySelector<HTMLInputElement>("#ph-rename");
      if (f && r) void client.setSummary(f.host, f.id, r.value.trim()).catch(() => {});
      view.menu = "closed"; paint(); return;
    }
    if (t.closest("[data-menu-kill]")) { view.menu = "killArm"; paint(); return; }
    if (t.closest("[data-menu-kill-confirm]")) {
      const f = focused();
      if (f) void client.sessionAction(f.host, f.id, "kill").catch(() => {});
      view.menu = "closed"; view.inSession = false; paint(); return;
    }
    if (t.closest("[data-org-toggle]")) { orgOpen = !orgOpen; paint(); return; }
    const org = t.closest<HTMLElement>("[data-org]");
    if (org) { app.setOrgFilter(org.dataset.org || ""); orgOpen = false; paint(); return; }
    const answer = t.closest<HTMLElement>("[data-answer]");
    if (answer) { const f = focused(); if (f) void client.answerQuestion(f.host, f.id, { optionIndex: Number(answer.dataset.answer) }).catch(() => {}); return; }
    if (t.closest("[data-send]")) { send(); return; }
    if (t.closest("[data-signout]")) { onSignOut?.(); return; }
    if (orgOpen && !t.closest(".ph-org")) { orgOpen = false; paint(); return; }
    if (view.menu !== "closed" && !t.closest(".ph-kebab-wrap")) { view.menu = "closed"; paint(); }
  });

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "ph-input") autoGrow(el as HTMLTextAreaElement);
  });
  root.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "ph-input" && (e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function send(): void {
    const inp = root.querySelector<HTMLTextAreaElement>("#ph-input");
    const f = focused();
    if (!inp || !f) return;
    const text = inp.value.trim();
    if (!text) return;
    inp.value = "";
    autoGrow(inp);
    // A pending question answers through /answer; otherwise /input.
    const live = last.agents.find((a) => a.key === f.host)?.sessions.find((s) => s.id === f.id);
    if (live?.session?.question) void client.answerQuestion(f.host, f.id, { optionIndex: -1, custom: text }).catch(() => {});
    else void client.sendInput(f.host, f.id, text).catch(() => {});
  }

  const handle: PhoneHandle = {
    render(state: AppState): void {
      last = state;
      paint();
    },
    enterFromGlasses(hostKey: string, sessionId: string): void {
      view.inSession = true;
      paint();
      void ensureHistory(hostKey, sessionId);
    },
    richTail(sessionId: string, entries: TailEntry[]): void {
      buffers.set(sessionId, mergeInto(sessionId, entries as RichEntry[]));
      if (focused()?.id === sessionId && view.inSession) fillTranscript();
    },
  };

  paint();
  return handle;
}

// The web's transcript merge (id-keyed, richer copy wins) from the vendored engine.
function mergeTail(existing: RichEntry[], incoming: RichEntry[]): RichEntry[] {
  return Chat.mergeTail(existing, incoming);
}
