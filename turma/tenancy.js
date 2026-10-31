"use strict";

// Hub users and tenants (XERK-2530, epic XERK-2529). One user = one tenant.
//
// This module is the PURE half: the record shape and its whitelist, password
// hashing, the local group -> role mapping, and the lookups/mutations the hub's
// store wiring (server.js, `tenancy` external store) and the future admin panel
// call. It holds no state of its own — every function takes the store value
// `{users, groups}` — so it is unit-testable without booting a hub.
//
// Decisions and the isolation guarantee: docs/multi-tenant-adr.md. Operative
// invariants: .claude/rules/turma-tenancy.md.

const crypto = require("crypto");

const ROLES = ["user", "admin"];
// Shipped defaults so an org without Authentik can manage membership by hand.
// Stored once the operator edits them; until then these are what apply.
const DEFAULT_GROUPS = Object.freeze({
  "turma-users": Object.freeze({ role: "user" }),
  "turma-admins": Object.freeze({ role: "admin" }),
});

// Bounds (inline literals in the coerce too, which runs at hub module init).
const USERS_MAX = 1000;
const GROUPS_MAX = 100;
const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const GROUP_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const DISPLAY_MAX = 100;
const PASSWORD_MAX = 1024; // bytes fed to scrypt are bounded before hashing
const PASSWORD_MIN = 8;
const SUB_MAX = 255;
const ISS_MAX = 500;

// scrypt, stdlib only. N=2^14, r=8 costs 16 MiB per call (128*N*r): the hub
// runs at 512m with a ~68 MiB co-peak margin (turma-limits.md), so the hub caps
// concurrent verifications (server.js LOGIN_SCRYPT_INFLIGHT_MAX) rather than
// raising N. Parameters ride the hash, so a later retune still verifies old ones.
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function newId() {
  return crypto.randomBytes(16).toString("hex");
}

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

function hashFormat(salt, key, { N, r, p }) {
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// `scrypt$N$r$p$<salt b64>$<key b64>` — never the plaintext.
async function hashPassword(password) {
  if (typeof password !== "string" || !password) throw new Error("password required");
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return hashFormat(salt, key, SCRYPT);
}

// Boot-only (the bootstrap admin, once): a synchronous variant, never on a request.
function hashPasswordSync(password) {
  if (typeof password !== "string" || !password) throw new Error("password required");
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = crypto.scryptSync(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return hashFormat(salt, key, SCRYPT);
}

function parseHash(stored) {
  if (typeof stored !== "string") return null;
  const m = /^scrypt\$(\d{1,7})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9+/=]{4,64})\$([A-Za-z0-9+/=]{4,128})$/.exec(stored);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Refuse parameters that would cost more than the configured ceiling (a
  // hand-edited store must not turn one login into an OOM).
  if (N < 2 || (N & (N - 1)) !== 0 || 128 * N * r > SCRYPT_MAXMEM || p < 1 || p > 4) return null;
  const salt = Buffer.from(m[4], "base64");
  const key = Buffer.from(m[5], "base64");
  if (salt.length < 8 || key.length < 16) return null;
  return { N, r, p, salt, key };
}

// A placeholder hash verified against when the username is unknown, so an
// unknown user costs the same scrypt as a known one (no timing oracle).
let dummyHash = null;
function dummyPasswordHash() {
  if (!dummyHash) dummyHash = hashPasswordSync(crypto.randomBytes(24).toString("base64"));
  return dummyHash;
}

async function verifyPassword(password, stored) {
  const h = parseHash(stored);
  if (!h || typeof password !== "string" || Buffer.byteLength(password) > PASSWORD_MAX) return false;
  const got = await scryptAsync(password, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: SCRYPT_MAXMEM });
  return crypto.timingSafeEqual(got, h.key);
}

function validPassword(pw) {
  return typeof pw === "string" && pw.length >= PASSWORD_MIN && Buffer.byteLength(pw) <= PASSWORD_MAX;
}

function cleanText(s, max) {
  if (typeof s !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, max);
}

const finiteMs = (n) => (Number.isSafeInteger(n) && n > 0 ? n : undefined);

// One user record, field by field. Anything malformed drops the record (an id,
// tenantId or source it cannot vouch for) or the field (everything else).
function coerceUser(id, u) {
  if (!ID_RE.test(id) || !u || typeof u !== "object" || Array.isArray(u)) return null;
  if (!ID_RE.test(u.tenantId) || u.tenantId === id) return null;
  if (u.source !== "local" && u.source !== "oidc") return null;
  const out = { id, tenantId: u.tenantId, source: u.source };
  out.displayName = cleanText(u.displayName, DISPLAY_MAX) || "user";
  if (u.source === "local") {
    if (typeof u.username !== "string" || !USERNAME_RE.test(u.username)) return null;
    out.username = u.username;
    if (parseHash(u.passwordHash)) out.passwordHash = u.passwordHash;
  } else {
    if (typeof u.oidcSub !== "string" || !u.oidcSub || u.oidcSub.length > SUB_MAX) return null;
    if (typeof u.oidcIss !== "string" || !u.oidcIss || u.oidcIss.length > ISS_MAX) return null;
    out.oidcIss = u.oidcIss;
    out.oidcSub = u.oidcSub;
    const idp = Array.isArray(u.idpRoles) ? [...new Set(u.idpRoles.filter((r) => ROLES.includes(r)))] : [];
    out.idpRoles = idp;
  }
  out.groups = Array.isArray(u.groups)
    ? [...new Set(u.groups.filter((g) => typeof g === "string" && GROUP_RE.test(g)))].slice(0, 20)
    : [];
  out.disabled = u.disabled === true;
  // "idp": the IdP's groups stopped granting any role (XERK-2532). Only that
  // kind of disable lifts itself when the groups grant a role again; an
  // operator's disable (no `disabledBy`) never does.
  if (out.disabled && u.source === "oidc" && u.disabledBy === "idp") out.disabledBy = "idp";
  out.createdAt = finiteMs(u.createdAt) || 0;
  const last = finiteMs(u.lastLoginAt);
  if (last) out.lastLoginAt = last;
  return out;
}

// The whole store: `{users: {id: record}, groups: {name: {role}}}`, null-prototype
// maps (an id or group named `__proto__` must not reach Object.prototype). A
// coerce fixed point, so an HA watch echo of our own write dedups.
function coerceTenancy(raw) {
  const users = Object.create(null);
  const groups = Object.create(null);
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ru = src.users && typeof src.users === "object" && !Array.isArray(src.users) ? src.users : {};
  const seenName = new Set();
  const seenSub = new Set();
  const seenTenant = new Set();
  let n = 0;
  for (const [id, u] of Object.entries(ru)) {
    if (n >= 1000) break;
    const c = coerceUser(id, u);
    if (!c) continue;
    // Uniqueness is part of the shape: two records claiming one login or one
    // tenant would make the principal ambiguous, so the later one is dropped.
    if (seenTenant.has(c.tenantId)) continue;
    const loginKey = c.source === "local" ? `l:${c.username.toLowerCase()}` : `o:${c.oidcIss}\n${c.oidcSub}`;
    if (c.source === "local" ? seenName.has(loginKey) : seenSub.has(loginKey)) continue;
    (c.source === "local" ? seenName : seenSub).add(loginKey);
    seenTenant.add(c.tenantId);
    users[id] = c;
    n++;
  }
  const rg = src.groups && typeof src.groups === "object" && !Array.isArray(src.groups) ? src.groups : null;
  if (rg) {
    let g = 0;
    for (const [name, v] of Object.entries(rg)) {
      if (g >= 100) break;
      if (!GROUP_RE.test(name) || !v || !ROLES.includes(v.role)) continue;
      groups[name] = { role: v.role };
      g++;
    }
    return { users, groups };
  }
  // No stored map: omit the key (not `{}`), so a re-coerce still reads "unset"
  // and the defaults keep applying — the coerce must be a fixed point.
  return { users };
}

// The group map in force: the stored one once an operator has set it, else the
// shipped defaults.
function groupMap(state) {
  return state && state.groups ? state.groups : DEFAULT_GROUPS;
}

// Roles in force for a user, ordered as ROLES. Local: its groups mapped through
// the group map. OIDC: the IdP's roles from its last login, plus any local group
// the operator added it to.
function effectiveRoles(state, user) {
  if (!user) return [];
  const map = groupMap(state);
  const out = new Set(user.source === "oidc" ? user.idpRoles || [] : []);
  for (const g of user.groups || []) {
    const e = Object.hasOwn(map, g) ? map[g] : null;
    if (e && ROLES.includes(e.role)) out.add(e.role);
  }
  return ROLES.filter((r) => out.has(r));
}

function findLocalUser(state, username) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) return null;
  const want = username.toLowerCase();
  for (const u of Object.values(state.users)) {
    if (u.source === "local" && u.username.toLowerCase() === want) return u;
  }
  return null;
}

function findOidcUser(state, iss, sub) {
  for (const u of Object.values(state.users)) {
    if (u.source === "oidc" && u.oidcIss === iss && u.oidcSub === sub) return u;
  }
  return null;
}

function freshTenantId(state) {
  const used = new Set(Object.values(state.users).map((u) => u.tenantId));
  let t;
  do t = newId(); while (used.has(t) || Object.hasOwn(state.users, t));
  return t;
}

function freshUserId(state) {
  let id;
  do id = newId(); while (Object.hasOwn(state.users, id));
  return id;
}

// Mutations return a NEW store value (the caller installs + persists it); they
// throw an Error whose message is operator-facing on a refusal.
function addUser(state, rec) {
  if (Object.keys(state.users).length >= USERS_MAX) throw new Error("the user store is full");
  const id = freshUserId(state);
  const tenantId = freshTenantId(state);
  const user = coerceUser(id, { ...rec, tenantId, createdAt: rec.createdAt || Date.now() });
  if (!user) throw new Error("invalid user record");
  const users = Object.assign(Object.create(null), state.users, { [id]: user });
  return { state: { ...state, users }, user };
}

// `passwordHash` comes from hashPassword(); this never sees the plaintext.
function createLocalUser(state, { username, displayName, passwordHash, groups = ["turma-users"], now = Date.now() }) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) throw new Error("invalid username");
  if (findLocalUser(state, username)) throw new Error("username already taken");
  if (!parseHash(passwordHash)) throw new Error("invalid password hash");
  return addUser(state, { source: "local", username, displayName: displayName || username, passwordHash, groups, createdAt: now });
}

// The OIDC callback's upsert: the (issuer, sub) pair is the identity — never the
// display name or email, which the IdP lets a user change. `idpRoles` are what
// the groups claim grants this login (XERK-2532: user group -> "user", admin
// group -> "admin", independently).
// - A first login mints the user and its tenant, but only when the groups grant
//   a role: an identity the IdP admits nowhere is never provisioned (user: null).
// - A later login refreshes the IdP roles + display name. One left with no role
//   at all (removed from every group, no local group either) is marked disabled
//   by the IdP; its record and tenant stay until an admin deletes the user. A
//   later login that grants a role again lifts that disable — never an
//   operator's.
function upsertOidcUser(state, { iss, sub, displayName, idpRoles, now = Date.now() }) {
  if (typeof iss !== "string" || !iss || iss.length > ISS_MAX) throw new Error("invalid issuer");
  if (typeof sub !== "string" || !sub || sub.length > SUB_MAX) throw new Error("invalid subject");
  const roles = Array.isArray(idpRoles) ? idpRoles.filter((r) => ROLES.includes(r)) : [];
  const existing = findOidcUser(state, iss, sub);
  if (!existing) {
    if (!roles.length) return { state, user: null };
    return addUser(state, { source: "oidc", oidcIss: iss, oidcSub: sub, displayName, idpRoles: roles, groups: [], createdAt: now });
  }
  const next = {
    ...existing,
    displayName: cleanText(displayName, DISPLAY_MAX) || existing.displayName,
    idpRoles: roles,
  };
  const granted = effectiveRoles(state, next).length > 0;
  if (!granted && !existing.disabled) Object.assign(next, { disabled: true, disabledBy: "idp" });
  else if (granted && existing.disabled && existing.disabledBy === "idp") {
    next.disabled = false;
    delete next.disabledBy;
  }
  const user = coerceUser(existing.id, next);
  const users = Object.assign(Object.create(null), state.users, { [user.id]: user });
  return { state: { ...state, users }, user };
}

function updateUser(state, id, patch) {
  const cur = Object.hasOwn(state.users, id) ? state.users[id] : null;
  if (!cur) throw new Error("no such user");
  // Identity fields never move: a tenant is the user's for life.
  const merged = { ...cur, ...patch, id, tenantId: cur.tenantId, source: cur.source };
  // An operator setting `disabled` owns it from then on: an IdP disable it
  // re-states becomes the operator's, so a later login cannot lift it.
  if (Object.hasOwn(patch, "disabled") && !Object.hasOwn(patch, "disabledBy")) delete merged.disabledBy;
  const next = coerceUser(id, merged);
  if (!next) throw new Error("invalid user record");
  const users = Object.assign(Object.create(null), state.users, { [id]: next });
  return { state: { ...state, users }, user: next };
}

// First run: no LOCAL account yet and the bootstrap pair set -> one local admin.
// OIDC users do not count: a passwordless OIDC hub that an operator closes with
// the bootstrap pair must still get its admin, or it admits nobody. Returns null
// when there is nothing to do.
function bootstrapAdmin(state, { username, password, now = Date.now() }) {
  if (!username || !password) return null;
  if (Object.values(state.users).some((u) => u.source === "local")) return null;
  if (!USERNAME_RE.test(username)) throw new Error("TURMA_BOOTSTRAP_ADMIN_USER is not a valid username");
  if (!validPassword(password)) throw new Error(`TURMA_BOOTSTRAP_ADMIN_PASSWORD must be ${PASSWORD_MIN}+ characters`);
  return createLocalUser(state, {
    username, displayName: username, passwordHash: hashPasswordSync(password),
    groups: ["turma-users", "turma-admins"], now,
  });
}

module.exports = {
  ROLES,
  DEFAULT_GROUPS,
  SCRYPT,
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_RE,
  ID_RE,
  newId,
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  dummyPasswordHash,
  validPassword,
  coerceTenancy,
  groupMap,
  effectiveRoles,
  findLocalUser,
  findOidcUser,
  createLocalUser,
  upsertOidcUser,
  updateUser,
  bootstrapAdmin,
};
