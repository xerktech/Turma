// Native phone companion controller (XERK-171). Mounts the Sessions/Board UI
// into the phone DOM, renders from the glasses App's polled state (via
// App.onState), and drives everything IN-PROCESS: a tap calls App.enterSession
// directly (so the glasses enter it too), the org filter calls App.setOrgFilter
// (so the glasses list narrows), and prompts/answers go straight through the
// shared HubClient. No iframe, no postMessage — the thing the cross-origin
// bridge could never do reliably.
import "./phone.css";
import type { App, AppState } from "../app.ts";
import type { HubClient } from "../hub-client.ts";
import { phoneHtml, type PhoneTab, type PhoneView } from "./render.ts";

export interface PhoneHandle {
  // Wire to App.onState — repaints the phone from the fresh state.
  render(state: AppState): void;
  // Wire to App.onEnterSession — the glasses entered a session, so pull the
  // phone's view into it too (idempotent when the phone drove the enter).
  enterFromGlasses(hostKey: string, sessionId: string): void;
}

export interface MountPhoneOpts {
  root: HTMLElement;
  app: App;
  client: HubClient;
  onSignOut?: () => void;
}

export function mountPhone({ root, app, client, onSignOut }: MountPhoneOpts): PhoneHandle {
  const view: PhoneView = { tab: "sessions", inSession: false };
  let orgOpen = false;
  let last: AppState = app.getState();

  function focused(): { host: string; id: string } | null {
    const st = last;
    if (st.screen === "session" && st.session) return { host: st.session.hostKey, id: st.session.sessionId };
    return null;
  }

  // Re-render, preserving the transcript scroll position and the compose box's
  // in-progress text/selection/focus across the innerHTML swap — the ~1s poll
  // (and every live-tail burst) repaints, and without this it would wipe what
  // the user is typing and throw the transcript back to the top.
  function paint(): void {
    // The phone's session view mirrors the App's focused session. If the glasses
    // left it (focus gone), drop back to the list rather than show a dead view.
    if (view.inSession && !focused()) view.inSession = false;

    const inp = root.querySelector<HTMLTextAreaElement>("#ph-input");
    const hadFocus = inp && document.activeElement === inp;
    const draft = inp ? inp.value : "";
    const selStart = inp ? inp.selectionStart : 0;
    const selEnd = inp ? inp.selectionEnd : 0;
    const scroller = root.querySelector<HTMLElement>("#ph-transcript");
    const atBottom = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40
      : true;
    const scrollTop = scroller ? scroller.scrollTop : 0;

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
    const scroller2 = root.querySelector<HTMLElement>("#ph-transcript");
    if (scroller2) scroller2.scrollTop = atBottom ? scroller2.scrollHeight : scrollTop;
  }

  function autoGrow(el: HTMLTextAreaElement): void {
    if (el.offsetParent === null) return; // not laid out — leave last height
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  // ---- events (delegated; the markup is replaced every repaint) ------------
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    const enter = t.closest<HTMLElement>("[data-enter]");
    if (enter) {
      const id = enter.dataset.enter!;
      const host = enter.dataset.host;
      app.enterSession(id, host); // drives the glasses in-process
      view.inSession = true;
      paint();
      return;
    }
    const tab = t.closest<HTMLElement>("[data-tab]");
    if (tab) {
      view.tab = tab.dataset.tab as PhoneTab;
      view.inSession = false;
      orgOpen = false;
      paint();
      return;
    }
    if (t.closest("[data-back]")) {
      // Leaving on the phone must NOT move the glasses (XERK-171) — just hide the
      // phone's own session view.
      view.inSession = false;
      paint();
      return;
    }
    if (t.closest("[data-org-toggle]")) {
      orgOpen = !orgOpen;
      paint();
      return;
    }
    const org = t.closest<HTMLElement>("[data-org]");
    if (org) {
      app.setOrgFilter(org.dataset.org || ""); // scopes the glasses list too
      orgOpen = false;
      paint();
      return;
    }
    const answer = t.closest<HTMLElement>("[data-answer]");
    if (answer) {
      const f = focused();
      if (f) void client.answerQuestion(f.host, f.id, { optionIndex: Number(answer.dataset.answer) }).catch(() => {});
      return;
    }
    if (t.closest("[data-send]")) {
      send();
      return;
    }
    if (t.closest("[data-signout]")) {
      onSignOut?.();
      return;
    }
    // A click anywhere else closes an open org menu.
    if (orgOpen && !t.closest(".ph-org")) { orgOpen = false; paint(); }
  });

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "ph-input") autoGrow(el as HTMLTextAreaElement);
  });

  // Enter sends (Shift+Enter newlines), like the web compose.
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
    void client.sendInput(f.host, f.id, text).catch(() => {});
  }

  const handle: PhoneHandle = {
    render(state: AppState): void {
      last = state;
      paint();
    },
    enterFromGlasses(_hostKey: string, _sessionId: string): void {
      // The glasses entered a session — pull the phone's view into it. Idempotent
      // when the phone itself drove the enter (inSession already true).
      view.inSession = true;
      paint();
    },
  };

  paint();
  return handle;
}
