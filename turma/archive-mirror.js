// The archive's object-store MIRROR + HYDRATE (XERK-759, epic XERK-751).
//
// archive.js writes both byte layers to the local ARCHIVE_DIR tree SYNCHRONOUSLY
// on the ingest path, and its SQLite index is disposable — `rebuildIndex()`
// re-derives every row (cursors included: `bytesStored` from the `.meta` sidecar,
// `rawBytes`/`archiveBytes` from the files). This module makes OBJECT STORAGE the
// of-record for those bytes without touching that synchronous hot path:
//
//   - NOTE (sync, cheap): archive.js calls an injected sink after each durable
//     file write; the sink is `note(absPath)`, which just records the relative
//     key in a dirty set. Nothing here runs on the heartbeat/ingest path.
//   - DRAIN (async, OFF the beat): a worker pushes the dirty files up to the blob
//     store. LEADER-ONLY — in Option 2 only the leader ingests, so only it has
//     dirty files, and gating the PUSH on the leader makes "exactly one writer of
//     the of-record" explicit (the ticket's "single owning writer"). The leader
//     gate is the not-yet-landed XERK-763 seam; until then it defaults to true.
//   - HYDRATE (async, at boot AND on promotion): pull the RENDERED layer back
//     down to the local tree, then `reindex()` so a freshly-started replica
//     (empty ephemeral disk) can serve reads and search. Until it completes,
//     archive reads 404 "still syncing" — the SAME honest answer archive.js
//     already gives for a not-yet-synced transcript. This is the promotion cost
//     the ADR flags for the single-writer option; accepted for Option 2.
//   - RAW LAYER IS LAZY (XERK-1043): keys under a `<x>.jsonl.raw/` directory are
//     ~83% of the bucket and almost never read, and pulling them into every
//     replica's size-limited emptyDir evicted the pod mid-hydrate once the bucket
//     outgrew it. Hydrate records them as REMOTE-PENDING instead. archive.js asks
//     `rawPending(path)` before trusting a raw file's size as its ingest cursor:
//     a pending file answers "cannot tell", so ingest refuses rather than letting
//     an agent restart it from 0 (whose partial local copy the drain would then
//     push OVER the complete object). Only that ingest ask queues a fetch; the
//     heartbeat cursor advertises the bucket's size instead (`rawPendingSize`),
//     so an unchanged file is never pulled down at all. The read-back routes
//     `await fetchRawUnder(dir)` first.
//
// With HA off this module is never wired (createBlobStore returns null), so the
// single-process path is byte-identical: local files ARE the of-record, no sink,
// no worker.

"use strict";

const fs = require("fs");
const path = require("path");

// How many raw objects one read-back route fetches at once, and how long it waits
// before answering "still syncing" (the fetches carry on). XERK-1043.
const RAW_FETCH_CONCURRENCY = 4;
const RAW_ROUTE_WAIT_MS = 10 * 1000;

class ArchiveMirror {
  /**
   * @param {object}  o
   * @param {object}  o.blobStore  a BlobStore (blobstore.js): put/getToFile/stat/list.
   * @param {string}  o.archiveDir the local ARCHIVE_DIR root the keys are relative to.
   * @param {Function} o.reindex   called after a hydrate to rebuild the local index.
   * @param {Function} [o.isLeader] leader gate for the PUSH (XERK-763); default true.
   * @param {Function} [o.log]     console.error-shaped logger.
   */
  constructor({ blobStore, archiveDir, reindex, isLeader, log }) {
    this.blobStore = blobStore;
    // archiveDir is ARCHIVE_DIR (operator env / a fixed default), not user input;
    // keyFor/pathFor below re-check every derived path against this resolved root.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    this.archiveDir = path.resolve(archiveDir);
    this.reindex = typeof reindex === "function" ? reindex : () => {};
    this.isLeader = typeof isLeader === "function" ? isLeader : () => true;
    this.log = typeof log === "function" ? log : (m) => console.error(m);
    this._dirty = new Set();
    this._draining = false;
    this._hydrating = false;
    // Remote-pending raw objects: raw-root key (`<repo>/<x>.jsonl.raw`) ->
    // Map(key -> remote size). Grouped by root so the per-transcript questions
    // (pending bytes, fetch a directory) never scan the whole bucket's keys.
    this._rawPending = new Map();
    this._rawWanted = new Set();   // pending keys queued for the background fetch
    this._rawInflight = new Map(); // key -> Promise, so a key is fetched once
    this._rawPumping = false;
    this._tmpSeq = 0;
    // Did the last hydrate COMPLETE — list the bucket AND land every rendered file
    // it needed? Until one has, the local tree does not match the of-record the
    // Postgres cursors describe, and ingest must stay closed (XERK-1048).
    this.hydrated = false;
  }

  // The blob key for an absolute path under ARCHIVE_DIR, or null if it escapes
  // the tree (defensive — every real caller passes a path archive.js just wrote
  // under ARCHIVE_DIR). POSIX '/' separators so a key is portable across a Linux
  // hub and any object store.
  keyFor(absPath) {
    // The `..`/absolute-rel check IS the traversal guard — a key is returned only
    // when the path resolves strictly under archiveDir.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const rel = path.relative(this.archiveDir, path.resolve(absPath));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  // The absolute local path for a blob key, or null if the key would escape the
  // tree (keys come from our OWN bucket, but never trust a listing to write
  // outside ARCHIVE_DIR — the tar-extract discipline).
  pathFor(key) {
    if (typeof key !== "string" || !key || key.includes("\0")) return null;
    // Every component a plain name: a listed `a.jsonl.raw/t/../../b.jsonl` stays
    // inside the tree but would land on ANOTHER transcript's file.
    if (key.split("/").some((c) => !c || c === "." || c === "..")) return null;
    // The startsWith(archiveDir + sep) check below IS the traversal guard — a
    // listing key that would escape the tree returns null, never a path.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const abs = path.resolve(this.archiveDir, key);
    if (abs !== this.archiveDir && !abs.startsWith(this.archiveDir + path.sep)) return null;
    return abs;
  }

  // archive.js's write sink. SYNC and cheap — record the key, nothing else.
  note(absPath) {
    const key = this.keyFor(absPath);
    if (key) this._dirty.add(key);
  }

  pending() {
    return this._dirty.size;
  }

  // Push every dirty file to the blob store. Best-effort per file: a failed push
  // is re-queued for the next drain (the archive's own re-push discipline — a
  // lagging of-record only means an agent re-sends the un-mirrored tail on
  // promotion, never data loss). Serialized so two workers never overlap.
  async drain() {
    if (!this.blobStore || this._draining) return 0;
    if (!this.isLeader()) return 0; // single owning writer (XERK-763 seam)
    this._draining = true;
    let pushed = 0;
    try {
      const batch = Array.from(this._dirty);
      for (const key of batch) {
        this._dirty.delete(key);
        const file = this.pathFor(key);
        if (!file) continue;
        try {
          await this.blobStore.put(key, { file });
          pushed++;
        } catch (e) {
          // ENOENT = the local file was deleted between note and push (a raced
          // operator delete); drop it. Anything else is transient — re-queue.
          if (!(e && e.code === "ENOENT")) this._dirty.add(key);
        }
      }
    } finally {
      this._draining = false;
    }
    return pushed;
  }

  // Pull every RENDERED-layer object down to the local tree (a freshly-booted or
  // promoted replica starts empty; raw-layer objects are only recorded as
  // pending — see the header), then rebuild the index from it. Only downloads a key
  // whose local copy is ABSENT or SMALLER than the object (missing, or a partial
  // download to finish) — NEVER when the local copy is same-size-or-larger, so a
  // leader warm-restarting with un-mirrored appends (local ahead of the bucket) is
  // never truncated back to the of-record. Its local files are append-only and
  // authoritative; the un-mirrored tail re-mirrors on the next drain. A leader
  // that has been writing thus hydrates to a near-no-op. Best-effort per key.
  // Returns the count downloaded.
  async hydrate() {
    if (!this.blobStore || this._hydrating) return 0;
    this._hydrating = true;
    let fetched = 0;
    try {
      // [{key, size}] in one listing when the store can give sizes (S3 always
      // does); otherwise a HEAD per key, the pre-XERK-1043 shape.
      let listing;
      try {
        if (typeof this.blobStore.listSizes === "function") {
          listing = await this.blobStore.listSizes("");
        } else {
          listing = [];
          for (const key of await this.blobStore.list("")) {
            let st = null;
            try { st = await this.blobStore.stat(key); } catch { st = null; }
            if (st) listing.push({ key, size: st.size });
          }
        }
      } catch (e) {
        this.hydrated = false;
        this.lastFailure = `listing the bucket failed (${e && e.message}) — is the object store reachable?`;
        return 0;
      }
      const failures = [];
      // Classify EVERY key against local disk and swap the pending set in ONE
      // synchronous step — no await between the listing and the swap. Clearing
      // the set and refilling it across the download loop's awaits left a window
      // on a promotion re-hydrate where a still-remote raw file read as ENOENT
      // (cursor 0), so an agent re-shipped it from 0 and the drain PUT the partial
      // copy over the complete object (XERK-1043 QA D1).
      const nextPending = new Map();
      const downloads = [];
      let pendingRaw = 0;
      for (const item of listing) {
        const key = item && item.key;
        const dest = this.pathFor(key);
        if (!dest || !Number.isFinite(item.size)) continue;
        let localSize = -1;
        try { localSize = fs.statSync(dest).size; } catch { localSize = -1; }
        // Skip when local is same-size OR larger (ahead of the bucket) — only a
        // missing/partial (smaller) local is (re)fetched. Never truncate a leader.
        if (localSize >= item.size) continue;
        const root = rawRootOf(key);
        if (root) {
          // Raw layer: recorded, not downloaded (see the header). `have` is the
          // partial local copy (if any), so pending bytes count only the excess.
          if (!nextPending.has(root)) nextPending.set(root, new Map());
          nextPending.get(root).set(key, { size: item.size, have: Math.max(localSize, 0) });
          pendingRaw++;
        } else {
          downloads.push({ key, dest });
        }
      }
      this._rawPending = nextPending;
      for (const k of [...this._rawWanted]) if (!this._isPending(k)) this._rawWanted.delete(k);
      // Said once per change, not on every retry of an incomplete hydrate.
      if (pendingRaw && pendingRaw !== this._loggedPendingRaw) {
        this.log(`archive hydrate: ${pendingRaw} raw-layer object(s) left in the ` +
          `bucket, fetched on demand (XERK-1043)`);
      }
      this._loggedPendingRaw = pendingRaw;
      for (const { key, dest } of downloads) {
        try {
          // Through a temp file too: a GET cut mid-body left a PARTIAL rendered
          // file at its real path, which ingest would then append to and the
          // drain PUT over the complete object (XERK-1043 QA, pass 2).
          if (await this._download(key, dest)) fetched++;
        } catch (e) {
          failures.push(`${key} (${e && e.message})`);
        }
      }
      // A rendered file that did not land is ABSENT (or short) locally while
      // Postgres holds its full cursor: ingest onto it writes a tail-only file the
      // drain PUTs over the complete object — the same loss as a failed listing.
      // One summary line per attempt, never one per key: a persistent failure
      // across a whole prod listing was ~9000 lines a minute (XERK-1048 QA).
      this.hydrated = failures.length === 0;
      this.lastFailure = failures.length
        ? `${failures.length} rendered download(s) failed, e.g. ${failures.slice(0, 3).join("; ")}`
        : null;
      // Reindex whatever landed, so search + cursors reflect the hydrated store.
      // Never fatal — a rebuild hiccup leaves the index stale, not the hub down.
      try { this.reindex(); } catch (e) {
        this.log(`archive hydrate: reindex failed (${e && e.message})`);
      }
    } finally {
      this._hydrating = false;
    }
    return fetched;
  }

  // hydrate(), retried with capped exponential backoff until it COMPLETES (lists
  // and lands every rendered file; a retry only fetches what is still missing).
  // A replica that opened ingest after a failed listing served Postgres cursors
  // over an EMPTY local tree: agents re-shipped tails onto missing files and the
  // drain PUT those partial files over the complete objects (XERK-1048). The
  // caller keeps ingest gated for as long as this runs. `sleep` is injectable
  // for tests.
  async hydrateUntilListed({ firstDelayMs = 2000, maxDelayMs = 60 * 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let fetched = await this.hydrate();
    for (let delay = firstDelayMs; this.blobStore && !this.hydrated;
      delay = Math.min(delay * 2, maxDelayMs)) {
      this.log(`archive hydrate: incomplete — ${this.lastFailure}. Archive ingest ` +
        `stays closed on this replica; retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      fetched = await this.hydrate();
    }
    return fetched;
  }

  // The byte hydrate as server.js runs it: archive ingest GATED CLOSED (via the
  // injected `setGate`, archive.setHydrating) for the whole of hydrateUntilListed,
  // released only in `finally`. Kept here, not inline in server.js, so the gate
  // itself is under test — dropping it silently brings XERK-1048's loss back.
  async hydrateGated(setGate, opts) {
    setGate(true);
    try { return await this.hydrateUntilListed(opts); }
    finally { setGate(false); }
  }

  _isPending(key) {
    const root = rawRootOf(key);
    const map = root && this._rawPending.get(root);
    return !!(map && map.has(key));
  }

  // The pending keys under a directory, as [key, {size, have}] — `absDir` may be
  // the raw root itself (archive.js sums the whole `<x>.jsonl.raw`) or any
  // directory under it.
  _pendingUnder(absDir) {
    const key = this.keyFor(absDir);
    const root = key && rawRootOf(key + "/_");
    const map = root && this._rawPending.get(root);
    if (!map) return [];
    const prefix = key + "/";
    return [...map].filter(([k]) => k.startsWith(prefix));
  }

  // SYNC, for archive.js's INGEST cursor: is this raw file in the bucket but not
  // yet (fully) on local disk? Asking queues its fetch — only ingest asks, i.e.
  // only a file an agent actually has new bytes for is ever pulled back down.
  rawPending(absPath) {
    const key = this.keyFor(absPath);
    if (!key || !this._isPending(key)) return false;
    this._rawWanted.add(key);
    this._pumpRaw();
    return true;
  }

  // SYNC, ADVISORY: the bucket's size for a pending raw file (null if it is not
  // pending). The heartbeat hands this back as the agent's cursor, so an agent
  // whose copy is no longer than the bucket's ships nothing, and one with more
  // ships only the tail — without this hub fetching anything.
  rawPendingSize(absPath) {
    const key = this.keyFor(absPath);
    if (!key || !this._isPending(key)) return null;
    return this._rawPending.get(rawRootOf(key)).get(key).size;
  }

  // SYNC: the pending files under `absDir`, as [{path (relative), bytes}].
  rawPendingFiles(absDir) {
    const key = this.keyFor(absDir);
    return this._pendingUnder(absDir)
      .map(([k, v]) => ({ path: k.slice(key.length + 1), bytes: v.size }));
  }

  // SYNC: bytes the bucket holds under `absDir` BEYOND what is on local disk —
  // added to a raw directory's walked size so `rawBytes` (the per-transcript raw
  // budget) counts the whole copy once: a partial local copy is not counted twice.
  rawPendingBytes(absDir) {
    let bytes = 0;
    for (const [, v] of this._pendingUnder(absDir)) bytes += Math.max(0, v.size - v.have);
    return bytes;
  }

  // Fetch every pending raw object under `absDir` (RAW_FETCH_CONCURRENCY at a
  // time) and resolve once they are local, or at `timeoutMs` — the fetches carry
  // on in the background. Returns how many are STILL pending, so a read-back
  // route answers "still syncing" rather than serve a partial directory, and never
  // holds an operator for the store's full request timeout.
  async fetchRawUnder(absDir, { timeoutMs = RAW_ROUTE_WAIT_MS } = {}) {
    const keys = this._pendingUnder(absDir).map(([k]) => k);
    if (!keys.length) return 0;
    const queue = keys.slice();
    const worker = async () => {
      while (queue.length) {
        const k = queue.shift();
        try { await this._fetchRaw(k); } catch { /* logged; stays pending */ }
      }
    };
    const work = Promise.all(Array.from(
      { length: Math.min(RAW_FETCH_CONCURRENCY, keys.length) }, worker));
    let timer;
    await Promise.race([
      work,
      new Promise((r) => { timer = setTimeout(r, timeoutMs); if (timer.unref) timer.unref(); }),
    ]);
    clearTimeout(timer);
    return keys.filter((k) => this._isPending(k)).length;
  }

  // One raw object, downloaded to a temp file and RENAMED into place, so a
  // half-written file is never visible at its real path (its size is a cursor).
  // Deduped per key; a failure leaves it pending for the next ask. Pending is
  // re-checked before the GET and again before the rename: a key that stopped
  // being pending meanwhile (already landed via another path, or a re-hydrate
  // found it local) is never downloaded over — its local file may have grown
  // since, and renaming the bucket copy over it would regress the cursor (QA D2).
  _fetchRaw(key) {
    const running = this._rawInflight.get(key);
    if (running) return running;
    if (!this._isPending(key)) return Promise.resolve();
    const run = (async () => {
      const dest = this.pathFor(key);
      if (!dest) return;
      try {
        // Landed, or gone from the bucket (404) — either way no longer pending.
        // The re-check runs AFTER the GET, before the rename (see above).
        await this._download(key, dest, () => this._isPending(key));
        if (!this._isPending(key)) return;
        const root = rawRootOf(key);
        const map = this._rawPending.get(root);
        if (map) {
          map.delete(key);
          if (!map.size) this._rawPending.delete(root);
        }
      } catch (e) {
        this._logFetchFailure(key, e);
        throw e;
      }
    })();
    this._rawInflight.set(key, run);
    run.then(() => this._rawInflight.delete(key), () => this._rawInflight.delete(key));
    return run;
  }

  // GET `key` into a temp file and RENAME it to `dest`, so `dest` only ever holds a
  // complete object (a file's size is its ingest cursor). The temp lives in a
  // dot-directory at the archive root: every tree walk in archive.js either skips
  // it or finds no `.jsonl` in it, and it shares the volume, so the rename is
  // atomic. `stillWanted` is re-asked after the GET: false discards the download.
  // Returns true when `dest` was written, false on a 404 or a discard.
  async _download(key, dest, stillWanted = () => true) {
    const tmpDir = path.join(this.archiveDir, ".raw-fetch");
    const tmp = path.join(tmpDir, `${process.pid}-${++this._tmpSeq}.part`);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      const ok = await this.blobStore.getToFile(key, tmp);
      if (!ok || !stillWanted()) return false;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tmp, dest);
      return true;
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* renamed, or never written */ }
    }
  }

  // A store outage fails every fetch; say so once a minute, not once per file.
  _logFetchFailure(key, e) {
    const now = Date.now();
    this._fetchFailures = (this._fetchFailures || 0) + 1;
    if (now - (this._fetchLogAt || 0) < 60 * 1000) return;
    this._fetchLogAt = now;
    this.log(`archive raw fetch: ${key} failed (${e && e.message}); ` +
      `${this._fetchFailures} failure(s) in the last minute, each retried on next use`);
    this._fetchFailures = 0;
  }

  // The background fetcher for keys ingest asked about. One at a time: a beat can
  // push to many files, and this must never turn into that many parallel
  // downloads. A key that stopped being pending meanwhile is skipped.
  async _pumpRaw() {
    if (this._rawPumping || !this.blobStore) return;
    this._rawPumping = true;
    try {
      while (this._rawWanted.size) {
        const key = this._rawWanted.values().next().value;
        this._rawWanted.delete(key);
        try { await this._fetchRaw(key); } catch { /* logged; stays pending */ }
      }
    } finally {
      this._rawPumping = false;
    }
  }
}

// The raw-root key a blob key lives under — `<dirs>/<name>.jsonl.raw`, the first
// component (never the top level) ending in `.jsonl.raw`, archive.js's
// RAW_DIR_SUFFIX / isRawDir rule — or null for a rendered-layer key.
function rawRootOf(key) {
  const parts = String(key).split("/");
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i].endsWith(".jsonl.raw")) return parts.slice(0, i + 1).join("/");
  }
  return null;
}

module.exports = { ArchiveMirror, rawRootOf };
