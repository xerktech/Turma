---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "turma/server.js"
  - "turma/public/index.html"
  - "turma/tests/dashboard-prune.test.js"
---

# Deleting a repo from a host (XERK-2672)

`POST /api/agents/<host>/repos/<repo>/delete` → `{type:"deleteRepo", repo}` → `delete_repo`.
Progress rides the heartbeat as `repoDeletes: [{repo, status, error, summary, at}]`.

- **Nothing is removed until the hub's archive holds every transcript of the repo.** Order:
  - beat: refuse (root, unscanned, cloning, pruning, a migration into it), mark `syncing` FIRST,
    then `kill` every session of the repo (kill keeps worktree + transcript, so a later give-up
    leaves them resumable);
  - each inventory build puts the repo's unconfirmed transcripts at the window's head and reports
    the ids in its slugs (`_note_repo_delete_build` sets `total`);
  - each reply confirms an id the shipped inventory OFFERED that `archiveHave` does NOT name
    (`inventoryCursors` names exactly what the hub is short of, rendered or raw);
  - `total ⊆ confirmed` → `deleting`, a worker rmtree's `WORKTREES_ROOT/<repo>` then
    `REPOS_ROOT/<repo>`; past `REPO_DELETE_SYNC_TIMEOUT_SEC` → `error`, nothing removed.
- **A reply with no `archiveHave` confirms nothing** (older hub, hydrating index): absence is
  "can't tell". An empty `{}` is a real answer (hub short of nothing).
- **Only a build staged after the kills counts** (`minSeq` vs `_inventory_seq`), and never one
  in which a repo slug was live: `running` OR `defer_raw` — a live worktree session sits in
  `defer_raw` with `r` sent as 0, so its raw files would read as held.
- **Transcripts are never deleted**: they live under `PROJECTS_ROOT`, outside the repo, so usage
  keeps counting them (ledger entries with a `remote` keep their repo attribution).
- While `syncing`/`deleting` no session may launch in the repo (`_launch_tmux` raises, `spawn`
  refuses via `_refuse_start`), and clone/prune of it refuse.
- Accepted: an id another host owns, or a rendered-blocked one, is not wanted by the hub and so
  reads confirmed; a full archive keeps wanting → the delete times out (safe direction).
- Hub: 409 for an agent that reports no `repoDeletes` array (it would ack and never act); 404 for
  a repo the host does not report. Web-only control (`android/PARITY.md`).
- Tests: `TestRepoDelete`; `XERK-2672:` in `server.test.js`; the Delete cases in
  `dashboard-prune.test.js`.
