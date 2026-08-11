#!/usr/bin/env bash
# 從本機真實 Claude Code 資料建立測試 fixture，並將使用者名稱匿名化。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_SESSIONS="$HOME/.claude/sessions"
SRC_PROJECTS="$HOME/.claude/projects"
REAL_USER="$(basename "$HOME")"

rm -rf "$ROOT/claude"
mkdir -p "$ROOT/claude/sessions"

# 1. 註冊表：取最多 3 個，將 home 路徑與使用者名稱換掉
n=0
for f in "$SRC_SESSIONS"/*.json; do
  [ -f "$f" ] || continue
  sed "s|$HOME|/Users/testuser|g; s|$REAL_USER|testuser|g" "$f" \
    > "$ROOT/claude/sessions/$(basename "$f")"
  n=$((n+1)); [ $n -ge 3 ] && break
done

# 2. Transcript：取最大的一份的頭 200 行與尾 200 行，保留結構但縮小體積
big=$(find "$SRC_PROJECTS" -name '*.jsonl' -type f -print0 \
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
