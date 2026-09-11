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
//   - HYDRATE (async, at boot AND on promotion): pull every object back down to
//     the local tree, then `reindex()` so a freshly-started replica (empty
//     ephemeral disk) can serve reads and search. Until it completes, archive
//     reads 404 "still syncing" — the SAME honest answer archive.js already gives
//     for a not-yet-synced transcript. This is the promotion cost the ADR flags
//     for the single-writer option; accepted for Option 2 (failover is rare).
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
    this.archiveDir = path.resolve(archiveDir);
    this.reindex = typeof reindex === "function" ? reindex : () => {};
    this.isLeader = typeof isLeader === "function" ? isLeader : () => true;
    this.log = typeof log === "function" ? log : (m) => console.error(m);
    this._dirty = new Set();
    this._draining = false;
    this._hydrating = false;
  }

  // The blob key for an absolute path under ARCHIVE_DIR, or null if it escapes
  // the tree (defensive — every real caller passes a path archive.js just wrote
  // under ARCHIVE_DIR). POSIX '/' separators so a key is portable across a Linux
  // hub and any object store.
  keyFor(absPath) {
    const rel = path.relative(this.archiveDir, path.resolve(absPath));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  // The absolute local path for a blob key, or null if the key would escape the
  // tree (keys come from our OWN bucket, but never trust a listing to write
  // outside ARCHIVE_DIR — the tar-extract discipline).
  pathFor(key) {
    if (typeof key !== "string" || !key || key.includes("\0")) return null;
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

  // Pull every object down to the local tree (a freshly-booted or promoted
  // replica starts empty), then rebuild the index from it. Only downloads a key
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
      let keys;
      try {
        keys = await this.blobStore.list("");
      } catch (e) {
        this.log(`archive hydrate: list failed (${e && e.message}); the store retries`);
        return 0;
      }
      for (const key of keys) {
        const dest = this.pathFor(key);
        if (!dest) continue;
        let remote;
        try {
          remote = await this.blobStore.stat(key);
        } catch { remote = null; }
        if (!remote) continue;
        let localSize = -1;
        try { localSize = fs.statSync(dest).size; } catch { localSize = -1; }
        // Skip when local is same-size OR larger (ahead of the bucket) — only a
        // missing/partial (smaller) local is (re)fetched. Never truncate a leader.
        if (localSize >= remote.size) continue;
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const ok = await this.blobStore.getToFile(key, dest);
          if (ok) fetched++;
        } catch (e) {
          this.log(`archive hydrate: ${key} failed (${e && e.message}); skipped`);
        }
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
}

module.exports = { ArchiveMirror };
