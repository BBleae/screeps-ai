#!/usr/bin/env python3
"""对比同一快照分叉出来的多个 RCL 基准跑（scripts/soak/rcl_benchmark.js --fork-world/--fork-db）。

用法：
    python3 scripts/soak/rcl_ab.py data/soak/rcl-fork-<A> data/soak/rcl-fork-<B> [--rooms W33S8,W35S7] [--out 报告.md]

每个跑读 run.json（srcRev/forkedFrom）、progress.jsonl（db 侧账本：gcl、acc、owned、roles、roomsMem、claims、spawnBuilt）
和 samples.jsonl（soakProbe：每房工地/建筑）。输出 Markdown：
- 总表：覆盖 tick、全账号 CP/tick、采集/孵化/建造 每 tick、平均 creep 数与角色数；
- 每房表：CP/tick、RCL 起止、storage 起→止（最低）、upgrader 目标均值——`--rooms` 指定的房单独列 storage 曲线（每 5k tick）；
- 无 spawn 的己方房时间线：spawn 工地进度 vs 道路工地进度/已建道路数（看 spawn 是否先于道路建成）；
- 母房收入账：自采（harvestByRoom）+ 外矿到货（按 Memory.rooms[母房].remotes 里 enabled 的房归属，多母房共享时均分）= 收入，与该房 CP 之比（CP/收入）区分"收入变少"与"效率变差"；
- link 时间线（每房）：首个 link 工地出现的 tick（samples.jsonl）、link 建成数随时间（owned.links）、link 能量均值（owned.linkE，老账本没有则空）；
- 各外矿净收益：采集 − 派往该房的 creep 孵化（acc.spawnByRemote，老账本没有则跳过），每 tick；
- 维护诊断（每房均值）：容器血量均值与最低值（容器 25 万血、每 500 tick 掉 5000）、塔能量均值——用来确认省运力/改权重没有把维修饿死；
- 运输诊断（每房均值）：地面掉落能量/堆数、源容器/控制器容器能量、hauler 数（haulerTasks 各类之和的均值）、hauler 取货来源比例（源容器/storage/掉落/投递/空闲；账本 haulerTasks，老账本没有则跳过）、feeder 均数与载货占比（账本 feeders）。
账本口径同 rcl_report.py：CP = 用户 gcl 增量，每房 CP = acc.upgradeByRoom 增量（分叉时归零）。
"""
import argparse
import json
import os
import sys


def load_jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def load_fork(run_dir):
    with open(os.path.join(run_dir, 'run.json'), encoding='utf-8') as fh:
        run = json.load(fh)
    rows = load_jsonl(os.path.join(run_dir, 'progress.jsonl'))
    samples = load_jsonl(os.path.join(run_dir, 'samples.jsonl'))
    if not rows:
        raise SystemExit('%s: progress.jsonl 为空' % run_dir)
    return {'dir': run_dir, 'run': run, 'rows': rows, 'samples': samples}


def label_of(fork):
    run = fork['run']
    rev = run.get('srcRev') or os.path.basename(fork['dir'])
    commit = (run.get('srcCommit') or '')[:7]
    return rev if not commit or rev.startswith(commit) else '%s(%s)' % (rev, commit)


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else 0.0


def per_room(fork):
    rows = fork['rows']
    first, last = rows[0], rows[-1]
    ticks = max(1, last['t'] - first['t'])
    names = []
    for row in rows:
        for name in (row.get('owned') or {}):
            if name not in names:
                names.append(name)
    out = {}
    for name in names:
        series = [(row['t'], row['owned'][name]) for row in rows if name in (row.get('owned') or {})]
        up0 = (first.get('acc', {}).get('upgradeByRoom') or {}).get(name, 0) or 0
        up1 = (last.get('acc', {}).get('upgradeByRoom') or {}).get(name, 0) or 0
        storages = [o.get('storage') or 0 for _, o in series]
        targets = [((row.get('roomsMem') or {}).get(name) or {}).get('targets') or {} for row in rows]
        upgr = [t.get('upgrader') for t in targets if t]
        out[name] = {
            'cpPerTick': (up1 - up0) / ticks,
            'cp': up1 - up0,
            'rclStart': series[0][1].get('rcl'), 'rclEnd': series[-1][1].get('rcl'),
            'progEnd': series[-1][1].get('prog'), 'progTotalEnd': series[-1][1].get('progTotal'),
            'storageStart': storages[0], 'storageEnd': storages[-1], 'storageMin': min(storages), 'storageMax': max(storages),
            'upgraderTarget': mean(upgr),
            'presentTicks': series[-1][0] - series[0][0],
            'spawnBuilt': (last.get('spawnBuilt') or {}).get(name),
            'claimedAt': (last.get('claims') or {}).get(name),
            'storageSeries': [(t, o.get('storage') or 0) for t, o in series],
        }
    return out


def totals(fork):
    rows = fork['rows']
    first, last = rows[0], rows[-1]
    ticks = max(1, last['t'] - first['t'])
    acc0, acc1 = first.get('acc', {}), last.get('acc', {})

    def delta(key):
        return (acc1.get(key) or 0) - (acc0.get(key) or 0)
    roles = {}
    for row in rows:
        for role, n in (row.get('roles') or {}).items():
            roles.setdefault(role, []).append(n)
    return {
        'tStart': first['t'], 'tEnd': last['t'], 'ticks': ticks,
        'cpPerTick': (last['gcl'] - first['gcl']) / ticks,
        'harvestPerTick': delta('harvest') / ticks,
        'spawnPerTick': delta('spawn') / ticks,
        'buildPerTick': delta('build') / ticks,
        'creepsAvg': mean([row.get('creeps') for row in rows]),
        'rolesAvg': {role: mean(v) for role, v in roles.items()},
        'ownedEnd': len(last.get('owned') or {}),
        'claims': dict(last.get('claims') or {}),
        'errorsEnd': last.get('errN'),
        'lastErr': last.get('lastErr'),
        'downgrades': last.get('downgrades'),
    }


def transport(fork):
    """每房运输诊断均值：掉落能量/堆数、源容器/控制器容器能量（owned 里每 50 tick 一条），hauler 任务分类占比（haulerTasks）。"""
    rows = fork['rows']
    if not rows or not any('srcCont' in o for o in (rows[-1].get('owned') or {}).values()):
        return None
    out = {}
    for row in rows:
        for name, o in (row.get('owned') or {}).items():
            d = out.setdefault(name, {'n': 0, 'drop': 0.0, 'dropN': 0.0, 'srcCont': 0.0, 'ctrlCont': 0.0, 'tasks': {}, 'feederN': 0, 'feederLoaded': 0,
                                     'contHits': 0.0, 'contN': 0.0, 'contMin': [], 'towerE': 0.0})
            d['n'] += 1
            d['contHits'] += o.get('contHits') or 0
            d['contN'] += o.get('contN') or 0
            d['towerE'] += o.get('towerE') or 0
            if o.get('contMinHits') is not None:
                d['contMin'].append(o['contMinHits'])
            f = ((row.get('feeders') or {}).get(name) or {})
            d['feederN'] += f.get('n', 0)
            d['feederLoaded'] += f.get('loaded', 0)
            for key in ('drop', 'dropN', 'srcCont', 'ctrlCont'):
                d[key] += o.get(key) or 0
            for cls, count in ((row.get('haulerTasks') or {}).get(name) or {}).items():
                d['tasks'][cls] = d['tasks'].get(cls, 0) + count
    result = {}
    for name, d in out.items():
        total = sum(d['tasks'].values())
        shares = {cls: (count / total if total else 0.0) for cls, count in d['tasks'].items()}
        result[name] = {'drop': d['drop'] / d['n'], 'dropN': d['dropN'] / d['n'], 'srcCont': d['srcCont'] / d['n'], 'ctrlCont': d['ctrlCont'] / d['n'],
                        'taskSamples': total, 'shares': shares, 'haulers': total / d['n'],
                        'feeders': d['feederN'] / d['n'], 'feederLoaded': (d['feederLoaded'] / d['feederN']) if d['feederN'] else None,
                        'contHitsAvg': (d['contHits'] / d['contN']) if d['contN'] else None,
                        'contMinHits': min(d['contMin']) if d['contMin'] else None, 'towerE': d['towerE'] / d['n']}
    return result


def income_by_home(fork):
    """每个己方房：自采 / 外矿到货 / 收入 / CP / CP÷收入，全部按 tick 均值。

    外矿归属取 Memory.rooms[母房].remotes 里 enabled 的记录（整段跑里出现过即算），同一外矿被多个母房列时按母房数均分——
    同快照的两次分叉之间，外矿采集有 ±5–15/tick 的分支差异（大脑白名单、InvaderCore），必须先扣掉它才能判断改动本身。
    """
    rows = fork['rows']
    if not rows:
        return {}
    first, last = rows[0], rows[-1]
    ticks = max(1, last['t'] - first['t'])
    acc0, acc1 = first.get('acc', {}), last.get('acc', {})

    def delta(name, room):
        return (acc1.get(name) or {}).get(room, 0) - (acc0.get(name) or {}).get(room, 0)
    owned = set(last.get('owned') or {})
    homes = {}
    for row in rows:
        for home, mem in (row.get('roomsMem') or {}).items():
            for entry in (mem.get('remotes') or []):
                if entry[1]:
                    homes.setdefault(entry[0], set()).add(home)
    out = {}
    for home in owned:
        own = delta('harvestByRoom', home) / ticks
        out[home] = {'own': own, 'remote': 0.0, 'remoteSpend': 0.0, 'cp': delta('upgradeByRoom', home) / ticks}
    for room, owners in homes.items():
        if room in owned:
            continue
        mine = [h for h in owners if h in out]
        if not mine:
            continue
        gross = delta('harvestByRoom', room) / ticks / len(mine)
        spend = delta('spawnByRemote', room) / ticks / len(mine)
        for home in mine:
            out[home]['remote'] += gross
            out[home]['remoteSpend'] += spend
    for info in out.values():
        info['income'] = info['own'] + info['remote']
        info['cpShare'] = (info['cp'] / info['income']) if info['income'] else None
    return out


def link_timeline(fork):
    """每房：首个 link 工地出现的相对 tick、link 建成数的变化点（相对 tick → 数量）、link 能量均值。"""
    rows = fork['rows']
    if not rows:
        return {}
    t0 = rows[0]['t']
    out = {}
    for row in rows:
        for name, o in (row.get('owned') or {}).items():
            d = out.setdefault(name, {'firstSite': None, 'built': [], 'linkE': [], 'linksEnd': 0})
            n = o.get('links') or 0
            if not d['built'] or d['built'][-1][1] != n:
                d['built'].append((row['t'] - t0, n))
            d['linksEnd'] = n
            if 'linkE' in o:
                d['linkE'].append(o['linkE'] or 0)
    for sample in fork['samples']:
        for name, room in (sample.get('rooms') or {}).items():
            if name not in out or out[name]['firstSite'] is not None:
                continue
            if any(s[0] == 'link' for s in (room.get('sites') or [])):
                out[name]['firstSite'] = sample['t'] - t0
    for d in out.values():
        d['linkEAvg'] = (sum(d['linkE']) / len(d['linkE'])) if d['linkE'] else None
        del d['linkE']
    return out


def per_remote(fork):
    """每个外矿房：采集/tick、派往该房的 creep 孵化/tick、净/tick（需要账本里有 spawnByRemote）。"""
    rows = fork['rows']
    first, last = rows[0], rows[-1]
    ticks = max(1, last['t'] - first['t'])
    acc0, acc1 = first.get('acc', {}), last.get('acc', {})
    if 'spawnByRemote' not in acc1:
        return None
    owned = set(last.get('owned') or {})
    rooms = set(acc1.get('spawnByRemote') or {}) | set(last.get('remoteRooms') or [])
    out = {}
    for room in rooms - owned:
        gross = (acc1.get('harvestByRoom') or {}).get(room, 0) - (acc0.get('harvestByRoom') or {}).get(room, 0)
        spend = (acc1.get('spawnByRemote') or {}).get(room, 0) - (acc0.get('spawnByRemote') or {}).get(room, 0)
        out[room] = {'gross': gross / ticks, 'spend': spend / ticks, 'net': (gross - spend) / ticks}
    return out


def spawnless_timeline(fork):
    """samples.jsonl 里 mine 且没有 spawn 建筑的房：spawn 工地进度 vs 道路工地进度/已建道路。"""
    timeline = {}
    for sample in fork['samples']:
        for name, room in (sample.get('rooms') or {}).items():
            if not room.get('mine'):
                continue
            structs = room.get('structs') or {}
            if structs.get('spawn'):
                if name in timeline:
                    timeline[name].append({'t': sample['t'], 'spawnDone': True, 'roads': structs.get('road', 0)})
                continue
            sites = room.get('sites') or []
            spawn_prog = sum(s[3] for s in sites if s[0] == 'spawn')
            spawn_total = sum(s[4] for s in sites if s[0] == 'spawn')
            road_prog = sum(s[3] for s in sites if s[0] == 'road')
            road_sites = sum(1 for s in sites if s[0] == 'road')
            timeline.setdefault(name, []).append({
                't': sample['t'], 'spawnDone': False, 'spawnSite': spawn_total > 0,
                'spawnProg': spawn_prog, 'spawnTotal': spawn_total,
                'roadProg': road_prog, 'roadSites': road_sites, 'roads': structs.get('road', 0),
            })
    # 只保留出现过无 spawn 状态的房，且截到 spawn 建成后的第一条
    out = {}
    for name, entries in timeline.items():
        if not any(not e['spawnDone'] for e in entries):
            continue
        trimmed = []
        for e in entries:
            trimmed.append(e)
            if e['spawnDone']:
                break
        out[name] = trimmed
    return out


def pct(value):
    return '-' if value is None else '%.0f%%' % (100 * value)


def fmt(value, digits=1):
    if value is None:
        return '-'
    if isinstance(value, float):
        return ('%.' + str(digits) + 'f') % value
    return str(value)


def fmt_k(value):
    if value is None:
        return '-'
    return '%.1fk' % (value / 1000.0)


def render(forks, focus_rooms):
    labels = [label_of(f) for f in forks]
    tot = [totals(f) for f in forks]
    rooms = [per_room(f) for f in forks]
    lines = []
    src = forks[0]['run'].get('forkedFrom') or {}
    lines.append('# 分叉 A/B：' + ' vs '.join(labels))
    lines.append('')
    lines.append('快照：`%s` @ tick %s；各跑覆盖 %s tick。' % (
        os.path.basename(src.get('dbFile') or src.get('worldDir') or '?'), src.get('tick'),
        ' / '.join(str(t['ticks']) for t in tot)))
    lines.append('')
    lines.append('## 总表')
    lines.append('')
    lines.append('| 指标 | ' + ' | '.join(labels) + ' |')
    lines.append('|---|' + '---|' * len(labels))
    metrics = [
        ('全账号 CP/tick', lambda t: fmt(t['cpPerTick'])),
        ('采集/tick', lambda t: fmt(t['harvestPerTick'])),
        ('孵化/tick', lambda t: fmt(t['spawnPerTick'])),
        ('建造/tick', lambda t: fmt(t['buildPerTick'])),
        ('creep 均数', lambda t: fmt(t['creepsAvg'])),
        ('upgrader 均数', lambda t: fmt(t['rolesAvg'].get('upgrader', 0))),
        ('hauler 均数', lambda t: fmt(t['rolesAvg'].get('hauler', 0))),
        ('courier 均数', lambda t: fmt(t['rolesAvg'].get('courier', 0))),
        ('己方房数（末）', lambda t: str(t['ownedEnd'])),
        ('期间占领', lambda t: ', '.join('%s@%s' % kv for kv in sorted(t['claims'].items(), key=lambda kv: kv[1])) or '无'),
        ('降级事件', lambda t: str(t['downgrades'] or 0)),
        ('错误数（末）', lambda t: str(t['errorsEnd'])),
    ]
    for name, fn in metrics:
        lines.append('| %s | %s |' % (name, ' | '.join(fn(t) for t in tot)))
    lines.append('')
    lines.append('## 每房 CP 与 storage')
    lines.append('')
    header = '| 房 | ' + ' | '.join('%s CP/tick | %s RCL | %s storage 起→止(低) | %s upgrader 目标' % (l, l, l, l) for l in labels) + ' |'
    lines.append(header)
    lines.append('|---|' + '---|' * (4 * len(labels)))
    names = []
    for r in rooms:
        for n in r:
            if n not in names:
                names.append(n)
    for name in names:
        cells = []
        for r in rooms:
            info = r.get(name)
            if not info:
                cells += ['-', '-', '-', '-']
                continue
            rcl = '%s→%s' % (info['rclStart'], info['rclEnd']) if info['rclStart'] != info['rclEnd'] else str(info['rclEnd'])
            cells += [fmt(info['cpPerTick']), rcl,
                      '%s→%s (%s)' % (fmt_k(info['storageStart']), fmt_k(info['storageEnd']), fmt_k(info['storageMin'])),
                      fmt(info['upgraderTarget'])]
        lines.append('| %s | %s |' % (name, ' | '.join(cells)))
    lines.append('')
    if focus_rooms:
        lines.append('## 重点房 storage 曲线（每 5k tick）')
        lines.append('')
        for name in focus_rooms:
            lines.append('### %s' % name)
            lines.append('')
            lines.append('| tick | ' + ' | '.join(labels) + ' |')
            lines.append('|---|' + '---|' * len(labels))
            series = [dict(r.get(name, {}).get('storageSeries', [])) for r in rooms]
            t0 = forks[0]['rows'][0]['t']
            t_end = max(f['rows'][-1]['t'] for f in forks)
            ticks = list(range(t0, t_end + 1, 5000))
            if ticks[-1] != t_end:
                ticks.append(t_end)
            for t in ticks:
                cells = []
                for s in series:
                    if not s:
                        cells.append('-')
                        continue
                    nearest = min(s.keys(), key=lambda k: abs(k - t))
                    cells.append(fmt_k(s[nearest]) if abs(nearest - t) <= 100 else '-')
                lines.append('| %s | %s |' % (t - t0, ' | '.join(cells)))
            lines.append('')
    transports = [transport(f) for f in forks]
    if any(t for t in transports):
        lines.append('## 运输诊断（每房均值；hauler 取货来源 = 处于该类任务的 hauler 采样占比）')
        lines.append('')
        lines.append('| 房 | ' + ' | '.join('%s 掉落(堆) | %s 源容器 | %s 控制器容器 | %s hauler 数 | %s hauler 源容器/storage/掉落/投递/空闲 | %s feeder(载货) | %s 容器血均(最低) | %s 塔能量' % ((l,) * 8) for l in labels) + ' |')
        lines.append('|---|' + '---|' * (8 * len(labels)))
        for name in names:
            cells = []
            for t in transports:
                info = (t or {}).get(name)
                if not info:
                    cells += ['-', '-', '-', '-', '-', '-', '-', '-']
                    continue
                sh = info['shares']
                share = '/'.join('%.0f%%' % (100 * sh.get(k, 0.0)) for k in ('srcContainer', 'storage', 'drop', 'deliver', 'idle'))
                feeder = '-' if not info['feeders'] else '%.1f (%.0f%%)' % (info['feeders'], 100 * (info['feederLoaded'] or 0))
                hits = '-' if info['contHitsAvg'] is None else '%s (%s)' % (fmt_k(info['contHitsAvg']), fmt_k(info['contMinHits']))
                cells += ['%s (%.1f)' % (fmt_k(info['drop']), info['dropN']), fmt_k(info['srcCont']), fmt(info['ctrlCont'], 0), fmt(info['haulers']), share, feeder, hits, fmt(info['towerE'], 0)]
            lines.append('| %s | %s |' % (name, ' | '.join(cells)))
        lines.append('')
    incomes = [income_by_home(f) for f in forks]
    lines.append('## 母房收入账（每 tick；外矿到货按 Memory.remotes 归属，多母房均分）')
    lines.append('')
    lines.append('| 房 | ' + ' | '.join('%s 自采 | %s 外矿 | %s 收入 | %s CP | %s CP/收入' % (l, l, l, l, l) for l in labels) + ' |')
    lines.append('|---|' + '---|' * (5 * len(labels)))
    for name in names:
        cells = []
        for inc in incomes:
            info = inc.get(name)
            if not info:
                cells += ['-', '-', '-', '-', '-']
                continue
            cells += [fmt(info['own']), fmt(info['remote']), fmt(info['income']), fmt(info['cp']), pct(info['cpShare'])]
        lines.append('| %s | %s |' % (name, ' | '.join(cells)))
    lines.append('')
    timelines = [link_timeline(f) for f in forks]
    lines.append('## link 时间线（首个 link 工地的相对 tick；建成数变化点；link 能量均值）')
    lines.append('')
    lines.append('| 房 | ' + ' | '.join('%s 首个工地 | %s 建成数变化 | %s link 能量均值' % (l, l, l) for l in labels) + ' |')
    lines.append('|---|' + '---|' * (3 * len(labels)))
    for name in names:
        cells = []
        for tl in timelines:
            info = tl.get(name)
            if not info:
                cells += ['-', '-', '-']
                continue
            built = ' → '.join('%d@%d' % (n, t) for t, n in info['built'][1:]) or str(info['built'][0][1])
            cells += ['-' if info['firstSite'] is None else str(info['firstSite']), built, '-' if info['linkEAvg'] is None else fmt(info['linkEAvg'], 0)]
        lines.append('| %s | %s |' % (name, ' | '.join(cells)))
    lines.append('')
    remotes = [per_remote(f) for f in forks]
    if any(r for r in remotes):
        lines.append('## 各外矿净收益（每 tick；采集 − 派往该房的 creep 孵化）')
        lines.append('')
        lines.append('| 外矿 | ' + ' | '.join('%s 采集 | %s 孵化 | %s 净' % (l, l, l) for l in labels) + ' |')
        lines.append('|---|' + '---|' * (3 * len(labels)))
        names = sorted({n for r in remotes if r for n in r}, key=lambda n: -max((r[n]['net'] for r in remotes if r and n in r), default=0))
        for name in names:
            cells = []
            for r in remotes:
                info = (r or {}).get(name)
                cells += ['-', '-', '-'] if not info else [fmt(info['gross']), fmt(info['spend']), fmt(info['net'])]
            lines.append('| %s | %s |' % (name, ' | '.join(cells)))
        lines.append('')
    lines.append('## 无 spawn 房的建造顺序')
    lines.append('')
    any_room = False
    for label, fork in zip(labels, forks):
        tl = spawnless_timeline(fork)
        if not tl:
            continue
        any_room = True
        for name, entries in tl.items():
            lines.append('### %s — %s' % (label, name))
            lines.append('')
            lines.append('| tick | spawn 工地 | 道路工地进度/数 | 已建道路 |')
            lines.append('|---|---|---|---|')
            for e in entries:
                if e['spawnDone']:
                    lines.append('| %s | 建成 | - | %s |' % (e['t'], e['roads']))
                else:
                    spawn = '%s/%s' % (e['spawnProg'], e['spawnTotal']) if e['spawnSite'] else '无工地'
                    lines.append('| %s | %s | %s/%s | %s |' % (e['t'], spawn, e['roadProg'], e['roadSites'], e['roads']))
            lines.append('')
    if not any_room:
        lines.append('期间没有出现过无 spawn 的己方房。')
        lines.append('')
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('runs', nargs='+', help='分叉跑目录（同一快照）')
    parser.add_argument('--rooms', default='', help='重点房，逗号分隔，单独列 storage 曲线')
    parser.add_argument('--out', help='写到文件（默认打印）')
    args = parser.parse_args(argv)
    forks = [load_fork(d) for d in args.runs]
    focus = [r for r in args.rooms.split(',') if r]
    text = render(forks, focus)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            fh.write(text + '\n')
        print('written', args.out)
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
