// The `deploy-hub-image` job (XERK-425): point the GitOps manifest at the image
// this release just pushed. Reads/writes the file; the decision is in the pure
// argocd.js beside it. See release.yml and RELEASING.md.
//
// in:  MANIFEST (path), IMAGE (repository, no tag), VERSION, DIGEST
// out: rewrites MANIFEST in place; $GITHUB_OUTPUT gets `changed`, `ref`,
//      `previous`.
//
// `changed=false` is a normal outcome, not a failure: a re-run of the same
// release rewrites the same ref, and the job commits nothing.

"use strict";

const fs = require("node:fs");
const A = require("./argocd");
const G = require("./git");

function main() {
  const manifest = process.env.MANIFEST;
  const image = process.env.IMAGE;
  const version = process.env.VERSION;
  const digest = process.env.DIGEST;
  for (const [k, v] of Object.entries({ MANIFEST: manifest, IMAGE: image, VERSION: version, DIGEST: digest })) {
    if (!v) throw new Error(`${k} is required`);
  }

  const before = fs.readFileSync(manifest, "utf8");
  const res = A.bumpImage(before, { repository: image, version, digest });
  if (res.changed) fs.writeFileSync(manifest, res.text);

  console.log(`${manifest}:${res.line}`);
  console.log(`  was: ${res.previous}`);
  console.log(`  now: ${res.next}${res.changed ? "" : "  (unchanged)"}`);

  G.setOutputs({ changed: String(res.changed), ref: res.next, previous: res.previous });
}

// An ::error:: annotation as well as the stack: this job failing means the
// cluster is still on the previous image, and that should be readable from the
// run summary without opening the log.
try {
  main();
} catch (e) {
  console.log(`::error::hub image bump failed: ${e.message}`);
  throw e;
}
