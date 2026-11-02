"use strict";

// XERK-2631 — the admin panel's user card. The audit log names an SSO user by
// `oidc:<id>` (its display name is the user's to edit), so the card must show
// that id, and nothing else on another card may read as it.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const tenancy = require("../tenancy.js");

// The page's own userHtml, run in a sandbox: its source sits between the
// `const esc` line and addUserHtml.
function loadUserHtml() {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "admin.html"), "utf8");
  const start = html.indexOf("const esc =");
  const end = html.indexOf("function addUserHtml");
  assert.ok(start > 0 && end > start, "admin.html still defines esc … userHtml in order");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ctx = { TurmaNav: { esc }, Map, Date, out: null };
  vm.createContext(ctx);
  vm.runInContext(`${html.slice(start, end)}\nout = userHtml;`, ctx);
  return ctx.out;
}
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const card = (over) => ({ name: "x", displayName: "x", roles: ["user"], groups: [], disabled: false,
  createdAt: 1, hosts: 0, idpRoles: ["user"], ...over });

test("XERK-2631: an SSO card shows the id its audit rows lead with; a spoofed name cannot", () => {
  const userHtml = loadUserHtml();
  const victimId = "a".repeat(32), attackerId = "b".repeat(32);
  // What the hub stores when an SSO user names itself after the victim's label.
  const { user } = tenancy.upsertOidcUser({ users: Object.create(null), groups: {} },
    { iss: "https://idp/", sub: "s-1", displayName: `oidc:${victimId} (Victim)`, idpRoles: ["user"] });
  const attacker = text(userHtml(card({ id: attackerId, source: "oidc", name: user.displayName, displayName: user.displayName })));
  const victim = text(userHtml(card({ id: victimId, source: "oidc", name: "Victim", displayName: "Victim" })));
  assert.ok(victim.includes(`In the audit log: oidc:${victimId}`), victim);
  assert.ok(attacker.includes(`In the audit log: oidc:${attackerId}`), attacker);
  assert.ok(!attacker.includes(`oidc:${victimId}`), `only the victim's card reads as its label: ${attacker}`);
  // Variants a browser's find-in-page folds to the same label are caught too.
  const fresh = () => ({ users: Object.create(null), groups: {} });
  for (const spoof of [`OIDC:${victimId.toUpperCase()}`, `oidc\uFF1A${victimId}`, `oidc:\u00AD${victimId}`,
    `oidc:\u200B${victimId}`, `oidc:\uFEFF${victimId}`, `oidc:\u0301${victimId}`, `oidc\uFE55${victimId}`,
    `oidc:${"\uFF41".repeat(32)}`]) {
    const stored = tenancy.upsertOidcUser(fresh(), { iss: "https://idp/", sub: "s-v", displayName: spoof, idpRoles: ["user"] }).user.displayName;
    const folded = stored.normalize("NFKD").replace(/[\p{Default_Ignorable_Code_Point}\p{M}]/gu, "").normalize("NFKC").toLowerCase();
    assert.ok(!/oidc:[0-9a-f]{32}/.test(folded), `${JSON.stringify(spoof)} stored as ${JSON.stringify(stored)}`);
  }
  // An ordinary name is kept exactly.
  const plain = tenancy.upsertOidcUser(fresh(), { iss: "https://idp/", sub: "s-p", displayName: "Résumé Ünïcode 😀", idpRoles: ["user"] }).user;
  assert.equal(plain.displayName, "Résumé Ünïcode 😀");
  const local = text(userHtml(card({ id: "c".repeat(32), source: "local", name: "rootadmin", username: "rootadmin" })));
  assert.ok(!local.includes("In the audit log"), "a local card is named by its username");
});
