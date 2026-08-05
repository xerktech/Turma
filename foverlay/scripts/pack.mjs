// Pack the built miniapp into the FLAT zip the Foverlay app bundles: the
// contents of dist/ (background/, ui/, plus miniapp.json + icon.png copied in
// here) sit at the ZIP ROOT — miniapp.json must be at the top level of the
// archive, not under a dist/ folder.
//
// Stdlib-only (like every script in this repo). Node has no zip in its stdlib,
// so the archive itself is produced by the system `zip` when present (CI's
// ubuntu-latest has one) with a python3 zipfile fallback for dev boxes without
// it.
//
// Usage: node scripts/pack.mjs [--version X.Y.Z] [--out path/to.zip]
//   --version   overrides the version used in the default output name
//               (miniapp.json's committed version otherwise)
//   --out       explicit output path (default build/<packageName>-<version>.zip)

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { version: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") args.version = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else {
      console.error(`pack.mjs: unknown argument ${a}`);
      process.exit(2);
    }
  }
  if ((args.version === undefined || args.version === "") || (args.out === undefined || args.out === "")) {
    console.error("pack.mjs: --version and --out require a value");
    process.exit(2);
  }
  return args;
}

function fail(msg) {
  console.error(`pack.mjs: ${msg}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const manifestPath = path.join(root, "miniapp.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const packageName = manifest.packageName;
const version = args.version || manifest.version;
if (!packageName) fail("miniapp.json has no packageName");
if (!version) fail("miniapp.json has no version (and no --version given)");

// The build must have run first: both entry points named by miniapp.json.
const distDir = path.join(root, "dist");
for (const rel of ["background/index.js", "ui/index.html"]) {
  if (!existsSync(path.join(distDir, rel))) {
    fail(`dist/${rel} missing — run \`bun run build\` first`);
  }
}

// The manifest and icon ride at the zip root alongside background/ and ui/.
copyFileSync(manifestPath, path.join(distDir, "miniapp.json"));
copyFileSync(path.join(root, "icon.png"), path.join(distDir, "icon.png"));

const outPath = path.resolve(root, args.out || path.join("build", `${packageName}-${version}.zip`));
mkdirSync(path.dirname(outPath), { recursive: true });
rmSync(outPath, { force: true });

// FLAT zip: archive dist/'s CONTENTS from inside dist/, so miniapp.json is at
// the zip root. System `zip -r` when available; python3's zipfile otherwise.
const haveZip = spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0;
if (haveZip) {
  const r = spawnSync("zip", ["-r", "-X", outPath, "."], { cwd: distDir, stdio: "inherit" });
  if (r.status !== 0) fail(`zip exited with status ${r.status}`);
} else {
  const py = `
import os, sys, zipfile
dist, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for base, _dirs, files in os.walk(dist):
        for f in sorted(files):
            p = os.path.join(base, f)
            z.write(p, os.path.relpath(p, dist))
`;
  const r = spawnSync("python3", ["-c", py, distDir, outPath], { stdio: "inherit" });
  if (r.status === null || r.error) fail("neither `zip` nor `python3` is available to create the archive");
  if (r.status !== 0) fail(`python3 zipfile exited with status ${r.status}`);
}

console.log(`packed ${path.relative(root, outPath)}`);
