#!/usr/bin/env bash
#
# Symlink the repo's skills (.claude/skills/<name>) into ~/.claude/skills so
# they load at user scope. Claude Code picks them up automatically when the
# working directory is this repo; the two other consumers do not:
#
#   - the partner assistant-api (Idea Watcher threads) runs headless `claude`
#     from its own directory and only sees user-scope skills;
#   - Nexus's own Claude engine sessions load user-scope skills when
#     engines.claude.setting_sources includes `user` (the baker-pro setting).
#
# Symlinks rather than copies, so `git pull` updates them. Same convention the
# partner uses for its own skills. Re-run after adding a skill; safe to re-run.
#
# Usage: ./scripts/link-skills.sh [--unlink]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.claude/skills"
DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
mkdir -p "$DEST"

for dir in "$SRC"/*/; do
  name="$(basename "$dir")"
  [ -f "$dir/SKILL.md" ] || continue
  target="$DEST/$name"
  if [ "${1:-}" = "--unlink" ]; then
    if [ -L "$target" ] && [ "$(readlink "$target")" = "${dir%/}" ]; then
      rm "$target" && echo "unlinked $name"
    fi
    continue
  fi
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "skip $name: $target exists and is not a symlink" >&2
    continue
  fi
  ln -sfn "${dir%/}" "$target"
  echo "linked $name -> ${dir%/}"
done
