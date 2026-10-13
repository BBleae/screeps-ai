#!/usr/bin/env bash
# 安装/卸载"顶级玩家持续观察"的 launchd 定时任务（macOS）：默认每 6 小时抓一轮 Kalgen 并重生成 docs/observe/kalgen.md。
#   bash scripts/observe/install_schedule.sh            # 安装（OBSERVE_PLAYER / OBSERVE_INTERVAL_SECONDS 可覆盖）
#   bash scripts/observe/install_schedule.sh uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="local.screeps-observe"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/data/observe/logs"
PYTHON="$(command -v python3)"
PLAYER="${OBSERVE_PLAYER:-Kalgen}"
INTERVAL="${OBSERVE_INTERVAL_SECONDS:-21600}"

if [ "${1:-install}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "uninstalled $LABEL"
  exit 0
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$ROOT/scripts/observe/run.py</string>
    <string>all</string>
    <string>--player</string><string>$PLAYER</string>
    <string>--self</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_DIR/run.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/run.err</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every ${INTERVAL}s, player=$PLAYER); logs in $LOG_DIR"
