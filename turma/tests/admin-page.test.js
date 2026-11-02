"use strict";

// XERK-2631 — the admin panel's user cards and audit log. The audit log names an
// SSO user by `oidc:<id>` (its display name is the user's to edit), so the card
// shows that id and the audit row links it to the card BY ID: a display name can
// be made to read as any label, even to a browser's find-in-page.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert/strict");

// The page's own render functions, run in a sandbox: everything from the
// `const esc` line up to render().
function loadPage() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
  const start = html.indexOf("const esc =");
  const end = html.indexOf("function render()");
  assert.ok(start > 0 && end > start, "admin.html still defines esc … auditHtml before render()");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ctx = { TurmaNav: { esc }, Map, Set, Date, out: null };
  vm.createContext(ctx);
  vm.runInContext(`${html.slice(start, end)}
out = { userHtml, auditHtml, set(u, a) { users = u; audit = a; you = null; } };`, ctx);
  return ctx.out;
}
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const card = (over) => ({ name: "x", displayName: "x", roles: ["user"], groups: [], disabled: false,
  createdAt: 1, hosts: 0, idpRoles: ["user"], ...over });

test("XERK-2631: an SSO card shows its audit id; the audit row links to the card by id, whatever the name says", () => {
  const page = loadPage();
  const victimId = "a".repeat(32), attackerId = "b".repeat(32);
  const spoof = `oidc:${victimId} (Victim)`;
  const attacker = card({ id: attackerId, source: "oidc", name: spoof, displayName: spoof });
  const victim = card({ id: victimId, source: "oidc", name: "Victim", displayName: "Victim" });
  const local = card({ id: "c".repeat(32), source: "local", name: "rootadmin", username: "rootadmin" });

  const vCard = page.userHtml(victim), aCard = page.userHtml(attacker);
  assert.ok(text(vCard).includes(`In the audit log: oidc:${victimId}`), vCard);
  assert.ok(text(aCard).includes(`In the audit log: oidc:${attackerId}`), aCard);
  assert.match(vCard, new RegExp(`^<div class="ad-user" id="user-${victimId}">`));
  assert.ok(!text(page.userHtml(local)).includes("In the audit log"), "a local card is named by its username");

  page.set([attacker, victim, local], [{ at: 1, action: "user.update",
    actor: `oidc:${attackerId} (${spoof})`, target: `oidc:${victimId} (Victim)` }]);
  const row = page.auditHtml();
  const links = [...row.matchAll(/<a href="#user-([0-9a-f]{32})">/g)].map((m) => m[1]);
  assert.deepEqual(links, [attackerId, victimId], `the actor links to the attacker's card, the target to the victim's: ${row}`);
  assert.ok(row.includes(`(oidc:${victimId} (Victim))`), "the spoofed name is shown as plain text, never a link");

  // A row for a user no longer listed (deleted) links nowhere.
  page.set([local], [{ at: 1, action: "user.delete", actor: "rootadmin (local)", target: `oidc:${victimId} (Victim)` }]);
  assert.ok(!page.auditHtml().includes("<a "), "no link to a card that is not there");
});
