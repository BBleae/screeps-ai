"""safe mode 决策：由大脑决定己方房要不要开 safe mode；游戏内（src/tower.js）只保留"核心建筑已经掉血"的最后手段。

背景（2026-09-06 W31S8）：无塔的 RCL2 新房被一只 NPC 入侵者触发 safe mode，20000 tick + 50000 tick 冷却里再不能开盾，
18 tick 后防御模块还照样孵了两只 defender。大脑比游戏内多两样东西：room-objects 里的敌方 body/boost/owner（不需要视野），
以及全账号视角（哪个母房能出兵、几跳路程）。决策：
  - 没有武装敌人 / 已在 safe mode / 没有次数 → hold；
  - 有能量的塔压得住（敌方治疗 < 塔伤害）→ hold（交给塔）；
  - 敌人 DPS 太低（NPC < safeModeNpcMinDps、玩家 < safeModePlayerMinDps）→ hold（交给 defender）；
  - 玩家强化 creep → activate；
  - 没有别的母房能出兵 → activate；
  - 最近母房出兵到达前（孵化 + 每房路程）敌人能打掉 spawn 血量的 safeModeCoreShare 以上 → activate，否则 hold（等 defender）。
决定写进 segment 的 rooms[房].safeMode = {action, reason, dps, eta, atTick}；游戏内 decisionTtl tick 内有效。
"""
from .intel import room_distance

SPAWN_HITS = 5000
TOWER_DAMAGE_FAR = 150      # 塔在 20 格外的最低伤害（保守：不知道敌人会站在哪）
NPC_OWNERS = ('Invader', 'Source Keeper')
DEFAULTS = {
    'safeModeHelpSpawnTicks': 60,       # 最近母房孵一队 defender 的时间
    'safeModeHelpTicksPerRoom': 50,     # defender 每穿一个房的路程
    'safeModeCoreShare': 0.8,           # 救援到达前敌人能打掉 spawn 血量的这个份额就开盾
    'safeModeNpcMinDps': 30,            # 低于此 DPS 的 NPC 杂兵交给 defender（1 个 ATTACK）
    'safeModePlayerMinDps': 60,         # 玩家 creep 的门槛（1–2 个 ATTACK 的侦察兵不值得开盾）
    'safeModeTowerMargin': 0.9,         # 敌方治疗 < 塔伤害 × margin 才算塔压得住
}


def helpers_for(room, intel, owned):
    """能出兵的其他己方房：有 spawn 的房及其到 room 的房数距离"""
    out = []
    for name in owned or ():
        if name == room:
            continue
        entry = intel.get(name) or {}
        if not (entry.get('structures') or {}).get('spawn'):
            continue
        out.append({'room': name, 'hops': room_distance(room, name)})
    return sorted(out, key=lambda item: item['hops'])


def safe_mode_busy(room, intel, owned):
    """同一账号同时只能有一房在 safe mode（activateSafeMode 返回 ERR_BUSY）：返回正开着盾的别的己方房，没有返回 None。
    2026-09-06 W31S5 被强化 Invader 打、大脑 activate，但 W31S8 的盾还剩 7600 tick，游戏内开不了"""
    for name in owned or ():
        if name == room:
            continue
        entry = (intel or {}).get(name) or {}
        if entry.get('safeMode'):
            return name
    return None


def decide(room, entry, helpers, tick, cfg=None, busy=None):
    """busy：正开着盾的别的己方房（safe_mode_busy），有则本房开不了，给 hold（busy:<房>）让游戏内不再每 tick 试"""
    cfg = dict(DEFAULTS, **(cfg or {}))
    entry = entry or {}
    profile = entry.get('hostileProfile') or {}
    armed = int(entry.get('armedHostiles') or 0)
    dps = int(profile.get('dps') or 0)
    base = {'atTick': int(tick), 'armed': armed, 'dps': dps}
    if not armed or not profile:
        return dict(base, action='hold', reason='no-threat')
    if entry.get('safeMode'):
        return dict(base, action='hold', reason='already-on')
    if busy:
        return dict(base, action='hold', reason='busy:' + str(busy))
    if not int(entry.get('safeModeAvailable') or 0):
        return dict(base, action='hold', reason='no-charge')
    towers = int((entry.get('structures') or {}).get('tower') or 0)
    tower_energy = int(entry.get('towerEnergy') or 0)
    if towers and tower_energy >= 10 and int(profile.get('heal') or 0) < towers * TOWER_DAMAGE_FAR * cfg['safeModeTowerMargin']:
        return dict(base, action='hold', reason='towers')
    owners = entry.get('hostileOwners') or []
    player = any(owner not in NPC_OWNERS for owner in owners)
    min_dps = cfg['safeModePlayerMinDps'] if player else cfg['safeModeNpcMinDps']
    if dps < min_dps:
        return dict(base, action='hold', reason='weak')
    if player and profile.get('boosted'):
        return dict(base, action='activate', reason='boosted-player')
    if not helpers:
        return dict(base, action='activate', reason='no-help')
    eta = min(cfg['safeModeHelpSpawnTicks'] + int(helper.get('hops') or 0) * cfg['safeModeHelpTicksPerRoom'] for helper in helpers)
    damage = dps * eta
    if damage >= SPAWN_HITS * cfg['safeModeCoreShare']:
        return dict(base, action='activate', reason='help-too-late', eta=int(eta), damage=int(damage))
    return dict(base, action='hold', reason='help-in-time', eta=int(eta), damage=int(damage))


def decide_all(intel, owned, tick, cfg=None):
    """所有己方房的决定（有情报的才算）"""
    out = {}
    for room in owned or ():
        entry = intel.get(room)
        if not entry or entry.get('error'):
            continue
        out[room] = decide(room, entry, helpers_for(room, intel, owned), tick, cfg, busy=safe_mode_busy(room, intel, owned))
    return out
