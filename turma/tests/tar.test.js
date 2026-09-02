// Unit tests for turma/tar.js — the hub's ustar+gzip writer (XERK-441).
//
// What it writes is read by PYTHON's `tarfile` on the agent, not by anything in
// this repo, so the tests assert the bytes: the header fields, the checksum, the
// 512-byte framing and the two-block terminator. A writer that only round-trips
// through its own reader would prove nothing about the other end.

"use strict";

const fs = require("fs");
const path = require("path");
const { mkdtemp } = require("./tmpdirs");
const zlib = require("zlib");
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");

const { packGzipTar, splitUstarName } = require("../tar.js");

const dir = mkdtemp("turma-tar-");
function file(name, content) {
  const p = path.join(dir, name.replace(/\//g, "_"));
  fs.writeFileSync(p, content);
  return { name, path: p, size: Buffer.byteLength(content) };
}

test("packs files python's tarfile reads back byte for byte", async () => {
  const out = path.join(dir, "a.tgz");
  const conv = '{"a":1}\n{"b":2}\n';
  const sub = "x".repeat(1000);
  const r = await packGzipTar(
    [file("id.jsonl", conv), file("id/subagents/qa.jsonl", sub)], out, 1 << 20);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.short.length, 0);
  assert.equal(r.bytes, fs.statSync(out).size);
  // The agent unpacks with `tarfile.open(mode="r:gz")` and writes each member by
  // hand — so that is what is checked here, not a node reader.
  const seen = execFileSync("python3", ["-c", `
import tarfile, json
t = tarfile.open(${JSON.stringify(out)}, "r:gz")
print(json.dumps({m.name: t.extractfile(m).read().decode() for m in t.getmembers() if m.isreg()}))
`]).toString();
  assert.deepEqual(JSON.parse(seen), { "id.jsonl": conv, "id/subagents/qa.jsonl": sub });
});

test("the archive ends with two zero blocks, so a reader knows it is complete", async () => {
  const out = path.join(dir, "b.tgz");
  await packGzipTar([file("t.jsonl", "hi\n")], out, 1 << 20);
  const tar = zlib.gunzipSync(fs.readFileSync(out));
  assert.equal(tar.length % 512, 0);
  assert.ok(tar.subarray(tar.length - 1024).every((b) => b === 0));
});

test("a file that shrank under us is padded and REPORTED, never silently short", async () => {
  // The header's size is written before the bytes are read, so a file truncated
  // mid-pack would leave an archive no reader can walk past. Padding keeps it
  // walkable; the report is what stops that being a silent loss.
  const out = path.join(dir, "c.tgz");
  const f = file("s.jsonl", "0123456789");
  fs.writeFileSync(f.path, "012");           // shrank after being measured
  const r = await packGzipTar([f], out, 1 << 20);
  assert.deepEqual(r.short, ["s.jsonl"]);
  const tar = zlib.gunzipSync(fs.readFileSync(out));
  assert.equal(tar.subarray(512, 522).toString("binary"), "012\0\0\0\0\0\0\0");
});

test("a file that GREW under us is cut to the size its header promised", async () => {
  const out = path.join(dir, "d.tgz");
  const f = file("g.jsonl", "012");
  fs.writeFileSync(f.path, "0123456789");
  const r = await packGzipTar([f], out, 1 << 20);
  assert.deepEqual(r.short, []);
  const tar = zlib.gunzipSync(fs.readFileSync(out));
  assert.equal(tar.subarray(512, 515).toString("utf8"), "012");
});

test("over the ceiling the write is abandoned, not left half-written on /data", async () => {
  const out = path.join(dir, "e.tgz");
  const big = file("big.jsonl", "compressible".repeat(200000));
  await assert.rejects(() => packGzipTar([big], out, 64), (e) => e.tooLarge === true);
  assert.equal(fs.existsSync(out), false, "the partial spool file is removed");
});

test("splitUstarName uses the prefix field, and refuses what ustar cannot name", () => {
  assert.deepEqual(splitUstarName("a.jsonl"), { prefix: "", name: "a.jsonl" });
  const deep = "d".repeat(120) + "/" + "f".repeat(60);
  assert.deepEqual(splitUstarName(deep), { prefix: "d".repeat(120), name: "f".repeat(60) });
  // 101 bytes with no separator to split at: not expressible without the
  // GNU/PAX long-name extension, which this deliberately does not emit.
  assert.equal(splitUstarName("z".repeat(101)), null);
  assert.equal(splitUstarName(""), null);
});

test("an unnameable member is skipped and reported, never truncated into another path", async () => {
  const out = path.join(dir, "f.tgz");
  const bad = file("y".repeat(101), "nope");
  const good = file("ok.jsonl", "yes\n");
  const r = await packGzipTar([bad, good], out, 1 << 20);
  assert.deepEqual(r.skipped, ["y".repeat(101)]);
  const tar = zlib.gunzipSync(fs.readFileSync(out));
  assert.equal(tar.subarray(0, 8).toString("utf8"), "ok.jsonl");
});
