#!/usr/bin/env bash
# 定时监控（launchd 每 30 分钟）：采集一轮线上快照，再打一份"维修与编制"的趋势摘要。
#
#   logs/status.jsonl   完整快照历史（scripts/monitor.py 写；退出码 1 = 有未被心跳确认的新增/升级/未认领紧急事件
#                       （本 cron 用 --no-ack 只记账不确认），
#                       0 = 没有新情况但账本里可能仍有长期未结事件，2 = 未采到可靠结果）
#   logs/monitor.log    每轮的文本摘要（含 ⚠ 异常清单）
#   logs/watch.log      各房"builder 编制 / 射程外维修债 / 方案内道路最低血量 / 控制器取能预算"趋势表
#
# 两个采集不重叠：monitor.py 自带 flock，上一轮没跑完时本轮跳过（退出码 2 = 未采集，不是健康）。
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2  # 进不了目录 = 未采集，不是"有异常"
PY=${SCREEPS_MONITOR_PYTHON:-python3}
[ -x "$PY" ] || PY=python3

rotate() {
    local file="$1" keep="$2"
    [ -f "$file" ] || return 0
    local lines
    lines=$(wc -l < "$file" | tr -d ' ')
    if [ "$lines" -gt "$keep" ]; then
        tail -n "$keep" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
    fi
}

{
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
    # --no-ack：cron 只记账不确认，告警留给每小时心跳（monitor.py --samples 3）消费并确认。
    "$PY" scripts/monitor.py --no-ack
    monitor_status=$?
    echo "monitor exit=$monitor_status"
} >> logs/monitor.log 2>&1

{
    echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
    "$PY" scripts/watch_rooms.py --samples 48
    echo "watch exit=$?"
} >> logs/watch.log 2>&1

rotate logs/monitor.log 4000
rotate logs/watch.log 4000

# The collector owns the health result; trend rendering/rotation must not erase it.
exit "$monitor_status"
