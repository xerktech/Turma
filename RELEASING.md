# Releasing Turma

One release publishes **all five components** under a single `v<MAJOR>.<MINOR>.<PATCH>`
tag: the `turma` image, the `agent` image, the glasses `.ehpk`, the android
`.apk`, and the native-agent tarball. Driven by `.github/workflows/release.yml`;
the logic lives in `.github/scripts/` (see its README).

## How the version is decided

- The root `VERSION` file holds `MAJOR.MINOR` only.
- `PATCH` is derived from the existing `v<M>.<m>.<p>` tags — the max on the
  current line, plus one — and is **never committed**. That keeps the auto-patch
  path read-only against the repo, so it can't re-trigger itself.
- A minor/major bump is a deliberate manual act (see below) that edits `VERSION`.

## Patch releases (automatic)

Every merge to `main` cuts a patch release. `plan` diffs the merge against the
previous release tag and decides, per component, **build or carry**:

- **Changed** components are rebuilt at the new version.
- **Unchanged** components are **carried**: their prior artifact is published in
  the new release *at its own prior version*, not rebuilt. A glasses-only merge
  builds the new `.ehpk` and copies the previous `turma-android-v*.apk` (and the
  rest) onto the release unchanged.

So a release always contains all five components; carried ones simply read their
older version. The release notes render a **rebuilt vs carried** table from the
attached `manifest.json`, which is the machine-readable source of truth.

Carried **images** are referenced in the manifest at their prior `:version` tag
(we do not retag an unchanged image to the new version — `:0.3.9` pointing at
`0.3.4` bits would be as misleading as renaming a carried asset). `:latest` is
already correct on a carried image, so Watchtower needs nothing. Carried
**assets** are copied forward under their **original filename**, because Even Hub
and Android version an install by the version baked *inside* the file — the name
must describe the bits.

## Minor / major releases (manual)

Run the **release** workflow from the Actions tab with `release_type: minor` (or
`major`) and `dry_run: false`. This:

1. bumps `VERSION` and commits it,
2. rolls every patch since the last minor into a new `CHANGELOG.md` section
   (grouped by component, from the merged PRs), committed alongside,
3. **force-builds every component** at the new version — a minor is a coherent,
   blessed cut, so nothing is carried (a carried asset would ship a version that
   disagrees with the release).

`CHANGELOG.md` holds only these minor rollups; per-patch notes live on each
release's GitHub page.

## Dry run

`workflow_dispatch` defaults `dry_run: true`. A dry run computes the version and
build matrix against real tags, builds with `push: false`, uploads the composed
`manifest.json` + release notes + assets as **Actions artifacts**, and creates
**no tag, release, or commit**. Use it to rehearse a release (especially the
first one, or after changing the scripts) as many times as you like.

## The first unified release

Cut `v0.3.0` by hand: run the workflow with `release_type: patch`,
`dry_run: false`. With `VERSION=0.3` and no `v*` tags yet, `plan` force-builds
every component (no previous release to carry from). Watch it; keep
`gh release delete v0.3.0 --cleanup-tag` handy if you need to redo it. The
version guard (`assertStrictlyGreatest`) refuses any version at or below an
existing tag — including the legacy `glasses-v*`/`android-v*`/`agent-native-v*`
namespaces — so a fat-fingered `VERSION` can't regress a shipped channel.

## Native agent self-update

Deployed WSL/Linux hosts poll the release stream and update themselves from it —
comparing the manifest's agent-native **component version**, not the release tag,
so a carried (unchanged) native build is a correct no-op. During the cutover, a
release that *builds* the native agent also publishes an `agent-native-v<version>`
alias release so hosts still on the legacy updater self-heal; that alias step is
removed once the fleet is confirmed migrated.

## Known wrinkles

- **Rapid merges leave patch-number gaps.** The release workflow serializes
  (`concurrency` group, `cancel-in-progress: false`) and supersedes older pending
  runs, so three merges in a burst may yield two releases. This is safe: the
  changelog is range-based (`prev_tag..HEAD`), so the surviving release still
  covers the superseded merges' PRs. Never make the changelog event-based.
- **A build that fails after the tag/images would leave partial state.** `publish`
  creates the tag last and only if no targeted build failed; a failed run creates
  no tag, so the next merge's diff still spans the failed range and the components
  just rebuild. The pipeline is self-healing by construction.
