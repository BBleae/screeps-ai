"""规划：房间评分、外矿分配、占领候选。纯函数，输入情报字典，输出计划字典。"""
from collections import deque

from .intel import ring_rooms, room_class, room_coords, room_distance, room_name

DEFAULTS = {
    # 用户要求尽量多开外矿（W33S8/W33S6/W35S7）：上限放到 4，spawn 产能不够时外矿需求排在最后自然排队
    'remoteMaxRooms': {1: 0, 2: 0, 3: 0, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4},
    'remoteRadius': 2,          # 允许二跳（游戏内 config.remote.maxRange 同步）
    # 实际要穿过的房间数上限：按出口情报做 BFS，走廊不穿 SK/中心房/他人房。坐标上的"两跳"可能根本走不通——
    # 线上 W34S7→W36S7：W35S7 西侧被墙封死，唯一通路是 W35S6→W36S6 两个 SK 房，派去的 reserver/矿工全死在路上
    'remoteMaxHops': 4,
    'remoteMinSources': 1,      # 单源房也可作外矿（评分自然更低）
    'claimRadius': 2,
    'claimMinLevel': 4,         # 母房 RCL≥4 才发起占领：低级房容量连 claimer（650）都孵不出，pioneer 也拖垮自身经济
    # 用户点名的占领清单（locks.json 的 claim.queue）可以指到 claimRadius 之外：母房资格不看跳数，看 claimer 能不能在寿命内走到——
    # [CLAIM,MOVE] 只活 600 tick，平地/道路 1 tick/格、沼泽 5 tick/格（fatigue 2/10，MOVE 每 tick 减 2），按各房真实地形跨房 A*
    # 从母房 spawn 走到目标 controller 旁（plan.travel_ticks）；没有地形数据时按每房 claimTicksPerRoom 估。
    # 2026-09-06：先是 4 跳、再放宽到 5 跳，用户最终要求"不限跳数，600 tick 内能到即可"（W31S4 只能经 W32S4 进，5 跳内没有空闲母房）
    'claimTravelTicks': 600,
    'claimTicksPerRoom': 50,
    'claimSearchRooms': 12,     # 房间级 BFS 的搜索半径（600 tick 至多 12 房，只是防止无界搜索）
    # SK 房过境：travel_ticks 的逐格 A* 把 keeper lair（intel 的 lairPos）周围这么多格设为不可走，逼安全路径贴远缘绕开——
    # 与游戏端 config.keeperAvoid.range 一致。有 lairPos 的 SK 房因此可当走廊穿（passable 放开），没有 lairPos 的 SK 房仍不穿（情报不足不冒险）。
    'keeperAvoidRadius': 5,
    # 占领清单的母房资格按 spawn 容量而不是 RCL：claimer [CLAIM,MOVE] 650，RCL3 建了 7 个以上 extension 的房就孵得出
    # （2026-09-06 W31S4 无主时 5 跳内没有 RCL≥4 的空闲母房，RCL3 的 W31S8 有 9 个 extension、4 跳，白等）。没有容量数据时退回 RCL≥claimMinLevel
    'claimSponsorMinCapacity': 650,
    'strongNeighborLevel': 7,   # 邻居 RCL≥7 视为强邻，压低相邻候选分
    'strongNeighborPenalty': 3.0,  # 每个强邻扣分：原 8 分让相邻双源房 W33S8 排到两跳房之后，用户明确要开它
    'threatTicks': 1500,        # 情报里近期有武装敌人/InvaderCore 的房暂不用（已在用的外矿除外：游戏内防御会处理）
    'stickyBonus': 6.0,         # 已在用的外矿加分：不为微小分差换房（换房 = 现有 creep 退役 + 重新孵化 + 路白修）
    # 外矿的能量卸在另一个母房（游戏内 record.drop，路程最短的己方房）：分配时给那个母房加分，让归属跟着能量走。
    # 线上 2026-09-11：W32S6/W33S5 的能量卸到 W32S4，却挂在 W33S7 名下——W33S7 对它们记零价值，常年不在编
    'dropHomeBonus': 8.0,
    # 外矿评分下限（None = 不设门，当前默认）：低于它的候选直接淘汰，不占 remoteMaxRooms 名额。
    # 评分不是损益表——2026-09-06 线上 12 条在用外矿有 8 条负分，但基准账目里它们多数净收益 +3.1…+7.5/tick，
    # 只有最负的两条接近盈亏平衡（W32S5 +2.0/+0.7、W33S5 +0.1/−0.1）。阈值要靠 A/B 标定：
    # run.py 的 --remote-min-score 让"同一提交、只差一个参数"的对照成为可能（screeps-9e 的分叉钉版跑）
    'remoteMinScore': None,
    # 母房养得起这个外矿的最低 spawn 容量（按源数）：双源外矿要 2 CLAIM 的 reserver（1300）和大 hauler，800 容量的房只能保住 1 的预定、
    # 源掉回 1500 档；单源外矿 650 的 1 CLAIM + 550 的矿工/hauler 在 800 下够用。分配时路程最短且养得起的母房优先，都养不起才退给最近的
    'remoteMinCapacity': {1: 800, 2: 1300},
}


def compatible_status(home_entry, entry):
    a = (home_entry or {}).get("roomStatus")
    b = (entry or {}).get("roomStatus")
    return a != "closed" and b != "closed" and (a == b or (a is None and b in (None, "normal")) or (b is None and a in (None, "normal")))


def corridor_ok(home_entry, entry):
    """途经房（不是目标房）能不能穿过：状态兼容，或者是没关闭的 highway。
    我方在 respawn 区内，分界线上的 highway（W30Sx）是 normal；区域隔离靠 highway 里不可摧毁的墙，
    这些墙已经并进地形 A*（intel.blockingWalls）。be26e7f 对走廊也做状态检查，把区内只能经 highway 内侧半边进出的房
    一并判成 noRoute（W31S8 → W31S9 自 09-07 起 0 外矿）；目标房仍严格按 compatible_status。"""
    if compatible_status(home_entry, entry):
        return True
    return bool(entry) and entry.get('class') == 'highway' and entry.get('roomStatus') != 'closed' and \
        (home_entry or {}).get('roomStatus') != 'closed'


def usable_for_remote(entry, me, cfg, tick, exclude=(), home_entry=None):
    if not entry or entry.get('unreachable'):
        return 'unreachable'
    if home_entry is not None and not compatible_status(home_entry, entry):
        return 'roomStatus'
    if entry.get('owner') == me:
        return 'own'
    if entry.get('owner'):
        return 'owner:' + str(entry['owner'])
    if entry.get('lairs'):
        return 'keeper'
    if entry.get('class') in ('sk', 'center', 'highway'):
        return entry['class']
    res = entry.get('reservation')
    # users 表偶尔不含自己，username 会退化成用户 id：以 mine（按 id 判定）为准，别把自己预定的外矿当成别人的
    if res and res.get('username') and res['username'] != me and not res.get('mine'):
        return 'reservation:' + str(res['username'])
    if entry.get('sources', 0) < cfg['remoteMinSources']:
        return 'sources:%d' % entry.get('sources', 0)
    if entry.get('threat') and tick - int(entry.get('at') or 0) <= cfg['threatTicks']:
        return 'threat'
    return None


def travel_rooms(home, room):
    """实际要穿过的房间数：房间只有四向出口，对角房也要经过一个中间房，所以用曼哈顿距离。"""
    hx, hy = room_coords(home)
    rx, ry = room_coords(room)
    return abs(hx - rx) + abs(hy - ry)


def connected(room, entry, other_room, other_entry):
    """两房是否有直接通路：必须正交相邻（对角房没有出口），且共享边在两侧都有出口；没有出口情报时按正交相邻算。"""
    rx, ry = room_coords(room)
    ox, oy = room_coords(other_room)
    dx, dy = ox - rx, oy - ry
    if abs(dx) + abs(dy) != 1:
        return False
    side = {(0, -1): ('N', 'S'), (0, 1): ('S', 'N'), (1, 0): ('E', 'W'), (-1, 0): ('W', 'E')}[(dx, dy)]
    mine = (entry or {}).get('exits')
    theirs = (other_entry or {}).get('exits')
    if mine and not mine.get(side[0], True):
        return False
    if theirs and not theirs.get(side[1], True):
        return False
    return True


def passable(entry, me, allow_keeper=False):
    """能不能把这个房当走廊穿过去：没有情报的房不冒险；他人房有塔不穿；中心房不穿。
    SK 房默认不穿——reserver/miner/hauler 没有 keeper 规避、穿 SK 会死（remote 路由一律走这个默认）。
    只有 allow_keeper=True（用户点名的占领清单，走的是 claimer/pioneer）且该房有 lairPos 时才放行：
    travel_ticks 会把 lair 周围 keeperAvoidRadius 格设为不可走、路径贴远缘绕开 keeper 杀伤圈，
    游戏端 movement.keeperAvoidCallback 让 claimer/pioneer 实走同样的安全路径。没有 lairPos（情报不足、算不出安全路）仍不穿。"""
    if not entry or entry.get('unreachable'):
        return False
    if entry.get('owner') and entry.get('owner') != me:
        return False
    if entry.get('class') == 'center':
        return False
    if entry.get('class') == 'sk' or entry.get('lairs'):
        return bool(allow_keeper and entry.get('lairPos'))
    return True


def route_hops(home, room, intel, me, max_hops, allow_keeper=False):
    """母房到目标实际要穿过的房间数：按出口情报四向 BFS，走廊只走 passable 的房；max_hops 内到不了返回 None。
    allow_keeper=True 时允许 SK 走廊（有 lairPos），供用户点名的占领清单用（claimer/pioneer 有 keeper 规避）。"""
    if home == room:
        return 0
    seen = {home: 0}
    queue = deque([home])
    while queue:
        current = queue.popleft()
        hops = seen[current]
        if hops >= max_hops:
            continue
        cx, cy = room_coords(current)
        for dx, dy in ((0, -1), (0, 1), (1, 0), (-1, 0)):
            nxt = room_name(cx + dx, cy + dy)
            # 目标房严格按状态兼容；途经房放宽到 highway（隔离墙已在地形里，见 corridor_ok）
            if nxt == room and not compatible_status(intel.get(home), intel.get(nxt)):
                continue
            if nxt != room and not corridor_ok(intel.get(home), intel.get(nxt)):
                continue
            if nxt in seen:
                continue
            if not connected(current, intel.get(current), nxt, intel.get(nxt)):
                continue
            if nxt == room:
                return hops + 1
            if not passable(intel.get(nxt), me, allow_keeper):
                continue
            seen[nxt] = hops + 1
            queue.append(nxt)
    return None


def remote_score(home, room, entry, intel, cfg, hops=None):
    distance = hops if hops is not None else travel_rooms(home, room)
    # 每多穿一个房搬运成本翻倍：距离罚分要压得住多一个源的收益；非相邻再额外扣一笔（reserver 与 hauler 都要穿过中间房）
    score = entry.get('sources', 0) * 10.0 - distance * 8.0 - (6.0 if distance > 1 else 0.0)
    if entry.get('invaderCore'):
        score -= 15
    if entry.get('walls', 0) > 20:
        score -= 1
    for name, other in intel.items():
        if name == room or not other or other.get('unreachable'):
            continue
        if other.get('owner') and other.get('level', 0) >= cfg['strongNeighborLevel'] and connected(room, entry, name, other):
            score -= float(cfg.get('strongNeighborPenalty') or 0)   # 紧挨且走得通的强邻才算：容易被抢或被打
    return score


def choose_remotes(home, intel, me, level, cfg=None, tick=0, exclude=(), current=()):
    """exclude：占领目标与己方房间不做外矿。current：游戏内当前启用的外矿——临时威胁（Invader）不把它们剔除，
    并给粘性加分；被占/被别人预定/不可达/Keeper 仍照常淘汰。"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    max_rooms = cfg['remoteMaxRooms'].get(int(level), 0)
    current = set(current or ())
    ranked = []
    rejected = {}
    for room, entry in intel.items():
        if room_distance(home, room) > cfg['remoteRadius']:
            continue
        if room in exclude:
            rejected[room] = 'excluded'
            continue
        reason = usable_for_remote(entry, me, cfg, tick, home_entry=intel.get(home))
        if reason == 'threat' and room in current:
            reason = None
        if reason:
            rejected[room] = reason
            continue
        # 已在用的外矿也不豁免：路走不通的房只会持续送 creep 去死
        hops = route_hops(home, room, intel, me, cfg['remoteMaxHops'])
        if hops is None or (entry.get('terrain') and travel_ticks(home, room, intel, me, cfg['claimTravelTicks'], cfg) is None):
            rejected[room] = 'noRoute'
            continue
        score = remote_score(home, room, entry, intel, cfg, hops=hops)
        if room in current:
            score += float(cfg.get('stickyBonus') or 0)
        # 评分下限在粘性加分之后判：已在用的外矿不因为一次微小分差被砍（换房本身就有成本）
        min_score = cfg.get('remoteMinScore')
        if min_score is not None and score < float(min_score):
            rejected[room] = 'lowScore:%.1f' % score
            continue
        ranked.append((score, room))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return {
        'remotes': [room for _, room in ranked[:max_rooms]],
        'ranked': [{'room': room, 'score': round(score, 1), 'sources': int((intel.get(room) or {}).get('sources') or 0)}
                   for score, room in ranked],
        'rejected': rejected,
        'maxRooms': max_rooms,
    }


def replan_remotes(plans, intel, me, levels, owned_rooms, claim_rooms, tick=0, current_by_home=None, cfg=None):
    """占领目标全账号排除后重排外矿：plan_home 只排除本母房自己的占领目标，别的母房会把它当外矿收进来
    （2026-09-06 线上：W33S7 占 W31S6 时 W33S8 把 W31S6 收作外矿，W33S8 占 W31S8 时 W33S7 仍留着 W31S8）。
    claim_rooms：single_claim 与 locks 之后实际生效的占领目标。就地修改 plans。"""
    exclude = set(owned_rooms or []) | set(claim_rooms or [])
    current_by_home = current_by_home or {}
    for home, item in plans.items():
        remotes = choose_remotes(home, intel, me, levels.get(home) or 0, cfg, tick, exclude=exclude,
                                 current=current_by_home.get(home) or ())
        item['remotes'] = remotes['remotes']
        item.setdefault('analysis', {})['remotes'] = remotes
    return plans


def usable_for_claim(entry, me, cfg, tick, home_entry=None):
    reason = usable_for_remote(entry, me, dict(cfg, remoteMinSources=2), tick, home_entry=home_entry)
    if reason:
        return reason
    if entry.get('level', 0) > 0:
        return 'level'
    return None


def claim_score(home, room, entry, intel, cfg, hops=None):
    score = remote_score(home, room, entry, intel, cfg, hops=hops)
    if entry.get('mineral'):
        score += 2
    if entry.get('walls', 0) > 20:
        score -= 2   # 残墙要清理
    return score


def bootstrapping_rooms(intel, me):
    """已是我方但还没有 spawn 的房：开荒未完成。"""
    return sorted(name for name, entry in intel.items()
                  if entry and entry.get('owner') == me and not (entry.get('structures') or {}).get('spawn'))


def choose_claim(home, intel, me, gcl_level, owned_rooms, cfg=None, tick=0, prefer=None, level=None):
    """占领候选：GCL 余量 > 0 且没有正在开荒的新房时给出目标；prefer 指定的房只要可用就优先；
    相邻房优先于二跳房（pioneer 支援距离）。level 给出时母房需 ≥ claimMinLevel。"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    headroom = int(gcl_level) - len(owned_rooms)
    bootstrapping = bootstrapping_rooms(intel, me)
    ranked = []
    rejected = {}
    for room, entry in intel.items():
        if room_distance(home, room) > cfg['claimRadius']:
            continue
        reason = usable_for_claim(entry, me, cfg, tick, home_entry=intel.get(home))
        if reason:
            rejected[room] = reason
            continue
        hops = route_hops(home, room, intel, me, cfg['remoteMaxHops'])
        if hops is None or (entry.get('terrain') and travel_ticks(home, room, intel, me, cfg['claimTravelTicks'], cfg) is None):
            rejected[room] = 'noRoute'
            continue
        ranked.append((claim_score(home, room, entry, intel, cfg, hops=hops), room))
    ranked.sort(key=lambda item: (room_distance(home, item[1]) > 1, -item[0], item[1]))
    chosen = None
    blocked = None
    if bootstrapping:
        blocked = 'bootstrapping:' + ','.join(bootstrapping)
    elif level is not None and int(level) < cfg['claimMinLevel']:
        blocked = 'level:%d' % int(level)
    elif headroom <= 0:
        blocked = 'gcl'
    elif ranked:
        if prefer and any(room == prefer for _, room in ranked):
            chosen = prefer
        else:
            chosen = ranked[0][1]
    return {
        'claim': {'room': chosen, 'priority': 1} if chosen else None,
        'blocked': blocked,
        'ranked': [{'room': room, 'score': round(score, 1)} for score, room in ranked],
        'rejected': rejected,
        'gclHeadroom': headroom,
    }


NO_OVERRIDE = object()


def plan_home(home, intel, me, level, gcl_level, owned_rooms, cfg=None, tick=0, prefer_claim=None,
              claim_override=NO_OVERRIDE, current_remotes=()):
    """claim_override：locks 里对 <home>.claim 的有效覆盖值（None 表示暂缓占领）。外矿只排除“实际生效”的占领目标——
    否则规划自己排出的下一个候选（往往是最好的相邻双源房）会被白白排除在外矿之外。"""
    claim = choose_claim(home, intel, me, gcl_level, owned_rooms, cfg, tick, prefer_claim, level=level)
    exclude = set(owned_rooms or [])
    effective = claim['claim'] if claim_override is NO_OVERRIDE else claim_override
    if effective and effective.get('room'):
        exclude.add(effective['room'])
    remotes = choose_remotes(home, intel, me, level, cfg, tick, exclude=exclude, current=current_remotes)
    return {
        'remotes': remotes['remotes'],
        'claim': claim['claim'],
        'analysis': {'remotes': remotes, 'claim': claim},
    }


def single_claim(plans, levels):
    """全账号同时只推进一个占领：多个母房都排出目标时，只保留 RCL 最高（同级取房名靠前）的那个，
    其余母房的 claim 置空并在 analysis 里注明。就地修改 plans。"""
    sponsors = sorted((home for home, item in plans.items() if item.get('claim')),
                      key=lambda home: (-int(levels.get(home) or 0), home))
    if len(sponsors) <= 1:
        return plans
    keeper = sponsors[0]
    for home in sponsors[1:]:
        plans[home]['claim'] = None
        analysis = plans[home].setdefault('analysis', {}).setdefault('claim', {})
        analysis['blocked'] = 'claimElsewhere:' + keeper
    return plans


def required_capacity(sources, cfg):
    table = (cfg or DEFAULTS).get('remoteMinCapacity') or DEFAULTS['remoteMinCapacity']
    key = max(1, min(int(sources or 1), max(int(k) for k in table)))
    return int(table.get(key) or table.get(str(key)) or 0)


def assign_remotes(plans, levels, cfg=None, prefer=None):
    """全账号外矿去重：同一外矿只归一个母房（线上 W33S8/W35S7 同时在两个母房白名单里，每房各派 reserver + 每源一只 miner，
    14:48 全账号 7 个 reserver、W33S8 三只 miner 挤两口源）。按 (分数, 母房 RCL) 全局贪心分配——分数已含每穿一房 −8，
    所以路程最短的母房自然优先；母房容量（plans[home].capacity）低于 remoteMinCapacity[源数] 的候选先跳过，
    没有母房养得起时再退给分数最高的。每房不超过自己的 maxRooms，落选的房用自己 ranked 里的下一个候选补位；
    被别家拿走的记进 analysis.remotes.takenBy。就地修改 plans。"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    prefer = prefer or {}
    bonus = float(cfg.get('dropHomeBonus') or 0)
    candidates = []
    for home, item in plans.items():
        analysis = (item.get('analysis') or {}).get('remotes') or {}
        for entry in analysis.get('ranked') or []:
            score = float(entry.get('score') or 0) + (bonus if prefer.get(entry['room']) == home else 0)
            candidates.append((-score, -int(levels.get(home) or 0), home, entry['room'],
                               int(entry.get('sources') or 0)))
    candidates.sort()
    owner_of = {}
    count = {home: 0 for home in plans}

    def affordable(home, sources):
        capacity = plans[home].get('capacity')
        return capacity is None or int(capacity) >= required_capacity(sources, cfg)

    for require_capacity in (True, False):
        for _score, _level, home, room, sources in candidates:
            analysis = (plans[home].get('analysis') or {}).get('remotes') or {}
            max_rooms = int(analysis.get('maxRooms') or 0)
            if room in owner_of or count[home] >= max_rooms:
                continue
            if require_capacity and not affordable(home, sources):
                continue
            owner_of[room] = home
            count[home] += 1
    for home, item in plans.items():
        analysis = item.setdefault('analysis', {}).setdefault('remotes', {})
        wanted = list(item.get('remotes') or [])   # 单独规划时自己会选的那几个
        ranked = [entry['room'] for entry in analysis.get('ranked') or []]
        item['remotes'] = [room for room in ranked if owner_of.get(room) == home]
        analysis['takenBy'] = {room: owner_of[room] for room in wanted if owner_of.get(room) not in (None, home)}
    return plans


def current_remote_names(records, tick=0):
    """游戏内"正在用"的外矿：启用中的，或只是因敌情临时暂停（suspendedUntil 未到）的；
    被白名单剔除/太远的不算。游戏内编制预算裁掉的（staffed 为 False：没人在采）也不算——不给它粘性加分，
    让有余量的母房接手（线上 W33S7 的 W32S6/W33S5 从 73608518 起 want=000 两万 tick，大脑仍只写给它）。"""
    names = []
    for name, record in sorted((records or {}).items()):
        if not isinstance(record, dict):
            continue
        if record.get('enabled') and record.get('staffed') is False:
            continue
        if record.get('enabled'):
            names.append(name)
        elif record.get('suspendReason') in ('hostileCreep', 'invaderCore') and int(record.get('suspendedUntil') or 0) > int(tick):
            names.append(name)
    return names


TERRAIN_TICKS = {'0': 1, '2': 5}   # [CLAIM,MOVE]：平地/道路 1 tick/格，沼泽 5 tick/格；'1'/'3' 是墙


def drop_preferences(memory_rooms, homes):
    """启用中的外矿记录里，卸货房（record.drop.room）是另一个母房的：{外矿: 卸货母房}（assign_remotes 据此加 dropHomeBonus）。
    只看启用中的记录：改派之后原母房的记录被停用，偏好随之消失，新母房靠粘性保住归属，不来回翻。
    卸货房自己 storage 富余（storageRich 开、或外矿孵化时间上限 remoteSpawnCapped 开）时不采用：能量在那里没有边际价值，
    游戏内也不再往比母房富得多的房卸货（remote.refreshDropRoom），跟过去只会把外矿推给已经花不完能量的房"""
    def rich(room):
        mem = (memory_rooms or {}).get(room) or {}
        return bool((mem.get('storageRich') or {}).get('on')) or bool(mem.get('remoteSpawnCapped'))
    out = {}
    for home in homes:
        for name, record in sorted((((memory_rooms or {}).get(home) or {}).get('remotes') or {}).items()):
            if not isinstance(record, dict) or not record.get('enabled'):
                continue
            drop = (record.get('drop') or {}).get('room')
            if drop and drop != home and drop in homes and not rich(drop):
                out[name] = drop
    return out


def travel_ticks(start_room, goal_room, intel, me, limit, cfg=None, allow_keeper=False):
    """[CLAIM,MOVE] 从 start_room 的 spawn 走到 goal_room 的 controller 相邻格要多少 tick：按情报里的地形（entry.terrain）跨房 A*，
    走廊只穿 passable 的房（出口格踏上即换房，落到对面房同一行/列的边格）。超过 limit 或不可达返回 None；
    起点/终点没有地形数据时退化为 route_hops × claimTicksPerRoom。
    allow_keeper=True 时允许 SK 走廊，且 A* 把 lair 周围 keeperAvoidRadius 格设为不可走（贴远缘绕开）；供用户点名的占领清单用。"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    if start_room == goal_room:
        return 0
    start_entry = intel.get(start_room) or {}
    goal_entry = intel.get(goal_room) or {}
    if not compatible_status(start_entry, goal_entry):
        return None
    if not start_entry.get('terrain') or not goal_entry.get('terrain'):
        hops = route_hops(start_room, goal_room, intel, me, cfg['claimSearchRooms'], allow_keeper)
        if hops is None:
            return None
        estimate = hops * int(cfg['claimTicksPerRoom'])
        return estimate if estimate <= limit else None
    start = start_entry.get('spawnPos') or {'x': 25, 'y': 25}
    goal = goal_entry.get('controllerPos') or {'x': 25, 'y': 25}
    gx0, gy0 = room_coords(goal_room)
    goal_gx, goal_gy = gx0 * 50 + int(goal['x']), gy0 * 50 + int(goal['y'])

    def heuristic(room, x, y):
        rx, ry = room_coords(room)
        return max(abs(rx * 50 + x - goal_gx), abs(ry * 50 + y - goal_gy)) - 1

    def enterable(room):
        if room in (start_room, goal_room):
            if not compatible_status(start_entry, intel.get(room)):
                return False
        elif not corridor_ok(start_entry, intel.get(room)):
            return False
        if room in (start_room, goal_room):
            return bool((intel.get(room) or {}).get('terrain'))
        entry = intel.get(room)
        return passable(entry, me, allow_keeper) and bool(entry.get('terrain'))

    radius = int(cfg.get('keeperAvoidRadius', 5))
    lair_cache = {}

    def lair_blocked(room_name):
        """该房里离任一 keeper lair ≤ radius 的格子（视为不可走）——逼 A* 贴远缘绕开 keeper 杀伤圈。
        只有 SK 走廊房有 lairPos；起点/终点房没有，返回空集。与游戏端 config.keeperAvoid.range 同半径。"""
        if room_name not in lair_cache:
            blocked = set()
            for p in ((intel.get(room_name) or {}).get('lairPos') or []):
                lx, ly = p.get('x'), p.get('y')
                if not isinstance(lx, int) or not isinstance(ly, int):
                    continue
                for bx in range(max(0, lx - radius), min(49, lx + radius) + 1):
                    for by in range(max(0, ly - radius), min(49, ly + radius) + 1):
                        if max(abs(bx - lx), abs(by - ly)) <= radius:
                            blocked.add((bx, by))
            lair_cache[room_name] = blocked
        return lair_cache[room_name]

    import heapq
    sx, sy = int(start['x']), int(start['y'])
    best = {(start_room, sx, sy): 0}
    heap = [(heuristic(start_room, sx, sy), 0, start_room, sx, sy)]
    while heap:
        _, cost, room, x, y = heapq.heappop(heap)
        if cost > limit:
            return None
        if best.get((room, x, y), cost) < cost:
            continue
        if room == goal_room and max(abs(x - int(goal['x'])), abs(y - int(goal['y']))) <= 1:
            return cost
        terrain = intel[room]['terrain']
        steps = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if not dx and not dy:
                    continue
                nx, ny = x + dx, y + dy
                if 0 <= nx < 50 and 0 <= ny < 50:
                    tile = terrain[ny * 50 + nx]
                    if tile in TERRAIN_TICKS and (nx, ny) not in lair_blocked(room):
                        steps.append((room, nx, ny, cost + TERRAIN_TICKS[tile]))
        # 站在边格上下一 tick 就到了对面房的边格（同一行/列），不再额外花 tick
        rx, ry = room_coords(room)
        for edge, (nroom, nx, ny) in (
                (x == 0, (room_name(rx - 1, ry), 49, y)), (x == 49, (room_name(rx + 1, ry), 0, y)),
                (y == 0, (room_name(rx, ry - 1), x, 49)), (y == 49, (room_name(rx, ry + 1), x, 0))):
            if edge and enterable(nroom) and intel[nroom]['terrain'][ny * 50 + nx] in TERRAIN_TICKS \
                    and (nx, ny) not in lair_blocked(nroom):
                steps.append((nroom, nx, ny, cost))
        for nroom, nx, ny, ncost in steps:
            if ncost > limit:
                continue
            key = (nroom, nx, ny)
            if ncost < best.get(key, float('inf')):
                best[key] = ncost
                heapq.heappush(heap, (ncost + heuristic(nroom, nx, ny), ncost, nroom, nx, ny))
    return None


def active_claim_queue(locks, now_ms):
    """locks.json 里用户点名的占领清单：{"claim.queue": {"value": [房, ...], "until": ms, "by": "agent"}}。
    过期、缺失或格式不对都当没有；顺序即优先级。"""
    lock = (locks or {}).get('claim.queue')
    if not lock or lock.get('until', 0) <= now_ms:
        return []
    value = lock.get('value')
    if not isinstance(value, list):
        return []
    return [room for room in value if isinstance(room, str) and room]


def claim_queue_intel_rooms(queue):
    """清单房可能在母房情报圈之外：把它们和各自的相邻房一并拉情报（路径 BFS 要走廊房有情报才敢穿）。"""
    rooms = []
    for room in queue:
        for name in [room] + ring_rooms(room, 1):
            if name not in rooms:
                rooms.append(name)
    return rooms


def assign_claim_queue(plans, queue, intel, me, levels, owned_rooms, gcl_level, cfg=None, tick=0,
                       locked_homes=(), sponsoring=None, capacities=None):
    """把用户点名的占领清单落到母房上。queue 按优先顺序；每个房的状态：
    owned（已是我方且有 spawn）、bootstrapping（我方但还没 spawn，附开荒它的母房）、wait:<原因>（有主/被预定/有威胁，等它变无主）、
    noIntel（没拉到情报）、gcl（没有 GCL 余量）、noSponsor（没有 claimer 在 claimTravelTicks 内走得到、够格（capacities 给出时按 spawn 容量
    ≥ claimSponsorMinCapacity，否则 RCL≥claimMinLevel）且空闲的母房）、
    claim（已分给 sponsor，附 hops 与按地形估的 travel tick）。母房一次只开一房：正在开荒（sponsoring={母房: 目标}，孤儿房算给最近的够格母房）、
    带 <home>.claim 锁（locked_homes）或本轮已接清单房的都不再接。清单还有未完成的房时，脚本自己排的占领目标一律清空
    （analysis.claim.blocked = 'claimQueue'），只推进用户点名的房。就地修改 plans，返回 {房: {status, sponsor, hops}}。"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    if not queue:
        return {}
    owned = list(owned_rooms or [])
    for name, entry in intel.items():
        if entry and entry.get('owner') == me and name not in owned:
            owned.append(name)
    max_hops = int(cfg['claimSearchRooms'])
    limit = int(cfg['claimTravelTicks'])

    def eligible(home):
        if home in (locked_homes or ()):
            return False
        capacity = (capacities or {}).get(home)
        if capacity is not None:
            return int(capacity) >= int(cfg['claimSponsorMinCapacity'])
        return int(levels.get(home) or 0) >= int(cfg['claimMinLevel'])

    def nearest(room, exclude=()):
        """claimer 走得到（travel_ticks ≤ claimTravelTicks）且最近的够格空闲母房：(travel, RCL 高者, 房名)"""
        best = None
        for home in plans:
            if not eligible(home) or home in exclude:
                continue
            travel = travel_ticks(home, room, intel, me, limit, cfg, allow_keeper=True)
            if travel is None:
                continue
            key = (travel, -int(levels.get(home) or 0), home)
            if best is None or key < best[0]:
                best = (key, home, travel)
        return best

    busy = {}   # 母房 → 它正在开荒的房
    for home, target in (sponsoring or {}).items():
        if home in plans and target in bootstrapping_rooms(intel, me):
            busy[home] = target
    for room in bootstrapping_rooms(intel, me):
        if room in busy.values():
            continue
        found = nearest(room, exclude=busy)
        if found:
            busy[found[1]] = room
    status = {}
    headroom = int(gcl_level) - len(owned)
    pending = False
    for room in queue:
        entry = intel.get(room)
        if room in owned:
            if (entry and entry.get('owner') == me and not (entry.get('structures') or {}).get('spawn')) or room in busy.values():
                sponsor = next((home for home, target in busy.items() if target == room), None)
                status[room] = {'status': 'bootstrapping', 'sponsor': sponsor,
                                'hops': route_hops(sponsor, room, intel, me, max_hops, allow_keeper=True) if sponsor else None}
                pending = True
            else:
                status[room] = {'status': 'owned', 'sponsor': None, 'hops': None}
            continue
        pending = True
        if not entry or entry.get('unreachable'):
            status[room] = {'status': 'noIntel', 'sponsor': None, 'hops': None}
            continue
        reason = usable_for_claim(entry, me, cfg, tick)
        if reason:
            status[room] = {'status': 'wait:' + reason, 'sponsor': None, 'hops': None}
            continue
        if headroom <= 0:
            status[room] = {'status': 'gcl', 'sponsor': None, 'hops': None}
            continue
        found = nearest(room, exclude=busy)
        if not found:
            status[room] = {'status': 'noSponsor', 'sponsor': None, 'hops': None}
            continue
        _, sponsor, travel = found
        busy[sponsor] = room
        headroom -= 1
        plans[sponsor]['claim'] = {'room': room, 'priority': 1}
        plans[sponsor].setdefault('analysis', {}).setdefault('claim', {})['queue'] = room
        status[room] = {'status': 'claim', 'sponsor': sponsor, 'hops': route_hops(sponsor, room, intel, me, max_hops, allow_keeper=True), 'travel': travel}
    if pending:
        for home, item in plans.items():
            if home in (locked_homes or ()) or busy.get(home) in queue:
                continue
            if item.get('claim'):
                item['claim'] = None
                item.setdefault('analysis', {}).setdefault('claim', {})['blocked'] = 'claimQueue'
    return status
