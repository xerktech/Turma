// Unit tests for turma/push.js (FCM HTTP v1 fan-out) using node:test — no npm
// deps, runs offline. A throwaway RSA keypair stands in for the service-account
// key so JWT signing is exercised for real; globalThis.fetch is stubbed to
// observe the token exchange and message sends without network.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const push = require("../push.js");

// A real (throwaway) RSA key so crypto.sign() has something valid to sign with.
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  project_id: "test-proj",
  client_email: "svc@test-proj.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://oauth2.test/token",
};

const realFetch = globalThis.fetch;
function restore() {
  globalThis.fetch = realFetch;
  push._resetTokenCache();
}

test("disabled when no service account: sendFcm is a no-op", async () => {
  push._setServiceAccount(null);
  assert.equal(push.fcmEnabled(), false);
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true };
  };
  const r = await push.sendFcm(["tok1"], { title: "t", body: "b" });
  assert.deepEqual(r, { sent: 0, dead: [] });
  assert.equal(called, false, "no HTTP when disabled");
  restore();
});

test("mints a JWT-bearer access token then sends a data message per token", async () => {
  push._setServiceAccount(SA);
  push._resetTokenCache();
  assert.equal(push.fcmEnabled(), true);

  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url) === SA.token_uri) {
      // Assert the assertion is a well-formed 3-part JWT for the token exchange.
      const params = new URLSearchParams(opts.body);
      assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      assert.equal(params.get("assertion").split(".").length, 3);
      return { ok: true, json: async () => ({ access_token: "ya29.test", expires_in: 3600 }) };
    }
    // The FCM send.
    assert.match(String(url), /projects\/test-proj\/messages:send$/);
    assert.equal(opts.headers.Authorization, "Bearer ya29.test");
    const sent = JSON.parse(opts.body);
    assert.ok(sent.message.token);
    assert.equal(sent.message.data.title, "Hello");
    assert.equal(sent.message.android.priority, "high");
    return { ok: true, text: async () => "" };
  };

  const r = await push.sendFcm(["tokA", "tokB"], {
    title: "Hello",
    body: "world",
    data: { tags: "question", sessionId: "12345" },
  });
  assert.equal(r.sent, 2);
  assert.deepEqual(r.dead, []);
  // One token exchange + two sends.
  assert.equal(calls.filter((c) => c.url === SA.token_uri).length, 1);
  assert.equal(calls.filter((c) => /messages:send$/.test(c.url)).length, 2);
  // data values are all coerced to strings.
  const send = calls.find((c) => /messages:send$/.test(c.url));
  const data = JSON.parse(send.opts.body).message.data;
  assert.equal(typeof data.sessionId, "string");
  restore();
});

test("caches the access token across sends", async () => {
  push._setServiceAccount(SA);
  push._resetTokenCache();
  let tokenExchanges = 0;
  globalThis.fetch = async (url) => {
    if (String(url) === SA.token_uri) {
      tokenExchanges++;
      return { ok: true, json: async () => ({ access_token: "ya29.cached", expires_in: 3600 }) };
    }
    return { ok: true, text: async () => "" };
  };
  await push.sendFcm(["a"], { title: "t", body: "b" });
  await push.sendFcm(["b"], { title: "t", body: "b" });
  assert.equal(tokenExchanges, 1, "token minted once, reused on the second send");
  restore();
});

test("reports unregistered tokens as dead for pruning", async () => {
  push._setServiceAccount(SA);
  push._resetTokenCache();
  globalThis.fetch = async (url, opts) => {
    if (String(url) === SA.token_uri) {
      return { ok: true, json: async () => ({ access_token: "ya29.t", expires_in: 3600 }) };
    }
    const token = JSON.parse(opts.body).message.token;
    if (token === "dead1") {
      return { ok: false, status: 404, text: async () => '{"error":{"status":"UNREGISTERED"}}' };
    }
    if (token === "transient") {
      return { ok: false, status: 503, text: async () => "unavailable" };
    }
    return { ok: true, text: async () => "" };
  };
  const r = await push.sendFcm(["good", "dead1", "transient"], { title: "t", body: "b" });
  assert.equal(r.sent, 1);
  assert.deepEqual(r.dead, ["dead1"], "only the 404/UNREGISTERED token is pruned");
  restore();
});

test("token mint failure degrades to a no-op, not a throw", async () => {
  push._setServiceAccount(SA);
  push._resetTokenCache();
  globalThis.fetch = async (url) => {
    if (String(url) === SA.token_uri) return { ok: false, status: 401 };
    throw new Error("should not reach send");
  };
  const r = await push.sendFcm(["a"], { title: "t", body: "b" });
  assert.deepEqual(r, { sent: 0, dead: [] });
  restore();
});
