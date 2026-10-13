"""指令：组装 Memory.brain 契约并通过 segment 90 写入。"""
import json
import time

CONTRACT_VERSION = 1
SEGMENT = 90
DEFAULT_TTL_MS = 30 * 60 * 1000
# 只把游戏内会用到的字段放进 segment，避免情报过大（segment 上限 100KB）
INTEL_FIELDS = ('at', 'source', 'class', 'sources', 'sourceData', 'lairs', 'controllerId', 'controllerPos',
                'level', 'owner', 'reservation', 'safeMode', 'mineral', 'hostiles', 'armedHostiles', 'hostileProfile',
                'invaderCore', 'threat', 'towers', 'walls', 'unreachable', 'roomStatus')


def slim_intel(intel):
    slim = {}
    for room, entry in intel.items():
        slim[room] = {key: entry[key] for key in INTEL_FIELDS if key in entry and entry[key] is not None}
    return slim


def build(plans, intel, locks=None, ttl_ms=DEFAULT_TTL_MS, now_ms=None):
    """plans: {home: {'remotes': [...], 'claim': {...}|None}}"""
    rooms = {}
    for home, plan in plans.items():
        rooms[home] = {
            'remotes': list(plan.get('remotes') or []),
            'claim': plan.get('claim'),
            'scouts': int(plan.get('scouts') or 0),   # 情报由外部提供，默认不再孵化 scout
            # 防御决定（combat.plan_defense）：{房: {action: fight|avoid, squad, until, reason}}；游戏内 defense.getDemands 在 until 前优先采用
            'defense': dict(plan.get('defense') or {}),
        }
        if 'mineral' in plan:
            rooms[home]['mineral'] = plan['mineral']
        # safe mode 决定（safemode.decide）：{action: activate|hold, reason, dps, eta, atTick}；游戏内 tower.js 在 decisionTtl tick 内采用
        if plan.get('safeMode'):
            rooms[home]['safeMode'] = dict(plan['safeMode'])
    locks = locks or {}
    for key, lock in locks.items():
        # agent 的显式决定覆盖确定性规划：key 形如 "W33S7.claim" / "W33S7.remotes"
        home, _, field = key.partition('.')
        if home in rooms and field and lock.get('until', 0) > (now_ms or time.time() * 1000):
            rooms[home][field] = lock.get('value')
    return {
        'version': CONTRACT_VERSION,
        'issuedAt': int(now_ms or time.time() * 1000),
        'ttlMs': int(ttl_ms),
        'intel': slim_intel(intel),
        'rooms': rooms,
        'locks': locks,
    }


def encode(directive):
    return json.dumps(directive, separators=(',', ':'), ensure_ascii=False)


# 引擎在每个 tick 末尾把 bot 激活的 segment 原样写回：API 写入若落在 bot 读取之后，就会被旧内容覆盖
# （private-server driver runtime.js 已核实；bot 侧读完即删键，这里再读回校验、必要时重写）
WRITE_RETRIES = 5
WRITE_VERIFY_DELAY = 2.0


def write(api, directive, segment=SEGMENT, retries=WRITE_RETRIES, delay=WRITE_VERIFY_DELAY, sleep=time.sleep):
    data = encode(directive)
    if len(data.encode('utf-8')) > 100000:
        raise ValueError('brain directive exceeds segment 90 capacity')
    for attempt in range(retries):
        api.set_segment(segment, data)
        sleep(delay)
        try:
            current = api.get_segment(segment)
        except Exception as error:  # 读回失败不算写入失败，下一轮大脑会再校验
            print('segment %d 读回失败（%s），按已写入处理' % (segment, error))
            return len(data)
        if current == data:
            return len(data)
        print('segment %d 写入被引擎写回覆盖（第 %d 次），重写' % (segment, attempt + 1))
    raise RuntimeError('segment %d write not visible after %d attempts' % (segment, retries))
