#!/usr/bin/env bash
# 从 reference/screeps-docs 克隆中重新提取官方文档到 docs/
# 用法: 在仓库根目录运行  bash scripts/sync-docs.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/reference/screeps-docs/source"
API="$ROOT/reference/screeps-docs/api/source"

[ -d "$SRC" ] || { echo "错误: 未找到 $SRC，先克隆 https://github.com/screeps/docs 到 reference/screeps-docs" >&2; exit 1; }

rm -rf "$ROOT/docs/game" "$ROOT/docs/api"
mkdir -p "$ROOT/docs/game/contributed" "$ROOT/docs/api/inherited"

for f in "$SRC"/*.md; do
  b="$(basename "$f")"
  case "$b" in tos.md|privacy-policy.md) continue ;; esac
  cp "$f" "$ROOT/docs/game/"
done
cp "$SRC"/contributed/*.md "$ROOT/docs/game/contributed/" 2>/dev/null || true

cp "$API"/*.md "$ROOT/docs/api/"
cp "$API"/inherited/*.md "$ROOT/docs/api/inherited/" 2>/dev/null || true

echo "已同步: game $(find "$ROOT/docs/game" -name '*.md' | wc -l | tr -d ' ') 个, api $(find "$ROOT/docs/api" -name '*.md' | wc -l | tr -d ' ') 个"
