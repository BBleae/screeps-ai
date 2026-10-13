#!/usr/bin/env python3
"""汇总本次会话的数据供可视化报告使用：监控时间线、部署版本、提交、私服验证、测试规模、大脑状态。

用法：python3 scripts/report/collect.py [--since '2026-09-02 20:00'] [--out data/report/report_data.json]
"""
import argparse
import glob
import json
import os
import re
import subprocess
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def monitor_timeline(since_epoch):
    rows = []
    path = os.path.join(ROOT, 'logs', 'status.jsonl')
    if not os.path.exists(path):
        return rows
    with open(path) as handle:
        for line in handle:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            at = entry.get('at')
            if isinstance(at, str):
                try:
                    at_epoch = time.mktime(time.strptime(at[:19], '%Y-%m-%d %H:%M:%S'))
                except ValueError:
                    continue
            else:
                at_epoch = float(at or 0)
            if at_epoch < since_epoch:
                continue
            mon = entry.get('mon') or {}
            analysis = entry.get('analysis') or {}
            room_rates = {r.get('name'): (r.get('rate') or {}) for r in analysis.get('rooms') or [] if isinstance(r, dict)}
            rooms = []
            for room in mon.get('rooms') or []:
                name = room.get('name')
                rate = room_rates.get(name) or {}
                upkeep = room.get('upkeep') or {}
                ctrl = upkeep.get('ctrlContainer') or {}
                sites = [s for s in room.get('sites') or [] if isinstance(s, dict)]
                spawn_site = next((s for s in sites if s.get('type') == 'spawn'), None)
                remotes = [r for r in room.get('remotes') or [] if isinstance(r, dict)]
                rooms.append({
                    'name': name, 'rcl': room.get('rcl'), 'progress': room.get('prog'), 'total': room.get('total'),
                    'spawnSite': {'progress': spawn_site.get('progress'), 'total': spawn_site.get('total')} if spawn_site else None,
                    'sites': {'count': len(sites), 'progress': sum(s.get('progress') or 0 for s in sites),
                              'total': sum(s.get('total') or 0 for s in sites)},
                    'remotes': [r.get('room') for r in remotes if r.get('enabled')],
                    'hostiles': (room.get('defense') or {}).get('hostiles'),
                    'energy': room.get('energy'), 'cap': room.get('cap'),
                    'rate': rate.get('value') if isinstance(rate, dict) else rate,
                    'ctrlContainer': ctrl.get('energy'),
                    'spawnBusy': (room.get('spawnUtil') or {}).get('busy'),
                })
            roles = {}
            for creep in mon.get('creeps') or []:
                roles[creep.get('role')] = roles.get(creep.get('role'), 0) + 1
            rows.append({
                'at': at, 'epoch': at_epoch, 'tick': mon.get('t'), 'version': mon.get('scriptV'),
                'errors': mon.get('errN'), 'cpu': (mon.get('cpu') or {}).get('used') if isinstance(mon.get('cpu'), dict) else mon.get('cpu'),
                'bucket': (mon.get('cpu') or {}).get('bucket') if isinstance(mon.get('cpu'), dict) else mon.get('bucket'),
                'rooms': rooms, 'roles': roles, 'issues': [i.get('text') if isinstance(i, dict) else str(i) for i in entry.get('issues') or []],
            })
    return rows


def git_commits(since):
    out = subprocess.run(['git', 'log', '--date=format:%Y-%m-%d %H:%M', '--format=%ad\t%h\t%s', '--since', since],
                         capture_output=True, text=True, cwd=ROOT).stdout
    commits = []
    for line in out.splitlines():
        parts = line.split('\t', 2)
        if len(parts) == 3:
            commits.append({'at': parts[0], 'hash': parts[1], 'subject': parts[2]})
    return commits


def log_sections():
    path = os.path.join(ROOT, 'logs', 'optimizations.md')
    sections = []
    if not os.path.exists(path):
        return sections
    current = None
    for line in open(path):
        if line.startswith('## '):
            current = {'title': line[3:].strip(), 'bullets': []}
            sections.append(current)
        elif line.startswith('- ') and current is not None:
            current['bullets'].append(line[2:].strip())
    return sections


def validation_runs(scratch_dirs):
    runs = []
    for scratch in scratch_dirs:
        for path in sorted(glob.glob(os.path.join(scratch, 'validation*.log'))):
            text = open(path, errors='ignore').read()
            match = re.search(r'exit=(\d+)', text)
            error = re.search(r'^Error: (.*)$', text, re.M)
            runs.append({'name': os.path.basename(path).replace('.log', ''), 'exit': int(match.group(1)) if match else None,
                         'ok': '"ok": true' in text, 'error': error.group(1)[:160] if error else None,
                         'at': time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(path)))})
    runs.sort(key=lambda r: int(re.sub(r'\D', '', r['name']) or 0))
    return runs


def test_counts():
    smoke = open(os.path.join(ROOT, 'test', 'smoke.js')).read()
    asserts = len(re.findall(r'^\s*assert\(', smoke, re.M))
    py = 0
    for path in glob.glob(os.path.join(ROOT, 'test', '*_test.py')):
        py += len(re.findall(r'^\s+def test_', open(path).read(), re.M))
    return {'smokeAsserts': asserts, 'pythonTests': py}


def brain_state():
    path = os.path.join(ROOT, 'data', 'brain', 'state.json')
    if not os.path.exists(path):
        return None
    state = json.load(open(path))
    homes = {}
    for home, info in state.get('homes', {}).items():
        plan = info.get('plan', {})
        homes[home] = {'level': info.get('level'), 'remotes': plan.get('remotes'), 'claim': (plan.get('claim') or {}).get('room'),
                       'intelRooms': len(info.get('intel', {})),
                       'blocked': (plan.get('analysis', {}).get('claim') or {}).get('blocked')}
    return {'tick': state.get('tick'), 'gcl': state.get('gcl'), 'me': state.get('me'), 'homes': homes,
            'apiCalls': state.get('apiCalls'), 'wrote': state.get('wrote')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--since', default='2026-09-02 20:00')
    parser.add_argument('--out', default=os.path.join(ROOT, 'data', 'report', 'report_data.json'))
    parser.add_argument('--scratch', action='append', default=[])
    args = parser.parse_args()
    since_epoch = time.mktime(time.strptime(args.since, '%Y-%m-%d %H:%M'))
    data = {
        'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        'since': args.since,
        'timeline': monitor_timeline(since_epoch),
        'commits': git_commits(args.since),
        'sections': log_sections(),
        'validations': validation_runs(args.scratch),
        'tests': test_counts(),
        'brain': brain_state(),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'w') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=1)
    print(json.dumps({'timeline': len(data['timeline']), 'commits': len(data['commits']), 'sections': len(data['sections']),
                      'validations': len(data['validations']), 'tests': data['tests'], 'out': args.out}, ensure_ascii=False))


if __name__ == '__main__':
    main()
