// XERK-668 — host-proof end-to-end drive of the production pty-host. Plays the
// MANAGER (hub-agent.py) and a BROWSER (the hub's proxied ttyd client), proving
// every property the DoD needs on a real pty. Needs node-pty + ws installed
// (`npm ci` in this dir), so it is EXCLUDED from CI (its filename is not
// `*.test.mjs`) exactly like the XERK-667 spike — run it via the recipe in
// README.md. On Linux node-pty binds forkpty; on Windows the identical API binds
// ConPTY. What this canNOT prove (ConPTY in a Session-0 service, job-object
// breakaway) stays the ADR's open questions for the service child.
//
// Exit 0 iff every check passes.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { readFileSync, existsSync, unlinkSync, appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'pty-host.drive.state.json');
const HOSTLOG = join(HERE, 'pty-host.drive.log');
// Evidence is written SYNCHRONOUSLY to a file (not just stdout): the pty-host is
// detached, so a wrapper that waits on it can be killed before Node flushes its
// block-buffered stdout — the file survives that. Same idea as the spike's
// evidence.txt.
const EVIDENCE = join(HERE, 'drive-evidence.txt');
function out(line) { process.stdout.write(line + '\n'); try { appendFileSync(EVIDENCE, line + '\n'); } catch {} }
const SESSION = 'driveA';
const TOKEN = 'drive-secret-token';
// The manager-owned file the pty-host re-reads its auth token from per check, so
// a hub token ROLL needs no relaunch (which here would kill the operator's
// claude, the pty-host being both the terminal and the pty). Section [9] drives
// the roll end to end.
const TOKENFILE = join(HERE, 'pty-host.drive.token');
const ROLLED_TOKEN = 'drive-rolled-token';
// The pty child. node-pty binds forkpty on POSIX and ConPTY on Windows; the child
// must be a shell that actually exists on the host (there is no `/bin/bash` on a
// native Windows box), or ConPTY/CreateProcess fails at spawn and the whole drive
// aborts. `echo <marker>` — the only child command the checks below rely on —
// prints the marker in both cmd.exe and a POSIX shell.
const CHILD_CMD = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/bash';
const BASE = `/term/${SESSION}`;
const CRED = 'Basic ' + Buffer.from(`term:${TOKEN}`).toString('base64');
const AUTH_TOKEN = Buffer.from(`term:${TOKEN}`).toString('base64'); // the /token value + ws init AuthToken

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  out(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitFor(getText, needle, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (getText().includes(needle)) return true; await sleep(50); }
  return false;
}

// A ttyd-`tty` terminal client (the browser half), authenticated like the hub.
function termClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${BASE}/ws`, ['tty'], { headers: { Authorization: CRED } });
  const st = { ws, out: '', prefs: null, title: null, protocol: null };
  ws.binaryType = 'arraybuffer';
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => { st.protocol = ws.protocol; ws.send(JSON.stringify({ AuthToken: AUTH_TOKEN, columns: 80, rows: 24 })); resolve(); });
    ws.on('error', reject);
  });
  ws.on('message', (data) => {
    const b = Buffer.from(data);
    if (b.length === 0) return;
    if (b[0] === 0x30) st.out += b.subarray(1).toString('utf8');          // OUTPUT
    else if (b[0] === 0x31) st.title = b.subarray(1).toString('utf8');    // SET_WINDOW_TITLE
    else if (b[0] === 0x32) { try { st.prefs = JSON.parse(b.subarray(1).toString('utf8')); } catch {} } // SET_PREFERENCES
  });
  st.input = (s) => ws.send(Buffer.concat([Buffer.from('0'), Buffer.from(s)]));
  st.close = () => new Promise((res) => { ws.once('close', res); ws.close(); });
  st.ready = ready;
  return st;
}

// The JSON control client (the manager's tmux-CLI replacement).
function ctrlClient(port, token = TOKEN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString('utf8')); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const rpc = (op, extra = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, op, ...extra })); });
  return { ready, rpc, close: () => ws.close() };
}

async function readState(ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(STATE)) { try { const j = JSON.parse(readFileSync(STATE, 'utf8')); if (j.termPort && j.ctrlPort) return j; } catch {} }
    await sleep(50);
  }
  return null;
}

async function main() {
  try { writeFileSync(EVIDENCE, ''); } catch {}
  out(`node ${process.version} · ${process.platform}/${process.arch} · node-pty backend = ${process.platform === 'win32' ? 'ConPTY' : 'forkpty'}`);
  for (const f of [STATE, HOSTLOG]) if (existsSync(f)) unlinkSync(f);
  writeFileSync(TOKENFILE, TOKEN);   // what the manager publishes at boot

  // --- 1. SPAWN via a THROWAWAY spawner that EXITS, proving the child outlives
  //        its spawner (the KillMode=process / manager-restart property) --------
  out('\n[1] SPAWN — detached pty-host outlives a spawner that exits');
  // An intermediate `node -e` spawns the pty-host detached then exits at once, so
  // the pty-host is orphaned to init — exactly a manager restart under systemd.
  // The spawner opens its OWN log fd (a fd from THIS process is meaningless in
  // the spawner's namespace), exactly as the real manager opens a per-session log.
  const spawnerSrc = `const {spawn}=require('child_process'),fs=require('fs');` +
    `const fd=fs.openSync(${JSON.stringify(HOSTLOG)},'a');` +
    `const c=spawn(process.execPath,` +
    `${JSON.stringify([join(HERE, 'pty-host.mjs'),
      '--session', SESSION, '--base-path', BASE, '--state', STATE, '--auth-token', TOKEN,
      '--auth-token-file', TOKENFILE,
      '--', CHILD_CMD])},` +
    `{detached:true,stdio:['ignore',fd,fd]});c.unref();process.exit(0);`;
  const spawner = spawn(process.execPath, ['-e', spawnerSrc], { stdio: 'ignore' });
  await new Promise((r) => spawner.on('exit', r));
  check('spawner process exited', !pidAlive(spawner.pid));
  const st = await readState();
  check('pty-host published state with loopback ports', !!st, st ? `pid=${st.pid} term=${st.termPort} ctrl=${st.ctrlPort}` : 'no state');
  if (!st) return finish();
  check('pty-host pid is alive after its spawner exited', pidAlive(st.pid));
  check('ports bind loopback only (state has no external addr)', st.termPort > 0 && st.ctrlPort > 0);

  // --- 1b. BIND FAILURE — no orphaned pty when a port is taken ----------------
  // The pty child used to be spawned at module top, BEFORE either server bound,
  // and neither server had an 'error' listener — so EADDRINUSE (a squatter, or a
  // teardown that left the old port held) was an uncaught throw that killed the
  // process with the child ALREADY RUNNING under the pty, leaking a process
  // nothing could reach. Bind first, spawn second, and say why in the log.
  out('\n[1b] BIND FAILURE — a taken port exits cleanly with a reason, no orphan');
  const squatter = net.createServer(() => {});
  await new Promise((r) => squatter.listen(0, '127.0.0.1', r));
  const taken = squatter.address().port;
  const failLog = join(HERE, 'pty-host.drive.bindfail.log');
  if (existsSync(failLog)) unlinkSync(failLog);
  const failState = join(HERE, 'pty-host.drive.bindfail.state.json');
  if (existsSync(failState)) unlinkSync(failState);
  const doomed = spawn(process.execPath, [
    join(HERE, 'pty-host.mjs'), '--session', 'driveBind', '--base-path', '/term/driveBind',
    '--state', failState, '--auth-token', TOKEN, '--term-port', String(taken),
    '--', CHILD_CMD,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let failErr = '';
  doomed.stderr.on('data', (d) => { failErr += d.toString(); });
  const failCode = await new Promise((r) => doomed.on('exit', r));
  check('a taken terminal port exits NON-ZERO instead of throwing', failCode !== 0, `exit=${failCode}`);
  check('the log says which server and why', /failed to bind/.test(failErr) && /EADDRINUSE/.test(failErr), failErr.trim().split('\n')[0]);
  check('no state file was published for the failed launch', !existsSync(failState));
  squatter.close();

  // --- 2. HTTP SURFACE — the ttyd client contract the hub proxies -------------
  out('\n[2] HTTP — ttyd client surface (302 / index / token / auth)');
  const b = `http://127.0.0.1:${st.termPort}`;
  const r302 = await fetch(`${b}${BASE}?x=1`, { headers: { Authorization: CRED }, redirect: 'manual' });
  check('bare base 302s to the slash form, query preserved', r302.status === 302 && r302.headers.get('location') === `${BASE}/?x=1`, `loc=${r302.headers.get('location')}`);
  const rNoAuth = await fetch(`${b}${BASE}/`, { redirect: 'manual' });
  check('index requires basic auth (401 without)', rNoAuth.status === 401);
  const rIdx = await fetch(`${b}${BASE}/`, { headers: { Authorization: CRED } });
  const html = await rIdx.text();
  check('index serves the vendored ttyd client', rIdx.status === 200 && html.includes('window.term') && html.includes('"tty"'), `${html.length}B`);
  const rTok = await fetch(`${b}${BASE}/token`, { headers: { Authorization: CRED } });
  const tokJson = await rTok.json();
  check('/token returns base64(term:<token>)', tokJson.token === AUTH_TOKEN);
  // A ws upgrade with NO auth must be refused.
  const bad = new WebSocket(`ws://127.0.0.1:${st.termPort}${BASE}/ws`, ['tty']);
  const badRejected = await new Promise((res) => { bad.on('open', () => { bad.close(); res(false); }); bad.on('error', () => res(true)); });
  check('ws upgrade without basic auth is refused', badRejected);

  // --- 3. ATTACH --------------------------------------------------------------
  out('\n[3] ATTACH — tty ws: subprotocol, title, prefs, output');
  const a = termClient(st.termPort);
  await a.ready;
  check("negotiated ttyd 'tty' subprotocol", a.protocol === 'tty', `got '${a.protocol}'`);
  await sleep(200);
  check('server sent SET_WINDOW_TITLE on connect', typeof a.title === 'string' && a.title.length > 0, JSON.stringify(a.title));
  check('server sent SET_PREFERENCES with the fleet-parity -t flags', a.prefs && a.prefs.fontSize === 12 && a.prefs.rendererType === 'webgl', JSON.stringify(a.prefs));
  a.input('echo DRIVE_MARK_A\r');
  check('client A sees its own command output', await waitFor(() => a.out, 'DRIVE_MARK_A'));

  // --- 4. DETACH --------------------------------------------------------------
  out('\n[4] DETACH — close A; pty keeps running');
  await a.close();
  await sleep(150);
  const ctrl = ctrlClient(st.ctrlPort); await ctrl.ready;
  const alive1 = await ctrl.rpc('alive');
  check('pty still alive after the only client detached', alive1.alive === true, `ptyPid=${alive1.ptyPid}`);

  // --- 5. REATTACH ------------------------------------------------------------
  out('\n[5] REATTACH — new client gets scrollback replay + live I/O');
  const c = termClient(st.termPort); await c.ready;
  check('client B receives the pre-detach scrollback', await waitFor(() => c.out, 'DRIVE_MARK_A', 1500));
  c.input('echo DRIVE_MARK_B\r');
  check('client B has live I/O after reattach', await waitFor(() => c.out, 'DRIVE_MARK_B'));

  // --- 6. CONTROL -------------------------------------------------------------
  out('\n[6] CONTROL — inject/capture/resize off the terminal ws');
  const inj = await ctrl.rpc('inject', { data: 'echo DRIVE_MARK_CTRL', submit: true });
  check('inject accepted (send-keys analog)', inj.ok === true);
  let cap = { data: '' };
  for (let i = 0; i < 40; i++) { cap = await ctrl.rpc('capture'); if (cap.data.includes('DRIVE_MARK_CTRL')) break; await sleep(50); }
  check('capture returns injected output (capture-pane analog)', cap.data.includes('DRIVE_MARK_CTRL'));
  check('injected input also reaches the live terminal (one shared pty)', await waitFor(() => c.out, 'DRIVE_MARK_CTRL', 1500));
  const rz = await ctrl.rpc('resize', { columns: 100, rows: 30 });
  check('resize accepted', rz.ok === true);

  // --- 7. ADOPT ---------------------------------------------------------------
  out('\n[7] ADOPT — a fresh manager re-adopts from the state file alone');
  await c.close(); ctrl.close();
  await sleep(150);
  const persisted = JSON.parse(readFileSync(STATE, 'utf8'));   // = resume_on_boot reading the registry
  check('surviving host discoverable by persisted pid+ports only', pidAlive(persisted.pid) && !!persisted.termPort && !!persisted.ctrlPort);
  const ctrl2 = ctrlClient(persisted.ctrlPort); await ctrl2.ready;
  const cap2 = await ctrl2.rpc('capture');
  check('re-adopted host still holds prior scrollback', cap2.data.includes('DRIVE_MARK_B'));
  const d = termClient(persisted.termPort); await d.ready;
  d.input('echo DRIVE_MARK_ADOPT\r');
  check('re-adopted terminal has live I/O', await waitFor(() => d.out, 'DRIVE_MARK_ADOPT'));

  // --- 8. KEEP-ALIVE ----------------------------------------------------------
  // The hub pools tunnel channels in a keep-alive http.Agent and reuses a FREE
  // one for the next asset/token request. Node's DEFAULT server keepAliveTimeout
  // is 5_000ms, far below the hub's idle window, so the hub eventually sent a
  // request down a socket already FIN'd — the browser's ECONNRESET / "socket
  // hang up" on terminal open, which is why the class is new on Windows (ttyd's
  // libwebsockets held connections far longer). Prove the origin outlasts it by
  // reusing ONE socket across an idle gap longer than that default.
  out('\n[8] KEEP-ALIVE — one socket survives an idle gap past Node\'s 5s default');
  const req = (sock) => new Promise((res, rej) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, i));
      const need = i + 4 + (m ? Number(m[1]) : 0);
      if (buf.length < need) return;
      sock.off('data', onData);
      res(buf.slice(0, need));
    };
    sock.on('data', onData);
    sock.once('error', rej);
    sock.write(`GET ${BASE}/token HTTP/1.1\r\nHost: x\r\nAuthorization: ${CRED}\r\nConnection: keep-alive\r\n\r\n`);
  });
  const ka = net.connect(st.termPort, '127.0.0.1');
  await new Promise((r, j) => { ka.once('connect', r); ka.once('error', j); });
  const first = await req(ka);
  check('first request on a fresh socket answers 200', first.startsWith('HTTP/1.1 200'));
  await sleep(7000);   // > Node's 5_000ms default keepAliveTimeout
  check('socket still open after a 7s idle gap (origin keep-alive raised)', !ka.destroyed && ka.writable);
  let second = '';
  try { second = await req(ka); } catch (e) { second = 'ERROR ' + (e && e.code); }
  check('the SAME socket answers a second request after the gap', second.startsWith('HTTP/1.1 200'), second.split('\r\n')[0]);
  ka.destroy();

  // --- 9. TOKEN ROLL ----------------------------------------------------------
  // The XERK-578 roll, which on this platform must NOT cost the session. The
  // manager rewrites the token file; the live pty-host picks it up on its very
  // next auth check, with the pty (and its child) untouched.
  out('\n[9] TOKEN ROLL — the live token file is obeyed without a relaunch');
  const rolledCred = 'Basic ' + Buffer.from(`term:${ROLLED_TOKEN}`).toString('base64');
  writeFileSync(TOKENFILE, ROLLED_TOKEN + '\n');   // trailing newline on purpose
  const rOld = await fetch(`${b}${BASE}/token`, { headers: { Authorization: CRED }, redirect: 'manual' });
  check('the pre-roll credential is refused', rOld.status === 401, `status=${rOld.status}`);
  const rNew = await fetch(`${b}${BASE}/token`, { headers: { Authorization: rolledCred } });
  const rolledJson = rNew.ok ? await rNew.json() : {};
  check('the rolled credential is accepted', rNew.status === 200 &&
    rolledJson.token === Buffer.from(`term:${ROLLED_TOKEN}`).toString('base64'));
  check('the pty SURVIVED the roll (no relaunch)', pidAlive(persisted.pid));
  const ctrlRolled = ctrlClient(persisted.ctrlPort, ROLLED_TOKEN); await ctrlRolled.ready;
  const capRolled = await ctrlRolled.rpc('capture');
  check('the manager drives control on the rolled token', typeof capRolled.data === 'string');
  check('the scrollback is intact across the roll', capRolled.data.includes('DRIVE_MARK_ADOPT'));
  // An unreadable file must fall back to the BAKED token, never to an empty one
  // (an empty token means "no auth required" and would open the control channel).
  unlinkSync(TOKENFILE);
  const rFallback = await fetch(`${b}${BASE}/token`, { headers: { Authorization: CRED } });
  check('a deleted token file falls back to the baked token, not to open access',
    rFallback.status === 200);
  ctrlRolled.close();

  // --- 10. TEARDOWN -----------------------------------------------------------
  out('\n[10] TEARDOWN — explicit kill stops the pty and the host exits');
  await ctrl2.rpc('kill');
  await d.close(); ctrl2.close();
  let gone = false;
  for (let i = 0; i < 80; i++) { if (!pidAlive(persisted.pid)) { gone = true; break; } await sleep(50); }
  check('host process exited after control kill', gone);

  finish();
}

function finish() {
  const pass = results.filter((r) => r.ok).length;
  out(`\nRESULT: ${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => { out('DRIVER ERROR: ' + (e?.stack || e)); process.exit(2); });
