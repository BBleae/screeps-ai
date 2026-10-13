#!/usr/bin/env python3
"""Source Keeper 房当外矿的 ROI 模型（离线，参数化）。

引擎事实（private-server/server/node_modules/@screeps/engine，keeper-lairs/tick.js、creeps/keepers/pretick.js、common constants）：
  - SK 源容量 4000（SOURCE_ENERGY_KEEPER_CAPACITY），300 tick 再生 → 13.33 能量/tick/源；SK 房没有控制器，不能预定
  - Keeper：17 TOUGH + 13 MOVE + 10 ATTACK + 10 RANGED_ATTACK，5000 hits；死亡（或掉血）后 300 tick（ENERGY_REGEN_TIME）在 lair 重生
  - Keeper 只走到自己源的 1 格内，攻击 1 格内血最少的（300/tick）、3 格内的远程（100/tick）；不追击 → 3 格外安全
  - Invader Core（stronghold）会在 SK 房出现，STRONGHOLD_DECAY_TICKS 75000 后消失；期间房间不可采

账目口径与 remote_roi.py 一致（每 tick 摊平）：
  毛产出 = Σ 源 min(矿工 WORK×2, 13.33) × (1500 − 距离)/1500；运力 = Σ hauler CARRY×50/(2×距离+4)；到家 = min
  维持   = 矿工/hauler/killer 成本/1500（killer 按 lossFactor 上浮：偶尔被 Keeper 或入侵者打死）+ 容器 0.5/tick/个（无主房 100 tick 掉 5000 hits）+ 道路 0.001/格
  killer = 能单挑一只 Keeper 并在下一只出场前回满血的最便宜身体（求解器 killer_body），MOVE = A+H（lair 之间要全速赶路）
  净     = 到家 − 维持；再按 downtime（stronghold 占用时间份额）打折
"""
import argparse
import math

SOURCE_RATE = 4000 / 300          # 13.33
KEEPER_HITS = 5000
KEEPER_MELEE = 10 * 30            # 10 ATTACK
KEEPER_RANGED = 10 * 10           # 10 RANGED_ATTACK，3 格内
KEEPER_RESPAWN = 300
CREEP_LIFE = 1500
ATTACK_POWER = 30
HEAL_POWER = 12
COST = {'attack': 80, 'heal': 250, 'move': 50, 'work': 100, 'carry': 50, 'tough': 10}
CONTAINER_REPAIR_UNOWNED = 0.5
CONTAINER_COST = 5000
ROAD_COST_PLAIN = 300
ROAD_REPAIR_PLAIN = 0.001


def killer_body(capacity, lairs=3, approach_damage=200, hits_margin=0.8, recover_within=None):
    """能单挑一只 Keeper 的最便宜 (attack, heal, move) 身体；找不到返回 None。
    战斗 F = ceil(5000 / (30A)) tick，贴身每 tick 受 400、自疗 12H；靠近时先吃 approach_damage；
    存活：F×max(0, 400−12H) + approach ≤ hits×hits_margin；回血：净伤/(12H) ≤ recover_within（默认 300/lairs，下一只 Keeper 出场前）。"""
    recover_within = recover_within or KEEPER_RESPAWN / max(1, lairs)
    best = None
    for attack in range(1, 50):
        for heal in range(0, 50 - attack):
            move = attack + heal
            parts = attack + heal + move
            if parts > 50:
                continue
            cost = attack * COST['attack'] + heal * COST['heal'] + move * COST['move']
            if cost > capacity:
                continue
            fight = math.ceil(KEEPER_HITS / (ATTACK_POWER * attack))
            net_per_tick = max(0, KEEPER_MELEE + KEEPER_RANGED - HEAL_POWER * heal)
            damage = fight * net_per_tick + approach_damage
            if damage > parts * 100 * hits_margin:
                continue
            if heal == 0 or damage / (HEAL_POWER * heal) > recover_within:
                continue
            candidate = {'attack': attack, 'heal': heal, 'move': move, 'parts': parts, 'cost': cost,
                         'fightTicks': fight, 'damageTaken': damage, 'recoverTicks': damage / (HEAL_POWER * heal)}
            if best is None or cost < best['cost'] or (cost == best['cost'] and damage < best['damageTaken']):
                best = candidate
    return best


def miner_body(capacity, rate=SOURCE_RATE):
    """够采满 rate 的静态矿工：WORK×2 ≥ rate，1 CARRY 修容器，路上 MOVE = ceil(部件/2)"""
    work = math.ceil(rate / 2)
    move = math.ceil((work + 1) / 2)
    cost = work * COST['work'] + COST['carry'] + move * COST['move']
    if cost > capacity:
        return None
    return {'work': work, 'carry': 1, 'move': move, 'parts': work + 1 + move, 'cost': cost}


def hauler_bodies(capacity, required_carry, road=True):
    """按 remote.js 的槽位逻辑拆 hauler：第一只尽量大（1 WORK 修路），后续只补差额（下限 4 CARRY）"""
    bodies = []
    planned = 0
    while planned < required_carry and len(bodies) < 8:
        residual = None if not bodies else max(4, required_carry - planned)
        best = None
        for carry in range(1, 33):
            if residual is not None and carry > residual:
                break
            work = 1 if not bodies else 0
            move = math.ceil((carry + work) / 2) if road else carry + work
            cost = work * COST['work'] + carry * COST['carry'] + move * COST['move']
            if cost > capacity or work + carry + move > 50:
                break
            best = {'work': work, 'carry': carry, 'move': move, 'parts': work + carry + move, 'cost': cost}
        if not best:
            break
        bodies.append(best)
        planned += best['carry']
    return bodies


def evaluate(capacity, distances, lairs=3, loss_factor=1.2, downtime=0.25, road_tiles=None):
    """distances：每个源到母房 spawn 的路程；road_tiles：要修的道路格数（默认 = 最长路程，其余共享）"""
    killer = killer_body(capacity, lairs=lairs)
    miner = miner_body(capacity)
    if not killer or not miner:
        return {'viable': False, 'killer': killer, 'miner': miner, 'capacity': capacity}
    sources = []
    gross = capacity_total = delivered = 0.0
    spawn_ticks = killer['parts'] * 3
    upkeep = {'killer': killer['cost'] / CREEP_LIFE * loss_factor, 'miner': 0.0, 'hauler': 0.0}
    for distance in distances:
        uptime = max(0.0, CREEP_LIFE - distance) / CREEP_LIFE
        harvest = min(miner['work'] * 2, SOURCE_RATE) * uptime
        required = math.ceil(SOURCE_RATE * (2 * distance + 4) / 50)
        haulers = hauler_bodies(capacity, required)
        carry = sum(h['carry'] for h in haulers)
        haul = carry * 50 / (2 * distance + 4)
        gross += harvest
        capacity_total += haul
        delivered += min(harvest, haul)
        upkeep['miner'] += miner['cost'] / CREEP_LIFE * loss_factor
        upkeep['hauler'] += sum(h['cost'] for h in haulers) / CREEP_LIFE * loss_factor
        spawn_ticks += miner['parts'] * 3 + sum(h['parts'] * 3 for h in haulers)
        sources.append({'distance': distance, 'requiredCarry': required, 'haulers': haulers, 'harvest': harvest, 'haul': haul})
    tiles = road_tiles if road_tiles is not None else max(distances)
    repair = len(distances) * CONTAINER_REPAIR_UNOWNED + tiles * ROAD_REPAIR_PLAIN
    total_upkeep = sum(upkeep.values()) + repair
    net = delivered - total_upkeep
    setup = len(distances) * CONTAINER_COST + tiles * ROAD_COST_PLAIN + killer['cost']
    spawn_share = spawn_ticks / CREEP_LIFE
    return {
        'viable': True, 'capacity': capacity, 'killer': killer, 'miner': miner, 'sources': sources,
        'gross': gross, 'capacity_total': capacity_total, 'delivered': delivered,
        'upkeep': upkeep, 'repair': repair, 'totalUpkeep': total_upkeep,
        'net': net, 'netAfterDowntime': net * (1 - downtime), 'roi': net / total_upkeep if total_upkeep else None,
        'setup': setup, 'payback': setup / net if net > 0 else None,
        'spawnShare': spawn_share, 'netPerSpawn': net / spawn_share if spawn_share else None,
        'creeps': 1 + len(distances) + sum(len(s['haulers']) for s in sources),
    }


def fmt(value, digits=1):
    return '-' if value is None else f'{value:.{digits}f}'


def print_report(label, report):
    if not report['viable']:
        print(f'{label} 容量 {report["capacity"]}: 不可行——{"没有能单挑 Keeper 的身体" if not report["killer"] else "矿工买不起"}')
        return
    k = report['killer']
    print(f'{label} 容量 {report["capacity"]}: 净 {fmt(report["net"])}/tick（stronghold 停机打折后 {fmt(report["netAfterDowntime"])}）'
          f' ROI {fmt(report["roi"])}x 回本 {fmt(report["payback"], 0)}t spawn 占用 {fmt(report["spawnShare"] * 100, 0)}%'
          f' 整个 spawn 折合 {fmt(report["netPerSpawn"])}/tick creep {report["creeps"]} 只')
    print(f'  killer {k["attack"]}A/{k["heal"]}H/{k["move"]}M 成本 {k["cost"]}：{k["fightTicks"]} tick 杀一只，掉 {k["damageTaken"]:.0f} 血，{k["recoverTicks"]:.0f} tick 回满')
    print(f'  毛产 {fmt(report["gross"])} 运力 {fmt(report["capacity_total"])} 到家 {fmt(report["delivered"])}  '
          f'维持 {fmt(report["totalUpkeep"])}（killer {fmt(report["upkeep"]["killer"])} 矿 {fmt(report["upkeep"]["miner"])} haul {fmt(report["upkeep"]["hauler"])} 修 {fmt(report["repair"])}）  一次性投入 {report["setup"]:.0f}')
    for s in report['sources']:
        bodies = ','.join(f'{h["carry"]}C@{h["cost"]}' for h in s['haulers'])
        print(f'  源 距{s["distance"]}: 需 {s["requiredCarry"]} CARRY → hauler {bodies}  采 {fmt(s["harvest"])} 运 {fmt(s["haul"])}')


def main():
    parser = argparse.ArgumentParser(description='SK 房外矿 ROI')
    parser.add_argument('--cap', type=int, nargs='+', default=[1650, 2300, 5600, 12900], help='母房容量（RCL5 1650 / RCL6 2300 / RCL7 5600 / RCL8 12900）')
    parser.add_argument('--dist', type=str, default='62,44,25', help='各源到母房 spawn 的路程，逗号分隔')
    parser.add_argument('--label', default='W34S7→W34S6')
    parser.add_argument('--downtime', type=float, default=0.25, help='stronghold 占用时间份额')
    parser.add_argument('--loss', type=float, default=1.2, help='creep 成本上浮（被 Keeper/入侵者打死）')
    args = parser.parse_args()
    distances = [int(x) for x in args.dist.split(',') if x.strip()]
    for cap in args.cap:
        print_report(args.label, evaluate(cap, distances, loss_factor=args.loss, downtime=args.downtime))


if __name__ == '__main__':
    main()
