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
- **An id at the hub's raw cap counts once its RENDERED cursor reaches the offered size**
  (`archiveRawSkip`): the hub keeps naming it (`rawBytes < r`) yet never takes more raw, so
  without this a repo holding one >128 MiB session could never be deleted (QA).
- While a delete waits the inventory is staged EVERY full beat, not only on refresh beats
  (every 15th), so a large backlog ships within `REPO_DELETE_SYNC_TIMEOUT_SEC`.
- A refused Start/Resume leaves an `error` record (which holds a slot); the beat kills any record
  of a deleting repo back into the closed history.
- Accepted: an id another host owns, or a rendered-blocked one, is not wanted by the hub and so
  reads confirmed; a full archive keeps wanting → the delete times out, and the error says so.
- A symlinked repo is unlinked, never followed; its target gets `git worktree prune` first.
- **Removal MOVES each tree into `REPOS_ROOT/.turma/deleting/` first, then rmtree's it there**
  (`<repo>.repo-…` / `<repo>.worktrees-…`), retrying `REPO_DELETE_RMTREE_ATTEMPTS`. Removed in
  place on a real host, the repo stayed in `scan_repos` and the agent's own per-beat `git status`
  wrote a lock into `.git` mid-rmtree: `rmdir .git` failed "Directory not empty" and the repo was
  left half-deleted (still listed, `.git` empty). Never go back to an in-place rmtree.
- Each removal first sweeps what an interrupted one left in that trash dir.
- A failed delete's note lingers `REPO_DELETE_ERROR_LINGER_SEC` (1h), a done one 5 min.
- Hub: 400 for the repos root, 409 for an agent that reports no `repoDeletes` array (it would ack
  and never act), 404 for a repo the host does not report. Web-only control (`android/PARITY.md`).
- Tests: `TestRepoDelete`; `XERK-2672:` in `server.test.js`; the Delete cases in
  `dashboard-prune.test.js`.
