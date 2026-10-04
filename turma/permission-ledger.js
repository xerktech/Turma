// The permission ledger (XERK-1563, epic XERK-1560): every permission prompt a
// session hit — a numbered TUI dialog, an auto-mode classifier block, or the
// session asking for permission in chat — with how long it held the session and
// the allow rule that would retire it. Agents send rows on the heartbeat
// (`permissionEvents`); this module bounds them, keeps them, and serves the
// rolling aggregates `GET /api/permissions` and `/metrics` read.
//
// ## Persistence — the usage-ledger FILE skeleton, a Postgres APPEND table under HA
//
// The in-memory model (per-host shards of rows keyed by row id) is the served,
// synchronous read model in both modes. Only persistence differs:
//   - file (DEFAULT, non-HA): `/data/permission-ledger.json`, rewritten whole on a
//     debounce + flushed on graceful shutdown — usage-ledger.js's load/evict and
//     debounced-write shape. HA `/data` is a per-pod emptyDir, so this is NON-HA only.
//   - Postgres (HA): one row per ledger row in `permission_event`, upserted by
//     (host, id) — a row is sent open and again closed, and the later one wins —
//     with PERMISSION_LEDGER_DAYS retention, rescanned into the model on the pool's
//     ready edge and on leader promotion (`rehydrate()`). Under XERK-919 the leader
//     receives every beat and serves every read, so its hot model is complete.
// Never `registerExternalStore`: rows churn every beat, and HA rewrites a whole
// external-store value per persist.

"use strict";

const fs = require("fs");
const path = require("path");

function positiveEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${name}=${JSON.stringify(raw)} is not a positive number; using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

const LEDGER_FILE = process.env.PERMISSION_LEDGER_FILE || "/data/permission-ledger.json";
const MAX_ROWS = positiveEnv("PERMISSION_LEDGER_MAX_ROWS", 20000);
// One host may hold at most this share of the rows AND of the byte budget (see
// evict), so a flooding host cannot evict the fleet.
const HOST_MAX_ROWS = positiveEnv("PERMISSION_LEDGER_HOST_MAX_ROWS", Math.max(1, Math.floor(MAX_ROWS / 4)));
const DAYS = positiveEnv("PERMISSION_LEDGER_DAYS", 30);
const DAY_MS = 86400000;
// What one beat may add: the agent sends at most this many, and a hub never
// trusts that it did.
const EVENTS_PER_BEAT = 200;
// The file is measured before it is read (an oversized one is an OOM at boot,
// every boot). The byte budget below keeps a written file far under this.
const FILE_MAX_BYTES = positiveEnv("PERMISSION_LEDGER_FILE_MAX", 16 << 20);
// The store is bounded in BYTES as well as rows: every cap above is in chars, so
// a row can serialize to ~15 KB of UTF-8 and MAX_ROWS of them would be a file
// load() refuses and a heap the container cannot hold. The budget is the smaller
// of nine tenths of the file ceiling (so a written file always loads) and a
// FRACTION of the container's memory limit (CLAUDE.md: memory ceilings are
// fractions, never fixed numbers) — server.js hands that limit in through
// setMemoryLimit() at boot. The fraction is sized from the ~68 MiB XERK-287
// co-peak MARGIN, not the container: a sixty-fourth (8 MiB of JSON at 512m) is
// ~9 MiB of retained heap, and a save streams the file in chunks rather than
// building a second whole copy (turma-limits.md records it in that margin).
const FILE_BUDGET_BYTES = Math.floor(FILE_MAX_BYTES * 0.9);
const BYTES_ENV = positiveEnv("PERMISSION_LEDGER_MAX_BYTES", 0);
const MEMORY_FRACTION = 64;               // 8 MiB at the deployed 512m
// An unknown limit (no cgroup) is budgeted as the deployed container.
const ASSUMED_MEMORY_LIMIT = 512 << 20;
function byteBudget(limit) {
  let b = FILE_BUDGET_BYTES;
  if (BYTES_ENV) b = Math.min(b, BYTES_ENV);
  const mem = Number.isFinite(limit) && limit > 0 ? limit : ASSUMED_MEMORY_LIMIT;
  return Math.min(b, Math.max(64 << 10, Math.floor(mem / MEMORY_FRACTION)));
}
let maxBytes = byteBudget(null);
const SAVE_DEBOUNCE_MS = positiveEnv("PERMISSION_LEDGER_SAVE_MS", 5000);
const TOP_MAX = 50;
const RECENT_MAX = 50;

// ---- ingest bounds: every field whitelisted, strict enums, capped strings ----
// `judged`: the agent's permission judge decided a Bash prompt (XERK-1566).
const KINDS = new Set(["dialog", "classifier-denied", "ask-in-chat", "judged"]);
const VERDICTS = new Set(["allow", "stand"]);
const DIALOG_KINDS = new Set(["permission", "plan", "sandbox", "other"]);
const ANSWERS = new Set(["allow", "deny", "unknown"]);
const VIA = new Set(["turma", "terminal", "unknown"]);
const ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;
const SID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const STR_CAPS = {
  tool: 128, head: 200, digest: 400, toolUseId: 128, prompt: 300, denyReason: 300,
  judgeReason: 300,
};
// A wait longer than the retention window is not a wait this ledger can hold.
const WAIT_MAX_MS = DAYS * DAY_MS;
// A row still open past this is one the agent lost; ageOut closes it as unknown.
const OPEN_MAX_MS = DAY_MS;

function capStr(v, max) {
  if (typeof v !== "string") return "";
  // C0/DEL/C1 out: these are rendered and logged, and a line break forges rows.
  return v.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, max);
}
function finiteNum(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One agent-sent row → the stored shape, or null. Whitelist: an unknown key is
 * dropped, a wrong-typed one coerced to "can't tell" (absent), never to a
 * plausible value. `openedAt` is required and may not sit in the future (past a
 * day of clock skew) — a future row would never age out of the window.
 */
function sanitizePermissionEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  if (!KINDS.has(raw.kind)) return null;
  const openedAt = finiteNum(raw.openedAt);
  if (openedAt === null || openedAt <= 0 || openedAt > now + DAY_MS) return null;
  const row = { id: raw.id, kind: raw.kind, openedAt: Math.floor(openedAt) };
  if (typeof raw.sessionId === "string" && SID_RE.test(raw.sessionId)) row.sessionId = raw.sessionId;
  if (raw.kind === "dialog") row.dialogKind = DIALOG_KINDS.has(raw.dialogKind) ? raw.dialogKind : "other";
  for (const [k, max] of Object.entries(STR_CAPS)) {
    const v = capStr(raw[k], max);
    if (v) row[k] = v;
  }
  for (const k of ["options", "rulesMatched"]) {
    if (!Array.isArray(raw[k])) continue;
    const list = raw[k].filter((s) => typeof s === "string").slice(0, k === "options" ? 9 : 8)
      .map((s) => capStr(s, 200));
    if (list.length) row[k] = list;
  }
  const closedAt = finiteNum(raw.closedAt);
  if (closedAt !== null && closedAt >= row.openedAt && closedAt <= now + DAY_MS) {
    row.closedAt = Math.floor(closedAt);
  }
  const waited = finiteNum(raw.waitedMs);
  if (waited !== null && waited >= 0 && waited <= WAIT_MAX_MS) row.waitedMs = Math.floor(waited);
  if (ANSWERS.has(raw.answer)) row.answer = raw.answer;
  if (Number.isInteger(raw.answerNumber) && raw.answerNumber >= 1 && raw.answerNumber <= 9) {
    row.answerNumber = raw.answerNumber;
  }
  if (VIA.has(raw.via)) row.via = raw.via;
  if (raw.kind === "judged" && VERDICTS.has(raw.verdict)) row.verdict = raw.verdict;
  return row;
}

// ---- the model -----------------------------------------------------------------
// host -> Map(id -> row). Insertion order is not trusted for eviction: rows are
// evicted by `openedAt`, oldest first.
let hosts = new Map();
// row -> its serialized UTF-8 size, measured once when the row enters the model.
let rowBytes = new WeakMap();

function track(row) {
  rowBytes.set(row, Buffer.byteLength(JSON.stringify(row), "utf8") + 1);
  return row;
}
function bytesOf(row) {
  let n = rowBytes.get(row);
  if (n === undefined) n = rowBytes.set(row, Buffer.byteLength(JSON.stringify(row), "utf8") + 1).get(row);
  return n;
}
function totalBytes() {
  let n = 0;
  for (const m of hosts.values()) for (const row of m.values()) n += bytesOf(row);
  return n;
}

/** The container's memory limit in bytes (null = unknown, budgeted as the
 * deployed 512m): the byte budget becomes the smaller of the file budget and a
 * sixty-fourth of it. */
function setMemoryLimit(limit) {
  maxBytes = byteBudget(limit);
  return maxBytes;
}

function rowCount() {
  let n = 0;
  for (const m of hosts.values()) n += m.size;
  return n;
}

function oldestFirst(list) {
  return list.sort((a, b) => a.openedAt - b.openedAt || (a.id < b.id ? -1 : 1));
}

// Drop rows past retention, then trim any host past its share, then the store
// past MAX_ROWS — oldest first each time. Returns the (host, id) pairs dropped.
function evict(now = Date.now()) {
  const cutoff = now - DAYS * DAY_MS;
  const dropped = [];
  for (const [host, m] of hosts) {
    for (const [id, row] of m) if (row.openedAt < cutoff) { m.delete(id); dropped.push([host, id]); }
    // The row share alone is not enough: the binding limit is bytes, and a
    // host's row share of max-size rows would fill most of it. So a host also
    // keeps at most a quarter of the byte budget, oldest dropped first.
    let hostBytes = 0;
    for (const row of m.values()) hostBytes += bytesOf(row);
    const hostMaxBytes = Math.floor(maxBytes / 4);
    if (m.size > HOST_MAX_ROWS || hostBytes > hostMaxBytes) {
      let overRows = m.size - HOST_MAX_ROWS;
      for (const row of oldestFirst([...m.values()])) {
        if (overRows <= 0 && hostBytes <= hostMaxBytes) break;
        overRows -= 1;
        hostBytes -= bytesOf(row);
        m.delete(row.id);
        dropped.push([host, row.id]);
      }
    }
    if (!m.size) hosts.delete(host);
  }
  let over = rowCount() - MAX_ROWS;
  let overBytes = totalBytes() - maxBytes;
  if (over > 0 || overBytes > 0) {
    const all = [];
    for (const [host, m] of hosts) for (const row of m.values()) all.push({ host, row });
    all.sort((a, b) => a.row.openedAt - b.row.openedAt);
    for (const { host, row } of all) {
      if (over <= 0 && overBytes <= 0) break;
      over -= 1;
      overBytes -= bytesOf(row);
      const m = hosts.get(host);
      m.delete(row.id);
      if (!m.size) hosts.delete(host);
      dropped.push([host, row.id]);
    }
  }
  return dropped;
}

/**
 * Fold one beat's rows for `host`. A row id seen before REPLACES the stored row
 * (an open dialog row is sent again once closed). Returns how many were kept.
 * Called only after every gate that can still refuse the beat.
 */
function ingest(host, events, now = Date.now()) {
  if (typeof host !== "string" || !host || host === "__proto__" || !Array.isArray(events)) return 0;
  const kept = [];
  for (const raw of events.slice(0, EVENTS_PER_BEAT)) {
    const row = sanitizePermissionEvent(raw, now);
    if (row) kept.push(track(row));
  }
  if (!kept.length) return 0;
  let m = hosts.get(host);
  if (!m) hosts.set(host, (m = new Map()));
  for (const row of kept) m.set(row.id, row);
  const closed = closeSuperseded(m, kept);
  const aged = ageOut(now);
  evict(now);
  const mine = [...kept, ...closed, ...(aged.get(host) || [])].filter((r) => m.get(r.id) === r);
  backend.onChange(host, mine);
  for (const [h, rows] of aged) {
    if (h === host) continue;
    const hm = hosts.get(h);
    const live = hm ? rows.filter((r) => hm.get(r.id) === r) : [];
    if (live.length) backend.onChange(h, live);
  }
  return kept.length;
}

// Still holding its session: no close and no answer of any kind.
function isOpen(row) {
  return typeof row.closedAt !== "number" && !row.answer;
}

// A row the agent lost stays open here until something closes it. The agent closes
// a row before it opens the session's next one of the same kind, and an ask once
// the session moves past it — so only a LOST row (a manager restart forgets its
// open rows) can still be open behind a newer one:
//   - a newer DIALOG row for a session closes that session's older open dialog row
//     (a pane shows one dialog at a time);
//   - ANY newer row for a session closes that session's older open ASK (the
//     session ran on, so it moved past the turn that asked).
// Closed with the answer and wait unknown — the hub never saw either. A real
// closed copy arriving later replaces this one by id. A classifier block is
// complete on arrival and never open.
function closeSuperseded(m, kept) {
  const newestDialog = new Map();   // sessionId -> openedAt of this beat's newest dialog row
  const newestAny = new Map();      // sessionId -> openedAt of this beat's newest row
  for (const r of kept) {
    if (!r.sessionId) continue;
    if (!(newestAny.get(r.sessionId) >= r.openedAt)) newestAny.set(r.sessionId, r.openedAt);
    if (r.kind === "dialog" && !(newestDialog.get(r.sessionId) >= r.openedAt)) {
      newestDialog.set(r.sessionId, r.openedAt);
    }
  }
  if (!newestAny.size) return [];
  const closed = [];
  for (const row of m.values()) {
    if (!row.sessionId || !isOpen(row)) continue;
    const at = row.kind === "dialog" ? newestDialog.get(row.sessionId)
      : row.kind === "ask-in-chat" ? newestAny.get(row.sessionId) : undefined;
    if (at === undefined || row.openedAt >= at) continue;
    closed.push(track({ ...row, closedAt: at, answer: "unknown", via: "unknown" }));
  }
  for (const row of closed) m.set(row.id, row);
  return closed;
}

// A row open longer than OPEN_MAX_MS is closed as unknown — whichever host it is
// on, at every ingest and every load/rescan. Nothing above closes a lost row whose
// session never files another (a session deleted while the manager was down, or a
// host that went away), and it would read "open" for the whole retention window.
// `closedAt` is when the hub gave up; no `waitedMs` (the wait is unknown). A real
// closed copy arriving later replaces it by id. Returns Map(host -> closed rows).
function ageOut(now = Date.now()) {
  const cutoff = now - OPEN_MAX_MS;
  const out = new Map();
  for (const [host, m] of hosts) {
    for (const row of m.values()) {
      if (row.openedAt >= cutoff || !isOpen(row)) continue;
      const done = track({ ...row, closedAt: now, answer: "unknown", via: "unknown" });
      m.set(row.id, done);
      if (!out.has(host)) out.set(host, []);
      out.get(host).push(done);
    }
  }
  return out;
}

// ---- reads ---------------------------------------------------------------------

// How far along a row is: closed beats open, and a dialog that has its hook's
// rulesMatched beats one that does not. Equal progress → the of-record copy wins.
function rowProgress(row) {
  return (typeof row.closedAt === "number" ? 2 : 0) + (row.rulesMatched ? 1 : 0);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// The Bash heads a `Bash(<head>:*)` rule IS offered for — a POSITIVE allowlist,
// the only thing that makes a Bash rule safe to paste. A prefix rule allows the
// head with ANY arguments, so a head is listed only when no argument it takes can
// run code: read-only inspection tools, and a few subcommands of a CLI whose own
// flags exec nothing. Everything else — an interpreter, shell, wrapper, runner, a
// tool with an exec flag (`find -exec`, `rg --pre`, `sort --compress-program`,
// `git fetch --upload-pack`, `go test -exec`, `npm test --node-options`), a path
// to a binary, an unknown CLI — gets NO rule and a reason: the card says "no
// safe rule, review it". Missing a safe head only withholds a suggestion;
// listing an unsafe one hands out an allow-everything rule. Add a head only with
// its argument surface checked, and a test row.
const BASH_SAFE_HEADS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "stat", "file", "du", "df",
  "pwd", "which", "whoami", "uname", "id", "date", "echo", "printf", "diff", "cmp", "comm",
  "cut", "tr", "jq", "realpath", "dirname", "basename", "readlink", "nl", "tac", "rev",
  "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "ps", "free", "uptime", "seq",
  "od", "hexdump", "strings", "column", "paste", "join", "fold", "true", "false",
]);
// A subcommand CLI's head is two words (`git status`); only these get a rule. Left
// out on purpose: `git diff`/`log`/`show` (`--output=<file>` writes any file),
// `git fetch`/`pull`/`push` (`--upload-pack`/`--receive-pack` run a command),
// `git rebase` (`--exec`), `kubectl get` (`--kubeconfig` names an exec plugin),
// `npm test`/`run` (`--node-options`, `--script-shell`), `go test` (`-exec`),
// `cargo` (`--config` sets a runner), `make` (variable overrides run anything).
// Also out: a subcommand GROUP whose verbs differ in kind — the head is two words,
// so the rule covers every verb under it. `gh pr`/`glab mr` (`merge --admin`
// lands on main past branch protection; `checkout -R` pulls any repo's tree and
// runs its hooks), `gh run` (`download -R … -D <dir>` writes any directory),
// `gh issue`/`glab issue` (writes to the tracker), and `git commit`/`switch`/
// `add`/`branch` (hooks a session can edit; `branch -D` deletes work).
const BASH_SAFE_SUBCOMMANDS = new Set([
  "git status", "git rev-parse", "git ls-files", "git blame", "git describe",
  "gh search", "gh status",
  "docker ps", "docker images", "docker logs", "docker inspect",
  "npm ls", "npm view", "npm outdated", "systemctl status",
]);
// A SECOND check, not what keeps the table safe (the allowlist is): heads known
// to run whatever follows them. An allowlisted head listed here still gets no
// rule, and a listed head's reason says why.
const BASH_NEVER_HEADS = new Set([
  "bash", "sh", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "pwsh", "powershell",
  "ash", "mksh", "yash", "xonsh", "nu", "elvish",
  "python", "python2", "python3", "py", "pythonw", "node", "deno", "ruby", "perl", "php",
  "lua", "R", "swift", "scala", "groovy", "erl", "ghci", "jshell", "racket", "guile", "sbcl",
  "osascript", "sudo", "su", "doas", "pkexec", "env", "xargs", "timeout", "gtimeout", "nohup",
  "nice", "time", "watch", "exec", "eval", "source", ".", "command", "builtin", "for",
  "while", "until", "if", "case", "select", "function", "do", "then", "npx", "bunx", "uvx",
  "npm exec", "pnpm exec", "pnpm dlx", "yarn dlx", "uv run", "docker run",
  "docker exec", "kubectl exec", "podman exec", "nerdctl exec", "bundle exec", "ssh", "awk",
  "find", "parallel", "script", "sed",
  "docker container", "docker compose", "npm x", "bun x", "bun run", "yarn exec",
  "go run", "cargo run", "dotnet run", "kubectl run", "kubectl debug",
  "stdbuf", "setsid", "chroot", "unshare", "nsenter", "strace", "ltrace", "busybox", "toybox",
  "flock", "taskset", "ionice", "chrt", "runuser", "setpriv", "systemd-run", "fakeroot",
  "proot", "bwrap", "firejail", "torsocks", "proxychains", "chpst", "sg", "valgrind", "perf",
  "caffeinate", "unbuffer", "expect", "xvfb-run", "dbus-run-session", "tsx", "ts-node",
  "poetry", "pipx", "pdm", "hatch", "conda", "mamba", "micromamba", "nix", "nix-shell",
  "mise", "asdf", "direnv", "java", "julia", "Rscript", "tclsh",
  "cmd", "cmd.exe", "powershell.exe", "pwsh.exe", "wsl", "wsl.exe",
  "nodejs", "pypy", "ipython", "bpython", "luajit", "gawk", "mawk", "nawk", "pnpx",
  "uv tool", "yarn node", "dotnet exec",
]);
// A versioned interpreter binary (`python3.11`, `php8.2`, `node22`) or a Windows
// `.exe` is its family — for the never-list's reason only; neither is allowlisted.
function bashFamily(base) {
  const name = base.replace(/\.exe$/i, "");
  const m = /^(.*?[A-Za-z])[\d.]+$/.exec(name);
  return m ? m[1] : name;
}
const BASH_HEAD_RE = /^[A-Za-z0-9._/-]+( [A-Za-z0-9._-]+)?$/;
// MIRRORS `SUBCOMMAND_CLIS` in agent/hooks/permlog.py (parity-tested): CLIs whose
// subcommand is the decision. permlog keeps the subcommand in the head only when
// it is the second word, so a leading global flag (`git -C /repo push`,
// `kubectl -n prod exec`) leaves the BARE CLI — which says nothing about what ran.
const SUBCOMMAND_CLIS = new Set([
  "git", "gh", "glab", "az", "npm", "pnpm", "yarn", "npx", "bun", "docker",
  "kubectl", "helm", "cargo", "go", "uv", "pip", "pip3", "terraform", "make",
  "systemctl", "brew", "apt", "apt-get", "dotnet", "gradle", "./gradlew",
]);

// `{rule}` for an allowlisted Bash head, else `{rule: null, reason}` — the reason
// is WHY there is no safe rule; the card shows it under "no safe rule — review it".
function bashVerdict(head) {
  if (!head || !BASH_HEAD_RE.test(head)) {
    return { rule: null, reason: "not a plain command name" };
  }
  const word = head.split(" ")[0];
  const base = word.slice(word.lastIndexOf("/") + 1);
  if (BASH_NEVER_HEADS.has(head) || BASH_NEVER_HEADS.has(word) || BASH_NEVER_HEADS.has(base)
      || BASH_NEVER_HEADS.has(bashFamily(base))) {
    return { rule: null, reason: "runs whatever follows it" };
  }
  if (word.includes("/")) {
    return { rule: null, reason: "a path runs whatever binary sits there" };
  }
  if (word === head && SUBCOMMAND_CLIS.has(word)) {
    return { rule: null,
      reason: `no subcommand recorded, and a bare ${word} rule allows every one` };
  }
  if (word === head ? BASH_SAFE_HEADS.has(head) : BASH_SAFE_SUBCOMMANDS.has(head)) {
    return { rule: `Bash(${head}:*)` };
  }
  return { rule: null,
    reason: "not on the known read-only list, so its arguments may run code" };
}

// A FULL MCP tool name, `mcp__<server>__<tool>`, no wildcard. `tool` is
// agent-supplied (a session can write its own hook log with Bash), and a bare
// `mcp__github` or `mcp__github__*` would allow every tool on that server.
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;

function toolVerdict(tool, head) {
  if (tool === "Bash") return bashVerdict(head);
  if (typeof tool === "string" && tool.startsWith("mcp__")) {
    return MCP_TOOL_RE.test(tool) ? { rule: tool } : { rule: null, reason: "not a full MCP tool name" };
  }
  if (tool === "WebFetch" && head && HOST_RE.test(head)) return { rule: `WebFetch(domain:${head})` };
  return { rule: null };
}

/**
 * The allow rule that would retire a prompt — DETERMINISTIC, a table, never a
 * judgement (the LLM judge, XERK-1566, consumes it):
 *   ask-in-chat                      → "model behaviour: see CLAUDE.md step 0"
 *   a sandbox dialog naming a host   → sandbox.network.allowedDomains: <host>;
 *                                      one with no readable host gets none
 *   classifier-denied                → an autoMode.environment allow line for the
 *                                      call's tool rule; NONE when the call has no
 *                                      tool rule (a sentence lifted from the deny
 *                                      reason is not a line anything accepts)
 *   Bash                             → Bash(<head>:*) ONLY for a head on the
 *                                      allowlist (BASH_SAFE_HEADS /
 *                                      BASH_SAFE_SUBCOMMANDS); any other head gets
 *                                      none, with a reason
 *   MCP                              → the full mcp__<server>__<tool> ONLY
 *                                      (MCP_TOOL_RE); a bare server or a
 *                                      wildcard gets none, with a reason
 *   WebFetch                         → WebFetch(domain:<d>)
 *   judged (XERK-1566)               → null: the judge's verdict on a prompt whose
 *                                      own dialog/classifier row already carries
 *                                      the actionable rule (a second Copy for the
 *                                      same prompt, or one for a STOOD command,
 *                                      would only mislead)
 *   anything else                    → null (no rule retires it)
 * Returns `{rule, reason}`: `reason` only for a Bash head, an MCP name or a
 * sandbox prompt that gets no rule.
 */
function ruleVerdict(g) {
  if (!g) return { rule: null };
  if (g.kind === "judged") return { rule: null };
  if (g.kind === "ask-in-chat") return { rule: "model behaviour: see CLAUDE.md step 0" };
  if (g.dialogKind === "sandbox") {
    // No tool allow rule retires a sandbox NETWORK prompt, so one whose host
    // could not be read gets no rule, never the call's own Bash rule.
    return g.head && HOST_RE.test(g.head)
      ? { rule: `sandbox.network.allowedDomains: ${g.head}` }
      : { rule: null, reason: "no host recorded for this sandbox prompt" };
  }
  const v = toolVerdict(g.tool, g.head);
  if (g.kind === "classifier-denied") {
    return v.rule ? { rule: `autoMode.environment: allow ${v.rule}` } : v;
  }
  if (g.dialogKind === "plan") return { rule: null };
  return v;
}

function suggestedRule(g) {
  return ruleVerdict(g).rule || null;
}

function scopedRows(hostSet, days, now) {
  const since = now - Math.min(Math.max(1, days || 7), DAYS) * DAY_MS;
  const out = [];
  for (const [host, m] of hosts) {
    if (hostSet && !hostSet.has(host)) continue;
    for (const row of m.values()) if (row.openedAt >= since) out.push({ host, row });
  }
  return out;
}

// An ask-in-chat row has no tool or head — what tells two asks apart is the
// question itself. Its group key is the question folded to lower-case letters
// (case, punctuation, digits and spacing dropped, so "Shall I push PR #12?" and
// "shall I push PR #13" are one ask) and bounded, so a long ask cannot make a
// long key.
const ASK_KEY_MAX = 120;
function askKey(prompt) {
  if (typeof prompt !== "string") return "";
  return prompt.toLowerCase().replace(/[^\p{L}]+/gu, " ").trim().slice(0, ASK_KEY_MAX);
}

/**
 * `{top, recent}` for the Usage page. `hostSet` (a Set of host keys) scopes it —
 * the route builds it from the LIVE fleet's org, like `retiredUsage`; null = all.
 */
function aggregate({ hosts: hostSet = null, days = 7, now = Date.now() } = {}) {
  const rows = scopedRows(hostSet, days, now);
  const groups = new Map();
  for (const { row } of rows) {
    const ask = row.kind === "ask-in-chat";
    const key = [row.kind, row.dialogKind || "", row.tool || "", row.head || "",
      ask ? askKey(row.prompt) : ""].join("\u0000");
    let g = groups.get(key);
    if (!g) {
      g = { kind: row.kind, dialogKind: row.dialogKind || null, tool: row.tool || null,
        head: row.head || null, count: 0, allowed: 0, denied: 0, open: 0, waits: [], lastAt: 0,
        denyReason: null, prompt: null };
      groups.set(key, g);
    }
    g.count += 1;
    if (row.answer === "allow") g.allowed += 1;
    if (row.answer === "deny") g.denied += 1;
    // Still holding its session: not closed and no answer of any kind yet. A
    // group whose every row is open has no answer to show, which 0/0 would hide.
    if (isOpen(row)) g.open += 1;
    if (typeof row.waitedMs === "number") g.waits.push(row.waitedMs);
    if (row.openedAt >= g.lastAt) {
      g.lastAt = row.openedAt;
      if (row.denyReason) g.denyReason = row.denyReason;
      if (ask && row.prompt) g.prompt = row.prompt;
    }
  }
  const top = [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, TOP_MAX)
    .map((g) => {
      const out = {
        kind: g.kind, dialogKind: g.dialogKind, tool: g.tool, head: g.head,
        count: g.count, allowed: g.allowed, denied: g.denied, open: g.open,
        medianWaitMs: median(g.waits), lastAt: g.lastAt, suggestedRule: null,
      };
      const verdict = ruleVerdict(g);
      out.suggestedRule = verdict.rule || null;
      // A Bash head with no safe rule says why: "review it", never a guess.
      if (!out.suggestedRule && verdict.reason) out.noRuleReason = verdict.reason;
      // An ask-in-chat group's subject is its newest question. Nobody answers
      // an ask with allow/deny, so its allowed/denied are null ("can't tell"),
      // never a 0/0 that reads as "asked and ignored".
      if (g.kind === "ask-in-chat") {
        out.prompt = g.prompt;
        out.allowed = null;
        out.denied = null;
      }
      // A classifier block with no rule says WHY it was blocked instead.
      if (g.kind === "classifier-denied" && g.denyReason) out.denyReason = g.denyReason;
      return out;
    });
  const recent = rows
    .sort((a, b) => b.row.openedAt - a.row.openedAt)
    .slice(0, RECENT_MAX)
    .map(({ host, row }) => {
      const out = { host };
      for (const k of ["id", "sessionId", "kind", "dialogKind", "tool", "head", "prompt",
        "denyReason", "answer", "via", "waitedMs", "openedAt", "closedAt",
        "verdict", "judgeReason"]) {
        if (row[k] !== undefined) out[k] = row[k];
      }
      // An ask is answered in prose, never allow/deny: its stored "unknown" is
      // not an answer, and the top table shows "—" for the same group.
      if (row.kind === "ask-in-chat") delete out.answer;
      return out;
    });
  return { days: Math.min(Math.max(1, days || 7), DAYS), top, recent };
}

/** Per-kind counts and summed waits across everything retained (for /metrics). */
function kindTotals() {
  const out = {};
  for (const k of KINDS) out[k] = { count: 0, waitMs: 0 };
  for (const m of hosts.values()) {
    for (const row of m.values()) {
      out[row.kind].count += 1;
      if (typeof row.waitedMs === "number") out[row.kind].waitMs += row.waitedMs;
    }
  }
  return out;
}

// ---- the file backend (non-HA) ---------------------------------------------------

function load() {
  hosts = new Map();
  try {
    const size = fs.statSync(LEDGER_FILE).size;
    if (size > FILE_MAX_BYTES) {
      throw new Error(`permission ledger is ${size} bytes, over the ${FILE_MAX_BYTES} limit — starting empty`);
    }
    const parsed = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8"));
    const raw = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.hosts : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("no `hosts` object");
    const now = Date.now();
    for (const [host, list] of Object.entries(raw)) {
      if (!host || host === "__proto__" || !Array.isArray(list)) continue;
      const m = new Map();
      for (const r of list) {
        const row = sanitizePermissionEvent(r, now);   // the file is re-checked too
        if (row) m.set(row.id, track(row));
      }
      if (m.size) hosts.set(host, m);
    }
    const aged = ageOut(now);
    evict(now);
    if (aged.size) scheduleSave();
  } catch (e) {
    if (!e || e.code !== "ENOENT") {
      hosts = new Map();
      console.error(`permission ledger restore skipped: ${(e && e.message) || e}`);
    }
  }
}

// What the file would weigh, from the row sizes measured once on entry: exact for
// the rows (each counted with its comma), an upper bound for the framing.
function fileBytes() {
  let n = 24;                                        // {"version":1,"hosts":{ … }}
  for (const [host, m] of hosts) {
    n += Buffer.byteLength(JSON.stringify(host), "utf8") + 4;
    for (const row of m.values()) n += bytesOf(row);
  }
  return n;
}

// Never write a file load() would refuse: past FILE_MAX_BYTES (the byte budget
// keeps the model under it; this is the backstop) the oldest rows go first.
function trimToFileCeiling() {
  while (rowCount() && fileBytes() > FILE_MAX_BYTES) {
    const all = [];
    for (const [host, m] of hosts) for (const row of m.values()) all.push({ host, row });
    all.sort((a, b) => a.row.openedAt - b.row.openedAt);
    for (const { host, row } of all.slice(0, Math.max(1, Math.ceil(all.length / 10)))) {
      const m = hosts.get(host);
      m.delete(row.id);
      if (!m.size) hosts.delete(host);
    }
    console.error("permission ledger: file past its ceiling; dropped the oldest tenth before writing");
  }
}

// A save STREAMS the file in chunks of about this many chars rather than building
// it whole: a whole-file string is a second copy of the store on the heap, which
// at the byte budget doubles what the ledger holds (XERK-287 margin).
const SAVE_CHUNK_CHARS = positiveEnv("PERMISSION_LEDGER_SAVE_CHUNK", 256 << 10);

// Writes `snapshot` ([host, rows[]] pairs, references only) to a temp file and
// renames it over the ledger, so a crash mid-save leaves the previous file whole.
async function writeSnapshot(snapshot) {
  await fs.promises.mkdir(path.dirname(LEDGER_FILE), { recursive: true });
  const tmp = `${LEDGER_FILE}.tmp`;
  const fh = await fs.promises.open(tmp, "w");
  try {
    let buf = "{\"version\":1,\"hosts\":{";
    for (let h = 0; h < snapshot.length; h++) {
      const [host, rows] = snapshot[h];
      buf += `${h ? "," : ""}${JSON.stringify(host)}:[`;
      for (let i = 0; i < rows.length; i++) {
        buf += (i ? "," : "") + JSON.stringify(rows[i]);
        if (buf.length >= SAVE_CHUNK_CHARS) { await fh.writeFile(buf, "utf8"); buf = ""; }
      }
      buf += "]";
    }
    await fh.writeFile(`${buf}}}`, "utf8");
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  try {
    await fs.promises.rename(tmp, LEDGER_FILE);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

let saveTimer = null;
// One save at a time (they share the temp file). A save asked for while one is
// in flight runs once after it, and answers every caller that asked meanwhile.
let writing = false;
let writeWaiters = null;
function writeNow(done) {
  if (writing) {
    (writeWaiters || (writeWaiters = [])).push(done);
    return;
  }
  writing = true;
  trimToFileCeiling();
  const snapshot = [];
  for (const [host, m] of hosts) snapshot.push([host, [...m.values()]]);
  let err = null;
  // Never rejects out: a rejection out of a save TIMER would exit the hub.
  writeSnapshot(snapshot).catch((e) => {
    err = e;
    console.error(`permission ledger save failed: ${(e && e.message) || e}`);
  }).then(() => {
    writing = false;
    if (writeWaiters) {
      const cbs = writeWaiters;
      writeWaiters = null;
      writeNow((e) => { for (const cb of cbs) if (cb) cb(e); });
    }
    if (done) done(err);
  });
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref();
}

const fileBackend = {
  onChange() { scheduleSave(); },
  flush(done) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    writeNow(done);
  },
  async close() {},
};
let backend = fileBackend;

// ---- the Postgres backend (HA) ---------------------------------------------------

const T_EVENT = "permission_event";
const PG_QUEUE_MAX = 10000;
const PG_ROWS_PER_INSERT = 500;          // 5 params a row, far under 65535
const PG_RETENTION_SWEEP_MS = 60 * 60 * 1000;

class PermissionLedgerPgStore {
  constructor(pool, cfg = {}) {
    this.pool = pool;
    const { quoteIdent } = require("./pgclient.js");
    this.table = quoteIdent(T_EVENT);
    this._queue = [];
    this._draining = null;
    this._closed = false;
    this._offHealth = null;
    this._readyWork = null;
    this._schemaReady = false;
    this._sweepTimer = null;
    this._onExternalChange = typeof cfg.onExternalChange === "function" ? cfg.onExternalChange : null;
    this._dropped = 0;
  }

  async init() {
    if (typeof this.pool.onHealth === "function") {
      this._offHealth = this.pool.onHealth((h) => { if (h === "ready" && !this._closed) this._onReady(); });
    }
    if (typeof this.pool.ready === "function") {
      this.pool.ready().then(() => this._onReady()).catch((e) => {
        console.error(`permission ledger: Postgres not reachable at boot: ${(e && e.message) || e}`);
      });
    } else if (this.pool.health === "ready") {
      await this._onReady();
    }
    this._sweepTimer = setInterval(() => { this.sweep().catch(() => {}); }, PG_RETENTION_SWEEP_MS);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  _onReady() {
    if (this._closed) return Promise.resolve();
    if (this._readyWork) return this._readyWork;
    this._readyWork = (async () => {
      try {
        await this._ensureSchema();
        // Writes the outage held back land BEFORE the scan reads the table back.
        await this._drain();
        await this.rescan();
      } catch (e) {
        console.error(`permission ledger: Postgres ready-work failed: ${(e && e.message) || e}`);
      } finally {
        this._readyWork = null;
      }
    })();
    return this._readyWork;
  }

  async _ensureSchema() {
    if (this._schemaReady) return;
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         host text NOT NULL,
         id text NOT NULL,
         opened_at bigint NOT NULL,
         progress smallint NOT NULL DEFAULT 0,
         doc text NOT NULL,
         PRIMARY KEY (host, id)
       )`);
    // A table an earlier revision created without the monotone column.
    await this.pool.query(
      `ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS progress smallint NOT NULL DEFAULT 0`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS permission_event_opened_at ON ${this.table} (opened_at)`);
    this._schemaReady = true;
  }

  // Load the retained window into the hot model — boot/reconnect and promotion.
  // NEWEST-WINS, never a blind replace: a write that failed during an outage
  // leaves Postgres holding an OLDER copy of a row (open, where the hot model has
  // it closed), and the agent sends a closed row only once — so a hot copy that
  // is further along (`rowProgress`) is kept, and re-queued so the table catches up.
  // A hot row the table does not hold at all (a write trimmed past PG_QUEUE_MAX in
  // a long outage) is re-queued too — bounded by the hot model and the queue cap.
  async rescan(now = Date.now()) {
    await this._ensureSchema();
    const since = now - DAYS * DAY_MS;
    const stale = [];
    const got = (await this.pool.query(
      `SELECT host, doc FROM ${this.table} WHERE opened_at >= $1 ORDER BY opened_at DESC LIMIT $2`,
      [String(since), String(MAX_ROWS)])) || [];
    const held = new Set();
    let oldest = Infinity;
    for (const r of got) {
      if (!r || typeof r.host !== "string" || !r.host || r.host === "__proto__") continue;
      let doc = null;
      try { doc = JSON.parse(r.doc); } catch { continue; }
      const row = sanitizePermissionEvent(doc, now);
      if (!row) continue;
      held.add(`${r.host}\u0000${row.id}`);
      oldest = Math.min(oldest, row.openedAt);
      let m = hosts.get(r.host);
      if (!m) hosts.set(r.host, (m = new Map()));
      const hot = m.get(row.id);
      if (hot && rowProgress(hot) > rowProgress(row)) {
        stale.push([r.host, hot]);
        continue;
      }
      m.set(row.id, track(row));
    }
    for (const [host, rows] of ageOut(now)) for (const row of rows) stale.push([host, row]);
    evict(now);
    // A LIMIT-truncated read says nothing about rows older than its oldest.
    const floor = got.length >= MAX_ROWS ? oldest : since;
    for (const [host, m] of hosts) {
      for (const row of m.values()) {
        if (row.openedAt >= floor && !held.has(`${host}\u0000${row.id}`)) stale.push([host, row]);
      }
    }
    for (const [host, row] of stale) this._queue.push(this._tuple(host, row));
    this._trimQueue();
    if (stale.length) this._drain();
    if (this._onExternalChange) { try { this._onExternalChange(); } catch { /* never breaks a scan */ } }
  }

  // Off the beat: enqueue only, a serialized background drain writes. Bounded —
  // a Postgres outage drops the OLDEST queued writes, never grows the heap.
  _tuple(host, row) {
    return [host, row.id, String(row.openedAt), String(rowProgress(row)), JSON.stringify(row)];
  }

  // Bounded: past PG_QUEUE_MAX the OLDEST queued writes go. The hot model still
  // holds them, and the next ready-edge rescan re-queues any the table lacks or
  // holds less far along — on THIS replica; one that never held them cannot.
  _trimQueue() {
    const over = this._queue.length - PG_QUEUE_MAX;
    if (over > 0) {
      this._queue.splice(0, over);
      if (!this._dropped) console.error(`permission ledger: Postgres write queue over ${PG_QUEUE_MAX}; dropping oldest`);
      this._dropped += over;
    }
  }

  onChange(host, rows) {
    for (const row of rows) this._queue.push(this._tuple(host, row));
    this._trimQueue();
    this._drain();
  }

  _drain() {
    if (this._draining) return this._draining;
    if (this._closed || !this._queue.length) return Promise.resolve();
    this._draining = (async () => {
      // Yield first: an async body that never awaited would run its `finally`
      // BEFORE `_draining` is assigned, leaving a settled promise there for good
      // and every later drain a silent no-op.
      await null;
      try {
        while (this._queue.length) {
          // One statement may not upsert the same key twice (Postgres refuses
          // "cannot affect row a second time"), and an outage backlog carries a
          // row open AND closed — keep the LAST copy of each (host, id).
          const raw = this._queue.splice(0, PG_ROWS_PER_INSERT);
          const byKey = new Map();
          for (const vals of raw) byKey.set(`${vals[0]}\u0000${vals[1]}`, vals);
          const batch = [...byKey.values()];
          const params = [];
          const tuples = batch.map((vals) => `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(", ")})`);
          try {
            await this._ensureSchema();
            await this.pool.query(
              // MONOTONE: a late retry of an OPEN copy (an old leader's ready
              // edge after a handover) never reverts a CLOSED row another
              // replica already wrote. Equal progress → the newer write wins.
              `INSERT INTO ${this.table} (host, id, opened_at, progress, doc) VALUES ${tuples.join(", ")} ` +
              `ON CONFLICT (host, id) DO UPDATE SET opened_at = EXCLUDED.opened_at, ` +
              `progress = EXCLUDED.progress, doc = EXCLUDED.doc ` +
              `WHERE EXCLUDED.progress >= ${this.table}.progress`,
              params);
          } catch (e) {
            // Put the batch BACK (ahead of anything newer) and stop: the pool's
            // next ready edge — or the next beat's write — retries it. Dropping
            // it lost a closed row for good once a rescan read the stale copy.
            this._queue.unshift(...batch);
            this._trimQueue();
            console.error(`permission ledger: Postgres write failed (${(e && e.message) || e}); ${batch.length} row(s) held for retry`);
            break;
          }
        }
      } finally {
        this._draining = null;
      }
    })();
    return this._draining;
  }

  async sweep(now = Date.now()) {
    if (this._closed) return;
    await this._ensureSchema();
    await this.pool.query(`DELETE FROM ${this.table} WHERE opened_at < $1`,
      [String(now - DAYS * DAY_MS)]);
  }

  flush(done) {
    Promise.resolve(this._drain()).then(() => done && done(null), (e) => done && done(e));
  }

  async close() {
    this._closed = true;
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    if (this._offHealth) { try { this._offHealth(); } catch { /* best effort */ } this._offHealth = null; }
  }
}

/**
 * Pick the backend (server.js, once at boot, fire-and-forget). HA off: the file
 * backend loaded at require time stays. HA on: the Postgres append table, sharing
 * the hub's one pool; no pool under HA stays on the file and says so (degraded).
 */
async function configure(haConfig, pgClient, onExternalChange) {
  if (!haConfig || !haConfig.ha) return;
  if (!pgClient) {
    console.error("permission ledger: HA is on but no Postgres client was provided — staying on the local file (DEGRADED)");
    return;
  }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const b = new PermissionLedgerPgStore(pgClient, { onExternalChange });
  backend = b;
  await b.init();
  console.log("permission ledger: using Postgres (permission_event) for the durable rows");
}

// Re-load from the of-record on LEADER PROMOTION; a no-op on the file backend.
function rehydrate() {
  return backend.rescan ? backend.rescan() : Promise.resolve();
}

function flush(done) { backend.flush(done); }

load();

module.exports = {
  ingest, aggregate, kindTotals, sanitizePermissionEvent, suggestedRule, ruleVerdict, configure,
  rehydrate, flush, setMemoryLimit,
  LEDGER_FILE, MAX_ROWS, HOST_MAX_ROWS, DAYS, EVENTS_PER_BEAT, T_EVENT, OPEN_MAX_MS,
  SUBCOMMAND_CLIS, BASH_SAFE_HEADS, BASH_SAFE_SUBCOMMANDS, PermissionLedgerPgStore,
  _internals: {
    hosts: () => hosts,
    rowCount, load, writeNow, totalBytes, maxBytes: () => maxBytes,
    reset() {
      hosts = new Map();
      rowBytes = new WeakMap();
      setMemoryLimit(null);
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (backend !== fileBackend) { try { backend.close(); } catch { /* noop */ } }
      backend = fileBackend;
    },
    getBackend: () => backend,
    setBackend(b) { backend = b; },
  },
};
