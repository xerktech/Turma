// The archive BlobStore (XERK-759): the SigV4 signer against AWS's own canonical
// vector, the pure encoders/parsers, the factory's backend selection, and the
// FULL put/get/stat/list/del round-trip driven over a LOCAL http fake-S3 (so the
// socket path IS exercised in CI — no live MinIO, the same "pure core in CI,
// real endpoint in host QA" posture SharedLiveStore takes). zero-npm.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { mkdtemp } = require("./tmpdirs");
const {
  createBlobStore,
  S3BlobStore,
  signRequest,
  canonicalQuery,
  encodeS3Path,
  parseListXml,
  xmlDecode,
} = require("../blobstore.js");

// ---- SigV4 -----------------------------------------------------------------

test("signRequest matches AWS's canonical GET Object vector", () => {
  const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const h = signRequest({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    canonicalUri: "/test.txt",
    query: {},
    headers: { range: "bytes=0-9" },
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    now: new Date("2013-05-24T00:00:00Z"),
    payloadHash: EMPTY,
  });
  const sig = /Signature=([0-9a-f]+)/.exec(h.Authorization)[1];
  assert.equal(sig, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  // The three amz headers are always present and consistent.
  assert.equal(h["x-amz-content-sha256"], EMPTY);
  assert.equal(h["x-amz-date"], "20130524T000000Z");
  assert.match(h.Authorization, /Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
});

test("signRequest defaults to UNSIGNED-PAYLOAD (streaming body, not hashed)", () => {
  const h = signRequest({
    method: "PUT", host: "h", canonicalUri: "/b/k", query: {}, headers: {},
    accessKey: "AK", secretKey: "SK", region: "us-east-1", service: "s3",
    now: new Date("2026-01-02T03:04:05Z"),
  });
  assert.equal(h["x-amz-content-sha256"], "UNSIGNED-PAYLOAD");
});

// ---- pure encoders / parsers ------------------------------------------------

test("encodeS3Path keeps '/' and the unreserved set, percent-encodes the rest", () => {
  assert.equal(encodeS3Path("a/b c/d.jsonl"), "a/b%20c/d.jsonl");
  assert.equal(encodeS3Path("re-po/2026-07__x__h__ab.jsonl.raw/id/tool.txt"),
    "re-po/2026-07__x__h__ab.jsonl.raw/id/tool.txt");
  assert.equal(encodeS3Path("a+b&c"), "a%2Bb%26c");
});

test("canonicalQuery sorts by encoded key and encodes values", () => {
  assert.equal(canonicalQuery({ "list-type": "2", prefix: "a b" }), "list-type=2&prefix=a%20b");
  assert.equal(canonicalQuery({}), "");
});

test("parseListXml pulls keys, truncation flag and the continuation token", () => {
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>true</IsTruncated>
    <Contents><Key>a/b.jsonl</Key><Size>10</Size></Contents>
    <Contents><Key>a/b.jsonl.meta</Key><Size>5</Size></Contents>
    <NextContinuationToken>TOK&amp;2</NextContinuationToken>
  </ListBucketResult>`;
  const r = parseListXml(xml);
  assert.deepEqual(r.keys, ["a/b.jsonl", "a/b.jsonl.meta"]);
  assert.equal(r.truncated, true);
  assert.equal(r.nextToken, "TOK&2");
});

test("parseListXml reads an empty listing as not-truncated, no keys", () => {
  const r = parseListXml(`<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`);
  assert.deepEqual(r.keys, []);
  assert.equal(r.truncated, false);
  assert.equal(r.nextToken, null);
});

test("xmlDecode reverses the five entity forms", () => {
  assert.equal(xmlDecode("a&amp;b&lt;c&gt;d&quot;e&apos;f"), 'a&b<c>d"e\'f');
});

// ---- factory ----------------------------------------------------------------

test("createBlobStore is null with HA off and an S3BlobStore with HA + s3", () => {
  assert.equal(createBlobStore({ ha: false }), null);
  assert.equal(createBlobStore({ ha: true, s3: null }), null);
  assert.equal(createBlobStore({ ha: true, s3: { endpoint: "https://x", bucket: "b" } }), null); // missing keys
  const s = createBlobStore({
    ha: true,
    s3: { endpoint: "https://minio:9000", bucket: "arc", region: "eu", accessKey: "AK", secretKey: "SK" },
  });
  assert.ok(s instanceof S3BlobStore);
  assert.equal(s.bucket, "arc");
  assert.equal(s.hostHeader, "minio:9000");
});

// ---- the socket path over a local fake-S3 -----------------------------------

// A minimal in-memory S3 over plain http: enough of PUT/GET/HEAD/DELETE and
// ListObjectsV2 for the client's round-trip. Verifies each request carries a
// SigV4 Authorization header (the transport is signed), then behaves like S3.
function fakeS3() {
  const objects = new Map(); // "/bucket/key" -> Buffer
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || null);
    const u = new URL(req.url, "http://x");
    const isList = u.searchParams.get("list-type") === "2";
    if (req.method === "GET" && isList) {
      const prefix = u.searchParams.get("prefix") || "";
      const bucketPath = u.pathname; // "/bucket"
      const items = [...objects.keys()]
        .filter((k) => k.startsWith(bucketPath + "/"))
        .map((k) => k.slice(bucketPath.length + 1))
        .filter((k) => k.startsWith(prefix));
      const body =
        `<ListBucketResult><IsTruncated>false</IsTruncated>` +
        items.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("") +
        `</ListBucketResult>`;
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(body);
      return;
    }
    const key = u.pathname;
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200); res.end(); });
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const buf = objects.get(key);
      if (!buf) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-length": String(buf.length) });
      res.end(req.method === "HEAD" ? undefined : buf);
      return;
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(400); res.end();
  });
  return { server, objects, seenAuth };
}

test("S3BlobStore put/get/stat/list/del round-trip over the socket", async () => {
  const { server, seenAuth } = fakeS3();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const TMP = mkdtemp("turma-blob-");
  try {
    const store = new S3BlobStore({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "arc", region: "us-east-1", accessKey: "AK", secretKey: "SK",
    });

    // absent object
    assert.equal(await store.stat("re/x.jsonl"), null);
    assert.equal(await store.getToFile("re/x.jsonl", path.join(TMP, "miss")), false);

    // put from a file (streamed), then stat + get it back byte-for-byte
    const src = path.join(TMP, "src.jsonl");
    const payload = Buffer.from("hello\nworld\n".repeat(1000));
    fs.writeFileSync(src, payload);
    await store.put("re/x.jsonl", { file: src });
    assert.deepEqual(await store.stat("re/x.jsonl"), { size: payload.length });
    const dest = path.join(TMP, "got.jsonl");
    assert.equal(await store.getToFile("re/x.jsonl", dest), true);
    assert.deepEqual(fs.readFileSync(dest), payload);

    // put from a buffer + list under a prefix
    await store.put("re/x.jsonl.meta", { body: Buffer.from('{"transcriptId":"t"}') });
    const keys = (await store.list("re/")).sort();
    assert.deepEqual(keys, ["re/x.jsonl", "re/x.jsonl.meta"]);

    // delete, then it is gone (and re-delete is a no-op success)
    await store.del("re/x.jsonl");
    assert.equal(await store.stat("re/x.jsonl"), null);
    await store.del("re/x.jsonl");

    // every request the client made was SigV4-signed
    assert.ok(seenAuth.length > 0);
    assert.ok(seenAuth.every((a) => typeof a === "string" && a.startsWith("AWS4-HMAC-SHA256 ")));
  } finally {
    server.close();
  }
});
