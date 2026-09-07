// THROWAWAY SPIKE (XERK-667) — not production code. See README.md.
//
// A persistent per-session pseudo-console host. On Windows this binds ConPTY via
// node-pty; on Linux/macOS the SAME node-pty API binds forkpty. It is the single
// process that replaces BOTH halves of today's Linux terminal stack:
//
//   tmux (detached session, `send-keys`, `capture-pane`, `has-session`)  +  ttyd (ws bridge)
//
// It owns one pty, keeps a scrollback ring, and exposes two loopback servers:
//   * TERMINAL ws  — speaks ttyd's `tty` subprotocol verbatim, so the tunnel/hub
//                    and xterm.js need no change (they shovel bytes; §2 of the ADR).
//   * CONTROL  ws  — JSON ops the manager (hub-agent.py) uses instead of tmux CLI:
//                    inject (send-keys/paste), capture (capture-pane), alive (has-session).
//
// It is meant to OUTLIVE its spawner (the KillMode=process invariant): spawned
// detached, it keeps running when the manager restarts, and a fresh manager
// re-adopts it from the persisted {pid,termPort,ctrlPort} state file alone.

import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

// ---- ttyd `tty` subprotocol command bytes (ttyd 1.7.x protocol.h) -------------
const C_INPUT = 0x30;            // '0' client->server: keystrokes
const C_RESIZE = 0x31;           // '1' client->server: JSON {columns,rows}
const C_PAUSE = 0x32;            // '2' client->server: flow control (ignored here)
const C_RESUME = 0x33;           // '3' client->server: flow control (ignored here)
const C_JSON_INIT = 0x7b;        // '{' client->server: first msg {AuthToken,columns,rows}
const S_OUTPUT = Buffer.from('0');   // server->client: pty output
const S_SET_PREFS = Buffer.from('2');// server->client: client preferences

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const SESSION = arg('session', 'spike');
const STATE = arg('state', `/tmp/pty-host-${SESSION}.json`);
const SHELL = arg('shell', process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
const MAX_CLIENTS = parseInt(arg('max-clients', '8'), 10);      // ttyd's `-m 8`
const RING_MAX = parseInt(arg('scrollback', String(256 * 1024)), 10);

// ---- the pty (ConPTY on Windows) ---------------------------------------------
const term = pty.spawn(SHELL, [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});

let ring = Buffer.alloc(0);                 // scrollback (capture-pane analog)
const termClients = new Set();
let ptyAlive = true;
let exitCode = null;

function appendRing(buf) {
  ring = Buffer.concat([ring, buf]);
  if (ring.length > RING_MAX) ring = ring.subarray(ring.length - RING_MAX);
}

term.onData((d) => {
  const buf = Buffer.from(d, 'utf8');
  appendRing(buf);
  const frame = Buffer.concat([S_OUTPUT, buf]);   // ttyd OUTPUT frame
  for (const ws of termClients) if (ws.readyState === ws.OPEN) ws.send(frame);
});

term.onExit(({ exitCode: code }) => {
  ptyAlive = false;
  exitCode = code ?? 0;
  writeState();
  // Give clients a beat to flush, then leave — a real host would linger briefly.
  setTimeout(() => process.exit(0), 50);
});

// ---- TERMINAL server: raw ttyd `tty` wire protocol ---------------------------
const termHttp = createServer();
const termWss = new WebSocketServer({
  server: termHttp,
  // ttyd negotiates the `tty` subprotocol; xterm.js sends it. Preserve it exactly.
  handleProtocols: (protocols) => (protocols.has('tty') ? 'tty' : false),
});

termWss.on('connection', (ws) => {
  if (termClients.size >= MAX_CLIENTS) { ws.close(1013, 'max clients'); return; }
  termClients.add(ws);
  // ttyd sends SET_PREFERENCES on connect, then the terminal backlog. Replaying the
  // scrollback ring is how a re-attaching client sees the screen it left — the
  // property tmux+ttyd give today via `tmux attach` re-rendering the live pane.
  ws.send(Buffer.concat([S_SET_PREFS, Buffer.from('{}')]));
  if (ring.length) ws.send(Buffer.concat([S_OUTPUT, ring]));

  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length === 0) return;
    switch (buf[0]) {
      case C_JSON_INIT: {
        try {
          const init = JSON.parse(buf.toString('utf8'));
          if (init.columns && init.rows) term.resize(init.columns, init.rows);
        } catch { /* ignore malformed init */ }
        break;
      }
      case C_INPUT:
        term.write(buf.subarray(1).toString('utf8'));
        break;
      case C_RESIZE: {
        try {
          const { columns, rows } = JSON.parse(buf.subarray(1).toString('utf8'));
          if (columns && rows) term.resize(columns, rows);
        } catch { /* ignore */ }
        break;
      }
      case C_PAUSE:
      case C_RESUME:
        break; // flow control not modelled in the spike
      default:
        break;
    }
  });

  ws.on('close', () => termClients.delete(ws));   // DETACH: pty keeps running
  ws.on('error', () => termClients.delete(ws));
});

// ---- CONTROL server: the tmux-CLI replacement the manager drives --------------
const ctrlHttp = createServer();
const ctrlWss = new WebSocketServer({ server: ctrlHttp });

ctrlWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    const reply = (o) => ws.send(JSON.stringify({ id: msg.id, ...o }));
    switch (msg.op) {
      case 'inject':                                   // ~ tmux send-keys / paste + Enter
        term.write(msg.data ?? '');
        if (msg.submit) term.write('\r');
        reply({ ok: true });
        break;
      case 'capture':                                  // ~ tmux capture-pane -p
        reply({ ok: true, data: ring.toString('utf8') });
        break;
      case 'alive':                                    // ~ tmux has-session
        reply({ ok: true, alive: ptyAlive, pid: process.pid, ptyPid: term.pid, exitCode });
        break;
      case 'resize':
        if (msg.columns && msg.rows) term.resize(msg.columns, msg.rows);
        reply({ ok: true });
        break;
      case 'kill':
        reply({ ok: true });
        term.kill();
        break;
      default:
        reply({ ok: false, error: `unknown op ${msg.op}` });
    }
  });
});

// ---- bring both servers up on ephemeral loopback ports, publish state ---------
function writeState() {
  const st = {
    session: SESSION,
    pid: process.pid,
    ptyPid: term.pid,
    termPort: termHttp.address()?.port ?? null,
    ctrlPort: ctrlHttp.address()?.port ?? null,
    shell: SHELL,
    ptyAlive,
    exitCode,
    startedAt: START,
  };
  writeFileSync(STATE, JSON.stringify(st, null, 2));
  return st;
}
const START = new Date().toISOString();

let up = 0;
const onListen = () => { if (++up === 2) { const st = writeState(); process.stdout.write(`PTYHOST_READY ${JSON.stringify(st)}\n`); } };
termHttp.listen(0, '127.0.0.1', onListen);
ctrlHttp.listen(0, '127.0.0.1', onListen);

// KillMode=process semantics: a clean SIGTERM tears the pty down; anything else
// (manager crash/restart) leaves us running to be re-adopted.
process.on('SIGTERM', () => { try { term.kill(); } catch {} process.exit(0); });
