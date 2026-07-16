// Changelog rendering for the unified release pipeline. Pure — the CLI
// (plan.js/publish.js via git.js) does all the git/gh I/O and hands this module
// pre-annotated ENTRIES; grouping/rendering here is data-in, string-out, so it's
// fully unit-tested in .github/scripts/tests/changelog.test.js.
//
// An entry is one thing that landed on main's first-parent line since the range
// start — a merged PR (title/#number/url/author) or, when no PR matches, a
// synthesized entry from the commit subject (direct pushes / PRs aged past the
// gh query window are NEVER dropped). Each entry carries the `components` it
// touched, computed by the CLI from the same changes.js path map the build
// matrix uses, so the changelog and the build can't disagree.

"use strict";

// Component -> display heading. agent-image and agent-native both fold into one
// "Agent" heading; an unmatched change (empty components) lands in "Other".
const COMPONENT_HEADING = {
  turma: "Hub",
  "agent-image": "Agent",
  "agent-native": "Agent",
  glasses: "Glasses",
  android: "Android",
};
const HEADING_ORDER = ["Hub", "Agent", "Glasses", "Android", "Other"];

// Component -> row label for the release-notes summary table.
const COMPONENT_LABEL = {
  turma: "Hub (image)",
  "agent-image": "Agent (image)",
  "agent-native": "Agent (native)",
  glasses: "Glasses",
  android: "Android",
};
const TABLE_ORDER = ["turma", "agent-image", "agent-native", "glasses", "android"];

// First line, trimmed, internal whitespace collapsed — a PR title or commit
// subject that somehow carries a newline can't break a markdown bullet/table.
function sanitizeTitle(s) {
  return String(s == null ? "" : s)
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .trim();
}

// Turn the first-parent commit walk + the merged-PR list into changelog entries.
// Pure: the CLI supplies `commits` (each {oid, subject}), `prs` (each with a
// mergeCommitOid) and `componentsByOid` (computed from the same changes.js map
// as the build). A commit whose oid is a PR's merge commit becomes a rich entry;
// any other commit on main's first-parent line (direct push, or a PR aged past
// the gh query window) is synthesized from its subject and NEVER dropped.
function buildEntries(opts) {
  const { commits, prs, componentsByOid } = opts;
  const prByOid = new Map();
  for (const pr of prs || []) if (pr.mergeCommitOid) prByOid.set(pr.mergeCommitOid, pr);
  const entries = [];
  for (const commit of commits || []) {
    const components = (componentsByOid && componentsByOid[commit.oid]) || [];
    const pr = prByOid.get(commit.oid);
    if (pr) {
      entries.push({ title: pr.title, url: pr.url || null, number: pr.number, author: pr.author || null, components });
    } else {
      entries.push({ title: commit.subject, url: null, number: null, author: null, components });
    }
  }
  return entries;
}

// The set of headings an entry belongs under (deduped, in HEADING_ORDER).
function headingsForEntry(entry) {
  const set = new Set();
  for (const c of entry.components || []) {
    if (COMPONENT_HEADING[c]) set.add(COMPONENT_HEADING[c]);
  }
  if (set.size === 0) set.add("Other");
  return HEADING_ORDER.filter((h) => set.has(h));
}

// Group entries under display headings. A multi-component entry appears under
// each heading it touches (once per heading). Empty headings are omitted.
function groupByComponent(entries) {
  const groups = {};
  for (const h of HEADING_ORDER) groups[h] = [];
  for (const entry of entries) {
    for (const h of headingsForEntry(entry)) groups[h].push(entry);
  }
  const out = {};
  for (const h of HEADING_ORDER) if (groups[h].length) out[h] = groups[h];
  return out;
}

function renderEntryLine(entry) {
  const title = sanitizeTitle(entry.title);
  let line = `- ${title}`;
  if (entry.number != null) {
    line += entry.url ? ` ([#${entry.number}](${entry.url}))` : ` (#${entry.number})`;
  }
  if (entry.author) line += ` @${entry.author}`;
  return line;
}

function renderGroups(groups) {
  const parts = [];
  for (const heading of HEADING_ORDER) {
    const list = groups[heading];
    if (!list || !list.length) continue;
    parts.push(`### ${heading}`);
    for (const entry of list) parts.push(renderEntryLine(entry));
    parts.push("");
  }
  return parts.join("\n").trimEnd();
}

// The summary table for the GitHub Release body, read from the manifest so it
// reflects exactly what shipped (rebuilt version + ref, or the carried older one).
function renderComponentTable(manifest) {
  const rows = ["| Component | Version | Status | Artifact |", "|---|---|---|---|"];
  for (const key of TABLE_ORDER) {
    const c = manifest.components[key];
    if (!c) continue;
    const status = c.built ? "rebuilt" : "carried";
    let artifact = "";
    if (c.kind === "image") artifact = "`" + c.ref + "`";
    else if (c.kind === "asset") artifact = "`" + c.asset + "`" + (c.version_code ? ` (code ${c.version_code})` : "");
    rows.push(`| ${COMPONENT_LABEL[key]} | ${c.version} | ${status} | ${artifact} |`);
  }
  return rows.join("\n");
}

const INSTALL_DETAILS = [
  "<details><summary>Install / deploy</summary>",
  "",
  "- **Images** (`Hub`, `Agent`): deployed on the home lab by Watchtower from `:latest`.",
  "  Pin a specific build with the `ghcr.io/...` ref in the table above.",
  "- **Agent (native)**: WSL/Linux hosts self-update from this stream; see `agent/native/README.md`.",
  "- **Glasses** (`.ehpk`): download below and sideload via the Even Hub app.",
  "- **Android** (`.apk`): download below and install (enable \"install unknown apps\"). Debug-signed.",
  "",
  "Carried components are unchanged since the version shown; their artifact name reflects the",
  "build it actually is. `manifest.json` (attached) is the machine-readable source of truth.",
  "</details>",
].join("\n");

// The GitHub Release body for one release (patch notes live only here, per the
// release policy — CHANGELOG.md gets only the minor rollups).
function renderReleaseNotes(opts) {
  const { version, groups, manifest } = opts;
  const body = groups && Object.keys(groups).length ? renderGroups(groups) : "_No component changes in range._";
  return [`## Turma v${version}`, "", renderComponentTable(manifest), "", body, "", INSTALL_DETAILS, ""].join("\n");
}

// A CHANGELOG.md section for a minor/major rollup (no summary table — this rolls
// up many patches; the per-patch tables live on their Release pages).
function renderChangelogSection(opts) {
  const { version, date, groups } = opts;
  const body = groups && Object.keys(groups).length ? renderGroups(groups) : "_No changes._";
  return [`## ${version} — ${date}`, "", body, ""].join("\n") + "\n";
}

const CHANGELOG_MARKER = "<!-- releases:newest-first -->";

// Prepend `section` under the newest-first marker, idempotently: if a section
// for the same version already exists it's replaced (re-running a dispatch
// doesn't double-insert). `section` must start with its own `## <version> ` line.
function insertSection(existingMd, section) {
  const md = String(existingMd);
  const markerIdx = md.indexOf(CHANGELOG_MARKER);
  const versionMatch = /^##\s+(\S+)/.exec(section);
  const version = versionMatch ? versionMatch[1] : null;

  let head;
  let rest;
  if (markerIdx === -1) {
    head = md.replace(/\s*$/, "");
    rest = "";
  } else {
    const afterMarker = markerIdx + CHANGELOG_MARKER.length;
    head = md.slice(0, afterMarker);
    rest = md.slice(afterMarker).replace(/^\n+/, "");
  }

  // Drop any existing section for this version so re-runs are idempotent.
  if (version) {
    const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|\\n)##\\s+${esc}(?:\\s|$)[\\s\\S]*?(?=\\n##\\s|$)`);
    rest = rest.replace(re, "").replace(/^\n+/, "");
  }

  const sec = section.replace(/\s*$/, "") + "\n";
  return `${head}\n\n${sec}${rest ? "\n" + rest.replace(/\s*$/, "") + "\n" : ""}`;
}

module.exports = {
  COMPONENT_HEADING,
  HEADING_ORDER,
  CHANGELOG_MARKER,
  buildEntries,
  sanitizeTitle,
  headingsForEntry,
  groupByComponent,
  renderEntryLine,
  renderGroups,
  renderComponentTable,
  renderReleaseNotes,
  renderChangelogSection,
  insertSection,
};
