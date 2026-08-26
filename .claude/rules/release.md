---
paths:
  - ".github/**"
  - "VERSION"
  - "RELEASING.md"
  - "CHANGELOG.md"
  - "turma/Dockerfile"
  - ".trivyignore"
---

# Releases and CI gates

`.github/workflows/` holds the GHCR image builds and the PR gates. See `RELEASING.md` and
`.github/scripts/README.md` for the operator-facing procedure.

## Unified releases

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all four components + a changelog**, cut by
  `.github/workflows/release.yml`. **Never split back into per-component workflows** — their
  independent `run_number` patches drift out of lockstep.
- The root **`VERSION`** file holds `MAJOR.MINOR` only. The **patch is derived from existing `v*`
  tags** (`max` on that line + 1), never committed. Bump `VERSION` only for a minor/major.
- The four components: `turma` (hub) image, native agent tarball, glasses `.ehpk`, android `.apk`.
  All version math (tag-derived patch, android `versionCode` packing, the strictly-greater guard)
  lives in the tested `.github/scripts`.

### What a release builds vs carries

- Only **changed** components build; **unchanged** ones are **carried** — their prior artifact is
  published at its own prior version, not rebuilt. Every release publishes all four.
- **Images**: carried → the manifest references the prior `:version` tag (no retag); a carried
  image's `:latest` is already correct, so Watchtower needs nothing.
- **Assets** (`.ehpk`/`.apk`/`.tar.gz`): a carried asset is copied forward under its **original
  name** (the filename must describe the bits — Even Hub / Android installs by the version baked
  inside, and the native bootstrap/updater resolve by filename, never by tag). A built asset is
  named at the new version.
- A per-release **`manifest.json`** is the machine-readable source of truth for each component's
  version + where its bits live — read by the next release's `plan`, the native updater, and humans.
  The bundled Claude Code release is pinned via `CLAUDE_CODE_VERSION` but is **not** part of the
  version.
- Trigger: `workflow_dispatch` (`dry_run` defaulting on) plus `push: main` for auto patch releases.
  A manual `minor`/`major` dispatch bumps `VERSION`, rolls intervening patches into `CHANGELOG.md`,
  and force-builds every component.
- The `push: main` trigger is **path-filtered to the four component source dirs**, restating
  `changes.js`'s `PREFIX_MAP` (a workflow trigger can't call into JS; a test asserts the two match).
  A docs-only merge cuts no release.

### The release DEPLOYS the hub (XERK-425)

- The last step of `build-turma-image` rewrites the `image:` line of the k8x hub's manifest in the
  private GitOps repo (`ai/turma/deployment.yaml` in xerktech/ArgoCD) to the tag it just pushed and
  commits it to main. That Application is `automated` + `selfHeal`, so **the commit is the deploy**.
- **Every failure is loud**: no `ARGOCD_DEPLOY_KEY`, or no `image:` line to update, fails the
  step. A silent skip is a cluster that quietly never updates behind a green pipeline.
- It authenticates with a **write deploy key** on the GitOps repo, never a PAT — `GITHUB_TOKEN`
  can't reach another repo, a classic PAT carries a whole account into CI, and a fine-grained one
  **expires**, which surfaces as a deploy that silently stops happening. GitHub's host key is
  pinned in the step rather than accepted on first use.
- Skipped on a dry run (no image was pushed) and off **main** — `workflow_dispatch` takes any ref,
  and this is the one step that reaches production.
- **"Built" is not "changed"**: `changes.js` maps the whole `turma/` prefix, so a test-only merge
  rebuilds the image and redeploys a runtime-identical hub, which `Recreate` + `replicas: 1` pays
  for with every tunnel, SSE stream and terminal channel. XERK-426.

## PR gates (pre-merge to main)

The build workflows run only post-merge; these run on `pull_request` → `main` and block the merge:

- `code-scan.yml` — Semgrep SAST over the JS/Python + the hub Dockerfile + secret patterns, hadolint
  on `turma/Dockerfile`, ShellCheck on every shell script in the repo (the native launcher/updater/
  installer). Also unit-tests the release logic (`.github/scripts/tests`), the native updater/
  installer/bootstrap shell tests, and the Python + Node unit suites. Path-filtered to include
  `CLAUDE.md` and `.claude/rules/**` so a docs-only PR still runs the instruction-file size gate.
- **Instruction file size limits** — `CLAUDE.md` and every `.claude/rules/*.md` must stay under
  40,000 characters, Claude Code's own "Large CLAUDE.md will impact performance" threshold. Measured
  in characters, not bytes (the files are full of multibyte glyphs); locally the same number is `wc
  -m <file>`. Rationale and where-to-put-what are in `CLAUDE.md`'s "Editing these files".
- `turma-image-scan.yml` — build the hub image locally (no push) and Trivy-scan for CVEs + secrets
  (`ignore-unfixed`, HIGH/CRITICAL gate), path-filtered to `turma/`.
- `glasses-ci.yml` — path-filtered to `glasses/**`, typecheck + Vitest + production build in a
  throwaway `node:24-alpine` container.
- `android-ci.yml` — path-filtered to `android/**`, JVM unit tests + `assembleDebug`.

Because the hub image bundles third-party binaries, keep the pinned tool versions current — that's
how most CVEs are cleared. Non-actionable upstream base-image findings go in the root `.trivyignore`
(a reviewed triage list, each with a reason); anything unlisted still fails.

## Where jobs run

**Every workflow runs on GitHub-hosted `ubuntu-latest`**, including the hub image build (its layer
cache is `type=gha`, GitHub-side, so it follows the job).

- Hosted bills **rounded UP per job**, so prefer fewer batched jobs.
- The self-hosted-box workarounds are **deleted, not disabled** — reintroducing any is a regression:
  "Reset workspace ownership" steps; per-job `DOCKER_CONFIG` scoping; `docker image prune` / `docker
  builder prune` cleanup; throwaway `node:24-alpine` containers for `npm view`; the
  `mingc/android-build-box` container. If a job genuinely needs self-hosted again, say which in a
  comment on its `runs-on` and bring back only the ones it needs.
- No GitHub Advanced Security, so no code-scanning API — findings live in the job log and
  `--exit-code` is the gate (no SARIF upload). Trivy is installed from its release tarball to
  `$HOME/.local/bin` (the trivy-action pins a step to a tag upstream deleted).
