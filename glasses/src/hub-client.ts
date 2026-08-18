import { authHeader, type Config } from "./config.ts";
import type {
  AgentsResponse,
  HistoryPending,
  HistoryResponse,
  SessionAction,
} from "./types.ts";

export interface SpawnOptions {
  repo: string;
  prompt?: string;
  label?: string;
  baseRef?: string;
  model?: string;
  permissionMode?: string;
}

export interface QueuedResponse {
  ok: boolean;
  cmdId: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// What a refused hub call reads as: the hub's OWN `{error}` text when it sent
// one, and the bare status only when it didn't (XERK-270).
//
// The hub explains every refusal it makes — "the target agent is in a different
// org" (409), "the host is offline" (503), the character cap (413), the queue
// limit (429) — and this client used to throw all of them away as "hub request
// failed: <status> <path>". On a display this small the message IS the whole
// feedback, so a status number tells the wearer nothing they can act on.
//
// Worded to match the other two clients — `TurmaNav.refusalText` in
// `turma/public/nav.js` and `hubErrorMessage` in `android/.../net/HubApi.kt` —
// so the same refusal reads the same on all three.
export function refusalText(status: number, body: unknown): string {
  const said = (body as { error?: unknown } | null)?.error;
  const words = typeof said === "string" ? clamp(said.trim()) : "";
  return words || `the hub answered HTTP ${status}`;
}

// A refusal is a sentence for a 10-line display, so it is clamped HERE, at the
// point the hub's text becomes ours, rather than at each surface that shows it.
//
// This text now reaches `render.ts`'s `wrapText`, which is quadratic in an
// unbroken word: 50k chars measured at 263ms and 200k at 4s, i.e. a hub or an
// edge that answers a refusal with a megabyte of text would stall the render
// loop rather than the socket. The clamp also bounds the session screen, where
// the same string wraps in full.
const REFUSAL_TEXT_MAX = 300;

function clamp(words: string): string {
  if (words.length <= REFUSAL_TEXT_MAX) return words;
  // Never cut BETWEEN the halves of a surrogate pair: `slice` counts UTF-16
  // code units, so an emoji straddling the boundary would leave a lone
  // surrogate on the display, which renders as a replacement box.
  const last = words.charCodeAt(REFUSAL_TEXT_MAX - 1);
  const straddles = last >= 0xd800 && last <= 0xdbff;
  return `${words.slice(0, straddles ? REFUSAL_TEXT_MAX - 1 : REFUSAL_TEXT_MAX)}…`;
}

// How long the refusal path waits for the error body itself.
//
// `timeoutFetch` below bounds the RESPONSE, not the body that follows it. A hub
// that sends headers and then stalls mid-body leaves this read pending forever,
// and because App.poll() re-arms only in its `finally`, ONE stalled error body
// would kill the poll loop permanently — precisely the freeze `timeoutFetch`
// exists to prevent, reintroduced on the failure path.
//
// A refusal body is a few bytes of JSON, so this ceiling can only fire on a
// stall. When it does the wearer gets the bare status instead of the hub's
// words: a worse message, but a far better outcome than a frozen display.
export const REFUSAL_BODY_TIMEOUT_MS = 5_000;

// The same ceiling for a SUCCESS body, which stalls exactly the same way and is
// the likelier route: `listAgents` runs every poll, and a 200 whose body never
// arrives froze the display just as dead as a refused one.
//
// Generous rather than sharp, because unlike a refusal a success body can be
// genuinely large (a session's history) on a genuinely slow link — this is the
// "the socket is gone" ceiling, not a latency budget.
export const BODY_TIMEOUT_MS = 30_000;

/** Settle `work` or give up after `ms`, so one stalled read can't hang a caller. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  const settled = Promise.resolve(work);
  if (!ms || ms <= 0) return settled;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`hub body read timed out after ${ms}ms`));
    }, ms);
    settled.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// EVERY body read in this file goes through here. `timeoutFetch` bounds the
// RESPONSE and cannot reach the body that follows it, so an unwrapped
// `res.json()` is an unbounded await on a live socket — and since App.poll()
// re-arms only in its `finally`, one such await freezes the glasses on stale
// content permanently. That deadline is what this exists for.
//
// The `Promise.resolve().then()` is only belt-and-braces for a polyfilled
// Response whose `json` isn't a function: every caller today is `async`, so the
// async boundary already turns such a synchronous throw into a rejection. Keep
// it for a future non-async caller, but don't credit it with the behaviour —
// removing it changes nothing observable.
function readJson<T = unknown>(res: Response, ms: number): Promise<T> {
  return withDeadline(Promise.resolve().then(() => res.json() as Promise<T>), ms);
}

/** The same reading for a response whose body hasn't been consumed yet. */
export async function refusal(res: Response): Promise<HttpError> {
  // The body may be empty, HTML from an edge, unreadable on a torn socket, or
  // never arrive at all. Every one of those means "the hub sent no words",
  // never a failure of its own, so none of them may escape as a throw.
  let body: unknown = {};
  try {
    body = await readJson(res, REFUSAL_BODY_TIMEOUT_MS);
  } catch {
    body = {};
  }
  return new HttpError(res.status, refusalText(res.status, body));
}

export interface HubClientOptions {
  config: Config;
  fetchFn?: typeof fetch;
  /** Per-request ceiling; 0 disables. Defaults to HUB_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

// How long any single hub request may hang before it is treated as failed.
//
// fetch has NO timeout of its own, and App.poll() re-arms only in its
// `finally`. So a hub that accepts the connection and never answers (a wedged
// origin, an edge holding the socket open, a lost native round-trip) left the
// promise unsettled and killed the poll loop PERMANENTLY — the glasses froze
// on stale content with no "hub unreachable" flash at all, where every other
// failure mode recovers within one poll.
//
// Veiller already fixed exactly this for its background JSContext (XERK-215,
// veiller/src/background/net.ts); this is the same guard for the lens, applied
// where every request funnels through instead of at one call site.
export const HUB_FETCH_TIMEOUT_MS = 30_000;

/** Race `base` against a timer so a never-settling fetch becomes a normal error. */
export function timeoutFetch(
  base: typeof fetch,
  timeoutMs: number = HUB_FETCH_TIMEOUT_MS,
): typeof fetch {
  if (!timeoutMs || timeoutMs <= 0) return base;
  const wrapped = (input: unknown, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`hub fetch timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      base(input as never, init).then(
        (res) => { clearTimeout(timer); resolve(res); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  return wrapped as unknown as typeof fetch;
}

// Typed REST client for the hub API (`turma/server.js`). Every method
// sends the Basic auth header, JSON in/out; every non-2xx response throws an
// HttpError carrying its status AND the hub's own `{error}` words (see
// `refusal`) — except getHistory's 202 ("still fetching"), which is a normal,
// non-throwing return per the brief's 202-pending pattern.
export class HubClient {
  private readonly config: Config;
  private readonly fetchFn: typeof fetch;

  constructor({ config, fetchFn, timeoutMs }: HubClientOptions) {
    this.config = config;
    this.fetchFn = timeoutFetch(
      fetchFn ?? globalThis.fetch.bind(globalThis),
      timeoutMs ?? HUB_FETCH_TIMEOUT_MS,
    );
  }

  private url(path: string): string {
    return `${this.hubBase()}${path}`;
  }

  // The hub origin without a trailing slash — for the terminal iframe URL.
  hubBase(): string {
    return this.config.hubUrl.replace(/\/$/, "");
  }

  // The raw ttyd terminal URL (reverse-tunnelled, keyed by session id — the hub
  // routes by id, not host+id; matches the Android app). Needs the session
  // cookie planted first (loginForCookie).
  termUrl(sessionId: string): string {
    return `${this.hubBase()}/term/${encodeURIComponent(sessionId)}/`;
  }

  // Plant the hub's session cookie so the cross-origin terminal iframe (and its
  // wss socket) authenticate. POSTs /api/login with the stored credentials and
  // `credentials:"include"`, exactly as the web login does. Best-effort.
  async loginForCookie(): Promise<void> {
    try {
      await this.fetchFn(this.url("/api/login"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: this.config.user, password: this.config.password }),
      });
    } catch {
      /* offline / blocked — the iframe falls back to the hub's own login */
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: authHeader(this.config), ...extra };
  }

  // Every response in 200-299 is treated as success here (fetch's own `ok`);
  // callers that need to distinguish 200 vs 202 (getHistory) don't use this.
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchFn(this.url(path), {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) throw await refusal(res);
    return (await readJson(res, BODY_TIMEOUT_MS)) as T;
  }

  listAgents(): Promise<AgentsResponse> {
    return this.request<AgentsResponse>("/api/agents");
  }

  spawnSession(host: string, opts: SpawnOptions): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(`/api/agents/${encodeURIComponent(host)}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    });
  }

  // Resume targets a KILLED session's id (from that host's closedSessions
  // list, see types.ts's ClosedSessionInfo) — same endpoint shape as
  // kill/start/restart (see turma/server.js's sessions/<id>/<action>
  // route and hub-agent.py's SessionManager.resume, which re-registers the
  // closed record and relaunches `claude --resume` on its kept branch).
  sessionAction(host: string, id: string, action: SessionAction): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/${action}`,
      { method: "POST" }
    );
  }

  deleteSession(host: string, id: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  }

  sendInput(host: string, id: string, text: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/input`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );
  }

  // Answer a pending AskUserQuestion: `optionIndex` is the 0-based option pick
  // (-1 for a pure free-text answer), `custom` carries free-text / "Other".
  // The agent drops the answer file the session's ask.py bridge is blocked on.
  answerQuestion(
    host: string,
    id: string,
    answer: { optionIndex?: number; custom?: string }
  ): Promise<QueuedResponse> {
    const body: { optionIndex: number; custom?: string } = {
      optionIndex: Number.isInteger(answer.optionIndex) ? (answer.optionIndex as number) : -1,
    };
    if (answer.custom) body.custom = answer.custom;
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
  }

  // 202 ("still fetching", body {pending:true, cmdId}) is a normal return,
  // not a throw — app.ts's session screen polls this every 3s while pending.
  async getHistory(
    host: string,
    id: string
  ): Promise<{ status: 200; body: HistoryResponse } | { status: 202; body: HistoryPending }> {
    const path = `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/history`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    if (!res.ok) throw await refusal(res);
    const body = await readJson(res, BODY_TIMEOUT_MS);
    if (res.status === 202) return { status: 202, body: body as HistoryPending };
    return { status: 200, body: body as HistoryResponse };
  }

  wsToken(): Promise<{ token: string; expiresInSec: number }> {
    return this.request<{ token: string; expiresInSec: number }>("/api/ws-token");
  }

  // ---- Board (Jira/Azure) — same endpoints the web board.html uses ----------

  // A ticket's full detail (description, comments, statusOptions). 202 means the
  // agent is still fetching it — the caller polls, like the web board.
  async jiraDetail(
    siteKey: string,
    key: string
  ): Promise<{ status: 200; body: Record<string, unknown> } | { status: 202; body: { pending: true; cmdId: string } }> {
    const path = `/api/jira/${encodeURIComponent(siteKey)}/${encodeURIComponent(key)}`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    if (!res.ok) throw await refusal(res);
    const body = await readJson<Record<string, unknown> & { pending: true; cmdId: string }>(res, BODY_TIMEOUT_MS);
    return res.status === 202 ? { status: 202, body } : { status: 200, body };
  }

  private jiraPost(siteKey: string, key: string, action: string, body: unknown): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/jira/${encodeURIComponent(siteKey)}/${encodeURIComponent(key)}/${action}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
  }

  // Start a session on a ticket (the card's start button).
  startTicket(siteKey: string, key: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(`/api/jira/${encodeURIComponent(siteKey)}/${encodeURIComponent(key)}/session`, { method: "POST" });
  }
  setTicketStatus(siteKey: string, key: string, body: { value?: string; category?: string }): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "status", body);
  }
  setTicketRepo(siteKey: string, key: string, body: unknown): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "repo", body);
  }
  setTicketAgent(siteKey: string, key: string, body: unknown): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "agent", body);
  }
  setTicketModel(siteKey: string, key: string, body: unknown): Promise<QueuedResponse> {
    return this.jiraPost(siteKey, key, "model", body);
  }
  jiraRefresh(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/api/jira/refresh", { method: "POST" });
  }

  // Flip an org's hub-side auto-start opt-in (the org menu's "auto" toggle,
  // XERK-41). Same endpoint the web org.js POSTs; the hub is authoritative on
  // return and its next heartbeat carries the settled `autoStartOrgs`.
  setAutoStart(siteKey: string, enabled: boolean): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `/api/jira/${encodeURIComponent(siteKey)}/autostart`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }
    );
  }

  // New-ticket create flow (the shared "New ticket" control). All three are the
  // same endpoints the web newticket.js uses; 202 = "still fetching", polled by
  // the caller.
  async createMeta(
    siteKey: string,
    project?: string
  ): Promise<{ status: 200; body: Record<string, unknown> } | { status: 202; body: Record<string, unknown> }> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const path = `/api/jira/${encodeURIComponent(siteKey)}/create-meta${q}`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    // Refuse through the same door as every other call: a swallowed body used
    // to resolve `{}`, which `createResult`'s caller renders as a ticket created
    // with no key — a false success on a write, for a request whose real fate
    // is unknown. 202 is a normal "still fetching" return, not a refusal.
    if (!res.ok) throw await refusal(res);
    const body = await readJson<Record<string, unknown>>(res, BODY_TIMEOUT_MS);
    return res.status === 202 ? { status: 202, body } : { status: 200, body };
  }
  createTicket(siteKey: string, body: { project: string; issueType: string; summary: string; description?: string; labels?: string[] }): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(`/api/jira/${encodeURIComponent(siteKey)}/tickets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async createResult(
    siteKey: string,
    cmdId: string
  ): Promise<{ status: 200; body: Record<string, unknown> } | { status: 202; body: Record<string, unknown> }> {
    const path = `/api/jira/${encodeURIComponent(siteKey)}/tickets/${encodeURIComponent(cmdId)}`;
    const res = await this.fetchFn(this.url(path), { headers: this.headers() });
    // Refuse through the same door as every other call: a swallowed body used
    // to resolve `{}`, which `createResult`'s caller renders as a ticket created
    // with no key — a false success on a write, for a request whose real fate
    // is unknown. 202 is a normal "still fetching" return, not a refusal.
    if (!res.ok) throw await refusal(res);
    const body = await readJson<Record<string, unknown>>(res, BODY_TIMEOUT_MS);
    return res.status === 202 ? { status: 202, body } : { status: 200, body };
  }

  // Interrupt the in-flight turn (web "◼ Stop") — leaves the session + conversation
  // intact. No body.
  interrupt(host: string, id: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/interrupt`,
      { method: "POST" }
    );
  }

  // Rename a session (web ⋯ → Rename). A blank summary clears the name back to
  // the auto/label fallback.
  setSummary(host: string, id: string, summary: string): Promise<QueuedResponse> {
    return this.request<QueuedResponse>(
      `/api/agents/${encodeURIComponent(host)}/sessions/${encodeURIComponent(id)}/summary`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      }
    );
  }
}
