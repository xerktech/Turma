// A minimal, streaming ustar + gzip writer — the one thing the hub needs to
// restore an archived session (XERK-441) and the one thing node has no built-in
// for.
//
// The agent unpacks a migration bundle with python's `tarfile` in `r:gz` mode
// (`_unpack_transcript`), so what is written here has to be a plain gzipped tar
// laid out relative to the project-slug dir — `<id>.jsonl`, `<id>/subagents/…`.
// That is exactly what `_pack_transcript` produces on the source agent of a live
// move, and the archive's raw layer already stores each file under that same
// session-relative name, so the two ends meet with no translation.
//
// STREAMING, not buffered, and that is not a style preference: the hub runs at
// `mem_limit: 256m` and a raw transcript can be tens of MiB, so a bundle built
// in memory is a fraction of the container per concurrent restore. Bytes go
// file -> tar framing -> gzip -> spool file, one read buffer at a time.

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const BLOCK = 512;
// ustar's own limits, not ours: 100 bytes of name, optionally split at a "/" so
// the leading part rides the 155-byte prefix field. A name that fits neither is
// not nameable in this format — see `splitUstarName`.
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/**
 * Split a member name into ustar's {prefix, name}, or null when the format
 * cannot express it.
 *
 * Deliberately NOT the GNU/PAX long-name extension python would emit: those add
 * a second member per file and a parser divergence for something no real session
 * file needs (the deepest Claude Code writes is
 * `<id>/subagents/workflows/wf_<run>/agent-x.jsonl`, well inside 255). A name
 * that does not fit is reported to the caller rather than silently truncated —
 * truncation would put one session's bytes under another session's path.
 */
function splitUstarName(name) {
  const s = String(name || "");
  if (!s || Buffer.byteLength(s) === 0) return null;
  if (Buffer.byteLength(s) <= NAME_MAX) return { prefix: "", name: s };
  // Longest prefix that fits, so the remainder has the best chance at 100.
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] !== "/") continue;
    const prefix = s.slice(0, i);
    const rest = s.slice(i + 1);
    if (!rest) continue;
    if (Buffer.byteLength(prefix) <= PREFIX_MAX && Buffer.byteLength(rest) <= NAME_MAX) {
      return { prefix, name: rest };
    }
  }
  return null;
}

function octal(n, width) {
  // ustar numbers are NUL-terminated octal in a fixed field.
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** One 512-byte ustar header for a regular file. */
function header(name, size, mtimeSec) {
  const split = splitUstarName(name);
  if (!split) throw new Error(`tar: member name is not expressible in ustar: ${name}`);
  const buf = Buffer.alloc(BLOCK);
  buf.write(split.name, 0, NAME_MAX, "utf8");
  buf.write(octal(0o644, 8), 100, 8, "ascii");        // mode
  buf.write(octal(0, 8), 108, 8, "ascii");            // uid
  buf.write(octal(0, 8), 116, 8, "ascii");            // gid
  buf.write(octal(size, 12), 124, 12, "ascii");
  buf.write(octal(Math.floor(mtimeSec), 12), 136, 12, "ascii");
  // The checksum is computed with its own field read as spaces, then written
  // back into it — the format's one circular rule.
  buf.write("        ", 148, 8, "ascii");
  buf.write("0", 156, 1, "ascii");                    // typeflag: regular file
  buf.write("ustar\0", 257, 6, "ascii");
  buf.write("00", 263, 2, "ascii");
  if (split.prefix) buf.write(split.prefix, 345, PREFIX_MAX, "utf8");
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return buf;
}

function padding(size) {
  const rem = size % BLOCK;
  return rem ? Buffer.alloc(BLOCK - rem) : Buffer.alloc(0);
}

/**
 * Pack `files` into a gzipped tar at `destPath`.
 *
 * `files` is [{name, path, size}] — `name` the session-relative member name,
 * `path` the absolute file to read, `size` the size that name was recorded at.
 * A file that is SHORTER than its recorded size (rewritten or truncated under
 * us) would leave the tar structurally broken, since the header's length is
 * already written, so the shortfall is padded with NULs and reported rather than
 * producing a bundle no tar reader can walk.
 *
 * `maxBytes` caps the COMPRESSED output — the same ceiling the migration relay
 * puts on an uploaded bundle, so a restored bundle and a migrated one are the
 * same size of thing to everything downstream. Over it, the write is aborted and
 * the partial file removed.
 *
 * Resolves {bytes, skipped}: the compressed size, and the members that could not
 * be named in ustar (never silently dropped — the caller reports them).
 */
async function packGzipTar(files, destPath, maxBytes, opts) {
  const mtime = (opts && opts.mtimeSec) || 0;
  const skipped = [];
  const packable = [];
  for (const f of files || []) {
    if (!splitUstarName(f.name)) { skipped.push(f.name); continue; }
    packable.push(f);
  }
  const short = [];
  async function* body() {
    for (const f of packable) {
      yield header(f.name, f.size, mtime);
      let written = 0;
      for await (const chunk of fs.createReadStream(f.path)) {
        // A file that GREW since it was measured must not overrun its header.
        const room = f.size - written;
        if (room <= 0) break;
        const out = chunk.length > room ? chunk.subarray(0, room) : chunk;
        written += out.length;
        yield out;
      }
      if (written < f.size) {
        short.push(f.name);
        yield Buffer.alloc(f.size - written);
      }
      const pad = padding(f.size);
      if (pad.length) yield pad;
    }
    // Two zero blocks end the archive.
    yield Buffer.alloc(BLOCK * 2);
  }

  let bytes = 0;
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(destPath);
  const counter = async function* (src) {
    for await (const chunk of src) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const e = new Error(`bundle exceeds ${maxBytes} bytes`);
        e.tooLarge = true;
        throw e;
      }
      yield chunk;
    }
  };
  try {
    await pipeline(Readable.from(body()), gz, counter, out);
  } catch (e) {
    try { fs.unlinkSync(destPath); } catch {}
    throw e;
  }
  return { bytes, skipped, short };
}

module.exports = { packGzipTar, splitUstarName, _internals: { header, octal, BLOCK } };
