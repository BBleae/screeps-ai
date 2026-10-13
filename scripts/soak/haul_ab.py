#!/usr/bin/env python3
"""运输饱和度 A/B：同一快照分叉的若干跑（scripts/soak/rcl_benchmark.js --fork-world/--fork-db），按 src/haul_stats.js 的累计计数比较
每只运输型 creep 的饱和度。账本行（progress.jsonl）里的 haul 字段是 Memory.haulStats（母房 × 角色的累计值），取窗口两端之差：

  只数    = t / 窗口 tick（窗口内平均在岗只数）
  饱和度  = 1 − idle / t（没挪位且载货不变的 tick 占比；被 CPU 跳过的 tick 也算 idle）
  空等    = idleE / t（空载原地）   满等 = idleL / t（载货原地）
  空跑    = mvE / t                载货行进 = mvL / t，装载率 = lf / mvL（载货行进时平均几成满）
  动作    = (ld + ul) / t，其中同 tick 挪位的比例 = ch / (ld + ul)
  货物行进 = cu / t（所有挪位 tick 的平均装载率 × 挪位占比；来回穿梭理想值约 0.5）  出发装载率 = df / dep
  倒腾    = churn / 窗口 tick（从 storage 取出又送回 storage 的量）
  运量    = out / 窗口 tick（每 tick 送出的能量），单位运量 = out × 50 / cap（每个 CARRY 每 tick 送出的能量）
  原因    = rs 各原因（park 没活靠边 / full 满载无处投 / wait 在取货点等货）占 t 的比例

另附账本侧的经济背景（不依赖 bot 自报）：每房 CP/tick、源容器与地面掉落能量均值、hauler/remoteHauler 的孵化花费。
用法：python3 scripts/soak/haul_ab.py <forkA> <forkB> [--warmup 2000] [--out docs/benchmarks/<日期>-haul-ab.md]
"""
import argparse
import json
import os
import sys

ROLES = ('hauler', 'remoteHauler', 'feeder', 'courier', 'operator')


def load_rows(run_dir):
    rows = []
    path = os.path.join(run_dir, 'progress.jsonl')
    if not os.path.exists(path):
        raise SystemExit('%s: 没有 progress.jsonl' % run_dir)
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    if not rows:
        raise SystemExit('%s: progress.jsonl 为空' % run_dir)
    return rows


def label_of(run_dir):
    try:
        with open(os.path.join(run_dir, 'run.json'), encoding='utf-8') as fh:
            run = json.load(fh)
        rev = run.get('srcRev') or os.path.basename(run_dir)
        commit = (run.get('srcCommit') or '')[:7]
        return rev if not commit or rev.startswith(commit) else '%s(%s)' % (rev, commit)
    except (OSError, ValueError):
        return os.path.basename(run_dir.rstrip('/'))


def window(rows, warmup, until=None):
    """窗口两端：起点 = 分叉后 warmup tick 之后第一条带 haul 的行，终点 = 最后一条带 haul 的行（until 给出时不超过 until tick）"""
    start_t = rows[0]['t'] + max(0, warmup)
    with_haul = [row for row in rows if isinstance(row.get('haul'), dict) and row['haul'].get('rooms') is not None]
    if until is not None:
        with_haul = [row for row in with_haul if row['t'] <= rows[0]['t'] + until]
    usable = [row for row in with_haul if row['t'] >= start_t]
    if len(usable) < 2:
        return None, None
    return usable[0], usable[-1]


def counters(row, home, role):
    rooms = ((row or {}).get('haul') or {}).get('rooms') or {}
    return (rooms.get(home) or {}).get(role) or {}


def diff(a, b):
    out = {}
    for key in set(a) | set(b):
        va, vb = a.get(key), b.get(key)
        if isinstance(va, dict) or isinstance(vb, dict):
            out[key] = diff(va or {}, vb or {})
        else:
            out[key] = (vb or 0) - (va or 0)
    return out


def metrics(delta, ticks):
    t = delta.get('t') or 0
    if t <= 0:
        return None
    acts = (delta.get('ld') or 0) + (delta.get('ul') or 0)
    mv_l = delta.get('mvL') or 0
    cap = delta.get('cap') or 0
    reasons = delta.get('rs') or {}
    return {
        'carriers': t / ticks,
        'busy': 1 - (delta.get('idle') or 0) / t,
        'idleE': (delta.get('idleE') or 0) / t,
        'idleL': (delta.get('idleL') or 0) / t,
        'fat': (delta.get('fat') or 0) / t,
        'mvE': (delta.get('mvE') or 0) / t,
        'mvL': mv_l / t,
        'load': (delta.get('lf') or 0) / mv_l if mv_l else None,
        'acts': acts / t,
        'chain': (delta.get('ch') or 0) / acts if acts else None,
        'cargo': (delta.get('cu') or 0) / t,
        'depFill': (delta.get('df') or 0) / delta['dep'] if delta.get('dep') else None,
        'churnPerTick': (delta.get('churn') or 0) / ticks,
        'outPerTick': (delta.get('out') or 0) / ticks,
        'perCarry': (delta.get('out') or 0) * 50 / cap if cap else None,
        'reasons': {k: v / t for k, v in reasons.items() if v},
        # v2（按动作钩子 / 事件序列；v1 数据里这些键不存在时为 None）
        'v2': 'ac' in delta,
        'actMove': (delta.get('acm') or 0) / delta['ac'] if delta.get('ac') else None,
        'trickle': (delta.get('tw') or 0) / t if 'tw' in delta else None,
        'parkWalk': (delta.get('mvP') or 0) / t if 'mvP' in delta else None,
        'aborted': ((delta.get('abL') or 0) + (delta.get('abE') or 0)) / t if 'abL' in delta else None,
        'detourLoaded': (delta.get('lgS') or 0) / delta['lgD'] if delta.get('lgD') else None,
        'detourEmpty': (delta.get('egS') or 0) / delta['egD'] if delta.get('egD') else None,
        'partialDep': (delta.get('dp8') or 0) / delta['dep'] if delta.get('dep') and 'dp8' in delta else None,
        'idleWaste': (delta.get('idWa') or 0) / t if 'idWa' in delta else None,
        'idleStarved': (delta.get('idSt') or 0) / t if 'idSt' in delta else None,
        'idleFull': (delta.get('idOv') or 0) / t if 'idOv' in delta else None,
        'lostPerLife': (delta.get('lostAge') or 0) * 1500 / t if 'lostAge' in delta else None,
    }


def room_metrics(delta):
    ticks = delta.get('ticks') or 0
    if ticks <= 0:
        return None
    return {'refills': delta.get('rfN') or 0,
            'refillTicks': (delta.get('rfT') or 0) / delta['rfN'] if delta.get('rfN') else None,
            'refillDeficit': (delta.get('rfD') or 0) / delta['rfN'] if delta.get('rfN') else None,
            'ctrlLinkFull': (delta.get('lkF') or 0) / ticks, 'srcLinkFull': (delta.get('lsF') or 0) / ticks,
            'spawnWaiting': (delta.get('spW') or 0) / ticks}


def line_metrics(delta, ticks):
    t = delta.get('t') or 0
    if t <= 0:
        return None
    return {'carriers': t / ticks, 'busy': 1 - (delta.get('idle') or 0) / t, 'trickle': (delta.get('tw') or 0) / t,
            'actMove': (delta.get('acm') or 0) / delta['ac'] if delta.get('ac') else None,
            'depFill': (delta.get('df') or 0) / delta['dep'] if delta.get('dep') else None,
            'perCarry': (delta.get('out') or 0) * 50 / delta['cap'] if delta.get('cap') else None,
            'outPerTick': (delta.get('out') or 0) / ticks, 'lost': delta.get('lostAge') or 0}


def ledger(rows, first, last):
    """账本侧背景：每房 CP/tick（控制器进度增量）、源容器与地面掉落均值，按角色的孵化花费"""
    ticks = max(1, last['t'] - first['t'])
    inside = [row for row in rows if first['t'] <= row['t'] <= last['t']]
    up0 = (first.get('acc') or {}).get('upgradeByRoom') or {}
    up1 = (last.get('acc') or {}).get('upgradeByRoom') or {}
    rooms = {}
    for row in inside:
        for name, o in (row.get('owned') or {}).items():
            d = rooms.setdefault(name, {'n': 0, 'srcCont': 0.0, 'drop': 0.0, 'storage': 0.0})
            d['n'] += 1
            d['srcCont'] += o.get('srcCont') or 0
            d['drop'] += o.get('drop') or 0
            d['storage'] += o.get('storage') or 0
    per_room = {}
    for name, d in rooms.items():
        per_room[name] = {'cp': ((up1.get(name) or 0) - (up0.get(name) or 0)) / ticks,
                          'srcCont': d['srcCont'] / d['n'], 'drop': d['drop'] / d['n'], 'storage': d['storage'] / d['n']}
    sr0 = (first.get('acc') or {}).get('spawnByRole') or {}
    sr1 = (last.get('acc') or {}).get('spawnByRole') or {}
    spawn = {role: ((sr1.get(role) or 0) - (sr0.get(role) or 0)) / ticks for role in ROLES if (sr1.get(role) or 0) or (sr0.get(role) or 0)}
    acc0, acc1 = first.get('acc') or {}, last.get('acc') or {}
    return {'ticks': ticks, 'rooms': per_room, 'spawnByRole': spawn,
            'cpTotal': ((last.get('gcl') or 0) - (first.get('gcl') or 0)) / ticks,
            'harvest': ((acc1.get('harvest') or 0) - (acc0.get('harvest') or 0)) / ticks}


def analyse(run_dir, warmup, until=None):
    rows = load_rows(run_dir)
    first, last = window(rows, warmup, until)
    if first is None:
        return {'dir': run_dir, 'label': label_of(run_dir), 'error': '没有足够的 haul 采样（warmup 之后少于两条）'}
    ticks = max(1, last['t'] - first['t'])
    homes = sorted(set(((last.get('haul') or {}).get('rooms') or {}).keys()))
    per = {}
    totals = {}
    for home in homes:
        for role in ROLES:
            delta = diff(counters(first, home, role), counters(last, home, role))
            m = metrics(delta, ticks)
            if m:
                per.setdefault(home, {})[role] = m
            acc = totals.setdefault(role, {})
            for key, value in delta.items():
                if isinstance(value, dict):
                    inner = acc.setdefault(key, {})
                    for k, v in value.items():
                        inner[k] = inner.get(k, 0) + v
                else:
                    acc[key] = acc.get(key, 0) + value
    account = {role: metrics(delta, ticks) for role, delta in totals.items()}
    account = {role: m for role, m in account.items() if m}
    rooms_v2 = {}
    lines_v2 = {}
    for home in homes:
        rd = diff(counters(first, home, '_room'), counters(last, home, '_room'))
        rm = room_metrics(rd)
        if rm:
            rooms_v2[home] = rm
        l0 = counters(first, home, '_lines')
        l1 = counters(last, home, '_lines')
        for remote in sorted(set(l0) | set(l1)):
            lm = line_metrics(diff(l0.get(remote) or {}, l1.get(remote) or {}), ticks)
            if lm:
                lines_v2['%s→%s' % (home, remote)] = lm
    version = ((last.get('haul') or {}).get('v'))
    return {'dir': run_dir, 'label': label_of(run_dir), 'tStart': first['t'], 'tEnd': last['t'], 'ticks': ticks, 'version': version,
            'homes': per, 'account': account, 'ledger': ledger(rows, first, last), 'rooms': rooms_v2, 'lines': lines_v2}


def pct(value):
    return '—' if value is None else '%.0f%%' % (100 * value)


def num(value, digits=1):
    return '—' if value is None else ('%.' + str(digits) + 'f') % value


def row_cells(m):
    if not m:
        return ['—'] * 14
    reasons = ' '.join('%s %s' % (k, pct(v)) for k, v in sorted(m['reasons'].items(), key=lambda kv: -kv[1])[:3]) or '—'
    return [num(m['carriers'], 2), pct(m['busy']), pct(m['idleE']), pct(m['idleL']), pct(m['mvE']), pct(m['mvL']),
            num(m['load'], 2), num(m['cargo'], 2), num(m['depFill'], 2), pct(m['chain']), num(m['perCarry'], 2),
            num(m['outPerTick'], 1), num(m['churnPerTick'], 2), reasons]


def render(results):
    lines = ['# 运输饱和度 A/B', '']
    for r in results:
        if r.get('error'):
            lines.append('- %s：%s' % (r['label'], r['error']))
        else:
            lines.append('- %s：窗口 tick %d → %d（%d tick），`%s`' % (r['label'], r['tStart'], r['tEnd'], r['ticks'], r['dir']))
    ok = [r for r in results if not r.get('error')]
    if not ok:
        return '\n'.join(lines) + '\n'
    header = '| 分叉 | 只数 | 饱和度 | 空等 | 满等 | 空跑 | 载货行进 | 装载率 | 货物行进 | 出发装载率 | 动作同步挪位 | 单位运量 | 运量/tick | 倒腾/tick | 主要原因 |'
    sep = '|' + '---|' * 15
    lines += ['', '## 全账号（按角色）', '']
    for role in ROLES:
        if not any(role in r['account'] for r in ok):
            continue
        lines += ['### ' + role, '', header, sep]
        for r in ok:
            lines.append('| ' + r['label'] + ' | ' + ' | '.join(row_cells(r['account'].get(role))) + ' |')
        lines.append('')
    if any(m.get('v2') for r in ok for m in r['account'].values()):
        header2 = '| 分叉 | 动作同步挪位(钩子) | 涓流等货 | 走去停车 | 半途换目标/白跑 | 载货绕路比 | 空载绕路比 | 出发 < 0.8 | 空闲:有货没人搬 | 空闲:没货 | 空闲:全满 | 老死带货/寿命 |'
        lines += ['## 全账号 v2 细分（按动作钩子与事件序列；v1 数据为 —）', '']
        for role in ROLES:
            if not any(role in r['account'] for r in ok):
                continue
            lines += ['### ' + role, '', header2, '|' + '---|' * 12]
            for r in ok:
                m = r['account'].get(role)
                if not m:
                    continue
                lines.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (
                    r['label'], pct(m.get('actMove')), pct(m.get('trickle')), pct(m.get('parkWalk')), pct(m.get('aborted')),
                    num(m.get('detourLoaded'), 2), num(m.get('detourEmpty'), 2), pct(m.get('partialDep')),
                    pct(m.get('idleWaste')), pct(m.get('idleStarved')), pct(m.get('idleFull')), num(m.get('lostPerLife'), 0)))
            lines.append('')
    room_names = sorted({name for r in ok for name in (r.get('rooms') or {})})
    if room_names:
        lines += ['## 房级（v2）：spawn/ext 补能期、link 满着的时间、spawn 等能量', '',
                  '| 房 | ' + ' | '.join('%s 补能次数 | %s 平均补能 tick | %s ctrl link 满 | %s 源 link 满 | %s spawn 等能量' % ((r['label'],) * 5) for r in ok) + ' |',
                  '|---|' + '---|' * (5 * len(ok))]
        for name in room_names:
            cells = []
            for r in ok:
                d = (r.get('rooms') or {}).get(name)
                cells += [str(d['refills']), num(d['refillTicks'], 1), pct(d['ctrlLinkFull']), pct(d['srcLinkFull']), pct(d['spawnWaiting'])] if d else ['—'] * 5
            lines.append('| %s | %s |' % (name, ' | '.join(cells)))
        lines.append('')
    line_names = sorted({name for r in ok for name in (r.get('lines') or {})})
    if line_names:
        lines += ['## 外矿线（v2，remoteHauler）', '',
                  '| 线 | ' + ' | '.join('%s 只数 | %s 饱和度 | %s 涓流等货 | %s 出发装载率 | %s 运量/tick | %s 老死带货' % ((r['label'],) * 6) for r in ok) + ' |',
                  '|---|' + '---|' * (6 * len(ok))]
        for name in line_names:
            cells = []
            for r in ok:
                d = (r.get('lines') or {}).get(name)
                cells += [num(d['carriers'], 2), pct(d['busy']), pct(d['trickle']), num(d['depFill'], 2), num(d['outPerTick'], 1), str(d['lost'])] if d else ['—'] * 6
            lines.append('| %s | %s |' % (name, ' | '.join(cells)))
        lines.append('')
    homes = sorted({home for r in ok for home in r['homes']})
    lines += ['## 每个母房', '']
    for home in homes:
        for role in ROLES:
            if not any(role in (r['homes'].get(home) or {}) for r in ok):
                continue
            lines += ['### %s · %s' % (home, role), '', header, sep]
            for r in ok:
                lines.append('| ' + r['label'] + ' | ' + ' | '.join(row_cells((r['homes'].get(home) or {}).get(role))) + ' |')
            lines.append('')
    lines += ['## 账本背景（数据库侧，不依赖 bot 自报）', '', '| 分叉 | 全账号 CP/tick | 采集/tick | hauler 孵化/tick | remoteHauler 孵化/tick |', '|---|---|---|---|---|']
    for r in ok:
        led = r['ledger']
        lines.append('| %s | %s | %s | %s | %s |' % (r['label'], num(led['cpTotal'], 2), num(led['harvest'], 1),
                                                     num(led['spawnByRole'].get('hauler'), 2), num(led['spawnByRole'].get('remoteHauler'), 2)))
    lines += ['', '| 房 | ' + ' | '.join('%s CP/tick | %s 源容器 | %s 掉落 | %s storage' % ((r['label'],) * 4) for r in ok) + ' |',
              '|---|' + '---|' * (4 * len(ok))]
    rooms = sorted({name for r in ok for name in r['ledger']['rooms']})
    for name in rooms:
        cells = []
        for r in ok:
            d = r['ledger']['rooms'].get(name)
            cells += [num(d['cp'], 2), num(d['srcCont'], 0), num(d['drop'], 0), num(d['storage'], 0)] if d else ['—'] * 4
        lines.append('| %s | %s |' % (name, ' | '.join(cells)))
    return '\n'.join(lines) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('runs', nargs='+', help='分叉跑目录（同一快照）')
    parser.add_argument('--warmup', type=int, default=2000, help='分叉后跳过的 tick（代码换版后的过渡期）')
    parser.add_argument('--until', type=int, default=None, help='窗口终点不超过分叉后这么多 tick（两边跑的长度不同时对齐）')
    parser.add_argument('--out', help='写到文件（默认打印）')
    parser.add_argument('--json', action='store_true', help='输出 JSON 而不是 Markdown')
    args = parser.parse_args(argv)
    results = [analyse(run, args.warmup, args.until) for run in args.runs]
    text = json.dumps(results, ensure_ascii=False, indent=1) if args.json else render(results)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
