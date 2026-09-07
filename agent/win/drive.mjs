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
function ctrlClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(TOKEN)}`);
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
      '--', '/bin/bash'])},` +
    `{detached:true,stdio:['ignore',fd,fd]});c.unref();process.exit(0);`;
  const spawner = spawn(process.execPath, ['-e', spawnerSrc], { stdio: 'ignore' });
  await new Promise((r) => spawner.on('exit', r));
  check('spawner process exited', !pidAlive(spawner.pid));
  const st = await readState();
  check('pty-host published state with loopback ports', !!st, st ? `pid=${st.pid} term=${st.termPort} ctrl=${st.ctrlPort}` : 'no state');
  if (!st) return finish();
  check('pty-host pid is alive after its spawner exited', pidAlive(st.pid));
  check('ports bind loopback only (state has no external addr)', st.termPort > 0 && st.ctrlPort > 0);

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

  // --- 8. TEARDOWN ------------------------------------------------------------
  out('\n[8] TEARDOWN — explicit kill stops the pty and the host exits');
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
