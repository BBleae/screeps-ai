#!/usr/bin/env python3
"""RCL 基准报告：读 scripts/soak/rcl_benchmark.js 产出的 progress.jsonl / levels.json / run.json，
按母房 RCL 阶段列出 tick 数、能量收支账、理论上限、效率与浪费点，再给账号总 Control Point 增长、
外矿收入/净收益与占领时间线，输出 Markdown（可选 JSON 摘要）。

用法：python3 scripts/soak/rcl_report.py data/soak/rcl-bench-<x> [--snapshot data/soak/live_snapshot.json]
      [--out docs/…/report.md] [--json summary.json]

账目口径（与 rcl_benchmark.js 一致，全部是数据库侧观测，不依赖 bot 自报）：
  采集   = 源 invaderHarvested 增量（己方房 / 外矿分账）   升级 = 用户 gcl 点数增量 = 账号总 CP（1 能量 = 1 点）
  孵化   = 首次见到的 creep 身体成本（按角色、按母房）     建造 = 工地进度增量 + 完工补量
  自产   = spawn 每 tick 自回 1 能量的估计（spawn 能量 < 300 的采样区间按 1/tick 计）
  残差   = 采集 + 自产 + 初始 300 − 升级 − 孵化 − 建造 − Δ库存 ≈ 修理/塔/衰减/被拆工地/采样间隔内出现又完工的小工地
理论上限：
  潜在采集 = 己方房源 × 10/tick（3000/300）+ 活跃外矿源 × (10 有预定 / 5 无预定)
  下限 A（母房两源全投控制器）= 该级所需进度 / 20；下限 B（实际收入全投）= 所需 / 实际采集速率；
  下限 C（潜在采集全投）= 所需 / 潜在采集速率。效率 = 下限 / 实际 tick。
"""
import argparse
import json
import os
import sys

CONTROLLER_LEVELS = {1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 3645000, 7: 10935000}
TOTAL_TO_RCL8 = sum(CONTROLLER_LEVELS.values())
GCL_MULTIPLY = 1000000
GCL_POW = 2.4
SOURCE_RATE_OWNED = 10.0      # 3000 / 300
SOURCE_RATE_NEUTRAL = 5.0     # 1500 / 300
EXTENSION_CAPACITY = {0: 50, 1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50, 7: 100, 8: 200}
SPAWN_CAPACITY = 300
ACC_KEYS = ('harvest', 'harvestHome', 'harvestRemote', 'upgrade', 'spawn', 'parts', 'creeps', 'build', 'buildHome', 'buildLost')
ACC_MAPS = ('spawnByRole', 'spawnByHome', 'spawnByRemote', 'buildByType', 'harvestByRoom', 'upgradeByRoom')
REMOTE_ROLES = ('remoteMiner', 'remoteHauler', 'reserver')
EXPANSION_ROLES = ('claimer', 'pioneer')


def gcl_level(points):
    return int((max(0.0, float(points or 0)) / GCL_MULTIPLY) ** (1.0 / GCL_POW)) + 1


def load_jsonl(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_run(run_dir):
    with open(os.path.join(run_dir, 'run.json'), encoding='utf-8') as handle:
        run = json.load(handle)
    rows = load_jsonl(os.path.join(run_dir, 'progress.jsonl'))
    levels_path = os.path.join(run_dir, 'levels.json')
    levels = []
    if os.path.exists(levels_path):
        with open(levels_path, encoding='utf-8') as handle:
            levels = json.load(handle) or []
    events = load_jsonl(os.path.join(run_dir, 'events.jsonl'))
    brain_runs = load_jsonl(os.path.join(run_dir, 'brain', 'runs.jsonl'))
    return run, rows, levels, events, brain_runs


def sources_per_room(snapshot_path):
    """快照里每房的源数量（潜在采集要用）；没有快照时返回空表，外矿潜在按 2 源估。"""
    if not snapshot_path or not os.path.exists(snapshot_path):
        return {}
    with open(snapshot_path, encoding='utf-8') as handle:
        snapshot = json.load(handle)
    return {room: sum(1 for o in data.get('objects', []) if o.get('type') == 'source') for room, data in snapshot.get('rooms', {}).items()}


def diff_acc(last, first):
    """两条记录的累计账目之差（first 可为 None：从零起算）。"""
    out = {}
    a = last.get('acc', {})
    b = (first or {}).get('acc', {}) if first else {}
    for key in ACC_KEYS:
        out[key] = a.get(key, 0) - b.get(key, 0)
    for key in ACC_MAPS:
        merged = {}
        for name, value in (a.get(key) or {}).items():
            merged[name] = value - (b.get(key) or {}).get(name, 0)
        out[key] = {k: v for k, v in merged.items() if v}
    return out


def valid_levels(rows, levels, home):
    """只保留"该房第一次到达该等级"的升级条目：降级后弹回、老数据里的重复条目（房间在此之前已经到过这个等级）一律丢掉。"""
    first_seen = {}
    for row in rows:
        owned = row.get('owned') or {home: {'rcl': row.get('rcl')}}
        for room, info in owned.items():
            level = (info or {}).get('rcl')
            if level is None:
                continue
            for lv in range(1, level + 1):
                first_seen.setdefault((room, lv), row['t'])
    out = []
    kept = set()
    for lv in sorted(levels, key=lambda lv: lv['tick']):
        room = lv.get('room', home)
        key = (room, lv['level'])
        if lv.get('reup') or (lv.get('sincePrev') is not None and lv['sincePrev'] < 0) or key in kept:
            continue
        seen_at = first_seen.get(key)
        sample_tick = lv.get('sampleTick', lv['tick'])
        if seen_at is not None and seen_at < sample_tick - 60:
            continue   # 采样里这个房早就到过这一级：这条是弹回/重复
        kept.add(key)
        out.append(lv)
    return out


def stage_rows(rows, level):
    return [r for r in rows if r.get('rcl') == level]


def owned_rooms(row, home):
    owned = row.get('owned')
    if isinstance(owned, dict) and owned:
        return list(owned.keys())
    return [home]


def interval_stats(stage, prev_row, home, source_counts):
    """一个阶段（母房同一 RCL 的采样记录）的区间统计：潜在采集、spawn 自产、闲置、掉落衰减、敌情、CPU……"""
    home_sources = None
    potential_home = 0.0
    potential_owned = 0.0
    potential_remote = 0.0
    regen = 0.0
    idle_source_ticks = 0.0
    dropped_decay = 0.0
    spawn_idle_full = 0.0
    spawn_busy_samples = 0
    no_upgrade_ticks = 0.0
    invader_ticks = 0.0
    ticks = 0.0
    cpu_sum = 0.0
    cpu_n = 0
    bucket_min = None
    storage_sum = 0.0
    carried_sum = 0.0
    stock_n = 0
    downgrade_min = None
    remote_rooms = set()
    max_remote_sources = 0
    spawns_max = 1
    ext_max = 0
    err_max = 0
    last_err = None
    owned_max = 1
    spawns_total_max = 1
    home_remotes = set()
    owned_any = set()
    prev = prev_row
    for row in stage:
        dt = row.get('dt') or 0
        if prev is not None and dt <= 0:
            dt = max(0, row['t'] - prev['t'])
        ticks += dt
        home_sources = len(row.get('homeSources') or []) or home_sources or 2
        potential_home += dt * home_sources * SOURCE_RATE_OWNED
        owned = owned_rooms(row, home)
        owned_any.update(owned)
        owned_max = max(owned_max, len(owned))
        for room in owned:
            n = home_sources if room == home else source_counts.get(room, 2)
            potential_owned += dt * n * SOURCE_RATE_OWNED
        reserved = {r[0] for r in (row.get('reservations') or []) if (r[1] or 0) > 0}
        remote_src = 0
        for room in row.get('remoteRooms') or []:
            remote_rooms.add(room)
            n = source_counts.get(room, 2)
            remote_src += n
            potential_remote += dt * n * (SOURCE_RATE_OWNED if room in reserved else SOURCE_RATE_NEUTRAL)
        max_remote_sources = max(max_remote_sources, remote_src)
        structs = row.get('homeStructs') or {}
        spawns = structs.get('spawn', 1) or 1
        spawns_max = max(spawns_max, spawns)
        ext = structs.get('extension', 0)
        ext_max = max(ext_max, ext)
        stock = row.get('stock') or {}
        spawn_energy = stock.get('spawn')
        if spawn_energy is None:
            spawn_energy = stock.get('spawnExt', 0)
        total_spawns = sum((info or {}).get('spawn', 0) for info in (row.get('owned') or {}).values()) or spawns
        spawns_total_max = max(spawns_total_max, total_spawns)
        for entry in row.get('remotes') or []:
            if entry and entry[1]:
                home_remotes.add(entry[0])
        if spawn_energy < SPAWN_CAPACITY * total_spawns:
            regen += dt * total_spawns
        idle_source_ticks += dt * (row.get('idleSources') or 0)
        dropped = (stock.get('dropped', 0) or 0) + (stock.get('droppedRemote', 0) or 0)
        if dropped > 0:
            piles = stock.get('piles')
            dropped_decay += dt * max(float(piles) if piles else 1.0, dropped / 1000.0)
        capacity = spawns * SPAWN_CAPACITY + ext * EXTENSION_CAPACITY.get(row.get('rcl', 0), 50)
        if len(owned) == 1 and not row.get('spawning') and stock.get('spawnExt', 0) >= capacity:
            spawn_idle_full += dt
        if row.get('spawning'):
            spawn_busy_samples += 1
        if prev is not None:
            up_prev = (prev.get('acc', {}).get('upgradeByRoom') or {}).get(home, prev.get('acc', {}).get('upgrade', 0))
            up_now = (row.get('acc', {}).get('upgradeByRoom') or {}).get(home, row.get('acc', {}).get('upgrade', 0))
            if up_now - up_prev <= 0:
                no_upgrade_ticks += dt
        hostiles = row.get('hostiles') or {}
        watched = set(row.get('remoteRooms') or []) | set(owned)
        if any(users.get('2') for room, users in hostiles.items() if room in watched):
            invader_ticks += dt
        if row.get('cpu') is not None:
            cpu_sum += row['cpu']
            cpu_n += 1
        if row.get('bucket') is not None:
            bucket_min = row['bucket'] if bucket_min is None else min(bucket_min, row['bucket'])
        storage_sum += stock.get('storage', 0) or 0
        carried_sum += stock.get('carried', 0) or 0
        stock_n += 1
        if row.get('downgradeIn') is not None:
            downgrade_min = row['downgradeIn'] if downgrade_min is None else min(downgrade_min, row['downgradeIn'])
        err_max = max(err_max, row.get('errN') or 0)
        if row.get('lastErr'):
            last_err = row['lastErr']
        prev = row
    return {
        'ticks': ticks, 'potentialHome': potential_home, 'potentialOwned': potential_owned, 'potentialRemote': potential_remote, 'regen': regen,
        'idleSourceTicks': idle_source_ticks, 'droppedDecay': dropped_decay, 'spawnIdleFullTicks': spawn_idle_full,
        'spawnBusyShare': (spawn_busy_samples / len(stage)) if stage else 0.0, 'noUpgradeTicks': no_upgrade_ticks,
        'invaderTicks': invader_ticks, 'cpuAvg': (cpu_sum / cpu_n) if cpu_n else None, 'bucketMin': bucket_min,
        'storageAvg': (storage_sum / stock_n) if stock_n else 0.0, 'carriedAvg': (carried_sum / stock_n) if stock_n else 0.0,
        'downgradeMin': downgrade_min, 'remoteRooms': sorted(remote_rooms), 'maxRemoteSources': max_remote_sources,
        'spawnsMax': spawns_max, 'spawnsTotalMax': spawns_total_max, 'extMax': ext_max, 'errMax': err_max, 'lastErr': last_err, 'ownedMax': owned_max,
        # 母房自家外矿：本阶段里母房白名单启用过、且阶段内从未成为己方房的房（被占下的房其采集归它自己）
        'homeRemotes': sorted(home_remotes - owned_any), 'homeSources': home_sources or 2,
    }


def remote_economy(acc, remote_rooms=None, ticks=None):
    """外矿账：毛收入（外矿采集）、外矿角色孵化、净收益；perRemote 按外矿房给“采集 − 派往该房的 creep 孵化（spawnByRemote）”。"""
    by_role = acc.get('spawnByRole') or {}
    spend = sum(by_role.get(role, 0) for role in REMOTE_ROLES)
    gross = acc.get('harvestRemote', 0)
    by_room = acc.get('harvestByRoom') or {}
    by_remote = acc.get('spawnByRemote') or {}
    per_remote = {}
    for room in set(by_remote) | set(remote_rooms or []):
        room_gross = by_room.get(room, 0)
        room_spend = by_remote.get(room, 0)
        per_remote[room] = {'gross': room_gross, 'spend': room_spend, 'net': room_gross - room_spend,
                            'netRate': (room_gross - room_spend) / ticks if ticks else None}
    return {'gross': gross, 'spend': spend, 'net': gross - spend, 'roi': (gross / spend) if spend else None,
            'byRoom': dict(by_room), 'perRemote': per_remote}


def build_stages(run, rows, levels, home, source_counts):
    """按母房 RCL 切阶段：阶段 L 从母房到达 L（或开局）到到达 L+1。最后一个未完成的阶段标 inProgress。"""
    start_tick = run.get('startTick', 0)
    level_tick = {}
    for lv in valid_levels(rows, levels, home):
        if lv.get('room', home) != home:
            continue
        level_tick.setdefault(lv['level'], lv['tick'])
    stages = []
    prev_row = None
    initial_stock = None
    present_levels = sorted({r.get('rcl') for r in rows if r.get('rcl') is not None})
    for level in present_levels:
        stage = stage_rows(rows, level)
        if not stage:
            continue
        t_start = level_tick.get(level, start_tick) if level > 1 else start_tick
        t_end = level_tick.get(level + 1)
        in_progress = t_end is None
        if in_progress:
            t_end = stage[-1]['t']
        acc = diff_acc(stage[-1], prev_row)
        stats = interval_stats(stage, prev_row, home, source_counts)
        ticks = max(1, t_end - t_start)
        stock_last = stage[-1].get('stock', {}).get('total', 0)
        if initial_stock is None:
            # 开局库存就是 spawn 里的 300：记为初始收入，库存从 0 起算（第一条采样前它已经花在第一只 creep 上了）
            initial = 300
            initial_stock = 0
            stock_first = 0
        else:
            initial = 0
            stock_first = (prev_row or stage[0]).get('stock', {}).get('total', 0)
        delta_stock = stock_last - stock_first
        income = acc['harvest'] + stats['regen'] + initial
        residual = income - acc['upgrade'] - acc['spawn'] - acc['build'] - delta_stock
        need = CONTROLLER_LEVELS.get(level, 0)
        home_up = (acc.get('upgradeByRoom') or {}).get(home)
        if home_up is None:
            home_up = acc['upgrade']
        harvest_rate = acc['harvest'] / ticks
        potential_rate = (stats['potentialOwned'] + stats['potentialRemote']) / max(1.0, stats['ticks'])
        by_room = acc.get('harvestByRoom') or {}
        home_harvest = by_room.get(home, acc['harvestHome'] if len(stats.get('homeRemotes', [])) == 0 and len(owned_rooms(stage[-1], home)) == 1 else 0)
        home_remote_harvest = sum(by_room.get(r, 0) for r in stats['homeRemotes'])
        home_income_rate = (home_harvest + home_remote_harvest) / ticks
        home_potential_rate = stats['homeSources'] * SOURCE_RATE_OWNED + sum(source_counts.get(r, 2) for r in stats['homeRemotes']) * SOURCE_RATE_OWNED
        bound_home = need / (2 * SOURCE_RATE_OWNED) if need else 0
        # 下限 B/C 只看母房自己的收入来源：母房两源 + 母房白名单里的外矿（其它房的收入不会流进这个控制器）
        bound_income = need / home_income_rate if home_income_rate > 0 and need else None
        bound_potential = need / home_potential_rate if home_potential_rate > 0 and need else None
        last = stage[-1]
        owned_end = owned_rooms(last, home)
        expansion_spend = sum((acc.get('spawnByRole') or {}).get(role, 0) for role in EXPANSION_ROLES)
        stages.append({
            'level': level, 'tStart': t_start - start_tick, 'tEnd': t_end - start_tick, 'ticks': ticks, 'inProgress': in_progress,
            'need': need, 'progressed': home_up, 'cp': acc['upgrade'], 'cpOthers': acc['upgrade'] - home_up, 'acc': acc, 'income': income, 'regen': stats['regen'], 'initial': initial,
            'deltaStock': delta_stock, 'residual': residual, 'stats': stats, 'remote': remote_economy(acc), 'expansionSpend': expansion_spend,
            'harvestRate': harvest_rate, 'homeHarvest': home_harvest, 'homeRemoteHarvest': home_remote_harvest, 'homeIncomeRate': home_income_rate, 'homePotentialRate': home_potential_rate,
            'homeRemotes': stats['homeRemotes'],
            'upgradeRate': home_up / ticks, 'cpRate': acc['upgrade'] / ticks, 'spawnRate': acc['spawn'] / ticks, 'buildRate': acc['build'] / ticks,
            'potentialRate': potential_rate, 'sourceUtilHome': (acc['harvestHome'] / stats['potentialOwned']) if stats['potentialOwned'] else None,
            'sourceUtilRemote': (acc['harvestRemote'] / stats['potentialRemote']) if stats['potentialRemote'] else None,
            'upgradeShare': (home_up / income) if income else None, 'cpShare': (acc['upgrade'] / income) if income else None,
            'spawnShare': (acc['spawn'] / income) if income else None, 'buildShare': (acc['build'] / income) if income else None,
            'spawnUtil': (acc['parts'] * 3.0 / (stats['spawnsTotalMax'] * ticks)) if ticks else None,
            'boundHomeOnly': bound_home, 'boundIncome': bound_income, 'boundPotential': bound_potential,
            'efficiencyHomeOnly': (bound_home / ticks) if (bound_home and not in_progress) else None,
            'efficiencyIncome': (bound_income / ticks) if (bound_income and not in_progress) else None,
            'efficiencyPotential': (bound_potential / ticks) if (bound_potential and not in_progress) else None,
            'stockEnd': stock_last, 'creepsEnd': last.get('creeps'), 'rolesEnd': last.get('roles'), 'structsEnd': last.get('homeStructs'),
            'ownedEnd': owned_end, 'gclLevelEnd': last.get('gclLevel') or gcl_level(last.get('gcl')), 'gclPointsEnd': last.get('gcl', 0),
        })
        prev_row = stage[-1]
    return stages


def cp_windows(run, rows, home, window=None):
    """按固定 tick 窗口给出账号总 CP 增速曲线（总 / 母房 / 其它房），以及同期采集与房数。"""
    if not rows:
        return []
    start_tick = run.get('startTick', 0)
    span = rows[-1]['t'] - start_tick
    if not window:
        window = max(10000, int(span / 25 // 1000 * 1000) or 10000)
    out = []
    anchor = rows[0]
    for row in rows[1:]:
        if row['t'] - anchor['t'] < window and row is not rows[-1]:
            continue
        acc = diff_acc(row, anchor)
        ticks = max(1, row['t'] - anchor['t'])
        home_up = (acc.get('upgradeByRoom') or {}).get(home, acc['upgrade'])
        out.append({'from': anchor['t'] - start_tick, 'to': row['t'] - start_tick, 'ticks': ticks, 'cp': acc['upgrade'], 'cpRate': acc['upgrade'] / ticks,
                    'homeRate': home_up / ticks, 'othersRate': (acc['upgrade'] - home_up) / ticks, 'harvestRate': acc['harvest'] / ticks,
                    'remoteRate': acc['harvestRemote'] / ticks, 'spawnRate': acc['spawn'] / ticks, 'rooms': len(owned_rooms(row, home)),
                    'rcl': row.get('rcl'), 'creeps': row.get('creeps'), 'gclLevel': row.get('gclLevel') or gcl_level(row.get('gcl'))})
        anchor = row
    return out


def downgrade_events(run, rows, events):
    """控制器降级：优先用事件文件；老数据没有事件时从采样里相邻记录的等级下降推断。"""
    start_tick = run.get('startTick', 0)
    out = [{'room': e.get('room'), 'from': e.get('from'), 'to': e.get('to'), 'tick': e.get('sinceStart', (e.get('tick') or 0) - start_tick), 'progressBefore': e.get('progressBefore')}
           for e in events if e.get('event') == 'downgrade']
    if out:
        return out
    last = {}
    for row in rows:
        for room, info in (row.get('owned') or {}).items():
            level = info.get('rcl')
            prev = last.get(room)
            if prev and level is not None and level < prev[0]:
                out.append({'room': room, 'from': prev[0], 'to': level, 'tick': row['t'] - start_tick, 'progressBefore': prev[1]})
            last[room] = (level, info.get('prog'))
    return out


def claim_timeline(run, rows, levels, home):
    """占领时间线：每个非母房的占领 tick、建成 spawn tick、各级到达 tick。"""
    if not rows:
        return []
    start_tick = run.get('startTick', 0)
    clean_levels = valid_levels(rows, levels, home)
    last = rows[-1]
    claims = last.get('claims') or {}
    built = last.get('spawnBuilt') or {}
    lost = last.get('lost') or {}
    out = []
    for room in sorted(claims, key=lambda r: claims[r]):
        ups = sorted((lv for lv in clean_levels if lv.get('room') == room), key=lambda lv: lv['tick'])
        info = (last.get('owned') or {}).get(room) or {}
        out.append({'room': room, 'claimed': claims[room] - start_tick, 'spawnBuilt': (built.get(room) - start_tick) if built.get(room) is not None else None,
                    'lost': (lost.get(room) - start_tick) if lost.get(room) is not None else None,
                    'levels': [(lv['level'], lv['tick'] - start_tick) for lv in ups], 'rclEnd': info.get('rcl'),
                    'cp': (last.get('acc', {}).get('upgradeByRoom') or {}).get(room, 0)})
    return out


def overall(run, rows, levels, stages, home):
    if not rows:
        return {}
    first, last = rows[0], rows[-1]
    start_tick = run.get('startTick', 0)
    ticks = last['t'] - start_tick
    acc = diff_acc(last, None)
    regen = sum(s['regen'] for s in stages)
    income = acc['harvest'] + regen + 300
    wall_ms = (last.get('wall') or 0) - (run.get('startedAt') or first.get('wall') or 0)
    reached = max((lv['level'] for lv in valid_levels(rows, levels, home) if lv.get('room', home) == home), default=1)
    home_up = (acc.get('upgradeByRoom') or {}).get(home, acc['upgrade'])
    return {
        'ticks': ticks, 'wallHours': wall_ms / 3600000.0 if wall_ms > 0 else None, 'ticksPerSecond': (ticks / (wall_ms / 1000.0)) if wall_ms > 0 else None,
        'reachedLevel': max(reached, last.get('rcl') or 1), 'acc': acc, 'regen': regen, 'income': income,
        'cp': acc['upgrade'], 'cpRate': acc['upgrade'] / ticks if ticks else 0.0, 'homeCp': home_up, 'othersCp': acc['upgrade'] - home_up,
        'gclLevelStart': gcl_level(first.get('gcl')), 'gclLevelEnd': last.get('gclLevel') or gcl_level(last.get('gcl')), 'roomsEnd': len(owned_rooms(last, home)),
        'upgradeShare': acc['upgrade'] / income if income else None, 'spawnShare': acc['spawn'] / income if income else None,
        'buildShare': acc['build'] / income if income else None,
        'remote': remote_economy(acc, sorted({r for s in stages for r in s['stats']['remoteRooms']}), ticks),
        'stockEnd': last.get('stock', {}).get('total', 0), 'residual': income - acc['upgrade'] - acc['spawn'] - acc['build'] - last.get('stock', {}).get('total', 0),
        'totalNeeded': TOTAL_TO_RCL8, 'boundHomeOnlyTotal': TOTAL_TO_RCL8 / 20.0,
        'harvestRate': acc['harvest'] / ticks if ticks else 0.0, 'upgradeRate': home_up / ticks if ticks else 0.0,
    }


def fmt(value, digits=0):
    if value is None:
        return '—'
    if isinstance(value, float):
        return f'{value:,.{digits}f}'
    return f'{value:,}'


def pct(value):
    return '—' if value is None else f'{value * 100:.0f}%'


def waste_lines(stage):
    """一个阶段的浪费点（能量当量），按大小排序。"""
    acc = stage['acc']
    stats = stage['stats']
    items = []
    unharvested_home = max(0.0, stats['potentialOwned'] - acc['harvestHome'])
    if unharvested_home > 0:
        items.append(('己方房源未采满', unharvested_home, f"源利用率 {pct(stage['sourceUtilHome'])}，其中母房源完全闲置 {fmt(stats['idleSourceTicks'])} 源·tick"))
    unharvested_remote = max(0.0, stats['potentialRemote'] - acc['harvestRemote'])
    if stats['potentialRemote'] > 0:
        items.append(('外矿源未采满', unharvested_remote, f"外矿利用率 {pct(stage['sourceUtilRemote'])}，活跃外矿 {', '.join(stats['remoteRooms']) or '无'}"))
    items.append(('孵化支出', acc['spawn'], f"{fmt(acc['creeps'])} 只 creep / {fmt(acc['parts'])} 部件，母房 spawn 占用 {pct(stage['spawnUtil'])}；按角色 " +
                  ', '.join(f'{k} {fmt(v)}' for k, v in sorted((acc.get('spawnByRole') or {}).items(), key=lambda kv: -kv[1])[:8])))
    items.append(('建造支出', acc['build'], f"己方房 {fmt(acc['buildHome'])}，被拆工地损失 {fmt(acc['buildLost'])}；按类型 " +
                  ', '.join(f'{k} {fmt(v)}' for k, v in sorted((acc.get('buildByType') or {}).items(), key=lambda kv: -kv[1])[:8])))
    if stage['deltaStock'] > 0:
        items.append(('囤积（库存净增）', stage['deltaStock'], f"阶段末库存 {fmt(stage['stockEnd'])}，storage 平均 {fmt(stats['storageAvg'])}，运输中平均 {fmt(stats['carriedAvg'])}"))
    if stats['droppedDecay'] > 0:
        items.append(('地面能量衰减（估）', stats['droppedDecay'], '按每堆 ≥1/tick、每 1000 能量 1/tick 估算'))
    if stage['residual'] > 0:
        items.append(('残差（修理/塔/衰减/漏记）', stage['residual'], '采集 + 自产 − 升级 − 孵化 − 建造 − Δ库存'))
    if stats['noUpgradeTicks'] > 0:
        items.append(('母房控制器无进度的 tick', stats['noUpgradeTicks'], f"占阶段 {pct(stats['noUpgradeTicks'] / max(1.0, stats['ticks']))}（能量当量按 20/tick 计 = {fmt(stats['noUpgradeTicks'] * 20)}）"))
    if stats['spawnIdleFullTicks'] > 0:
        items.append(('spawn 满能量却空闲的 tick', stats['spawnIdleFullTicks'], f"占阶段 {pct(stats['spawnIdleFullTicks'] / max(1.0, stats['ticks']))}"))
    if stats['invaderTicks'] > 0:
        items.append(('有 Invader 在场的 tick', stats['invaderTicks'], f"占阶段 {pct(stats['invaderTicks'] / max(1.0, stats['ticks']))}"))
    if stage['expansionSpend'] > 0:
        items.append(('占领/开荒孵化', stage['expansionSpend'], 'claimer + pioneer 身体成本（换来的是新房的 CP，见占领时间线）'))
    items.sort(key=lambda item: -item[1])
    return items


def render_markdown(run, summary):
    stages = summary['stages']
    ov = summary['overall']
    home = run['args']['home']
    lines = []
    lines.append(f"# RCL 基准报告：{run.get('srcRev') or 'worktree'}（{(run.get('srcCommit') or run.get('workTree') or '')[:12]}）")
    lines.append('')
    lines.append(f"- 世界：快照 {run.get('rooms', '?')} 房真实地形，只播种中立对象；母房 {home} spawn ({run['spawn']['x']},{run['spawn']['y']})，"
                 f"CPU {run['args']['cpu']}，GCL {run['args'].get('gcl', 1)}，Memory 空；外部大脑每 {run['args']['brainEvery']} tick 一轮"
                 f"（{'锁住占领，只测单房' if run['args'].get('lockClaim') else '允许占领'}）。")
    lines.append(f"- 采样：每 {run['args']['sample']} tick 一次数据库侧记账；升级 tick 由前后采样进度线性插值（误差 < 采样间隔）。")
    if ov:
        lines.append(f"- 跑了 {fmt(ov['ticks'])} tick，母房到 RCL{ov['reachedLevel']}，期末 {ov['roomsEnd']} 个房、GCL {ov['gclLevelStart']}→{ov['gclLevelEnd']}；"
                     f"实际 {fmt(ov['wallHours'], 2)} 小时，{fmt(ov['ticksPerSecond'], 1)} tick/s；重启 {summary.get('restarts', 0)} 次。")
    lines.append('')
    lines.append(f'## 母房 {home} 每级用时')
    lines.append('')
    lines.append('| RCL | 到达 tick | 本级用时 | 需要进度 | 母房升级/tick | 母房自家收入/tick（两源+自家外矿） | 自家潜在/tick | 下限 A 两源全投 | 下限 B 自家收入全投 | 下限 C 自家潜在全投 | 效率 A | 效率 B | 效率 C |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for s in stages:
        label = f"{s['level']}→{s['level'] + 1}" + ('（进行中）' if s['inProgress'] else '')
        lines.append(f"| {label} | {fmt(s['tEnd'])} | {fmt(s['ticks'])} | {fmt(s['need'])} | {fmt(s['upgradeRate'], 1)} | {fmt(s['homeIncomeRate'], 1)}（外矿 {len(s['homeRemotes'])} 个）| {fmt(s['homePotentialRate'], 1)} | "
                     f"{fmt(s['boundHomeOnly'])} | {fmt(s['boundIncome'])} | {fmt(s['boundPotential'])} | {pct(s['efficiencyHomeOnly'])} | {pct(s['efficiencyIncome'])} | {pct(s['efficiencyPotential'])} |")
    if ov:
        lines.append('')
        lines.append(f"到 RCL8 共需 {fmt(TOTAL_TO_RCL8)} 进度；只靠母房两源（20/tick）全投控制器的绝对下限是 {fmt(TOTAL_TO_RCL8 / 20)} tick。"
                     '下限 B/C 只算流得进这个控制器的收入：母房两源 + 母房白名单里的外矿（其它己方房的收入归它们自己的控制器），效率 = 下限 / 实际用时。')
    lines.append('')
    lines.append('## 每级能量账（能量单位；采集含外矿，升级列是母房自己的进度，总 CP 见下一节）')
    lines.append('')
    lines.append('| RCL | tick | 采集(己方房+外矿) | 自产 | 母房升级 | 孵化 | 建造 | Δ库存 | 残差 | 收入/tick | 潜在/tick | 己方源利用 | 外矿源利用 | 母房升级占比 | 孵化占比 | 建造占比 | spawn 占用 |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for s in stages:
        a = s['acc']
        lines.append(f"| {s['level']} | {fmt(s['ticks'])} | {fmt(a['harvest'])} ({fmt(a['harvestHome'])}+{fmt(a['harvestRemote'])}) | {fmt(s['regen'])} | {fmt(s['progressed'])} | {fmt(a['spawn'])} | {fmt(a['build'])} | "
                     f"{fmt(s['deltaStock'])} | {fmt(s['residual'])} | {fmt(s['harvestRate'], 1)} | {fmt(s['potentialRate'], 1)} | {pct(s['sourceUtilHome'])} | {pct(s['sourceUtilRemote'])} | "
                     f"{pct(s['upgradeShare'])} | {pct(s['spawnShare'])} | {pct(s['buildShare'])} | {pct(s['spawnUtil'])} |")
    lines.append('')
    lines.append('## 账号总 Control Point 增长（= 所有房升级能量之和）')
    lines.append('')
    lines.append('| 母房 RCL 阶段 | tick | 总 CP | 母房 CP | 其它房 CP | 总 CP/tick | 母房 CP/tick | 总 CP 占收入 | 期末房数 | 期末 GCL | 占领/开荒孵化 |')
    lines.append('|---|---|---|---|---|---|---|---|---|---|---|')
    for s in stages:
        lines.append(f"| {s['level']} | {fmt(s['ticks'])} | {fmt(s['cp'])} | {fmt(s['progressed'])} | {fmt(s['cpOthers'])} | {fmt(s['cpRate'], 2)} | {fmt(s['upgradeRate'], 2)} | "
                     f"{pct(s['cpShare'])} | {len(s['ownedEnd'])} | {s['gclLevelEnd']} | {fmt(s['expansionSpend'])} |")
    windows = summary.get('cpWindows') or []
    if windows:
        lines.append('')
        lines.append('CP 增速曲线（固定 tick 窗口）：')
        lines.append('')
        lines.append('| 窗口 | 总 CP/tick | 母房 CP/tick | 其它房 CP/tick | 采集/tick | 其中外矿/tick | 孵化/tick | 房数 | 母房 RCL | creep | GCL |')
        lines.append('|---|---|---|---|---|---|---|---|---|---|---|')
        for w in windows:
            lines.append(f"| {fmt(w['from'])}–{fmt(w['to'])} | {fmt(w['cpRate'], 2)} | {fmt(w['homeRate'], 2)} | {fmt(w['othersRate'], 2)} | {fmt(w['harvestRate'], 1)} | {fmt(w['remoteRate'], 1)} | "
                         f"{fmt(w['spawnRate'], 1)} | {w['rooms']} | {w['rcl']} | {w['creeps']} | {w['gclLevel']} |")
    timeline = summary.get('claims') or []
    lines.append('')
    lines.append('## 占领时间线')
    lines.append('')
    if not timeline:
        lines.append('（没有占领新房）')
    else:
        lines.append('| 房 | 占下 tick | 建成 spawn | 各级到达 tick | 期末 RCL | 该房 CP | 失去 |')
        lines.append('|---|---|---|---|---|---|---|')
        for c in timeline:
            ups = ', '.join(f"RCL{lv} @{fmt(t)}" for lv, t in c['levels']) or '—'
            lines.append(f"| {c['room']} | {fmt(c['claimed'])} | {fmt(c['spawnBuilt'])} | {ups} | {c['rclEnd'] if c['rclEnd'] is not None else '—'} | {fmt(c['cp'])} | {fmt(c['lost'])} |")
    downgrades = summary.get('downgrades') or []
    if downgrades:
        lines.append('')
        lines.append('控制器降级：' + '；'.join(f"{d['room']} RCL{d['from']}→{d['to']} @ {fmt(d['tick'])}（降级前进度 {fmt(d['progressBefore'])}）" for d in downgrades))
    lines.append('')
    lines.append('## 外矿')
    lines.append('')
    lines.append('| 母房 RCL 阶段 | 外矿采集 | 外矿角色孵化 (remoteMiner/remoteHauler/reserver) | 净收益 | 毛/孵 | 外矿源利用 | 活跃外矿 | 各房采集 |')
    lines.append('|---|---|---|---|---|---|---|---|')
    for s in stages:
        r = s['remote']
        by_room = ', '.join(f'{k} {fmt(v)}' for k, v in sorted(r['byRoom'].items(), key=lambda kv: -kv[1]) if k not in s['ownedEnd'])
        lines.append(f"| {s['level']} | {fmt(r['gross'])} | {fmt(r['spend'])} | {fmt(r['net'])} | {fmt(r['roi'], 2)} | {pct(s['sourceUtilRemote'])} | {', '.join(s['stats']['remoteRooms']) or '无'} | {by_room or '—'} |")
    lines.append('')
    lines.append('## 每级末状态')
    lines.append('')
    lines.append('| RCL | creep 数 | 角色 | 母房建筑 | CPU 均值 | bucket 最低 | 降级计时最低 | 错误 |')
    lines.append('|---|---|---|---|---|---|---|---|')
    for s in stages:
        st = s['stats']
        roles = ', '.join(f'{k} {v}' for k, v in sorted((s['rolesEnd'] or {}).items()))
        structs = ', '.join(f'{k} {v}' for k, v in sorted((s['structsEnd'] or {}).items()))
        lines.append(f"| {s['level']} | {fmt(s['creepsEnd'])} | {roles} | {structs} | {fmt(st['cpuAvg'], 1)} | {fmt(st['bucketMin'])} | {fmt(st['downgradeMin'])} | {st['errMax']} |")
    lines.append('')
    lines.append('## 浪费点（按母房阶段，能量当量从大到小）')
    for s in stages:
        lines.append('')
        lines.append(f"### RCL{s['level']}（{fmt(s['ticks'])} tick，收入 {fmt(s['income'])}）")
        for name, amount, detail in waste_lines(s):
            share = f"{amount / s['income'] * 100:.0f}% 的收入" if s['income'] else ''
            lines.append(f"- {name}：{fmt(amount)}（{share}）— {detail}")
    if ov:
        lines.append('')
        lines.append('## 总账')
        lines.append('')
        a = ov['acc']
        r = ov['remote']
        lines.append(f"- 采集 {fmt(a['harvest'])}（己方房 {fmt(a['harvestHome'])} / 外矿 {fmt(a['harvestRemote'])}）+ spawn 自产 {fmt(ov['regen'])} + 初始 300 = 收入 {fmt(ov['income'])}。")
        lines.append(f"- 总 CP {fmt(ov['cp'])}（{pct(ov['upgradeShare'])}；母房 {fmt(ov['homeCp'])} + 其它房 {fmt(ov['othersCp'])}，平均 {fmt(ov['cpRate'], 2)} CP/tick）、"
                     f"孵化 {fmt(a['spawn'])}（{pct(ov['spawnShare'])}）、建造 {fmt(a['build'])}（{pct(ov['buildShare'])}）、期末库存 {fmt(ov['stockEnd'])}、残差 {fmt(ov['residual'])}。")
        lines.append(f"- 外矿：采集 {fmt(r['gross'])}，外矿角色孵化 {fmt(r['spend'])}，净 {fmt(r['net'])}（毛/孵 {fmt(r['roi'], 2)}）。")
        per_remote = r.get('perRemote') or {}
        if any(v['spend'] for v in per_remote.values()):
            lines.append('')
            lines.append('### 各外矿净收益（全程；孵化 = 派往该房的 remoteMiner/remoteHauler/reserver/defender）')
            lines.append('')
            lines.append('| 外矿 | 采集 | 孵化 | 净 | 净/tick |')
            lines.append('|---|---|---|---|---|')
            for room, v in sorted(per_remote.items(), key=lambda kv: -kv[1]['net']):
                lines.append(f"| {room} | {fmt(v['gross'])} | {fmt(v['spend'])} | {fmt(v['net'])} | {fmt(v['netRate'], 2)} |")
        lines.append(f"- 平均采集 {fmt(ov['harvestRate'], 1)}/tick，母房升级 {fmt(ov['upgradeRate'], 1)}/tick。参照 Kalgen（docs/observe/kalgen.md）：控制器 ≈ 38%、creep ≈ 33% 的采集量。")
    return '\n'.join(lines) + '\n'


def summarize(run, rows, levels, events, snapshot_path, window=None):
    home = run['args']['home']
    source_counts = sources_per_room(snapshot_path)
    stages = build_stages(run, rows, levels, home, source_counts)
    summary = {
        'stages': stages, 'overall': overall(run, rows, levels, stages, home), 'levels': levels,
        'cpWindows': cp_windows(run, rows, home, window), 'claims': claim_timeline(run, rows, levels, home), 'downgrades': downgrade_events(run, rows, events),
        'restarts': sum(1 for e in events if e.get('event') == 'restart'),
        'failures': sum(1 for e in events if e.get('event') == 'failure'),
    }
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('run_dir')
    parser.add_argument('--snapshot', default=os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'soak', 'live_snapshot.json'))
    parser.add_argument('--window', type=int, default=0, help='CP 增速曲线的窗口 tick 数（默认按总长自动取，最少 10000）')
    parser.add_argument('--out', help='写 Markdown 到文件（默认打印到 stdout）')
    parser.add_argument('--json', help='同时写 JSON 摘要')
    args = parser.parse_args(argv)
    run, rows, levels, events, _brain = load_run(args.run_dir)
    if not rows:
        print('no progress records yet', file=sys.stderr)
        return 1
    summary = summarize(run, rows, levels, events, args.snapshot, args.window or None)
    text = render_markdown(run, summary)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as handle:
            handle.write(text)
        print(f'wrote {args.out}')
    else:
        sys.stdout.write(text)
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as handle:
            json.dump(summary, handle, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
