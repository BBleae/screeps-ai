"""情报：把官方 API 的 room-objects / map-stats 转成游戏内 Memory.map 同构的条目。

不需要任何视野：room-objects 对任意房间都返回全部对象（含他人 creep 与 body）。
"""
import re
import time

from . import combat

ROOM_RE = re.compile(r'^([WE])(\d+)([NS])(\d+)$')
ARMED_PARTS = ('attack', 'ranged_attack', 'heal')
INVADER_USER = '2'
KEEPER_USER = '3'


def parse_room(name):
    match = ROOM_RE.match(name)
    if not match:
        raise ValueError('bad room name: %s' % name)
    hx, x, vy, y = match.groups()
    return hx, int(x), vy, int(y)


def room_coords(name):
    """房间名 → 全局整数坐标（W/N 为负半轴：W0 = -1，E0 = 0）。"""
    hx, x, vy, y = parse_room(name)
    wx = -(x + 1) if hx == 'W' else x
    wy = -(y + 1) if vy == 'N' else y
    return wx, wy


def room_name(wx, wy):
    hx = 'W' if wx < 0 else 'E'
    x = -wx - 1 if wx < 0 else wx
    vy = 'N' if wy < 0 else 'S'
    y = -wy - 1 if wy < 0 else wy
    return '%s%d%s%d' % (hx, x, vy, y)


def room_distance(a, b):
    ax, ay = room_coords(a)
    bx, by = room_coords(b)
    return max(abs(ax - bx), abs(ay - by))


def ring_rooms(center, radius):
    """中心房 Chebyshev 半径 radius 内的房间（不含中心），按距离再按名字排序。"""
    cx, cy = room_coords(center)
    rooms = []
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx == 0 and dy == 0:
                continue
            rooms.append(room_name(cx + dx, cy + dy))
    rooms.sort(key=lambda name: (room_distance(center, name), name))
    return rooms


def room_class(name):
    """normal / highway / sk（Source Keeper 房）/ center（区中心）。"""
    _, x, _, y = parse_room(name)
    mx, my = x % 10, y % 10
    if mx == 0 or my == 0:
        return 'highway'
    if mx == 5 and my == 5:
        return 'center'
    if mx in (4, 5, 6) and my in (4, 5, 6):
        return 'sk'
    return 'normal'


def armed(body):
    return any((part.get('type') if isinstance(part, dict) else part) in ARMED_PARTS for part in body or [])


def _username(users, user_id):
    if not user_id:
        return None
    info = (users or {}).get(str(user_id)) or {}
    return info.get('username') or ('Invader' if str(user_id) == INVADER_USER else
                                    'Source Keeper' if str(user_id) == KEEPER_USER else str(user_id))


def build_entry(room, objects, users, tick, my_user_id=None, owner_stat=None):
    """room-objects → Memory.map 条目。tick 为拉取时的游戏 tick（用于 at 与 reservation 剩余）。"""
    objects = objects or []
    by_type = {}
    for obj in objects:
        by_type.setdefault(obj.get('type'), []).append(obj)
    controller = (by_type.get('controller') or [None])[0]
    sources = sorted(by_type.get('source') or [], key=lambda o: str(o.get('_id')))
    creeps = [c for c in by_type.get('creep') or [] if str(c.get('user')) != str(my_user_id)]
    hostile_creeps = [c for c in creeps if str(c.get('user')) != KEEPER_USER]
    armed_hostiles = [c for c in hostile_creeps if armed(c.get('body'))]
    # safe mode 决策（safemode.py）要看：武装敌人的主人（NPC 还是玩家）、塔的能量、还剩几次 safe mode
    hostile_owners = sorted(set(_username(users, c.get('user')) or str(c.get('user')) for c in armed_hostiles))
    tower_energy = sum(int(((obj.get('store') or {}).get('energy')) or 0) for obj in objects if obj.get('type') == 'tower')
    structures = {}
    for obj in objects:
        kind = obj.get('type')
        if kind in ('creep', 'source', 'mineral', 'controller', 'energy', 'tombstone', 'ruin'):
            continue
        structures[kind] = structures.get(kind, 0) + 1
    owner_id = controller and controller.get('user')
    owner = _username(users, owner_id) if owner_id else None
    if not owner and owner_stat:
        owner = owner_stat
    reservation = None
    if controller and controller.get('reservation'):
        res = controller['reservation']
        ticks_to_end = max(0, int(res.get('endTime', 0)) - int(tick))
        if ticks_to_end > 0:
            reservation = {'username': _username(users, res.get('user')), 'ticksToEnd': ticks_to_end,
                           'mine': bool(my_user_id) and str(res.get('user')) == str(my_user_id)}
    mineral = (by_type.get('mineral') or [None])[0]
    invader_core = bool(by_type.get('invaderCore'))
    lairs = len(by_type.get('keeperLair') or [])
    safe_mode = bool(controller and int(controller.get('safeMode') or 0) > int(tick))
    entry = {
        'at': int(tick),
        'seenAt': int(time.time() * 1000),
        'source': 'external',
        'class': room_class(room),
        'sources': len(sources),
        'sourceData': [{'id': str(s.get('_id')), 'x': s.get('x'), 'y': s.get('y'),
                        'energyCapacity': s.get('energyCapacity', 3000)} for s in sources],
        'lairs': lairs,
        # keeper lair 坐标：travel_ticks 的 A* 与游戏端 movement.keeperAvoidCallback 都用它绕开 keeper 杀伤圈，
        # 让 claimer/pioneer 能保持距离穿过 SK 房（非 SK 房此列表为空，无副作用）
        'lairPos': [{'x': o.get('x'), 'y': o.get('y')} for o in by_type.get('keeperLair', [])
                    if isinstance(o.get('x'), int) and isinstance(o.get('y'), int)],
        'controllerId': str(controller['_id']) if controller else None,
        'controllerPos': {'x': controller.get('x'), 'y': controller.get('y')} if controller else None,
        'spawnPos': next(({'x': o.get('x'), 'y': o.get('y')} for o in objects if o.get('type') == 'spawn'), None),
        'level': int(controller.get('level') or 0) if controller else 0,
        'owner': owner,
        'reservation': reservation,
        'safeMode': safe_mode,
        'safeModeAvailable': int(controller.get('safeModeAvailable') or 0) if controller else 0,
        'hostileOwners': hostile_owners,
        'towerEnergy': tower_energy,
        'mineral': mineral.get('mineralType') if mineral else None,
        'mineralAmount': int(mineral.get('mineralAmount') or 0) if mineral else 0,
        'hostiles': len(hostile_creeps),
        'armedHostiles': len(armed_hostiles),
        # 敌情画像（血量/伤害/治疗/风筝型/强化/到期 tick）：游戏内 defense.threatIn 在没有视野时用它评估，外部 plan_defense 也用
        'hostileProfile': combat.hostile_profile(armed_hostiles, tick) if armed_hostiles else None,
        'invaderCore': invader_core,
        'threat': len(armed_hostiles) > 0 or invader_core,
        'structures': structures,
        'walls': structures.get('constructedWall', 0),
        'blockingWalls': [{'x': o['x'], 'y': o['y']} for o in by_type.get('constructedWall', [])
                          if isinstance(o.get('x'), int) and isinstance(o.get('y'), int)],
        'towers': structures.get('tower', 0),
        'portals': structures.get('portal', 0),
        'powerBank': structures.get('powerBank', 0) > 0,
    }
    return entry


def exits_from_terrain(terrain):
    """四条边是否有出口（边上任一格不是墙）。terrain 为 2500 字符编码串（'1' 位是墙）。"""
    if not terrain or len(terrain) < 2500:
        return None

    def wall(x, y):
        return int(terrain[y * 50 + x]) & 1 == 1
    return {
        'N': any(not wall(x, 0) for x in range(50)),
        'S': any(not wall(x, 49) for x in range(50)),
        'W': any(not wall(0, y) for y in range(50)),
        'E': any(not wall(49, y) for y in range(50)),
    }


def collect(api, homes, radius, my_user_id=None, tick=None, progress=None, map_stats=True, extra_rooms=()):
    """拉取自有房周围 radius 圈的情报，返回 {room: entry}。map-stats 一次拿归属，room-objects 逐房。
    map_stats=False：不调 map-stats（guard.py 每 90 秒只看己方房，主人来自 room-objects 的 controller；
    2026-09-06 guard 上线后 map-stats 被限流 429，连 run.py 也跟着被限）。
    extra_rooms：情报圈之外还要拉的房（占领清单房及其邻房，plan.claim_queue_intel_rooms）"""
    # 母房自身也拉：spawn 有无决定它是否仍在开荒（阻止给无 spawn 的新母房再规划占领）
    rooms = list(homes)
    for home in homes:
        for name in ring_rooms(home, radius):
            if name not in rooms:
                rooms.append(name)
    for name in extra_rooms or ():
        if name not in rooms:
            rooms.append(name)
    tick = tick if tick is not None else api.time()
    stats = api.map_stats(rooms) if (rooms and map_stats) else {}
    owners = {}
    for name, stat in (stats.get('stats') or {}).items():
        own = (stat or {}).get('own') or {}
        # map-stats 对预定房也返回 own.user（level 0），只有 level>0 才是真正拥有
        if own.get('user') and int(own.get('level') or 0) > 0:
            owners[name] = _username(stats.get('users'), own['user'])
    intel = {}
    for name in rooms:
        try:
            payload = api.room_objects(name)
        except Exception as error:  # noqa: BLE001 - 单房失败不阻断整轮
            intel[name] = {'at': int(tick), 'seenAt': int(time.time() * 1000), 'source': 'external',
                           'class': room_class(name), 'unreachable': True, 'error': str(error)[:120]}
            continue
        entry = build_entry(name, payload.get('objects'), payload.get('users'), tick, my_user_id, owners.get(name))
        stat = (stats.get('stats') or {}).get(name) or {}
        now = time.time() * 1000
        if stat:
            entry['roomStatus'] = ('closed' if stat.get('status') == 'out of borders' or (stat.get('openTime') or 0) > now
                                   else 'novice' if (stat.get('novice') or 0) > now
                                   else 'respawn' if (stat.get('respawnArea') or 0) > now else 'normal')
        # 地形出口：判断"强邻"是否真的连通（对角房没有直接出口，被墙封死的边也不通）
        try:
            terrain = api.room_terrain(name) if hasattr(api, 'room_terrain') else None
            if terrain:
                tiles = list(terrain)
                for wall in entry['blockingWalls']:
                    x, y = wall['x'], wall['y']
                    if 0 <= x < 50 and 0 <= y < 50:
                        tiles[y * 50 + x] = '1'
                terrain = ''.join(tiles)
            exits = exits_from_terrain(terrain) if terrain else None
            if exits:
                entry['exits'] = exits
                entry['terrain'] = terrain   # 占领清单按 claimer 实际走多少 tick 选母房（plan.travel_ticks），不进 segment
        except Exception:  # noqa: BLE001 - 出口只是评分辅助
            pass
        intel[name] = entry
        if progress:
            progress(name, entry)
    return intel
