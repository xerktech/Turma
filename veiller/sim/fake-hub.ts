/**
 * A Turma hub that answers the miniapp for real, but takes its cues from the
 * test.
 *
 * The miniapp's whole world is the hub: the fleet it lists, the transcript it
 * streams, the question it must answer, the dictation it sends its microphone
 * to. So a walkthrough needs a hub that speaks the actual contract —
 * `turma/server.js`'s routes, envelopes and status codes, including the 202
 * "still fetching" history reply and the `/live` + `/audio` WebSockets — while
 * letting the script decide *when* a question arrives or a turn streams in.
 *
 * Everything the miniapp POSTs is recorded in `calls`, so a step can assert
 * that a tap actually reached the endpoint the web UI would have hit.
 */

import type { Server, ServerWebSocket } from "bun";

export interface HubCall {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeSession {
  id: string;
  repo: string;
  branch?: string;
  label?: string | null;
  summary?: string | null;
  status: "running" | "stopped" | "error" | "queued";
  model?: string | null;
  permissionMode?: string | null;
  createdAt?: string;
  queuedReason?: string | null;
  ticket?: Record<string, unknown> | null;
  prs?: Record<string, unknown>[] | null;
  session: {
    bridgeAttached: boolean;
    paneBusy?: boolean | null;
    transcriptAgeSec: number | null;
    lastRole: string | null;
    lastHasToolUse: boolean;
    question: string | null;
    questionOptions: string[];
    tail: { id: string; role: string; text: string; blocks?: unknown[] }[];
    newPrUrls: string[];
  } | null;
}

export interface FakeAgent {
  key: string;
  device: string;
  online: boolean;
  terminalOnline?: boolean;
  repos: { name: string; path: string; isRoot?: boolean }[];
  sessions: FakeSession[];
  closedSessions: Record<string, unknown>[];
  jira?: Record<string, unknown> | null;
  models?: Record<string, unknown>;
}

type LiveSocket = ServerWebSocket<{ kind: "live"; host: string; id: string } | { kind: "audio"; bytes: number }>;

export interface FakeHubOptions {
  user?: string;
  password?: string;
  port?: number;
}

const AUTH_REALM = 'Basic realm="turma"';

export class FakeHub {
  readonly user: string;
  readonly password: string;
  private server: Server | null = null;
  private readonly liveSockets = new Set<LiveSocket>();

  /** Every mutating request the miniapp made, in order. */
  readonly calls: HubCall[] = [];
  /** The fleet `/api/agents` reports. Mutate freely between polls. */
  agents: FakeAgent[] = [];
  orgColors: Record<string, number> = {};
  autoStartOrgs: Record<string, boolean> = {};
  /** When true every REST route answers 503 — the "hub unreachable" case. */
  down = false;
  /** How many 202 "still fetching" replies /history gives before the 200. */
  historyPending = 0;
  /** What /history eventually returns. */
  historyEntries: { id: string; role: string; text: string }[] = [];
  historyTruncated = false;
  /** What the /audio socket transcribes the next dictation to. */
  transcript = "";
  /** When set, /audio reports the dictation as unavailable with this reason. */
  transcriptUnavailable: string | null = null;
  /** Ticket detail bodies served by GET /api/jira/<site>/<key>. */
  ticketDetails: Record<string, Record<string, unknown>> = {};
  /** Board create-meta / create-result canned replies. */
  createMeta: Record<string, unknown> = { projects: [{ key: "XERK", name: "XerkTech" }], labels: ["Turma"] };
  createTypes: Record<string, unknown> = { types: [{ id: "10001", name: "Task" }] };
  createResults: Record<string, Record<string, unknown>> = {};

  private cmdSeq = 0;

  constructor(opts: FakeHubOptions = {}) {
    this.user = opts.user ?? "sim";
    this.password = opts.password ?? "sim-password";
  }

  get port(): number {
    if (!this.server) throw new Error("FakeHub not started");
    return this.server.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Sockets currently tailing a session — proof the miniapp opened /live. */
  liveWatchers(): { host: string; id: string }[] {
    return [...this.liveSockets]
      .map((ws) => ws.data)
      .filter((d): d is { kind: "live"; host: string; id: string } => d.kind === "live")
      .map(({ host, id }) => ({ host, id }));
  }

  /** Push committed transcript entries down every open /live socket. */
  pushTail(entries: { id: string; role: string; text: string; blocks?: unknown[] }[]): void {
    this.broadcast(JSON.stringify({ type: "tail", entries }));
  }

  /** Push the in-progress assistant turn (empty text = the turn completed). */
  pushTurn(text: string): void {
    this.broadcast(JSON.stringify({ type: "turn", text }));
  }

  private broadcast(raw: string): void {
    for (const ws of this.liveSockets) {
      if (ws.data.kind === "live") ws.send(raw);
    }
  }

  session(id: string): FakeSession | undefined {
    for (const a of this.agents) {
      const s = a.sessions.find((x) => x.id === id);
      if (s) return s;
    }
    return undefined;
  }

  /** Calls recorded against a path suffix — the usual assertion shape. */
  callsTo(suffix: string): HubCall[] {
    return this.calls.filter((c) => c.path.endsWith(suffix));
  }

  lastCall(): HubCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  start(port = 0): void {
    const self = this;
    this.server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        const url = new URL(req.url);
        const path = url.pathname;

        // WebSockets carry their credential in the query string (the hub's
        // short-lived ws-token), not a header — the browser WebSocket API has
        // no way to set one.
        if (path.startsWith("/live/")) {
          const [, , host, id] = path.split("/");
          if (!url.searchParams.get("auth")) return new Response("no token", { status: 401 });
          if (server.upgrade(req, { data: { kind: "live", host: decodeURIComponent(host ?? ""), id: decodeURIComponent(id ?? "") } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        if (path === "/audio") {
          if (!url.searchParams.get("auth")) return new Response("no token", { status: 401 });
          if (server.upgrade(req, { data: { kind: "audio", bytes: 0 } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }

        return self.rest(req, url);
      },
      websocket: {
        open(ws: LiveSocket) {
          self.liveSockets.add(ws);
        },
        message(ws: LiveSocket, message) {
          if (ws.data.kind !== "audio") return;
          if (typeof message !== "string") {
            ws.data.bytes += message.byteLength;
            return;
          }
          let frame: { type?: string };
          try {
            frame = JSON.parse(message) as { type?: string };
          } catch {
            return;
          }
          if (frame.type !== "finalize") return;
          const transcript = self.transcriptUnavailable
            ? { text: "", unavailable: true, reason: self.transcriptUnavailable }
            : { text: self.transcript, language: "en" };
          ws.send(JSON.stringify({ type: "audio_result", transcript, bytes: ws.data.bytes, durationMs: 1200 }));
          ws.close();
        },
        close(ws: LiveSocket) {
          self.liveSockets.delete(ws);
        },
      },
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.liveSockets) ws.close();
    this.liveSockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    // A dictation's /audio socket is closed by the miniapp's own recorder, and
    // a worker terminated mid-stream can leave that connection half-open —
    // enough for `stop(true)` to wait on it forever. The harness is done by
    // this point either way, so cap the wait rather than hang the run.
    await Promise.race([server.stop(true), new Promise<void>((r) => setTimeout(r, 2000))]);
  }

  // ---- REST ---------------------------------------------------------------

  private authorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const expected = "Basic " + Buffer.from(`${this.user}:${this.password}`).toString("base64");
    return header === expected;
  }

  private queued(): Response {
    this.cmdSeq += 1;
    return Response.json({ ok: true, cmdId: `cmd-${this.cmdSeq}` });
  }

  private async rest(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = req.method;

    let body: unknown = null;
    if (method !== "GET" && method !== "DELETE") {
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    }

    // The login POST plants a cookie for the terminal iframe; it is the one
    // route that authenticates by body rather than header.
    if (path === "/api/login" && method === "POST") {
      this.calls.push({ method, path, body });
      return Response.json({ ok: true });
    }

    if (!this.authorized(req)) {
      return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": AUTH_REALM } });
    }
    if (method !== "GET") this.calls.push({ method, path, body });

    if (this.down) return new Response("hub down", { status: 503 });

    if (path === "/api/agents" && method === "GET") {
      return Response.json({
        now: Date.now(),
        agents: this.agents,
        orgColors: this.orgColors,
        autoStartOrgs: this.autoStartOrgs,
      });
    }

    if (path === "/api/ws-token" && method === "GET") {
      return Response.json({ token: `ws-${++this.cmdSeq}`, expiresInSec: 300 });
    }

    const sess = path.match(/^\/api\/agents\/([^/]+)\/sessions(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (sess) {
      const [, , id, action] = sess;
      if (!id && method === "POST") return this.queued(); // spawn
      if (id && !action && method === "DELETE") return Response.json({ ok: true });
      if (id && action === "history" && method === "GET") {
        if (this.historyPending > 0) {
          this.historyPending -= 1;
          return Response.json({ pending: true, cmdId: `hist-${++this.cmdSeq}` }, { status: 202 });
        }
        return Response.json({
          entries: this.historyEntries,
          truncated: this.historyTruncated,
          fetchedAt: Date.now(),
        });
      }
      if (id && action && method === "POST") return this.queued();
    }

    if (path === "/api/jira/refresh" && method === "POST") return Response.json({ ok: true });

    const jira = path.match(/^\/api\/jira\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (jira) {
      const [, site, second, third] = jira;
      const siteKey = decodeURIComponent(site ?? "");
      if (second === "create-meta" && method === "GET") {
        return Response.json(url.searchParams.get("project") ? this.createTypes : this.createMeta);
      }
      if (second === "tickets" && method === "POST") {
        this.cmdSeq += 1;
        const cmdId = `cmd-${this.cmdSeq}`;
        const b = (body ?? {}) as { summary?: string };
        this.createResults[cmdId] = {
          key: "XERK-999",
          url: `https://${siteKey}/browse/XERK-999`,
          summary: b.summary,
        };
        return Response.json({ ok: true, cmdId });
      }
      if (second === "tickets" && third && method === "GET") {
        const result = this.createResults[third];
        return result
          ? Response.json(result)
          : Response.json({ pending: true, cmdId: third }, { status: 202 });
      }
      if (second === "autostart" && method === "POST") {
        const b = (body ?? {}) as { enabled?: boolean };
        if (b.enabled) this.autoStartOrgs[siteKey] = true;
        else delete this.autoStartOrgs[siteKey];
        return Response.json({ ok: true });
      }
      if (second && !third && method === "GET") {
        const detail = this.ticketDetails[`${siteKey}/${decodeURIComponent(second)}`];
        return detail
          ? Response.json(detail)
          : Response.json({ pending: true, cmdId: `jira-${++this.cmdSeq}` }, { status: 202 });
      }
      if (second && third && method === "POST") return this.queued();
    }

    return new Response("not found", { status: 404 });
  }
}

// ---- fixtures ---------------------------------------------------------------

/** A session in its ordinary running shape. */
export function runningSession(over: Partial<FakeSession> = {}): FakeSession {
  return {
    id: "sess-1",
    repo: "Turma",
    branch: "XERK-233",
    label: null,
    summary: "Fixing the lens",
    status: "running",
    model: "claude-opus-5",
    permissionMode: "auto",
    createdAt: "2026-08-08T09:00:00Z",
    prs: null,
    ticket: null,
    session: {
      bridgeAttached: true,
      paneBusy: false,
      transcriptAgeSec: 12,
      lastRole: "assistant",
      lastHasToolUse: false,
      question: null,
      questionOptions: [],
      tail: [
        { id: "e1", role: "user", text: "Walk the miniapp and fix what breaks." },
        { id: "e2", role: "assistant", text: "On it — booting the simulator now." },
      ],
      newPrUrls: [],
    },
    ...over,
  };
}

/** A fleet that exercises the home screen's shapes: two hosts, one offline. */
export function defaultFleet(): FakeAgent[] {
  return [
    {
      key: "truenas",
      device: "truenas",
      online: true,
      terminalOnline: true,
      repos: [
        { name: "(root)", path: "/mnt/data/Docker/git", isRoot: true },
        { name: "Turma", path: "/mnt/data/Docker/git/Turma" },
        { name: "DockerOps", path: "/mnt/data/Docker/git/DockerOps" },
      ],
      sessions: [runningSession()],
      closedSessions: [],
      models: { available: ["default", "opus", "sonnet", "haiku"], defaultLabel: "Opus 5", at: "2026-08-08T08:00:00Z" },
      jira: {
        configured: true,
        available: true,
        source: "jira",
        siteKey: "xerktech.atlassian.net",
        user: "malcolm",
        fetchedAt: "2026-08-08T09:30:00Z",
        repoOptions: [
          { name: "Turma", cloned: true, nameWithOwner: "xerktech/Turma" },
          { name: "Veiller", cloned: false, nameWithOwner: "xerktech/Veiller" },
        ],
        tickets: [
          {
            key: "XERK-233",
            summary: "Turma Veiller fixes",
            status: "In Progress",
            statusCategory: "indeterminate",
            type: "Task",
            priority: "Medium",
            assignee: "Malcolm Habeeb",
            repoGuess: { repo: "Turma", cloned: true, reason: "the miniapp lives here" },
          },
          {
            key: "XERK-234",
            summary: "Board polish",
            status: "To Do",
            statusCategory: "new",
            type: "Task",
            priority: "Low",
          },
        ],
      },
    },
    {
      key: "wsl-desktop",
      device: "wsl-desktop",
      online: false,
      repos: [{ name: "Turma", path: "/home/mal/git/Turma" }],
      sessions: [],
      closedSessions: [],
    },
  ];
}
