---
paths:
  - ".github/**"
  - "VERSION"
  - "RELEASING.md"
  - "CHANGELOG.md"
  - "agent/Dockerfile"
  - "turma/Dockerfile"
  - ".trivyignore"
---

# Releases, CI gates and image tiers

`.github/workflows/` holds the GHCR image builds and the PR gates. See `RELEASING.md` and
`.github/scripts/README.md` for the operator-facing procedure.

## Unified releases

- **One release = one `v<MAJOR>.<MINOR>.<PATCH>` tag = all five components + a changelog**, cut by
  `.github/workflows/release.yml`. **Never split back into per-component workflows** — their
  independent `run_number` patches drift out of lockstep.
- The root **`VERSION`** file holds `MAJOR.MINOR` only. The **patch is derived from existing `v*`
  tags** (`max` on that line + 1), never committed. Bump `VERSION` only for a minor/major.
- The five components: `turma` image, `agent` image, glasses `.ehpk`, android `.apk`, native agent
  tarball. All version math (tag-derived patch, android `versionCode` packing, the strictly-greater
  guard) lives in the tested `.github/scripts`.

### What a release builds vs carries

- Only **changed** components build; **unchanged** ones are **carried** — their prior artifact is
  published at its own prior version, not rebuilt. Every release publishes all five.
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

## PR gates (pre-merge to main)

The build workflows run only post-merge; these run on `pull_request` → `main` and block the merge:

- `code-scan.yml` — Semgrep SAST over the JS/Python + Dockerfiles + secret patterns, hadolint on
  both Dockerfiles, ShellCheck on `entrypoint.sh`. Also unit-tests the release logic
  (`.github/scripts/tests`), the native updater/installer/bootstrap shell tests, and the Python +
  Node unit suites. Path-filtered to include `CLAUDE.md` and `.claude/rules/**` so a docs-only PR
  still runs the instruction-file size gate.
- **Instruction file size limits** — `CLAUDE.md` and every `.claude/rules/*.md` must stay under
  40,000 characters, Claude Code's own "Large CLAUDE.md will impact performance" threshold. Measured
  in characters, not bytes (the files are full of multibyte glyphs); locally the same number is `wc
  -m <file>`. Rationale and where-to-put-what are in `CLAUDE.md`'s "Editing these files".
- `turma-agent-image-scan.yml` / `turma-image-scan.yml` — build each image locally (no push) and
  Trivy-scan for CVEs + secrets (`ignore-unfixed`, HIGH/CRITICAL gate), path-filtered to their
  folder.
- `glasses-ci.yml` — path-filtered to `glasses/**`, typecheck + Vitest + production build in a
  throwaway `node:24-alpine` container.
- `android-ci.yml` — path-filtered to `android/**`, JVM unit tests + `assembleDebug`.

Because the images bundle third-party binaries, keep the pinned tool versions current — that's how
most CVEs are cleared. Non-actionable upstream base-image findings go in the root `.trivyignore` (a
reviewed triage list, each with a reason); anything unlisted still fails.

## The agent image's tiers

- **The image is tiered** (`AGENT_BASE`):
  - `:latest` is the `android-build` tier (2.0 GB), no emulator or system image (those cost 4.4 GB
    and nothing in CI or `android/` needs them).
  - To RUN an app, `adb connect` to a device or an emulator on a KVM-capable host (`platform-tools`
    is in the tier); that path is hardware-accelerated, unlike the bundled AVD (needs `/dev/kvm`
    passed).
  - If you need an in-container AVD, `:emulator` (the `android` tier, 6.4 GB,
    `ANDROID_EMULATOR_TAG`/`ANDROID_EMULATOR_ABI`) is built on demand via
    `agent-emulator-image.yml`.
- The cloud CLIs (terraform/`az`/`aws`) sit in the `tooling` stage so **every tier carries them and
  the CI scan covers them**. Details in `.claude/rules/agent-image.md`.

## Where jobs run

**Every workflow runs on GitHub-hosted `ubuntu-latest`**, including the image builds (their layer
cache is `type=gha`, GitHub-side, so it follows the job).

- Disk is the real constraint for the agent image, handled in-job: the scan writes **one** image
  copy (build straight to a docker-archive, `trivy --input`) instead of three, scans the slim
  `tooling` tier, and both agent jobs delete the runner's ~25 GB of unused preinstalled toolchains
  up front. That reclaim is only safe because those builds are hermetic — **don't copy it into
  `android-ci.yml`, which builds against the runner's own Android SDK.**
- Hosted bills **rounded UP per job**, so prefer fewer batched jobs.
- The self-hosted-box workarounds are **deleted, not disabled** — reintroducing any is a regression:
  "Reset workspace ownership" steps; per-job `DOCKER_CONFIG` scoping; `docker image prune` / `docker
  builder prune` cleanup; throwaway `node:24-alpine` containers for `npm view`; the
  `mingc/android-build-box` container. If a job genuinely needs self-hosted again, say which in a
  comment on its `runs-on` and bring back only the ones it needs.
- No GitHub Advanced Security, so no code-scanning API — findings live in the job log and
  `--exit-code` is the gate (no SARIF upload). Trivy is installed from its release tarball to
  `$HOME/.local/bin` (the trivy-action pins a step to a tag upstream deleted).
