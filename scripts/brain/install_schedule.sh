#!/usr/bin/env bash
# 安装/卸载外部大脑的 launchd 定时任务（macOS）：每 5 分钟对官方服务器跑一轮并写入 segment 90。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="local.screeps-brain"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# 守望（guard.py）：每 GUARD_INTERVAL 秒看一眼己方房的武装敌人，safe mode 决定有变化就只改 segment 里的 rooms[房].safeMode
GUARD_LABEL="$LABEL-guard"
GUARD_PLIST="$HOME/Library/LaunchAgents/$GUARD_LABEL.plist"
GUARD_INTERVAL="${BRAIN_GUARD_INTERVAL_SECONDS:-90}"
LOG_DIR="$ROOT/data/brain/logs"
PYTHON="$(command -v python3)"
# 母房默认留空：run.py 会从 Memory.rooms 自动识别己方房间（新占的房到 RCL4 就能自动分到外矿）；
# 首个占领目标已用 locks 固定，不再靠 --prefer-claim
HOMES="${BRAIN_HOMES:-}"
PREFER="${BRAIN_PREFER_CLAIM:-}"
INTERVAL="${BRAIN_INTERVAL_SECONDS:-300}"

if [ "${1:-install}" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)" "$GUARD_PLIST" 2>/dev/null || true
  rm -f "$PLIST" "$GUARD_PLIST"
  echo "uninstalled $LABEL and $GUARD_LABEL"
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
    <string>$ROOT/scripts/brain/run.py</string>
    <string>--radius</string><string>2</string>
$( [ -n "$HOMES" ] && printf '    <string>--homes</string><string>%s</string>\n' "$HOMES" )$( [ -n "$PREFER" ] && printf '    <string>--prefer-claim</string><string>%s</string>\n' "$PREFER" )    <string>--write</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/run.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/run.err</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL (every ${INTERVAL}s, homes=${HOMES:-auto}, prefer=${PREFER:-none}); logs in $LOG_DIR"

cat > "$GUARD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$GUARD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$ROOT/scripts/brain/guard.py</string>
$( [ -n "$HOMES" ] && printf '    <string>--homes</string><string>%s</string>\n' "$HOMES" )    <string>--write</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartInterval</key><integer>$GUARD_INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/guard.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/guard.err</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" "$GUARD_PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$GUARD_PLIST"
echo "installed $GUARD_LABEL (every ${GUARD_INTERVAL}s); logs in $LOG_DIR"
