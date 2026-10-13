#!/usr/bin/env python3
"""盯住线上各房"维修与编制"的趋势，判断 2026-09-10 那批问题是否真的在收敛。

只读 logs/status.jsonl（scripts/monitor.py 定时写的快照），不连游戏。

每房一行：builder 在岗/目标、射程外维修债（血）与处数、方案内道路最低血量比例、
控制器取能预算（cap/duty）、storage；并给出与最早样本相比的走向（债在降还是在涨）。

用法:
    python3 scripts/watch_rooms.py                 # 最近 24 条样本
    python3 scripts/watch_rooms.py --samples 72    # 更多历史
    python3 scripts/watch_rooms.py --json          # 机器可读
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, 'logs', 'status.jsonl')


def load_rows(n):
    if not os.path.exists(LOG):
        return []
    rows = []
    with open(LOG) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict) and isinstance(row.get('mon'), dict):
                rows.append(row)
    return rows[-n:]


def room_state(mon, name):
    for room in mon.get('rooms') or []:
        if room.get('name') == name:
            return room
    return None


def builders_for(mon, name):
    return sum(1 for creep in mon.get('creeps') or []
               if creep.get('home') == name and creep.get('role') == 'builder')


def series(rows, name):
    out = []
    for row in rows:
        mon = row.get('mon') or {}
        room = room_state(mon, name)
        if not room:
            continue
        state = room.get('state') if isinstance(room.get('state'), dict) else {}
        roads = room.get('roads') if isinstance(room.get('roads'), dict) else {}
        upgrade = room.get('upgrade') if isinstance(room.get('upgrade'), dict) else {}
        out.append({
            'at': row.get('at'),
            'tick': mon.get('t'),
            'version': mon.get('scriptV'),
            'builders': builders_for(mon, name),
            'builderTarget': state.get('builderTarget'),
            'repairDebt': state.get('builderRepairDebt'),
            'outOfReach': state.get('builderOutOfReach'),
            'roadsOnPlan': roads.get('onPlan'),
            'roadsOffPlan': roads.get('offPlan'),
            'minOnPlanRatio': roads.get('minOnPlanRatio'),
            'work': upgrade.get('work'),
            'cap': upgrade.get('cap'),
            'duty': upgrade.get('duty'),
            'low': upgrade.get('low'),
            'storage': room.get('storage'),
            'energy': room.get('energy'),
            'level': room.get('rcl'),
            'issues': (row.get('analysis') or {}).get('rooms'),
        })
    return out


def fmt(value, digits=0):
    if value is None:
        return 'n/a'
    if isinstance(value, float):
        return f'{value:.{digits}f}' if digits else f'{value:.0f}'
    return str(value)


def trend(first, last, key):
    a, b = first.get(key), last.get(key)
    if not isinstance(a, (int, float)) or not isinstance(b, (int, float)):
        return ''
    if b < a:
        return f'↓{a - b:g}'
    if b > a:
        return f'↑{b - a:g}'
    return '='


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--samples', type=int, default=24)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()

    rows = load_rows(max(1, args.samples))
    if not rows:
        print('没有可用的快照：先跑 python3 scripts/monitor.py', file=sys.stderr)
        return 2

    names = []
    for room in rows[-1]['mon'].get('rooms') or []:
        names.append(room.get('name'))
    report = {}
    for name in names:
        points = series(rows, name)
        if not points:
            continue
        report[name] = {'points': points, 'first': points[0], 'last': points[-1]}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
        return 0

    first_at = rows[0].get('at')
    last_at = rows[-1].get('at')
    print(f'样本 {len(rows)} 条：{first_at} → {last_at}（每房最后一条为该房最新状态）')
    header = ('房间', 'RCL', 'builder', '编制目标', '维修债(血)', '射程外', '方案内最低', '路 内/外', '控制器 work/cap/duty', 'storage')
    print('%-7s %3s %9s %8s %11s %7s %10s %10s %18s %9s' % header)
    for name, info in sorted(report.items()):
        last = info['last']
        ratio = last.get('minOnPlanRatio')
        ratio_text = f'{ratio * 100:.0f}%' if isinstance(ratio, (int, float)) else 'n/a'
        cap = last.get('cap')
        upgrade_text = f"{fmt(last.get('work'))}/{fmt(cap) if cap is not None else '不限'}/{fmt(last.get('duty'), 2)}"
        roads_text = f"{fmt(last.get('roadsOnPlan'))}/{fmt(last.get('roadsOffPlan'))}"
        print('%-7s %3s %9s %8s %11s %7s %10s %10s %18s %9s' % (
            name, fmt(last.get('level')), fmt(last.get('builders')), fmt(last.get('builderTarget')),
            fmt(last.get('repairDebt')), fmt(last.get('outOfReach')), ratio_text, roads_text,
            upgrade_text, fmt(last.get('storage'))))
        debt_trend = trend(info['first'], last, 'repairDebt')
        if debt_trend:
            print('        %-64s维修债 %s' % ('', debt_trend))
    return 0


if __name__ == '__main__':
    sys.exit(main())
