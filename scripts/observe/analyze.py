"""观察分析：纯函数，输入 room-objects / room-history / user stats 的 JSON，输出摘要字典。不访问网络。

口径说明见 docs/superpowers/specs/2026-09-04-player-observation-design.md。
"""
import collections
import re
import statistics

PART_CODE = {'work': 'W', 'carry': 'C', 'move': 'M', 'attack': 'A', 'ranged_attack': 'R', 'heal': 'H',
             'claim': 'L', 'tough': 'T'}
PART_ORDER = ['tough', 'work', 'carry', 'move', 'attack', 'ranged_attack', 'heal', 'claim']
PART_COST = {'work': 100, 'carry': 50, 'move': 50, 'attack': 80, 'ranged_attack': 150, 'heal': 250,
             'claim': 600, 'tough': 10}
CORE_TYPES = ('spawn', 'storage', 'terminal', 'lab', 'tower', 'powerSpawn', 'factory', 'nuker', 'observer')
STRUCTURE_TYPES = ('spawn', 'extension', 'road', 'constructedWall', 'rampart', 'link', 'storage', 'tower',
                   'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'container', 'nuker', 'factory')
ROOM_TOKEN = re.compile(r'^([WE]\d{1,2}[NS]\d{1,2})([a-zA-Z]?)(\d*)$')
TIER_TOKEN = re.compile(r'^L(\d+)$')
TICK_TOKEN = re.compile(r'^t?(\d{5,})$')
HEX_ID_TOKEN = re.compile(r'^[0-9a-f]{24}$')
# 8 分钟一个 bin：interval=8 ≈ 64 分钟，180 ≈ 24 小时，1440 ≈ 8 天（用我方账号的采能量校准）
STATS_BIN_MINUTES = 8


# ---- creep 身体与名字 ----

def body_parts(body):
    """body 可能是 [{'type':..,'boost':..}] 或 ['work', ...]；统一返回 (type, boost) 列表。"""
    parts = []
    for part in body or []:
        if isinstance(part, dict):
            parts.append((part.get('type'), part.get('boost')))
        else:
            parts.append((part, None))
    return parts


def body_signature(body):
    """按固定顺序压缩身体：W10C1M5。"""
    counts = collections.Counter(kind for kind, _ in body_parts(body))
    return ''.join('%s%d' % (PART_CODE[kind], counts[kind]) for kind in PART_ORDER if counts.get(kind))


def body_cost(body):
    return sum(PART_COST.get(kind, 0) for kind, _ in body_parts(body))


def body_boosts(body):
    return dict(collections.Counter(boost for _, boost in body_parts(body) if boost))


def parse_creep_name(name):
    """解析形如 shauler-L1600-W17N27h1-82739484 / W18S4a-legacyscientist-t5375928 的名字。

    返回 {role, tier, room, slot, slotIndex, tick}；解析不出的字段为 None。对其他玩家的任意命名也能给出 role。
    """
    result = {'role': None, 'tier': None, 'room': None, 'slot': None, 'slotIndex': None, 'tick': None}
    if not name:
        return result
    for token in str(name).split('-'):
        if not token:
            continue
        match = ROOM_TOKEN.match(token)
        if match:
            if result['room'] is None:
                result['room'] = match.group(1)
                result['slot'] = match.group(2) or None
                result['slotIndex'] = int(match.group(3)) if match.group(3) else None
            continue
        match = TIER_TOKEN.match(token)
        if match:
            result['tier'] = int(match.group(1))
            continue
        match = TICK_TOKEN.match(token)
        if match:
            result['tick'] = int(match.group(1))
            continue
        if HEX_ID_TOKEN.match(token):
            continue
        if result['role'] is None and re.search(r'[A-Za-z]', token):
            result['role'] = token
    if result['role'] is None:
        result['role'] = re.sub(r'[^A-Za-z_]', '', str(name)) or str(name)
    return result


# ---- 几何 ----

def chebyshev(a, b):
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def _pos(obj):
    return (obj['x'], obj['y'])


def _by_type(objs, kind):
    return [o for o in objs if o.get('type') == kind]


def classify_links(objs):
    """给每个 link 标 kind：source（距源 ≤2）/ hub（距 storage ≤2）/ controller（距控制器 ≤3）/ edge（离房间边 ≤3）/ other。"""
    sources = [_pos(o) for o in _by_type(objs, 'source')]
    storages = [_pos(o) for o in _by_type(objs, 'storage')]
    controllers = [_pos(o) for o in _by_type(objs, 'controller')]
    result = []
    for link in _by_type(objs, 'link'):
        pos = _pos(link)
        if any(chebyshev(pos, s) <= 2 for s in sources):
            kind = 'source'
        elif any(chebyshev(pos, s) <= 2 for s in storages):
            kind = 'hub'
        elif any(chebyshev(pos, c) <= 3 for c in controllers):
            kind = 'controller'
        elif pos[0] <= 3 or pos[0] >= 46 or pos[1] <= 3 or pos[1] >= 46:
            kind = 'edge'
        else:
            kind = 'other'
        result.append({'x': pos[0], 'y': pos[1], 'kind': kind,
                       'energy': (link.get('store') or {}).get('energy', 0)})
    return result


def core_bbox(objs):
    """核心结构（spawn/storage/terminal/lab/tower/…）的外接矩形。"""
    points = [_pos(o) for o in objs if o.get('type') in CORE_TYPES]
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    width = max(xs) - min(xs) + 1
    height = max(ys) - min(ys) + 1
    return {'x': min(xs), 'y': min(ys), 'w': width, 'h': height, 'area': width * height, 'n': len(points)}


# ---- 房间摘要 ----

def _store_energy(obj):
    return int((obj.get('store') or {}).get('energy', 0) or 0)


def _store_other(obj):
    store = obj.get('store') or {}
    return sum(int(v or 0) for k, v in store.items() if k != 'energy')


def summarize_creeps(objs, owner_id=None):
    creeps = [o for o in _by_type(objs, 'creep') if owner_id is None or o.get('user') == owner_id]
    roles = collections.Counter()
    archetypes = collections.Counter()
    boosted = 0
    cost = 0
    details = []
    for creep in creeps:
        parsed = parse_creep_name(creep.get('name'))
        signature = body_signature(creep.get('body'))
        roles[parsed['role']] += 1
        archetypes[(parsed['role'], signature)] += 1
        boosts = body_boosts(creep.get('body'))
        if boosts:
            boosted += 1
        cost += body_cost(creep.get('body'))
        details.append({'name': creep.get('name'), 'role': parsed['role'], 'tier': parsed['tier'],
                        'targetRoom': parsed['room'], 'slot': parsed['slot'], 'signature': signature,
                        'cost': body_cost(creep.get('body')), 'boosts': boosts, 'x': creep.get('x'),
                        'y': creep.get('y'), 'energy': _store_energy(creep)})
    return {'count': len(creeps), 'roles': dict(roles), 'boosted': boosted, 'cost': cost,
            'archetypes': {'%s|%s' % key: n for key, n in archetypes.items()}, 'list': details}


def summarize_room(shard, room, objs, owner_id=None):
    """己方房摘要：结构、link 分类、储量、塔、rampart、lab、spawn、creep、核心紧凑度与关键距离。"""
    counts = collections.Counter(o.get('type') for o in objs)
    storages = _by_type(objs, 'storage')
    terminals = _by_type(objs, 'terminal')
    controllers = _by_type(objs, 'controller')
    sources = _by_type(objs, 'source')
    towers = _by_type(objs, 'tower')
    ramparts = _by_type(objs, 'rampart')
    walls = _by_type(objs, 'constructedWall')
    labs = _by_type(objs, 'lab')
    spawns = _by_type(objs, 'spawn')
    containers = _by_type(objs, 'container')
    controller = controllers[0] if controllers else None
    storage = storages[0] if storages else None
    summary = {
        'shard': shard, 'room': room,
        'rcl': controller.get('level') if controller else None,
        'progress': controller.get('progress') if controller else None,
        'safeMode': bool(controller and controller.get('safeMode')),
        'structures': {kind: counts.get(kind, 0) for kind in STRUCTURE_TYPES if counts.get(kind)},
        'constructionSites': counts.get('constructionSite', 0),
        'storageEnergy': _store_energy(storage) if storage else None,
        'storageOther': _store_other(storage) if storage else None,
        'terminalEnergy': _store_energy(terminals[0]) if terminals else None,
        'terminalOther': _store_other(terminals[0]) if terminals else None,
        'towers': {'n': len(towers),
                   'energyMean': round(statistics.mean(_store_energy(t) for t in towers)) if towers else None},
        'ramparts': {'n': len(ramparts),
                     'hitsMean': round(statistics.mean(r.get('hits', 0) for r in ramparts)) if ramparts else None,
                     'hitsMin': min(r.get('hits', 0) for r in ramparts) if ramparts else None},
        'walls': {'n': len(walls),
                  'hitsMean': round(statistics.mean(w.get('hits', 0) for w in walls)) if walls else None},
        'labs': {'n': len(labs),
                 'resources': sorted({k for lab in labs for k, v in (lab.get('store') or {}).items()
                                      if k != 'energy' and v})},
        'spawns': {'n': len(spawns), 'busy': sum(1 for s in spawns if s.get('spawning')),
                   'spawning': [s['spawning'].get('name') for s in spawns if s.get('spawning')]},
        'links': classify_links(objs),
        'linkKinds': dict(collections.Counter(l['kind'] for l in classify_links(objs))),
        'sources': [{'x': s['x'], 'y': s['y'], 'energy': s.get('energy'), 'capacity': s.get('energyCapacity')}
                    for s in sources],
        'containers': [{'x': c['x'], 'y': c['y'], 'energy': _store_energy(c), 'hits': c.get('hits')}
                       for c in containers],
        'mineral': next((m.get('mineralType') for m in _by_type(objs, 'mineral')), None),
        'core': core_bbox(objs),
        'creeps': summarize_creeps(objs, owner_id),
        'otherCreeps': sum(1 for o in _by_type(objs, 'creep') if owner_id and o.get('user') != owner_id),
    }
    if storage:
        spos = _pos(storage)
        summary['distances'] = {
            'storageToController': chebyshev(spos, _pos(controller)) if controller else None,
            'storageToSources': sorted(chebyshev(spos, _pos(s)) for s in sources),
            'storageToSpawns': sorted(chebyshev(spos, _pos(s)) for s in spawns),
        }
    else:
        summary['distances'] = None
    return summary


def summarize_remote_room(shard, room, objs, owner_id=None, game_time=None):
    """外矿房摘要：预定剩余、容器、道路、矿工、入侵者。"""
    controllers = _by_type(objs, 'controller')
    reservation = controllers[0].get('reservation') if controllers else None
    creeps = _by_type(objs, 'creep')
    mine = [c for c in creeps if owner_id is None or c.get('user') == owner_id]
    hostile = [c for c in creeps if owner_id and c.get('user') not in (owner_id, '2', '3')]
    invaders = [c for c in creeps if c.get('user') == '2']
    return {
        'shard': shard, 'room': room,
        'reservedBy': reservation.get('user') if reservation else None,
        'reservationLeft': (reservation.get('endTime') - game_time) if reservation and game_time else None,
        'sources': [{'x': s['x'], 'y': s['y'], 'energy': s.get('energy'), 'capacity': s.get('energyCapacity')}
                    for s in _by_type(objs, 'source')],
        'containers': [{'x': c['x'], 'y': c['y'], 'energy': _store_energy(c), 'hits': c.get('hits')}
                       for c in _by_type(objs, 'container')],
        'roads': len(_by_type(objs, 'road')),
        'invaderCore': bool(_by_type(objs, 'invaderCore')),
        'invaders': len(invaders),
        'hostile': len(hostile),
        'creeps': summarize_creeps(mine),
    }


# ---- 聚合 ----

def aggregate_archetypes(room_summaries):
    """跨房按角色聚合身体签名：{role: {signature: count}}。"""
    result = collections.defaultdict(collections.Counter)
    for summary in room_summaries:
        for key, n in summary['creeps']['archetypes'].items():
            role, signature = key.split('|', 1)
            result[role][signature] += n
    return {role: dict(counter.most_common()) for role, counter in result.items()}


def remotes_from_creeps(room_summaries):
    """从 creep 名里的目标房推断母房→外矿映射（目标房 ≠ 所在房）。"""
    result = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    for summary in room_summaries:
        home = summary['room']
        for creep in summary['creeps']['list']:
            target = creep.get('targetRoom')
            if target and target != home:
                result[home][target][creep['role']] += 1
    return {home: {room: dict(roles) for room, roles in targets.items()} for home, targets in result.items()}


def aggregate_rooms(room_summaries):
    """全部己方房的分布统计。"""
    if not room_summaries:
        return {}
    rcl = collections.Counter(s['rcl'] for s in room_summaries)
    link_kinds = collections.Counter()
    for s in room_summaries:
        link_kinds.update(s['linkKinds'])
    creeps = [s['creeps']['count'] for s in room_summaries]
    storage = [s['storageEnergy'] for s in room_summaries if s['storageEnergy'] is not None]
    areas = [s['core']['area'] for s in room_summaries if s['core']]
    ctrl_dist = [s['distances']['storageToController'] for s in room_summaries
                 if s['distances'] and s['distances']['storageToController'] is not None]
    src_dist = [d for s in room_summaries if s['distances'] for d in s['distances']['storageToSources']]
    ramparts = [s['ramparts']['n'] for s in room_summaries]
    roles = collections.Counter()
    for s in room_summaries:
        roles.update(s['creeps']['roles'])
    return {
        'rooms': len(room_summaries),
        'rcl': dict(rcl),
        'creepsPerRoom': {'mean': round(statistics.mean(creeps), 1), 'min': min(creeps), 'max': max(creeps)},
        'rolesTotal': dict(roles.most_common()),
        'linkKinds': dict(link_kinds),
        'storageEnergy': {'median': statistics.median(storage), 'min': min(storage), 'max': max(storage)}
        if storage else None,
        'coreArea': {'median': statistics.median(areas), 'min': min(areas), 'max': max(areas)} if areas else None,
        'storageToController': {'median': statistics.median(ctrl_dist), 'max': max(ctrl_dist)}
        if ctrl_dist else None,
        'storageToSource': {'median': statistics.median(src_dist), 'max': max(src_dist)} if src_dist else None,
        'ramparts': {'median': statistics.median(ramparts), 'max': max(ramparts)},
        'spawnsBusy': sum(s['spawns']['busy'] for s in room_summaries),
        'spawnsTotal': sum(s['spawns']['n'] for s in room_summaries),
    }


# ---- 账号统计换算 ----

def derive_rates(stats, rooms, tick_seconds, interval):
    """把 /api/user/stats 的滚动窗口换算成每房每 tick 的速率。

    stats: {energyHarvested, energyControl, energyCreeps, energyConstruction, creepsProduced(部件数), creepsLost, powerProcessed}
    tick_seconds: 该玩家主要 shard 的平均 tick 秒数；rooms: 房间数。
    """
    minutes = interval * STATS_BIN_MINUTES
    ticks = minutes * 60.0 / tick_seconds if tick_seconds else 0
    denom = ticks * max(rooms, 1)
    harvested = stats.get('energyHarvested', 0) or 0
    creeps = stats.get('energyCreeps', 0) or 0
    parts = stats.get('creepsProduced', 0) or 0
    result = {
        'interval': interval, 'windowMinutes': minutes, 'ticks': round(ticks),
        'harvestPerRoomTick': round(harvested / denom, 2) if denom else None,
        'controlPerRoomTick': round((stats.get('energyControl', 0) or 0) / denom, 2) if denom else None,
        'creepsPerRoomTick': round(creeps / denom, 2) if denom else None,
        'constructionPerRoomTick': round((stats.get('energyConstruction', 0) or 0) / denom, 2) if denom else None,
        'partsPerRoomHour': round(parts / max(rooms, 1) / (minutes / 60.0), 1) if minutes else None,
        'energyPerPart': round(creeps / parts, 1) if parts else None,
        'controlShare': round((stats.get('energyControl', 0) or 0) / harvested, 3) if harvested else None,
        'creepShare': round(creeps / harvested, 3) if harvested else None,
        'constructionShare': round((stats.get('energyConstruction', 0) or 0) / harvested, 3) if harvested else None,
        'lostPerKParts': round(1000.0 * (stats.get('creepsLost', 0) or 0) / parts, 2) if parts else None,
        'powerProcessed': stats.get('powerProcessed'),
    }
    return result


# ---- room-history 行为分析 ----

def _apply_diff(state, oid, diff):
    if diff is None:
        state.pop(oid, None)
        return
    current = state.get(oid)
    if current is None:
        state[oid] = dict(diff)
        return
    for key, value in diff.items():
        if key == 'store' and isinstance(value, dict) and isinstance(current.get('store'), dict):
            current['store'] = dict(current['store'])
            current['store'].update(value)
        else:
            current[key] = value


def _neighbor_kinds(state, x, y, exclude_id=None):
    kinds = set()
    for oid, obj in state.items():
        if oid == exclude_id or obj.get('x') is None:
            continue
        if abs(obj['x'] - x) <= 1 and abs(obj['y'] - y) <= 1:
            kinds.add(obj.get('type'))
    return kinds


UNLOAD_TARGET_ORDER = ('link', 'storage', 'terminal', 'spawn', 'extension', 'tower', 'lab', 'container',
                       'powerSpawn', 'nuker', 'controller')


def summarize_history(history, owner_id=None):
    """回放 100 tick 的 room-history：每个 creep 的移动步数、装卸对象与吞吐；spawn 事件；源消耗。"""
    ticks = history.get('ticks') or {}
    keys = sorted(ticks, key=int)
    if not keys:
        return {'room': history.get('room'), 'base': history.get('base'), 'ticks': 0}
    state = {}
    for oid, obj in (ticks[keys[0]] or {}).items():
        _apply_diff(state, oid, obj)
    tracks = collections.defaultdict(list)
    names = {}
    bodies = {}
    spawn_events = []
    source_deltas = collections.defaultdict(list)
    spawns_seen = {}
    prev_source_energy = {oid: o.get('energy') for oid, o in state.items() if o.get('type') == 'source'}
    for oid, obj in state.items():
        if obj.get('type') == 'spawn' and obj.get('spawning'):
            spawns_seen[oid] = obj['spawning'].get('name')
            spawn_events.append({'tick': int(keys[0]), 'name': obj['spawning'].get('name'),
                                 'needTime': obj['spawning'].get('needTime'), 'ongoing': True,
                                 'role': parse_creep_name(obj['spawning'].get('name'))['role']})

    def record(tick):
        for oid, obj in state.items():
            if obj.get('type') == 'creep' and (owner_id is None or obj.get('user') == owner_id):
                names.setdefault(oid, obj.get('name'))
                bodies.setdefault(oid, obj.get('body'))
                tracks[oid].append((tick, obj.get('x'), obj.get('y'), _store_energy(obj)))

    record(int(keys[0]))
    for key in keys[1:]:
        tick = int(key)
        for oid, diff in (ticks[key] or {}).items():
            if diff and diff.get('type') == 'spawn' or (oid in state and state[oid].get('type') == 'spawn'):
                if diff and diff.get('spawning'):
                    spawning = diff['spawning']
                    if spawns_seen.get(oid) != spawning.get('name'):
                        spawns_seen[oid] = spawning.get('name')
                        spawn_events.append({'tick': tick, 'name': spawning.get('name'),
                                             'needTime': spawning.get('needTime'),
                                             'role': parse_creep_name(spawning.get('name'))['role']})
            _apply_diff(state, oid, diff)
        for oid, obj in state.items():
            if obj.get('type') == 'source':
                before = prev_source_energy.get(oid)
                now = obj.get('energy')
                if before is not None and now is not None and now < before:
                    source_deltas[oid].append(before - now)
                prev_source_energy[oid] = now
        record(tick)

    per_creep = []
    for oid, track in tracks.items():
        name = names.get(oid)
        body = bodies.get(oid)
        parsed = parse_creep_name(name)
        moves = sum(1 for a, b in zip(track, track[1:]) if (a[1], a[2]) != (b[1], b[2]))
        unloads = collections.Counter()
        unloaded = 0
        loaded = 0
        for a, b in zip(track, track[1:]):
            if b[3] < a[3]:
                unloaded += a[3] - b[3]
                kinds = _neighbor_kinds(state, b[1], b[2], exclude_id=oid)
                target = next((k for k in UNLOAD_TARGET_ORDER if k in kinds), 'none')
                unloads[target] += 1
            elif b[3] > a[3]:
                loaded += b[3] - a[3]
        per_creep.append({'name': name, 'role': parsed['role'], 'signature': body_signature(body),
                          'ticksPresent': len(track), 'moves': moves,
                          'movesPerTick': round(moves / max(len(track) - 1, 1), 3),
                          'unloaded': unloaded, 'loaded': loaded, 'unloadTargets': dict(unloads),
                          'start': track[0][1:3], 'end': track[-1][1:3]})

    by_role = collections.defaultdict(lambda: {'creeps': 0, 'ticks': 0, 'moves': 0, 'unloaded': 0,
                                               'unloadTargets': collections.Counter()})
    for entry in per_creep:
        bucket = by_role[entry['role']]
        bucket['creeps'] += 1
        bucket['ticks'] += entry['ticksPresent']
        bucket['moves'] += entry['moves']
        bucket['unloaded'] += entry['unloaded']
        bucket['unloadTargets'].update(entry['unloadTargets'])
    roles = {}
    for role, bucket in by_role.items():
        roles[role] = {'creeps': bucket['creeps'],
                       'movesPerTick': round(bucket['moves'] / max(bucket['ticks'], 1), 3),
                       'unloadedPerTick': round(bucket['unloaded'] / max(bucket['ticks'], 1), 2),
                       'unloadTargets': dict(bucket['unloadTargets'])}
    sources = {}
    for oid, deltas in source_deltas.items():
        sources[oid] = {'harvestPerTick': round(statistics.mean(deltas), 1), 'harvestTicks': len(deltas)}
    return {
        'room': history.get('room'), 'base': history.get('base'), 'ticks': len(keys),
        'creeps': per_creep, 'roles': roles, 'spawnEvents': spawn_events,
        'sources': sources,
        'sourceHarvestPerTick': {oid: s['harvestPerTick'] for oid, s in sources.items()},
    }



# ---- 快照差分 ----

def diff_summaries(prev, cur):
    """两轮 summary 的变化：房间数、GCL、名次、新出现的身体签名、结构类型变化。"""
    if not prev:
        return {'first': True}
    changes = {}
    for key in ('gcl', 'power', 'rooms'):
        before = (prev.get('profile') or {}).get(key)
        after = (cur.get('profile') or {}).get(key)
        if before != after:
            changes[key] = {'from': before, 'to': after}
    prev_arch = prev.get('archetypes') or {}
    cur_arch = cur.get('archetypes') or {}
    new_sig = {}
    for role, sigs in cur_arch.items():
        added = sorted(set(sigs) - set(prev_arch.get(role, {})))
        if added:
            new_sig[role] = added
    if new_sig:
        changes['newSignatures'] = new_sig
    gone = sorted(set(prev_arch) - set(cur_arch))
    if gone:
        changes['rolesGone'] = gone
    prev_rooms = {r['room'] for r in prev.get('roomList', [])}
    cur_rooms = {r['room'] for r in cur.get('roomList', [])}
    if prev_rooms - cur_rooms:
        changes['roomsLost'] = sorted(prev_rooms - cur_rooms)
    if cur_rooms - prev_rooms:
        changes['roomsGained'] = sorted(cur_rooms - prev_rooms)
    return changes


# ---- ASCII 渲染 ----

SYMBOLS = {'spawn': 'S', 'extension': 'e', 'road': '.', 'tower': 'T', 'storage': '$', 'terminal': 'M',
           'link': 'L', 'lab': 'b', 'container': 'c', 'constructedWall': 'W', 'source': '@', 'controller': 'C',
           'mineral': 'm', 'extractor': 'x', 'powerSpawn': 'P', 'nuker': 'N', 'observer': 'O', 'factory': 'F',
           'creep': 'k'}


def render_ascii(objs, terrain=None):
    """把房间渲染成 50 行文本：# 墙、' 沼泽、r rampart（覆盖在结构上时结构字母大写）。"""
    grid = []
    for y in range(50):
        row = []
        for x in range(50):
            code = terrain[y * 50 + x] if terrain and len(terrain) >= 2500 else '0'
            row.append('#' if code == '1' else ("'" if code == '2' else ' '))
        grid.append(row)
    ramparts = set()
    for obj in objs:
        kind = obj.get('type')
        if kind == 'rampart':
            ramparts.add((obj['x'], obj['y']))
        elif kind in SYMBOLS:
            grid[obj['y']][obj['x']] = SYMBOLS[kind]
    for x, y in ramparts:
        cell = grid[y][x]
        grid[y][x] = 'r' if cell in (' ', "'", '#', '.') else cell.upper()
    lines = ['   ' + ''.join(str(x % 10) for x in range(50))]
    for y in range(50):
        lines.append('%2d ' % y + ''.join(grid[y]))
    return '\n'.join(lines)
