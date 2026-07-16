# Release scripts

The logic behind `.github/workflows/release.yml` (see `RELEASING.md` at the repo
root for the end-to-end release story). Kept here as small, testable Node
modules instead of inlined workflow bash — stdlib-only, zero npm dependencies,
matching the rest of the repo.

## Design

**Pure modules take data; one thin CLI layer does the I/O.** All `git`/`gh`
shell-outs are confined to `git.js`, so every module below it is unit-tested
offline in milliseconds (`.github/scripts/tests/*.test.js`, run by
`code-scan.yml`).

| File | Kind | Responsibility |
|------|------|----------------|
| `version.js` | pure | MAJOR.MINOR parse, tag-derived patch, android versionCode packing, the strictly-greater guard |
| `changes.js` | pure | the path→component map — the single source of truth shared by the build matrix and the changelog |
| `changelog.js` | pure | entry building, grouping by component, release-notes + CHANGELOG rendering |
| `manifest.js` | pure | `manifest.json` construction + the carry-forward decision |
| `git.js` | impure | the only `child_process`: git/gh wrappers + `$GITHUB_OUTPUT` |
| `collect.js` | impure | composes git+changes+changelog into entries for a range |
| `plan.js` | CLI | the `plan` job: compute version/tag/build-matrix → `$GITHUB_OUTPUT` |
| `publish.js` | CLI | the `publish` job: write `manifest.json`, `release-notes.md`, carry plan |
| `changelog-cli.js` | CLI | the `bump` job (minor/major): roll patches up into `CHANGELOG.md` |

## Version scheme

Root `VERSION` holds `MAJOR.MINOR` only. The **patch is derived from the
`v<M>.<m>.<p>` git tags** (max on that line + 1), never committed — so the
auto-patch path is read-only against the repo and can't re-trigger itself. One
tag namespace, `v<M>.<m>.<p>`, one release, all five components.

## CLI I/O contract (for release.yml)

- **`plan.js`** — in: `RELEASE_TYPE` (patch|minor|major), `FORCE_ALL`. out
  (`$GITHUB_OUTPUT`): `version`, `tag`, `prev_tag`, `changed` (json),
  `android_version_code`, `build_turma`/`build_agent_image`/`build_agent_native`/
  `build_glasses`/`build_android`, `base_major`, `base_minor`.
- **`publish.js`** — in: `VERSION_FULL`, `TAG`, `PREV_TAG`, `CHANGED` (json),
  `ANDROID_VERSION_CODE`, `COMMIT`, `RELEASED_AT`, `OUT_DIR`. out: writes
  `manifest.json`, `release-notes.md`, `carry-plan.json`; sets `carry`,
  `has_carry`.
- **`changelog-cli.js`** — in: `NEW_VERSION`, `BASE_MAJOR`, `BASE_MINOR`, `DATE`,
  `CHANGELOG_PATH`. out: rewrites `CHANGELOG.md` in place.
