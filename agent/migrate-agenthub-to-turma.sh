#!/usr/bin/env bash
# One-time on-disk state migration for the "Agent Hub" -> "Turma" rename.
#
# Renames the persisted registry, the worktree store, and the Claude Code
# transcript directories from the old `.agenthub` convention to `.turma`, and
# rewrites the now-stale worktree paths stored inside the session registry.
#
# Run this ONCE, with the Turma agent container STOPPED, in the environment that
# holds the agent's state (i.e. where $HOME and $REPOS_ROOT resolve to the same
# paths the container sees). Every step is guarded, so a partial/re-run is safe.
#
# Paths mirror hub-agent.py:
#   REGISTRY_DIR   = $HOME/.agenthub       -> $HOME/.turma          (sessions.json, closed.json, guard-settings.json)
#   WORKTREES_ROOT = $REPOS_ROOT/.agenthub -> $REPOS_ROOT/.turma    (.../worktrees/<id>)
#   PROJECTS_ROOT  = /root/.claude/projects (transcript dirs, slugged from the worktree cwd)
set -euo pipefail

REPOS_ROOT="${REPOS_ROOT:?set REPOS_ROOT to the git root the agent scans}"
HOME_DIR="${HOME:?}"
PROJECTS_ROOT="${CLAUDE_PROJECTS_ROOT:-/root/.claude/projects}"

move() { # src dst
  if [ -e "$1" ] && [ ! -e "$2" ]; then
    echo "mv $1 -> $2"; mv "$1" "$2"
  else
    echo "skip $1 (missing, or target already exists)"
  fi
}

# 1. Registry dir: session state + resumable history + guard settings.
move "$HOME_DIR/.agenthub" "$HOME_DIR/.turma"

# 2. Worktree store on the mounted git root.
move "$REPOS_ROOT/.agenthub" "$REPOS_ROOT/.turma"

# 3. Rewrite stale absolute worktree paths inside the moved registry JSONs, so
#    each session still points at its (now-.turma) worktree.
for j in "$HOME_DIR/.turma/sessions.json" "$HOME_DIR/.turma/closed.json"; do
  if [ -f "$j" ] && grep -q '/\.agenthub/' "$j"; then
    echo "rewrite $j (.agenthub -> .turma)"
    sed -i 's#/\.agenthub/#/.turma/#g' "$j"
  fi
done

# 4. Rename Claude Code transcript dirs so the post-move worktree slug resolves.
#    _project_slug maps every non-alphanumeric char to '-', so a worktree at
#    .../.agenthub/worktrees/<id> lands in a projects dir whose name contains
#    the literal substring 'agenthub'; swapping that to 'turma' matches the slug
#    the renamed worktree now produces, preserving each session's history/usage.
if [ -d "$PROJECTS_ROOT" ]; then
  for d in "$PROJECTS_ROOT"/*agenthub*; do
    [ -e "$d" ] || continue   # no matches -> literal glob, skip
    nd="$(dirname "$d")/$(basename "$d" | sed 's/agenthub/turma/g')"
    if [ ! -e "$nd" ]; then
      echo "mv $(basename "$d") -> $(basename "$nd")"; mv "$d" "$nd"
    fi
  done
fi

echo "Migration complete."
