// Publish a packed .ehpk build to the Even Hub developer portal — the upload
// half of the dev loop the portal UI does by hand. Two portal API calls:
//
//   1. POST /api/v1/versions/draft?package_id=<pkg>   multipart, field `ehpk` -> draft_id
//   2. POST /api/v1/versions/create?package_id=<pkg>  multipart {draft_id, changelog} -> version
//
// BOTH calls are multipart/form-data — create too, exactly as the portal
// frontend sends it (its bundle appends draft_id/changelog to a FormData);
// a JSON body gets rejected with code 1001 "parameter parsing error".
//
// Auth mirrors @evenrealities/evenhub-cli exactly: the portal wants an
// `X-Even-Authorization: <access_token>` header, where the token is the JWT the
// CLI's `evenhub login` stores in <config>/evenhub/credentials.yaml
// (XDG_CONFIG_HOME or ~/.config). Access tokens are short-lived (~10 min), so
// this script checks the JWT `exp` and refreshes via /api/v1/auth/refresh —
// persisting the new credential set back, same as the CLI — before uploading.
// For CI (no interactive login), EVENHUB_EMAIL + EVENHUB_PASSWORD log in
// directly; the portal expects the password XOR-obfuscated with the email and
// base64-encoded (that is what the CLI sends — it is obfuscation, not
// security; the real secrecy is TLS).
//
//   node scripts/evenhub-publish.mjs --next-version 0.1.2 --changelog 'Private build 0.1.2'
//
// Defaults fit this repo (project dir = glasses/, artifact = ../turma.ehpk at
// the repo root, build = `npm run pack`), overridable to match any Even Hub app:
//
//   --project-dir <dir>     dir holding app.json (default: script's parent)
//   --artifact <path>       .ehpk to upload, relative to project dir (default: ../turma.ehpk)
//   --build-command <cmd>   shell command run in project dir (default: npm run pack)
//   --package-id <id>       portal package id (default: app.json's package_id)
//   --next-version <x.y.z>  rewrite app.json's version before building
//   --changelog <text>      required unless --dry-run
//   --skip-build            upload an already-built artifact as-is
//   --dry-run               resolve config + build, but skip auth and both uploads
//
// Env: EVENHUB_BASE_URL (default https://hub.evenrealities.com), EVENHUB_TOKEN
// (raw access token — skips credentials.yaml entirely), EVENHUB_EMAIL/EVENHUB_PASSWORD.
//
// Promotion of the uploaded build remains a manual step in the portal.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_URL = "https://hub.evenrealities.com";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * The portal's password obfuscation, byte-for-byte what evenhub-cli sends to
 * /api/v1/auth/login: XOR the UTF-8 password bytes with the UTF-8 email bytes
 * (email repeating), then base64.
 */
export function obfuscatePassword(email, password) {
  const key = new TextEncoder().encode(email);
  const pwd = new TextEncoder().encode(password);
  const out = new Uint8Array(pwd.length);
  for (let i = 0; i < pwd.length; i++) out[i] = pwd[i] ^ key[i % key.length];
  return Buffer.from(out).toString("base64");
}

/**
 * Whether a JWT's `exp` is in the past (with a safety margin so a token that
 * dies mid-upload counts as expired). Returns true for anything unparseable —
 * an unreadable token is as good as an expired one.
 */
export function isJwtExpired(token, nowSeconds, marginSeconds = 30) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    if (typeof payload.exp !== "number") return true;
    return payload.exp < nowSeconds + marginSeconds;
  } catch {
    return true;
  }
}

/**
 * Minimal flat YAML for credentials.yaml (string/number scalars only — the
 * shape evenhub-cli writes). Avoids an undeclared js-yaml dependency.
 */
export function parseFlatYaml(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

export function dumpFlatYaml(obj) {
  return (
    Object.entries(obj)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n") + "\n"
  );
}

/**
 * The portal responds in the CLI's envelope: {code, message, data} with code 0
 * on success. Throws a readable error otherwise.
 */
export function unwrapEnvelope(json, what) {
  if (!json || typeof json !== "object" || typeof json.code !== "number") {
    throw new Error(`${what}: unexpected response shape: ${JSON.stringify(json)}`);
  }
  if (json.code !== 0) {
    throw new Error(`${what}: portal returned code ${json.code}: ${json.message ?? "(no message)"}`);
  }
  return json.data;
}

/**
 * The versions/create request body, mirroring the portal frontend exactly: a
 * multipart form with draft_id and — only when non-empty — changelog. The
 * portal rejects a JSON body with code 1001 "parameter parsing error".
 */
export function buildCreateVersionForm(draftId, changelog) {
  const form = new FormData();
  form.append("draft_id", String(draftId));
  if (changelog !== undefined && changelog !== "") form.append("changelog", changelog);
  return form;
}

/**
 * Whether a versions/list-private response already contains `version`, without
 * assuming the exact collection field name. Used to make publishing idempotent:
 * the release pipeline uploads before the git tag exists, so a release run that
 * fails downstream and retries would otherwise re-publish the same version and
 * be rejected by the portal.
 */
export function versionListContains(data, version) {
  if (data == null) return false;
  const list = Array.isArray(data)
    ? data
    : (data.list ?? data.items ?? data.versions ?? data.records ?? []);
  return (
    Array.isArray(list) &&
    list.some((v) => v === version || (v && typeof v === "object" && v.version === version))
  );
}

/** Pull the draft id out of the draft response without assuming one field name. */
export function extractDraftId(data) {
  if (data == null) return undefined;
  if (typeof data === "string" || typeof data === "number") return data;
  return data.draft_id ?? data.draftId ?? data.id;
}

export function parseArgs(argv) {
  const opts = {
    projectDir: undefined,
    artifact: "../turma.ehpk",
    buildCommand: "npm run pack",
    packageId: undefined,
    nextVersion: undefined,
    changelog: undefined,
    skipBuild: false,
    dryRun: false,
  };
  const takesValue = {
    "--project-dir": "projectDir",
    "--artifact": "artifact",
    "--build-command": "buildCommand",
    "--package-id": "packageId",
    "--next-version": "nextVersion",
    "--changelog": "changelog",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--skip-build") opts.skipBuild = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg in takesValue) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      opts[takesValue[arg]] = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.nextVersion && !/^\d+\.\d+\.\d+$/.test(opts.nextVersion)) {
    throw new Error(`--next-version must be x.y.z (got: ${opts.nextVersion})`);
  }
  if (!opts.dryRun && !opts.changelog) {
    throw new Error("--changelog is required (or pass --dry-run)");
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Credentials (same file the evenhub CLI reads/writes)
// ---------------------------------------------------------------------------

export function credentialsPath(env = process.env) {
  const configHome =
    env.XDG_CONFIG_HOME ||
    (process.platform === "win32"
      ? env.APPDATA || join(homedir(), "AppData", "Roaming")
      : join(homedir(), ".config"));
  return join(configHome, "evenhub", "credentials.yaml");
}

async function postJson(baseUrl, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Resolve a usable access token:
 *   1. EVENHUB_TOKEN — used verbatim (caller manages freshness);
 *   2. credentials.yaml — refreshed via /api/v1/auth/refresh when the access
 *      JWT is expired, new credential set persisted back (as the CLI does);
 *   3. EVENHUB_EMAIL + EVENHUB_PASSWORD — full login, credentials persisted.
 */
async function resolveAccessToken(baseUrl) {
  if (process.env.EVENHUB_TOKEN) return process.env.EVENHUB_TOKEN;

  const now = Date.now() / 1000;
  const credsFile = credentialsPath();
  if (existsSync(credsFile)) {
    const creds = parseFlatYaml(readFileSync(credsFile, "utf8"));
    if (creds.access_token && !isJwtExpired(creds.access_token, now)) {
      return creds.access_token;
    }
    if (creds.refresh_token && !isJwtExpired(creds.refresh_token, now)) {
      console.log("evenhub-publish: access token expired, refreshing…");
      const json = await postJson(baseUrl, "/api/v1/auth/refresh", {
        refresh_token: creds.refresh_token,
      });
      const data = unwrapEnvelope(json, "auth/refresh");
      writeFileSync(credsFile, dumpFlatYaml(data), { mode: 0o600 });
      return data.access_token;
    }
  }

  const { EVENHUB_EMAIL: email, EVENHUB_PASSWORD: password } = process.env;
  if (email && password) {
    console.log(`evenhub-publish: logging in as ${email}…`);
    const json = await postJson(baseUrl, "/api/v1/auth/login", {
      email,
      password: obfuscatePassword(email, password),
    });
    const data = unwrapEnvelope(json, "auth/login");
    mkdirSync(dirname(credsFile), { recursive: true, mode: 0o700 });
    writeFileSync(credsFile, dumpFlatYaml(data), { mode: 0o600 });
    return data.access_token;
  }

  throw new Error(
    "No Even Hub credentials: run `npx evenhub login`, or set EVENHUB_TOKEN, " +
      "or set EVENHUB_EMAIL + EVENHUB_PASSWORD.",
  );
}

// ---------------------------------------------------------------------------
// Portal upload
// ---------------------------------------------------------------------------

/**
 * True when the portal already has `version` for this package. Best-effort: an
 * unreachable or unrecognized list response warns and returns false so a
 * listing hiccup can't block a publish.
 */
async function portalHasVersion(baseUrl, token, packageId, version) {
  try {
    const params = new URLSearchParams({ package_id: packageId, page: "1", page_size: "50" });
    const res = await fetch(`${baseUrl}/api/v1/versions/list-private?${params}`, {
      headers: { "X-Even-Authorization": token },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return versionListContains(unwrapEnvelope(await res.json(), "versions/list-private"), version);
  } catch (err) {
    console.warn(`evenhub-publish: version listing failed (${err.message}) — publishing anyway`);
    return false;
  }
}

async function uploadDraft(baseUrl, token, packageId, artifactPath) {
  const form = new FormData();
  form.append(
    "ehpk",
    new Blob([readFileSync(artifactPath)], { type: "application/octet-stream" }),
    artifactPath.split("/").pop(),
  );
  const res = await fetch(
    `${baseUrl}/api/v1/versions/draft?package_id=${encodeURIComponent(packageId)}`,
    { method: "POST", headers: { "X-Even-Authorization": token }, body: form },
  );
  if (!res.ok) throw new Error(`versions/draft: ${res.status} ${res.statusText}`);
  return unwrapEnvelope(await res.json(), "versions/draft");
}

async function createVersion(baseUrl, token, packageId, draftId, changelog) {
  const res = await fetch(
    `${baseUrl}/api/v1/versions/create?package_id=${encodeURIComponent(packageId)}`,
    {
      method: "POST",
      headers: { "X-Even-Authorization": token },
      body: buildCreateVersionForm(draftId, changelog),
    },
  );
  if (!res.ok) throw new Error(`versions/create: ${res.status} ${res.statusText}`);
  return unwrapEnvelope(await res.json(), "versions/create");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const baseUrl =
    process.env.EVENHUB_BASE_URL || process.env.EVENHUB_API_URL || DEFAULT_BASE_URL;
  const projectDir = resolve(
    opts.projectDir ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  const appJsonPath = join(projectDir, "app.json");
  const app = JSON.parse(readFileSync(appJsonPath, "utf8"));

  if (opts.nextVersion) {
    app.version = opts.nextVersion;
    writeFileSync(appJsonPath, `${JSON.stringify(app, null, 2)}\n`);
    console.log(`evenhub-publish: bumped ${appJsonPath} version -> ${opts.nextVersion}`);
  }

  if (!opts.skipBuild) {
    console.log(`evenhub-publish: running \`${opts.buildCommand}\` in ${projectDir}`);
    execSync(opts.buildCommand, { cwd: projectDir, stdio: "inherit" });
  }

  const artifactPath = resolve(projectDir, opts.artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath} (build it or pass --artifact)`);
  }
  const packageId = opts.packageId ?? app.package_id;
  console.log(
    `evenhub-publish: package_id=${packageId} version=${app.version} artifact=${artifactPath}`,
  );

  if (opts.dryRun) {
    console.log(
      `evenhub-publish: dry run — would POST ${baseUrl}/api/v1/versions/draft` +
        ` then /api/v1/versions/create (changelog: ${opts.changelog ?? "(none)"})`,
    );
  } else {
    const token = await resolveAccessToken(baseUrl);
    if (await portalHasVersion(baseUrl, token, packageId, app.version)) {
      console.log(
        `evenhub-publish: portal already has ${packageId}@${app.version} — nothing to publish.`,
      );
      process.exit(0);
    }
    const draft = await uploadDraft(baseUrl, token, packageId, artifactPath);
    const draftId = extractDraftId(draft);
    if (draftId === undefined) {
      throw new Error(`versions/draft: no draft id in response: ${JSON.stringify(draft)}`);
    }
    console.log(`evenhub-publish: draft uploaded (draft_id=${draftId})`);
    const version = await createVersion(baseUrl, token, packageId, draftId, opts.changelog);
    console.log(`evenhub-publish: version created: ${JSON.stringify(version)}`);
    console.log(
      "evenhub-publish: done — promote the build in the portal, then restart the Even app and hit Update.",
    );
  }
}
