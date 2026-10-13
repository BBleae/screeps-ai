#!/usr/bin/env python3
"""对 soak 采样（samples.jsonl）跑不变量规则，列出可疑现象及其 tick 区间。

用法: python3 scripts/soak/analyze.py data/soak/run-<时间>/samples.jsonl [--json]
规则（每条都是线上曾经踩过或容易踩的坑）：
  errors          Memory.errors 非空
  edge-pingpong   同一 creep 连续 ≥3 个采样都站在出口格（x/y 为 0 或 49）
  idle-with-energy 带能量的 hauler/builder/upgrader 连续 ≥4 个采样位置不变
  stuck-creep     任意 creep 连续 ≥6 个采样位置不变且不在容器/工位上（静态矿工除外）
  remote-stuck    外矿记录停用/暂停但 suspendedUntil 已过期，连续 ≥3 个采样
  defender-spam   defenseLog.spawned 持续增长而所有房间都没见过敌人
  site-stall      同一工地连续 ≥8 个采样进度不变（且房里有 builder）
  capacity-dip    母房 energyCapacityAvailable 比起始值低 ≥40% 连续 ≥6 个采样
  no-upgrade      母房 controller progress 连续 ≥8 个采样不变
  spawn-idle-short spawn 空闲但 targets 总数 > 在岗数，连续 ≥4 个采样
  plan-missing    母房没有轮子方案 / planError
  drops-pile      房间地面能量 ≥ 2000 连续 ≥4 个采样
  ruin-energy     ruin 里的能量 ≥ 500 连续 ≥6 个采样（没人去收）
  cpu-spike       单次采样 cpu ≥ 100
"""
import argparse
import json
import sys
from collections import defaultdict


def load(path):
    samples, events = [], []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            (events if item.get('event') else samples).append(item)
    return samples, events


def runs(flags, min_len):
    """把布尔序列里连续为真的段落（长度 ≥ min_len）转成 (start_index, end_index)。"""
    out, start = [], None
    for index, flag in enumerate(flags + [False]):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            if index - start >= min_len:
                out.append((start, index - 1))
            start = None
    return out


def analyze(samples, events):
    findings = []
    if not samples:
        return [{'rule': 'no-samples', 'detail': 'samples.jsonl 为空'}]
    ticks = [s['t'] for s in samples]

    def add(rule, detail, span=None, room=None):
        findings.append({'rule': rule, 'room': room, 'detail': detail,
                         'ticks': [ticks[span[0]], ticks[span[1]]] if span else None})

    # errors
    for s in samples:
        if s.get('errN'):
            add('errors', '; '.join(s.get('errs') or [])[:200], (ticks.index(s['t']), ticks.index(s['t'])))
            break
    # cpu
    for index, s in enumerate(samples):
        if (s.get('cpu') or 0) >= 100:
            add('cpu-spike', 'cpu=%s' % s['cpu'], (index, index))

    # per-creep tracks
    tracks = defaultdict(list)   # name -> [(index, role, home, room, x, y, energy, remoteRoom, targetRoom)]
    for index, s in enumerate(samples):
        for creep in s.get('creeps') or []:
            name, role, home, room, x, y, energy = creep[0], creep[1], creep[2], creep[3], creep[4], creep[5], creep[6]
            tracks[name].append((index, role, home, room, x, y, energy))
    for name, track in tracks.items():
        role = track[0][1]
        edge = [(t[4] in (0, 49) or t[5] in (0, 49)) for t in track]
        for span in runs(edge, 3):
            add('edge-pingpong', '%s(%s) 在出口格 %s' % (name, role, [(track[i][3], track[i][4], track[i][5]) for i in range(span[0], min(span[1] + 1, span[0] + 3))]),
                (track[span[0]][0], track[span[1]][0]), track[0][2])
        still = [i > 0 and track[i][3:6] == track[i - 1][3:6] for i in range(len(track))]
        if role in ('hauler', 'builder', 'remoteHauler'):   # upgrader 站着升级是正常的
            idle = [still[i] and track[i][6] > 0 for i in range(len(track))]
            for span in runs(idle, 4):
                add('idle-with-energy', '%s(%s) 带 %d 能量在 %s(%d,%d) 不动' % (name, role, track[span[0]][6], track[span[0]][3], track[span[0]][4], track[span[0]][5]),
                    (track[span[0]][0], track[span[1]][0]), track[0][2])
        if role not in ('harvester', 'remoteMiner', 'upgrader', 'reserver'):
            for span in runs(still, 6):
                add('stuck-creep', '%s(%s) 在 %s(%d,%d) 连续 %d 次采样不动' % (name, role, track[span[0]][3], track[span[0]][4], track[span[0]][5], span[1] - span[0] + 1),
                    (track[span[0]][0], track[span[1]][0]), track[0][2])

    # per-room tracks
    room_names = sorted({name for s in samples for name in (s.get('rooms') or {})})
    for room in room_names:
        rows = [(index, s['rooms'][room]) for index, s in enumerate(samples) if room in (s.get('rooms') or {})]
        if not rows:
            continue
        mine = any(r.get('mine') for _, r in rows)
        # remotes stuck
        if mine:
            stuck = []
            for index, r in rows:
                bad = []
                for item in r.get('remotes') or []:
                    parts = item.split(':')
                    if len(parts) < 4:
                        continue
                    name, enabled, reason, until = parts[0], parts[1] == '1', parts[2], int(parts[3] or 0)
                    if not enabled and reason in ('hostileCreep', 'invaderCore', 'notWhitelisted') and until and until < samples[index]['t'] and until != 9007199254740991:
                        bad.append(name + ':' + reason)
                stuck.append(bool(bad))
            for span in runs(stuck, 3):
                add('remote-stuck', '外矿停用但暂停已过期: %s' % rows[span[0]][1].get('remotes'), (rows[span[0]][0], rows[span[1]][0]), room)
            # defender spam
            dl = [r.get('dl') or 0 for _, r in rows]
            # defender 也会为外矿里的敌人出兵：任何采样里任何房间见过敌人都不算"无敌情"
            hostile_seen = any((rm.get('hostiles') or 0) > 0 for s in samples for rm in (s.get('rooms') or {}).values())
            grew = [i > 0 and dl[i] > dl[i - 1] for i in range(len(dl))]
            if sum(grew) >= 3 and not hostile_seen:
                add('defender-spam', 'defenseLog.spawned %d → %d 而母房从未见到敌人' % (dl[0], dl[-1]), (rows[0][0], rows[-1][0]), room)
            # capacity dip
            caps = [r.get('cap') or 0 for _, r in rows]
            base = caps[0]
            dip = [base > 0 and c < base * 0.6 for c in caps]
            for span in runs(dip, 6):
                add('capacity-dip', '容量 %d → %d' % (base, caps[span[0]]), (rows[span[0]][0], rows[span[1]][0]), room)
            # no upgrade
            prog = [r.get('prog') or 0 for _, r in rows]
            flat = [i > 0 and prog[i] == prog[i - 1] for i in range(len(prog))]
            for span in runs(flat, 8):
                add('no-upgrade', 'controller 进度停在 %d' % prog[span[0]], (rows[span[0]][0], rows[span[1]][0]), room)
            # spawn idle while short
            short = []
            for index, r in rows:
                targets = r.get('targets') or {}
                want = sum(int(v or 0) for v in targets.values())
                have = sum(1 for c in samples[index].get('creeps') or [] if c[2] == room and c[1] in targets)
                spawning = any(sp.startswith(room + ':') and len(sp) > len(room) + 1 for sp in samples[index].get('spawning') or [])
                short.append(want > have and not spawning and (r.get('e') or 0) >= 300)
            for span in runs(short, 4):
                add('spawn-idle-short', 'spawn 空闲但编制未满 targets=%s' % rows[span[0]][1].get('targets'), (rows[span[0]][0], rows[span[1]][0]), room)
            # plan
            if any(r.get('planError') for _, r in rows) or not any(r.get('planVer') for _, r in rows):
                add('plan-missing', 'planVer=%s planError=%s' % (rows[-1][1].get('planVer'), rows[-1][1].get('planError')), (rows[-1][0], rows[-1][0]), room)
            # site stall
            progress = defaultdict(list)
            for index, r in rows:
                for site in r.get('sites') or []:
                    progress[(site[0], site[1], site[2])].append((index, site[3]))
            for key, series in progress.items():
                if len(series) < 8:
                    continue
                stall = [i > 0 and series[i][1] == series[i - 1][1] for i in range(len(series))]
                for span in runs(stall, 8):
                    add('site-stall', '%s@%d,%d 进度停在 %d' % (key[0], key[1], key[2], series[span[0]][1]), (series[span[0]][0], series[span[1]][0]), room)
        # drops / ruins
        drops = [(r.get('drops') or 0) >= 2000 for _, r in rows]
        for span in runs(drops, 4):
            add('drops-pile', '地面能量 %d' % rows[span[0]][1].get('drops'), (rows[span[0]][0], rows[span[1]][0]), room)
        ruins = [(r.get('ruinEnergy') or 0) >= 500 for _, r in rows]
        for span in runs(ruins, 6):
            add('ruin-energy', 'ruin 能量 %d 无人收' % rows[span[0]][1].get('ruinEnergy'), (rows[span[0]][0], rows[span[1]][0]), room)
    return findings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('samples')
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    samples, events = load(args.samples)
    findings = analyze(samples, events)
    if args.json:
        print(json.dumps({'samples': len(samples), 'events': len(events), 'findings': findings}, ensure_ascii=False, indent=1))
        return
    print('采样 %d 次（tick %s–%s），事件 %d，发现 %d 条' % (len(samples), samples[0]['t'] if samples else '-', samples[-1]['t'] if samples else '-', len(events), len(findings)))
    by_rule = defaultdict(list)
    for item in findings:
        by_rule[item['rule']].append(item)
    for rule, items in sorted(by_rule.items(), key=lambda kv: -len(kv[1])):
        print('\n[%s] ×%d' % (rule, len(items)))
        for item in items[:6]:
            print('  %s %s %s' % (item.get('room') or '', item.get('ticks') or '', item['detail']))
        if len(items) > 6:
            print('  … 还有 %d 条' % (len(items) - 6))


if __name__ == '__main__':
    main()
