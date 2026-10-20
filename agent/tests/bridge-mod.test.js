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
