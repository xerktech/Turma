// The storage-abstraction seam (XERK-754, epic XERK-751) — the spine every
// state-externalization child plugs into.
//
// ONE interface (`LiveStore`) with TWO backends behind it:
//   - `FileLiveStore`   — the DEFAULT single-process backend. Module-level maps
//                         for hot coordination state + full-file temp+rename
//                         writes for durable keys, reproducing today's on-disk
//                         SHAPES byte-for-byte, so the docker-compose non-HA path
//                         is zero-config and unchanged.
//   - `SharedLiveStore` — a Valkey (redis-wire) client over node:net/node:tls,
//                         selected when HA config is set. stdlib only: the hub
//                         ships no node_modules, so this speaks RESP2 on a raw
//                         socket rather than pulling a client library.
//
// The abstract contract is docs/turma-ha-store-adr.md ("§1 LiveStore"). The
// method SHAPES are the contract; the names below follow it. All methods are
// ASYNC (return Promises) because a shared backend is inherently async — one
// interface both backends satisfy means the file backend resolves immediately.
// Values are JSON-shaped and are SNAPSHOTS: `get` returns a copy, so a caller
// must mutate-then-`set`, never rely on in-place identity (which a shared store
// could never give). This is what makes the two backends interchangeable.
//
// SCOPE (XERK-754): this lands the LiveStore interface + both backends + the
// backend selection + connection/health handling + tests. It does NOT rewire any
// existing store's save/load in server.js — that is the wave-3 children, which
// flip each call site onto an already-proven adapter. So with HA off nothing here
// runs on the hot path and the non-HA behaviour is byte-identical.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const tls = require("tls");
const { EventEmitter } = require("events");

// Deep-value equality for compareAndSet's `expected` check, and the guard that a
// `get` copy round-trips. JSON canonicalisation is exact for the JSON-shaped
// values this store holds when the caller passes back what `get` returned
// unchanged (structuredClone preserves key order). Documented as the contract.
function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// A snapshot of a stored value. structuredClone is a Node global (24) and keeps
// the value a private copy so a caller can never mutate the store in place.
function snapshot(v) {
  if (v === null || typeof v !== "object") return v;
  return structuredClone(v);
}

// ============================================================================
// FileLiveStore — the default single-process backend.
// ============================================================================
//
// Hot state lives in a module-level Map (what the hub keeps in RAM today).
// DURABLE keys additionally persist to a JSON file via a full-file temp+rename
// write — the exact discipline `scheduleSave` uses for state.json (XERK-297):
// write a sibling `.tmp-<pid>` then rename over the target, so a reader (this
// hub's own next-boot load) sees either the whole old file or the whole new one,
// never a torn blob. The on-disk bytes are `JSON.stringify(value)` — identical to
// every store's current format — so a wave-3 child can move a store onto this
// backend with no on-disk change (proven byte-for-byte in the tests).
class FileLiveStore {
  /**
   * @param {object} [opts]
   * @param {Object<string,{file:string,debounceMs?:number}>} [opts.persistent]
   *   Keys that persist to a file, keyed by store key. Loaded at construction,
   *   re-written (debounced, temp+rename) on change. Everything else is RAM-only.
   */
  constructor(opts = {}) {
    this.kind = "file";
    this.map = new Map();
    this.queues = new Map();
    this.ttls = new Map();
    this.watchers = []; // {prefix, cb}
    this.channels = new Map(); // channel -> Set<cb>
    this.persistent = opts.persistent || {};
    this._saveTimers = new Map(); // key -> timer
    // Load durable keys up front so a restart restores them, same as today's
    // boot-time file reads. A missing/invalid file is "not set", never fatal —
    // the same best-effort posture the policy stores have (losing one just means
    // it re-accumulates), while state.json's own oversize guard stays in
    // server.js since it is state-specific.
    for (const [key, spec] of Object.entries(this.persistent)) {
      try {
        const raw = fs.readFileSync(spec.file, "utf8");
        this.map.set(key, JSON.parse(raw));
      } catch {
        /* first boot / no volume / unreadable — treated as absent */
      }
    }
  }

  async get(key) {
    return this.map.has(key) ? snapshot(this.map.get(key)) : null;
  }

  async set(key, value, { ttlMs } = {}) {
    this.map.set(key, snapshot(value));
    this._armTtl(key, ttlMs);
    this._persist(key);
    this._fire(key, "set", value);
  }

  async del(key) {
    const had = this.map.delete(key);
    this._clearTtl(key);
    this._persist(key);
    if (had) this._fire(key, "del", null);
  }

  async setIfAbsent(key, value, { ttlMs } = {}) {
    if (this.map.has(key)) return false;
    await this.set(key, value, { ttlMs });
    return true;
  }

  async compareAndSet(key, expected, next, { ttlMs } = {}) {
    const cur = this.map.has(key) ? this.map.get(key) : null;
    if (!sameValue(cur, expected)) return false;
    await this.set(key, next, { ttlMs });
    return true;
  }

  async incrBy(key, n) {
    const cur = Number(this.map.has(key) ? this.map.get(key) : 0) || 0;
    const next = cur + Number(n);
    this.map.set(key, next);
    this._persist(key);
    this._fire(key, "set", next);
    return next;
  }

  async scan(prefix) {
    const out = [];
    for (const [key, value] of this.map) {
      if (key.startsWith(prefix)) out.push({ key, value: snapshot(value) });
    }
    return out;
  }

  // mget is scan's alias in the contract (the ADR lists "mget(prefix)/scan(prefix)").
  async mget(prefix) {
    return this.scan(prefix);
  }

  watch(prefix, cb) {
    const entry = { prefix, cb };
    this.watchers.push(entry);
    return () => {
      const i = this.watchers.indexOf(entry);
      if (i >= 0) this.watchers.splice(i, 1);
    };
  }

  async publish(channel, message) {
    const subs = this.channels.get(channel);
    if (!subs) return;
    // Copy so a subscriber unsubscribing mid-fan-out cannot reshape the set we
    // are iterating, and snapshot the message so no subscriber can mutate it for
    // the next — matching the shared backend, where each subscriber JSON.parses
    // its own copy.
    for (const cb of [...subs]) {
      try {
        cb(snapshot(message));
      } catch {
        /* a subscriber throwing must not stop the fan-out */
      }
    }
  }

  subscribe(channel, cb) {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(cb);
    return () => {
      const s = this.channels.get(channel);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.channels.delete(channel);
      }
    };
  }

  async queuePush(key, item) {
    let q = this.queues.get(key);
    if (!q) {
      q = [];
      this.queues.set(key, q);
    }
    q.push(snapshot(item));
  }

  async queueDrain(key) {
    const q = this.queues.get(key);
    if (!q || q.length === 0) return [];
    this.queues.set(key, []);
    return q.map(snapshot);
  }

  // Health is trivially "ready" for a local store — there is no connection to
  // lose — so warm-standby/HA code can read `.health` uniformly across backends.
  get health() {
    return "ready";
  }

  async ready() {
    /* already ready */
  }

  onHealth() {
    return () => {};
  }

  // Flush every pending durable write synchronously — the graceful-shutdown path.
  // Synchronous temp+rename (nothing else runs during drain), atomic like the
  // debounced path so a half-written file is never left for the next boot.
  flush() {
    for (const key of this._saveTimers.keys()) {
      clearTimeout(this._saveTimers.get(key));
    }
    this._saveTimers.clear();
    for (const key of Object.keys(this.persistent)) {
      this._writeNow(key, true);
    }
  }

  close() {
    this.flush();
    for (const t of this.ttls.values()) clearTimeout(t);
    this.ttls.clear();
  }

  // ---- internals -----------------------------------------------------------

  _fire(key, type, value) {
    for (const w of this.watchers) {
      if (key.startsWith(w.prefix)) {
        try {
          w.cb({ type, key, value: type === "del" ? null : snapshot(value) });
        } catch {
          /* a watcher throwing must not break the mutation */
        }
      }
    }
  }

  _armTtl(key, ttlMs) {
    this._clearTtl(key);
    if (!ttlMs || ttlMs <= 0) return;
    // unref so a pending expiry never keeps the process alive (matches every
    // other timer in the hub, e.g. scheduleSave's saveTimer.unref()).
    const t = setTimeout(() => {
      this.del(key).catch(() => {});
    }, ttlMs);
    t.unref?.();
    this.ttls.set(key, t);
  }

  _clearTtl(key) {
    const t = this.ttls.get(key);
    if (t) {
      clearTimeout(t);
      this.ttls.delete(key);
    }
  }

  _persist(key) {
    const spec = this.persistent[key];
    if (!spec) return;
    if (this._saveTimers.has(key)) return; // already scheduled (debounce)
    const debounce = spec.debounceMs ?? 1000;
    const t = setTimeout(() => {
      this._saveTimers.delete(key);
      this._writeNow(key, false);
    }, debounce);
    t.unref?.();
    this._saveTimers.set(key, t);
  }

  _writeNow(key, sync) {
    const spec = this.persistent[key];
    if (!spec) return;
    const file = spec.file;
    // A deleted durable key persists as an empty file? No — a durable store that
    // loses its key is "absent", so we leave the file as its last content until a
    // set rewrites it (the same as today: a store never writes "null" over its
    // own file). If the key is gone we simply skip the write.
    if (!this.map.has(key)) return;
    let blob;
    try {
      blob = JSON.stringify(this.map.get(key));
    } catch (e) {
      // Unserialisable — give up on this write rather than throw inside a timer
      // (an uncaught throw in a setTimeout exits the process; XERK-235).
      console.error(`store: could not serialize durable key ${JSON.stringify(key)}: ${e.message}`);
      return;
    }
    if (sync) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, blob);
        fs.renameSync(tmp, file);
      } catch (e) {
        console.error(`store: durable flush of ${JSON.stringify(key)} failed: ${e.message}`);
      }
      return;
    }
    fs.mkdir(path.dirname(file), { recursive: true }, () => {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFile(tmp, blob, (err) => {
        if (err) {
          console.error(`store: durable save of ${JSON.stringify(key)} failed: ${err.message}`);
          return;
        }
        fs.rename(tmp, file, (rerr) => {
          if (rerr) {
            console.error(`store: durable save of ${JSON.stringify(key)} failed: ${rerr.message}`);
            fs.unlink(tmp, () => {});
          }
        });
      });
    });
  }
}

// ============================================================================
// RESP2 codec — pure, exported for unit tests (the socket itself can't run in CI).
// ============================================================================

// Encode a command as a RESP array of bulk strings. Args are strings/numbers;
// Buffers pass through so binary-safe values survive. This is the whole write
// side of the wire protocol.
function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const a of args) {
    const buf = Buffer.isBuffer(a) ? a : Buffer.from(String(a), "utf8");
    parts.push(Buffer.from(`$${buf.length}\r\n`, "utf8"), buf, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(parts);
}

// Incremental RESP2 reply parser. `feed(chunk)` returns the array of COMPLETE
// replies decodable so far, holding any partial tail for the next chunk. Replies
// decode to: string (+), Error (-), number (:), string|null (bulk $), array|null
// (*). This is the read side; it must tolerate a reply split across any number of
// chunks (a large bulk value, a deep array) — which is why it re-parses from the
// buffer start each time and only commits once a whole reply is present.
class RespParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const r = this._tryParse(this.buf, 0);
      if (!r) break; // incomplete — wait for more bytes
      out.push(r.value);
      this.buf = this.buf.subarray(r.offset);
    }
    // Keep the tail as a standalone Buffer so subarray views don't pin the whole
    // previous concat alive.
    if (this.buf.length) this.buf = Buffer.from(this.buf);
    return out;
  }

  _lineEnd(buf, offset) {
    const i = buf.indexOf("\r\n", offset, "utf8");
    return i < 0 ? -1 : i;
  }

  _tryParse(buf, offset) {
    if (offset >= buf.length) return null;
    const type = String.fromCharCode(buf[offset]);
    const lineEnd = this._lineEnd(buf, offset + 1);
    if (lineEnd < 0) return null; // header line not complete yet
    const header = buf.toString("utf8", offset + 1, lineEnd);
    const afterHeader = lineEnd + 2;
    switch (type) {
      case "+":
        return { value: header, offset: afterHeader };
      case "-":
        return { value: new Error(header), offset: afterHeader };
      case ":":
        return { value: Number(header), offset: afterHeader };
      case "$": {
        const len = Number(header);
        if (len === -1) return { value: null, offset: afterHeader };
        const end = afterHeader + len;
        if (end + 2 > buf.length) return null; // value + trailing CRLF not all here
        return { value: buf.toString("utf8", afterHeader, end), offset: end + 2 };
      }
      case "*": {
        const count = Number(header);
        if (count === -1) return { value: null, offset: afterHeader };
        const arr = [];
        let off = afterHeader;
        for (let i = 0; i < count; i++) {
          const el = this._tryParse(buf, off);
          if (!el) return null; // an element is incomplete — whole array waits
          arr.push(el.value);
          off = el.offset;
        }
        return { value: arr, offset: off };
      }
      default:
        // An unknown type byte is a protocol desync we cannot recover from mid
        // stream; surface it as an error reply so the connection layer can reset.
        return { value: new Error(`unexpected RESP type ${JSON.stringify(type)}`), offset: afterHeader };
    }
  }
}

// ============================================================================
// SharedLiveStore — the Valkey (redis-wire) backend, selected when HA is on.
// ============================================================================
//
// Two connections, because a RESP2 connection in subscribe mode cannot also run
// ordinary commands: `cmd` for GET/SET/EVAL/etc., `sub` for pub/sub + the
// internal change channel that powers `watch`. Both reconnect with capped
// backoff; the health of the pair drives `.health` and `onHealth`, so a warm
// standby (and, later, an active replica) can see the store come and go.
//
// `watch` is implemented over the store's OWN change channel, not Redis keyspace
// notifications: those need `CONFIG SET notify-keyspace-events`, which a managed
// Valkey often denies, so every mutating op PUBLISHes a small {type,key,value}
// event to `WATCH_CHANNEL` and watchers filter by prefix. Cross-replica by
// construction (the point of a warm standby), at the cost of one extra publish
// per mutation — acceptable for the seam; wave-3 may fold it into a Lua op.
const WATCH_CHANNEL = "__turma_watch__";
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;
const PING_EVERY_MS = 15000;

class SharedLiveStore {
  /**
   * @param {object} cfg  { storeUrl }  (from resolveHaConfig)
   * @param {object} [opts] { onHealth?, connect?:boolean }  connect defaults true;
   *   pass false to construct without dialing (tests).
   */
  constructor(cfg, opts = {}) {
    this.kind = "shared";
    this.url = cfg.storeUrl;
    const u = new URL(this.url);
    this.tls = u.protocol === "rediss:";
    this.host = u.hostname;
    this.port = Number(u.port) || 6379;
    this.password = u.password ? decodeURIComponent(u.password) : (u.username && !u.password ? decodeURIComponent(u.username) : null);
    // redis://[:pass@]host:port/<db>
    const dbSeg = u.pathname.replace(/^\//, "");
    this.db = dbSeg && /^\d+$/.test(dbSeg) ? Number(dbSeg) : 0;

    this._emitter = new EventEmitter();
    this._health = "closed";
    this._closed = false;
    this._watchers = []; // {prefix, cb}
    this._channelSubs = new Map(); // channel -> Set<cb>

    this._cmd = this._makeConn("cmd");
    this._sub = this._makeConn("sub");

    if (opts.onHealth) this.onHealth(opts.onHealth);
    if (opts.connect !== false) this.connect();
  }

  get health() {
    return this._health;
  }

  onHealth(cb) {
    this._emitter.on("health", cb);
    return () => this._emitter.off("health", cb);
  }

  connect() {
    this._closed = false;
    this._openConn(this._cmd);
    this._openConn(this._sub);
  }

  // Resolves the first time BOTH connections are ready. Never rejects — a store
  // that is down at boot must reconnect, not crash the hub (availability); the
  // caller logs health instead of blocking on it.
  ready() {
    if (this._health === "ready") return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onHealth((h) => {
        if (h === "ready") {
          off();
          resolve();
        }
      });
    });
  }

  // ---- the LiveStore contract ----------------------------------------------

  async get(key) {
    const raw = await this._command("GET", key);
    return raw == null ? null : JSON.parse(raw);
  }

  async set(key, value, { ttlMs } = {}) {
    const args = ["SET", key, JSON.stringify(value)];
    if (ttlMs && ttlMs > 0) args.push("PX", String(Math.floor(ttlMs)));
    await this._command(...args);
    await this._announce("set", key, value);
  }

  async del(key) {
    await this._command("DEL", key);
    await this._announce("del", key, null);
  }

  async setIfAbsent(key, value, { ttlMs } = {}) {
    const args = ["SET", key, JSON.stringify(value), "NX"];
    if (ttlMs && ttlMs > 0) args.push("PX", String(Math.floor(ttlMs)));
    const reply = await this._command(...args);
    const ok = reply === "OK";
    if (ok) await this._announce("set", key, value);
    return ok;
  }

  // Atomic compare-and-set via a Lua script (GET-compare-then-SET in one op),
  // comparing the STORED JSON string to the expected value's JSON — the same
  // canonicalisation FileLiveStore uses, so both backends decide CAS identically.
  async compareAndSet(key, expected, next, { ttlMs } = {}) {
    const expJson = expected === null ? null : JSON.stringify(expected);
    const nextJson = JSON.stringify(next);
    const px = ttlMs && ttlMs > 0 ? String(Math.floor(ttlMs)) : "";
    const script =
      "local v=redis.call('GET',KEYS[1]) " +
      "if (v==false and ARGV[1]=='\\0nil') or v==ARGV[1] then " +
      "if ARGV[3]~='' then redis.call('SET',KEYS[1],ARGV[2],'PX',tonumber(ARGV[3])) " +
      "else redis.call('SET',KEYS[1],ARGV[2]) end return 1 else return 0 end";
    // A key with no value is `false` in Lua; represent "expected null/absent" with
    // a sentinel so it round-trips (an absent key and a JSON `null` value differ).
    const expArg = expJson === null ? "\0nil" : expJson;
    const r = await this._command("EVAL", script, "1", key, expArg, nextJson, px);
    const ok = r === 1;
    if (ok) await this._announce("set", key, next);
    return ok;
  }

  async incrBy(key, n) {
    return this._command("INCRBY", key, String(Math.trunc(Number(n))));
  }

  async scan(prefix) {
    const keys = [];
    let cursor = "0";
    do {
      const [next, batch] = await this._command("SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", "200");
      cursor = next;
      for (const k of batch) if (k !== WATCH_CHANNEL) keys.push(k);
    } while (cursor !== "0");
    if (keys.length === 0) return [];
    const vals = await this._command("MGET", ...keys);
    const out = [];
    for (let i = 0; i < keys.length; i++) {
      if (vals[i] == null) continue; // expired between SCAN and MGET
      out.push({ key: keys[i], value: JSON.parse(vals[i]) });
    }
    return out;
  }

  async mget(prefix) {
    return this.scan(prefix);
  }

  watch(prefix, cb) {
    const entry = { prefix, cb };
    this._watchers.push(entry);
    // Ensure we are subscribed to the internal change channel (idempotent).
    this._ensureSubscribed(WATCH_CHANNEL);
    return () => {
      const i = this._watchers.indexOf(entry);
      if (i >= 0) this._watchers.splice(i, 1);
    };
  }

  async publish(channel, message) {
    await this._command("PUBLISH", channel, JSON.stringify(message));
  }

  subscribe(channel, cb) {
    let subs = this._channelSubs.get(channel);
    if (!subs) {
      subs = new Set();
      this._channelSubs.set(channel, subs);
    }
    subs.add(cb);
    this._ensureSubscribed(channel);
    return () => {
      const s = this._channelSubs.get(channel);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) {
        this._channelSubs.delete(channel);
        this._subWrite(encodeCommand(["UNSUBSCRIBE", channel]));
      }
    };
  }

  // Command/ticket queue as a Redis list: RPUSH to enqueue, an atomic
  // LRANGE+DEL Lua to drain the whole list (one round trip, no lost-window).
  async queuePush(key, item) {
    await this._command("RPUSH", key, JSON.stringify(item));
  }

  async queueDrain(key) {
    const script = "local v=redis.call('LRANGE',KEYS[1],0,-1) redis.call('DEL',KEYS[1]) return v";
    const items = await this._command("EVAL", script, "1", key);
    return (items || []).map((s) => JSON.parse(s));
  }

  close() {
    this._closed = true;
    for (const conn of [this._cmd, this._sub]) {
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      if (conn.pingTimer) clearInterval(conn.pingTimer);
      try {
        conn.socket?.destroy();
      } catch {
        /* best effort */
      }
    }
    this._setHealth("closed");
  }

  // ---- connection lifecycle -------------------------------------------------

  _makeConn(role) {
    return {
      role,
      socket: null,
      parser: new RespParser(),
      pending: [], // queued command resolvers (cmd conn only)
      ready: false,
      backoff: RECONNECT_BASE_MS,
      reconnectTimer: null,
      pingTimer: null,
    };
  }

  _openConn(conn) {
    if (this._closed || conn.socket) return;
    const onError = () => {}; // handled by 'close'
    const socket = this.tls
      ? tls.connect({ host: this.host, port: this.port, servername: this.host }, () => this._onConnected(conn))
      : net.connect({ host: this.host, port: this.port }, () => this._onConnected(conn));
    conn.socket = socket;
    conn.parser = new RespParser();
    socket.on("data", (chunk) => this._onData(conn, chunk));
    socket.on("error", onError);
    socket.on("close", () => this._onClose(conn));
  }

  _onConnected(conn) {
    conn.backoff = RECONNECT_BASE_MS;
    // AUTH then SELECT before the connection counts as ready. These ride the
    // pending queue like any command; the promises are fire-and-forget here (an
    // auth failure surfaces as a rejected command later and a close).
    const boot = [];
    if (this.password) boot.push(["AUTH", this.password]);
    if (this.db) boot.push(["SELECT", String(this.db)]);
    for (const cmd of boot) {
      if (conn.role === "cmd") {
        this._sendOn(conn, cmd).catch(() => {});
      } else {
        conn.socket.write(encodeCommand(cmd)); // sub conn: reply routed/ignored
      }
    }
    conn.ready = true;
    if (conn.role === "sub") this._resubscribe(conn);
    // A periodic PING keeps a dead-but-not-closed socket honest (a silently
    // half-open TCP connection past a NAT idle timeout), same discipline as the
    // control-channel liveness ping.
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => {
      if (conn.role === "cmd") this._sendOn(conn, ["PING"]).catch(() => {});
      else conn.socket?.write(encodeCommand(["PING"]));
    }, PING_EVERY_MS);
    conn.pingTimer.unref?.();
    this._recomputeHealth();
  }

  _onData(conn, chunk) {
    let replies;
    try {
      replies = conn.parser.feed(chunk);
    } catch (e) {
      // A protocol desync we can't parse past — reset the socket to resync.
      console.error(`store: RESP parse error on ${conn.role}: ${e.message}`);
      try {
        conn.socket?.destroy();
      } catch {
        /* best effort */
      }
      return;
    }
    for (const reply of replies) {
      if (conn.role === "sub" && this._isPush(reply)) {
        this._handlePush(reply);
        continue;
      }
      // cmd connection (and boot replies on the sub conn): resolve the next
      // waiter. A reply with no waiter is a boot/PING ack on the sub conn — drop.
      const waiter = conn.pending.shift();
      if (!waiter) continue;
      if (reply instanceof Error) waiter.reject(reply);
      else waiter.resolve(reply);
    }
  }

  _onClose(conn) {
    conn.ready = false;
    conn.socket = null;
    if (conn.pingTimer) {
      clearInterval(conn.pingTimer);
      conn.pingTimer = null;
    }
    // Fail every in-flight command so callers see an error rather than hanging
    // until a timeout — the ADR's fail-narrow posture.
    const err = new Error("store connection lost");
    for (const w of conn.pending.splice(0)) w.reject(err);
    this._recomputeHealth();
    if (this._closed) return;
    // Reconnect with capped exponential backoff.
    const delay = Math.min(conn.backoff, RECONNECT_MAX_MS);
    conn.backoff = Math.min(conn.backoff * 2, RECONNECT_MAX_MS);
    conn.reconnectTimer = setTimeout(() => this._openConn(conn), delay);
    conn.reconnectTimer.unref?.();
  }

  _recomputeHealth() {
    if (this._closed) return this._setHealth("closed");
    if (this._cmd.ready && this._sub.ready) return this._setHealth("ready");
    if (this._cmd.socket || this._sub.socket) return this._setHealth("reconnecting");
    return this._setHealth("connecting");
  }

  _setHealth(h) {
    if (this._health === h) return;
    this._health = h;
    this._emitter.emit("health", h);
  }

  // ---- command send ---------------------------------------------------------

  _command(...args) {
    return this._sendOn(this._cmd, args);
  }

  _sendOn(conn, args) {
    return new Promise((resolve, reject) => {
      if (!conn.socket || !conn.ready) {
        // Not connected — reject at once rather than buffer indefinitely. A
        // caller retries or degrades; the seam does not silently swallow writes.
        reject(new Error(`store not connected (${this._health})`));
        return;
      }
      conn.pending.push({ resolve, reject });
      try {
        conn.socket.write(encodeCommand(args));
      } catch (e) {
        conn.pending.pop();
        reject(e);
      }
    });
  }

  // ---- pub/sub + watch ------------------------------------------------------

  _isPush(reply) {
    return (
      Array.isArray(reply) &&
      typeof reply[0] === "string" &&
      ["message", "pmessage", "subscribe", "unsubscribe", "psubscribe", "punsubscribe", "pong"].includes(
        reply[0].toLowerCase()
      )
    );
  }

  _handlePush(reply) {
    const kind = reply[0].toLowerCase();
    if (kind !== "message") return; // (un)subscribe acks / pong: nothing to route
    const channel = reply[1];
    const payload = reply[2];
    if (channel === WATCH_CHANNEL) {
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        return;
      }
      for (const w of this._watchers) {
        if (typeof ev.key === "string" && ev.key.startsWith(w.prefix)) {
          try {
            w.cb(ev);
          } catch {
            /* a watcher throwing must not break delivery */
          }
        }
      }
      return;
    }
    const subs = this._channelSubs.get(channel);
    if (!subs) return;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    for (const cb of [...subs]) {
      try {
        cb(msg);
      } catch {
        /* isolate subscriber errors */
      }
    }
  }

  // Broadcast a change so watchers on any replica invalidate. Best-effort: a
  // failed publish never fails the mutation it followed (the write already
  // landed; the watch is a cache-warming hint, not a correctness guarantee).
  async _announce(type, key, value) {
    try {
      await this._command("PUBLISH", WATCH_CHANNEL, JSON.stringify({ type, key, value }));
    } catch {
      /* watch is best-effort */
    }
  }

  _ensureSubscribed(channel) {
    if (this._sub.ready) this._subWrite(encodeCommand(["SUBSCRIBE", channel]));
    // If not ready, _resubscribe on the next connect re-issues everything.
  }

  _subWrite(buf) {
    try {
      this._sub.socket?.write(buf);
    } catch {
      /* the reconnect path re-subscribes */
    }
  }

  _resubscribe(conn) {
    const channels = new Set(this._channelSubs.keys());
    if (this._watchers.length) channels.add(WATCH_CHANNEL);
    if (channels.size === 0) return;
    conn.socket.write(encodeCommand(["SUBSCRIBE", ...channels]));
  }
}

// ============================================================================
// Factory — the ONE place the HA toggle selects a backend.
// ============================================================================

/**
 * Build the LiveStore for the resolved HA config.
 * @param {object} haConfig  result of resolveHaConfig(env)
 * @param {object} [opts]     { onHealth?, connect?, persistent? } forwarded to the backend
 * @returns {FileLiveStore|SharedLiveStore}
 */
function createLiveStore(haConfig, opts = {}) {
  if (haConfig && haConfig.ha) {
    return new SharedLiveStore(haConfig, opts);
  }
  return new FileLiveStore({ persistent: opts.persistent });
}

module.exports = {
  createLiveStore,
  FileLiveStore,
  SharedLiveStore,
  RespParser,
  encodeCommand,
  sameValue,
  WATCH_CHANNEL,
};
