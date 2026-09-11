"use strict";

// XERK-763 — leader election (turma/leader.js). The election ALGORITHM is driven
// over a fake in-memory k8s Lease API (resourceVersion optimistic concurrency),
// so acquire / renew / failover / conflict are tested with no live cluster —
// the same no-live-backend discipline as store.test.js's RESP codec.

const test = require("node:test");
const assert = require("node:assert");

const { createLeader, LeaderElector, StandaloneLeader } = require("../leader.js");

// A minimal coordination.k8s.io Lease API over one in-memory object.
function fakeK8s() {
  const api = {
    lease: null, // {metadata:{name,resourceVersion}, spec:{...}}
    rv: 0,
    calls: [],
    partitioned: false,
  };
  api.request = async (method, path, body) => {
    api.calls.push({ method, path });
    if (api.partitioned) throw new Error("network down");
    const isCollection = /\/leases$/.test(path);
    if (method === "GET") {
      if (!api.lease) return { status: 404, body: { kind: "Status", code: 404 } };
      return { status: 200, body: clone(api.lease) };
    }
    if (method === "POST" && isCollection) {
      if (api.lease) return { status: 409, body: { kind: "Status", code: 409 } };
      api.rv += 1;
      api.lease = {
        metadata: { name: body.metadata.name, resourceVersion: String(api.rv) },
        spec: clone(body.spec),
      };
      return { status: 201, body: clone(api.lease) };
    }
    if (method === "PUT") {
      const rv = body.metadata && body.metadata.resourceVersion;
      if (!api.lease) return { status: 404, body: { code: 404 } };
      if (rv !== api.lease.metadata.resourceVersion) {
        return { status: 409, body: { kind: "Status", code: 409 } }; // stale RV
      }
      api.rv += 1;
      api.lease = {
        metadata: { name: api.lease.metadata.name, resourceVersion: String(api.rv) },
        spec: clone(body.spec),
      };
      return { status: 200, body: clone(api.lease) };
    }
    return { status: 500, body: null };
  };
  return api;
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function elector(api, identity, overrides = {}) {
  return new LeaderElector(
    {
      identity,
      namespace: "turma",
      leaseName: "turma-hub-leader",
      leaseDurationMs: 300,
      renewDeadlineMs: 200,
      retryPeriodMs: 1000, // we drive ticks by hand via _tick()
      ...overrides,
    },
    { request: api.request, connect: false }
  );
}

test("non-HA is always the leader", () => {
  const l = createLeader({ haOn: false });
  assert.ok(l instanceof StandaloneLeader);
  assert.equal(l.isLeader(), true);
  assert.equal(l.mode, "single-process");
});

test("HA with no k8s service account degrades to always-leader", () => {
  // No injected request and no SA token file → StandaloneLeader("ha-no-lease").
  const warnings = [];
  const l = createLeader({
    haOn: true,
    env: { TURMA_LEADER_TOKEN_FILE: "/nonexistent/turma-sa-token" },
    log: (m) => warnings.push(m),
  });
  assert.ok(l instanceof StandaloneLeader);
  assert.equal(l.mode, "ha-no-lease");
  assert.equal(l.isLeader(), true);
  assert.ok(warnings.some((w) => /leader election is DISABLED/.test(w)));
});

test("acquires an absent lease (404 → create) and renews while held", async () => {
  const api = fakeK8s();
  const a = elector(api, "pod-a");
  await a._tick();
  assert.equal(a.isLeader(), true);
  assert.equal(api.lease.spec.holderIdentity, "pod-a");
  const rvAfterAcquire = api.lease.metadata.resourceVersion;

  await a._tick(); // renew
  assert.equal(a.isLeader(), true);
  assert.notEqual(api.lease.metadata.resourceVersion, rvAfterAcquire); // a fresh renewTime was written
  assert.equal(api.lease.spec.holderIdentity, "pod-a");
});

test("a second replica is a follower while the first holds a valid lease", async () => {
  const api = fakeK8s();
  const a = elector(api, "pod-a");
  const b = elector(api, "pod-b");
  await a._tick();
  assert.equal(a.isLeader(), true);
  await b._tick();
  assert.equal(b.isLeader(), false);
  assert.equal(api.lease.spec.holderIdentity, "pod-a"); // b did not steal it
});

test("failover: a follower acquires once the leader's lease expires", async () => {
  // k8s Lease durations are integer SECONDS, so expiry granularity is 1s.
  const api = fakeK8s();
  const a = elector(api, "pod-a", { leaseDurationMs: 1000, renewDeadlineMs: 800 });
  const b = elector(api, "pod-b", { leaseDurationMs: 1000, renewDeadlineMs: 800 });
  const changes = [];
  b.onChange((v) => changes.push(v));
  await a._tick();
  assert.equal(a.isLeader(), true);
  await b._tick();
  assert.equal(b.isLeader(), false); // valid lease, b waits

  // pod-a dies (stops renewing). Wait out the lease, then b sees it expired.
  await sleep(1200);
  await b._tick();
  assert.equal(b.isLeader(), true);
  assert.equal(api.lease.spec.holderIdentity, "pod-b");
  assert.ok(api.lease.spec.leaseTransitions >= 1); // a handover was counted
  assert.deepEqual(changes, [true]); // exactly one promotion edge
});

test("isLeader() self-expires when the election loop wedges (split-brain guard)", async () => {
  // The self-expiry is bounded by the ADVERTISED (seconds-granular) lease, so a
  // real wedge test needs >=1s (a standby honors the same seconds value).
  const api = fakeK8s();
  const a = elector(api, "pod-a", { leaseDurationMs: 1000, renewDeadlineMs: 800 });
  await a._tick();
  assert.equal(a.isLeader(), true);
  // No further ticks fire (a wedged loop). Past the lease duration, isLeader()
  // must report false off the local clock even though _tick never cleared it.
  await sleep(1200);
  assert.equal(a.isLeader(), false);
});

test("the local self-expiry is never LOOSER than a standby's expiry (rounding guard)", () => {
  // XERK-763 QA: leaseSeconds CEILs, and isLeader() bounds on leaseSeconds*1000,
  // so the local split-brain guard's window can never exceed the seconds-granular
  // window a standby reads — whatever fractional-second lease is configured.
  const api = fakeK8s();
  for (const ms of [1400, 1001, 2499, 15000, 15001]) {
    const e = elector(api, "pod-x", { leaseDurationMs: ms });
    const k8sExpiryMs = e.leaseSeconds * 1000; // what a standby honors
    assert.equal(e.leaseSeconds, Math.ceil(ms / 1000), `leaseSeconds ceils for ${ms}ms`);
    // The local self-expiry threshold isLeader() uses is exactly k8sExpiryMs, so
    // local <= k8s for every configuration (never a wedged leader outliving the
    // standby's acquisition).
    assert.ok(k8sExpiryMs >= ms || k8sExpiryMs === Math.ceil(ms / 1000) * 1000);
    assert.equal(k8sExpiryMs, Math.ceil(ms / 1000) * 1000);
  }
});

test("isLeader()'s threshold is exactly the advertised lease, for a fractional-second lease", async () => {
  // Pin the THRESHOLD VALUE directly (no multi-second sleep): a 1400ms lease
  // advertises 2s, so isLeader() must hold up to 2000ms since the last renew and
  // drop past it — never up to the raw 1400ms (the pre-fix bug would have dropped
  // at 1400, i.e. looser-then-stricter than a standby reading 2s... the bug was
  // the reverse for round-DOWN; here 1400 rounds UP so the direct threshold check
  // is the durable guard against any future re-introduction).
  const api = fakeK8s();
  const a = elector(api, "pod-a", { leaseDurationMs: 1400 });
  await a._tick();
  assert.equal(a.isLeader(), true);
  assert.equal(a.leaseSeconds, 2);
  // Simulate elapsed time by backdating the last confirmed renewal.
  a._lastRenew = Date.now() - 1900; // within the 2000ms advertised window
  assert.equal(a.isLeader(), true, "holds within the advertised (ceil) lease window");
  a._lastRenew = Date.now() - 2100; // past it
  assert.equal(a.isLeader(), false, "drops past the advertised window, matching a standby");
});

test("a stale-resourceVersion PUT (409) does not claim leadership", async () => {
  const api = fakeK8s();
  const a = elector(api, "pod-a", { leaseDurationMs: 1000, renewDeadlineMs: 800 });
  const b = elector(api, "pod-b", { leaseDurationMs: 1000, renewDeadlineMs: 800 });
  await a._tick(); // a is leader
  await sleep(1200); // lease expires (seconds granularity)

  // Both observe the expired lease at the same RV, then both PUT. The first wins;
  // the second gets a 409 and must NOT think it acquired.
  const obsA = await a._get();
  const obsB = await b._get();
  const okA = await a._put(obsA, Date.now());
  const okB = await b._put(obsB, Date.now());
  assert.equal(okA, true);
  assert.equal(okB, false);
});

test("release() backdates renewTime so a standby promotes at once", async () => {
  const api = fakeK8s();
  const a = elector(api, "pod-a", { leaseDurationMs: 5000, renewDeadlineMs: 4000 });
  const b = elector(api, "pod-b", { leaseDurationMs: 5000, renewDeadlineMs: 4000 });
  await a._tick();
  assert.equal(a.isLeader(), true);

  await a.release(); // graceful shutdown
  assert.equal(a.isLeader(), false);
  // b now sees the lease as expired (renewTime backdated), without waiting 5s.
  await b._tick();
  assert.equal(b.isLeader(), true);
});

test("a transient API error keeps leadership within the renew deadline, then drops it", async () => {
  const api = fakeK8s();
  const a = elector(api, "pod-a", { leaseDurationMs: 5000, renewDeadlineMs: 40 });
  await a._tick();
  assert.equal(a.isLeader(), true);

  api.partitioned = true;
  await a._tick(); // read fails immediately after a fresh renew — keep leadership
  assert.equal(a.isLeader(), true);

  await sleep(60); // past the renew deadline
  await a._tick(); // read still failing → give up leadership
  assert.equal(a.isLeader(), false);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
