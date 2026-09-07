// THROWAWAY SPIKE (XERK-667) — not production code. See README.md.
//
// Plays the role of the MANAGER (hub-agent.py). Spawns one detached pty-host and
// proves the terminal-layer properties the ADR's Decision A depends on, each mapped
// to the Linux mechanism it replaces:
//
//   1. SPAWN     — a persistent pty-host comes up on loopback           (tmux new-session)
//   2. ATTACH    — a ttyd-`tty`-protocol ws client drives the pty       (ttyd + tmux attach)
//   3. DETACH    — client closes; the pty keeps running                 (browser tab closed)
//   4. REATTACH  — a NEW client gets the scrollback + live I/O          (re-open ttyd; pane redraw)
//   5. CONTROL   — inject/capture/liveness without the terminal ws      (send-keys/capture-pane/has-session)
//   6. ADOPT     — a fresh manager re-adopts the surviving host from    (resume_on_boot: registry
//                  the persisted {pid,ports} state file ALONE            pid+port probe, KillMode=process)
//   7. TEARDOWN  — an explicit kill stops the pty and the host exits
//
// Exit code 0 iff every check passes. Evidence is appended to evidence.txt.

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { readFileSync, existsSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'pty-host.state.json');
const HOSTLOG = join(HERE, 'pty-host.log');
const EVIDENCE = join(HERE, 'evidence.txt');
const SESSION = 'spikeA';

const results = [];
function log(line) { process.stdout.write(line + '\n'); appendFileSync(EVIDENCE, line + '\n'); }
function check(name, ok, detail = '') {
  results.push({ name, ok });
  log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A ttyd-`tty` terminal client: sends the init JSON + INPUT frames, collects OUTPUT.
function termClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/term/${SESSION}`, ['tty']);
  const state = { ws, out: '', protocol: null, opened: false, prefsSeen: false };
  ws.binaryType = 'arraybuffer';
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => {
      state.opened = true;
      state.protocol = ws.protocol;
      // ttyd init frame: '{ "AuthToken":"", "columns":C, "rows":R }' (starts with '{')
      ws.send(Buffer.from(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 })));
      resolve();
    });
    ws.on('error', reject);
  });
  ws.on('message', (data) => {
    const buf = Buffer.from(data);
    if (buf.length === 0) return;
    const cmd = buf[0];
    const body = buf.subarray(1).toString('utf8');
    if (cmd === 0x32) state.prefsSeen = true;         // SET_PREFERENCES
    else if (cmd === 0x30) state.out += body;         // OUTPUT
  });
  state.input = (s) => ws.send(Buffer.concat([Buffer.from('0'), Buffer.from(s)])); // INPUT frame
  state.close = () => new Promise((res) => { ws.once('close', res); ws.close(); });
  state.ready = ready;
  return state;
}

async function waitFor(getText, needle, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (getText().includes(needle)) return true; await sleep(50); }
  return false;
}

// A JSON control client: the tmux-CLI replacement the manager speaks.
function ctrlClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString('utf8'));
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const rpc = (op, extra = {}) => new Promise((resolve) => {
    const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, op, ...extra }));
  });
  return { ready, rpc, close: () => ws.close() };
}

async function main() {
  writeFileSync(EVIDENCE, `# XERK-667 terminal-layer spike — ${new Date().toISOString()}\n`);
  log(`node ${process.version} · platform ${process.platform}/${process.arch} · node-pty backend = ${process.platform === 'win32' ? 'ConPTY' : 'forkpty'}`);
  for (const f of [STATE, HOSTLOG]) if (existsSync(f)) unlinkSync(f);

  // --- 1. SPAWN: start the pty-host DETACHED so it outlives this "manager" ------
  log('\n[1] SPAWN — persistent pty-host, detached (survives manager exit)');
  const out = (await import('node:fs')).openSync(HOSTLOG, 'a');
  const child = spawn(process.execPath, [
    join(HERE, 'pty-host.mjs'), '--session', SESSION, '--state', STATE, '--shell', '/bin/bash',
  ], { detached: true, stdio: ['ignore', out, out] });
  child.unref();                                       // the manager no longer owns it

  let st = null;
  for (let i = 0; i < 100 && !st; i++) {
    await sleep(50);
    if (existsSync(STATE)) { try { const j = JSON.parse(readFileSync(STATE, 'utf8')); if (j.termPort && j.ctrlPort) st = j; } catch {} }
  }
  check('pty-host published state with loopback ports', !!st, st ? `pid=${st.pid} term=${st.termPort} ctrl=${st.ctrlPort}` : 'no state file');
  if (!st) return finish();
  check('pty-host pid is alive', pidAlive(st.pid));

  // --- 2. ATTACH ---------------------------------------------------------------
  log('\n[2] ATTACH — ttyd-`tty` ws client A drives the pty');
  const a = termClient(st.termPort);
  await a.ready;
  check("negotiated ttyd 'tty' subprotocol", a.protocol === 'tty', `got '${a.protocol}'`);
  a.input('echo SPIKE_MARK_A\r');
  const sawA = await waitFor(() => a.out, 'SPIKE_MARK_A');
  check('client A sees its own command output over the ws', sawA);

  // --- 3. DETACH ---------------------------------------------------------------
  log('\n[3] DETACH — close client A; pty must keep running');
  await a.close();
  await sleep(150);
  const ctrl = ctrlClient(st.ctrlPort); await ctrl.ready;
  const alive1 = await ctrl.rpc('alive');
  check('pty still alive after the only client detached', alive1.alive === true, `ptyPid=${alive1.ptyPid}`);

  // --- 4. REATTACH -------------------------------------------------------------
  log('\n[4] REATTACH — new client B gets scrollback replay + live I/O');
  const b = termClient(st.termPort);
  await b.ready;
  const replayA = await waitFor(() => b.out, 'SPIKE_MARK_A', 1500);
  check('client B receives the pre-detach scrollback on connect', replayA);
  b.input('echo SPIKE_MARK_B\r');
  const liveB = await waitFor(() => b.out, 'SPIKE_MARK_B');
  check('client B has live I/O after reattach', liveB);

  // --- 5. CONTROL channel (tmux-CLI replacement) -------------------------------
  log('\n[5] CONTROL — inject/capture/liveness without the terminal ws');
  const inj = await ctrl.rpc('inject', { data: 'echo SPIKE_MARK_CTRL', submit: true });
  check('inject accepted (send-keys analog)', inj.ok === true);
  let cap = { data: '' };
  for (let i = 0; i < 40; i++) { cap = await ctrl.rpc('capture'); if (cap.data.includes('SPIKE_MARK_CTRL')) break; await sleep(50); }
  check('capture returns injected output (capture-pane analog)', cap.data.includes('SPIKE_MARK_CTRL'));
  const liveOnB = await waitFor(() => b.out, 'SPIKE_MARK_CTRL', 1500);
  check('injected input also reaches the live terminal (one shared pty)', liveOnB);

  // --- 6. ADOPT-AFTER-RESTART --------------------------------------------------
  log('\n[6] ADOPT — a fresh manager re-adopts from the state file alone');
  await b.close(); ctrl.close();                       // drop ALL in-memory handles
  await sleep(150);
  const persisted = JSON.parse(readFileSync(STATE, 'utf8'));   // = resume_on_boot reading the registry
  check('surviving host discoverable by persisted pid+port only', pidAlive(persisted.pid) && !!persisted.termPort);
  const ctrl2 = ctrlClient(persisted.ctrlPort); await ctrl2.ready;
  const cap2 = await ctrl2.rpc('capture');
  check('re-adopted host still holds prior scrollback', cap2.data.includes('SPIKE_MARK_B'));
  const c = termClient(persisted.termPort); await c.ready;
  c.input('echo SPIKE_MARK_ADOPT\r');
  const liveC = await waitFor(() => c.out, 'SPIKE_MARK_ADOPT');
  check('re-adopted terminal has live I/O', liveC);

  // --- 7. TEARDOWN -------------------------------------------------------------
  log('\n[7] TEARDOWN — explicit kill stops the pty and the host exits');
  await ctrl2.rpc('kill');
  await c.close(); ctrl2.close();
  let gone = false;
  for (let i = 0; i < 60; i++) { if (!pidAlive(persisted.pid)) { gone = true; break; } await sleep(50); }
  check('host process exited after kill', gone);

  finish();
}

function finish() {
  const pass = results.filter((r) => r.ok).length;
  const total = results.length;
  log(`\nRESULT: ${pass}/${total} checks passed`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => { log('DRIVER ERROR: ' + (e?.stack || e)); process.exit(2); });
