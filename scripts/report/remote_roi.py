#!/usr/bin/env python3
"""外矿 ROI：每个外矿每 tick 的能量账（毛产出、运力上限、到家能量、维持成本、净收益、回本、spawn 占用）。

数据来自线上 console 探针：`require('remote').getDemands(home)` 给出每个外矿在当前容量下的计划编制（身体 → 成本/WORK/CARRY），
Game.creeps 给出在岗 creep；记录里的源距离、容器、道路、预定来自 Memory.rooms[母房].remotes。

用法:
  python3 scripts/report/remote_roi.py                # 线上探针 + 打印
  python3 scripts/report/remote_roi.py --json out.json   # 同时把探针原始数据存下来
  python3 scripts/report/remote_roi.py --from out.json   # 离线复算

账目口径（全部按每 tick 摊平）：
  毛产出   = Σ 源 min(矿工 WORK×2, 源容量/300) × 在岗率，在岗率 = (1500 − 源距离)/1500（每代矿工走一次路）
  运力     = Σ 源 hauler CARRY×50 / (2×距离 + 4)（remote.js 的 requiredCarry 公式反过来）
  到家     = Σ 源 min(毛产出, 运力)，源没有容器时为 0（矿工还在建容器）
  维持成本 = 矿工成本/1500 + hauler 成本/1500 + reserver 成本/600（CLAIM creep 只活 600 tick）
           + 容器修理（预定房 5000 hits/500 tick → 0.1 能量/tick，未预定 0.5）+ 道路修理（平地 0.001/tick/格）
  净收益   = 到家 − 维持成本；ROI = 净收益/维持成本；回本 = 一次性投入（容器 5000/源 + 道路 300/格）/净收益
  spawn 占用 = Σ 身体部件×3 / 寿命，占一个 spawn 的份额
  "不预定"对照：源 1500 档（5/tick）、无 reserver、hauler 成本按需求减半、容器修理 0.5/tick
"""
import argparse
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

CREEP_LIFE = 1500
CLAIM_LIFE = 600
SOURCE_REGEN = 300
HARVEST_PER_WORK = 2
CARRY_CAPACITY = 50
CONTAINER_COST = 5000
CONTAINER_REPAIR_RESERVED = 5000 / 500 / 100   # 0.1 能量/tick
CONTAINER_REPAIR_UNOWNED = 5000 / 100 / 100    # 0.5 能量/tick
ROAD_COST_PLAIN = 300
ROAD_REPAIR_PLAIN = 100 / 1000 / 100           # 0.001 能量/tick/格（平地）
UNRESERVED_CAPACITY = 1500
RESERVED_CAPACITY = 3000

PROBE = r"""
(function() {
  function bodyInfo(parts) {
    var cost = 0, work = 0, carry = 0, claim = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i] && parts[i].type ? parts[i].type : parts[i];
      cost += BODYPART_COST[p] || 0;
      if (p === WORK) work++;
      if (p === CARRY) carry++;
      if (p === CLAIM) claim++;
    }
    return { cost: cost, parts: parts.length, work: work, carry: carry, claim: claim };
  }
  var remote = require('remote');
  var out = { nonce: '__NONCE__', t: Game.time, homes: [] };
  _.forEach(Game.rooms, function(r) {
    if (!r.controller || !r.controller.my) return;
    var mem = (Memory.rooms || {})[r.name] || {};
    var remotes = mem.remotes || {};
    if (!Object.keys(remotes).length) return;
    var demands;
    try { demands = remote.getDemands(r) || []; } catch (e) { demands = null; }
    var reserverBody = [];
    try { reserverBody = remote.reserverBody(r.energyCapacityAvailable) || []; } catch (e) { reserverBody = []; }
    var home = { name: r.name, rcl: r.controller.level, cap: r.energyCapacityAvailable, reserver: bodyInfo(reserverBody), remotes: [] };
    _.forEach(remotes, function(x, key) {
      var name = x.room || key;
      home.remotes.push({
        room: name,
        enabled: x.enabled !== false,
        suspendedUntil: x.suspendedUntil || 0,
        suspendReason: x.suspendReason || null,
        reservation: x.reservation ? (x.reservation.ticksToEnd || 0) : 0,
        controllerDistance: x.controllerDistance || null,
        dropRoom: x.drop && x.drop.room && x.drop.room !== r.name ? x.drop.room : null,
        dropDistance: x.drop && x.drop.room && x.drop.room !== r.name && x.drop.distance > 0 ? x.drop.distance : null,
        sources: _.map(x.sources || [], function(s) {
          return { id: s.id, distance: s.distance || null, energyCapacity: s.energyCapacity || 1500,
                   container: !!s.containerId, roadTiles: s.road ? s.road.split(';').length : 0, roadComplete: !!s.roadComplete };
        }),
        demands: demands ? _.map(_.filter(demands, function(d) { return d.memory && d.memory.remoteRoom === name; }), function(d) {
          var b = bodyInfo(d.body || []);
          b.role = d.role; b.slot = d.slot; b.sourceId = d.memory.sourceId || null;
          return b;
        }) : null,
        alive: _.map(_.filter(Game.creeps, function(c) { return c.memory.home === r.name && c.memory.remoteRoom === name; }), function(c) {
          var b = bodyInfo(c.body);
          b.role = c.memory.role; b.sourceId = c.memory.sourceId || null; b.ttl = c.ticksToLive || null;
          return b;
        })
      });
    });
    out.homes.push(home);
  });
  Memory._roi = JSON.stringify(out);
})()
""".strip()


def fetch():
    from probe import console, read_memory
    nonce = str(time.time_ns())
    expression = PROBE.replace('__NONCE__', nonce)
    chunks = [expression[i:i + 700] for i in range(0, len(expression), 700)]
    for index, chunk in enumerate(chunks):
        operator = '=' if index == 0 else '+='
        response = console('Memory._roiProbe' + operator + json.dumps(chunk))
        if response.get('error'):
            raise RuntimeError('探针分片提交失败: ' + response['error'])
    response = console('eval(Memory._roiProbe);delete Memory._roiProbe')
    if response.get('error'):
        raise RuntimeError('探针执行提交失败: ' + response['error'])
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(2)
        data = read_memory('_roi')
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except json.JSONDecodeError:
                data = None
        if isinstance(data, dict) and data.get('nonce') == nonce:
            return data
    raise RuntimeError('探针无新鲜响应（bot 未运行或 console 队列阻塞）')


def uptime(distance):
    return max(0.0, CREEP_LIFE - (distance or 0)) / CREEP_LIFE


def lifetime(creep):
    return CLAIM_LIFE if (creep.get('claim') or 0) > 0 or creep.get('role') == 'reserver' else CREEP_LIFE


def evaluate_roster(remote, roster, reserved, hauler_scale=1.0):
    """按一套编制（计划 demands 或在岗 alive）算账；reserved 决定源档位和容器修理档"""
    sources = remote.get('sources') or []
    by_source = {}
    for creep in roster or []:
        by_source.setdefault(creep.get('sourceId'), []).append(creep)
    gross = capacity = delivered = 0.0
    # 运输工往全账号路程最短的己方房卸货（remote.js record.drop，2026-09-06）：运力按到卸货房的距离算；矿工仍从母房走，在岗率按源距离
    haul_distance_override = remote.get('dropDistance') or None
    for source in sources:
        distance = source.get('distance') or 50
        haul_distance = haul_distance_override or distance
        miners = [c for c in by_source.get(source.get('id'), []) if c.get('role') == 'remoteMiner']
        haulers = [c for c in by_source.get(source.get('id'), []) if c.get('role') == 'remoteHauler']
        source_rate = (RESERVED_CAPACITY if reserved else UNRESERVED_CAPACITY) / SOURCE_REGEN
        work = sum(c.get('work') or 0 for c in miners)
        harvest = min(work * HARVEST_PER_WORK, source_rate) * uptime(distance)
        carry = sum(c.get('carry') or 0 for c in haulers)
        haul = carry * CARRY_CAPACITY / (2 * haul_distance + 4)
        gross += harvest
        capacity += haul
        if source.get('container'):
            delivered += min(harvest, haul)
    cost = {'remoteMiner': 0.0, 'reserver': 0.0, 'remoteHauler': 0.0}
    spawn_share = 0.0
    for creep in roster or []:
        role = creep.get('role')
        if role not in cost:
            continue
        life = lifetime(creep)
        scale = hauler_scale if role == 'remoteHauler' else 1.0
        cost[role] += (creep.get('cost') or 0) * scale / life
        spawn_share += (creep.get('parts') or 0) * 3 * scale / life
    containers = sum(1 for s in sources if s.get('container'))
    road_tiles = sum(s.get('roadTiles') or 0 for s in sources)
    repair = containers * (CONTAINER_REPAIR_RESERVED if reserved else CONTAINER_REPAIR_UNOWNED) + road_tiles * ROAD_REPAIR_PLAIN
    upkeep = sum(cost.values()) + repair
    net = delivered - upkeep
    setup = containers * CONTAINER_COST + road_tiles * ROAD_COST_PLAIN
    return {
        'gross': gross, 'capacity': capacity, 'delivered': delivered,
        'cost': cost, 'repair': repair, 'upkeep': upkeep, 'net': net,
        'roi': (net / upkeep) if upkeep > 0 else None,
        'payback': (setup / net) if net > 0 else None,
        'setup': setup, 'spawnShare': spawn_share,
        'creeps': len([c for c in roster or [] if c.get('role') in cost]),
    }


def evaluate_remote(remote, now, home_reserver=None):
    active = bool(remote.get('enabled')) and (remote.get('suspendedUntil') or 0) <= (now or 0)
    demands = remote.get('demands')
    alive = remote.get('alive') or []
    # 稳态账：预定够久时 remote.js 暂时不出 reserver 需求，但维持预定始终要一只，按母房当前容量的 reserver 身体补进计划
    if demands and home_reserver and (home_reserver.get('cost') or 0) > 0 and \
            not any(d.get('role') == 'reserver' for d in demands):
        demands = list(demands) + [dict(home_reserver, role='reserver', slot='reserver:steady', sourceId=None)]
    plan_reserved = any(d.get('role') == 'reserver' for d in demands or []) or (remote.get('reservation') or 0) > 0
    plan = evaluate_roster(remote, demands, reserved=True) if demands else None
    # 不预定对照：同一套编制去掉 reserver，源掉回 1500 档，hauler 只需一半
    no_reserve = evaluate_roster(remote, [d for d in demands or [] if d.get('role') != 'reserver'],
                                 reserved=False, hauler_scale=0.5) if demands else None
    actual = evaluate_roster(remote, alive, reserved=(remote.get('reservation') or 0) > 0 or
                             any(c.get('role') == 'reserver' for c in alive))
    return {
        'room': remote.get('room'), 'active': active, 'reason': remote.get('suspendReason'),
        'sources': len(remote.get('sources') or []),
        'containers': sum(1 for s in remote.get('sources') or [] if s.get('container')),
        'distances': [s.get('distance') for s in remote.get('sources') or []],
        'dropRoom': remote.get('dropRoom'), 'dropDistance': remote.get('dropDistance'),
        'reservation': remote.get('reservation') or 0,
        'planReserved': plan_reserved,
        'plan': plan, 'noReserve': no_reserve, 'actual': actual,
    }


def evaluate(data):
    now = data.get('t')
    homes = []
    for home in data.get('homes') or []:
        remotes = [evaluate_remote(remote, now, home.get('reserver')) for remote in home.get('remotes') or []]
        active = [r for r in remotes if r['active'] and r['plan']]
        plan_share = sum(r['plan']['spawnShare'] for r in active)
        plan_net = sum(r['plan']['net'] for r in active)
        homes.append({
            'name': home.get('name'), 'cap': home.get('cap'), 'remotes': remotes,
            'planNet': plan_net,
            'planUpkeep': sum(r['plan']['upkeep'] for r in active),
            'planSpawnShare': plan_share,
            # 一个 spawn 整个用来养外矿能换多少净收益：母房只有一个 spawn 时，spawn 时间比能量更稀缺
            'planNetPerSpawn': (plan_net / plan_share) if plan_share > 0 else None,
            'actualNet': sum(r['actual']['net'] for r in remotes if r['active']),
            'actualSpawnShare': sum(r['actual']['spawnShare'] for r in remotes if r['active']),
        })
    return {'t': now, 'homes': homes}


def fmt(value, digits=1):
    if value is None:
        return '-'
    return f'{value:.{digits}f}'


def print_report(report):
    print(f'tick {report.get("t")}  口径见文件头；成本按每 tick 摊平，spawn 占用 = 占一个 spawn 的份额')
    for home in report['homes']:
        print(f'{home["name"]} 容量 {home["cap"]}: 计划净收益 {fmt(home["planNet"])}/tick（维持 {fmt(home["planUpkeep"])}/tick，'
              f'spawn 占用 {fmt(home["planSpawnShare"] * 100, 0)}%，整个 spawn 折合 {fmt(home["planNetPerSpawn"])}/tick）；'
              f'在岗净收益 {fmt(home["actualNet"])}/tick（spawn 占用 {fmt(home["actualSpawnShare"] * 100, 0)}%）')
        ranked = sorted(home['remotes'], key=lambda r: -(r['plan']['net'] if r['plan'] else -1e9))
        for r in ranked:
            head = f'  {r["room"]:6} 源{r["sources"]} 容器{r["containers"]} 距{"/".join(str(d) for d in r["distances"])} 预定{r["reservation"]}'
            if r.get('dropRoom'):
                head += f' 卸{r["dropRoom"]}距{r["dropDistance"]}'
            if not r['active']:
                print(f'{head}  停用({r["reason"]})  在岗净 {fmt(r["actual"]["net"])}')
                continue
            plan = r['plan']
            if not plan:
                print(f'{head}  需求未知  在岗净 {fmt(r["actual"]["net"])}')
                continue
            cost = plan['cost']
            print(f'{head}  毛产 {fmt(plan["gross"])} 运力 {fmt(plan["capacity"])} 到家 {fmt(plan["delivered"])}  '
                  f'维持 {fmt(plan["upkeep"])}（矿 {fmt(cost["remoteMiner"])} res {fmt(cost["reserver"])} haul {fmt(cost["remoteHauler"])} 修 {fmt(plan["repair"])}）  '
                  f'净 {fmt(plan["net"])} ROI {fmt(plan["roi"])}x 回本 {fmt(plan["payback"], 0)}t spawn {fmt(plan["spawnShare"] * 100, 0)}%  '
                  f'不预定净 {fmt(r["noReserve"]["net"])}  在岗净 {fmt(r["actual"]["net"])}（{r["actual"]["creeps"]} 只）')


def main():
    parser = argparse.ArgumentParser(description='外矿 ROI')
    parser.add_argument('--json', help='把探针原始数据写到这个文件')
    parser.add_argument('--from', dest='source', help='用已保存的探针数据离线复算')
    args = parser.parse_args()
    if args.source:
        with open(args.source) as f:
            data = json.load(f)
    else:
        data = fetch()
        if args.json:
            with open(args.json, 'w') as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
    print_report(evaluate(data))


if __name__ == '__main__':
    main()
