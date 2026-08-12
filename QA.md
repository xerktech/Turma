# QA.md — how to QA this repo (durable knowledge, no findings)

## agent/ (per-host session manager, python stdlib-only)

- Tests: from repo root `python3 -m unittest discover -s agent/tests` (~1260 tests, ~16s).
  stdlib `unittest` only — there is deliberately no pytest (image has no pip; don't install it).
- Single class: `cd agent && python3 -m unittest tests.test_hub_agent.TestMrStatus -v`.
- `hub-agent.py` has a dash in its name — import it in harnesses via
  `importlib.util.spec_from_file_location("hub_agent", ".../agent/hub-agent.py")`
  (exactly what `agent/tests/test_hub_agent.py` does; copy its `write_jsonl` helpers).
- Guard hook is importable the same way: `agent/hooks/guard.py`, pure function surface is
  `policy_reason(cmd)` / `decide(...)`; tests `python3 -m unittest tests.test_guard`.
- Module-level env-derived constants (`GITLAB_URL`, `GITLAB_TOKEN`, …) are read at import
  time — patch `ha.GITLAB_URL = ...` directly in a harness, not `os.environ`.
- `agent/tests/test_install_sudo.sh` FAILS on this host when run as root (3 cases: sudo
  answers without a tty/decline) — identical on pristine HEAD; not a change regression.
  Diff its output against a `git stash` run of HEAD before blaming a change.
- `install.sh` functions test standalone: `sed -n '/^ensure_X() {/,/^}/p'` into a harness
  that stubs `have`/`info`/`warn`, sets `PREFIX`/version vars, under `set -euo pipefail`.

## turma/ (hub, node, no npm deps)

- Tests: `cd turma && node --test tests/*.test.js` (~930 tests, ~6s).
  TRAP: `node --test tests/` (bare dir) FAILS — it picks up a non-test file. Use the glob.
- Hub modules dual-export for tests; no build step, no node_modules.
- All three `prBadgeHtml` copies are test-covered: `chat.js` via chat.test.js, the
  `sessions.html` inline copy via sessions.test.js's `loadPage` return list, the
  `index.html` inline copy via dashboard-livestate.test.js's `__dash` export. When adding
  an inline-page function to a test, expose it through those harnesses the same way.

## glasses/

- `glasses/src/vendor/chat.cjs`+`board.cjs` AND `veiller/src/ui/vendor/chat.cjs`+`board.cjs`
  are COMMITTED byte-for-byte copies of `turma/public/chat.js`/`board.js`, each enforced by
  its own `vendor.test.ts`. TRAP: a PR editing chat.js/board.js without re-copying BOTH
  merges green when the path filters don't fire and breaks the NEXT glasses/veiller PR.
  Sweep with `find . -name chat.cjs` + `cmp` against the source.
- `glasses/src/phone/render.ts` AND `veiller/src/ui/phone/render.ts` each carry a
  hand-ported `prBadgeHtml` — chip renderers beside web ×3 + android; check both whenever
  the chip changes.
- Vitest needs npm install; not runnable on the TrueNAS host — rely on glasses-ci.yml.

## android/

- JVM unit tests need Gradle + JDK17 + Android SDK — NOT runnable on the TrueNAS host
  (no apt, ro /usr). Rely on `android-ci.yml` (`gh pr checks <n>`), or a container host
  with the `turma-agent:latest` image (it bundles the toolchain).

## This TrueNAS host (where QA sessions usually run)

- No apt, `/usr` read-only. ALL of `/tmp` is noexec INCLUDING the session scratchpad
  (`/tmp/claude-0/...`) — executable scratch (downloaded binaries, scripts run via
  shebang paths that need exec) goes under `/root/.cache/<qa-dir>`; delete it after.
  Plain `bash script.sh` works from noexec paths (the interpreter reads, not execs).
- shellcheck is at `/root/.local/bin/shellcheck`; node + python3 present and work.
- The host's own turma agent is NATIVE (systemd `turma-agent.service`), not Docker.
  Deployed runtime: `/root/.local/share/turma-agent/` (`VERSION` stamp says what's live;
  grep its `hub-agent.py` to confirm a change actually shipped). Env:
  `/root/.config/turma-agent/turma-agent.env` (chmod 600 — never print values).
  State: `/root/.turma` → symlink to `/mnt/data/Docker/Turma-agent`.
- Native installs carry NO `glab` unless installed by the new `ensure_glab` — check tool
  presence before assuming image-parity on this host.
- The hub is the `turma` container (compose in `/mnt/data/Docker/git/DockerOps/compose/turma.yaml`),
  public URL `https://turma.xerktech.com`, HTTP basic auth (creds live in that compose file —
  reading them out with shell has been blocked by the permission classifier; ask the operator
  if a live fleet-payload check is needed).
- `gh` works authenticated on this host (`gh pr checks`, `gh run list --repo xerktech/turma`).
- Mutating a working-tree file for a mutation test: back it up with `cp`, NEVER restore
  with `git checkout --` — the changes under QA are often uncommitted and checkout
  destroys them. Byte-verify the tree afterward against a saved `git diff`.

## GitLab-related QA

- Real-API fixtures: gitlab.com public projects answer anonymously, e.g.
  `curl -s "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/merge_requests/<iid>"` —
  the single-MR GET includes `head_pipeline`/`detailed_merge_status`; the LIST endpoint
  does NOT include `head_pipeline`. Private projects 404 anonymously (not 403).
- glab CLI source (for output-format questions): read raw files at
  `https://gitlab.com/gitlab-org/cli/-/raw/v<ver>/...`; non-TTY `mr create` prints the
  bare MR web URL (`internal/commands/mr/mrutils/mrutils.go` `DisplayMR`).
- glab env contract (verified live on the 1.111.0 binary): token from
  `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`; host from `GITLAB_HOST`/`GITLAB_URI`/`GL_HOST` —
  glab does NOT read the agent's `GITLAB_URL`. `glab auth status` says "not
  authenticated" for an env-token host but API calls still send the env token.
- Static glab release URL (works, verified):
  `https://gitlab.com/gitlab-org/cli/-/releases/v<V>/downloads/glab_<V>_linux_<amd64|arm64>.tar.gz`,
  binary at tar member `bin/glab`.
- GitLab push-option semantics (server source, `lib/gitlab/push_options.rb` +
  `app/services/merge_requests/push_options_handler_service.rb`): `-o name=value` is
  parsed for EVERY option and any non-empty string value is truthy — so
  `merge_request.auto_merge=true` (and even `=false`) arms auto-merge like the bare form.
  Any guard matching push options must match the `name` prefix, not the exact token.

## Blast radius notes

- PR-chip pipeline spans: agent scan (`_scan_pr_line`) → `session_pr_urls`/`prUrls` →
  `pr_status_cache` + two ledgers (`pr-sessions.json`, `pr-status.json`) → hub
  `session.prs` → three web renderers (`index.html`, `sessions.html`, `chat.js`
  `prBadgeHtml`/`prBadge`) + android `CommonUi.kt` + glasses (`vendor/chat.cjs` copy AND
  `phone/render.ts`) → hub alerts (`prAlertDecision` in `turma/server.js`). A URL-shape
  or label change must be checked at every stage.
