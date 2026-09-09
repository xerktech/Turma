// XERK-668 — CI unit tests for the pure ttyd-protocol module. Stdlib only (no
// node-pty, no ws), so it runs in code-scan.yml's `node --test` with no npm
// install — the reason the wire/auth/framing logic lives apart from the I/O
// shell. The host-proof end-to-end drive (needs node-pty) is `../drive.mjs`,
// excluded from CI exactly like the XERK-667 spike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as T from '../tty-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The command bytes are direction-specific and were read off the real ttyd
// 1.7.7 wire (vendor/ttyd-1.7.7/PROVENANCE.md). Pin them so a "cleanup" that
// swaps a constant — which silently breaks the terminal — fails here.
test('ttyd command bytes match the captured 1.7.7 protocol', () => {
  assert.equal(T.C_INPUT, 0x30);
  assert.equal(T.C_RESIZE, 0x31);
  assert.equal(T.C_PAUSE, 0x32);
  assert.equal(T.C_RESUME, 0x33);
  assert.equal(T.C_JSON_INIT, 0x7b);
  assert.equal(T.S_OUTPUT, 0x30);
  assert.equal(T.S_SET_WINDOW_TITLE, 0x31);   // server '1' is a TITLE, not a resize
  assert.equal(T.S_SET_PREFERENCES, 0x32);    // server '2' is PREFS, not pause
  assert.equal(T.WS_SUBPROTOCOL, 'tty');
});

test('server frame builders prepend the right command byte', () => {
  assert.deepEqual(T.outputFrame('hi'), Buffer.from('0hi'));
  assert.deepEqual(T.windowTitleFrame('bash (h)'), Buffer.from('1bash (h)'));
  const pf = T.preferencesFrame({ fontSize: 12 });
  assert.equal(pf[0], 0x32);
  assert.deepEqual(JSON.parse(pf.subarray(1).toString()), { fontSize: 12 });
});

test('decodeClientFrame classifies every ttyd client frame', () => {
  assert.deepEqual(T.decodeClientFrame(Buffer.from('')), { kind: 'empty' });
  const init = T.decodeClientFrame(Buffer.from(JSON.stringify({ AuthToken: 'x', columns: 80, rows: 24 })));
  assert.equal(init.kind, 'init');
  assert.equal(init.authToken, 'x');
  assert.equal(init.columns, 80);
  const inp = T.decodeClientFrame(Buffer.from('0echo hi\r'));
  assert.equal(inp.kind, 'input');
  assert.equal(inp.data.toString(), 'echo hi\r');
  const rz = T.decodeClientFrame(Buffer.from('1' + JSON.stringify({ columns: 120, rows: 40 })));
  assert.deepEqual([rz.kind, rz.columns, rz.rows], ['resize', 120, 40]);
  assert.equal(T.decodeClientFrame(Buffer.from('2')).kind, 'pause');
  assert.equal(T.decodeClientFrame(Buffer.from('3')).kind, 'resume');
  assert.equal(T.decodeClientFrame(Buffer.from('9x')).kind, 'unknown');
  assert.equal(T.decodeClientFrame(Buffer.from('1not-json')).kind, 'malformed');
});

test('basic auth matches ttyd -c term:<token> and rejects everything else', () => {
  const tok = 's3cret';
  const good = 'Basic ' + Buffer.from('term:s3cret').toString('base64');
  assert.equal(T.basicAuthOk(good, tok), true);
  assert.equal(T.basicAuthOk('Basic ' + Buffer.from('term:wrong').toString('base64'), tok), false);
  assert.equal(T.basicAuthOk('Basic ' + Buffer.from('other:s3cret').toString('base64'), tok), false);
  assert.equal(T.basicAuthOk(undefined, tok), false);
  assert.equal(T.basicAuthOk('Bearer x', tok), false);
  assert.equal(T.basicAuthOk('Basic !!!notbase64', tok), false);
  // An unset token accepts anything (ttyd with no -c).
  assert.equal(T.basicAuthOk(undefined, ''), true);
});

test('/token echoes base64(term:<token>) — the value the ws init must carry', () => {
  const tok = 'abc';
  assert.equal(T.tokenValue(tok), Buffer.from('term:abc').toString('base64'));
  assert.deepEqual(JSON.parse(T.tokenResponseBody(tok)), { token: T.tokenValue(tok) });
  assert.equal(T.initAuthOk(T.tokenValue(tok), tok), true);
  assert.equal(T.initAuthOk('nope', tok), false);
  assert.equal(T.initAuthOk('', ''), true);
});

test('pref flags coerce like ttyd -t (number/bool/string, split on first =)', () => {
  const p = T.parsePrefFlags([
    'fontSize=12',
    'disableLeaveAlert=true',
    'macOptionClickForcesSelection=false',
    'rendererType=webgl',
    'fontFamily=JBMNerd, "A B", monospace',
    'weird=a=b=c',
    'noeq',
    '=novalue',
  ]);
  assert.equal(p.fontSize, 12);
  assert.equal(p.disableLeaveAlert, true);
  assert.equal(p.macOptionClickForcesSelection, false);
  assert.equal(p.rendererType, 'webgl');
  assert.equal(p.fontFamily, 'JBMNerd, "A B", monospace'); // commas/quotes stay a string
  assert.equal(p.weird, 'a=b=c'); // split on FIRST '=' only
  assert.equal('noeq' in p, false);
  assert.equal('' in p, false);
  // The fleet-parity defaults are the exact `-t` set _launch_ttyd passes.
  assert.equal(T.DEFAULT_PREFS.fontSize, 12);
  assert.equal(T.DEFAULT_PREFS.rendererType, 'webgl');
  assert.equal(T.DEFAULT_PREFS.disableLeaveAlert, true);
  assert.equal(T.DEFAULT_PREFS.macOptionClickForcesSelection, true);
  assert.match(T.DEFAULT_PREFS.fontFamily, /JBMNerd/);
});

test('control channel token gate (loopback shared secret on the URL)', () => {
  assert.equal(T.controlTokenOk('/?token=sek', 'sek'), true);
  assert.equal(T.controlTokenOk('/?token=nope', 'sek'), false);
  assert.equal(T.controlTokenOk('/', 'sek'), false);          // no token param
  assert.equal(T.controlTokenOk('/?token=', 'sek'), false);
  assert.equal(T.controlTokenOk('/?token=sek', ''), true);    // unset token = open
  assert.equal(T.constantTimeEqual('abc', 'abc'), true);
  assert.equal(T.constantTimeEqual('abc', 'abd'), false);
  assert.equal(T.constantTimeEqual('abc', 'abcd'), false);    // length differs
});

test('HTTP routing: bare base 302s to the slash form; /, /token, /ws', () => {
  assert.deepEqual(T.routeHttp('/term/abc', '/term/abc'), { kind: 'redirect', location: '/term/abc/' });
  assert.deepEqual(T.routeHttp('/term/abc/', '/term/abc'), { kind: 'index' });
  assert.deepEqual(T.routeHttp('/term/abc/token', '/term/abc'), { kind: 'token' });
  assert.deepEqual(T.routeHttp('/term/abc/other', '/term/abc'), { kind: 'notfound' });
  assert.equal(T.baseRedirectLocation('/term/abc', '/term/abc'), '/term/abc/');
  assert.equal(T.baseRedirectLocation('/term/abc/', '/term/abc'), null);
});

test('scrollback ring keeps a byte-bounded tail', () => {
  const r = new T.ScrollbackRing(8);
  r.append('abcdef');
  r.append('ghij'); // total 10 > 8, keeps last 8
  assert.equal(r.text(), 'cdefghij');
  assert.equal(r.length, 8);
});

test('state (de)serialises the adopt registry', () => {
  const st = { session: 's', pid: 42, ptyPid: 43, base: '/term/s', termPort: 7681, ctrlPort: 7682, shell: 'bash', startedAt: 'now' };
  const back = T.parseState(T.serializeState(st));
  assert.equal(back.pid, 42);
  assert.equal(back.termPort, 7681);
  assert.equal(back.ctrlPort, 7682);
  assert.equal(back.ptyAlive, true);
  assert.throws(() => T.parseState('null'));
});

test('control protocol maps the four tmux roles + resize', () => {
  const events = [];
  const adapter = {
    write: (s) => events.push(['write', s]),
    resize: (c, r) => events.push(['resize', c, r]),
    kill: () => events.push(['kill']),
    capture: () => 'PANE',
    pid: 100, ptyPid: 101, alive: true, exitCode: null,
  };
  assert.deepEqual(T.handleControlMessage({ id: 1, op: 'inject', data: 'ls', submit: true }, adapter), { id: 1, ok: true });
  assert.deepEqual(events, [['write', 'ls'], ['write', '\r']]);
  assert.deepEqual(T.handleControlMessage({ op: 'capture' }, adapter), { ok: true, data: 'PANE' });
  const a = T.handleControlMessage({ op: 'alive' }, adapter);
  assert.deepEqual([a.ok, a.alive, a.pid, a.ptyPid], [true, true, 100, 101]);
  T.handleControlMessage({ op: 'resize', columns: 90, rows: 30 }, adapter);
  assert.deepEqual(events.at(-1), ['resize', 90, 30]);
  T.handleControlMessage({ op: 'kill' }, adapter);
  assert.deepEqual(events.at(-1), ['kill']);
  assert.equal(T.handleControlMessage({ op: 'bogus' }, adapter).ok, false);
  assert.equal(T.handleControlMessage('{bad json', adapter).ok, false);
});

// The DoD is "renders in the hub UI through the existing tunnel". The hub's
// proxyTerm buffers this HTML and injects its font/scroll/OSC52 shims before
// </head>, and those shims + the tmux-scroll pill drive ttyd's `window.term`.
// The ws-proxy re-issues the browser's `tty` upgrade verbatim. So the vendored
// client MUST keep every anchor the hub depends on — assert them here so a
// re-vendor to a future ttyd that dropped one fails in CI, not silently in a
// browser nobody can run on this Linux box.
test('vendored ttyd client keeps every hub-integration anchor', () => {
  const html = readFileSync(join(HERE, '..', 'vendor', 'ttyd-1.7.7', 'index.html'), 'utf8');
  assert.ok(html.includes('</head>'), 'proxyTerm injection anchor');
  assert.ok(html.includes('window.term'), 'the handle TERM_OSC52_JS / TERM_SCROLL_BOTTOM wire onto');
  assert.ok(html.includes('"tty"'), 'the ws subprotocol the ws-proxy forwards');
  assert.ok(html.includes('/token'), 'the credential fetch');
  assert.ok(html.includes('/ws'), 'the ws endpoint under the base path');
  assert.ok(html.includes('window.location.pathname'), 'base-path-agnostic (served under /term/<id>/)');
  assert.ok(html.includes('AuthToken'), 'the ws init credential field');
});

// ---- TerminalGrid: the rendered-screen capture (XERK-703) --------------------
// The bug: Claude Code paints its "esc to interrupt" footer ONCE per turn and
// updates the spinner in place, so the RAW scrollback ring loses the marker once
// a turn streams past its byte window and `_busy_from_capture` reads a working
// session IDLE (firing the "you have uncommitted work" nudge). TerminalGrid
// renders the ring into the visible grid (the tmux capture-pane -p analog) where
// the footer is a persistent element. Driven against REAL captured Claude output
// (fixtures/, provenance there); the grid is fed EVERY byte, not the ring tail.
const WORKING = readFileSync(join(HERE, 'fixtures', 'claude-working-turn.raw'));
const DIALOG = readFileSync(join(HERE, 'fixtures', 'claude-trust-dialog.raw'));

function feed(bytes, cols, rows, chunk) {
  const g = new T.TerminalGrid(cols, rows);
  for (let i = 0; i < bytes.length; i += chunk) g.write(bytes.subarray(i, i + chunk));
  return g;
}

test('a working turn reads BUSY off the rendered grid where the raw ring reads idle', () => {
  // Mid-turn: the model is still streaming. The interrupt hint was painted at the
  // very start and has long since scrolled out of a bounded raw byte window.
  const mid = WORKING.subarray(0, 30000);
  const ringTail = mid.subarray(mid.length - 20000).toString('utf8');   // what capture returned before
  assert.ok(!ringTail.includes('esc to interrupt'),
    'the raw ring tail has lost the paint-once footer — the false-idle bug');
  const grid = feed(mid, 100, 40, mid.length).capture();
  assert.ok(grid.includes('esc to interrupt'),
    'the rendered grid keeps the footer as a persistent screen element');
  // And the mode-footer glyph parse (parse_pane_mode) now has real text to read.
  assert.ok(grid.includes('plan mode on'));
});

test('turn completion reads IDLE off the rendered grid (no false busy)', () => {
  const grid = feed(WORKING, 100, 40, WORKING.length).capture();
  assert.ok(!grid.includes('esc to interrupt'), 'the finished turn dropped the hint');
  assert.ok(grid.includes('❯'), 'the idle prompt is back');   // the ❯ prompt
});

test('the rendered grid is stable across arbitrary pty chunk boundaries', () => {
  // The pty delivers arbitrary chunks; an escape sequence split across two writes
  // must not corrupt the grid. Every chunk size must produce the identical screen.
  const whole = feed(WORKING, 100, 40, WORKING.length).capture();
  for (const chunk of [1, 7, 13, 100, 4096]) {
    assert.equal(feed(WORKING, 100, 40, chunk).capture(), whole, `chunk size ${chunk}`);
  }
});

test('per-word cursor-positioned dialog text renders as readable lines', () => {
  // Claude lays dialog words out with \x1b[NG column moves, not spaces — the raw
  // stream has no contiguous phrases, so only the rendered grid can be parsed.
  const grid = feed(DIALOG, 100, 40, DIALOG.length).capture();
  assert.ok(grid.includes('Yes, I trust this folder'));
  assert.ok(grid.includes('No, exit'));
});

test('TerminalGrid handles erase, scroll region and resize without throwing', () => {
  const g = new T.TerminalGrid(20, 5);
  g.write('\x1b[2J\x1b[H');                       // clear + home
  g.write('line one\r\nline two');
  assert.ok(g.capture().includes('line one'));
  g.write('\x1b[1;3r');                           // a scroll region
  g.write('\x1b[10;10H' + 'x'.repeat(50));        // out-of-range cursor + autowrap (no throw)
  // Resize PRESERVES the overlapping region (no transient blank -> no false idle
  // in the gap before the app's repaint).
  g.resize(40, 10);
  assert.ok(g.capture().includes('line one'), 'content survives a resize');
  g.write('\x1b[2J\x1b[Hafter');                  // the app's post-SIGWINCH repaint
  assert.equal(g.capture(), 'after');
});
