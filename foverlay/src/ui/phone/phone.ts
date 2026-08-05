// Native phone companion controller (XERK-171). Mounts the Sessions/Board UI
// into the phone DOM, renders from the glasses App's polled state, and drives
// everything IN-PROCESS (App.enterSession/setOrgFilter, shared HubClient). The
// session transcript is rendered through the web's OWN chat.js engine (vendored,
// see vendor/engines.ts) so it matches the web/Android exactly — full tool
// cards, thinking, code, PR/interrupt marks — fed by the phone's own rich buffer
// (history via getHistory + live deltas via App.onRichTail).
import "./phone.css";
import "../vendor/chat.css";
import "../vendor/board.css";
import type { AppState } from "../../core/app.ts";
import type { HubClient } from "../../core/hub-client.ts";
import type { TailEntry } from "../../core/types.ts";
import { siteKeyOf } from "../../core/sessions.ts";
import { phoneHtml, transcriptEntries, type PhoneTab, type PhoneView, type VerbosityPreset } from "./render.ts";
import { Board, Chat, renderTranscript, splitLabels, type BoardSite, type RichEntry, type Verbosity } from "../vendor/engines.ts";

export interface PhoneHandle {
  render(state: AppState): void;
  enterFromGlasses(hostKey: string, sessionId: string): void;
  // Wire to App.onRichTail — accumulate the focused session's live rich blocks.
  richTail(sessionId: string, entries: TailEntry[]): void;
}

// Foverlay port: upstream mounted the phone against the in-process `App`
// instance. Here the glasses App lives in the background JSContext, so the
// caller (ui/main.ts) hands in a small adapter that forwards these calls
// over the channel bus and answers getState() from the hydrated snapshot the
// background broadcasts on every repaint. Structurally identical to the
// slice of `App` this controller used upstream.
export interface PhoneAppLike {
  getState(): AppState;
  enterSession(sessionId: string, hostKeyHint?: string): void;
  setOrgFilter(siteKey: string): void;
  setAutoStartOrg(siteKey: string, enabled: boolean): void;
}

export interface MountPhoneOpts {
  root: HTMLElement;
  app: PhoneAppLike;
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
  // The open board ticket detail (its rendered HTML is cached so a poll repaint
  // re-shows it without re-fetching), or null. `edit` is which field's inline
  // picker is open (status/repo/agent/model), `body` the fetched issue.
  type DetailEdit = "" | "status" | "repo" | "agent" | "model";
  let detail: { site: string; key: string; body: Record<string, unknown> | null; edit: DetailEdit } | null = null;

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
  // NOT PORTED to the miniapp: the ttyd terminal pane needs the hub session
  // cookie planted in the WebView's own cookie jar, but all hub traffic here
  // rides the background fetch proxy (a different jar), so the iframe could
  // never authenticate. The Terminal toggle is hidden (see render.ts's
  // sessionViewHtml); view.showTerminal therefore stays false and this is
  // dead code kept for upstream diff-parity.
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
    if (drag) return; // a live board drag owns the DOM — don't yank the card
    if (view.inSession && !focused()) view.inSession = false;
    sweepMoves();

    const inp = root.querySelector<HTMLTextAreaElement>("#ph-input");
    const hadFocus = inp && document.activeElement === inp;
    const draft = inp ? inp.value : "";
    const selStart = inp ? inp.selectionStart : 0;
    const selEnd = inp ? inp.selectionEnd : 0;

    root.innerHTML = phoneHtml(last, view, orgOpen, moves);

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
    } else if (view.tab === "board") {
      if (detail) renderDetail(); // re-show the open ticket detail across the ~1s board repaint
      if (create) renderCreate(); // re-show the open create modal
    }
  }

  // ---- board ticket detail (via board.js detailHtml, editable pickers) ------
  const closeBtn = `<button class="td-close" aria-label="Close">✕</button>`;
  function boardTicket(site: string, key: string): Record<string, unknown> | undefined {
    const sites: BoardSite[] = Board.mergeSites(last.agents as unknown[]);
    const s = sites.find((x) => x.siteKey === site);
    return s?.tickets.find((t) => t.key === key) as Record<string, unknown> | undefined;
  }
  // The opts board.js's detailHtml needs to render the field pickers editable and
  // in the right editing state. Agent/model pins aren't threaded yet (the fields
  // read Auto/Default; a pick still works), so those are left undefined.
  function detailOpts(): Record<string, unknown> {
    const sites: BoardSite[] = Board.mergeSites(last.agents as unknown[]);
    const site = sites.find((s) => s.siteKey === detail!.site);
    const body = detail!.body || {};
    const hasOnline = last.agents.some((a) => a.online && siteKeyOf(a) === detail!.site);
    const statusOptions = (body.statusOptions as unknown[]) || [];
    return {
      now: last.now,
      canChangeStatus: hasOnline && statusOptions.length > 0,
      canEdit: true,
      statusOptions,
      repoOptions: site?.repoOptions || [],
      hostOptions: site?.hostOptions || [],
      models: site?.models || {},
      editing: detail!.edit === "repo",
      statusEditing: detail!.edit === "status",
      agentEditing: detail!.edit === "agent",
      modelEditing: detail!.edit === "model",
    };
  }
  function detailInner(): string {
    if (!detail) return "";
    if (!detail.body) return `${closeBtn}<div class="td-note">Loading ${detail.key}…</div>`;
    const t = boardTicket(detail.site, detail.key) ?? { key: detail.key };
    return Board.detailHtml(t, detail.body, detailOpts());
  }
  function renderDetail(): void {
    const back = root.querySelector<HTMLElement>("#ph-detail");
    const panel = root.querySelector<HTMLElement>("#ph-detail-panel");
    if (back && panel && detail) { panel.innerHTML = detailInner(); back.hidden = false; }
  }
  async function fetchDetail(site: string, key: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let res;
      try { res = await client.jiraDetail(site, key); } catch { if (detail?.key === key) { detail.body = { error: true }; renderDetail(); } return; }
      if (detail?.key !== key) return;
      if (res.status === 200) { detail.body = res.body; renderDetail(); return; }
      await new Promise((r) => setTimeout(r, 900));
    }
  }
  function openDetail(site: string, key: string): void {
    detail = { site, key, body: null, edit: "" };
    paint();
    void fetchDetail(site, key);
  }
  function closeDetail(): void { detail = null; const back = root.querySelector<HTMLElement>("#ph-detail"); if (back) back.hidden = true; }

  // ---- New ticket create flow (board.js createFormHtml, ported from the web's
  // newticket.js orchestration: org -> project -> type cascade, submit + poll) --
  interface CreateState { siteKey: string; source: string; values: Record<string, string>; meta?: Record<string, unknown>; types?: Record<string, unknown>; created?: Record<string, unknown>; busy?: boolean; error?: string; }
  let create: CreateState | null = null;
  let createSeq = 0;
  function renderCreate(): void {
    const back = root.querySelector<HTMLElement>("#ph-create");
    const panel = root.querySelector<HTMLElement>("#ph-create-panel");
    if (!back || !panel || !create) return;
    const sites: BoardSite[] = Board.mergeSites(last.agents as unknown[]);
    panel.innerHTML = Board.createFormHtml({ sites, siteKey: create.siteKey, source: create.source, values: create.values, meta: create.meta, types: create.types, created: create.created, busy: create.busy, error: create.error });
    back.hidden = false;
  }
  function syncCreate(): void {
    if (!create) return;
    const g = (sel: string): string | undefined => root.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel)?.value;
    const s = g("[data-cf-summary]"); if (s !== undefined) create.values.summary = s;
    const d = g("[data-cf-desc]"); if (d !== undefined) create.values.description = d;
    const l = g("[data-cf-labels]"); if (l !== undefined) create.values.labels = l;
  }
  async function loadMeta(): Promise<void> {
    const seq = ++createSeq, site = create!.siteKey;
    const alive = (): boolean => createSeq === seq && create?.siteKey === site;
    create!.meta = {}; renderCreate();
    for (let i = 0; i < 20 && alive(); i++) {
      let res; try { res = await client.createMeta(site); } catch (e) { if (alive()) { create!.meta = { error: (e as Error).message }; renderCreate(); } return; }
      if (!alive()) return;
      if (res.status === 200) {
        const d = res.body as { projects?: { key: string }[]; labels?: unknown[]; source?: string };
        create!.meta = { projects: d.projects || [], labels: d.labels || [] };
        if (d.source) create!.source = d.source;
        if ((d.projects || []).length === 1) { create!.values.project = d.projects![0]!.key; renderCreate(); return void loadTypes(); }
        renderCreate(); return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  async function loadTypes(): Promise<void> {
    const project = create!.values.project; if (!project) return;
    const seq = ++createSeq, site = create!.siteKey;
    const alive = (): boolean => createSeq === seq && create?.siteKey === site && create?.values.project === project;
    create!.types = {}; renderCreate();
    for (let i = 0; i < 20 && alive(); i++) {
      let res; try { res = await client.createMeta(site, project); } catch (e) { if (alive()) { create!.types = { error: (e as Error).message }; renderCreate(); } return; }
      if (!alive()) return;
      if (res.status === 200) {
        const d = res.body as { types?: { id: string }[] };
        const types = d.types || [];
        create!.types = { types };
        if (types.length === 1) create!.values.issueType = types[0]!.id;
        renderCreate(); return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  async function submitCreate(): Promise<void> {
    const s = create; if (!s || s.busy) return;
    syncCreate();
    const v = s.values;
    if (!v.project || !v.issueType || !(v.summary || "").trim()) return;
    s.busy = true; s.error = ""; renderCreate();
    const labels = splitLabels(v.labels, s.source);
    let cmd; try { cmd = await client.createTicket(s.siteKey, { project: v.project, issueType: v.issueType, summary: (v.summary || "").trim(), description: v.description, labels }); }
    catch (e) { if (create === s) { s.busy = false; s.error = (e as Error).message; renderCreate(); } return; }
    for (let i = 0; i < 40 && create === s; i++) {
      let res; try { res = await client.createResult(s.siteKey, cmd.cmdId); } catch (e) { if (create === s) { s.busy = false; s.error = (e as Error).message; renderCreate(); } return; }
      if (create !== s) return;
      if (res.status === 200) {
        const d = res.body as { key?: string; url?: string; error?: string; warning?: string };
        s.busy = false;
        if (d.error) { s.error = d.error; renderCreate(); return; }
        s.created = { key: d.key, url: d.url, warning: d.warning || "" };
        renderCreate(); return;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (create === s) { s.busy = false; s.error = "the create didn't complete in time"; renderCreate(); }
  }
  function openCreate(): void {
    const sites: BoardSite[] = Board.mergeSites(last.agents as unknown[]);
    const first = sites.find((s) => s.siteKey === last.orgFilter) || sites[0];
    if (!first) return;
    create = { siteKey: first.siteKey, source: (first.source as string) || "jira", values: {} };
    paint();
    void loadMeta();
  }
  function closeCreate(): void { create = null; const back = root.querySelector<HTMLElement>("#ph-create"); if (back) back.hidden = true; }

  // ---- board drag-drop (move a ticket's status between columns) -------------
  // Optimistic-move overrides keyed "<site>\x00<key>", held until the poll
  // reflects the move (moveSweepVerdict), passed to boardHtml so the card stays
  // in its dropped column meanwhile. A long-press starts the drag (a plain drag
  // is a scroll); the ghost lives on <body> and paint() skips repaints while a
  // drag is live, so the card isn't yanked from under the finger.
  interface MoveOverride { category: string; pending?: boolean; settled?: boolean; settledAt?: number; error?: boolean; at: number; }
  const moves = new Map<string, MoveOverride>();
  const moveKey = (site: string, key: string): string => `${site}\x00${key}`;
  let press: { card: HTMLElement; site: string; key: string; srcCat: string; x: number; y: number } | null = null;
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let drag: { site: string; key: string; srcCat: string; ghost: HTMLElement; overCat: string | null } | null = null;
  let suppressClick = false;

  function sweepMoves(): void {
    if (!moves.size) return;
    const sites: BoardSite[] = Board.mergeSites(last.agents as unknown[]);
    const byKey = new Map<string, unknown>();
    for (const s of sites) for (const t of s.tickets) byKey.set(moveKey(s.siteKey, t.key), t);
    const now = Date.now();
    for (const [k, move] of [...moves]) {
      const t = byKey.get(k);
      const realCat = t ? String(Board.categoryOf(t)) : move.category;
      if (Board.moveSweepVerdict(move, realCat, now, 12000, 6000) === "clear") moves.delete(k);
    }
  }
  function moveTo(site: string, key: string, category: string): void {
    const k = moveKey(site, key);
    moves.set(k, { category, pending: true, at: Date.now() });
    paint();
    void client.setTicketStatus(site, key, { category })
      .then(() => { const m = moves.get(k); if (m) { m.pending = false; m.settled = true; m.settledAt = Date.now(); } void client.jiraRefresh().catch(() => {}); })
      .catch(() => { const m = moves.get(k); if (m) { m.error = true; m.at = Date.now(); } });
  }
  function endDrag(dropCat: string | null): void {
    if (!drag) return;
    drag.ghost.remove();
    root.querySelectorAll(".kc-drop-into").forEach((el) => el.classList.remove("kc-drop-into"));
    const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(drag.key) : drag.key.replace(/["\\]/g, "\\$&");
    root.querySelector(`.kanban-card[data-key="${esc}"]`)?.classList.remove("kc-drag-src");
    const { site, key, srcCat } = drag;
    drag = null;
    if (dropCat && dropCat !== srcCat) { suppressClick = true; moveTo(site, key, dropCat); }
    else paint();
  }
  // A field picker's <select> changed — decode to the POST body (board.html's
  // rules), fire the write, close the picker, and re-fetch to show the result.
  function savePicker(field: DetailEdit, value: string): void {
    if (!detail) return;
    const { site, key } = detail;
    if (field === "status") { if (value !== "__keep__") void client.setTicketStatus(site, key, { value }).catch(() => {}); }
    else if (field === "repo") void client.setTicketRepo(site, key, value === "__auto__" ? { auto: true } : value === "__none__" ? { repo: null } : { repo: value }).catch(() => {});
    else if (field === "agent") void client.setTicketAgent(site, key, value === "__auto__" ? { auto: true } : { host: value }).catch(() => {});
    else if (field === "model") void client.setTicketModel(site, key, value === "__default__" ? { auto: true } : { model: value }).catch(() => {});
    detail.edit = "";
    renderDetail();
    setTimeout(() => { if (detail?.key === key) void fetchDetail(site, key); }, 1200);
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

    // Code-block copy button (XERK-183) — the web's own handler, reused verbatim.
    if (Chat.copyCodeClick(e)) return;

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
    const cancel = t.closest<HTMLElement>("[data-cancel]");
    if (cancel) { void client.sessionAction(cancel.dataset.host!, cancel.dataset.cancel!, "kill").catch(() => {}); return; }
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
    // Per-org auto-start toggle (XERK-41): flip optimistically, POST, roll back
    // on failure. The menu stays OPEN so several orgs can be toggled in a row.
    const orgAuto = t.closest<HTMLElement>("[data-org-auto]");
    if (orgAuto) {
      const site = orgAuto.dataset.orgAuto || "";
      if (site) {
        const enabled = !last.autoStartOrgs[site];
        app.setAutoStartOrg(site, enabled);
        void client.setAutoStart(site, enabled).catch(() => app.setAutoStartOrg(site, !enabled));
      }
      return;
    }
    const org = t.closest<HTMLElement>("[data-org]");
    if (org) { app.setOrgFilter(org.dataset.org || ""); orgOpen = false; paint(); return; }
    const answer = t.closest<HTMLElement>("[data-answer]");
    if (answer) { const f = focused(); if (f) void client.answerQuestion(f.host, f.id, { optionIndex: Number(answer.dataset.answer) }).catch(() => {}); return; }
    if (t.closest("[data-send]")) { send(); return; }
    if (t.closest("[data-signout]")) { onSignOut?.(); return; }

    // ---- board ----
    if (t.closest("[data-board-refresh]")) { void client.jiraRefresh().catch(() => {}); return; }
    // New ticket create modal.
    if (t.closest("[data-new-ticket]")) { openCreate(); return; }
    if (t.closest("[data-cf-close]")) { closeCreate(); return; }
    if (t.closest("[data-cf-submit]")) { void submitCreate(); return; }
    if (t.closest("[data-cf-another]") && create) { create.created = undefined; create.values = {}; renderCreate(); void loadMeta(); return; }
    if (t.closest("#ph-create") && !t.closest("#ph-create-panel")) { closeCreate(); return; } // backdrop
    const start = t.closest<HTMLElement>(".kc-start[data-start]");
    if (start) {
      const key = start.dataset.start!;
      const site = start.closest<HTMLElement>("[data-site]")?.dataset.site || t.closest<HTMLElement>("[data-key]")?.dataset.site;
      if (site) void client.startTicket(site, key).catch(() => {});
      return;
    }
    const sessLink = t.closest<HTMLAnchorElement>("a.kc-sess");
    if (sessLink) {
      e.preventDefault();
      const m = (sessLink.getAttribute("href") || "").match(/[?&]session=([^&]+)/);
      if (m) { app.enterSession(decodeURIComponent(m[1]!)); view.tab = "sessions"; view.inSession = true; closeDetail(); paint(); }
      return;
    }
    if (t.closest(".td-close")) { closeDetail(); paint(); return; }
    if (t.closest("#ph-detail") && !t.closest("#ph-detail-panel")) { closeDetail(); paint(); return; } // backdrop
    // Detail-panel field pickers: Change opens the inline <select>, Cancel closes.
    const editBtn = t.closest<HTMLElement>("[data-status-edit],[data-repo-edit],[data-agent-edit],[data-model-edit]");
    if (editBtn && detail) {
      detail.edit = editBtn.hasAttribute("data-status-edit") ? "status" : editBtn.hasAttribute("data-repo-edit") ? "repo" : editBtn.hasAttribute("data-agent-edit") ? "agent" : "model";
      renderDetail(); return;
    }
    if (t.closest("[data-status-cancel],[data-repo-cancel],[data-agent-cancel],[data-model-cancel]") && detail) { detail.edit = ""; renderDetail(); return; }
    const card = t.closest<HTMLElement>(".kanban-card[data-key]");
    if (card && view.tab === "board") {
      if (suppressClick) { suppressClick = false; return; } // the click a just-completed drag synthesizes
      openDetail(card.dataset.site || "", card.dataset.key!);
      return;
    }

    if (orgOpen && !t.closest(".ph-org")) { orgOpen = false; paint(); return; }
    if (view.menu !== "closed" && !t.closest(".ph-kebab-wrap")) { view.menu = "closed"; paint(); }
  });

  root.addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "ph-input") { autoGrow(el as HTMLTextAreaElement); return; }
    // Create-modal text fields: sync into state + toggle the submit button live
    // (no re-render, so typing keeps focus), like the web's newticket.js.
    if (create && el.closest?.("[data-cf-summary],[data-cf-desc],[data-cf-labels]")) {
      syncCreate();
      const btn = root.querySelector<HTMLButtonElement>("[data-cf-submit]");
        const v = create.values;
      if (btn) btn.disabled = !(v.project && v.issueType && (v.summary || "").trim()) || !!create.busy;
    }
  });
  // A detail-panel picker <select> changed → save it (picking IS the save, the
  // web's contract). Each option's value is decoded to the POST body in savePicker.
  root.addEventListener("change", (e) => {
    const el = e.target as HTMLElement;
    // Create-modal cascade selects.
    if (create) {
      const org = el.closest?.("[data-cf-org]") as HTMLSelectElement | null;
      if (org) { create.siteKey = org.value; create.values = {}; create.types = undefined; void loadMeta(); return; }
      const proj = el.closest?.("[data-cf-project]") as HTMLSelectElement | null;
      if (proj) { create.values.project = proj.value; create.values.issueType = ""; void loadTypes(); return; }
      const typ = el.closest?.("[data-cf-type]") as HTMLSelectElement | null;
      if (typ) { create.values.issueType = typ.value; return; }
    }
    // Detail-panel field pickers.
    if (!detail) return;
    const map: [string, DetailEdit][] = [["data-status-select", "status"], ["data-repo-select", "repo"], ["data-agent-select", "agent"], ["data-model-select", "model"]];
    for (const [attr, field] of map) {
      const sel = el.closest?.(`[${attr}]`) as HTMLSelectElement | null;
      if (sel) { savePicker(field, sel.value); return; }
    }
  });
  root.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement;
    if (el.id === "ph-input" && (e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // ---- board drag-drop pointer gestures ----
  function positionGhost(g: HTMLElement, x: number, y: number): void { g.style.left = `${x}px`; g.style.top = `${y - 14}px`; }
  function columnAt(x: number, y: number): { el: HTMLElement | null; cat: string | null } {
    const under = document.elementFromPoint(x, y) as HTMLElement | null;
    const col = under?.closest<HTMLElement>("[data-cat]") || null;
    return { el: col, cat: col?.dataset.cat || null };
  }
  root.addEventListener("pointerdown", (e) => {
    if (view.tab !== "board" || view.inSession || drag) return;
    const pe = e as PointerEvent;
    const card = (e.target as HTMLElement).closest<HTMLElement>(".kanban-card[data-key]");
    if (!card || (e.target as HTMLElement).closest("a,button,select")) return; // let links/chips work
    const srcCat = card.closest<HTMLElement>("[data-cat]")?.dataset.cat || "";
    press = { card, site: card.dataset.site || "", key: card.dataset.key!, srcCat, x: pe.clientX, y: pe.clientY };
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (!press) return;
      const ghost = press.card.cloneNode(true) as HTMLElement;
      ghost.classList.add("kc-ghost");
      ghost.style.width = `${press.card.offsetWidth}px`;
      document.body.appendChild(ghost);
      positionGhost(ghost, press.x, press.y);
      press.card.classList.add("kc-drag-src");
      drag = { site: press.site, key: press.key, srcCat: press.srcCat, ghost, overCat: null };
    }, 220);
  });
  root.addEventListener("pointermove", (e) => {
    const pe = e as PointerEvent;
    if (drag) {
      pe.preventDefault();
      positionGhost(drag.ghost, pe.clientX, pe.clientY);
      const { el, cat } = columnAt(pe.clientX, pe.clientY);
      if (cat !== drag.overCat) {
        root.querySelectorAll(".kc-drop-into").forEach((n) => n.classList.remove("kc-drop-into"));
        if (el && cat && cat !== drag.srcCat) el.classList.add("kc-drop-into");
        drag.overCat = cat;
      }
      return;
    }
    // Not yet dragging: a move beyond a small threshold is a scroll — cancel the long-press.
    if (press && pressTimer && (Math.abs(pe.clientX - press.x) > 10 || Math.abs(pe.clientY - press.y) > 10)) {
      clearTimeout(pressTimer); pressTimer = null; press = null;
    }
  }, { passive: false });
  function releasePointer(e: Event): void {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (drag) { const pe = e as PointerEvent; endDrag(columnAt(pe.clientX, pe.clientY).cat); }
    press = null;
  }
  root.addEventListener("pointerup", releasePointer);
  root.addEventListener("pointercancel", () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } if (drag) endDrag(null); press = null; });

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
