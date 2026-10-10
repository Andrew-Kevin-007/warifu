#!/usr/bin/env bash
# Usage: scripts/spawn-worktree.sh 01            -> worktree ../symbolon-wt/wp-01 on branch wp-01/<slug>
# Creates an isolated checkout for one agent and prints the kickoff prompt path.
set -euo pipefail
WP="${1:?usage: spawn-worktree.sh <wp-number e.g. 01>}"
ROOT="$(git rev-parse --show-toplevel)"
PROMPT="$(ls "$ROOT"/kickoff/WP-"$WP"_*.md 2>/dev/null | head -1)"
[ -n "$PROMPT" ] || { echo "no kickoff prompt for WP-$WP"; exit 1; }
SLUG="$(basename "$PROMPT" .md | sed "s/^WP-${WP}_//")"
BRANCH="wp-${WP}/${SLUG}"
DEST="$ROOT/../symbolon-wt/wp-${WP}"
mkdir -p "$ROOT/../symbolon-wt"
git -C "$ROOT" worktree add -b "$BRANCH" "$DEST" main
echo "worktree : $DEST"
echo "branch   : $BRANCH"
echo "prompt   : $PROMPT"
echo "next     : cd $DEST && pnpm install && <start your agent with the prompt above>"
