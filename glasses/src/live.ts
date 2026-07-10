// Live transcript tail over a WebSocket — the near-real-time path the session
// screen uses while it's open. The 6s poll (app.ts) only ever sees the
// agent's 20s heartbeat, so on its own new text lands up to ~20s late and in
// whole blocks. This opens `/live/<host>/<session>?auth=<ws-token>` on the
// hub (agent-hub/server.js), which asks that host's tunnel-agent to tail the
// one session's transcript ~1s and push deltas back; each `{type:"tail",
// entries}` frame is handed straight to the App, which merges it (mergeTail)
// and typewriter-reveals the growth (reveal.ts).
//
// Purely additive: if the socket never connects (agent tunnel offline, dev
// mock hub with no /live route) the App still runs on the poll — live tail is
// an enhancement, never a dependency. It reconnects with capped backoff while
// a session is being watched and goes fully quiet once stop() is called.
//
// Same injectable shape as audio.ts (structural WebSocket, no SDK import), so
// vitest drives it with a fake socket.

import type { HubClient } from "./hub-client.ts";
import type { WebSocketCtor, WebSocketEvent, WebSocketLike } from "./audio.ts";
import type { TailEntry } from "./types.ts";

export type TailListener = (entries: TailEntry[]) => void;

export interface LiveTailLike {
  start(hostKey: string, sessionId: string, onTail: TailListener): void;
  stop(): void;
}

// A no-op used wherever a live tail isn't wired (existing tests, the poll-only
// fallback). Keeps App's dependency non-optional at the call sites.
export class NoopLiveTail implements LiveTailLike {
  start(_hostKey: string, _sessionId: string, _onTail: TailListener): void {}
  stop(): void {}
}

// https -> wss, http -> ws (the plain-ws scheme is the deliberate dev/LAN
// fallback for a non-TLS hub, mirroring dictation.ts's buildAudioWsUrl).
export function buildLiveWsUrl(
  hubUrl: string,
  hostKey: string,
  sessionId: string,
  token: string
): string {
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  const wsBase = hubUrl.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://").replace(/\/$/, "");
  return (
    `${wsBase}/live/${encodeURIComponent(hostKey)}/${encodeURIComponent(sessionId)}` +
    `?auth=${encodeURIComponent(token)}`
  );
}

export interface LiveTailOptions {
  hubClient: Pick<HubClient, "wsToken">;
  hubUrl: string;
  WebSocket?: WebSocketCtor;
  now?: () => number;
  /** Reconnect backoff schedule override (tests). */
  backoffMs?: number[];
  /** Injectable timer (tests). Defaults to setTimeout. */
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

interface TailFrame {
  type: "tail";
  entries?: TailEntry[];
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export class LiveTail implements LiveTailLike {
  private readonly hubClient: Pick<HubClient, "wsToken">;
  private readonly hubUrl: string;
  private readonly wsCtor: WebSocketCtor | undefined;
  private readonly backoffMs: number[];
  private readonly setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;

  // Bumped on every start()/stop(); every async continuation re-checks it so a
  // stop() (or a newer start()) that lands mid-connect can't resurrect a dead
  // socket or deliver to the wrong session.
  private generation = 0;
  private ws: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  private hostKey = "";
  private sessionId = "";
  private onTail: TailListener | null = null;

  constructor(opts: LiveTailOptions) {
    this.hubClient = opts.hubClient;
    this.hubUrl = opts.hubUrl;
    this.wsCtor =
      opts.WebSocket ?? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket as WebSocketCtor | undefined);
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  }

  start(hostKey: string, sessionId: string, onTail: TailListener): void {
    // A start() for the session we're already streaming is a no-op — don't
    // tear down a healthy socket just because the screen re-entered.
    if (this.onTail && this.hostKey === hostKey && this.sessionId === sessionId) {
      this.onTail = onTail;
      return;
    }
    this.teardown();
    this.hostKey = hostKey;
    this.sessionId = sessionId;
    this.onTail = onTail;
    this.attempt = 0;
    const gen = ++this.generation;
    void this.connect(gen);
  }

  stop(): void {
    this.generation++;
    this.onTail = null;
    this.teardown();
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore — peer may have already dropped
      }
    }
  }

  private async connect(gen: number): Promise<void> {
    const Ctor = this.wsCtor;
    if (!Ctor) return; // no WebSocket available (unusual) — poll-only, silently
    let token: string;
    try {
      token = (await this.hubClient.wsToken()).token;
    } catch {
      if (gen === this.generation) this.scheduleReconnect(gen);
      return;
    }
    if (gen !== this.generation) return; // stop()/newer start() landed mid-fetch

    const url = buildLiveWsUrl(this.hubUrl, this.hostKey, this.sessionId, token);
    let ws: WebSocketLike;
    try {
      ws = new Ctor(url);
    } catch {
      this.scheduleReconnect(gen);
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (gen === this.generation) this.attempt = 0; // healthy — reset backoff
    });
    ws.addEventListener("message", (ev: WebSocketEvent) => {
      if (gen !== this.generation) return;
      if (typeof ev.data !== "string") return;
      let frame: TailFrame;
      try {
        frame = JSON.parse(ev.data) as TailFrame;
      } catch {
        return;
      }
      if (frame?.type === "tail" && Array.isArray(frame.entries) && frame.entries.length) {
        this.onTail?.(frame.entries);
      }
    });
    const onEnd = (): void => {
      if (gen !== this.generation) return; // superseded — teardown() handles it
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect(gen);
    };
    ws.addEventListener("close", onEnd);
    ws.addEventListener("error", onEnd);
  }

  private scheduleReconnect(gen: number): void {
    if (gen !== this.generation) return;
    if (this.reconnectTimer) return;
    const wait = this.backoffMs[Math.min(this.attempt, this.backoffMs.length - 1)] ?? 1000;
    this.attempt++;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (gen !== this.generation) return;
      void this.connect(gen);
    }, wait);
  }
}
