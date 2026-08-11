#!/usr/bin/env bash
# Extract test fixtures from real Claude Code data and anonymize usernames.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_SESSIONS="$HOME/.claude/sessions"
SRC_PROJECTS="$HOME/.claude/projects"
REAL_USER="$(basename "$HOME")"

rm -rf "$ROOT/claude"
mkdir -p "$ROOT/claude/sessions"

# 1. Session registry: extract up to 3 files, replace home paths and usernames.
n=0
for f in "$SRC_SESSIONS"/*.json; do
  [ -f "$f" ] || continue
  sed "s|$HOME|/Users/testuser|g; s|$REAL_USER|testuser|g" "$f" \
    > "$ROOT/claude/sessions/$(basename "$f")"
  n=$((n+1)); [ $n -ge 3 ] && break
done

# 2. Transcript: extract largest file's head+tail 200 lines, anonymize paths and usernames.
#    Validate directory exists first — pipefail is disabled for just this pipeline because
#    `head -1` closes the read end early, which SIGPIPEs `ls` and would otherwise abort
#    the script under `set -e`. Not `|| true` — that would also swallow genuine errors.
if ! find "$SRC_PROJECTS" -type d >/dev/null 2>&1; then
  echo "Error: cannot access projects directory: $SRC_PROJECTS" >&2
  exit 1
fi
big=$(set +o pipefail
      find "$SRC_PROJECTS" -name '*.jsonl' -type f -print0 \
      | xargs -0 ls -S 2>/dev/null | head -1)
if [ -n "$big" ]; then
  slug=$(basename "$(dirname "$big")" | sed "s|$REAL_USER|testuser|g")
  mkdir -p "$ROOT/claude/projects/$slug"
  out="$ROOT/claude/projects/$slug/$(basename "$big")"
  { head -200 "$big"; tail -200 "$big"; } \
    | sed "s|$HOME|/Users/testuser|g; s|$REAL_USER|testuser|g" > "$out"
  echo "transcript fixture: $out ($(wc -l < "$out") 行)"
fi

echo "註冊表 fixture: $n 個"
echo "提醒：fixtures/claude/ 已列入 .gitignore，內容不會進版控。"
