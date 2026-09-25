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
//     push OVER the complete object). Asking queues a background fetch; the
//     read-back routes `await fetchRawUnder(dir)` first.
//
// With HA off this module is never wired (createBlobStore returns null), so the
// single-process path is byte-identical: local files ARE the of-record, no sink,
// no worker.

"use strict";

const fs = require("fs");
const path = require("path");

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
  // leader warm-restarting with un-mirrored appends (local ahead of the bucket)
  // is never truncated back to the of-record. Its local files are append-only and
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
        listing = typeof this.blobStore.listSizes === "function"
          ? await this.blobStore.listSizes("")
          : (await this.blobStore.list("")).map((key) => ({ key, size: null }));
      } catch (e) {
        this.log(`archive hydrate: list failed (${e && e.message}); the store retries`);
        return 0;
      }
      // Rebuilt from THIS listing: a promotion re-hydrate must not keep a key the
      // bucket no longer holds pending forever.
      this._rawPending.clear();
      this._rawWanted.clear();
      let pendingRaw = 0;
      for (const item of listing) {
        const key = item.key;
        const dest = this.pathFor(key);
        if (!dest) continue;
        let remote = Number.isFinite(item.size) ? { size: item.size } : null;
        if (!remote) {
          try {
            remote = await this.blobStore.stat(key);
          } catch { remote = null; }
        }
        if (!remote) continue;
        let localSize = -1;
        try { localSize = fs.statSync(dest).size; } catch { localSize = -1; }
        // Skip when local is same-size OR larger (ahead of the bucket) — only a
        // missing/partial (smaller) local is (re)fetched. Never truncate a leader.
        if (localSize >= remote.size) continue;
        const root = rawRootOf(key);
        if (root) {
          // Raw layer: recorded, not downloaded (see the header).
          if (!this._rawPending.has(root)) this._rawPending.set(root, new Map());
          this._rawPending.get(root).set(key, remote.size);
          pendingRaw++;
          continue;
        }
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const ok = await this.blobStore.getToFile(key, dest);
          if (ok) fetched++;
        } catch (e) {
          this.log(`archive hydrate: ${key} failed (${e && e.message}); skipped`);
        }
      }
      if (pendingRaw) {
        this.log(`archive hydrate: ${pendingRaw} raw-layer object(s) left in the ` +
          `bucket, fetched on demand (XERK-1043)`);
      }
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

  // The pending entry for an absolute path: {root, map, key}, or null.
  _pendingEntry(absPath) {
    const key = this.keyFor(absPath);
    if (!key) return null;
    const root = rawRootOf(key);
    const map = root && this._rawPending.get(root);
    return map && map.has(key) ? { root, map, key } : null;
  }

  // SYNC, for archive.js's raw cursor: is this raw file in the bucket but not yet
  // on local disk? Asking queues its fetch, so the answer turns false (and the
  // local size becomes the cursor) a beat or two later.
  rawPending(absPath) {
    const p = this._pendingEntry(absPath);
    if (!p) return false;
    this._rawWanted.add(p.key);
    this._pumpRaw();
    return true;
  }

  // SYNC: bytes the bucket holds under `absDir` that are not on local disk yet —
  // what archive.js adds to a raw directory's walked size so `rawBytes` (the
  // per-transcript raw budget) counts the whole copy, not just the local part.
  rawPendingBytes(absDir) {
    const key = this.keyFor(absDir);
    // `absDir` may be the raw root itself (archive.js sums the whole
    // `<x>.jsonl.raw`) or a directory under it; either way it has files below.
    const root = key && rawRootOf(key + "/_");
    const map = root && this._rawPending.get(root);
    if (!map) return 0;
    const prefix = key + "/";
    let bytes = 0;
    for (const [k, size] of map) if (k === key || k.startsWith(prefix)) bytes += size;
    return bytes;
  }

  // Fetch every pending raw object under `absDir` and resolve once they are all
  // local (or have failed). Returns how many are STILL pending, so a read-back
  // route can answer "still syncing" rather than serve a partial directory.
  async fetchRawUnder(absDir) {
    const key = this.keyFor(absDir);
    const root = key && rawRootOf(key + "/_"); // see rawPendingBytes
    const map = root && this._rawPending.get(root);
    if (!map) return 0;
    const prefix = key + "/";
    const keys = [...map.keys()].filter((k) => k === key || k.startsWith(prefix));
    await Promise.all(keys.map((k) => this._fetchRaw(k).catch(() => {})));
    const left = this._rawPending.get(root);
    return left ? keys.filter((k) => left.has(k)).length : 0;
  }

  // One raw object, downloaded to a temp file and RENAMED into place, so a
  // half-written file is never visible at its real path (its size is a cursor).
  // Deduped per key; a failure leaves it pending for the next ask.
  _fetchRaw(key) {
    const running = this._rawInflight.get(key);
    if (running) return running;
    const run = (async () => {
      const dest = this.pathFor(key);
      const root = rawRootOf(key);
      if (!dest || !root) return;
      // A dot-directory at the archive root: every tree walk in archive.js either
      // skips it or finds no `.jsonl` in it, and it shares the volume, so the
      // rename is atomic.
      const tmpDir = path.join(this.archiveDir, ".raw-fetch");
      const tmp = path.join(tmpDir, `${process.pid}-${++this._tmpSeq}.part`);
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
        const ok = await this.blobStore.getToFile(key, tmp);
        if (ok) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(tmp, dest);
        }
        // Landed, or gone from the bucket (404) — either way no longer pending.
        const map = this._rawPending.get(root);
        if (map) {
          map.delete(key);
          if (!map.size) this._rawPending.delete(root);
        }
      } catch (e) {
        this.log(`archive raw fetch: ${key} failed (${e && e.message}); retried on next use`);
        throw e;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* renamed, or never written */ }
      }
    })();
    this._rawInflight.set(key, run);
    run.then(() => this._rawInflight.delete(key), () => this._rawInflight.delete(key));
    return run;
  }

  // The background fetcher for keys asked about from the (sync) cursor path. One
  // at a time: a heartbeat can ask about up to ARCHIVE_RAW_CURSOR_MAX files, and
  // this must never turn into that many parallel downloads.
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
