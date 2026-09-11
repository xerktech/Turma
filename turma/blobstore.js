// The archive's BLOB STORE backend (XERK-759, epic XERK-751).
//
// The durable archive keeps two byte layers on disk under ARCHIVE_DIR — the
// rendered `.jsonl`+`.meta` sidecars and the byte-for-byte `.raw/` copy
// (turma-archive.md). Under HA the hub runs as N replicas and the RWO
// `turma-data` volume can no longer be the archive's of-record: a standby cannot
// mount it, so it cannot be promoted without a volume detach/attach that defeats
// fast failover (docs/turma-ha-design.md §Option 2). So the of-record for the
// BYTES moves to OBJECT STORAGE (MinIO/S3) — read/written identically by every
// replica with no volume move — exactly the split docs/turma-ha-store-adr.md
// records: bytes -> object storage, the searchable index stays a per-replica
// disposable SQLite rebuilt from the bytes (archive.js already treats it that
// way), so there is no shared SQLite file to corrupt and the ticket's "single
// owning writer" is satisfied by the leader being the only replica that ingests.
//
// This module is ONLY the object-store client + the factory. The mirror that
// pushes local writes up and the boot/promotion hydrate that pulls them back
// down are archive-mirror.js; archive.js is untouched on its synchronous hot
// path (an injected sink notes each written path — nothing here is on the beat).
//
// stdlib ONLY — the hub ships no node_modules (the XERK-754 stance). So this is a
// hand-rolled SigV4 signer over node:https/node:http, path-style addressing
// (`<endpoint>/<bucket>/<key>`, what MinIO and any S3-compatible endpoint speak),
// UNSIGNED-PAYLOAD so a large body streams from disk without being buffered to
// hash it. The SIGNER and the list-XML parse are the unit-testable core; the
// socket lifecycle is host-QA-only (no live MinIO in CI), exactly as
// SharedLiveStore's Valkey socket is.

"use strict";

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

// ---- SigV4 -----------------------------------------------------------------

// S3 canonical-URI encoding: percent-encode every byte EXCEPT the RFC-3986
// unreserved set and `/` (S3 does not encode the path separator). This is also
// what the object key must be encoded with when it goes into the request path.
function encodeS3Path(p) {
  let out = "";
  for (const ch of Buffer.from(p, "utf8")) {
    const c = String.fromCharCode(ch);
    if (
      (ch >= 0x41 && ch <= 0x5a) || // A-Z
      (ch >= 0x61 && ch <= 0x7a) || // a-z
      (ch >= 0x30 && ch <= 0x39) || // 0-9
      c === "-" || c === "_" || c === "." || c === "~" || c === "/"
    ) {
      out += c;
    } else {
      out += "%" + ch.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

// A query object -> the CANONICAL query string: keys and values URI-encoded
// (RFC-3986, and here `/` is encoded too — it is a value, not a path), sorted by
// encoded key. Empty when there is no query.
function canonicalQuery(query) {
  const parts = [];
  for (const k of Object.keys(query || {})) {
    const v = query[k];
    if (v == null) continue;
    parts.push([encodeRfc3986(k), encodeRfc3986(String(v))]);
  }
  parts.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return parts.map(([k, v]) => `${k}=${v}`).join("&");
}

function encodeRfc3986(s) {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// The two amz timestamps SigV4 needs, derived from ONE Date so the datestamp in
// the credential scope and the x-amz-date always agree.
function amzDates(now) {
  const iso = (now || new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  // iso is YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

// Sign one request. Returns the header set to send (the caller merges its own
// Content-Length/Content-Type on top). PURE — no I/O — so it is unit-tested with
// fixed inputs against a known-good signature.
//
// `payloadHash` defaults to UNSIGNED-PAYLOAD: the body is not hashed, so a
// multi-hundred-MiB raw file streams from disk instead of being read into memory
// to sign it. That is safe over TLS (the endpoint is https in HA) and is what
// every S3 SDK falls back to for a streaming body.
function signRequest(opts) {
  const {
    method, host, canonicalUri, query, headers,
    accessKey, secretKey, region, service, now,
    payloadHash,
  } = opts;
  const hash = payloadHash || "UNSIGNED-PAYLOAD";
  const { amzDate, dateStamp } = amzDates(now);

  // Header names lower-cased, values trimmed; host + the two x-amz-* are always
  // signed. Sorted by lower-cased name.
  const signed = {
    host,
    "x-amz-content-sha256": hash,
    "x-amz-date": amzDate,
    ...lowerKeys(headers || {}),
  };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(signed[n]).trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    hash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": hash,
    ...headers,
  };
}

function lowerKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

// ---- S3 list XML parse ------------------------------------------------------

// S3 / MinIO ListObjectsV2 returns predictable XML. Pull every <Key> and the
// truncation marker without an XML library (zero-npm). Keys are XML-escaped by
// the server, so decode the five entity forms. This is pure + unit-tested.
function parseListXml(xml) {
  const keys = [];
  const re = /<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const km = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
    if (km) keys.push(xmlDecode(km[1]));
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokM = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { keys, truncated, nextToken: tokM ? xmlDecode(tokM[1]) : null };
}

function xmlDecode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---- the S3 blob store ------------------------------------------------------

class S3BlobStore {
  /**
   * @param {{endpoint,bucket,region,accessKey,secretKey}} cfg — the resolved
   *   ARCHIVE_S3_* config (ha-config.js `s3`). `endpoint` is a full origin URL.
   */
  constructor(cfg, opts = {}) {
    const u = new URL(cfg.endpoint);
    this.protocol = u.protocol; // "https:" | "http:"
    this.hostname = u.hostname;
    this.port = u.port ? Number(u.port) : (u.protocol === "http:" ? 80 : 443);
    this.hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    this.bucket = cfg.bucket;
    this.region = cfg.region || "us-east-1";
    this.accessKey = cfg.accessKey;
    this.secretKey = cfg.secretKey;
    this.service = "s3";
    this.timeoutMs = opts.timeoutMs || 60 * 1000;
    this.kind = "s3";
  }

  // The canonical URI for one object key: /<bucket>/<encoded key>. Path-style.
  _uriFor(key) {
    return `/${encodeS3Path(this.bucket)}/${encodeS3Path(key)}`;
  }

  _agentLib() {
    return this.protocol === "http:" ? http : https;
  }

  // One request. `bodyFile` streams a file as the body; `bodyBuffer` sends bytes;
  // neither = empty body. `collect` buffers the response (list); `toFile` streams
  // it to disk (get). Resolves { status, headers, body? }.
  _request(method, key, { query, headers, bodyFile, bodyBuffer, collect, toFile } = {}) {
    return new Promise((resolve, reject) => {
      const canonicalUri = key == null ? `/${encodeS3Path(this.bucket)}` : this._uriFor(key);
      const extraHeaders = { ...(headers || {}) };
      let contentLength = 0;
      if (bodyBuffer) contentLength = bodyBuffer.length;
      else if (bodyFile) {
        try { contentLength = fs.statSync(bodyFile).size; }
        catch (e) { return reject(e); }
      }
      if (method === "PUT" || method === "DELETE") extraHeaders["content-length"] = String(contentLength);

      const signedHeaders = signRequest({
        method,
        host: this.hostHeader,
        canonicalUri,
        query: query || {},
        headers: extraHeaders,
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        region: this.region,
        service: this.service,
      });

      const path = canonicalUri + (query && Object.keys(query).length ? "?" + canonicalQuery(query) : "");
      const req = this._agentLib().request({
        method,
        hostname: this.hostname,
        port: this.port,
        path,
        headers: { ...signedHeaders, "content-length": String(contentLength), host: this.hostHeader },
      }, (res) => {
        const status = res.statusCode;
        if (toFile && status === 200) {
          const ws = fs.createWriteStream(toFile);
          res.pipe(ws);
          ws.on("finish", () => resolve({ status, headers: res.headers }));
          ws.on("error", reject);
          res.on("error", reject);
          return;
        }
        // Buffer the (small) body for list/errors; drain otherwise.
        const chunks = [];
        res.on("data", (c) => { if (collect || status >= 400) chunks.push(c); });
        res.on("end", () => resolve({
          status,
          headers: res.headers,
          body: chunks.length ? Buffer.concat(chunks).toString("utf8") : "",
        }));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error("s3 request timeout")));
      if (bodyBuffer) req.end(bodyBuffer);
      else if (bodyFile) {
        const rs = fs.createReadStream(bodyFile);
        rs.on("error", (e) => { req.destroy(e); reject(e); });
        rs.pipe(req);
      } else req.end();
    });
  }

  // PUT one object from a local file (streamed) or a buffer.
  async put(key, src) {
    const opts = src && src.file ? { bodyFile: src.file } : { bodyBuffer: src && src.body ? src.body : Buffer.alloc(0) };
    const r = await this._request("PUT", key, opts);
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`s3 put ${key} -> HTTP ${r.status}${r.body ? ": " + r.body.slice(0, 200) : ""}`);
    }
  }

  // GET one object straight to a local file. Returns true, or false on a 404.
  async getToFile(key, destPath) {
    const r = await this._request("GET", key, { toFile: destPath });
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    throw new Error(`s3 get ${key} -> HTTP ${r.status}`);
  }

  // HEAD one object. Returns { size } or null when absent.
  async stat(key) {
    const r = await this._request("HEAD", key, {});
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`s3 head ${key} -> HTTP ${r.status}`);
    const len = Number(r.headers["content-length"]);
    return { size: Number.isFinite(len) ? len : 0 };
  }

  // List every key under a prefix, paging past the 1000-key truncation.
  async list(prefix) {
    const keys = [];
    let token = null;
    do {
      const query = { "list-type": "2", prefix: prefix || "" };
      if (token) query["continuation-token"] = token;
      const r = await this._request("GET", null, { query, collect: true });
      if (r.status !== 200) throw new Error(`s3 list ${prefix} -> HTTP ${r.status}`);
      const parsed = parseListXml(r.body || "");
      for (const k of parsed.keys) keys.push(k);
      token = parsed.truncated ? parsed.nextToken : null;
    } while (token);
    return keys;
  }

  async del(key) {
    const r = await this._request("DELETE", key, {});
    // S3 answers 204 for a delete; 404 is a no-op success (already gone).
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
      throw new Error(`s3 del ${key} -> HTTP ${r.status}`);
    }
  }
}

// ---- the factory ------------------------------------------------------------

// Build the archive blob store for the resolved HA config, or null when HA is
// off (the single-process path keeps its local ARCHIVE_DIR tree, byte-identical —
// the mirror is never wired, so nothing is on the archive's hot path). ha-config
// has ALREADY validated the s3 block (all-or-nothing, fail-loud at boot), so a
// missing field never reaches here — but guard anyway rather than construct a
// half-configured client.
function createBlobStore(haConfig, opts = {}) {
  if (!haConfig || !haConfig.ha || !haConfig.s3) return null;
  const s3 = haConfig.s3;
  if (!s3.endpoint || !s3.bucket || !s3.accessKey || !s3.secretKey) return null;
  return new S3BlobStore(s3, opts);
}

module.exports = {
  createBlobStore,
  S3BlobStore,
  // Exported for the unit tests (the signer + parsers are the testable core).
  signRequest,
  canonicalQuery,
  encodeS3Path,
  parseListXml,
  xmlDecode,
};
