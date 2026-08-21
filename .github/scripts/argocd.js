// Rewriting one `image:` line in a GitOps manifest, so a release deploys itself
// (XERK-425). The hub runs on k8x as `ai/turma` in xerktech/ArgoCD, whose Turma
// Application is `automated` + `selfHeal` — so a commit to that file IS the
// deploy, and this is the last step of the release rather than a convenience.
//
// Pure: takes the manifest text, returns the new text. Unit-tested in
// .github/scripts/tests/argocd.test.js; the fs/git side is argocd-cli.js.
//
// WHY A LINE REWRITE AND NOT A YAML LOAD. The manifest is ~200 lines of comments
// that carry the reasoning for every field in it, and no stdlib YAML round-trip
// keeps a comment. Re-emitting the file would delete the thing that makes it
// reviewable, on every release. So the edit is deliberately textual and refuses
// anything it is not certain about.

"use strict";

// A tag GHCR will accept: the release `version` (e.g. 1.0.31). Deliberately
// narrower than the OCI grammar — this is fed from `plan`'s output, so anything
// exotic means something upstream is wrong, not that a tag needs escaping.
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// `image: <ref>` and nothing else on the line, with the leading `- ` kept in the
// indent group so a container written as a compact list item round-trips. A
// trailing comment would end up inside the ref, so such a line is not matched
// rather than being silently mangled.
const IMAGE_LINE_RE = /^(\s*(?:-[ \t]+)?)image:[ \t]+(\S+)[ \t]*$/;

// Split an image ref into { repository, tag, digest }. The tag separator is the
// LAST colon after the last slash — a registry port (`host:5000/x`) has its
// colon before a slash and must not be read as a tag.
function parseRef(ref) {
  const at = ref.indexOf("@");
  const digest = at === -1 ? "" : ref.slice(at + 1);
  const name = at === -1 ? ref : ref.slice(0, at);
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  if (colon > slash) return { repository: name.slice(0, colon), tag: name.slice(colon + 1), digest };
  return { repository: name, tag: "", digest };
}

// `ghcr.io/x/turma:1.0.31@sha256:…`. Tag AND digest, matching how the sibling
// turma-agent StatefulSet is pinned in the same repo: the digest is what the
// pod actually runs (a tag is mutable), and the tag is what makes a human — or
// the next release's diff — able to read which build that is.
function imageRef(repository, version, digest) {
  return `${repository}:${version}@${digest}`;
}

// parts index -> 1-based line number (see the split below).
function lineNumber(index) {
  return index / 2 + 1;
}

// Rewrite the single `image:` line whose repository is `repository`.
//
// Throws when there is not exactly one. Both failure modes are the ones worth
// being loud about: zero means the manifest moved or was restructured and a
// silent no-op would leave the cluster on an old image forever, while two means
// the file gained a second container and guessing which one to bump is how a
// deploy pipeline ships the wrong thing.
//
// Returns { text, changed, line, previous, next }.
function bumpImage(text, opts) {
  const repository = opts.repository;
  const version = String(opts.version || "");
  const digest = String(opts.digest || "");
  if (!repository) throw new Error("bumpImage: repository is required");
  if (!TAG_RE.test(version)) throw new Error(`bumpImage: version ${JSON.stringify(version)} is not a usable image tag`);
  if (!DIGEST_RE.test(digest)) throw new Error(`bumpImage: digest ${JSON.stringify(digest)} is not a sha256 digest`);

  // Split KEEPING the separators, so every byte this function does not mean to
  // touch survives verbatim — including each line's own ending. Rebuilding the
  // file from bare lines and one guessed EOL would rewrite every line of a
  // mixed-ending file, and a whole-file diff hides the one line that changed.
  // Even indices are line content, odd ones are the separators between them.
  const parts = text.split(/(\r?\n)/);

  const hits = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = IMAGE_LINE_RE.exec(parts[i]);
    if (m && parseRef(m[2]).repository === repository) hits.push({ index: i, indent: m[1], ref: m[2] });
  }
  if (hits.length === 0) throw new Error(`no \`image: ${repository}…\` line found — the manifest changed shape`);
  if (hits.length > 1) {
    const at = hits.map((h) => lineNumber(h.index)).join(", ");
    throw new Error(`${hits.length} \`image: ${repository}…\` lines found (lines ${at}) — refusing to guess which one to bump`);
  }

  const hit = hits[0];
  const next = imageRef(repository, version, digest);
  parts[hit.index] = `${hit.indent}image: ${next}`;
  return {
    text: parts.join(""),
    changed: hit.ref !== next,
    line: lineNumber(hit.index),
    previous: hit.ref,
    next,
  };
}

module.exports = { parseRef, imageRef, bumpImage, TAG_RE, DIGEST_RE };
