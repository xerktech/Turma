// The controller: owns app state, turns glasses events into navigation and hub
// calls, polls the session list, and repaints. All rendering is delegated to
// the pure render() in render.ts; all I/O goes through the injected display,
// dictation, and HubClient — so this wiring is what the app IS.

import type { Agent, SessionRef } from "./types.js";
import type { GlassesDisplay, GlassesEvent } from "./display/index.js";
import type { Dictation } from "./dictation.js";
import type { HubClient } from "./hub-client.js";
import type { HubConfig } from "./config.js";
import { flattenSessions, sortSessions, findRef } from "./sessions.js";
import { render, actionsFor, onlineHosts, reposFor, type ActionId } from "./render.js";

export type ScreenName =
  | "home"
  | "session"
  | "actions"
  | "reply"
  | "confirm"
  | "newHost"
  | "newRepo";

export interface AppState {
  agents: Agent[];
  refs: SessionRef[];
  screen: { name: ScreenName };
  flash: string | null;
  focus: { hostKey: string; id: string } | null;
  home: { sel: number };
  session: { page: number };
  actions: { sel: number };
  reply: { text: string; listening: boolean; sending: boolean; error: string | null };
  confirm: { action: "kill" | "delete"; sel: number };
  newHost: { sel: number };
  newRepo: { hostKey: string; sel: number };
  currentRef(): SessionRef | undefined;
}

export class App implements AppState {
  agents: Agent[] = [];
  refs: SessionRef[] = [];
  screen: { name: ScreenName } = { name: "home" };
  flash: string | null = null;
  focus: { hostKey: string; id: string } | null = null;
  home = { sel: 0 };
  session = { page: 0 };
  actions = { sel: 0 };
  reply = { text: "", listening: false, sending: false, error: null as string | null };
  confirm = { action: "delete" as "kill" | "delete", sel: 0 };
  newHost = { sel: 0 };
  newRepo = { hostKey: "", sel: 0 };

  private paused = false;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private replyDiscard = false;

  constructor(
    private display: GlassesDisplay,
    private dictation: Dictation,
    private client: HubClient,
    private cfg: HubConfig,
  ) {}

  currentRef(): SessionRef | undefined {
    return this.focus ? findRef(this.refs, this.focus.hostKey, this.focus.id) : undefined;
  }

  async run(): Promise<void> {
    await this.display.start();
    this.display.onEvent((e) => this.onEvent(e));
    this.draw();
    await this.refresh();
    setInterval(() => {
      if (!this.paused) void this.refresh();
    }, this.cfg.pollMs);
  }

  // --- data -----------------------------------------------------------------

  async refresh(): Promise<void> {
    try {
      const { agents } = await this.client.listAgents();
      this.agents = agents;
      this.refs = sortSessions(flattenSessions(agents));
      this.clampSelections();
    } catch (e) {
      this.flashMsg(`! ${(e as Error).message}`.slice(0, 40));
    }
    this.draw();
  }

  private clampSelections(): void {
    this.home.sel = clamp(this.home.sel, 0, this.refs.length); // last = "+ New"
    // Drop into home if the focused session vanished (killed elsewhere, etc.).
    if (
      (this.screen.name === "session" ||
        this.screen.name === "actions" ||
        this.screen.name === "reply" ||
        this.screen.name === "confirm") &&
      !this.currentRef()
    ) {
      this.goHome();
    }
  }

  // --- rendering ------------------------------------------------------------

  private draw(): void {
    this.display.render(render(this));
  }

  private flashMsg(msg: string): void {
    this.flash = msg;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
      this.draw();
    }, 3000);
    this.draw();
  }

  // --- event dispatch -------------------------------------------------------

  private onEvent(e: GlassesEvent): void {
    if (e === "background") {
      this.paused = true;
      return;
    }
    if (e === "foreground") {
      this.paused = false;
      void this.refresh();
      return;
    }
    switch (this.screen.name) {
      case "home":
        return this.onHome(e);
      case "session":
        return this.onSession(e);
      case "actions":
        return this.onList(e, this.actions, actionsFor(this.currentRef()!).length, () =>
          this.runAction(actionsFor(this.currentRef()!)[this.actions.sel]),
        );
      case "reply":
        return this.onReply(e);
      case "confirm":
        return this.onConfirm(e);
      case "newHost":
        return this.onList(e, this.newHost, onlineHosts(this).length, () => this.chooseHost());
      case "newRepo":
        return this.onList(e, this.newRepo, reposFor(this, this.newRepo.hostKey).length + 1, () =>
          this.chooseRepo(),
        );
    }
  }

  // Generic up/down/select/back over a { sel } list of `count` items.
  private onList(
    e: GlassesEvent,
    box: { sel: number },
    count: number,
    onSelect: () => void,
  ): void {
    if (e === "up") box.sel = clamp(box.sel - 1, 0, count - 1);
    else if (e === "down") box.sel = clamp(box.sel + 1, 0, count - 1);
    else if (e === "select") return onSelect();
    else if (e === "back") return this.back();
    this.draw();
  }

  private onHome(e: GlassesEvent): void {
    const count = this.refs.length + 1; // +1 for "New session"
    if (e === "up") this.home.sel = clamp(this.home.sel - 1, 0, count - 1);
    else if (e === "down") this.home.sel = clamp(this.home.sel + 1, 0, count - 1);
    else if (e === "select") {
      if (this.home.sel >= this.refs.length) {
        this.screen = { name: "newHost" };
        this.newHost.sel = 0;
      } else {
        const ref = this.refs[this.home.sel];
        this.focus = { hostKey: ref.hostKey, id: ref.session.id };
        this.session.page = 0;
        this.screen = { name: "session" };
      }
    }
    this.draw();
  }

  private onSession(e: GlassesEvent): void {
    if (e === "up") this.session.page = Math.max(0, this.session.page - 1);
    else if (e === "down") this.session.page += 1; // render clamps to last page
    else if (e === "select") {
      this.actions.sel = 0;
      this.screen = { name: "actions" };
    } else if (e === "back") this.goHome();
    this.draw();
  }

  private onConfirm(e: GlassesEvent): void {
    if (e === "up" || e === "down") this.confirm.sel = this.confirm.sel === 0 ? 1 : 0;
    else if (e === "back") this.screen = { name: "actions" };
    else if (e === "select") {
      if (this.confirm.sel === 1) return this.doConfirmedAction();
      this.screen = { name: "actions" };
    }
    this.draw();
  }

  private onReply(e: GlassesEvent): void {
    if (e === "select") return void this.sendOrStop();
    if (e === "back") {
      this.replyDiscard = true;
      this.dictation.stop();
      this.screen = { name: "actions" };
      this.draw();
    }
    // up/down ignored while dictating.
  }

  // --- actions --------------------------------------------------------------

  private runAction(id: ActionId): void {
    const ref = this.currentRef();
    if (!ref) return this.goHome();
    switch (id) {
      case "back":
        this.screen = { name: "session" };
        return this.draw();
      case "reply":
        return this.openReply();
      case "delete":
        this.confirm = { action: "delete", sel: 0 };
        this.screen = { name: "confirm" };
        return this.draw();
      case "kill":
        return void this.queue(() => this.client.sessionAction(ref.hostKey, ref.session.id, "kill"), "kill");
      case "restart":
        return void this.queue(
          () => this.client.sessionAction(ref.hostKey, ref.session.id, "restart"),
          "restart",
        );
      case "start":
        return void this.queue(
          () => this.client.sessionAction(ref.hostKey, ref.session.id, "start"),
          "start",
        );
    }
  }

  private doConfirmedAction(): void {
    const ref = this.currentRef();
    if (!ref) return this.goHome();
    void this.queue(() => this.client.deleteSession(ref.hostKey, ref.session.id), "delete");
  }

  private openReply(): void {
    this.reply = { text: "", listening: false, sending: false, error: null };
    this.screen = { name: "reply" };
    this.replyDiscard = false;
    if (!this.dictation.supported()) {
      this.reply.error = "no mic/STT here";
      return this.draw();
    }
    this.reply.listening = true;
    this.draw();
    this.dictation
      .start((partial) => {
        this.reply.text = partial;
        this.draw();
      })
      .then((finalText) => {
        if (this.replyDiscard) return;
        this.reply.text = finalText;
        this.reply.listening = false;
        this.draw();
      })
      .catch((err) => {
        if (this.replyDiscard) return;
        this.reply.listening = false;
        this.reply.error = (err as Error).message.slice(0, 30);
        this.draw();
      });
  }

  private async sendOrStop(): Promise<void> {
    if (this.reply.listening) {
      this.dictation.stop(); // finalize; the promise fills reply.text
      return;
    }
    const ref = this.currentRef();
    const text = this.reply.text.trim();
    if (!ref || !text) {
      this.replyDiscard = true;
      this.screen = { name: "actions" };
      return this.draw();
    }
    this.reply.sending = true;
    this.draw();
    try {
      await this.client.sendInput(ref.hostKey, ref.session.id, text);
      this.goHome();
      this.flashMsg("✓ reply sent");
    } catch (e) {
      this.reply.sending = false;
      this.reply.error = (e as Error).message.slice(0, 30);
      this.draw();
    }
  }

  // Fire a queued hub command, flash the outcome, and go home + refresh.
  private async queue(fn: () => Promise<unknown>, label: string): Promise<void> {
    try {
      await fn();
      this.goHome();
      this.flashMsg(`✓ ${label} queued`);
      void this.refresh();
    } catch (e) {
      this.flashMsg(`! ${label}: ${(e as Error).message}`.slice(0, 40));
    }
  }

  private chooseHost(): void {
    const host = onlineHosts(this)[this.newHost.sel];
    if (!host) return;
    this.newRepo = { hostKey: host.key, sel: 0 };
    this.screen = { name: "newRepo" };
    this.draw();
  }

  private chooseRepo(): void {
    const repos = reposFor(this, this.newRepo.hostKey);
    if (this.newRepo.sel >= repos.length) {
      // "‹ back" row
      this.screen = { name: "newHost" };
      return this.draw();
    }
    const repo = repos[this.newRepo.sel];
    void this.queue(() => this.client.spawn(this.newRepo.hostKey, repo.name), `spawn ${repo.name}`);
  }

  // --- navigation helpers ---------------------------------------------------

  private back(): void {
    switch (this.screen.name) {
      case "actions":
        this.screen = { name: "session" };
        break;
      case "newRepo":
        this.screen = { name: "newHost" };
        break;
      case "newHost":
      case "session":
        this.goHome();
        break;
      default:
        this.goHome();
    }
    this.draw();
  }

  private goHome(): void {
    this.screen = { name: "home" };
    this.focus = null;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
