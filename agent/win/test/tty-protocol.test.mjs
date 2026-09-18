// XERK-668 — CI unit tests for the pure ttyd-protocol module. Stdlib only (no
// node-pty, no ws), so it runs in code-scan.yml's `node --test` with no npm
// install — the reason the wire/auth/framing logic lives apart from the I/O
// shell. The host-proof end-to-end drive (needs node-pty) is `../drive.mjs`,
// excluded from CI exactly like the XERK-667 spike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
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

test('BOTH the live file token and the baked one are in force', () => {
  // A hub token ROLL used to be fatal here in a way it never is on Linux. There
  // the manager kills the stale ttyd and relaunches it while tmux (and the claude
  // in it) lives on; here the pty-host IS the pty, so a relaunch kills the
  // operator's session — and leaving it running left an unrecoverable zombie: the
  // terminal 401s into a browser password prompt, the ws upgrade is refused, AND
  // the manager's own control channel stops authenticating, so capture/inject/kill
  // silently fail while the pid stays alive and the session reports `running`
  // forever. So the token comes from a manager-owned file re-read per auth check.
  assert.deepEqual(T.authTokensInForce('rolled', 'baked'), ['rolled', 'baked']);
  assert.deepEqual(T.authTokensInForce('  rolled\n', 'baked'), ['rolled', 'baked'],
    'the file is written with a trailing newline by some editors');
  // The BAKED token must stay valid. Letting the file OUTRANK it would hand any
  // stale or failed-to-update file the power to lock the MANAGER — which
  // authenticates with its env TURMA_TOKEN — out of a pty-host it just spawned,
  // recreating the zombie by another door, and would make "a failed publish leaves
  // the baked token in force" untrue.
  assert.ok(T.authTokensInForce('rolled', 'baked').includes('baked'));
  // Every "cannot read it" shape degrades to the baked token alone, never to an
  // EMPTY one — an empty token means "no auth required" to basicAuthOk, which
  // would silently open the control channel that accepts inject/kill.
  for (const bad of [null, undefined, '', '   ', '\n', 42, {}]) {
    assert.deepEqual(T.authTokensInForce(bad, 'baked'), ['baked'],
      `fallback for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(T.authTokensInForce('same', 'same'), ['same'], 'deduped');
  const hdr = (t) => 'Basic ' + Buffer.from(`term:${t}`).toString('base64');
  const ok = (text, baked, sent) =>
    T.authTokensInForce(text, baked).some((t) => T.basicAuthOk(hdr(sent), t));
  assert.equal(ok('rolled', 'baked', 'rolled'), true);
  assert.equal(ok('rolled', 'baked', 'baked'), true, 'the manager is never locked out');
  assert.equal(ok('rolled', 'baked', 'other'), false);
  assert.equal(ok(null, 'baked', ''), false, 'an unreadable file never opens auth');
});

test('serializeState publishes EVERY key the pty-host writes', () => {
  // serializeState is a WHITELIST, and pty-host.mjs is never imported by CI (it
  // needs node-pty), so a field added to writeState() but not here is silently
  // dropped and the manager reads its ABSENCE as fact. That exact omission shipped
  // once: `authTokenFile` never reached the state file, so the manager's post-roll
  // self-heal always took its destructive branch and a token roll tore down every
  // live session — while a python test that hand-wrote the field into a fake state
  // file stayed green. Read the writer's object literal out of the source and hold
  // the two sides together.
  const src = readFileSync(join(HERE, '..', 'pty-host.mjs'), 'utf8');
  const body = /function writeState\(\) \{\s*const st = \{([\s\S]*?)\n  \};/.exec(src);
  assert.ok(body, 'writeState() moved or changed shape');
  // Strip comments first, then take every `name:` that opens a line or follows a
  // comma. The writer spells every key out (no shorthand) so this sees them all.
  const literal = body[1].replace(/\/\/[^\n]*/g, '');
  // Split the literal into TOP-LEVEL entries and require every one of them to be
  // an explicit `name:`. Matching `name:` alone would let the three natural ways
  // of adding the next field slip straight through — `newKey,` (shorthand, which
  // is what the writer used before this guard existed), a `...spread`, and an
  // `st.newKey = …` assignment after the literal — each re-opening the exact hole
  // that shipped as the destructive token-roll branch.
  const entries = [];
  let depth = 0, cur = '';
  for (const ch of literal) {
    if ('{(['.includes(ch)) depth++;
    else if ('})]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { entries.push(cur); cur = ''; } else cur += ch;
  }
  entries.push(cur);
  const written = new Set();
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(e);
    assert.ok(m, `writeState() entry ${JSON.stringify(e)} is not an explicit ` +
      '"name:" — shorthand and spreads are invisible to this guard, so spell it out');
    written.add(m[1]);
  }
  // Nothing may be bolted onto `st` after the literal either.
  const after = /function writeState\(\) \{[\s\S]*?\n  \};([\s\S]*?)\n\}/.exec(src);
  assert.ok(after, 'writeState() moved or changed shape');
  assert.ok(!/\bst\s*(\.\w+|\[)\s*=[^=]/.test(after[1].replace(/\/\/[^\n]*/g, '')),
    'writeState() assigns a field to `st` AFTER the literal, where the guard ' +
    'cannot see it — put it in the literal');
  assert.ok(written.has('authTokenFile'), 'sanity: the writer still has the field');
  // Every field populated: JSON.stringify omits an `undefined` value entirely, so
  // a sparse input would under-report what serializeState publishes.
  const full = Object.fromEntries(T.STATE_KEYS.map((k) => [k, `v-${k}`]));
  const published = new Set(Object.keys(JSON.parse(T.serializeState(full))));
  assert.deepEqual([...T.STATE_KEYS].sort(), [...published].sort(),
    'STATE_KEYS must describe what serializeState actually emits');
  for (const k of written) {
    assert.ok(published.has(k),
      `pty-host writeState() sets "${k}" but serializeState drops it — the manager ` +
      'will read its absence as fact');
  }
  // ...and it round-trips a real value, not just the key.
  const st = JSON.parse(T.serializeState({ session: 's', pid: 1, base: '/term/s', startedAt: 'now', authTokenFile: '/x/auth-token' }));
  assert.equal(st.authTokenFile, '/x/auth-token');
  assert.equal(JSON.parse(T.serializeState({})).authTokenFile, null);
});

test('the token-file cache key moves when the file is ROLLED', () => {
  // The read is cached on this key, so a key that misses a roll leaves the OLD
  // token in force and locks the manager out until the pty-host is relaunched.
  // The production roll is `os.replace` of a DERIVED token — a fixed-length
  // secret — so the replacement is typically the SAME SIZE as what it replaces:
  // a size-only (or size-dominated) key never notices it. Drive exactly that.
  const base = { mtimeMs: 1700000000000, size: 64, ino: 4242, dev: 66310 };
  const key = T.tokenCacheKey(base);
  assert.equal(T.tokenCacheKey({ ...base }), key, 'same stat must hit the cache');
  // os.replace: new inode, IDENTICAL size, and (worst case, coarse clock) the
  // same mtime. Only `ino` saves this one.
  assert.notEqual(T.tokenCacheKey({ ...base, ino: 4243 }), key, 'an os.replace roll must MISS');
  // In-place same-size rewrite: only mtime moves.
  assert.notEqual(T.tokenCacheKey({ ...base, mtimeMs: base.mtimeMs + 1 }), key,
    'an in-place rewrite must MISS');
  // The remaining two still count.
  assert.notEqual(T.tokenCacheKey({ ...base, size: 65 }), key);
  assert.notEqual(T.tokenCacheKey({ ...base, dev: 66311 }), key);
  // Every field is actually present, so no single one can be dropped unnoticed.
  for (const f of ['mtimeMs', 'size', 'ino', 'dev']) {
    assert.ok(key.includes(String(base[f])), `the key must incorporate ${f}`);
  }
  // A missing/NaN field degrades to a sentinel rather than "undefined" colliding
  // across two different broken stats.
  assert.equal(T.tokenCacheKey({}), '?:?:?:?');
  assert.notEqual(T.tokenCacheKey({ ...base, ino: undefined }), key);
});

test('applyKeepAlive really assigns both windows to every server', () => {
  // The assignment lives in the pure module precisely so this can exist: written
  // inline in pty-host.mjs it is covered by NOTHING, and deleting it (reinstating
  // the exact bug it fixes) passes every CI gate.
  const a = {}, b = {};
  T.applyKeepAlive([a, b]);
  for (const s of [a, b]) {
    assert.equal(s.keepAliveTimeout, T.KEEPALIVE_TIMEOUT_MS);
    assert.equal(s.headersTimeout, T.HEADERS_TIMEOUT_MS);
  }
});

test('installFatalErrorHandlers covers every emitter and fires exactly once', () => {
  // `ws` re-emits its http server's 'error' on the WebSocketServer, so a bind
  // failure reaches BOTH — and an unhandled 'error' on either one throws, which
  // with the pty spawned first took the process down with the child already
  // running under it. Cover all of them, and settle only once.
  const http = new EventEmitter(), wss = new EventEmitter();
  const fired = [];
  T.installFatalErrorHandlers(
    [{ name: 'terminal', emitter: http }, { name: 'terminal ws', emitter: wss }],
    (which, err) => fired.push(`${which}:${err.code}`),
  );
  const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
  http.emit('error', err);   // the real ws wiring re-emits, so both fire
  wss.emit('error', err);
  assert.deepEqual(fired, ['terminal:EADDRINUSE'], 'one fatal, not two exits');
  // Every emitter is listened to, so none of them can throw as unhandled.
  assert.equal(http.listenerCount('error'), 1);
  assert.equal(wss.listenerCount('error'), 1);
});

test('pty-host hands installFatalErrorHandlers all four emitters', () => {
  // The LIST lives in the shell, which CI never imports — so dropping one entry
  // (say the terminal WebSocketServer, the one that actually receives the
  // re-emitted bind error) restores the uncaught-throw crash and passes every
  // other gate. Read the call site and hold it to the four.
  const src = readFileSync(join(HERE, '..', 'pty-host.mjs'), 'utf8');
  const call = /T\.installFatalErrorHandlers\(\[([\s\S]*?)\n\],/.exec(src);
  assert.ok(call, 'the installFatalErrorHandlers call moved or changed shape');
  const emitters = [...call[1].matchAll(/emitter:\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepEqual(emitters.sort(), ['ctrlHttp', 'ctrlWss', 'termHttp', 'termWss'],
    'both http servers AND both WebSocketServers, or an unhandled bind error throws');
  // And nothing quietly went back to a bare inline assignment of the windows.
  assert.ok(/T\.applyKeepAlive\(\[termHttp, ctrlHttp\]\)/.test(src),
    'both servers must get the keep-alive windows, via the covered helper');
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
  // very start and scrolls out of a bounded raw byte window once enough streams
  // past it. The production ring is 256 KiB (pty-host.mjs RING_MAX), so the real
  // trigger is a turn streaming >256 KiB past the paint-once marker; this uses a
  // reduced 20 KiB window on the compact real-capture fixture to demonstrate the
  // SAME mechanism (marker outside the window -> the ring scan reads idle, the
  // full-stream grid still reads busy) without shipping a 300 KiB fixture.
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

test('a never-terminating escape does not grow pending without bound (untrusted output)', () => {
  const g = new T.TerminalGrid(20, 5);
  // An OSC with no ST, then a CSI with endless params — both incomplete forever.
  for (let i = 0; i < 20; i++) g.write('\x1b]' + 'A'.repeat(50000));
  assert.ok(g._pending.length <= 65536 + 50000, 'pending is bounded');
  for (let i = 0; i < 20; i++) g.write('\x1b[' + '1;'.repeat(50000));
  assert.ok(g._pending.length <= 65536 + 100000, 'pending stays bounded');
  // Still usable afterwards.
  g.write('\x1b[2J\x1b[Hok');
  assert.equal(g.capture(), 'ok');
});

// ---- C6: the scrollback ring is O(1) amortised, not a per-chunk full copy ----
test('C6: ScrollbackRing keeps an exact byte-bounded tail across many small chunks', () => {
  // It used to be `this.buf = Buffer.concat([this.buf, b])` per chunk, copying
  // the WHOLE 256 KiB ring on every pty write — on the pty-host's only thread,
  // which also fans bytes to the browser and answers the manager's control RPCs.
  // The chunk-list rewrite must be byte-for-byte identical to that behaviour.
  const ref = (chunks, max) => {
    let b = Buffer.alloc(0);
    for (const c of chunks) { b = Buffer.concat([b, c]); if (b.length > max) b = b.subarray(b.length - max); }
    return b;
  };
  const cases = [
    { max: 8, chunks: ['a', 'b', 'c'] },
    { max: 4, chunks: ['abcdefgh'] },                 // one chunk larger than the ring
    { max: 5, chunks: ['ab', 'cd', 'ef', 'gh'] },     // eviction mid-chunk
    { max: 16, chunks: [] },                          // empty
    { max: 3, chunks: ['', 'xy', '', 'z'] },          // empty appends are no-ops
  ];
  for (const { max, chunks } of cases) {
    const bufs = chunks.map((c) => Buffer.from(c, 'utf8'));
    const ring = new T.ScrollbackRing(max);
    for (const b of bufs) ring.append(b);
    const want = ref(bufs, max);
    assert.deepEqual(ring.bytes(), want, `ring bytes for max=${max} [${chunks}]`);
    assert.equal(ring.length, want.length, `ring length for max=${max}`);
    assert.equal(ring.text(), want.toString('utf8'));
  }
});

test('C6: the ring never exceeds its ceiling and stays cheap under a stream', () => {
  const max = 1024;
  const ring = new T.ScrollbackRing(max);
  const chunk = Buffer.alloc(64, 0x61);
  for (let i = 0; i < 5000; i++) {
    ring.append(chunk);
    assert.ok(ring.length <= max, 'the ring must never exceed its ceiling mid-stream');
  }
  assert.equal(ring.length, max);
  // Retained chunks must stay bounded too — an unbounded list would be the same
  // leak in a different shape.
  assert.ok(ring.chunks.length <= Math.ceil(max / 64) + 1,
    `retained chunk count stays bounded (got ${ring.chunks.length})`);
});

// ---- C14: the rendered grid must not corrupt or scramble on hostile bytes ----
test('C14: an inverted DECSTBM region is IGNORED, not applied', () => {
  // `\x1b[10;5r` yields top=9, bot=4. Applied, _scrollUp's splice pair removes
  // and reinserts at the wrong ends and scrambles the screen. These are
  // untrusted pty bytes — a plain `echo` reaches this.
  const g = new T.TerminalGrid(20, 10);
  g.write('\x1b[10;5r');
  assert.ok(g.top < g.bot, `an unusable region must be refused (top=${g.top} bot=${g.bot})`);
  // A legitimate region still applies.
  g.write('\x1b[3;8r');
  assert.equal(g.top, 2);
  assert.equal(g.bot, 7);
  // And the grid still renders rather than throwing.
  g.write('hello');
  assert.match(g.capture(), /hello/);
});

test('C14: EL/ED at the pending-wrap column do not grow the row past `cols`', () => {
  // After the last cell is filled, `cc === cols` while the wrap is pending, so an
  // unclamped `c <= this.cc` wrote grid[cr][cols]. capture() trimmed it
  // cosmetically, but resize()/_scrollUp then carried the wrong row shape.
  for (const seq of ['\x1b[1K', '\x1b[1J']) {
    const g = new T.TerminalGrid(4, 3);
    g.write('abcd');            // fills the row; cc is now at the wrap column
    g.write(seq);
    for (const row of g.grid) {
      assert.equal(row.length, 4, `row stays exactly cols wide after ${JSON.stringify(seq)}`);
    }
  }
});
