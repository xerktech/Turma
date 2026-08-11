// Unit tests for the chat engine's live-socket lifecycle (public/chat.js):
// reconnectNow(), which the Sessions page fires the moment a flapped host
// tunnel comes back (XERK-252), and loadHistory()'s refusal to fetch for a view
// that has already closed. node:test, no npm — chat.js is driven against
// minimal WebSocket/fetch/document shims.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// --- shims (installed before chat.js is required) ----------------------------
let sockets, fetched, fetchReply;

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.readyState = FakeSocket.CONNECTING;
    sockets.push(this);
  }
  close() { this.readyState = FakeSocket.CLOSED; if (this.onclose) this.onclose(); }
  open() { this.readyState = FakeSocket.OPEN; if (this.onopen) this.onopen(); }
}
FakeSocket.CONNECTING = 0;
FakeSocket.OPEN = 1;
FakeSocket.CLOSING = 2;
FakeSocket.CLOSED = 3;

globalThis.WebSocket = FakeSocket;
globalThis.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
};
globalThis.window = { getSelection: () => null };
globalThis.location = { origin: "https://hub.example" };
globalThis.fetch = (url) => {
  fetched.push(String(url));
  return Promise.resolve(fetchReply(String(url)));
};

const chat = require("../public/chat.js");

// Let the `await`s inside startWs/loadHistory settle.
const settle = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => {
  // chat.js is a module-level singleton, so retire any socket a previous test
  // left it holding — silently, since firing onclose would arm a reconnect.
  for (const s of sockets || []) s.readyState = FakeSocket.CLOSED;
  sockets = [];
  fetched = [];
  fetchReply = (url) =>
    url.includes("/api/ws-token")
      ? { ok: true, json: async () => ({ token: "tok-1", expiresInSec: 300 }) }
      : { ok: true, status: 200, json: async () => ({ entries: [] }) };
  chat.__setSessionRef("hostA", "sess-1");
});

// The hub holds a browser's /live socket across a control-channel flap and
// re-arms the agent's watch when the tunnel returns, so a socket that is still
// open needs nothing — nudging it would drop a working stream and re-seed it.
test("reconnectNow leaves a live socket alone", async () => {
  await chat.reconnectNow();
  await settle();
  assert.equal(sockets.length, 1, "opened one socket while none was up");
  sockets[0].open();

  await chat.reconnectNow();
  await settle();
  assert.equal(sockets.length, 1, "an OPEN socket is not torn down and rebuilt");

  // A CONNECTING one is already on its way in, too.
  sockets[0].readyState = FakeSocket.CONNECTING;
  await chat.reconnectNow();
  await settle();
  assert.equal(sockets.length, 1);
});

test("reconnectNow reopens a dropped socket at once, against the right session", async () => {
  await chat.reconnectNow();
  await settle();
  sockets[0].open();
  sockets[0].close();          // the flap takes the socket down

  await chat.reconnectNow();
  await settle();
  assert.equal(sockets.length, 2, "the dead socket is replaced");
  assert.match(sockets[1].url, /^wss:\/\/hub\.example\/live\/hostA\/sess-1\?auth=/);
});

// The window that made this bite in the browser: open() sets hostKey/sessionId
// synchronously but only assigns `ws` after the ws-token round trip, and the
// page's render() — which runs on the same tick as selectSession() — could fire
// the reconnect nudge inside it. Two sockets were opened for one view and
// close() could only ever close the last, so the other leaked and the hub, still
// seeing a live client, never unwatched the session.
test("a nudge landing inside open()'s connect doesn't open a second socket", async () => {
  const startAndNudge = chat.startWs(chat.__gen());  // mid ws-token fetch
  chat.reconnectNow();
  await startAndNudge;
  await settle();
  assert.equal(sockets.length, 1, "one view, one socket");
});

// The guard the one above leans on, on its own: connecting is async, so two
// concurrent connects for the same view (a retry timer and a nudge, open() and
// a nudge) must still leave exactly one socket — `ws` holds only the last, and
// close() can only close what `ws` holds.
test("two concurrent connects for one view build one socket", async () => {
  const a = chat.startWs(chat.__gen());
  const b = chat.startWs(chat.__gen());
  await Promise.all([a, b]);
  await settle();
  assert.equal(sockets.length, 1);
});

// ...but the guard is per view, not global: opening a DIFFERENT session while
// the previous connect is still in flight must still connect.
test("a new session connects even while the previous view is mid-connect", async () => {
  const pending = chat.startWs(chat.__gen());
  chat.__nextGen();                      // what close()/open() do between sessions
  chat.__setSessionRef("hostB", "sess-2");
  await chat.startWs(chat.__gen());
  await pending;
  await settle();
  const urls = sockets.map((s) => s.url);
  assert.equal(urls.length, 1, "the abandoned view's socket is never built");
  assert.match(urls[0], /\/live\/hostB\/sess-2\?auth=/, "the new session got the socket");
});

test("reconnectNow is a no-op with no session on the stage", async () => {
  chat.__setSessionRef(null, null);
  await chat.reconnectNow();
  await settle();
  assert.equal(sockets.length, 0);
  assert.deepEqual(fetched, [], "not even a ws-token is minted");
});

// close() nulls hostKey/sessionId, but a 202-retry timer may already be in
// flight. It used to build `/api/agents/null/sessions/null/history` and 404 —
// the result was discarded by the generation check, the REQUEST was not.
test("loadHistory doesn't fetch for a view that has closed", async () => {
  const gen = chat.__gen();
  await chat.loadHistory(gen);
  await settle();
  assert.deepEqual(fetched, ["/api/agents/hostA/sessions/sess-1/history"]);

  fetched = [];
  chat.__setSessionRef(null, null);
  await chat.loadHistory(gen);
  await settle();
  assert.deepEqual(fetched, [], "no request at all — no null-id URL");

  // A stale generation (the view moved on to another session) is dropped just
  // as early, before its URL is built.
  fetched = [];
  chat.__setSessionRef("hostA", "sess-1");
  await chat.loadHistory(gen - 1);
  await settle();
  assert.deepEqual(fetched, []);
});
