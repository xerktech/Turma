// XERK-1563 — the permission ledger: ingest bounds (sanitizePermissionEvent), the
// rolling aggregates, the deterministic suggestedRule table, org scoping by host
// set, the non-HA file backend, and the HA Postgres append table.
//
// There is no live Postgres in CI (the pgclient.test.js / usage-ledger-store.test.js
// constraint), so the HA backend is driven against an in-memory FAKE PgPool that
// recognises exactly the statements the store emits — the real store's logic runs
// end to end; only the wire is host-QA-only.

"use strict";

const path = require("path");
const fs = require("fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp } = require("./tmpdirs");

const dir = mkdtemp("turma-test-permledger-");
process.env.PERMISSION_LEDGER_FILE = path.join(dir, "permission-ledger.json");
process.env.PERMISSION_LEDGER_MAX_ROWS = "40";
process.env.PERMISSION_LEDGER_HOST_MAX_ROWS = "30";
process.env.PERMISSION_LEDGER_FILE_MAX = "400000";
process.env.PERMISSION_LEDGER_SAVE_CHUNK = "2048";   // every save spans many chunks

const ledger = require("../permission-ledger.js");
const { sanitizePermissionEvent: sanitize, suggestedRule, aggregate } = ledger;

const NOW = Date.parse("2026-10-03T12:00:00Z");
const MIN = 60000;
const DAY = 86400000;

function row(id, extra = {}) {
  return { id, kind: "dialog", dialogKind: "permission", tool: "Bash", head: "npm test",
    openedAt: NOW - MIN, closedAt: NOW, waitedMs: MIN, answer: "allow", via: "terminal",
    ...extra };
}

test.beforeEach(() => ledger._internals.reset());

// ---- ingest bounds ----------------------------------------------------------

test("sanitize: whitelists, caps and enums every field", () => {
  const got = sanitize({
    ...row("d-1"), sessionId: "s1", extra: "dropped", prompt: "x".repeat(5000),
    tool: "T".repeat(999), head: "h\nforged line", options: ["Yes", 7, "No", ..."abcdefghij"],
    rulesMatched: ["Bash(npm test:*)"], answerNumber: 2,
  }, NOW);
  assert.equal(got.extra, undefined);
  assert.equal(got.prompt.length, 300);
  assert.equal(got.tool.length, 128);
  assert.equal(got.head, "h forged line");              // a control char can't forge a line
  assert.deepEqual(got.options.slice(0, 2), ["Yes", "No"]);
  assert.equal(got.options.length, 9);
  assert.equal(got.answerNumber, 2);
  assert.equal(got.sessionId, "s1");
});

test("sanitize: a wrong-typed field reads as can't-tell, never a plausible value", () => {
  const got = sanitize({ ...row("d-1"), answer: "yes", via: "phone", dialogKind: "weird",
    waitedMs: -5, closedAt: NOW - DAY, answerNumber: 12, sessionId: "../x" }, NOW);
  assert.equal(got.answer, undefined);
  assert.equal(got.via, undefined);
  assert.equal(got.dialogKind, "other");
  assert.equal(got.waitedMs, undefined);
  assert.equal(got.closedAt, undefined);      // before openedAt
  assert.equal(got.answerNumber, undefined);
  assert.equal(got.sessionId, undefined);
});

test("sanitize: refuses what cannot be a row", () => {
  for (const bad of [null, [], "x", { id: "a" }, { ...row("d-1"), kind: "other" },
    { ...row("bad id!") }, { ...row("d-1"), openedAt: "1" },
    { ...row("d-1"), openedAt: Infinity }, { ...row("d-1"), openedAt: NOW + 2 * DAY },
    { ...row("d-1"), openedAt: 0 }]) {
    assert.equal(sanitize(bad, NOW), null, JSON.stringify(bad));
  }
  // dialogKind exists only on a dialog row.
  assert.equal(sanitize({ ...row("c-1"), kind: "classifier-denied" }, NOW).dialogKind, undefined);
});

test("ingest: a row id seen again REPLACES the stored row (open, then closed)", () => {
  ledger.ingest("h1", [{ id: "d-1", kind: "dialog", openedAt: NOW - MIN }], NOW);
  ledger.ingest("h1", [row("d-1")], NOW);
  const m = ledger._internals.hosts().get("h1");
  assert.equal(m.size, 1);
  assert.equal(m.get("d-1").answer, "allow");
});

test("ingest: a newer dialog row for a session closes that session's row left open", () => {
  // The agent restarted with a prompt up: its old row was never closed, and the
  // same prompt is filed again under a new id.
  const open = { closedAt: undefined, waitedMs: undefined, answer: undefined, via: undefined,
    sessionId: "s1" };
  ledger.ingest("h1", [row("d-s1-1", { ...open, openedAt: NOW - 10 * MIN }),
    row("d-s2-1", { ...open, sessionId: "s2", openedAt: NOW - 10 * MIN }),
    // answered between beats: never closed, but not open either — left alone
    row("d-s1-0", { ...open, answer: "allow", openedAt: NOW - 20 * MIN })], NOW);
  ledger.ingest("h2", [row("d-s1-x", { ...open, openedAt: NOW - 10 * MIN })], NOW);
  const changed = [];
  const orig = ledger._internals.getBackend();
  ledger._internals.setBackend({ onChange: (host, rows) => changed.push([host, rows.map((r) => r.id)]) });
  try {
    ledger.ingest("h1", [row("d-s1-2", { ...open, openedAt: NOW - MIN })], NOW);
  } finally { ledger._internals.setBackend(orig); }
  const m = ledger._internals.hosts().get("h1");
  const old = m.get("d-s1-1");
  assert.equal(old.closedAt, NOW - MIN);
  assert.deepEqual([old.answer, old.via, old.waitedMs], ["unknown", "unknown", undefined]);
  assert.equal(m.get("d-s1-2").closedAt, undefined, "the new row stays open");
  assert.equal(m.get("d-s2-1").closedAt, undefined, "another session's row is untouched");
  assert.equal(m.get("d-s1-0").closedAt, undefined);
  assert.equal(ledger._internals.hosts().get("h2").get("d-s1-x").closedAt, undefined,
    "another host's session is untouched");
  assert.deepEqual(changed, [["h1", ["d-s1-2", "d-s1-1"]]], "the closed copy is persisted too");
  const g = aggregate({ now: NOW }).top.find((t) => t.head === "npm test");
  assert.equal(g.open, 3);         // d-s1-2, d-s2-1, d-s1-x — no longer the lost d-s1-1
  // A real closed copy arriving later still replaces the synthetic close.
  ledger.ingest("h1", [row("d-s1-1", { sessionId: "s1", openedAt: NOW - 10 * MIN })], NOW);
  assert.equal(m.get("d-s1-1").answer, "allow");
});

test("ingest: any newer row for a session closes that session's ask left open", () => {
  const ask = (id, at, extra = {}) => ({ id, kind: "ask-in-chat", sessionId: "s1",
    prompt: "May I push?", openedAt: at, ...extra });
  ledger.ingest("h1", [ask("a-1", NOW - 10 * MIN), ask("a-2", NOW - 10 * MIN, { sessionId: "s2" })],
    NOW);
  // A classifier block (a complete row) for the same session moves it past the ask.
  ledger.ingest("h1", [row("c-1", { kind: "classifier-denied", dialogKind: undefined,
    sessionId: "s1", openedAt: NOW - 2 * MIN, closedAt: undefined, waitedMs: undefined,
    answer: "deny", via: undefined })], NOW);
  const m = ledger._internals.hosts().get("h1");
  assert.deepEqual([m.get("a-1").closedAt, m.get("a-1").answer, m.get("a-1").via],
    [NOW - 2 * MIN, "unknown", "unknown"]);
  assert.equal(m.get("a-1").waitedMs, undefined);
  assert.equal(m.get("a-2").closedAt, undefined, "another session's ask is untouched");
  // A newer ASK closes an older one too; a row OLDER than the ask closes nothing.
  ledger.ingest("h1", [ask("a-3", NOW - MIN, { sessionId: "s2" }),
    row("d-old", { sessionId: "s2", openedAt: NOW - 20 * MIN })], NOW);
  assert.equal(m.get("a-2").closedAt, NOW - MIN);
  assert.equal(m.get("a-3").closedAt, undefined, "the newest ask stays open");
  // A dialog row is still closed only by a newer DIALOG row, never by an ask.
  ledger.ingest("h1", [row("d-open", { sessionId: "s3", openedAt: NOW - 9 * MIN,
    closedAt: undefined, waitedMs: undefined, answer: undefined, via: undefined }),
  ask("a-s3", NOW - MIN, { sessionId: "s3" })], NOW);
  assert.equal(m.get("d-open").closedAt, undefined);
  // The agent's real close still replaces the hub's.
  ledger.ingest("h1", [ask("a-1", NOW - 10 * MIN, { closedAt: NOW - 3 * MIN, waitedMs: 7 * MIN,
    answer: "unknown", via: "turma" })], NOW);
  assert.deepEqual([m.get("a-1").via, m.get("a-1").waitedMs], ["turma", 7 * MIN]);
});

test("ingest: a row open past OPEN_MAX_MS is closed as unknown, on every host", () => {
  const open = { closedAt: undefined, waitedMs: undefined, answer: undefined, via: undefined };
  const old = NOW - ledger.OPEN_MAX_MS - MIN;
  ledger.ingest("h2", [row("stale", { ...open, sessionId: "gone", openedAt: old }),
    row("young", { ...open, sessionId: "live", openedAt: NOW - ledger.OPEN_MAX_MS + MIN }),
    { id: "ask-stale", kind: "ask-in-chat", sessionId: "gone2", prompt: "ok?", openedAt: old }],
  NOW - 2 * MIN);
  const changed = [];
  const orig = ledger._internals.getBackend();
  ledger._internals.setBackend({ onChange: (host, rows) => changed.push([host, rows.map((r) => r.id)]) });
  try {
    // A beat from ANOTHER host is when the hub notices.
    ledger.ingest("h1", [row("x1")], NOW);
  } finally { ledger._internals.setBackend(orig); }
  const m = ledger._internals.hosts().get("h2");
  assert.deepEqual([m.get("stale").closedAt, m.get("stale").answer, m.get("stale").via],
    [NOW, "unknown", "unknown"]);
  assert.equal(m.get("stale").waitedMs, undefined);
  assert.equal(m.get("ask-stale").closedAt, NOW);
  assert.equal(m.get("young").closedAt, undefined, "under the limit stays open");
  // Each host's closes are persisted under that host.
  assert.deepEqual(changed, [["h1", ["x1"]], ["h2", ["stale", "ask-stale"]]]);
  assert.equal(aggregate({ now: NOW }).top.find((g) => g.head === "npm test").open, 1);
});

test("load: a restored row open past OPEN_MAX_MS is closed as unknown", async () => {
  ledger.ingest("h1", [row("lost", { closedAt: undefined, waitedMs: undefined, answer: undefined,
    via: undefined, openedAt: Date.now() - ledger.OPEN_MAX_MS - MIN })], Date.now() - 2 * MIN);
  await new Promise((resolve) => ledger.flush(resolve));
  ledger._internals.load();
  const got = ledger._internals.hosts().get("h1").get("lost");
  assert.equal(got.answer, "unknown");
  assert.equal(typeof got.closedAt, "number");
});

test("ingest: at most EVENTS_PER_BEAT rows a beat; junk hosts refused", () => {
  const many = Array.from({ length: ledger.EVENTS_PER_BEAT + 50 }, (_, i) =>
    row(`x${i}`, { openedAt: NOW - i }));
  // The per-host cap (30 here) still bounds what is kept — the beat cap bounds work.
  assert.equal(ledger.ingest("h1", many, NOW), ledger.EVENTS_PER_BEAT);
  assert.equal(ledger.ingest("__proto__", [row("a")], NOW), 0);
  assert.equal(ledger.ingest("h1", "nope", NOW), 0);
});

test("eviction: retention, the per-host share, then the store cap — oldest first", () => {
  ledger.ingest("old", [row("ancient", { openedAt: NOW - (ledger.DAYS + 1) * DAY })], NOW - (ledger.DAYS + 1) * DAY);
  ledger.ingest("h1", Array.from({ length: 35 }, (_, i) => row(`a${i}`, { openedAt: NOW - 1000 + i })), NOW);
  assert.equal(ledger._internals.hosts().get("h1").size, ledger.HOST_MAX_ROWS);
  assert.equal(ledger._internals.hosts().has("old"), false);       // aged out
  assert.equal(ledger._internals.hosts().get("h1").has("a0"), false); // oldest went
  ledger.ingest("h2", Array.from({ length: 20 }, (_, i) => row(`b${i}`, { openedAt: NOW - 500 + i })), NOW);
  assert.equal(ledger._internals.rowCount(), ledger.MAX_ROWS);
  // The store-wide eviction took h1's oldest, not h2's fresh rows.
  assert.equal(ledger._internals.hosts().get("h2").size, 20);
});

// ---- aggregates + suggestedRule ---------------------------------------------

test("aggregate: groups by (kind, tool, head) with counts, answers, median wait", () => {
  ledger.ingest("h1", [
    row("1", { waitedMs: 1000 }), row("2", { waitedMs: 3000, answer: "deny" }),
    row("3", { waitedMs: 9000 }),
    row("4", { kind: "classifier-denied", dialogKind: undefined, head: "git push",
      denyReason: "push is outside scope", answer: "deny", waitedMs: undefined }),
    row("5", { openedAt: NOW - 9 * DAY }),                      // outside 7 days
  ], NOW);
  const { top, recent } = aggregate({ now: NOW });
  const npm = top.find((g) => g.head === "npm test" && g.kind === "dialog");
  assert.deepEqual([npm.count, npm.allowed, npm.denied, npm.medianWaitMs], [3, 2, 1, 3000]);
  // Off the safe-head list: no rule, and the reason the card shows instead.
  assert.equal(npm.suggestedRule, null);
  assert.match(npm.noRuleReason, /not on the known read-only list/);
  assert.equal(top[0], npm);                                  // most frequent first
  assert.equal(recent.length, 4);
  assert.equal(recent[0].host, "h1");
  assert.equal(aggregate({ now: NOW, days: 30 }).recent.length, 5);
});

test("aggregate: scoped by host set — another org's host never counts", () => {
  ledger.ingest("acme-1", [row("1")], NOW);
  ledger.ingest("rival-1", [row("2"), row("3")], NOW);
  assert.equal(aggregate({ now: NOW, hosts: new Set(["acme-1"]) }).top[0].count, 1);
  assert.equal(aggregate({ now: NOW, hosts: new Set() }).top.length, 0);
  assert.equal(aggregate({ now: NOW }).top[0].count, 3);
});

test("suggestedRule: the deterministic table", () => {
  const cases = [
    [{ kind: "dialog", dialogKind: "permission", tool: "Bash", head: "git status" },
      "Bash(git status:*)"],
    [{ kind: "dialog", dialogKind: "permission", tool: "Bash", head: "npm test" }, null],
    [{ kind: "dialog", tool: "mcp__github__create_issue", head: "mcp__github__create_issue" },
      "mcp__github__create_issue"],
    [{ kind: "dialog", tool: "WebFetch", head: "docs.example.com" }, "WebFetch(domain:docs.example.com)"],
    [{ kind: "dialog", dialogKind: "sandbox", tool: "Bash", head: "registry.npmjs.org" },
      "sandbox.network.allowedDomains: registry.npmjs.org"],
    [{ kind: "classifier-denied", tool: "Bash", head: "git rev-parse" },
      "autoMode.environment: allow Bash(git rev-parse:*)"],
    [{ kind: "classifier-denied", tool: "Bash", head: "git push" }, null],
    // No tool rule → NO rule: a sentence lifted from the deny reason pastes nowhere.
    [{ kind: "classifier-denied", tool: "Edit", head: "/x", denyReason: "Writing outside the repo. Refused" },
      null],
    [{ kind: "classifier-denied", tool: "Write", head: "/home/u/.ssh/config",
      denyReason: "Writing to SSH configuration is outside the task" }, null],
    [{ kind: "classifier-denied", denyReason: "Something" }, null],
    [{ kind: "ask-in-chat" }, "model behaviour: see CLAUDE.md step 0"],
    [{ kind: "dialog", dialogKind: "plan", tool: "ExitPlanMode", head: "ExitPlanMode" }, null],
    [{ kind: "dialog", tool: "Edit", head: "/repo/a.py" }, null],
    [{ kind: "dialog", tool: "WebFetch", head: "not a host" }, null],
    // A Bash rule never retires a sandbox NETWORK prompt: no readable host, no rule.
    [{ kind: "dialog", dialogKind: "sandbox", tool: "Bash", head: "ls" }, null],
    // XERK-1566: a judged row is the judge's verdict on a prompt whose own
    // dialog/classifier row already carries the rule — none here, a STOOD one
    // above all (a Copy-able allow for a never-listed command would mislead).
    [{ kind: "judged", tool: "Bash", head: "npm run" }, null],
    [{ kind: "judged", tool: "Bash", head: "git push", verdict: "stand" }, null],
  ];
  for (const [g, want] of cases) assert.equal(suggestedRule(g), want, JSON.stringify(g));
  assert.match(ledger.ruleVerdict({ kind: "dialog", dialogKind: "sandbox", tool: "Bash", head: "ls" })
    .reason, /no host/);
});

// `tool` is agent-supplied, so an MCP rule is only ever a FULL server+tool name.
test("suggestedRule: an MCP rule needs a full mcp__<server>__<tool> name", () => {
  const bad = ["mcp__github", "mcp__github__", "mcp__github__*", "mcp__x\", \"Bash",
    "mcp____tool", "mcp__srv__to ol", "mcp__srv__tool\n"];
  for (const tool of bad) {
    for (const kind of ["dialog", "classifier-denied"]) {
      const g = { kind, dialogKind: kind === "dialog" ? "permission" : undefined, tool, head: tool };
      const v = ledger.ruleVerdict(g);
      assert.equal(v.rule, null, `${kind} ${JSON.stringify(tool)}`);
      assert.equal(v.reason, "not a full MCP tool name", `${kind} ${JSON.stringify(tool)}`);
    }
  }
  assert.equal(suggestedRule({ kind: "classifier-denied", tool: "mcp__srv__do-it", head: "x" }),
    "autoMode.environment: allow mcp__srv__do-it");
  // Through ingest + aggregate too: what the card and XERK-1566's judge read.
  ledger._internals.reset();
  ledger.ingest("h1", [
    row("m1", { tool: "mcp__github", head: "mcp__github" }),
    row("m2", { tool: "mcp__github__*", head: "mcp__github__*" }),
    row("m3", { kind: "classifier-denied", dialogKind: undefined, tool: "mcp__srv",
      head: "mcp__srv", answer: "deny" }),
    row("m4", { tool: "mcp__github__get_me", head: "mcp__github__get_me" }),
  ], NOW);
  const { top } = aggregate({ now: NOW });
  const by = (t) => top.find((g) => g.tool === t);
  for (const t of ["mcp__github", "mcp__github__*", "mcp__srv"]) {
    assert.equal(by(t).suggestedRule, null, t);
    assert.equal(by(t).noRuleReason, "not a full MCP tool name", t);
  }
  assert.equal(by("mcp__github__get_me").suggestedRule, "mcp__github__get_me");
});

// A Bash rule is offered ONLY for a head on the positive allowlist; every other
// head gets none, with a reason. Each check runs as a dialog and as a classifier
// block (whose rule is the same tool rule inside an autoMode line).
function assertNoBashRule(head) {
  for (const kind of ["dialog", "classifier-denied"]) {
    const v = ledger.ruleVerdict({ kind, tool: "Bash", head });
    assert.equal(v.rule, null, `${kind} ${head}`);
    assert.equal(typeof v.reason, "string", `${kind} ${head}`);
    assert.ok(v.reason.length > 0, `${kind} ${head}`);
    assert.equal(suggestedRule({ kind, tool: "Bash", head }), null, `${kind} ${head}`);
  }
}

test("suggestedRule: an exec head under any name gets no Bash rule, and says why", () => {
  // Sudo-equivalents, container execs, interpreters, shells and wrappers an open
  // deny list missed — the allowlist never offers them, listed or not.
  for (const head of ["pkexec", "podman exec", "nerdctl exec", "bundle exec",
    "py", "pythonw", "R", "swift", "scala", "groovy", "erl", "ghci", "jshell", "racket",
    "guile", "sbcl", "ash", "mksh", "yash", "xonsh", "nu", "elvish",
    "gtimeout", "fakeroot", "proot", "bwrap", "firejail", "torsocks", "proxychains", "chpst",
    "sg", "valgrind", "perf", "caffeinate", "toybox", "sed",
    // …and the earlier rounds' list: interpreters, shells, wrappers, keywords,
    // runner verbs, versioned and .exe binaries.
    "python3", "bash", "sh", "sudo", "env", "xargs", "timeout", "for", "eval",
    "/usr/bin/python3", "npx tsx", "uv run", "docker run", "npm exec", "docker container",
    "docker compose", "npm x", "bun x", "bun run", "yarn exec", "go run", "cargo run",
    "dotnet run", "kubectl run", "kubectl debug", "stdbuf", "nsenter", "busybox", "poetry",
    "conda", "java", "Rscript", "cmd.exe", "wsl", "nodejs", "pypy3", "gawk", "pnpx",
    "uv tool", "yarn node", "dotnet exec", "python3.11", "/usr/bin/python3.11", "php8.2",
    "perl5.36", "node22", "python.exe", "node.exe", "bash5", "awk", "find", "ssh"]) {
    assertNoBashRule(head);
  }
  assert.match(ledger.ruleVerdict({ kind: "dialog", tool: "Bash", head: "pkexec" }).reason,
    /runs whatever follows it/);
});

test("suggestedRule: a head off the allowlist gets no rule — unknown, runner or exec-flag tool", () => {
  // Unknown CLIs, and known ones whose ARGUMENTS can run code (an exec flag, a
  // config that names a command, a script runner).
  for (const head of ["frobnicate", "mytool", "s3cmd", "terraform apply", "npm test",
    "npm run", "yarn test", "pnpm test", "bun test", "go test", "cargo test", "pytest",
    "./gradlew test", "make all", "uv sync", "git push", "git fetch", "git pull",
    "git diff", "git log", "git rebase", "git grep", "kubectl get", "rg", "fd", "sort",
    "tee", "less", "tsc", "eslint", "curl", "wget", "rm", "cp", "mv", "chmod"]) {
    assertNoBashRule(head);
    assert.match(ledger.ruleVerdict({ kind: "dialog", tool: "Bash", head }).reason,
      /not on the known read-only list|runs whatever follows it|a path runs/, head);
  }
  // A path runs whatever binary sits there — even one named like a safe head.
  for (const head of ["/usr/bin/ls", "./ls", "/tmp/x/cat"]) assertNoBashRule(head);
  // A head outside a plain command shape would be a malformed rule.
  for (const head of ["(cd", "rm*", "a)b", "$(foo)", "x;y", "make all extra", ""]) {
    assertNoBashRule(head);
  }
  // A BARE subcommand CLI — what permlog's head is when a global flag precedes
  // the subcommand (`git -C /repo push`, `kubectl -n prod exec`) — says nothing
  // about what ran.
  for (const head of ["git", "gh", "docker", "kubectl", "npm", "make", "/usr/bin/git",
    "./gradlew"]) {
    assertNoBashRule(head);
  }
});

test("suggestedRule: a subcommand group whose verbs write, merge or run hooks gets no rule", () => {
  // The head is two words, so its rule covers EVERY verb under it: `gh pr merge
  // --admin` (past branch protection), `gh pr checkout -R` (another repo's hooks),
  // `gh run download -D` (any directory), `git commit`/`switch` (editable hooks).
  const reason = "not on the known read-only list, so its arguments may run code";
  for (const head of ["gh pr", "glab mr", "gh run", "gh issue", "glab issue", "git commit",
    "git switch", "git add", "git branch", "make build", "make test", "make install"]) {
    assertNoBashRule(head);
    assert.equal(ledger.ruleVerdict({ kind: "dialog", tool: "Bash", head }).reason, reason, head);
    assert.equal(ledger.BASH_SAFE_SUBCOMMANDS.has(head), false, head);
  }
});

test("suggestedRule: each no-rule Bash branch serves its own reason", () => {
  const reasonOf = (head) => ledger.ruleVerdict({ kind: "dialog", tool: "Bash", head }).reason;
  // The never-list, matched on the whole head, its first word, a path's base
  // name and a versioned binary's family.
  for (const head of ["docker run", "npx tsx", "/usr/bin/python3", "python3.11", "pkexec"]) {
    assert.equal(reasonOf(head), "runs whatever follows it", head);
  }
  for (const head of ["/usr/bin/ls", "./ls", "/tmp/x/cat", "bin/tool"]) {
    assert.equal(reasonOf(head), "a path runs whatever binary sits there", head);
  }
  for (const cli of ["git", "gh", "docker", "make", "npm"]) {
    assert.equal(reasonOf(cli), `no subcommand recorded, and a bare ${cli} rule allows every one`, cli);
  }
  for (const head of ["(cd", "rm*", "x;y", ""]) {
    assert.equal(reasonOf(head), "not a plain command name", JSON.stringify(head));
  }
});

test("suggestedRule: every allowlisted head keeps its rule, and no allowlisted head is an exec", () => {
  const safe = [...ledger.BASH_SAFE_HEADS, ...ledger.BASH_SAFE_SUBCOMMANDS];
  assert.ok(safe.length > 20);
  for (const head of safe) {
    assert.equal(suggestedRule({ kind: "dialog", tool: "Bash", head }), `Bash(${head}:*)`, head);
    assert.equal(suggestedRule({ kind: "classifier-denied", tool: "Bash", head }),
      `autoMode.environment: allow Bash(${head}:*)`, head);
    assert.equal(ledger.ruleVerdict({ kind: "dialog", tool: "Bash", head }).reason, undefined);
  }
  // Single words are single words; two-word heads are subcommands of a CLI
  // permlog splits that way (or permlog would never produce them).
  for (const h of ledger.BASH_SAFE_HEADS) assert.ok(!h.includes(" ") && !h.includes("/"), h);
  for (const h of ledger.BASH_SAFE_SUBCOMMANDS) {
    assert.ok(ledger.SUBCOMMAND_CLIS.has(h.split(" ")[0]), h);
  }
});

test("aggregate: a no-rule Bash group serves its reason; other no-rule groups serve none", () => {
  ledger.ingest("h1", [
    row("n1", { head: "pkexec" }),
    row("n2", { head: "git status" }),
    row("n3", { tool: "Edit", head: "/repo/a.py" }),
  ], NOW);
  const { top } = aggregate({ now: NOW });
  const by = (h) => top.find((g) => g.head === h);
  assert.equal(by("pkexec").suggestedRule, null);
  assert.match(by("pkexec").noRuleReason, /^runs whatever follows it$/);
  assert.equal(by("git status").suggestedRule, "Bash(git status:*)");
  assert.equal("noRuleReason" in by("git status"), false);
  assert.equal(by("/repo/a.py").suggestedRule, null);
  assert.equal("noRuleReason" in by("/repo/a.py"), false);
});

test("suggestedRule: the subcommand-CLI set mirrors permlog.py's SUBCOMMAND_CLIS", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "agent", "hooks", "permlog.py"),
    "utf8");
  const m = /SUBCOMMAND_CLIS = frozenset\(\{([^}]*)\}\)/.exec(src);
  assert.ok(m, "permlog.py declares SUBCOMMAND_CLIS");
  const py = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  assert.deepEqual([...ledger.SUBCOMMAND_CLIS].sort(), py);
});

test("aggregate: ask-in-chat groups by its question, with no allowed/denied to claim", () => {
  const ask = (id, prompt, extra = {}) => ({ id, kind: "ask-in-chat", sessionId: "s1", prompt,
    openedAt: NOW - MIN, closedAt: NOW, waitedMs: MIN, answer: "unknown", via: "turma", ...extra });
  ledger.ingest("h1", [
    ask("a1", "Shall I push PR #12 to origin?"),
    ask("a2", "shall I push   PR #13 to origin", { openedAt: NOW - 30000 }),   // same ask, folded
    ask("a3", "Should I rebuild the Dockerfile?"),
    ask("a4", undefined),                                                       // no question text
  ], NOW);
  const asks = aggregate({ now: NOW }).top.filter((g) => g.kind === "ask-in-chat");
  assert.equal(asks.length, 3, "distinct questions are distinct groups");
  const push = asks.find((g) => g.count === 2);
  assert.equal(push.prompt, "shall I push   PR #13 to origin");            // the newest wording
  assert.deepEqual([push.allowed, push.denied], [null, null]);
  assert.equal(push.suggestedRule, "model behaviour: see CLAUDE.md step 0");
  assert.ok(asks.some((g) => g.prompt === "Should I rebuild the Dockerfile?"));
  assert.ok(asks.some((g) => g.prompt === null && g.count === 1));
  // The key is bounded: two asks that differ only past the cap share a group.
  ledger._internals.reset();
  const long = "may I ".repeat(40);
  ledger.ingest("h1", [ask("b1", long + "alpha"), ask("b2", long + "beta")], NOW);
  assert.equal(aggregate({ now: NOW }).top.length, 1);
});

test("aggregate: counts rows still waiting, and an ask's recent row claims no answer", () => {
  const open = { closedAt: undefined, waitedMs: undefined, answer: undefined, via: undefined };
  ledger.ingest("h1", [
    row("o1", { ...open, head: "terraform apply" }),
    row("o2", { head: "npm test" }),
    row("o3", { ...open, head: "npm test", openedAt: NOW - 1000 }),
    // a request answered between beats: never closed, but not open either
    row("o4", { ...open, answer: "unknown", head: "make" }),
    { id: "o5", kind: "ask-in-chat", sessionId: "s1", prompt: "May I push?", openedAt: NOW - MIN,
      closedAt: NOW, waitedMs: MIN, answer: "unknown", via: "turma" },
  ], NOW);
  const { top, recent } = aggregate({ now: NOW });
  const by = (h) => top.find((g) => g.head === h);
  assert.deepEqual([by("terraform apply").count, by("terraform apply").open], [1, 1]);
  assert.deepEqual([by("npm test").count, by("npm test").open], [2, 1]);
  assert.equal(by("make").open, 0);
  assert.equal(top.find((g) => g.kind === "ask-in-chat").open, 0);
  const ask = recent.find((r) => r.id === "o5");
  assert.equal(ask.answer, undefined, "an ask has no allow/deny: its stored 'unknown' is not served");
  assert.equal(ask.waitedMs, MIN);
  assert.equal(recent.find((r) => r.id === "o4").answer, "unknown");
});

test("aggregate: a classifier block with no rule carries its deny reason", () => {
  ledger.ingest("h1", [
    row("c1", { kind: "classifier-denied", dialogKind: undefined, tool: "Write",
      head: "/home/u/.ssh/config", denyReason: "Writing to SSH configuration", answer: "deny" }),
    row("c2", { kind: "classifier-denied", dialogKind: undefined, head: "git rev-parse",
      denyReason: "push is outside scope", answer: "deny" }),
  ], NOW);
  const { top } = aggregate({ now: NOW });
  const write = top.find((g) => g.tool === "Write");
  assert.equal(write.suggestedRule, null);
  assert.equal(write.denyReason, "Writing to SSH configuration");
  const push = top.find((g) => g.head === "git rev-parse");
  assert.equal(push.suggestedRule, "autoMode.environment: allow Bash(git rev-parse:*)");
  assert.deepEqual([push.allowed, push.denied], [0, 1]);
  // A dialog group never carries a deny reason or a prompt.
  ledger.ingest("h1", [row("d1")], NOW);
  const dialog = aggregate({ now: NOW }).top.find((g) => g.kind === "dialog");
  assert.equal("denyReason" in dialog || "prompt" in dialog, false);
});

test("kindTotals: per-kind counts and summed waits for /metrics", () => {
  ledger.ingest("h1", [row("1", { waitedMs: 2000 }), row("2", { waitedMs: 3000 }),
    { id: "a1", kind: "ask-in-chat", openedAt: NOW - MIN }], NOW);
  const t = ledger.kindTotals();
  assert.deepEqual(t.dialog, { count: 2, waitMs: 5000 });
  assert.deepEqual(t["ask-in-chat"], { count: 1, waitMs: 0 });
  assert.deepEqual(t["classifier-denied"], { count: 0, waitMs: 0 });
});

// ---- the non-HA file backend ------------------------------------------------

test("file backend: flush writes, load restores and re-sanitizes", async () => {
  ledger.ingest("h1", [row("1"), row("2")], Date.now());
  await new Promise((r) => ledger.flush(r));
  const raw = JSON.parse(fs.readFileSync(ledger.LEDGER_FILE, "utf8"));
  assert.equal(raw.hosts.h1.length, 2);
  // A hand-edited row with junk is dropped on restore, the rest kept.
  raw.hosts.h1.push({ id: "bad id", kind: "dialog", openedAt: 1 });
  raw.hosts.__proto__ = [];
  fs.writeFileSync(ledger.LEDGER_FILE, JSON.stringify(raw));
  ledger._internals.load();
  assert.equal(ledger._internals.rowCount(), 2);
});

// A row whose every capped field is full of 3-byte UTF-8: the char caps let it
// reach ~15 KB serialized, so a row cap alone does not bound the bytes.
function fatRow(id, openedAt) {
  const w = (n) => "\u20ac".repeat(n);
  return { id, kind: "classifier-denied", openedAt, tool: w(128), head: w(200), digest: w(400),
    toolUseId: w(128), prompt: w(300), denyReason: w(300),
    options: Array.from({ length: 9 }, () => w(200)),
    rulesMatched: Array.from({ length: 8 }, () => w(200)) };
}

test("bytes: the store is bounded in BYTES too, oldest first, and the file it writes loads", async () => {
  const now = Date.now();
  const rows = Array.from({ length: 40 }, (_, i) => fatRow(`f${i}`, now - (40 - i) * MIN));
  ledger.ingest("h1", rows.slice(0, 20), now);
  ledger.ingest("h2", rows.slice(20), now);
  const kept = ledger._internals.rowCount();
  assert.ok(kept < 40, `byte budget evicted nothing (${kept} rows)`);
  assert.ok(ledger._internals.totalBytes() <= ledger._internals.maxBytes());
  assert.ok(ledger._internals.hosts().get("h2").has("f39"));        // the newest stays
  assert.ok(!ledger._internals.hosts().get("h1")?.has("f0"));       // the oldest went
  await new Promise((r) => ledger.flush(r));
  assert.ok(fs.statSync(ledger.LEDGER_FILE).size <= 400000);
  ledger._internals.load();
  assert.equal(ledger._internals.rowCount(), kept);                  // nothing lost to a refused load
});

test("bytes: one host's max-size rows cannot push another host's rows out", () => {
  const now = Date.now();
  // Ordinary rows from three hosts, all older than the flood.
  for (const h of ["a", "b", "c"]) {
    ledger.ingest(h, Array.from({ length: 3 }, (_, i) => row(`${h}${i}`, { openedAt: now - 60 * MIN + i })), now);
  }
  // One host floods max-size rows, newer than everyone else's.
  ledger.ingest("evil", Array.from({ length: 30 }, (_, i) => fatRow(`e${i}`, now - 30 * MIN + i)), now);
  for (const h of ["a", "b", "c"]) assert.equal(ledger._internals.hosts().get(h).size, 3, h);
  let evilBytes = 0;
  for (const r of ledger._internals.hosts().get("evil").values()) evilBytes += Buffer.byteLength(JSON.stringify(r)) + 1;
  assert.ok(evilBytes <= ledger._internals.maxBytes() / 4, `evil holds ${evilBytes} bytes`);
  assert.ok(ledger._internals.hosts().get("evil").has("e29"));      // its newest stays
});

test("bytes: the budget is a fraction of the container limit, never above the file budget", () => {
  // A sixty-fourth: 8 MiB at the deployed 512m, sized from the XERK-287 margin.
  assert.equal(ledger.setMemoryLimit(8 << 20), (8 << 20) / 64);
  assert.equal(ledger.setMemoryLimit(1 << 20), 64 << 10);             // the floor
  assert.equal(ledger.setMemoryLimit(1 << 30), Math.floor(400000 * 0.9));
  assert.equal(ledger.setMemoryLimit(null), Math.floor(400000 * 0.9));
});

test("bytes: a model over the file ceiling is trimmed before it is written, never written unloadable", async () => {
  const now = Date.now();
  const m = new Map();
  for (let i = 0; i < 40; i++) {
    const r = sanitize(fatRow(`g${i}`, now - (40 - i) * MIN), now);
    m.set(r.id, r);
  }
  ledger._internals.hosts().set("h1", m);                            // past every bound, unevicted
  const errs = [];
  const orig = console.error;
  console.error = (msg) => errs.push(String(msg));
  try { await new Promise((r) => ledger._internals.writeNow(r)); } finally { console.error = orig; }
  assert.ok(fs.statSync(ledger.LEDGER_FILE).size <= 400000);
  assert.ok(errs.some((e) => /past its ceiling/.test(e)));
  ledger._internals.load();
  assert.ok(ledger._internals.rowCount() > 0);
  assert.ok(ledger._internals.hosts().get("h1").has("g39"));
});

test("file backend: a save streams in chunks through a temp file, and overlapping saves all land", async () => {
  const now = Date.now();
  ledger.ingest("h1", Array.from({ length: 15 }, (_, i) => row(`s${i}`, { openedAt: now - (20 - i) * MIN,
    closedAt: undefined, waitedMs: undefined, answer: undefined, prompt: "p".repeat(300) })), now);
  ledger.ingest("h-2", Array.from({ length: 10 }, (_, i) => row(`t${i}`, { openedAt: now - (10 - i) * MIN,
    closedAt: undefined, waitedMs: undefined, answer: undefined })), now);
  const want = JSON.stringify([...ledger._internals.hosts()].map(([h, m]) => [h, [...m.values()]]));
  // Three saves asked for at once: one in flight, the rest answered by ONE follow-up.
  const results = await Promise.all([0, 1, 2].map(() => new Promise((r) => ledger.flush(r))));
  assert.deepEqual(results, [null, null, null]);
  assert.equal(fs.existsSync(`${ledger.LEDGER_FILE}.tmp`), false);
  const onDisk = JSON.parse(fs.readFileSync(ledger.LEDGER_FILE, "utf8"));
  assert.equal(onDisk.version, 1);
  assert.ok(fs.statSync(ledger.LEDGER_FILE).size > 3 * 2048, "the file spans several chunks");
  ledger._internals.load();
  assert.equal(JSON.stringify([...ledger._internals.hosts()].map(([h, m]) => [h, [...m.values()]])),
    want);
});

test("file backend: a save that fails before its rename leaves the previous file whole", async () => {
  const now = Date.now();
  ledger.ingest("h1", [row("keep", { openedAt: now - MIN })], now);
  await new Promise((r) => ledger.flush(r));
  const before = fs.readFileSync(ledger.LEDGER_FILE, "utf8");
  ledger.ingest("h1", Array.from({ length: 10 }, (_, i) => row(`n${i}`, { openedAt: now - i,
    prompt: "q".repeat(300) })), now);
  const rename = fs.promises.rename;
  fs.promises.rename = () => Promise.reject(new Error("crash before rename"));
  let err;
  try {
    err = await new Promise((r) => ledger.flush(r));
  } finally {
    fs.promises.rename = rename;
  }
  assert.match(String(err && err.message), /crash before rename/);
  // The ledger was never written in place: the old file is byte-identical and loads.
  assert.equal(fs.readFileSync(ledger.LEDGER_FILE, "utf8"), before);
  assert.equal(fs.existsSync(`${ledger.LEDGER_FILE}.tmp`), false);
  ledger._internals.load();
  assert.deepEqual([...ledger._internals.hosts().get("h1").keys()], ["keep"]);
});

test("file backend: an unreadable file starts empty, never throws", () => {
  fs.writeFileSync(ledger.LEDGER_FILE, "{not json");
  ledger._internals.load();
  assert.equal(ledger._internals.rowCount(), 0);
});

// ---- the HA Postgres append table -------------------------------------------

class FakePgPool {
  constructor() { this.rows = new Map(); this.sql = []; this.health = "ready"; }
  onHealth() { return () => {}; }
  ready() { return Promise.resolve(); }
  query(text, params = []) {
    const sql = text.replace(/\s+/g, " ").trim();
    this.sql.push(sql);
    if (/^CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(sql)) return Promise.resolve([]);
    if (/^ALTER TABLE "permission_event" ADD COLUMN IF NOT EXISTS progress smallint NOT NULL DEFAULT 0$/.test(sql)) {
      return Promise.resolve([]);
    }
    let m = /^INSERT INTO "permission_event" \(host, id, opened_at, progress, doc\) VALUES (.*) ON CONFLICT \(host, id\) DO UPDATE SET opened_at = EXCLUDED\.opened_at, progress = EXCLUDED\.progress, doc = EXCLUDED\.doc WHERE EXCLUDED\.progress >= "permission_event"\.progress$/.exec(sql);
    if (m) {
      const seen = new Set();
      for (let i = 0; i < params.length; i += 5) {
        const k = `${params[i]}\u0000${params[i + 1]}`;
        // Postgres: "ON CONFLICT DO UPDATE command cannot affect row a second time".
        if (seen.has(k)) return Promise.reject(new Error("cannot affect row a second time"));
        seen.add(k);
      }
      if (this.failInserts) return Promise.reject(new Error("pg down"));
      for (let i = 0; i < params.length; i += 5) {
        const [host, id, openedAt, progress, doc] = params.slice(i, i + 5);
        assert.equal(typeof openedAt, "string");             // text protocol
        assert.equal(typeof progress, "string");
        const k = `${host}\u0000${id}`;
        const have = this.rows.get(k);
        // The WHERE guard: a less-far-along copy never replaces a stored one.
        if (have && Number(progress) < Number(have.progress || 0)) continue;
        this.rows.set(k, { host, id, opened_at: openedAt, progress, doc });
      }
      return Promise.resolve([]);
    }
    m = /^SELECT host, doc FROM "permission_event" WHERE opened_at >= \$1 ORDER BY opened_at DESC LIMIT \$2$/.exec(sql);
    if (m) {
      const since = Number(params[0]);
      return Promise.resolve([...this.rows.values()]
        .filter((r) => Number(r.opened_at) >= since)
        .sort((a, b) => Number(b.opened_at) - Number(a.opened_at))
        .slice(0, Number(params[1]))
        .map((r) => ({ host: r.host, doc: r.doc })));
    }
    m = /^DELETE FROM "permission_event" WHERE opened_at < \$1$/.exec(sql);
    if (m) {
      for (const [k, r] of this.rows) if (Number(r.opened_at) < Number(params[0])) this.rows.delete(k);
      return Promise.resolve([]);
    }
    throw new Error(`FakePgPool: unrecognised SQL: ${sql}`);
  }
}

test("HA: configure swaps in the Postgres append table; rows upsert by (host, id)", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  assert.ok(ledger._internals.getBackend() instanceof ledger.PermissionLedgerPgStore);
  const now = Date.now();
  ledger.ingest("h1", [{ id: "d-1", kind: "dialog", openedAt: now - MIN }], now);
  ledger.ingest("h1", [row("d-1", { openedAt: now - MIN, closedAt: now })], now);
  await new Promise((r) => ledger.flush(r));
  assert.equal(pool.rows.size, 1);                            // the closed row replaced the open one
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-1").doc).answer, "allow");
});

test("HA: rehydrate (leader promotion) loads the retained window into the hot model", async () => {
  const pool = new FakePgPool();
  const now = Date.now();
  const put = (host, r) => pool.rows.set(`${host}\u0000${r.id}`,
    { host, id: r.id, opened_at: String(r.openedAt), doc: JSON.stringify(r) });
  put("h1", row("a", { openedAt: now - MIN }));
  put("h2", row("b", { openedAt: now - 2 * MIN }));
  put("h2", { ...row("junk"), kind: "nope" });               // re-sanitized: dropped
  pool.rows.set("h3\u0000x", { host: "h3", id: "x", opened_at: String(now), doc: "{not json" });
  await ledger.configure({ ha: true }, pool);                 // ready edge scans
  ledger._internals.hosts().clear();
  await ledger.rehydrate();
  assert.equal(ledger._internals.rowCount(), 2);
  assert.equal(aggregate({ now }).top[0].count, 2);
});

test("HA: the retention sweep deletes rows past PERMISSION_LEDGER_DAYS", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  pool.rows.set("h1\u0000old", { host: "h1", id: "old",
    opened_at: String(now - (ledger.DAYS + 1) * DAY), doc: "{}" });
  pool.rows.set("h1\u0000new", { host: "h1", id: "new", opened_at: String(now), doc: "{}" });
  await ledger._internals.getBackend().sweep(now);
  assert.deepEqual([...pool.rows.keys()], ["h1\u0000new"]);
});

test("HA: a failed write is logged and held, never thrown into the beat", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  pool.query = (t) => (/^INSERT/.test(t) ? Promise.reject(new Error("pg down")) : Promise.resolve([]));
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    assert.equal(ledger.ingest("h1", [row("1", { openedAt: Date.now() })]), 1);
    await new Promise((r) => ledger.flush(r));
  } finally { console.error = orig; }
  assert.ok(errs.some((m) => /Postgres write failed/.test(m)));
  assert.equal(ledger._internals.rowCount(), 1);              // the hot model kept it
});

test("HA: a write that failed is retried, and a ready-edge rescan never reverts a closed row", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  const store = ledger._internals.getBackend();
  ledger.ingest("h1", [{ id: "d-s-1", kind: "dialog", openedAt: now - MIN, head: "git push" }], now);
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-s-1").doc).closedAt, undefined);
  pool.failInserts = true;                                    // the blip
  const orig = console.error;
  console.error = () => {};
  try {
    ledger.ingest("h1", [row("d-s-1", { openedAt: now - MIN, closedAt: now, answer: "allow" })], now);
    await new Promise((r) => ledger.flush(r));
  } finally { console.error = orig; }
  pool.failInserts = false;
  await store._onReady();                                     // the pool's ready edge
  const hot = ledger._internals.hosts().get("h1").get("d-s-1");
  assert.equal(hot.closedAt, now);                            // the served model kept the close
  assert.equal(hot.answer, "allow");
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-s-1").doc).closedAt, now);   // and the of-record caught up
});

test("HA: a stale hot copy re-queued by a rescan still lands in the table", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  // PG holds the open copy (the closed write was lost before this fix shipped).
  pool.rows.set("h1\u0000d-2", { host: "h1", id: "d-2", opened_at: String(now - MIN),
    doc: JSON.stringify({ id: "d-2", kind: "dialog", openedAt: now - MIN }) });
  ledger._internals.hosts().set("h1", new Map([["d-2", sanitize(row("d-2", { openedAt: now - MIN, closedAt: now }), now)]]));
  await ledger.rehydrate();
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-2").doc).answer, "allow");
});

test("HA: a failed write of a row the table never held lands on the next write", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  // Let the boot ready-edge finish: its rescan would otherwise re-queue the row.
  await ledger._internals.getBackend()._onReady();
  const now = Date.now();
  pool.failInserts = true;
  const orig = console.error;
  console.error = () => {};
  try {
    ledger.ingest("h1", [row("new-1", { openedAt: now - MIN, closedAt: now })], now);
    await new Promise((r) => ledger.flush(r));
  } finally { console.error = orig; }
  assert.equal(pool.rows.has("h1\u0000new-1"), false);
  pool.failInserts = false;
  // The NEXT beat's write — not a rescan, which has no PG copy to compare against.
  ledger.ingest("h1", [row("other", { openedAt: now - MIN })], now);
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000new-1").doc).closedAt, now);
});

test("HA: a ready-edge rescan re-queues a hot row the table lacks entirely", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  // Trimmed past PG_QUEUE_MAX during an outage: only the hot model holds it.
  ledger._internals.hosts().set("h1", new Map([["t-1", sanitize(row("t-1", { openedAt: now - MIN, closedAt: now }), now)]]));
  await ledger.rehydrate();
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000t-1").doc).closedAt, now);
});

test("HA: the upsert is monotone — a late OPEN copy never reverts a CLOSED row", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  ledger.ingest("h1", [row("d-m", { openedAt: now - MIN, closedAt: now })], now);
  await new Promise((r) => ledger.flush(r));
  // An old leader retrying its held open copy after the new leader wrote the close.
  ledger._internals.getBackend().onChange("h1",
    [sanitize({ id: "d-m", kind: "dialog", openedAt: now - MIN }, now)]);
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-m").doc).closedAt, now);
  assert.ok(pool.sql.some((q) => /WHERE EXCLUDED\.progress >= "permission_event"\.progress$/.test(q)));
});

test("HA: one row open AND closed in one batch upserts once, the closed copy winning", async () => {
  const pool = new FakePgPool();
  await ledger.configure({ ha: true }, pool);
  const now = Date.now();
  ledger.ingest("h1", [{ id: "d-3", kind: "dialog", openedAt: now - MIN },
    row("d-3", { openedAt: now - MIN, closedAt: now })], now);
  await new Promise((r) => ledger.flush(r));
  assert.equal(JSON.parse(pool.rows.get("h1\u0000d-3").doc).closedAt, now);
});

test("HA off: configure is a no-op, the file backend stays", async () => {
  await ledger.configure({ ha: false }, new FakePgPool());
  await ledger.configure(null, null);
  assert.equal(ledger._internals.getBackend().constructor.name, "Object");
});
