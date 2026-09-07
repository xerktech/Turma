// XERK-668 — the ttyd `tty` wire protocol, PURE and stdlib-only.
//
// This is the byte-for-byte reproduction of the half of ttyd the Windows agent
// must replace: the framing the browser's xterm.js speaks, the `/token` shape it
// fetches, the SET_PREFERENCES it applies, the basic-auth ttyd's `-c` enforces,
// and the JSON control protocol that stands in for the tmux CLI. It owns NO I/O
// (no node-pty, no ws, no http, no fs), so CI exercises every decision here with
// the stdlib alone — the I/O shell that wires node-pty + ws around it is
// `pty-host.mjs`, host-proof only (node-pty is a native addon CI cannot build).
//
// Captured from a real `ttyd 1.7.7` (the version `agent/native/install.sh` pins):
// see `vendor/ttyd-1.7.7/PROVENANCE.md`. Every constant below was read off that
// binary's wire, not inferred — the protocol has direction-specific command
// bytes (client `1`=RESIZE vs server `1`=SET_WINDOW_TITLE) and getting one wrong
// silently breaks the terminal, so they are pinned against the capture in tests.

import { timingSafeEqual } from 'node:crypto';

// ---- command bytes (ttyd 1.7.x protocol.h; direction-specific) ---------------
// client -> server (first byte of each frame)
export const C_INPUT = 0x30;   // '0' keystrokes
export const C_RESIZE = 0x31;  // '1' JSON {columns,rows}
export const C_PAUSE = 0x32;   // '2' flow control
export const C_RESUME = 0x33;  // '3' flow control
export const C_JSON_INIT = 0x7b; // '{' first message {AuthToken,columns,rows}
// server -> client
export const S_OUTPUT = 0x30;        // '0' pty output
export const S_SET_WINDOW_TITLE = 0x31; // '1' window title text
export const S_SET_PREFERENCES = 0x32;  // '2' client-options JSON (the `-t` flags)

export const WS_SUBPROTOCOL = 'tty';
export const WS_PATH_SUFFIX = '/ws';
export const TOKEN_PATH_SUFFIX = '/token';

// ---- server -> client frame builders -----------------------------------------
// Each server frame is one command byte followed by its payload. xterm.js reads
// the first byte and dispatches; the tunnel/hub shovel these opaque.
export function outputFrame(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  return Buffer.concat([Buffer.from([S_OUTPUT]), b]);
}
export function windowTitleFrame(title) {
  return Buffer.concat([Buffer.from([S_SET_WINDOW_TITLE]), Buffer.from(String(title), 'utf8')]);
}
export function preferencesFrame(prefs) {
  return Buffer.concat([Buffer.from([S_SET_PREFERENCES]), Buffer.from(JSON.stringify(prefs), 'utf8')]);
}

// ---- client -> server frame decoding -----------------------------------------
// Returns a discriminated result; the caller performs the I/O (write/resize) so
// this stays pure. The init frame is the ONLY one that starts with '{'.
export function decodeClientFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length === 0) return { kind: 'empty' };
  const cmd = buf[0];
  if (cmd === C_JSON_INIT) {
    try {
      const init = JSON.parse(buf.toString('utf8'));
      return { kind: 'init', authToken: init.AuthToken ?? '', columns: init.columns, rows: init.rows };
    } catch { return { kind: 'malformed' }; }
  }
  if (cmd === C_INPUT) return { kind: 'input', data: buf.subarray(1) };
  if (cmd === C_RESIZE) {
    try {
      const { columns, rows } = JSON.parse(buf.subarray(1).toString('utf8'));
      return { kind: 'resize', columns, rows };
    } catch { return { kind: 'malformed' }; }
  }
  if (cmd === C_PAUSE) return { kind: 'pause' };
  if (cmd === C_RESUME) return { kind: 'resume' };
  return { kind: 'unknown', byte: cmd };
}

// ---- basic auth (ttyd `-c term:<token>`) -------------------------------------
// The hub proxies EVERY /term request with `Authorization: Basic base64(term:T)`
// (server.js `ttydAuth`), so the pty-host validates exactly that, same as ttyd.
export function credential(token) {
  return `term:${token ?? ''}`;
}
// Constant-time compare so a byte-by-byte timing oracle can't recover the token.
export function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
const safeStrEq = constantTimeEqual;
// The CONTROL channel is loopback + a shared-secret token on the URL
// (`ws://…/?token=<TOKEN>`), so another local process cannot drive the session.
// An unset token means "no auth required". Constant-time on the token compare.
export function controlTokenOk(reqUrl, token) {
  if (token === '' || token == null) return true;
  let t;
  try { t = new URL(reqUrl, 'http://x').searchParams.get('token'); }
  catch { return false; }
  return t != null && constantTimeEqual(t, token);
}
// `header` is a raw `Authorization` value. Returns true iff it is
// `Basic base64(term:<token>)`. An unset token means "no auth required".
export function basicAuthOk(header, token) {
  if (token === '' || token == null) return true;
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
  catch { return false; }
  return safeStrEq(decoded, credential(token));
}

// ttyd's `/token` returns base64("user:pass") so the JS client can echo it back
// as the ws init `AuthToken` (verified against the real 1.7.7 binary). The ws
// init check compares against this exact value.
export function tokenValue(token) {
  return Buffer.from(credential(token), 'utf8').toString('base64');
}
export function tokenResponseBody(token) {
  return JSON.stringify({ token: tokenValue(token) });
}
// The ws upgrade already carried basic auth; the init AuthToken is ttyd's second
// check. An unset token accepts any (matches ttyd with no `-c`).
export function initAuthOk(authToken, token) {
  if (token === '' || token == null) return true;
  return safeStrEq(authToken ?? '', tokenValue(token));
}

// ---- client preferences (the `-t key=value` flags ttyd sends as SET_PREFS) ---
// ttyd type-coerces: `fontSize=12` -> number, `disableLeaveAlert=true` -> bool,
// everything else -> string (a font stack with commas/quotes stays a string).
// Matched against the real binary's SET_PREFERENCES JSON.
export function coercePrefValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  // A bare integer/float with no other characters is a number; anything else
  // (e.g. `12px`, a font stack) stays a string.
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
// `pairs` is an array of `key=value` strings (repeated `--pref`/`-t` flags).
// Splits on the FIRST '=' only, so a value may contain '='.
export function parsePrefFlags(pairs) {
  const out = {};
  for (const p of pairs || []) {
    const i = String(p).indexOf('=');
    if (i < 0) continue;
    const key = p.slice(0, i);
    if (!key) continue;
    out[key] = coercePrefValue(p.slice(i + 1));
  }
  return out;
}
// The exact `-t` set `hub-agent.py`'s `_launch_ttyd` passes, so a Windows
// terminal renders identically to the Linux fleet's. Kept here as the single
// source of truth for both the pty-host default and the tests.
export const DEFAULT_PREFS = {
  fontFamily: 'JBMNerd, "JetBrainsMono Nerd Font Mono", "DejaVu Sans Mono", monospace',
  fontSize: 12,
  rendererType: 'webgl',
  disableLeaveAlert: true,
  macOptionClickForcesSelection: true,
};

// ---- base-path redirect (ttyd `-b /term/<id>`) -------------------------------
// ttyd answers the BARE base path with a 302 to the slash form; the hub relies
// on this (server.js adds the slash itself, but a direct hit must still 302).
// Returns the Location to redirect to, or null if no redirect is needed.
// `reqPath` is the URL path only (no query); the caller re-appends the query.
export function baseRedirectLocation(reqPath, base) {
  if (reqPath === base) return base + '/';
  return null;
}
// Route a GET/HEAD path under the base to a served resource.
export function routeHttp(reqPath, base) {
  if (reqPath === base) return { kind: 'redirect', location: base + '/' };
  if (reqPath === base + '/') return { kind: 'index' };
  if (reqPath === base + TOKEN_PATH_SUFFIX) return { kind: 'token' };
  return { kind: 'notfound' };
}

// ---- scrollback ring (the `capture-pane` analog) -----------------------------
// A byte-bounded tail of raw pty output. Replayed to a re-attaching client (the
// screen tmux+ttyd repaint on `attach` today) and returned by control `capture`.
export class ScrollbackRing {
  constructor(maxBytes) {
    this.max = maxBytes > 0 ? maxBytes : 256 * 1024;
    this.buf = Buffer.alloc(0);
  }
  append(chunk) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    this.buf = Buffer.concat([this.buf, b]);
    if (this.buf.length > this.max) this.buf = this.buf.subarray(this.buf.length - this.max);
  }
  bytes() { return this.buf; }
  text() { return this.buf.toString('utf8'); }
  get length() { return this.buf.length; }
}

// ---- persisted state (the registry a fresh manager re-adopts from) -----------
// The direct analog of the session record's tmuxName/ttydPid/ttydPort — the
// {pid, termPort, ctrlPort} a restarted manager probes to re-attach, under
// KillMode=process. Kept minimal and JSON-serialisable.
export function serializeState(st) {
  return JSON.stringify({
    session: st.session,
    pid: st.pid,
    ptyPid: st.ptyPid ?? null,
    base: st.base,
    termPort: st.termPort ?? null,
    ctrlPort: st.ctrlPort ?? null,
    shell: st.shell ?? null,
    ptyAlive: st.ptyAlive !== false,
    exitCode: st.exitCode ?? null,
    startedAt: st.startedAt,
  }, null, 2);
}
export function parseState(str) {
  const j = JSON.parse(str);
  if (!j || typeof j !== 'object') throw new Error('state is not an object');
  return j;
}

// ---- control protocol (the tmux-CLI replacement) ----------------------------
// The manager drives the session through this instead of `tmux send-keys` /
// `capture-pane` / `has-session`. PURE: given a pty adapter (the thin object the
// I/O shell wraps node-pty in), it returns the reply and performs the adapter's
// own methods. Ops mirror the four tmux roles the ADR enumerates plus resize.
//
//   inject  -> send-keys / paste-buffer (+ Enter on submit)
//   capture -> capture-pane -p (the scrollback ring)
//   alive   -> has-session (+ pids for the adopt probe)
//   resize  -> refresh-client -C
//   kill    -> kill-session
//
// The adapter interface: { write(str), resize(cols,rows), kill(), get pid,
// get ptyPid, get alive, get exitCode, capture()->string }.
export function handleControlMessage(raw, adapter) {
  let msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return { ok: false, error: 'unparseable control message' }; }
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'control message not an object' };
  const base = msg.id != null ? { id: msg.id } : {};
  switch (msg.op) {
    case 'inject': {
      adapter.write(msg.data ?? '');
      if (msg.submit) adapter.write('\r');
      return { ...base, ok: true };
    }
    case 'capture':
      return { ...base, ok: true, data: adapter.capture() };
    case 'alive':
      return { ...base, ok: true, alive: adapter.alive, pid: adapter.pid,
        ptyPid: adapter.ptyPid, exitCode: adapter.exitCode };
    case 'resize': {
      if (msg.columns && msg.rows) adapter.resize(msg.columns, msg.rows);
      return { ...base, ok: true };
    }
    case 'kill':
      adapter.kill();
      return { ...base, ok: true };
    default:
      return { ...base, ok: false, error: `unknown op ${msg?.op}` };
  }
}
