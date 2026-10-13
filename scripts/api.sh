#!/usr/bin/env bash
# Screeps 官方 API 调用小工具：bash scripts/api.sh METHOD PATH [JSON_BODY]
# token 从 .env 读取，不落日志
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN=$(grep SCREEPS_AUTH_TOKEN "$ROOT/.env" | cut -d= -f2)
METHOD=${1:-GET}
PATH_=${2:-/api/user/world-status}
if [ "${METHOD}" = "GET" ]; then
  curl -s -m 20 -X GET -H "X-Token: $TOKEN" "https://screeps.com${PATH_}"
else
  if [ $# -ge 3 ]; then
    curl -s -m 20 -X "$METHOD" -H "X-Token: $TOKEN" -H "Content-Type: application/json" -d "$3" "https://screeps.com${PATH_}"
  else
    curl -s -m 20 -X "$METHOD" -H "X-Token: $TOKEN" "https://screeps.com${PATH_}"
  fi
fi
