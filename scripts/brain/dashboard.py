#!/usr/bin/env python3
"""监控面板：外部大脑每轮把本轮已经拉到的数据压成一条快照，追加到历史，渲染自包含的 index.html。

用法：
  （自动）scripts/brain/run.py 每轮写完 state.json 后调用 update()；只记官方服务器，--no-dashboard 关闭
  python3 scripts/brain/dashboard.py        # 按已有历史重新渲染（改了模板/口径后用，不调任何 API）
  open data/brain/dashboard/index.html      # 页面在下一轮大脑写完后自动重载；超过 15 分钟没更新会标红

零额外 API：Memory.rooms / Memory.creeps / GCL 点数由 run.py 传入（它本来就读）；room-objects 只读 intel.collect 本轮
留下的磁盘缓存（ScreepsApi.cached_room_objects），缓存里没有的房这一轮就没有它的计数器（速率按实际覆盖的 tick 算，不被稀释）。

口径（全部按 tick 摊平；速率用 tick 差，窗口按墙钟选 1h / 6h / 24h）：
  理论上限  每个源 max(energyCapacity, 3000) / 300：母房和启用中的外矿都按"已预定"算，预定掉了落到 1500 档、
            敌情停用期间采不到都记作损失；SK / 中心房的源是 4000
  实际采集  源 invaderHarvested 的增量（引擎 harvest.js 每次采集都累加；Invader 生成时清零，值变小按从 0 重新累计）
  维持成本  缓存房间里我方 creep 的身体成本 / 寿命（带 CLAIM 600，否则 1500）；外矿 creep 记在母房的该外矿下，
            援建 creep 记在出钱的母房（memory.aid）；内存里有、缓存房间里看不到的 creep 不计价，只计数
  CP/tick   控制器 progress 增量（升级时补上一级剩余；RCL8 的 progress 不再涨，只能看账号 GCL）；账号总量用 GCL 点数增量
  外矿净值  实际采集 − 该外矿 creep 的维持成本：没扣运输损耗、掉落腐烂、道路/容器修理，是上界
  时间对齐  快照 tick 取一轮开始时，对象在这一轮里陆续读到（guard 也会刷新母房缓存），1h 窗口和曲线点有 10% 以内的噪声，6h/24h 首尾相消
"""
import argparse
import bisect
import fcntl
import itertools
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TEMPLATE = os.path.join(HERE, 'dashboard_template.html')
DATA_MARKER = '/*__DASHBOARD_DATA__*/null'
DEFAULT_DIR = os.path.join(ROOT, 'data', 'brain', 'dashboard')

CONTROLLER_LEVELS = {1: 200, 2: 45000, 3: 135000, 4: 405000, 5: 1215000, 6: 3645000, 7: 10935000}
CONTROLLER_DOWNGRADE = {1: 20000, 2: 10000, 3: 20000, 4: 40000, 5: 80000, 6: 120000, 7: 150000, 8: 200000}
BODY_COST = {'move': 50, 'work': 100, 'carry': 50, 'attack': 80, 'ranged_attack': 150, 'heal': 250, 'claim': 600, 'tough': 10}
ARMED_PARTS = ('attack', 'ranged_attack', 'heal')
KEEPER_USER = '3'
CREEP_LIFE = 1500
CLAIM_LIFE = 600
SOURCE_REGEN = 300
RESERVED_SOURCE = 3000
GCL_MULTIPLY = 1e6
GCL_POW = 2.4

# 缓存文件只认 4 分钟内写的：大脑每 5 分钟一轮，更旧的是上一轮留下的（本轮这个房拉取失败），拿来算增量会得到假的 0
CACHE_MAX_AGE = 240
# 看不到身体的 creep 沿用上一轮的价最多 300 tick：creepName 取第一个空闲名字，死掉的名字马上被同角色新 creep 复用
PRICE_CARRY_TICKS = 300
LOCK_WAIT = 30                # 另一个进程持锁（手动跑的大脑被挂起）最多等 30 秒就跳过这一轮，别让 launchd 那轮卡死
KEEP_SECONDS = 7 * 86400
TRIM_SLACK = 86400            # 平时只追加一行；最旧的一条超出保留期一天以上才整份重写裁剪（每 5 分钟重写 5 MB 是白白写盘）
# 相邻两条快照隔太久（本机睡眠/断网）不算增量：期间 Invader 清零看不到，采集会被低估，这段就当没覆盖
MAX_PAIR_GAP = 2 * 3600
WINDOWS = (('1h', 3600), ('6h', 6 * 3600), ('24h', 86400))
SERIES_WINDOW = 3600          # 曲线上每个点是过去 1 小时的速率（源 300 tick 再生一次，5 分钟的差值全是锯齿）
SERIES_BUCKET = 20 * 60       # 曲线每 20 分钟一个点，7 天 ≤ 504 点
ALERT_WINDOW = '6h'
STATE_CODE = {'off': 0, 'on': 1, 'suspended': 2}
ACCOUNT = '@account'


# ---- 快照：本轮数据 → 一个时间点的读数 ----

def part_type(part):
    return part.get('type') if isinstance(part, dict) else part


def body_upkeep(body):
    """一只 creep 每 tick 摊掉的孵化成本"""
    parts = [part_type(part) for part in body or []]
    life = CLAIM_LIFE if 'claim' in parts else CREEP_LIFE
    return sum(BODY_COST.get(part, 0) for part in parts) / life


def store_energy(obj, key='store'):
    store = obj.get(key)
    return int(store.get('energy') or 0) if isinstance(store, dict) else 0


def source_counters(objects):
    """源按 _id 排序（与 intel.build_entry 一致）→ [[invaderHarvested, energyCapacity], ...]"""
    sources = sorted((o for o in objects if o.get('type') == 'source'), key=lambda o: str(o.get('_id')))
    return [[int(o.get('invaderHarvested') or 0), int(o.get('energyCapacity') or 0)] for o in sources]


def room_view(objects, my_id, tick):
    """一个房的 room-objects → 仪表读数（母房和外矿共用）"""
    my_id = str(my_id)
    tick = int(tick)
    view = {
        'sources': source_counters(objects),
        'ground': sum(int(o.get('energy') or 0) for o in objects
                      if o.get('type') == 'energy' and (o.get('resourceType') or 'energy') == 'energy'),
        'invaderCore': any(o.get('type') == 'invaderCore' for o in objects),
        'containers': sum(1 for o in objects if o.get('type') == 'container'),
    }
    hostile = [o for o in objects if o.get('type') == 'creep' and str(o.get('user')) not in (my_id, KEEPER_USER)]
    view['hostiles'] = len(hostile)
    view['armed'] = sum(1 for o in hostile if any(part_type(p) in ARMED_PARTS for p in o.get('body') or []))
    controller = next((o for o in objects if o.get('type') == 'controller'), None)
    if controller:
        view['rcl'] = int(controller.get('level') or 0)
        view['prog'] = int(controller.get('progress') or 0)
        down = controller.get('downgradeTime')
        view['downgrade'] = int(down) - tick if down and str(controller.get('user')) == my_id else None
        view['safeMode'] = int(controller.get('safeMode') or 0) > tick
        reservation = controller.get('reservation') or {}
        left = int(reservation.get('endTime') or 0) - tick
        # 预定剩余：正数是我方，负数是别人
        view['reserve'] = (left if str(reservation.get('user')) == my_id else -left) if left > 0 else 0
    mine = [o for o in objects if str(o.get('user')) == my_id]
    view['energy'] = sum(store_energy(o) for o in mine if o.get('type') in ('spawn', 'extension'))
    view['cap'] = sum(store_energy(o, 'storeCapacityResource') for o in mine if o.get('type') in ('spawn', 'extension'))
    storages = [o for o in mine if o.get('type') == 'storage']
    view['storage'] = sum(store_energy(o) for o in storages) if storages else None
    terminals = [o for o in mine if o.get('type') == 'terminal']
    view['terminal'] = sum(store_energy(o) for o in terminals) if terminals else None
    towers = [o for o in mine if o.get('type') == 'tower']
    view['towers'] = [sum(store_energy(o) for o in towers), sum(store_energy(o, 'storeCapacityResource') for o in towers)]
    view['sites'] = sum(1 for o in mine if o.get('type') == 'constructionSite')
    spawns = [o for o in mine if o.get('type') == 'spawn']
    view['spawns'] = [sum(1 for o in spawns if o.get('spawning')), len(spawns)]
    return view


def creep_ledger(objects_by_room, creep_memory, my_id, known=None, tick=0):
    """我方 creep 分账 → (按 memory.home 的编制 {房: {'roles', 'creeps'}}, 按出钱母房的维持成本 {房: {'own', 'remotes', 'unpriced'}},
    本轮定得出价的 {creep 名: [每 tick 成本, 最近一次看到身体的 tick]})。站在本轮没拉到的房里的 creep 用上一轮记下的价（known，
    PRICE_CARRY_TICKS 内）：否则缓存缺一个房，那里的 creep 这一段的维持成本就掉成 0、覆盖 tick 却照算，净额被高估"""
    known = known or {}
    priced = {}
    bodies = {}
    for objects in objects_by_room.values():
        for obj in objects or []:
            if obj.get('type') == 'creep' and str(obj.get('user')) == str(my_id) and obj.get('name'):
                bodies[obj['name']] = obj.get('body')
    staff = {}
    pay = {}
    for name, mem in (creep_memory or {}).items():
        if not isinstance(mem, dict) or not mem.get('home'):
            continue
        home = mem['home']
        crew = staff.setdefault(home, {'roles': {}, 'creeps': 0})
        role = str(mem.get('role') or '?')
        crew['roles'][role] = crew['roles'].get(role, 0) + 1
        crew['creeps'] += 1
        payer = pay.setdefault(mem.get('aid') or home, {'own': 0.0, 'remotes': {}, 'unpriced': 0})
        body = bodies.get(name)
        upkeep = seen = None
        if body is not None:
            upkeep, seen = body_upkeep(body), int(tick)
        else:
            carried = known.get(name)
            if isinstance(carried, list) and len(carried) == 2 and all(isinstance(v, (int, float)) for v in carried) \
                    and int(tick) - carried[1] <= PRICE_CARRY_TICKS:
                upkeep, seen = carried
        if upkeep is None:
            payer['unpriced'] += 1
            continue
        priced[name] = [round(upkeep, 4), seen]
        remote = mem.get('remoteRoom')
        if remote and remote != home:
            slot = payer['remotes'].setdefault(remote, [0.0, 0])
            slot[0] += upkeep
            slot[1] += 1
        else:
            payer['own'] += upkeep
    return staff, pay, priced


def remote_state(record, tick):
    if not isinstance(record, dict) or record.get('enabled') is False:
        return 'off'
    if int(record.get('suspendedUntil') or 0) > int(tick):
        return 'suspended'
    return 'on'


def _ema(mem, key):
    value = (mem.get(key) or {}).get('ema') if isinstance(mem.get(key), dict) else None
    return round(float(value), 2) if isinstance(value, (int, float)) else None


def whitelist_names(directive):
    out = {}
    for home, entry in ((directive or {}).get('rooms') or {}).items():
        names = []
        for item in (entry or {}).get('remotes') or []:
            name = item if isinstance(item, str) else (item or {}).get('room')
            if name:
                names.append(name)
        out[home] = names
    return out


def build_snapshot(tick, now, me, homes, memory_rooms, creep_memory, objects_by_room, whitelist=None, brain=None,
                   known_upkeep=None):
    me = me or {}
    my_id = str(me.get('_id') or '')
    memory_rooms = memory_rooms or {}
    whitelist = whitelist or {}
    staff, pay, priced = creep_ledger(objects_by_room, creep_memory, my_id, known_upkeep, tick)
    # 同一外矿被两个母房同时启用时采集只记一次：优先大脑白名单里的那个母房
    counted = {}
    for prefer_whitelist in (True, False):
        for home in homes:
            for name, record in ((memory_rooms.get(home) or {}).get('remotes') or {}).items():
                if remote_state(record, tick) == 'off':
                    continue
                if prefer_whitelist and name not in (whitelist.get(home) or []):
                    continue
                counted.setdefault(name, home)
    snap = {'v': 1, 't': int(tick), 'at': round(float(now), 1), 'gcl': int(me.get('gcl') or 0),
            'me': me.get('username'), 'brain': brain or {}, 'rooms': {}, 'priced': priced}
    for home in homes:
        mem = memory_rooms.get(home) or {}
        objects = objects_by_room.get(home)
        room = {'seen': objects is not None}
        room.update(room_view(objects, my_id, tick) if objects is not None else {})
        state = mem.get('state') or {}
        waiting = (mem.get('spawnQueue') or {}).get('waiting')
        crew = staff.get(home) or {'roles': {}, 'creeps': 0}
        bill = pay.get(home) or {'own': 0.0, 'remotes': {}, 'unpriced': 0}
        room.update({
            'income': _ema(mem, 'spawnIncome'), 'spend': _ema(mem, 'spawnSpend'),
            'recovering': bool(state.get('recovering')), 'emergency': bool(state.get('emergencyHarvest')),
            'queue': ({'key': waiting.get('key'), 'waited': waiting.get('waited'), 'eta': waiting.get('eta')}
                      if isinstance(waiting, dict) else None),
            'roles': crew['roles'], 'creeps': crew['creeps'], 'unpriced': bill['unpriced'],
            'upkeep': round(bill['own'], 3), 'remotes': {},
        })
        records = mem.get('remotes') or {}
        for name in sorted(set(records) | set(bill['remotes'])):
            record = records.get(name)
            state_name = remote_state(record, tick)
            upkeep, count = bill['remotes'].get(name, [0.0, 0])
            if state_name == 'off' and not count:
                continue   # 没启用也没人在干活的旧记录：面板上是噪声
            record = record if isinstance(record, dict) else {}
            remote_objects = objects_by_room.get(name)
            view = room_view(remote_objects, my_id, tick) if remote_objects is not None else {}
            sources = record.get('sources') or []
            drop = (record.get('drop') or {}).get('room')
            reserve = view.get('reserve')
            if reserve is None and isinstance(record.get('reservation'), dict):
                reservation = record['reservation']
                left = int(reservation.get('ticksToEnd') or 0)
                reserve = left if reservation.get('username') == me.get('username') else -left
            room['remotes'][name] = {
                'state': state_name, 'why': record.get('suspendReason'),
                'until': int(record.get('suspendedUntil') or 0) if state_name == 'suspended' else None,
                'whitelist': name in (whitelist.get(home) or []), 'counted': counted.get(name) == home,
                'seen': remote_objects is not None, 'sources': view.get('sources'),
                'ground': view.get('ground'), 'armed': view.get('armed'), 'invaderCore': view.get('invaderCore'),
                'reserve': reserve, 'containers': sum(1 for s in sources if s.get('containerId')),
                'dist': [s.get('distance') for s in sources], 'drop': drop if drop and drop != home else None,
                'upkeep': round(upkeep, 3), 'creeps': count,
            }
        snap['rooms'][home] = room
    return snap


def history_entry(snap):
    """快照 → 历史里的一行：只留累计计数器和算速率要用的读数"""
    rooms = {}
    for home, room in (snap.get('rooms') or {}).items():
        entry = {key: room.get(key) for key in ('rcl', 'prog', 'storage', 'income', 'spend', 'upkeep', 'sources')
                 if room.get(key) is not None}
        entry['remotes'] = {name: [STATE_CODE[r['state']], r['upkeep'], 1 if r['counted'] else 0,
                                   r['sources'] if r['counted'] else None]
                            for name, r in (room.get('remotes') or {}).items()}
        rooms[home] = entry
    return {'v': 1, 't': snap['t'], 'at': snap['at'], 'gcl': snap.get('gcl') or 0, 'rooms': rooms}


# ---- 速率：历史 → 每个作用域每个指标的累计量 ----

def source_step(prev_sources, cur_sources, dt):
    """同一房相邻两次的源计数器 → (采集, 上限)；源数量对不上（缓存缺字段）就不算"""
    if not prev_sources or not cur_sources or len(prev_sources) != len(cur_sources):
        return None
    harvest = ceiling = 0.0
    for (prev_harvested, capacity), (harvested, _) in zip(prev_sources, cur_sources):
        harvest += harvested - prev_harvested if harvested >= prev_harvested else harvested
        ceiling += max(capacity, RESERVED_SOURCE) / SOURCE_REGEN * dt
    return harvest, ceiling


def cp_step(prev, cur):
    level, progress = prev.get('rcl'), prev.get('prog')
    new_level, new_progress = cur.get('rcl'), cur.get('prog')
    if None in (level, progress, new_level, new_progress) or level >= 8 or new_level >= 8:
        return None
    if new_level == level:
        return max(0, new_progress - progress)
    if new_level == level + 1:
        # 引擎升级是 progress -= CONTROLLER_LEVELS[level]；降级会把 progress 抬到超过本级所需，所以不能先夹 0 再加
        gained = new_progress + CONTROLLER_LEVELS.get(level, 0) - progress
        return gained if gained >= 0 else None
    return None   # 降级或跨多级：这一段不算


def step(prev, cur):
    """相邻两条历史 → {作用域: {指标: (增量, 覆盖 tick)}}；作用域是 '@account'、母房名、'母房>外矿'"""
    dt = int(cur.get('t') or 0) - int(prev.get('t') or 0)
    if dt <= 0 or float(cur.get('at') or 0) - float(prev.get('at') or 0) > MAX_PAIR_GAP:
        return {}
    out = {}

    def add(scope, metric, value):
        if value is not None:
            out.setdefault(scope, {})[metric] = (float(value), dt)

    if int(prev.get('gcl') or 0) > 0 and int(cur.get('gcl') or 0) >= int(prev['gcl']):
        add(ACCOUNT, 'cp', int(cur['gcl']) - int(prev['gcl']))
    prev_rooms = prev.get('rooms') or {}
    for home, room in (cur.get('rooms') or {}).items():
        before = prev_rooms.get(home)
        if not before:
            continue
        add(home, 'cp', cp_step(before, room))
        own = source_step(before.get('sources'), room.get('sources'), dt)
        if own:
            add(home, 'hOwn', own[0])
            add(home, 'cOwn', own[1])
        for metric, key in (('upOwn', 'upkeep'), ('income', 'income'), ('spend', 'spend')):
            if before.get(key) is not None:
                add(home, metric, before[key] * dt)
        if before.get('storage') is not None and room.get('storage') is not None:
            add(home, 'storage', room['storage'] - before['storage'])
        harvest = ceiling = upkeep_total = 0.0
        active = unseen = False
        now_remotes = room.get('remotes') or {}
        for name, (code, upkeep, counted, sources) in (before.get('remotes') or {}).items():
            scope = home + '>' + name
            upkeep_total += (upkeep or 0) * dt
            add(scope, 'upkeep', (upkeep or 0) * dt)
            if not counted or code == STATE_CODE['off']:
                continue
            active = True
            later = now_remotes.get(name)
            got = source_step(sources, later[3] if later else None, dt)
            if not got:
                unseen = True
                continue
            add(scope, 'h', got[0])
            add(scope, 'c', got[1])
            harvest += got[0]
            ceiling += got[1]
        add(home, 'upRem', upkeep_total)
        if not active:
            add(home, 'hRem', 0)
            add(home, 'cRem', 0)
        elif not unseen:
            # 有一个外矿这一段没拉到（或记账换到了别的母房）就整段不算：只加看得到的那几个会按整段 tick 稀释
            add(home, 'hRem', harvest)
            add(home, 'cRem', ceiling)
    return out


def accumulate(entries):
    """→ {(作用域, 指标): (累计增量[], 累计覆盖 tick[])}，与 entries 一一对应"""
    size = len(entries)
    raw = {}
    for index in range(1, size):
        for scope, metrics in step(entries[index - 1], entries[index]).items():
            for metric, (value, ticks) in metrics.items():
                values, covered = raw.setdefault((scope, metric), ([0.0] * size, [0] * size))
                values[index] += value
                covered[index] += ticks
    return {key: (list(itertools.accumulate(values)), list(itertools.accumulate(covered)))
            for key, (values, covered) in raw.items()}


def window_start(ats, index, seconds):
    start = bisect.bisect_left(ats, ats[index] - seconds, 0, index + 1)
    return index - 1 if start >= index and index > 0 else start


def window_rate(tracks, key, index, start):
    track = tracks.get(key)
    if not track or start >= index:
        return None
    covered = track[1][index] - track[1][start]
    if covered <= 0:
        return None
    return (track[0][index] - track[0][start]) / covered


def _sum(*values):
    present = [v for v in values if v is not None]
    return sum(present) if present else None


def _ratio(numerator, denominator):
    return numerator / denominator if numerator is not None and denominator else None


def _minus(a, b):
    return a - b if a is not None and b is not None else None


def _round(value, digits=2):
    return None if value is None else round(value, digits)


def room_rates(tracks, home, index, start):
    def rate(metric):
        return window_rate(tracks, (home, metric), index, start)
    stats = {metric: rate(metric) for metric in
             ('cp', 'hOwn', 'cOwn', 'hRem', 'cRem', 'upOwn', 'upRem', 'income', 'spend', 'storage')}
    stats['harvest'] = _sum(stats['hOwn'], stats['hRem'])
    stats['ceiling'] = _sum(stats['cOwn'], stats['cRem'])
    stats['upkeep'] = _sum(stats['upOwn'], stats['upRem'])
    stats['effOwn'] = _ratio(stats['hOwn'], stats['cOwn'])
    stats['effRem'] = _ratio(stats['hRem'], stats['cRem'])
    stats['eff'] = _ratio(stats['harvest'], stats['ceiling'])
    stats['net'] = _minus(stats['harvest'], stats['upkeep'])
    return stats


def remote_rates(tracks, scope, index, start):
    harvest = window_rate(tracks, (scope, 'h'), index, start)
    ceiling = window_rate(tracks, (scope, 'c'), index, start)
    upkeep = window_rate(tracks, (scope, 'upkeep'), index, start)
    return {'h': harvest, 'c': ceiling, 'eff': _ratio(harvest, ceiling), 'upkeep': upkeep, 'net': _minus(harvest, upkeep)}


def series_indices(ats):
    """每 SERIES_BUCKET 秒取最后一条"""
    picked = []
    for index, at in enumerate(ats):
        if picked and int(ats[picked[-1]] // SERIES_BUCKET) == int(at // SERIES_BUCKET):
            picked[-1] = index
        else:
            picked.append(index)
    return picked


# ---- 视图：页面要的全部数字 ----

def gcl_info(points):
    if not points:
        return {'level': 0, 'points': 0, 'progress': None, 'remaining': None}
    level = int((points / GCL_MULTIPLY) ** (1 / GCL_POW)) + 1
    start = (level - 1) ** GCL_POW * GCL_MULTIPLY
    end = level ** GCL_POW * GCL_MULTIPLY
    return {'level': level, 'points': points, 'progress': (points - start) / (end - start), 'remaining': end - points}


def room_alerts(room, stats, remote_stats):
    alerts = []

    def add(level, text):
        alerts.append({'level': level, 'text': text})

    if room.get('armed'):
        add('critical', '敌袭：%d 个武装敌人' % room['armed'])
    if room.get('recovering'):
        add('critical', '恢复模式')
    if room.get('emergency'):
        add('critical', '紧急采集')
    # 降级计时上限随等级变（RCL2 只有 10000，刚升级时引擎还会砍半），固定阈值会让每个新房在 RCL2 一直挂红
    limit = CONTROLLER_DOWNGRADE.get(room.get('rcl'))
    if room.get('downgrade') is not None and limit and room['downgrade'] < min(10000, 0.3 * limit):
        add('critical', '控制器 %d tick 后降级' % room['downgrade'])
    for name, remote in sorted((room.get('remotes') or {}).items()):
        if remote.get('armed'):
            add('critical', '外矿 %s 有 %d 个武装敌人' % (name, remote['armed']))
    if not room.get('seen'):
        add('warning', '本轮没拿到房间对象')
    queue = room.get('queue') or {}
    if (queue.get('waited') or 0) >= 300:
        add('warning', '孵化排队 %s 已等 %d tick' % (queue.get('key'), queue['waited']))
    window = stats.get(ALERT_WINDOW) or {}
    if window.get('effOwn') is not None and window['effOwn'] < 0.8:
        add('warning', '本房采集率 %d%%' % round(window['effOwn'] * 100))
    if window.get('storage') is not None and window['storage'] < -20 and (room.get('storage') or 0) < 20000:
        add('warning', 'storage 在掉 %.0f/tick' % -window['storage'])
    for name, remote in sorted((room.get('remotes') or {}).items()):
        if remote['state'] == 'suspended':
            add('warning', '外矿 %s 停用：%s' % (name, remote.get('why') or '?'))
        elif remote['state'] == 'off' and remote.get('creeps'):
            add('serious', '外矿 %s 没启用还有 %d 只 creep' % (name, remote['creeps']))
        if remote['state'] != 'off' and remote.get('counted') and not remote.get('seen'):
            # 拉不到的外矿这一段整段不计外矿采集：一直拉不到时母房的"采集"只剩本房源，得有人看得见
            add('warning', '外矿 %s 本轮没拉到房间对象，外矿采集暂不计' % name)
        net = ((remote_stats.get(name) or {}).get(ALERT_WINDOW) or {}).get('net')
        if remote['state'] == 'on' and remote.get('counted') and net is not None and net < 0:
            add('serious', '外矿 %s 亏 %.1f/tick' % (name, -net))
    if room.get('safeMode'):
        add('info', '安全模式中')
    return alerts


def _rounded(stats):
    return {key: _round(value, 3 if key.startswith('eff') else 2) for key, value in stats.items()}


def build_view(entries, snap, now=None):
    now = time.time() if now is None else float(now)
    entries = sorted(entries, key=lambda e: (e['t'], e['at']))
    ats = [e['at'] for e in entries]
    last = len(entries) - 1
    tracks = accumulate(entries) if entries else {}
    picked = series_indices(ats)
    starts = {label: window_start(ats, last, seconds) if last >= 0 else 0 for label, seconds in WINDOWS}
    series_starts = [window_start(ats, index, SERIES_WINDOW) for index in picked]

    def timing(index, start):
        if index < 0 or start >= index:
            return {'ticks': 0, 'span': 0, 'secPerTick': None}
        ticks = entries[index]['t'] - entries[start]['t']
        span = entries[index]['at'] - entries[start]['at']
        return {'ticks': ticks, 'span': round(span), 'secPerTick': round(span / ticks, 3) if ticks > 0 else None}

    rooms = []
    for home, room in (snap.get('rooms') or {}).items():
        stats = {}
        for label, _ in WINDOWS:
            stats[label] = _rounded(room_rates(tracks, home, last, starts[label]))
            stats[label].update(timing(last, starts[label]))
        remote_stats = {name: {label: _rounded(remote_rates(tracks, home + '>' + name, last, starts[label]))
                               for label, _ in WINDOWS}
                        for name in room.get('remotes') or {}}
        series = {'cp': [], 'harvest': [], 'ceiling': [], 'upkeep': [], 'storage': []}
        for index, start in zip(picked, series_starts):
            rates = room_rates(tracks, home, index, start)
            for key in ('cp', 'harvest', 'ceiling', 'upkeep'):
                series[key].append(_round(rates[key]))
            series['storage'].append((entries[index].get('rooms', {}).get(home) or {}).get('storage'))
        remotes = []
        order = {'on': 0, 'suspended': 1, 'off': 2}
        for name, remote in sorted((room.get('remotes') or {}).items(), key=lambda kv: (order[kv[1]['state']], kv[0])):
            remotes.append({'name': name, 'now': remote, 'stats': remote_stats[name]})
        need = CONTROLLER_LEVELS.get(room.get('rcl'))
        now_room = {key: value for key, value in room.items() if key != 'remotes'}
        rooms.append({
            'name': home, 'now': now_room, 'rclNeed': need,
            'progress': (room.get('prog') or 0) / need if need else None,
            'stats': stats, 'series': series, 'remotes': remotes,
            'alerts': room_alerts(room, stats, remote_stats),
        })

    account_stats = {}
    for label, _ in WINDOWS:
        merged = {'cp': window_rate(tracks, (ACCOUNT, 'cp'), last, starts[label])}
        for key in ('harvest', 'ceiling', 'upkeep', 'hOwn', 'cOwn', 'hRem', 'cRem'):
            merged[key] = _sum(*[r['stats'][label].get(key) for r in rooms])
        merged['roomsCp'] = _sum(*[r['stats'][label].get('cp') for r in rooms])
        merged['eff'] = _ratio(merged['harvest'], merged['ceiling'])
        merged['net'] = _minus(merged['harvest'], merged['upkeep'])
        account_stats[label] = _rounded(merged)
        account_stats[label].update(timing(last, starts[label]))
    account_series = {'cp': [_round(window_rate(tracks, (ACCOUNT, 'cp'), index, start))
                             for index, start in zip(picked, series_starts)]}
    for key in ('harvest', 'ceiling', 'upkeep'):
        account_series[key] = [_round(_sum(*[r['series'][key][n] for r in rooms])) for n in range(len(picked))]

    brain = snap.get('brain') or {}
    first = ats[0] if ats else None
    return {
        'generatedAt': snap.get('at') or now, 'renderedAt': round(now, 1), 'tick': snap.get('t'), 'me': snap.get('me'),
        'gcl': gcl_info(snap.get('gcl')), 'brain': brain,
        'history': {'entries': len(entries), 'first': first, 'keepSeconds': KEEP_SECONDS},
        'series': {'t': [round(ats[index]) for index in picked]},
        'account': {'stats': account_stats, 'series': account_series,
                    'creeps': sum(r['now'].get('creeps') or 0 for r in rooms),
                    'unpriced': sum(r['now'].get('unpriced') or 0 for r in rooms)},
        'rooms': rooms,
        'windows': [label for label, _ in WINDOWS],
    }


# ---- 读写 ----

def write_atomic(path, text):
    """先写同目录的唯一临时文件再改名：页面自动重载时不会读到写了一半的文件，两个进程也不会共用一个临时文件"""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '.', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_history(path, now=None, keep=KEEP_SECONDS):
    entries = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict) and isinstance(entry.get('t'), int) and isinstance(entry.get('at'), (int, float)):
                    entries[entry['t']] = entry
    kept = [e for e in entries.values() if now is None or e['at'] >= now - keep]
    return sorted(kept, key=lambda e: (e['t'], e['at']))


def history_line(entry):
    # ensure_ascii：非 ASCII 全部转义，字符串里混进孤立代理项也写得出去
    return json.dumps(entry, separators=(',', ':')) + '\n'


def save_history(path, entries):
    write_atomic(path, ''.join(history_line(e) for e in entries))


def append_history(path, entry):
    """追加一行；上次写到一半断掉（最后没有换行）时先补换行，别把新行粘在坏行后面一起作废"""
    prefix = ''
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, 'rb') as handle:
            handle.seek(-1, os.SEEK_END)
            if handle.read(1) != b'\n':
                prefix = '\n'
    with open(path, 'a', encoding='utf-8') as handle:
        handle.write(prefix + history_line(entry))


def render_html(view, template_path=TEMPLATE):
    with open(template_path, encoding='utf-8') as handle:
        template = handle.read()
    # 数据放在 <script type="application/json"> 里：把 < 全部转义，room/role 名里出现 </script> 也关不掉标签
    data = json.dumps(view, separators=(',', ':')).replace('<', '\\u003c')
    return template.replace(DATA_MARKER, data)


def update(out_dir, api, state, me, memory_rooms, creep_memory, now=None, lock_wait=LOCK_WAIT):
    """run.py 每轮调用：只读缓存，追加历史，重写 latest.json 与 index.html。加文件锁：手动跑的大脑和 launchd 撞上时串行；
    等不到锁就抛 TimeoutError（run.update_dashboard 兜住），不阻塞大脑"""
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, '.lock'), 'w') as lock:
        deadline = time.monotonic() + lock_wait
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('面板锁被占用超过 %s 秒（另一个大脑进程卡住？），这一轮不记' % lock_wait)
                time.sleep(0.2)
        return _update(out_dir, api, state, me, memory_rooms, creep_memory, now)


def _update(out_dir, api, state, me, memory_rooms, creep_memory, now=None):
    now = time.time() if now is None else float(now)
    state = state or {}
    homes = list(state.get('homes') or {})
    names = set(homes)
    for home in homes:
        names.update(((memory_rooms or {}).get(home) or {}).get('remotes') or {})
    reader = getattr(api, 'cached_room_objects', None)
    objects_by_room = {}
    if reader:
        for name in sorted(names):
            payload = reader(name, CACHE_MAX_AGE)
            if isinstance(payload, dict):
                objects_by_room[name] = payload.get('objects') or []
    wrote = str(state.get('wrote') or '')
    brain = {'wrote': wrote, 'ok': wrote.startswith('segment') and not state.get('blockers'),
             'blockers': len(state.get('blockers') or []), 'apiCalls': state.get('apiCalls')}
    latest_path = os.path.join(out_dir, 'latest.json')
    known = {}
    try:
        with open(latest_path, encoding='utf-8') as handle:
            known = json.load(handle).get('priced') or {}
    except (OSError, ValueError, AttributeError):
        known = {}
    if not isinstance(known, dict):
        known = {}   # 手改坏的 latest.json 不能让面板每轮都失败（它只在成功时重写）
    snap = build_snapshot(state.get('tick') or 0, now, me, homes, memory_rooms, creep_memory, objects_by_room,
                          whitelist=whitelist_names(state.get('directive')), brain=brain, known_upkeep=known)
    history_path = os.path.join(out_dir, 'history.jsonl')
    existing = load_history(history_path)
    entry = history_entry(snap)
    entries = [e for e in existing if e['at'] >= now - KEEP_SECONDS and e['t'] != snap['t']] + [entry]
    entries.sort(key=lambda e: (e['t'], e['at']))
    if any(e['t'] >= snap['t'] or e['at'] < now - KEEP_SECONDS - TRIM_SLACK for e in existing):
        save_history(history_path, entries)
    else:
        append_history(history_path, entry)
    write_atomic(latest_path, json.dumps(snap))
    view = build_view(entries, snap, now)
    write_atomic(os.path.join(out_dir, 'index.html'), render_html(view))
    return view


def main(argv=None):
    parser = argparse.ArgumentParser(description='按已有历史重新渲染监控面板（不调 API）')
    parser.add_argument('--dir', default=DEFAULT_DIR)
    args = parser.parse_args(argv)
    latest = os.path.join(args.dir, 'latest.json')
    if not os.path.exists(latest):
        raise SystemExit('还没有快照：%s（外部大脑跑过一轮之后才有）' % latest)
    with open(latest, encoding='utf-8') as handle:
        snap = json.load(handle)
    view = build_view(load_history(os.path.join(args.dir, 'history.jsonl'), now=time.time()), snap)
    path = os.path.join(args.dir, 'index.html')
    write_atomic(path, render_html(view))
    print(path)


if __name__ == '__main__':
    sys.exit(main())
