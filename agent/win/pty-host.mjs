// XERK-668 — the per-session pty-host: the production terminal layer for the
// native Windows agent (ADR docs/windows-agent-adr.md, D1). One long-lived
// process per session that OWNS the session's pty (ConPTY on Windows via
// node-pty, forkpty elsewhere) and serves, on loopback, the EXACT surface ttyd
// serves today — so the hub, tunnel-agent.js and the browser's xterm.js are
// unchanged (server.js proxies /term/<id>/* to this port exactly as it dials
// ttyd). It replaces BOTH halves of the Linux stack:
//
//   tmux (detached session, send-keys, capture-pane, has-session)  +  ttyd (ws)
//
// Two loopback servers:
//   * TERMINAL (termPort): HTTP for ttyd's client (`/` = the vendored 1.7.7
//     inline.html, `/token`, the bare-base 302) + the `tty` websocket at
//     `<base>/ws`, all behind basic-auth `term:<token>` — byte-identical to what
//     the hub's proxyTerm/ws-proxy already speak.
//   * CONTROL (ctrlPort): a JSON ws the manager drives instead of the tmux CLI
//     (inject/capture/alive/resize/kill), token-gated on a loopback port.
//
// All wire/auth/framing DECISIONS live in the pure `tty-protocol.mjs` (CI-tested
// with the stdlib); this file is only the node-pty + ws + http I/O around them,
// so it is host-proof (node-pty is a native addon CI cannot build). Spawned
// DETACHED by the manager so it outlives a manager restart (KillMode=process),
// and re-adopted from the persisted {pid,termPort,ctrlPort} state alone (D2).

import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';
import * as T from './tty-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
// A repeatable flag (`--pref k=v --pref k2=v2`).
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1]);
  }
  return out;
}

const SESSION = arg('session', 'session');
const BASE = arg('base-path', `/term/${SESSION}`);
const TERM_PORT = parseInt(arg('term-port', '0'), 10);   // 0 = ephemeral; manager allocates off TTYD_PORT_BASE
const CTRL_PORT = parseInt(arg('ctrl-port', '0'), 10);   // 0 = ephemeral; published in state
const STATE = arg('state', join(HERE, `pty-host-${SESSION}.state.json`));
const BAKED_TOKEN = arg('auth-token', '');               // the `term:<TOKEN>` basic-auth password
// The manager-owned file holding the token CURRENTLY in force. Re-read per auth
// check so a hub token roll needs no relaunch (see authTokensInForce's comment) —
// which on Windows would mean killing the operator's live claude, the pty-host
// being both the terminal and the pty. Empty/absent = the baked token, unchanged.
const TOKEN_FILE = arg('auth-token-file', '');
const COLS = parseInt(arg('cols', '80'), 10);
const ROWS = parseInt(arg('rows', '24'), 10);
const RING_MAX = parseInt(arg('scrollback', String(256 * 1024)), 10);
const MAX_CLIENTS = parseInt(arg('max-clients', '8'), 10); // ttyd's `-m 8`
const CWD = arg('cwd', process.cwd());
const CLIENT_HTML = arg('client-html', join(HERE, 'vendor', 'ttyd-1.7.7', 'index.html'));
// The command the pty runs. Everything after a bare `--` is the argv; default is
// the platform shell (the manager passes `claude --remote-control …`).
const dd = process.argv.indexOf('--');
const CMD = dd >= 0 && dd + 1 < process.argv.length
  ? process.argv[dd + 1]
  : (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
const CMD_ARGS = dd >= 0 ? process.argv.slice(dd + 2) : [];
const TITLE = arg('title', `${CMD.split(/[\\/]/).pop()} (${process.env.DEVICE_NAME || 'turma'})`);

// The `-t` client options the browser applies (font/webgl/…): the manager's
// flags override the fleet-parity defaults so a Windows terminal renders like
// the Linux one.
const PREFS = { ...T.DEFAULT_PREFS, ...T.parsePrefFlags(argAll('pref')) };

const INDEX_HTML = readFileSync(CLIENT_HTML);
const START = new Date().toISOString();

// A pty-host with no auth token would serve the terminal unauthenticated AND —
// worse — accept unauthenticated `inject`/`kill` on the control channel (our own
// invention, unlike ttyd's optional `-c`). The manager ALWAYS mints one
// (`_launch_ttyd` passes `-c term:{TURMA_TOKEN or 'changeme'}`), so an empty token
// is a misconfiguration, not a mode — refuse to start rather than run open.
if (BAKED_TOKEN === '' || BAKED_TOKEN == null) {
  process.stderr.write('pty-host: --auth-token is required (refusing to run the terminal + control channel unauthenticated)\n');
  process.exit(2);
}

// The tokens in force for THIS check: the manager's live file AND the baked one
// (see authTokensInForce for why BOTH). A manager that rewrites the file after a
// roll is obeyed immediately, with no relaunch and no lost session.
//
// The read is HARDENED because it runs on the pty-host's ONLY thread, on every
// auth check, against a path another same-uid process can replace:
//   * a non-REGULAR file is refused outright — opening a planted FIFO here blocks
//     the event loop FOREVER, wedging the terminal AND the manager's control
//     channel while the pid stays alive (the zombie, by another door);
//   * a file over TOKEN_FILE_MAX is refused rather than read — a 10 MB one costs
//     ~22ms of blocking read PER REQUEST;
//   * the answer is cached on (mtime, size, inode, dev), so the steady state is
//     one stat, not a read.
// Every refusal falls back to the baked token, never to an empty one (an empty
// token means "no auth required" to basicAuthOk and would open the control
// channel that accepts inject/kill).
const TOKEN_FILE_MAX = 4096;
let tokenCache = { key: null, tokens: null };
function authTokens() {
  if (!TOKEN_FILE) return [BAKED_TOKEN];
  try {
    const st = lstatSync(TOKEN_FILE);
    if (!st.isFile() || st.size > TOKEN_FILE_MAX) throw new Error('unusable token file');
    const key = `${st.mtimeMs}:${st.size}:${st.ino}:${st.dev}`;
    if (tokenCache.key === key) return tokenCache.tokens;
    const tokens = T.authTokensInForce(readFileSync(TOKEN_FILE, 'utf8'), BAKED_TOKEN);
    tokenCache = { key, tokens };
    return tokens;
  } catch { /* unreadable/unusable: the baked token alone */ }
  tokenCache = { key: null, tokens: null };
  return T.authTokensInForce(null, BAKED_TOKEN);
}
// The token a request authenticated WITH, or null. `/token` must echo THAT one:
// the browser sends it straight back as the ws init AuthToken, so answering with
// a different in-force token would fail the pty-host's own second check.
function matchedToken(header) {
  for (const t of authTokens()) if (T.basicAuthOk(header, t)) return t;
  return null;
}

// ---- the pty (ConPTY on Windows) ---------------------------------------------
// SPAWNED ONLY ONCE BOTH SERVERS ARE LISTENING (see startPty below). Spawning it
// at module top meant a bind failure — EADDRINUSE from a port a failed teardown
// left held, or any squatter that won the TOCTOU against the manager's
// `_port_open` probe — killed the process with claude.exe already running under
// the ConPTY, leaking a child nothing could reach and making the manager wait out
// the full PTY_SPAWN_TIMEOUT_SEC on its beat. Bind first, spawn second: a bind
// failure then costs nothing but a clean non-zero exit with a reason in the log.
let term = null;
const ring = new T.ScrollbackRing(RING_MAX);
// The rendered-screen grid the control `capture` reads (XERK-703). The ring above
// is raw bytes over time and loses Claude Code's paint-once interrupt-hint footer
// once a turn streams past its window (false-idle); the grid is fed EVERY byte and
// keeps the footer as a persistent screen element, the `capture-pane -p` analog.
const grid = new T.TerminalGrid(COLS, ROWS);
const termClients = new Set();
let ptyAlive = false;
let exitCode = null;

// COLORTERM advertises truecolor to the app (the direct analog of tmux.conf's
// RGB terminal-override — with no tmux in the middle, 24-bit sequences pass
// straight through to xterm.js, which is truecolor). OSC 52 copy-out likewise
// passes through as raw output for the hub's injected handler to catch.
function startPty() {
  term = pty.spawn(CMD, CMD_ARGS, {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: CWD,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  ptyAlive = true;

  term.onData((d) => {
    const buf = Buffer.from(d, 'utf8');
    ring.append(buf);
    grid.write(buf);
    const frame = T.outputFrame(buf);
    for (const ws of termClients) if (ws.readyState === ws.OPEN) ws.send(frame);
  });

  term.onExit(({ exitCode: code }) => {
    ptyAlive = false;
    exitCode = code ?? 0;
    writeState();
    // Give clients a beat to flush the final bytes, then exit — a real host
    // lingers briefly so a re-attach right at exit still sees the last screen.
    setTimeout(() => process.exit(0), 100);
  });
}

// ---- pty adapter for the pure control handler --------------------------------
const adapter = {
  write: (s) => { if (term) term.write(s); },
  resize: (c, r) => { try { term?.resize(c, r); grid.resize(c, r); } catch { /* pty may have exited */ } },
  kill: () => { try { term?.kill(); } catch { /* already dead */ } },
  // The RENDERED visible screen (tmux capture-pane -p analog), not the raw ring —
  // so `_busy_from_capture`'s marker scan sees the persistent footer (XERK-703).
  capture: () => grid.capture(),
  get pid() { return process.pid; },
  get ptyPid() { return term ? term.pid : null; },
  get alive() { return ptyAlive; },
  get exitCode() { return exitCode; },
};

// ---- TERMINAL server: ttyd HTTP client + the `tty` websocket -----------------
function unauthorized(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ttyd"', 'Content-Length': 0 });
  res.end();
}
const termHttp = createServer((req, res) => {
  const path = req.url.split('?')[0];
  const tok = matchedToken(req.headers.authorization);
  if (tok === null) return unauthorized(res);
  const route = T.routeHttp(path, BASE);
  if (route.kind === 'redirect') {
    // Preserve the query byte-for-byte (ttyd does; server.js relies on it).
    const q = req.url.slice(path.length);
    res.writeHead(302, { Location: route.location + q, 'Content-Length': 0 });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (route.kind === 'index') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': INDEX_HTML.length });
    return res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
  }
  if (route.kind === 'token') {
    const body = Buffer.from(T.tokenResponseBody(tok), 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  res.writeHead(404, { 'Content-Length': 0 });
  res.end();
});

const termWss = new WebSocketServer({
  server: termHttp,
  path: BASE + T.WS_PATH_SUFFIX,
  // xterm.js negotiates the `tty` subprotocol; preserve it exactly.
  handleProtocols: (protocols) => (protocols.has(T.WS_SUBPROTOCOL) ? T.WS_SUBPROTOCOL : false),
  verifyClient: (info) => matchedToken(info.req.headers.authorization) !== null,
});

termWss.on('connection', (ws) => {
  // Count RAW connections (ttyd's `-m` semantics), not just inited ones — else a
  // client that connects and never sends its init frame is never counted and the
  // cap is bypassed by holding un-inited sockets. `termWss.clients` already
  // includes this new socket, so refuse once it exceeds the cap.
  if (termWss.clients.size > MAX_CLIENTS) { ws.close(1013, 'max clients'); return; }
  let inited = false;
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const f = T.decodeClientFrame(buf);
    switch (f.kind) {
      case 'init': {
        // ttyd's second auth check; the ws upgrade already carried basic auth.
        if (!authTokens().some((t) => T.initAuthOk(f.authToken, t))) { ws.close(1008, 'bad token'); return; }
        if (f.columns && f.rows) adapter.resize(f.columns, f.rows);
        if (inited) return;
        inited = true;
        termClients.add(ws);
        // ttyd's connect sequence: window title, then client preferences, then
        // the terminal backlog — replaying the ring is how a re-attaching client
        // sees the screen it left (tmux+ttyd's `attach` repaint today).
        ws.send(T.windowTitleFrame(TITLE));
        ws.send(T.preferencesFrame(PREFS));
        if (ring.length) ws.send(T.outputFrame(ring.bytes()));
        break;
      }
      case 'input':
        if (inited) adapter.write(f.data.toString('utf8'));
        break;
      case 'resize':
        if (f.columns && f.rows) adapter.resize(f.columns, f.rows);
        break;
      case 'pause':
        try { term?.pause(); } catch { /* older node-pty */ }
        break;
      case 'resume':
        try { term?.resume(); } catch { /* older node-pty */ }
        break;
      default:
        break; // empty/malformed/unknown ignored, as ttyd does
    }
  });
  ws.on('close', () => termClients.delete(ws));   // DETACH: pty keeps running
  ws.on('error', () => termClients.delete(ws));
});

// ---- CONTROL server: the tmux-CLI replacement the manager drives -------------
// Loopback + a shared-secret token on the URL (`?token=<TOKEN>`), so another
// local process cannot drive the session. The manager holds the token (it minted
// it) and reads the ctrlPort from the state file.
const ctrlHttp = createServer((_req, res) => { res.writeHead(426); res.end('control channel is websocket-only'); });
const ctrlWss = new WebSocketServer({
  server: ctrlHttp,
  verifyClient: (info) => authTokens().some((t) => T.controlTokenOk(info.req.url, t)),
});
ctrlWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const reply = T.handleControlMessage(raw.toString('utf8'), adapter);
    ws.send(JSON.stringify(reply));
    // kill is answered THEN executed (handleControlMessage already called
    // adapter.kill); the onExit handler above tears down and exits.
  });
});

// ---- state file: the registry a fresh manager re-adopts from -----------------
function writeState() {
  const st = {
    session: SESSION, pid: process.pid, ptyPid: term ? term.pid : null, base: BASE,
    termPort: termHttp.address()?.port ?? (TERM_PORT || null),
    ctrlPort: ctrlHttp.address()?.port ?? (CTRL_PORT || null),
    // Whether this pty-host re-reads its auth token from a manager-owned file
    // (XERK-578). The manager READS this back: a surviving pty-host WITHOUT it
    // predates the live-token change, so its baked-in token can never be
    // refreshed and a roll leaves it unreachable — which is the one case the
    // manager has to heal destructively.
    authTokenFile: TOKEN_FILE || null,
    // Spelled out rather than shorthand: `serializeState` is a WHITELIST, and the
    // CI test reads THIS literal's key names to hold the two sides together (a
    // key added here but not there is silently dropped, and the manager reads the
    // absence as fact — that omission shipped once and turned the post-roll
    // self-heal into "tear down every session").
    shell: CMD, ptyAlive: ptyAlive, exitCode: exitCode, startedAt: START,
  };
  // Atomic: write a sibling temp then rename, so a reader never sees a partial.
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, T.serializeState(st));
  renameSync(tmp, STATE);
  return st;
}

// A broken stdout must NEVER kill the session. The manager spawns us detached
// with stdout to a log file; after a manager restart that fd can be gone, so an
// EPIPE/EBADF on the diagnostic PTYHOST_READY line (or any later write) must be
// swallowed, not thrown — the pty child outliving its spawner is the whole point.
process.stdout.on('error', () => {});

// The ORIGIN keep-alive window. Node's 5s default is SHORTER than the window the
// hub parks a free tunnel channel for, which guarantees the hub eventually sends
// an asset request down a socket we already FIN'd — the browser's ECONNRESET /
// "socket hang up" on terminal open. See KEEPALIVE_TIMEOUT_MS for the invariant.
T.applyKeepAlive([termHttp, ctrlHttp]);

// A bind failure ('error' on a server with no listener) is an UNCAUGHT throw that
// takes the process down — and with the old spawn-at-top order it did so with
// claude.exe already running under the ConPTY. Handle it explicitly: log a
// structured reason (the manager's only window into a launch that never
// published), tear any pty down, and exit non-zero so the .log says why rather
// than the manager just timing out.
T.installFatalErrorHandlers([
  { name: `terminal server (127.0.0.1:${TERM_PORT})`, emitter: termHttp },
  { name: `control server (127.0.0.1:${CTRL_PORT})`, emitter: ctrlHttp },
  // `ws` RE-EMITS its attached http server's 'error' on the WebSocketServer, so
  // covering the http servers alone is not enough — the re-emit is itself an
  // unhandled 'error' and throws before the clean exit below can run.
  { name: `terminal ws (127.0.0.1:${TERM_PORT})`, emitter: termWss },
  { name: `control ws (127.0.0.1:${CTRL_PORT})`, emitter: ctrlWss },
], (which, err) => {
  try {
    process.stderr.write(`pty-host: ${which} failed to bind ` +
      `(${err && err.code ? err.code : err}) — not starting the pty\n`);
  } catch { /* stderr gone */ }
  try { term?.kill(); } catch { /* not spawned / already dead */ }
  process.exit(3);
});

let up = 0;
const onListen = () => {
  if (++up !== 2) return;
  // BOTH ports are bound: only now is it safe to put a child on the ConPTY.
  try {
    startPty();
  } catch (e) {
    try { process.stderr.write(`pty-host: pty spawn failed (${e})\n`); } catch { /* stderr gone */ }
    process.exit(4);
  }
  const st = writeState();
  try { process.stdout.write(`PTYHOST_READY ${JSON.stringify(st)}\n`); } catch { /* stdout gone */ }
};
termHttp.listen(TERM_PORT, '127.0.0.1', onListen);
ctrlHttp.listen(CTRL_PORT, '127.0.0.1', onListen);

// KillMode=process semantics: a clean SIGTERM/SIGINT tears the pty down; any
// other manager death (crash/restart) leaves us running to be re-adopted.
function shutdown() { try { term?.kill(); } catch { /* already dead */ } process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
