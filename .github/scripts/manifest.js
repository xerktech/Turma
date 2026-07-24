// manifest.json is the source of truth for what a release IS: one entry per
// component naming its version and where its bits live. Uploaded as an asset on
// every release, and read by (a) the next release's `plan` to decide carry vs
// build, (b) the native agent's self-updater, (c) humans. Pure — unit-tested in
// .github/scripts/tests/manifest.test.js.
//
// Carry-forward model (matches the release preview the user approved): a release
// version is an UMBRELLA. A rebuilt component takes the new version; a CARRIED
// component keeps its own older version and the release just references it.
//   - Images: nothing to do on carry. The component's version tag and :latest
//     already exist in the registry from when it was built; the manifest simply
//     references that older tag (ghcr...:0.3.4 on a v0.3.9 release). We never
//     retag a carried image to the new version — :0.3.9 pointing at 0.3.4 bits
//     is the same lie as renaming a carried asset.
//   - Assets: physically copied onto the new release under their ORIGINAL name
//     (turma-android-v0.3.4.apk on the v0.3.9 release), so every release page is
//     self-contained. Renaming to the new version would make a file whose
//     in-package version (versionCode) contradicts its name — which Android
//     acts on.
//   - Even Hub (the glasses component): the .ehpk is NOT a release asset — its
//     distribution channel is the Even Hub developer portal, uploaded by
//     build-glasses at pack time. Nothing to do on carry: the portal already
//     holds the carried version; the manifest just references it.

"use strict";

const SCHEMA = 1;
const DEFAULT_OWNER = "xerktech";
const DEFAULT_GLASSES_PACKAGE_ID = "com.xerktech.turma";

// Fresh descriptor for a component built at `version` on release `tag`.
function freshComponent(component, version, tag, opts) {
  const owner = (opts && opts.owner) || DEFAULT_OWNER;
  switch (component) {
    case "turma":
      return { version, kind: "image", ref: `ghcr.io/${owner}/turma:${version}`, built: true };
    case "agent-image":
      return { version, kind: "image", ref: `ghcr.io/${owner}/turma-agent:${version}`, built: true };
    case "agent-native": {
      const asset = `turma-agent-native-v${version}.tar.gz`;
      return { version, kind: "asset", asset, sha256_asset: `${asset}.sha256`, release_tag: tag, built: true };
    }
    case "glasses":
      return {
        version,
        kind: "evenhub",
        package_id: (opts && opts.glassesPackageId) || DEFAULT_GLASSES_PACKAGE_ID,
        built: true,
      };
    case "android":
      return {
        version,
        kind: "asset",
        asset: `turma-android-v${version}.apk`,
        version_code: opts && opts.androidVersionCode,
        release_tag: tag,
        built: true,
      };
    default:
      throw new Error(`unknown component ${component}`);
  }
}

// Build the manifest for a release. `changed` is the {component: bool} record
// from changes.detectChanges (== which components were built, since publish only
// runs when every targeted build succeeds). Carried components are copied from
// prevManifest verbatim except: built=false, and (for assets) release_tag is
// re-pointed at the new tag because carryPlan copies the asset onto this release.
function buildManifest(opts) {
  const { version, tag, commit, releasedAt, changed, prevManifest } = opts;
  const components = {};
  for (const component of Object.keys(changed)) {
    if (changed[component]) {
      components[component] = freshComponent(component, version, tag, opts);
      continue;
    }
    const prev = prevManifest && prevManifest.components && prevManifest.components[component];
    if (!prev) {
      // Unchanged but nothing to carry from: a schema drift or a brand-new
      // component. Throwing forces a rebuild, which is the safe direction —
      // never emit a manifest with a hole.
      throw new Error(`component ${component} is unchanged but absent from the previous manifest; rebuild it`);
    }
    // Pre-portal manifests shipped the .ehpk as a release asset; the Even Hub
    // portal is its channel now, so a carried glasses entry is normalized to
    // the evenhub kind instead of copying a stale asset forward (the portal
    // already holds that version — it uploads on every rebuild).
    if (component === "glasses" && prev.kind === "asset") {
      components[component] = {
        version: prev.version,
        kind: "evenhub",
        package_id: (opts && opts.glassesPackageId) || DEFAULT_GLASSES_PACKAGE_ID,
        built: false,
      };
      continue;
    }
    const carried = Object.assign({}, prev, { built: false });
    if (carried.kind === "asset") carried.release_tag = tag;
    components[component] = carried;
  }
  return { schema: SCHEMA, version, tag, commit, released_at: releasedAt, components };
}

// The work the `publish` job executes to make a release self-contained: for each
// carried ASSET, copy it from the previous release onto this one under the same
// name. Images need no action (see the header). Returns [] when nothing carries.
function carryPlan(manifest, prevManifest) {
  const actions = [];
  for (const [component, c] of Object.entries(manifest.components)) {
    if (c.built || c.kind !== "asset") continue;
    const action = {
      component,
      action: "copy-asset",
      asset: c.asset,
      from_release: prevManifest.tag,
      to_release: manifest.tag,
    };
    if (c.sha256_asset) action.sha256_asset = c.sha256_asset;
    actions.push(action);
  }
  return actions;
}

module.exports = { SCHEMA, DEFAULT_OWNER, DEFAULT_GLASSES_PACKAGE_ID, freshComponent, buildManifest, carryPlan };
