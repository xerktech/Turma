// Leader election for the HA hub (XERK-763, epic XERK-751).
//
// Under Option 2 (active-passive, `docs/turma-ha-design.md`) the hub runs as N
// replicas but the SINGLETON background work — the offline-detection sweep, the
// master orchestration tick (auto-start/stop, epic runs, auto-merge/close, the
// ticket-queue drain, …) and migration-advance — must run on EXACTLY ONE
// replica, or every fleet-wide ACTION (spawn, PR merge, ticket close, FCM alert)
// fires N times. This module elects that one replica.
//
// The mechanism is a Kubernetes `Lease` in `coordination.k8s.io` (the parent's
// choice; the store's CAS could express a lease but the k8s-native one keeps
// election out of the data plane — `docs/turma-ha-store-adr.md` §1). A Service
// account with get/create/update on that Lease, and `automountServiceAccountToken:
// true`, are wired by the `manifest` sibling; this module only speaks to the API.
//
// stdlib only — the hub ships no node_modules, so the k8s calls go over
// `node:https` with the service-account CA + bearer token. The election
// ALGORITHM is pure over an injected `request(method, path, body)` (the same
// philosophy as store.js's RESP codec), so the whole acquire / renew / failover
// path is unit-tested with a fake API server and no live cluster.
//
// `isLeader()` is SYNCHRONOUS (the sweeps call it inline) and fail-safe: it
// reports leader only while THIS process's own last confirmed renewal is within
// the lease duration, so a wedged election loop can never leave a stale leader
// believing it still holds the lease (split-brain defence) — the k8s expiry and
// this local clock guard agree.
//
// NON-HA and HA-without-a-lease both use `StandaloneLeader`, whose `isLeader()`
// is always true — single-process is trivially always-leader, and a compose/dev
// HA stack with no k8s API degrades to always-leader with a loud boot warning
// (running the sweeps on every replica) rather than refusing to boot.

"use strict";

const fs = require("fs");
const https = require("https");
const os = require("os");
const crypto = require("crypto");

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

// Timing defaults (client-go's leaderelection shape): renewDeadline < leaseDuration,
// retryPeriod small. A follower sees the leader gone at most leaseDuration after
// its last renewal; the leader gives up leadership if it cannot renew within
// renewDeadline. All overridable by env for tests (wind them down to ms).
const DEFAULTS = {
  leaseDurationMs: 15000,
  renewDeadlineMs: 10000,
  retryPeriodMs: 2000,
  requestTimeoutMs: 8000,
};

// ---------------------------------------------------------------------------
// StandaloneLeader — always the leader. Non-HA, or HA with no reachable lease.
// ---------------------------------------------------------------------------
class StandaloneLeader {
  constructor(mode) {
    this.mode = mode || "standalone"; // "single-process" | "ha-no-lease"
    this.kind = "standalone";
  }
  isLeader() {
    return true;
  }
  start() {}
  stop() {}
  async release() {}
  onChange() {
    // A standalone leader never changes state; fire once so a promotion hook
    // (guard/migration hydration) still runs on boot if a caller wants it.
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// LeaderElector — the k8s Lease election loop.
// ---------------------------------------------------------------------------
class LeaderElector {
  /**
   * @param {object} cfg
   *   {identity, namespace, leaseName, leaseDurationMs, renewDeadlineMs,
   *    retryPeriodMs}
   * @param {object} opts
   *   {request: async (method, path, body) => {status, body}, onChange?, log?,
   *    connect?:boolean}
   *   `request` performs one k8s API call and resolves {status:number, body:obj}
   *   (or throws on a network error). Injected in tests.
   */
  constructor(cfg, opts = {}) {
    this.kind = "k8s";
    this.identity = cfg.identity;
    this.namespace = cfg.namespace;
    this.leaseName = cfg.leaseName;
    this.leaseDurationMs = cfg.leaseDurationMs || DEFAULTS.leaseDurationMs;
    this.renewDeadlineMs = cfg.renewDeadlineMs || DEFAULTS.renewDeadlineMs;
    this.retryPeriodMs = cfg.retryPeriodMs || DEFAULTS.retryPeriodMs;
    this._request = opts.request;
    this._log = opts.log || (() => {});
    this._onChange = [];
    if (opts.onChange) this._onChange.push(opts.onChange);

    this._leader = false;
    // Local monotonic-ish stamp of the last CONFIRMED renewal/acquisition. The
    // sync `isLeader()` self-expires off this, so a stalled loop drops leadership.
    this._lastRenew = 0;
    this._timer = null;
    this._closed = false;
    // The resourceVersion of the lease as we last saw it — k8s PUT is optimistic
    // and 409s a stale one, which we resolve by re-GETting on the next tick.
    this._resourceVersion = null;
    if (opts.connect !== false) this.start();
  }

  get leaseSeconds() {
    return Math.max(1, Math.round(this.leaseDurationMs / 1000));
  }

  _leasePath() {
    return `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.namespace)}/leases`;
  }

  isLeader() {
    // Fail-safe: hold leadership only while our last confirmed renewal is still
    // within the lease window. A wedged loop (no ticks firing) therefore drops
    // leadership after leaseDurationMs even though `_leader` was never cleared,
    // so it can never race a newly-promoted standby.
    return this._leader && Date.now() - this._lastRenew <= this.leaseDurationMs;
  }

  onChange(cb) {
    this._onChange.push(cb);
    return () => {
      const i = this._onChange.indexOf(cb);
      if (i >= 0) this._onChange.splice(i, 1);
    };
  }

  _emit(isLeader) {
    for (const cb of this._onChange) {
      try {
        cb(isLeader);
      } catch (e) {
        this._log(`leader: onChange handler threw: ${(e && e.message) || e}`);
      }
    }
  }

  // Set/clear leadership, firing onChange only on a real edge.
  _setLeader(next) {
    if (next) this._lastRenew = Date.now();
    if (next === this._leader) return;
    this._leader = next;
    this._log(
      next
        ? `leader: acquired lease ${this.leaseName} as ${this.identity}`
        : `leader: lost lease ${this.leaseName}`
    );
    this._emit(next);
  }

  start() {
    if (this._timer || this._closed) return;
    // Run one tick immediately so boot resolves leadership fast, then on cadence.
    const loop = () => {
      this._tick().catch((e) => this._log(`leader: tick error: ${(e && e.message) || e}`));
    };
    loop();
    this._timer = setInterval(loop, this.retryPeriodMs);
    this._timer.unref?.();
  }

  stop() {
    this._closed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _get() {
    const r = await this._request(
      "GET",
      `${this._leasePath()}/${encodeURIComponent(this.leaseName)}`,
      null
    );
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`GET lease ${r.status}`);
    return r.body;
  }

  _spec(now, prev) {
    // A lease's timestamps are RFC3339. `acquireTime` is preserved across a renew
    // and stamped fresh on an acquisition; `leaseTransitions` counts handovers.
    const iso = new Date(now).toISOString();
    return {
      holderIdentity: this.identity,
      leaseDurationSeconds: this.leaseSeconds,
      acquireTime: prev && prev.acquireTime && prev.holderIdentity === this.identity
        ? prev.acquireTime
        : iso,
      renewTime: iso,
      leaseTransitions:
        prev && typeof prev.leaseTransitions === "number"
          ? prev.leaseTransitions + (prev.holderIdentity === this.identity ? 0 : 1)
          : prev
            ? 1
            : 0,
    };
  }

  async _create(now) {
    const body = {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name: this.leaseName, namespace: this.namespace },
      spec: this._spec(now, null),
    };
    const r = await this._request("POST", this._leasePath(), body);
    if (r.status === 201 || r.status === 200) {
      this._resourceVersion = r.body && r.body.metadata && r.body.metadata.resourceVersion;
      return true;
    }
    // 409 = someone created it first; re-GET next tick.
    return false;
  }

  async _put(observed, now) {
    const rv = observed.metadata && observed.metadata.resourceVersion;
    const body = {
      apiVersion: "coordination.k8s.io/v1",
      kind: "Lease",
      metadata: { name: this.leaseName, namespace: this.namespace, resourceVersion: rv },
      spec: this._spec(now, observed.spec || {}),
    };
    const r = await this._request(
      "PUT",
      `${this._leasePath()}/${encodeURIComponent(this.leaseName)}`,
      body
    );
    if (r.status === 200) {
      this._resourceVersion = r.body && r.body.metadata && r.body.metadata.resourceVersion;
      return true;
    }
    // 409 = the lease moved under us (stale resourceVersion); re-GET next tick.
    return false;
  }

  // One election cycle: read the lease and renew / acquire / stand down.
  async _tick() {
    if (this._closed) return;
    let observed;
    try {
      observed = await this._get();
    } catch (e) {
      // Transient API error: keep leadership only within the renew deadline, so a
      // brief API blip does not hand the fleet to a second leader — but a genuine
      // partition does, once the deadline lapses (and isLeader() self-expires at
      // the lease duration regardless).
      this._maybeExpire();
      this._log(`leader: lease read failed: ${(e && e.message) || e}`);
      return;
    }

    const now = Date.now();
    if (observed === null) {
      this._setLeader(await this._create(now));
      return;
    }

    const spec = observed.metadata && observed.spec ? observed.spec : observed.spec || {};
    const holder = spec.holderIdentity;
    const held = holder === this.identity;
    const renewMs = spec.renewTime ? Date.parse(spec.renewTime) : NaN;
    const durMs = (Number(spec.leaseDurationSeconds) || this.leaseSeconds) * 1000;
    const expired = !Number.isFinite(renewMs) || now - renewMs > durMs;

    if (held) {
      // We are (or were) the holder — renew. A failed renew keeps leadership only
      // within the renew deadline.
      if (await this._put(observed, now)) this._setLeader(true);
      else this._maybeExpire();
      return;
    }
    if (expired) {
      // The lease is up for grabs — acquire it.
      this._setLeader(await this._put(observed, now));
      return;
    }
    // A different replica holds a valid lease: we are a follower.
    this._setLeader(false);
  }

  // Drop leadership if we have not confirmed a renewal within the renew deadline.
  _maybeExpire() {
    if (this._leader && Date.now() - this._lastRenew > this.renewDeadlineMs) {
      this._setLeader(false);
    }
  }

  // Best-effort renounce on graceful shutdown: backdate our renewTime so a
  // standby sees the lease expired at once and promotes without waiting out the
  // full lease duration. Never throws.
  async release() {
    this.stop();
    if (!this._leader) return;
    try {
      const observed = await this._get();
      if (!observed || !observed.spec || observed.spec.holderIdentity !== this.identity) return;
      const rv = observed.metadata && observed.metadata.resourceVersion;
      const past = new Date(Date.now() - this.leaseDurationMs - 1000).toISOString();
      await this._request(
        "PUT",
        `${this._leasePath()}/${encodeURIComponent(this.leaseName)}`,
        {
          apiVersion: "coordination.k8s.io/v1",
          kind: "Lease",
          metadata: { name: this.leaseName, namespace: this.namespace, resourceVersion: rv },
          spec: { ...observed.spec, renewTime: past },
        }
      );
      this._log(`leader: released lease ${this.leaseName}`);
    } catch (e) {
      this._log(`leader: release failed (harmless): ${(e && e.message) || e}`);
    } finally {
      this._leader = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Service-account access + the default k8s request implementation.
// ---------------------------------------------------------------------------

// Read the mounted service-account credentials. Returns null when the token is
// absent (not in k8s / token not automounted), so the caller can degrade.
function readServiceAccount(env = process.env) {
  const tokenPath = env.TURMA_LEADER_TOKEN_FILE || `${SA_DIR}/token`;
  const caPath = env.TURMA_LEADER_CA_FILE || `${SA_DIR}/ca.crt`;
  const nsPath = env.TURMA_LEADER_NAMESPACE_FILE || `${SA_DIR}/namespace`;
  let token;
  try {
    token = fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    return null;
  }
  if (!token) return null;
  let ca = null;
  try {
    ca = fs.readFileSync(caPath, "utf8");
  } catch {
    /* CA optional: fall back to the system store */
  }
  let namespace = env.TURMA_LEADER_NAMESPACE || "";
  if (!namespace) {
    try {
      namespace = fs.readFileSync(nsPath, "utf8").trim();
    } catch {
      /* resolved below */
    }
  }
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT_HTTPS || env.KUBERNETES_SERVICE_PORT || "443";
  return { token, ca, namespace, host, port };
}

// The default `request` for a real cluster: one HTTPS call to the API server,
// resolving {status, body}. Never used in tests (which inject their own).
function makeK8sRequest(sa, timeoutMs = DEFAULTS.requestTimeoutMs) {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = https.request(
        {
          host: sa.host,
          port: sa.port,
          path,
          method,
          servername: "kubernetes.default.svc",
          ca: sa.ca || undefined,
          headers: {
            Authorization: `Bearer ${sa.token}`,
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": payload.length }
              : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch {
                /* non-JSON body: leave null, status carries the outcome */
              }
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("k8s request timeout")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

// A stable-per-process holder identity: the pod name (k8s sets HOSTNAME to it)
// plus a short random suffix, so two processes that somehow share a name never
// both believe they hold the lease.
function leaderIdentity(env = process.env) {
  const base = env.TURMA_LEADER_IDENTITY || env.POD_NAME || env.HOSTNAME || os.hostname() || "hub";
  return `${base}_${crypto.randomBytes(4).toString("hex")}`;
}

function timingFromEnv(env = process.env) {
  const num = (name, def) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  return {
    leaseDurationMs: num("TURMA_LEADER_LEASE_MS", DEFAULTS.leaseDurationMs),
    renewDeadlineMs: num("TURMA_LEADER_RENEW_MS", DEFAULTS.renewDeadlineMs),
    retryPeriodMs: num("TURMA_LEADER_RETRY_MS", DEFAULTS.retryPeriodMs),
  };
}

/**
 * Build the leader for this process.
 * @param {object} args {haOn, env?, log?, onChange?, request?}
 *   `request` overrides the k8s HTTP layer (tests). Returns an object with a
 *   synchronous `isLeader()` in every mode.
 * @returns {StandaloneLeader|LeaderElector}
 */
function createLeader({ haOn, env = process.env, log = () => {}, onChange, request } = {}) {
  if (!haOn) return new StandaloneLeader("single-process");

  const timing = timingFromEnv(env);
  // A test-injected request needs no real service account.
  if (request) {
    return new LeaderElector(
      {
        identity: leaderIdentity(env),
        namespace: env.TURMA_LEADER_NAMESPACE || "default",
        leaseName: env.TURMA_LEADER_LEASE || "turma-hub-leader",
        ...timing,
      },
      { request, log, onChange }
    );
  }

  const sa = readServiceAccount(env);
  if (!sa || !sa.host) {
    log(
      "WARNING: HA is on but no Kubernetes service account is reachable — leader " +
        "election is DISABLED and every replica runs the singleton sweeps. Set " +
        "automountServiceAccountToken:true (the manifest sibling) or run a single " +
        "replica. See docs/turma-ha-design.md."
    );
    return new StandaloneLeader("ha-no-lease");
  }
  const namespace = sa.namespace || env.TURMA_LEADER_NAMESPACE || "default";
  return new LeaderElector(
    {
      identity: leaderIdentity(env),
      namespace,
      leaseName: env.TURMA_LEADER_LEASE || "turma-hub-leader",
      ...timing,
    },
    { request: makeK8sRequest(sa), log, onChange }
  );
}

module.exports = {
  createLeader,
  LeaderElector,
  StandaloneLeader,
  readServiceAccount,
  makeK8sRequest,
  leaderIdentity,
  DEFAULTS,
};
