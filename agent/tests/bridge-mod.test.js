// The Claude bridge mod (agent/mods/turma-bridge, XERK-2131) is a TypeScript
// hooks module nothing else in CI parses: a syntax error would ship silently,
// switch the turn signal off fleet-wide and put a load-error line in every
// session's pane. This strips its types the way Node does, parses the result
// and loads it as an ES module, and pins the contract hub-agent.py launches it with.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const { stripTypeScriptTypes } = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");

const MOD = path.join(__dirname, "..", "mods", "turma-bridge");

test("the bridge mod's manifest and hooks file are what the engine loads", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "turma-bridge");
  const hooks = JSON.parse(fs.readFileSync(path.join(MOD, "hooks", "hooks.json"), "utf8"));
  assert.deepEqual(hooks, { modules: ["./register.ts"] });
});

test("the bridge mod's hooks module parses and loads as an ES module", async () => {
  const src = fs.readFileSync(path.join(MOD, "hooks", "register.ts"), "utf8");
  const js = stripTypeScriptTypes(src); // throws ERR_INVALID_TYPESCRIPT_SYNTAX
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mod-"));
  try {
    const out = path.join(dir, "register.mjs");
    fs.writeFileSync(out, js);
    const r = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // Loading it too: a bad import or a top-level throw parses fine yet keeps
    // Claude from loading the mod. register.ts imports types only, which the
    // strip removes, so it needs no stub of the engine.
    const mod = await import(pathToFileURL(out).href);
    assert.equal(typeof mod.register, "function");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // A module holding import() does not load at all.
  assert.doesNotMatch(src, /\bimport\s*\(/);
  assert.match(src, /export const register\b/);
});

test("the mod reads the env vars hub-agent.py exports", () => {
  const src = fs.readFileSync(path.join(MOD, "hooks", "register.ts"), "utf8");
  const agent = fs.readFileSync(path.join(__dirname, "..", "hub-agent.py"), "utf8");
  assert.match(src, /\$\.env\.get\('TURMA_TURN_STATE'\)/);
  assert.match(agent, /TURMA_TURN_STATE=\{shlex\.quote\(turn_state\)\}/);
  assert.match(agent, /extra_env\["TURMA_TURN_STATE"\] = turn_state/);
  assert.match(src, /\$\.env\.get\('TURMA_MOD_REQUESTS'\)/);
  assert.match(agent, /TURMA_MOD_REQUESTS=\{shlex\.quote\(mod_request_dir/);
  assert.match(agent, /extra_env\["TURMA_MOD_REQUESTS"\] = mod_request_dir/);
});

test("the mod runs /rename only, never a command a request names", () => {
  const src = fs.readFileSync(path.join(MOD, "hooks", "register.ts"), "utf8");
  const runs = [...src.matchAll(/\$\.command\.run\(\{\s*command:\s*([^,}]+)/g)].map(m => m[1].trim());
  assert.deepEqual(runs, ["'rename'"]);
});

// Load the real module (types stripped) and drive it against a fake engine:
// the events Claude Code would raise, and every `$` call the module makes.
async function loadMod() {
  const src = fs.readFileSync(path.join(MOD, "hooks", "register.ts"), "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-mod-run-"));
  const out = path.join(dir, "register.mjs");
  fs.writeFileSync(out, stripTypeScriptTypes(src));
  const mod = await import(pathToFileURL(out).href);
  fs.rmSync(dir, { recursive: true, force: true });
  return mod;
}

async function harness({ runRejects } = {}) {
  const { register } = await loadMod();
  const files = new Map();
  const runs = [];
  const timers = [];
  const hooks = {};
  const $ = {
    env: { get: async name => ({ TURMA_TURN_STATE: "/s/turn.json", TURMA_MOD_REQUESTS: "/r" })[name] },
    session: { id: async () => "conv-1" },
    fs: {
      read: async p => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
      write: async (p, t) => { files.set(p, t); },
    },
    clock: { every: (ms, fn) => { timers.push(fn); return () => {}; } },
    command: {
      run: async e => {
        runs.push(e);
        const why = runRejects && runRejects.shift();
        if (why) throw new Error(why);
        return { text: "" };
      },
    },
  };
  register((name, hook) => { hooks[name] = hook; }, {});
  const settle = () => new Promise(r => setTimeout(r, 5));
  const h = {
    files, runs,
    async event(name, e) { await hooks[name]($, e, async x => x); await settle(); },
    hooks, $,
    async tick() { for (const fn of timers) fn(); await settle(); await settle(); },
    turn() { return JSON.parse(files.get("/s/turn.json")).turn; },
    ask(name, at) { files.set("/r/rename.json", JSON.stringify({ v: 1, name, at })); },
    done() { return files.has("/r/rename.done.json") ? JSON.parse(files.get("/r/rename.done.json")) : null; },
  };
  await h.event("session.start", { cwd: "/", surface: "terminal", isInteractive: true });
  return h;
}

test("the turn state follows the main loop only", async () => {
  const h = await harness();
  assert.equal(h.turn(), "idle");
  await h.event("turn.start", { text: "go", turnId: "t1" });
  assert.equal(h.turn(), "running");
  // A subagent's turns never move it.
  await h.event("turn.start", { text: "", turnId: "a1", agentId: "sub" });
  await h.event("turn.complete", { turnId: "a1", agentId: "sub", isAborted: false, reason: "answer" });
  assert.equal(h.turn(), "running");
  await h.event("turn.complete", { turnId: "t1", isAborted: false, reason: "answer" });
  assert.equal(h.turn(), "idle");
  // A background agent working after the main turn ended leaves it idle.
  await h.event("turn.start", { text: "", turnId: "a2", agentId: "bg" });
  assert.equal(h.turn(), "idle");
});

test("a rename runs only while the main turn is idle", async () => {
  const h = await harness();
  await h.event("turn.start", { text: "go", turnId: "t1" });
  h.ask("New name", 10);
  await h.tick();
  assert.deepEqual(h.runs, [], "mid-turn it would wait in Claude Code's queue");
  await h.event("turn.complete", { turnId: "t1", isAborted: false, reason: "answer" });
  await h.tick();
  assert.deepEqual(h.runs.map(r => [r.command, r.args]), [["rename", "New name"]]);
  assert.deepEqual(h.done(), { v: 1, at: 10, name: "New name", ok: true });
  await h.tick();
  assert.equal(h.runs.length, 1, "one run per request");
});

test("after an interrupted turn it waits for the person's next turn", async () => {
  const h = await harness();
  await h.event("turn.start", { text: "go", turnId: "t1" });
  await h.event("turn.complete", { turnId: "t1", isAborted: true, reason: "aborted" });
  h.ask("After esc", 20);
  await h.tick();
  assert.deepEqual(h.runs, []);
  assert.equal(h.done(), null, "no answer: the agent must not spend an attempt");
  await h.event("turn.start", { text: "next", turnId: "t2" });
  await h.event("turn.complete", { turnId: "t2", isAborted: false, reason: "answer" });
  await h.tick();
  assert.equal(h.done().ok, true);
});

test("a 'stopped' refusal is not an answer; the next turn retries it", async () => {
  const h = await harness({
    runRejects: ["HooksError: the session was stopped and nobody has sent input since"],
  });
  h.ask("Retry me", 30);
  await h.tick();
  assert.equal(h.done(), null);
  await h.tick();
  assert.equal(h.runs.length, 1, "it waits; it does not hammer the refusal");
  await h.event("turn.start", { text: "hi", turnId: "t3" });
  await h.event("turn.complete", { turnId: "t3", isAborted: false, reason: "answer" });
  await h.tick();
  assert.equal(h.done().ok, true);
  assert.equal(h.runs.length, 2);
});

test("an unclean or oversized name is refused, never rewritten", async () => {
  for (const [name, at] of [["bad\nname", 41], [" padded", 42], ["x".repeat(201), 43], ["", 44],
                            ["bell\u0007", 45], ["\ufeffbom", 46], ["c1\u009bcsi", 48],
                            ["zero\u200bwidth", 49], ["line\u2028sep", 50]]) {
    const h = await harness();
    h.ask(name, at);
    await h.tick();
    assert.deepEqual(h.runs, [], JSON.stringify(name));
    assert.equal(h.done().ok, false);
  }
  const h = await harness();
  h.ask("x".repeat(200), 47);
  await h.tick();
  assert.equal(h.done().ok, true);
});

test("a turn that starts while the request is being read stops the run", async () => {
  // The idle check before the reads is not enough on its own: the reads await,
  // and a prompt submitted meanwhile would queue the command (QA).
  const h = await harness();
  h.ask("Racy", 60);
  const read = h.$.fs.read;
  let fired = false;
  h.$.fs.read = async p => {
    if (!fired && p.endsWith("rename.json")) {
      fired = true;
      await h.hooks["turn.start"](h.$, { text: "typed", turnId: "t9" }, async x => x);
    }
    return read(p);
  };
  await h.tick();
  assert.deepEqual(h.runs, []);
  assert.equal(h.done(), null);
});
