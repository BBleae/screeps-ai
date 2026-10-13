#!/usr/bin/env python3
"""外部大脑一轮：拉情报 → 规划 → （可选）写 segment 90 → 输出 state.json 与 brief.md。

用法：
  python3 scripts/brain/run.py --homes W33S7 --dry-run
  python3 scripts/brain/run.py --homes W33S7 --write
  python3 scripts/brain/run.py --server private --base-url http://127.0.0.1:21025 --username ValidationRemote --token <t> --homes W50N50 --write
"""
import argparse
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from brain import brief, combat, directive, intel, layout, minerals, plan, safemode  # noqa: E402
from brain.api import ScreepsApi, load_env  # noqa: E402


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--server', choices=['official', 'private'], default='official')
    parser.add_argument('--base-url', default=None)
    parser.add_argument('--token', default=None)
    parser.add_argument('--username', default=None, help='私服需要 X-Username')
    parser.add_argument('--shard', default='shard1')
    parser.add_argument('--homes', default='', help='逗号分隔的母房；留空则从 Memory.rooms 推断')
    parser.add_argument('--radius', type=int, default=2)
    parser.add_argument('--prefer-claim', default=None)
    # 外矿评分下限（默认不设门）：A/B 用同一提交只换这个参数，避免"两次提交"把别的改动也带进对照
    parser.add_argument('--remote-min-score', type=float, default=None)
    parser.add_argument('--out', default=os.path.join(ROOT, 'data', 'brain'))
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--dry-run', action='store_true')
    # 3 小时：launchd 每 5 分钟写一次，本机断网/官方 API 抖动几十分钟不该让游戏内指令过期（游戏内另有 6 小时宽限）
    parser.add_argument('--ttl-minutes', type=int, default=180)
    parser.add_argument('--min-interval', type=float, default=0.4)
    parser.add_argument('--no-dashboard', action='store_true', help='不更新监控面板（<out>/dashboard/）')
    return parser.parse_args(argv)


def make_api(args):
    env = load_env(ROOT)
    if args.server == 'official':
        base_url = args.base_url or 'https://screeps.com'
        token = args.token or env.get('SCREEPS_AUTH_TOKEN')
        username = None
    else:
        base_url = args.base_url or 'http://127.0.0.1:21025'
        token = args.token
        username = args.username
    if not token:
        raise SystemExit('missing API token')
    return ScreepsApi(base_url, token, username=username, shard=args.shard,
                      cache_dir=os.path.join(args.out, 'cache', args.server), min_interval=args.min_interval)


def owned_rooms(api, memory_rooms):
    names = []
    for name, mem in (memory_rooms or {}).items():
        if isinstance(mem, dict) and mem.get('plan'):
            names.append(name)
    return names


def run(args, api=None):
    api = api or make_api(args)
    me = api.me()
    my_id = str(me.get('_id'))
    my_name = me.get('username')
    gcl_level = int(((me.get('gcl') or 0) and gcl_from_points(me.get('gcl'))) or 0)
    tick = api.time()
    memory_rooms = api.memory('rooms') or {}
    homes = [h for h in args.homes.split(',') if h] or owned_rooms(api, memory_rooms)
    if not homes:
        raise SystemExit('no home rooms')
    creep_memory = api.memory('creeps') or {}
    locks = {}
    locks_file = os.path.join(args.out, 'locks.json')
    if os.path.exists(locks_file):
        with open(locks_file) as handle:
            locks = json.load(handle)
    now_ms = time.time() * 1000
    # 用户点名的占领清单可以在情报圈之外（线上 W33S3 离最近母房 3 格）：连同邻房一并拉情报
    claim_queue = plan.active_claim_queue(locks, now_ms)
    all_intel = intel.collect(api, homes, args.radius, my_user_id=my_id, tick=tick,
                              extra_rooms=plan.claim_queue_intel_rooms(claim_queue))
    # 规划参数覆盖（命令行）：留空表示用 plan.DEFAULTS
    plan_cfg = {}
    if getattr(args, 'remote_min_score', None) is not None:
        plan_cfg['remoteMinScore'] = float(args.remote_min_score)
    plan_cfg = plan_cfg or None
    plans = {}
    state_homes = {}
    owned = list(homes)
    for name, entry in all_intel.items():
        if entry.get('owner') == my_name and name not in owned:
            owned.append(name)
    for home in homes:
        level = int(((memory_rooms.get(home) or {}).get('state') or {}).get('rcl') or 0) or room_level(api, home)
        claim_lock = locks.get(home + '.claim')
        claim_override = plan.NO_OVERRIDE
        if claim_lock and claim_lock.get('until', 0) > now_ms:
            claim_override = claim_lock.get('value')
        current_remotes = plan.current_remote_names((memory_rooms.get(home) or {}).get('remotes'), tick=tick)
        home_plan = plan.plan_home(home, all_intel, my_name, level, gcl_level, owned, cfg=plan_cfg, tick=tick,
                                   prefer_claim=args.prefer_claim, claim_override=claim_override,
                                   current_remotes=current_remotes)
        # 防御：外矿（当前在用 + 规划白名单）里有武装敌人时，按母房容量算打不打得过（详见 combat.plan_defense）
        home_entry = all_intel.get(home) or {}
        structures = home_entry.get('structures') or {}
        capacity = combat.energy_capacity(level, structures.get('spawn', 0), structures.get('extension', 0))
        defense_rooms = list(dict.fromkeys(list(current_remotes) + list(home_plan.get('remotes') or [])))
        last_loss = (((memory_rooms.get(home) or {}).get('defenseLog') or {}).get('lastLoss')) or None
        income = ((memory_rooms.get(home) or {}).get('spawnIncome') or {}).get('ema')
        travel = {room: intel.room_distance(home, room) for room in defense_rooms}
        home_plan['defense'] = combat.plan_defense(home, defense_rooms, all_intel, capacity, tick, last_loss=last_loss,
                                                   income=income, travel_rooms=travel)
        # safe mode 由大脑决定（safemode.py）：看敌方 DPS/主人/强化、本房塔与次数、别的母房能否及时出兵
        home_plan['safeMode'] = safemode.decide(home, home_entry, safemode.helpers_for(home, all_intel, owned), tick,
                                                busy=safemode.safe_mode_busy(home, all_intel, owned))
        has_miner = any(c.get('role') == 'mineralMiner' and c.get('home') == home
                        for c in creep_memory.values() if isinstance(c, dict))
        if (level >= 6 or has_miner) and not home_entry.get('error'):
            objects = api.room_objects(home, ttl_s=0).get('objects') or []
            home_plan['mineral'] = minerals.plan(objects, api.room_terrain(home), my_id, tick,
                                                 capacity, creep_memory)
        else:
            home_plan['mineral'] = {'version': 1, 'enabled': False, 'build': False, 'count': 0, 'reason': 'rcl'}
        home_plan['capacity'] = capacity
        plans[home] = home_plan
        state_homes[home] = {'level': level, 'plan': home_plan,
                             'intel': {name: entry for name, entry in all_intel.items()
                                       if intel.room_distance(home, name) <= args.radius}}
    levels = {home: state_homes[home]['level'] for home in plans}
    plan.single_claim(plans, levels)
    # 用户点名的占领清单：有主的房等它无主，无主的分给最近的够格母房；正在开荒别的房的母房不接新目标
    locked_homes = {home for home in plans if (locks.get(home + '.claim') or {}).get('until', 0) > now_ms}
    sponsoring = {}
    for home in plans:
        target = (((memory_rooms.get(home) or {}).get('expansion')) or {}).get('target')
        if isinstance(target, str) and target and target != home:
            sponsoring[home] = target
    capacities = {home: plans[home].get('capacity') for home in plans if plans[home].get('capacity') is not None}
    queue_status = plan.assign_claim_queue(plans, claim_queue, all_intel, my_name, levels, owned, gcl_level,
                                           tick=tick, locked_homes=locked_homes, sponsoring=sponsoring, capacities=capacities)
    # 实际生效的占领目标（single_claim 之后，再叠加 locks 的覆盖）全账号排除后重排外矿，再去重分配（容量不够的母房让给养得起的）
    claim_rooms = set()
    for home in plans:
        lock = locks.get(home + '.claim')
        effective = lock.get('value') if (lock and lock.get('until', 0) > now_ms) else plans[home].get('claim')
        if effective and effective.get('room'):
            claim_rooms.add(effective['room'])
    current_by_home = {home: plan.current_remote_names((memory_rooms.get(home) or {}).get('remotes'), tick=tick) for home in plans}
    plan.replan_remotes(plans, all_intel, my_name, levels, owned, claim_rooms, tick=tick, current_by_home=current_by_home, cfg=plan_cfg)
    plan.assign_remotes(plans, levels, cfg=plan_cfg, prefer=plan.drop_preferences(memory_rooms, list(plans)))
    doc = directive.build(plans, all_intel, locks=locks, ttl_ms=args.ttl_minutes * 60 * 1000)
    blockers = write_blockers(all_intel, homes, levels)
    wrote = '未写入（dry-run）'
    if args.write and not args.dry_run:
        if blockers:
            # 2026-09-04 15:13：本机断网，room-objects 全部失败 → 这一轮写了 remotes=[] → 游戏内全部外矿 notWhitelisted，
            # 7 个 reserver 与所有远程 creep 退役，6 分钟后白名单恢复再全部重孵。情报不完整就不写：上一份指令在 TTL 内继续有效，
            # 过期后游戏内退回自治逻辑（已启用的外矿照常运行）。
            wrote = '未写入（情报不完整：%s）' % '; '.join(blockers)
        else:
            size = directive.write(api, doc)
            wrote = 'segment %d，%d 字节，issuedAt %d' % (directive.SEGMENT, size, doc['issuedAt'])
    state = {'generatedAt': time.time(), 'tick': tick, 'me': my_name, 'gcl': gcl_level,
             'homes': state_homes, 'directive': doc, 'wrote': wrote, 'blockers': blockers, 'apiCalls': api.calls,
             'claimQueue': queue_status}
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'state.json'), 'w') as handle:
        json.dump(state, handle, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, 'brief.md'), 'w') as handle:
        handle.write(brief.render(state))
    update_dashboard(args, api, state, me, memory_rooms, creep_memory)
    return state


def update_dashboard(args, api, state, me, memory_rooms, creep_memory):
    """监控面板（dashboard.py）：只记 launchd 那种完整轮次——官方服务器（私服验证/基准不混进线上历史）、母房自动识别
    （手动 --homes 子集会让那一条只剩几个房）、不是 --dry-run。import 也放在 try 里：面板模块坏了不能连累大脑，
    也不能连累 import 本模块的 guard.py（safe mode 决策）。出错只打到 stderr，不影响这一轮的指令"""
    if getattr(args, 'server', 'official') != 'official' or getattr(args, 'no_dashboard', False) \
            or getattr(args, 'homes', '') or getattr(args, 'dry_run', False):
        return False
    try:
        from brain import dashboard
        dashboard.update(os.path.join(args.out, 'dashboard'), api, state, me, memory_rooms, creep_memory)
        return True
    except Exception as error:  # noqa: BLE001 - 面板是旁路
        print('dashboard: %s: %s' % (type(error).__name__, error), file=sys.stderr)
        return False


def write_blockers(all_intel, homes, levels):
    """这一轮不能写指令的原因：任何房 room-objects 拉取失败（entry 带 error），或母房等级读成 0（同样是接口失败）。
    这两种情况下 choose_remotes 会给出空白名单，写进去等于命令游戏内解散全部外矿。"""
    blockers = []
    for name in sorted(all_intel):
        entry = all_intel[name] or {}
        if entry.get('error'):
            blockers.append('intel:%s:%s' % (name, entry['error']))
    for home in homes:
        if not int(levels.get(home) or 0):
            blockers.append('level:%s' % home)
    return blockers


def gcl_from_points(points):
    """GCL 等级 = floor((points / 1e6) ** (1/2.4)) + 1（GCL_POW=2.4, GCL_MULTIPLY=1e6）。"""
    try:
        return int((float(points) / 1e6) ** (1 / 2.4)) + 1
    except (TypeError, ValueError):
        return 0


def room_level(api, room):
    try:
        payload = api.room_objects(room, ttl_s=30)
        for obj in payload.get('objects') or []:
            if obj.get('type') == 'controller':
                return int(obj.get('level') or 0)
    except Exception:  # noqa: BLE001
        pass
    return 0


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    state = run(args)
    rooms = state['directive'].get('rooms', {})
    summary = {home: {'remotes': rooms.get(home, {}).get('remotes'), 'claim': rooms.get(home, {}).get('claim')}
               for home in state['homes']}
    print(json.dumps({'tick': state['tick'], 'gcl': state['gcl'], 'plans': summary, 'wrote': state['wrote'],
                      'blockers': state.get('blockers') or [], 'apiCalls': state['apiCalls'],
                      'claimQueue': state.get('claimQueue') or {}, 'out': args.out}, ensure_ascii=False))


if __name__ == '__main__':
    main()
