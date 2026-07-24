"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const CL = require("../changelog.js");

const entry = (o) => Object.assign({ title: "x", url: null, number: null, author: null, components: [] }, o);

test("buildEntries matches merge-commit and squash oids to PRs; orphans synthesize from subject", () => {
  const commits = [
    { oid: "m1", subject: "Merge pull request #201 from x/y" }, // merge-commit shape
    { oid: "s1", subject: "Squashed title (#202)" }, // squash shape (oid IS the mergeCommit)
    { oid: "d1", subject: "direct hotfix to main" }, // orphan: no PR
  ];
  const prs = [
    { number: 201, title: "Remove sibling refs", url: "http://x/201", author: "malc", mergeCommitOid: "m1" },
    { number: 202, title: "Add board chip", url: "http://x/202", author: "malc", mergeCommitOid: "s1" },
  ];
  const componentsByOid = { m1: [], s1: ["turma"], d1: ["agent-image", "agent-native"] };
  const entries = CL.buildEntries({ commits, prs, componentsByOid });
  assert.equal(entries[0].number, 201);
  assert.equal(entries[0].title, "Remove sibling refs");
  assert.equal(entries[1].number, 202);
  assert.deepEqual(entries[1].components, ["turma"]);
  // orphan: kept, synthesized from the commit subject, no PR metadata
  assert.equal(entries[2].number, null);
  assert.equal(entries[2].title, "direct hotfix to main");
  assert.deepEqual(entries[2].components, ["agent-image", "agent-native"]);
});

test("groupByComponent folds agent components into one Agent heading, [] into Other", () => {
  const groups = CL.groupByComponent([
    entry({ title: "hub thing", components: ["turma"] }),
    entry({ title: "agent thing", components: ["agent-image", "agent-native"] }),
    entry({ title: "chore", components: [] }),
  ]);
  assert.deepEqual(Object.keys(groups), ["Hub", "Agent", "Other"]);
  assert.equal(groups.Agent.length, 1); // not double-counted across the two agent components
});

test("a multi-component entry appears under each heading it touches", () => {
  const groups = CL.groupByComponent([entry({ title: "shared", components: ["turma", "glasses"] })]);
  assert.equal(groups.Hub.length, 1);
  assert.equal(groups.Glasses.length, 1);
});

test("an entry matching no component is never dropped (lands in Other)", () => {
  const groups = CL.groupByComponent([entry({ title: "root README tweak", components: [] })]);
  assert.deepEqual(Object.keys(groups), ["Other"]);
});

test("renderEntryLine formats PR and orphan entries", () => {
  assert.equal(
    CL.renderEntryLine(entry({ title: "Add flag", number: 42, url: "http://x/42", author: "malc" })),
    "- Add flag ([#42](http://x/42)) @malc",
  );
  assert.equal(CL.renderEntryLine(entry({ title: "direct push", number: null })), "- direct push");
});

test("sanitizeTitle collapses newlines/whitespace so a title can't break markdown", () => {
  assert.equal(CL.sanitizeTitle("first line\nsecond"), "first line");
  assert.equal(CL.sanitizeTitle("  a   b  "), "a b");
  const line = CL.renderEntryLine(entry({ title: "weird | title\nwith break", number: 1 }));
  assert.ok(!line.includes("\n"));
});

test("renderComponentTable reads rebuilt/carried status straight from the manifest", () => {
  const manifest = {
    components: {
      turma: { version: "0.3.1", kind: "image", ref: "ghcr.io/x/turma:0.3.1", built: true },
      "agent-image": { version: "0.3.0", kind: "image", ref: "ghcr.io/x/turma-agent:0.3.0", built: false },
      "agent-native": { version: "0.3.1", kind: "asset", asset: "n.tar.gz", built: true },
      glasses: { version: "0.3.0", kind: "evenhub", package_id: "com.xerktech.turma", built: false },
      android: { version: "0.3.1", kind: "asset", asset: "a.apk", version_code: 30001, built: true },
    },
  };
  const table = CL.renderComponentTable(manifest);
  assert.match(table, /Hub \(image\) \| 0\.3\.1 \| rebuilt/);
  assert.match(table, /Agent \(image\) \| 0\.3\.0 \| carried/);
  assert.match(table, /Glasses \(Even Hub\) \| 0\.3\.0 \| carried \| `com\.xerktech\.turma` \(Even Hub portal\)/);
  assert.match(table, /code 30001/);
});

test("renderReleaseNotes handles an empty range", () => {
  const notes = CL.renderReleaseNotes({ version: "0.3.1", groups: {}, manifest: { components: {} } });
  assert.match(notes, /## Turma v0\.3\.1/);
  assert.match(notes, /_No component changes in range\._/);
});

test("insertSection prepends under the marker and is idempotent for the same version", () => {
  const base = `# Changelog\n\n${CL.CHANGELOG_MARKER}\n`;
  const secA = CL.renderChangelogSection({ version: "0.3.0", date: "2026-07-16", groups: { Hub: [entry({ title: "a", components: ["turma"] })] } });
  const once = CL.insertSection(base, secA);
  assert.match(once, /## 0\.3\.0 — 2026-07-16/);

  const secB = CL.renderChangelogSection({ version: "0.4.0", date: "2026-08-01", groups: { Agent: [entry({ title: "b", components: ["agent-image"] })] } });
  const two = CL.insertSection(once, secB);
  // newest first: 0.4.0 above 0.3.0
  assert.ok(two.indexOf("## 0.4.0") < two.indexOf("## 0.3.0"));

  // re-inserting 0.4.0 must not duplicate it
  const three = CL.insertSection(two, secB);
  const count = (three.match(/## 0\.4\.0 —/g) || []).length;
  assert.equal(count, 1);
});
