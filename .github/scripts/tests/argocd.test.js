"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../argocd.js");

const IMAGE = "ghcr.io/xerktech/turma";
const DIGEST = "sha256:" + "a".repeat(64);
const OTHER = "sha256:" + "b".repeat(64);

// The shape of the real xerktech/ArgoCD ai/turma/deployment.yaml at the point
// this was written: a digest-only pin, buried in the comment block that explains
// it, with a sibling container ref (turma-agent) that must NOT be matched.
function manifest(ref) {
  return [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "        - name: turma",
    "          # PINNED BY DIGEST, not `:latest`.",
    `          image: ${ref}`,
    "          env:",
    "            - name: TZ",
    "              value: America/New_York",
    "",
  ].join("\n");
}

test("parseRef splits repository, tag and digest", () => {
  assert.deepEqual(A.parseRef("ghcr.io/x/turma"), { repository: "ghcr.io/x/turma", tag: "", digest: "" });
  assert.deepEqual(A.parseRef("ghcr.io/x/turma:1.0.31"), {
    repository: "ghcr.io/x/turma",
    tag: "1.0.31",
    digest: "",
  });
  assert.deepEqual(A.parseRef(`ghcr.io/x/turma@${DIGEST}`), {
    repository: "ghcr.io/x/turma",
    tag: "",
    digest: DIGEST,
  });
  assert.deepEqual(A.parseRef(`ghcr.io/x/turma:1.0.31@${DIGEST}`), {
    repository: "ghcr.io/x/turma",
    tag: "1.0.31",
    digest: DIGEST,
  });
});

// A registry port's colon sits before the last slash. Reading it as a tag would
// make the repository compare fail, i.e. "no image line found" on a manifest
// that has one.
test("parseRef does not read a registry port as a tag", () => {
  assert.deepEqual(A.parseRef("registry:5000/x/turma"), {
    repository: "registry:5000/x/turma",
    tag: "",
    digest: "",
  });
});

test("bumpImage rewrites a digest-only pin to tag+digest, keeping indentation", () => {
  const res = A.bumpImage(manifest(`${IMAGE}@${OTHER}`), {
    repository: IMAGE,
    version: "1.0.31",
    digest: DIGEST,
  });
  assert.equal(res.changed, true);
  assert.equal(res.next, `${IMAGE}:1.0.31@${DIGEST}`);
  assert.equal(res.previous, `${IMAGE}@${OTHER}`);
  assert.equal(res.text, manifest(`${IMAGE}:1.0.31@${DIGEST}`));
  assert.equal(res.line, 9);
});

test("bumpImage rewrites a tag+digest pin", () => {
  const res = A.bumpImage(manifest(`${IMAGE}:1.0.30@${OTHER}`), {
    repository: IMAGE,
    version: "1.0.31",
    digest: DIGEST,
  });
  assert.equal(res.changed, true);
  assert.equal(res.text, manifest(`${IMAGE}:1.0.31@${DIGEST}`));
});

// A re-run of the same release must be a no-op, not a stream of empty commits.
test("bumpImage reports changed=false when the ref already matches", () => {
  const text = manifest(`${IMAGE}:1.0.31@${DIGEST}`);
  const res = A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest: DIGEST });
  assert.equal(res.changed, false);
  assert.equal(res.text, text);
});

// The hub and the agent live in the same GitOps repo, and `turma` is a prefix of
// `turma-agent`. A substring match here would bump the agent's StatefulSet to a
// hub image.
test("bumpImage matches the repository exactly, never a prefix", () => {
  const text = manifest("ghcr.io/xerktech/turma-agent:1.0.30@" + OTHER);
  assert.throws(
    () => A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest: DIGEST }),
    /no `image: ghcr.io\/xerktech\/turma…` line found/,
  );
});

// Zero and two are both "the manifest is not what this job was written against".
// Silently doing nothing would leave the cluster on the old image forever;
// silently picking one would deploy the wrong container.
test("bumpImage refuses to guess when the manifest has two matching lines", () => {
  const text = manifest(`${IMAGE}@${OTHER}`) + `        - image: ${IMAGE}:sidecar\n`;
  assert.throws(
    () => A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest: DIGEST }),
    /refusing to guess/,
  );
});

test("bumpImage rejects a version or digest it cannot put in a ref", () => {
  const text = manifest(`${IMAGE}@${OTHER}`);
  for (const version of ["", "1.0.31 && rm -rf /", "-leading-dash", "a/b"]) {
    assert.throws(() => A.bumpImage(text, { repository: IMAGE, version, digest: DIGEST }), /not a usable image tag/);
  }
  for (const digest of ["", "sha256:abc", "a".repeat(64), `SHA256:${"a".repeat(64)}`]) {
    assert.throws(
      () => A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest }),
      /not a sha256 digest/,
    );
  }
});

// A trailing comment would be swallowed into the ref by a looser regex, so the
// line is not matched at all — which surfaces as the loud "manifest changed
// shape" error rather than as a mangled ref pushed to the cluster.
test("bumpImage does not match an image line carrying a trailing comment", () => {
  const text = manifest(`${IMAGE}@${OTHER} # the cutover image`);
  assert.throws(() => A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest: DIGEST }), /changed shape/);
});

// Every byte outside the rewritten line survives, mixed endings included: the
// diff a human reviews on the GitOps repo must be the one line, never the file.
test("bumpImage leaves a mixed-ending file alone apart from its own line", () => {
  const text = `a\r\nb\n          image: ${IMAGE}@${OTHER}\r\nc\nd`;
  const res = A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest: DIGEST });
  assert.equal(res.text, `a\r\nb\n          image: ${IMAGE}:1.0.31@${DIGEST}\r\nc\nd`);
  assert.equal(res.line, 3);
});

test("bumpImage preserves CRLF line endings", () => {
  const text = manifest(`${IMAGE}@${OTHER}`).replace(/\n/g, "\r\n");
  const res = A.bumpImage(text, { repository: IMAGE, version: "1.0.31", digest: DIGEST });
  assert.equal(res.text, manifest(`${IMAGE}:1.0.31@${DIGEST}`).replace(/\n/g, "\r\n"));
});
