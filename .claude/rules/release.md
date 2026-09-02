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

`.github/workflows/` holds the GHCR image builds and PR gates. See `RELEASING.md` and
`.github/scripts/README.md` for the operator procedure.

## Unified releases

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all four components + a changelog**, cut by
  `release.yml`. **Never split back into per-component workflows** — independent `run_number`
  patches drift out of lockstep.
- `VERSION` holds `MAJOR.MINOR` only. **Patch is derived from existing `v*` tags** (max+1), never
  committed. Bump `VERSION` only for minor/major.
- Four components: `turma` (hub) image, native agent tarball, glasses `.ehpk`, android `.apk`. All
  version math lives in tested `.github/scripts`.

### What a release builds vs carries

- Only **changed** components build; **unchanged** are CARRIED at their prior version. Every release
  publishes all four.
- Images: carried → manifest references the prior `:version` tag (no retag). Assets
  (`.ehpk`/`.apk`/`.tar.gz`): carried → copied forward under the **ORIGINAL name** (installers and
  the native bootstrap/updater resolve by filename, never by tag).
- Per-release **`manifest.json`** is the machine-readable source of truth (version + bits location),
  read by the next release's `plan`, the native updater, and humans. `CLAUDE_CODE_VERSION` is pinned
  but NOT part of the version.
- Trigger: `workflow_dispatch` (`dry_run` on by default) + `push: main` for auto patch releases. A
  manual `minor`/`major` dispatch bumps `VERSION`, rolls patches into `CHANGELOG.md`, force-builds
  everything.
- `push: main` is **path-filtered to the four component source dirs**, mirroring `changes.js`'s
  `PREFIX_MAP` (a test asserts the two match — a workflow trigger can't call into JS). A docs-only
  merge cuts no release.

### The release DEPLOYS the hub (XERK-425)

- `build-turma-image`'s last step rewrites the k8x hub manifest's `image:` line in the private GitOps
  repo (`ai/turma/deployment.yaml`, xerktech/ArgoCD) and commits to main. That Application is
  `automated`+`selfHeal`, so **the commit is the deploy**.
- **Every failure is loud** — no `ARGOCD_DEPLOY_KEY` or no `image:` line fails the step; a silent
  skip is a cluster that quietly never updates behind a green pipeline.
- Auths with a **write deploy key**, never a PAT (`GITHUB_TOKEN` can't reach another repo; a classic
  PAT carries the whole account; a fine-grained one expires silently). GitHub's host key is pinned,
  not accepted on first use.
- Skipped on a dry run and off **main**. **"Built" IS "changed"**: `changes.js` carves each
  component's non-shipped tests/tooling out of its prefix (`EXCLUDE_PREFIXES`; e.g. `turma/tests/**`,
  `turma/tools/**`), and `release.yml`'s `push:` filter mirrors them as `!`-negation globs, so a
  test-only merge builds nothing and never REDEPLOYS a runtime-identical hub — the `Recreate`+
  `replicas: 1` drop of every tunnel/SSE/terminal channel is reserved for a real image change
  (XERK-426). Widening the exclude list means widening BOTH the map and those globs together.

## PR gates (pre-merge to main)

- `code-scan.yml` — Semgrep SAST (JS/Python + hub Dockerfile + secret patterns), hadolint on
  `turma/Dockerfile`, ShellCheck on every shell script, unit tests (`.github/scripts/tests`, native
  updater/installer/bootstrap shell tests, Python + Node suites). Path-filtered to include
  `CLAUDE.md`/`.claude/rules/**` so a docs-only PR still runs the size gate.
- **Instruction file size limits** — `CLAUDE.md` + every `.claude/rules/*.md` must stay under 40,000
  characters (Claude Code's own perf threshold). Measured in CHARS not bytes (`wc -m`). See
  `CLAUDE.md`'s "Editing these files".
- `turma-image-scan.yml` — builds the hub image locally (no push), Trivy-scans for CVEs+secrets
  (`ignore-unfixed`, HIGH/CRITICAL gate). Path-filtered to `turma/`.
- `glasses-ci.yml` — path-filtered to `glasses/**`: typecheck + Vitest + production build in a
  throwaway `node:24-alpine` container.
- `android-ci.yml` — path-filtered to `android/**`: JVM unit tests + `assembleDebug`.

Keep pinned tool versions current — that's how most CVEs clear. Non-actionable upstream findings go
in root `.trivyignore` (reviewed, each with a reason); anything unlisted fails.

## Where jobs run

**Every workflow runs on GitHub-hosted `ubuntu-latest`**, including the hub image build (`gha`
layer cache follows the job).

- Hosted bills **rounded UP per job** — prefer fewer batched jobs.
- **Self-hosted-box workarounds are DELETED, not disabled** — reintroducing any is a regression:
  workspace-ownership reset steps, per-job `DOCKER_CONFIG` scoping, `docker image/builder prune`,
  throwaway `node:24-alpine` for `npm view`, `mingc/android-build-box`. If a job genuinely needs
  self-hosted again, say which in a `runs-on` comment and bring back only what it needs.
- No GitHub Advanced Security → no SARIF upload; findings live in the job log, `--exit-code` is the
  gate. Trivy installs from its release tarball to `$HOME/.local/bin` (the trivy-action pins a tag
  upstream deleted).
