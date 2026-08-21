# Releasing Turma

One release publishes **all six components** under a single `v<MAJOR>.<MINOR>.<PATCH>`
tag: the `turma` image, the `agent` image, the glasses app, the android
`.apk`, the native-agent tarball, and the veiller miniapp `.zip`. Driven by
`.github/workflows/release.yml`;
the logic lives in `.github/scripts/` (see its README). The glasses build is
**not a release asset**: its distribution channel is the Even Hub developer
portal, uploaded by `build-glasses` right after packing (see "Even Hub
dev-portal publish").

## How the version is decided

- The root `VERSION` file holds `MAJOR.MINOR` only.
- `PATCH` is derived from the existing `v<M>.<m>.<p>` tags — the max on the
  current line, plus one — and is **never committed**. That keeps the auto-patch
  path read-only against the repo, so it can't re-trigger itself.
- A minor/major bump is a deliberate manual act (see below) that edits `VERSION`.

## Patch releases (automatic)

Every merge to `main` that touches a component's source (`turma/`, `agent/`,
`glasses/`, `android/`, `veiller/`) cuts a patch release — a merge that touches only docs or
the release machinery does not, since every component would be carried and the
release would publish nothing new. `plan` diffs the merge against the previous
release tag and decides, per component, **build or carry**:

- **Changed** components are rebuilt at the new version.
- **Unchanged** components are **carried**: their prior artifact ships *at its
  own prior version*, not rebuilt. A glasses-only merge builds and
  portal-publishes the new glasses app and copies the previous
  `turma-android-v*.apk` / native tarball onto the release unchanged.

So a release always contains all six components; carried ones simply read their
older version. The release notes render a **rebuilt vs carried** table from the
attached `manifest.json`, which is the machine-readable source of truth.

Carried **images** are referenced in the manifest at their prior `:version` tag
(we do not retag an unchanged image to the new version — `:0.3.9` pointing at
`0.3.4` bits would be as misleading as renaming a carried asset). `:latest` is
already correct on a carried image, so Watchtower needs nothing. Carried
**assets** (the `.apk`, native tarball, and veiller `.zip`) are copied forward
under their **original filename**, because Android and the native updater version
an install by the version baked *inside* the file — the name must describe the
bits. A
carried **glasses** component needs nothing physical: the Even Hub portal
already holds its version, and the manifest references it (`kind: "evenhub"`).

## Even Hub dev-portal publish

The `build-glasses` job packs the `.ehpk` and immediately uploads it to the Even
Hub developer portal (the portal's draft + create-version API, via
`glasses/scripts/evenhub-publish.mjs`). The portal — not the GitHub release — is
the glasses app's distribution channel, so the `.ehpk` is not attached to the
release; a portal failure fails `build-glasses` and blocks the release like any
other build failure. The upload happens **before the tag exists**: if a later
job fails, no tag is minted, and the retrying run recomputes the same version —
the publish script detects a version the portal already has (via
`versions/list-private`) and skips, so retries are safe. A carried (unchanged)
glasses component publishes nothing: the portal already holds its version, and
the manifest references it. **Promoting** the uploaded build in the portal
remains a manual step.

Configuration (Settings → Secrets and variables → Actions):

- **Secrets `EVENHUB_EMAIL` / `EVENHUB_PASSWORD`** — the Even Hub developer
  account the build authenticates as. Access tokens live ~10 min, so a stored
  token can't work for CI; email + password is the only durable credential.
- **Variable `EVENHUB_PACKAGE_ID`** *(optional)* — overrides the committed
  `glasses/app.json` `package_id` when the portal listing uses a different id.

If the secrets are missing on a real release, `build-glasses` fails with a clear
error before anything is tagged or published. A `dry_run` dispatch exercises the
publish step (config + artifact resolution) without authenticating or uploading,
and uploads the packed `.ehpk` as an Actions artifact (`glasses-ehpk-dry-run`)
for inspection.

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

## Deploying the hub to k8x (automatic)

The `k8x` hub is a Kubernetes Deployment in the private **xerktech/ArgoCD** repo
(`ai/turma/deployment.yaml`), pinned by digest, with no Watchtower. Its Argo CD
Application is `automated` + `selfHeal`, so a commit to that file *is* the
deploy.

`deploy-hub-image` runs after `publish` and rewrites the manifest's `image:` line
to `ghcr.io/<owner>/turma:<version>@sha256:<digest>` — tag *and* digest, matching
how the sibling `turma-agent` StatefulSet is pinned there. The digest comes from
`build-turma-image`'s own build output, never re-resolved from the registry,
because `:latest`/`:<version>` are mutable and a later release could otherwise
hand the cluster a different image than the one that was just built.

It runs **only when the `turma` component was actually built** (a carried hub is
already the running image), never on a dry run, and **only from `main`** — a
`workflow_dispatch` accepts any ref, and without that guard one mis-aimed
non-dry dispatch would roll the fleet's control plane onto an unmerged branch.
Running it after `publish` means the cluster only ever receives an image
belonging to a release that exists. If it fails, the release itself still
stands — the tag, the images and the assets are already published; what the red
job reports is that k8x is still on the previous image.

The converse of the build-vs-carry gate does not hold: `changes.js` maps the
whole `turma/` prefix, so a test-only change still rebuilds the image and
therefore redeploys a runtime-identical hub, costing the single replica a
`Recreate`. XERK-426 carries that.

A rejected push is **re-applied, not rebased**: the job resets onto the new
`origin/main` and re-runs the rewrite. The commit it races with is most often a
hand-edit of this very line, which a rebase would turn into a conflict that
kills the step before its error message. Re-applying also makes the rival's edit
visible — if they pinned the same ref, the re-run stages nothing and the job
stops rather than committing over them.

The rewrite is `.github/scripts/argocd.js` (pure, unit-tested) driven by
`argocd-cli.js`. It is a textual one-line edit on purpose: that manifest is
mostly comments carrying the reasoning for every field, and a YAML round-trip
would delete them on every release. It refuses to guess — no matching `image:`
line, or more than one, fails the job rather than silently doing nothing.

Configuration (Settings → Secrets and variables → Actions):

- **Secret `ARGOCD_REPO_TOKEN`** *(required)* — a PAT with `contents: write` on
  the GitOps repo. `GITHUB_TOKEN` is scoped to this repo only, so it cannot push
  there. A missing secret **fails the job**; it deliberately does not skip,
  because a silent skip is a cluster that quietly never updates and a pipeline
  that still looks green.
- **Variable `ARGOCD_REPO`** *(optional)* — defaults to `<owner>/ArgoCD`.
- **Variable `ARGOCD_HUB_MANIFEST`** *(optional)* — defaults to
  `ai/turma/deployment.yaml`.

The cluster-side Turma **agent** (`ai/turma-agent`, a StatefulSet in the same
repo) is still bumped by hand — deliberately, since restarting it kills every
session that host is running.

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
