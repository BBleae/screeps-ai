"""战力模型：与 src/defense.js 同一套公式（两边必须一致，改一处要改另一处并跑各自的测试）。

外部大脑用官方 API 的 room-objects 能看到任何房间里的敌方 creep（body、boost、hits、ageTime），不需要游戏内视野，
所以"打不打得过"这个决定放在这里做，结果作为 rooms[home].defense 指令下发；游戏内只在有视野时兜底（己方房、远程 creep 看到的外矿）。

模型（悲观：双方同时交换伤害，对方全部在射程内）：
  我方净伤害 = 我方 dps − 对方治疗；对方净伤害 = 对方 dps − 我方治疗
  能赢 ⇔ 对方血量 / 我方净伤害 × winMargin ≤ 我方血量 / 对方净伤害（对方打不动 = 无穷）
风筝型（有远程、无近战、能动：引擎里这种 Invader 会拉开到 3 格）在场时只考虑远程编组。
"""
ATTACK_POWER = 30
RANGED_ATTACK_POWER = 10
HEAL_POWER = 12
CREEP_LIFE = 1500
BOOSTS = {
    'attack': {'UH': 2, 'UH2O': 3, 'XUH2O': 4},
    'ranged_attack': {'KO': 2, 'KHO2': 3, 'XKHO2': 4},
    'heal': {'LO': 2, 'LHO2': 3, 'XLHO2': 4},
    'tough': {'GO': 0.7, 'GHO2': 0.5, 'XGHO2': 0.3},
}
PART_COST = {'move': 50, 'work': 100, 'carry': 50, 'attack': 80, 'ranged_attack': 150, 'heal': 250, 'claim': 600, 'tough': 10}
EXTENSION_CAPACITY = {1: 50, 2: 50, 3: 50, 4: 50, 5: 50, 6: 50, 7: 100, 8: 200}
DEFAULTS = {'maxDefenders': 3, 'winMargin': 1.5, 'remoteValueShare': 0.5, 'lossMarginFactor': 1.25, 'lossTicks': 1500}


def _parts(subject):
    if isinstance(subject, dict):
        return subject.get('body') or []
    return [part if isinstance(part, dict) else {'type': part} for part in subject or []]


def body_cost(body):
    return sum(PART_COST.get(part if isinstance(part, str) else part.get('type'), 0) for part in body or [])


def creep_profile(subject):
    """subject：room-objects 的 creep 字典（body 含 type/hits/boost，hits 为总血量）或身体数组。"""
    live = isinstance(subject, dict) and subject.get('hits') is not None
    hits = float(subject.get('hits')) if live else 0.0
    dps = heal = 0.0
    attack = ranged = move = 0
    boosted = False
    for part in _parts(subject):
        if part.get('hits') == 0:
            continue
        kind = part.get('type')
        mult = BOOSTS.get(kind, {}).get(part.get('boost')) or 1
        if part.get('boost'):
            boosted = True
        part_hits = 100 if part.get('hits') is None else part.get('hits')
        if not live:
            hits += part_hits
        if kind == 'tough' and mult < 1:
            hits += part_hits * (1 / mult - 1)
        if kind == 'attack':
            dps += ATTACK_POWER * mult
            attack += 1
        elif kind == 'ranged_attack':
            dps += RANGED_ATTACK_POWER * mult
            ranged += 1
        elif kind == 'heal':
            heal += HEAL_POWER * mult
        elif kind == 'move':
            move += 1
    return {'hits': hits, 'dps': dps, 'heal': heal, 'kiter': ranged > 0 and attack == 0 and move > 0, 'boosted': boosted}


def hostile_profile(creeps, tick):
    """一群敌人的画像；until = 最晚到期的 tick（room-objects 的 ageTime；缺失按 1500）。"""
    out = {'at': int(tick), 'count': 0, 'hits': 0.0, 'dps': 0.0, 'heal': 0.0, 'kiters': False, 'boosted': False, 'until': int(tick)}
    for creep in creeps or []:
        profile = creep_profile(creep)
        out['count'] += 1
        out['hits'] += profile['hits']
        out['dps'] += profile['dps']
        out['heal'] += profile['heal']
        out['kiters'] = out['kiters'] or profile['kiter']
        out['boosted'] = out['boosted'] or profile['boosted']
        age = creep.get('ageTime') if isinstance(creep, dict) else None
        until = int(age) if age else int(tick) + CREEP_LIFE
        out['until'] = max(out['until'], until)
    for key in ('hits', 'dps', 'heal'):
        out[key] = int(round(out[key]))
    return out


def squad_profile(bodies):
    out = {'hits': 0.0, 'dps': 0.0, 'heal': 0.0}
    for body in bodies or []:
        profile = creep_profile(body)
        for key in out:
            out[key] += profile[key]
    return out


def can_beat(bodies, enemy, margin=None):
    if not enemy or not enemy.get('count'):
        return True
    ours = squad_profile(bodies)
    factor = DEFAULTS['winMargin'] if margin is None else float(margin)
    enemy_net = ours['dps'] - enemy.get('heal', 0)
    if enemy_net <= 0:
        return False
    kill_time = enemy['hits'] / enemy_net
    our_net = enemy.get('dps', 0) - ours['heal']
    survive_time = float('inf') if our_net <= 0 else ours['hits'] / our_net
    return kill_time * factor <= survive_time


def melee_body(attack):
    return ['move'] * attack + ['attack'] * attack


def ranged_body(ranged, heal):
    return ['move'] * (ranged + heal) + ['ranged_attack'] * ranged + ['heal'] * heal


def candidates(capacity, style=None):
    out = []
    if style != 'ranged':
        for attack in range(2, 26):
            body = melee_body(attack)
            cost = body_cost(body)
            if cost > capacity:
                break
            out.append({'style': 'melee', 'body': body, 'cost': cost})
    if style != 'melee':
        for ranged in range(1, 26):
            for heal in range(0, min(5, ranged) + 1):
                body = ranged_body(ranged, heal)
                if len(body) > 50:
                    continue
                cost = body_cost(body)
                if cost > capacity:
                    continue
                out.append({'style': 'ranged', 'body': body, 'cost': cost})
    out.sort(key=lambda item: (item['cost'], len(item['body'])))
    return out


def plan_squad(capacity, enemy, cfg=None):
    """最便宜的能赢的编组：1..maxDefenders 只同样的身体。找不到返回 None。"""
    if not enemy or not enemy.get('count'):
        return None
    cfg = dict(DEFAULTS, **(cfg or {}))
    options = candidates(capacity, 'ranged' if enemy.get('kiters') else None)
    best = None
    for count in range(1, max(1, int(cfg['maxDefenders'])) + 1):
        for candidate in options:
            if not can_beat([candidate['body']] * count, enemy, cfg['winMargin']):
                continue
            total = candidate['cost'] * count
            if best is None or total < best['total']:
                best = {'style': candidate['style'], 'body': candidate['body'], 'cost': candidate['cost'], 'count': count, 'total': total}
            break
    return best


def energy_capacity(level, spawns, extensions):
    """母房 spawn/extension 数与 RCL → energyCapacityAvailable（extension 容量 RCL7 100、RCL8 200）。"""
    return int(spawns or 0) * 300 + int(extensions or 0) * EXTENSION_CAPACITY.get(int(level or 1), 50)


def assembly_lead(squad, income=None, travel_rooms_count=1):
    """编组到场要多少 tick：攒够总成本（母房 spawn 收入 EMA，来自 Memory.rooms[home].spawnIncome.ema；未知按 0）+ 逐只孵化（3 tick/部件）+ 走路（每房 50）"""
    accumulate = squad['total'] / max(0.5, float(income)) if income else 0
    spawn_ticks = squad['count'] * len(squad['body']) * 3
    travel = max(1, int(travel_rooms_count or 1)) * 50
    return int(round(accumulate + spawn_ticks + travel))


def plan_defense(home, rooms, intel, capacity, tick, cfg=None, last_loss=None, income=None, travel_rooms=None):
    """对 rooms（当前外矿 + 白名单）里有武装敌人画像的房给出指令：
    {room: {'action': 'fight', 'squad': {count, body, style, cost, total}, 'until', 'reason'} |
           {'action': 'avoid', 'until', 'reason'}}
    fight 还要过经济门槛（编组总成本 ≤ 源数 × 10/tick × 到场后入侵者剩余寿命 × remoteValueShare；income 是母房 spawn 收入 EMA，
    travel_rooms 是 {房: 距离房数}）；
    近期在这房阵亡过（Memory.rooms[home].defenseLog.lastLoss）就把 winMargin 提高 lossMarginFactor 倍。"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    out = {}
    for room in rooms or []:
        entry = (intel or {}).get(room) or {}
        profile = entry.get('hostileProfile')
        if not profile or not profile.get('count') or int(profile.get('until') or 0) <= int(tick):
            continue
        margin = cfg['winMargin']
        if last_loss and last_loss.get('room') == room and int(tick) - int(last_loss.get('at') or 0) <= cfg['lossTicks']:
            margin *= cfg['lossMarginFactor']
        squad = plan_squad(capacity, profile, dict(cfg, winMargin=margin))
        # 值不值按"到场时"算：攒能量 + 孵化 + 走路的时间从入侵者剩余寿命里扣掉（2026-09-05 W33S6：按当下算 fight，刚孵一只就翻成 avoid）
        lead = assembly_lead(squad, income, (travel_rooms or {}).get(room, 1)) if squad else 0
        remaining = max(0, int(profile['until']) - int(tick) - lead)
        value = max(1, int(entry.get('sources') or 1)) * 10 * remaining * cfg['remoteValueShare']
        base = {'until': int(profile['until']), 'count': int(profile['count']), 'boosted': bool(profile.get('boosted')),
                'kiters': bool(profile.get('kiters')), 'capacity': int(capacity), 'lead': lead}
        if not squad:
            out[room] = dict(base, action='avoid', reason='unwinnable')
        elif squad['total'] > value:
            out[room] = dict(base, action='avoid', reason='notWorth:%d>%d' % (squad['total'], int(value)))
        else:
            out[room] = dict(base, action='fight', reason='winnable', squad=squad)
    return out
