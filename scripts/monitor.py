#!/usr/bin/env python3
DESCRIPTION = '定时监控 Screeps bot 发育状态。\n\n每轮：console 写探针取实时快照 + 读历史趋势，追加到 logs/status.jsonl；\n所有异常（运行时错误 / 武装敌人 / 关键角色缺失 / 工地停滞 / 升级回退 / CPU 紧急等）都并入\nlogs/monitor-incidents.json 的事件账本（scripts/monitor_health.py）。\n\n退出码：\n  0  本轮没有新增或升级的事件（账本里可能仍有长期未结、已知的事件，照样要读）\n  1  本轮有新增事件（首次出现或解决/撤销后复发）、首次升级为 escalated 的事件，\n     或尚未附调查证据的 urgent 事件\n  2  本轮没采到可靠结果（采集/分析失败、已有采集进程持锁），不是健康\n\n用法: python3 scripts/monitor.py\n'
import argparse
import json
import statistics
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from probe import read_memory, console
import monitor_health

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = os.path.join(ROOT, 'logs', 'status.jsonl')
LOG_MAX_BYTES = 8 * 1024 * 1024
LOG_KEEP_ENTRIES = 1000

THRESHOLDS = {
    'site_stall_ticks': 180,
    'rate_regression_ratio': 0.8,
    'spawn_idle_energy': 200,
    'missing_hauler_buffer': 100,
    'cpu_high_ratio': 0.9,
    'cpu_high_floor': 100,
    'brain_age_warn_min': 90,
    'brain_age_alert_min': 300,
    'cpu_bucket_ok': 2000,
    'cpu_tick_limit_ratio': 0.9,
    'bucket_low': 1000,
    'bucket_drop': 3000,
    'bucket_drop_ratio': 0.7,
    'ctrl_container_empty_ticks': 60,
    'spawn_queue_wait_ticks': 300,
    'remote_unstaffed_ticks': 300,
    'rate_window_ticks': 100,
}

PROBE = r"""
(function() {
  var roomMem = Memory.rooms || {};
  function structAt(room, pos, type) {
    if (!pos) return null;
    var list = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var i = 0; i < list.length; i++) {
      if (list[i].structureType === type) return list[i];
    }
    return null;
  }
  function chebyshev(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
  }
  function remoteDemands(room) {
    try { return require('remote').getDemands(room) || []; } catch (e) { return null; }
  }
  function siteWanted(room, site) {
    try { return require('utils').siteWanted(room, site); } catch (e) { return null; }
  }
  function slotFilled(home, item) {
    return _.some(Game.creeps, function(c) {
      var m = c.memory || {};
      if (m.home !== home || m.role !== item.role) return false;
      if (m.slotKey) return m.slotKey === item.slot;
      if (m.remoteRoom !== item.memory.remoteRoom) return false;
      if (item.memory.sourceId && m.sourceId !== item.memory.sourceId) return false;
      if (item.memory.haulSlot != null && m.haulSlot !== item.memory.haulSlot) return false;
      return true;
    });
  }
  function nearbyStruct(room, target, preferred, type) {
    var direct = structAt(room, preferred, type);
    if (direct) return direct;
    if (!target) return null;
    var list = room.find(FIND_STRUCTURES).filter(function(structure) {
      return structure.structureType === type && structure.pos && chebyshev(structure.pos, target) <= 1;
    });
    list.sort(function(left, right) {
      var leftDistance = chebyshev(left.pos, target);
      var rightDistance = chebyshev(right.pos, target);
      return leftDistance - rightDistance || left.pos.y - right.pos.y || left.pos.x - right.pos.x;
    });
    return list[0] || null;
  }
  function linkSpot(plan, key) {
    if (!plan || !plan.links) return null;
    if (key === 'src0') return plan.links.src0 || plan.links.src || null;
    return plan.links[key] || null;
  }
  function res(store, key) {
    if (!store) return 0;
    return store[key] || 0;
  }
  function sourceWorkTarget(source) {
    var capacity = Number(source && source.energyCapacity);
    if (!isFinite(capacity) || capacity <= 0) capacity = 3000;
    var regeneration = Number(source && source.regenerationTicks);
    if (!isFinite(regeneration) || regeneration <= 0) regeneration = 300;
    return Math.max(1, Math.min(15, Math.ceil(capacity / (regeneration * 2))));
  }
  function sourceAnchor(room, plan) {
    if (plan && plan.anchor) return plan.anchor;
    var spawns = room.find(FIND_MY_SPAWNS).slice().sort(function(a, b) {
      return a.pos.x - b.pos.x || a.pos.y - b.pos.y || String(a.id).localeCompare(String(b.id));
    });
    return spawns.length ? spawns[0].pos : { x: 25, y: 25 };
  }
  function orderedSources(room, mem, plan) {
    var anchor = sourceAnchor(room, plan);
    var fallback = room.find(FIND_SOURCES).slice().sort(function(a, b) {
      var ad = Math.pow(a.pos.x - anchor.x, 2) + Math.pow(a.pos.y - anchor.y, 2);
      var bd = Math.pow(b.pos.x - anchor.x, 2) + Math.pow(b.pos.y - anchor.y, 2);
      return ad - bd || a.pos.x - b.pos.x || a.pos.y - b.pos.y || String(a.id).localeCompare(String(b.id));
    });
    var visible = {};
    var ordered = [];
    var seen = {};
    for (var i = 0; i < fallback.length; i++) visible[fallback[i].id] = fallback[i];
    var memoryIds = Array.isArray(mem.sources) ? mem.sources : [];
    var planIds = plan && Array.isArray(plan.sourceIds) ? plan.sourceIds : [];
    var preferred = plan && plan.version && planIds.length ? [planIds, memoryIds] : [memoryIds, planIds];
    function addIds(ids) {
      for (var j = 0; j < ids.length; j++) {
        var id = ids[j];
        if (seen[id] || !visible[id]) continue;
        seen[id] = true;
        ordered.push(visible[id]);
      }
    }
    for (var p = 0; p < preferred.length; p++) addIds(preferred[p]);
    for (var k = 0; k < fallback.length; k++) {
      var source = fallback[k];
      if (seen[source.id]) continue;
      seen[source.id] = true;
      ordered.push(source);
    }
    return ordered;
  }
  function dangerousHostile(creep) {
    if (!creep || typeof creep.getActiveBodyparts !== 'function') return false;
    return creep.getActiveBodyparts(ATTACK) > 0 ||
      creep.getActiveBodyparts(RANGED_ATTACK) > 0 ||
      creep.getActiveBodyparts(HEAL) > 0 ||
      creep.getActiveBodyparts(WORK) > 0 ||
      creep.getActiveBodyparts(CLAIM) > 0;
  }
  var hostileRooms = _.reduce(Game.rooms, function(acc, r) {
    var n = _.filter(r.find(FIND_HOSTILE_CREEPS), dangerousHostile).length;
    if (n) acc[r.name] = n;
    return acc;
  }, {});
  var out = {
    schema: 4,
    username: (_.find(Game.spawns) || _.find(Game.creeps) || {owner:{}}).owner.username || null,
    nonce: '__MONITOR_NONCE__',
    t: Game.time,
    errN: (Memory.errors || []).length,
    errs: (Memory.errors || []).slice(0, 5).map(function(e) {
      return (e.where || '?') + ': ' + (e.msg || e);
    }),
    scriptV: Memory.SCRIPT_VERSION,
    roles: _.countBy(Game.creeps, function(c) { return c.memory.role || 'unknown'; }),
    creeps: _.map(Game.creeps, function(c) {
      return {
        name: c.name,
        id: c.id,
        energy: res(c.store, RESOURCE_ENERGY),
        claim: c.getActiveBodyparts(CLAIM),
        move: c.getActiveBodyparts(MOVE),
        bodyCost: _.sum(c.body, function(p) { return BODYPART_COST[p.type] || 0; }),
        ctrlRange: c.room && c.room.controller ? c.pos.getRangeTo(c.room.controller) : null,
        role: c.memory.role || 'unknown',
        home: c.memory.home || '',
        room: c.room ? c.room.name : null,
        sourceId: c.memory.sourceId || null,
        sourceIdx: c.memory.sourceIdx == null ? null : c.memory.sourceIdx,
        aid: c.memory.aid || null,
        remoteRoom: c.memory.remoteRoom || null,
        slotKey: c.memory.slotKey || null,
        pos: c.pos ? c.pos.x + ',' + c.pos.y : null,
        ttl: c.spawning ? null : c.ticksToLive,
        spawning: !!c.spawning,
        work: c.getActiveBodyparts ? c.getActiveBodyparts(WORK) : 0,
        carry: c.getActiveBodyparts ? c.getActiveBodyparts(CARRY) : 0
      };
    }),
    hostiles: _.sum(Game.rooms, function(r) {
      return r.find(FIND_HOSTILE_CREEPS).length;
    }),
    armedHostiles: _.sum(_.values(hostileRooms)),
    hostileRooms: hostileRooms,
    rooms: _.map(_.filter(Game.rooms, function(r) {
      return r.controller && r.controller.my;
    }), function(r) {
      var mem = roomMem[r.name] || {};
      var demands = remoteDemands(r);
      var plan = mem.plan || {};
      var sources = orderedSources(r, mem, plan);
      var spawns = r.find(FIND_MY_SPAWNS);
      var spawnBusy = _.filter(spawns, function(s) { return !!s.spawning; }).length;
      var roomHostiles = r.find(FIND_HOSTILE_CREEPS);
      var ctrlLink = structAt(r, linkSpot(plan, 'ctrl'), STRUCTURE_LINK);
      var storeLink = structAt(r, linkSpot(plan, 'store'), STRUCTURE_LINK);
      return {
        name: r.name,
        rcl: r.controller.level,
        prog: r.controller.progress,
        total: r.controller.progressTotal,
        ticksToDowngrade: r.controller.ticksToDowngrade,
        energy: r.energyAvailable,
        cap: r.energyCapacityAvailable,
        storage: r.storage ? res(r.storage.store, RESOURCE_ENERGY) : 0,
        terminal: r.terminal ? res(r.terminal.store, RESOURCE_ENERGY) : 0,
        defense: {
          hostiles: roomHostiles.length,
          armedHostiles: _.filter(roomHostiles, dangerousHostile).length,
          safeMode: r.controller.safeMode || 0,
          safeModeAvailable: r.controller.safeModeAvailable || 0,
          safeModeCooldown: r.controller.safeModeCooldown || 0
        },
        economy: {
          storageConsumerFallback: mem.storageConsumerFallback || 0,
          remoteEnergySalvaged: mem.remoteEnergySalvaged || null,
          remoteRoadBudget: mem.remoteRoadBudget || null,
          ledgerComplete: false
        },
        drops: _.map(r.find(FIND_DROPPED_RESOURCES).filter(function(d) { return d.resourceType === RESOURCE_ENERGY; }), function(d) {
          return { id: d.id, amount: d.amount, x: d.pos.x, y: d.pos.y };
        }),
        state: mem.state || null,
        industry: mem.industryState || null,
        plan: {
          version: plan.version || null,
          wheel: !!plan.wheel,
          adopted: mem.wheelLayout || null,
          error: mem.planError || null
        },
        layoutBlocked: mem.layoutBlocked || null,
        demolition: (mem.demolition || []).slice(0, 5),
        done: _.countBy(r.find(FIND_STRUCTURES), 'structureType'),
        spawns: _.map(spawns, function(s) {
          return {
            id: s.id,
            name: s.name,
            idle: !s.spawning,
            spawning: !!s.spawning,
            remainingTime: s.spawning ? s.spawning.remainingTime : 0,
            needTime: s.spawning ? s.spawning.needTime : 0,
            energy: res(s.store, RESOURCE_ENERGY)
          };
        }),
        spawnUtil: {
          total: spawns.length,
          busy: spawnBusy,
          idle: spawns.length - spawnBusy
        },
        sources: _.map(sources, function(src, idx) {
          var cpos = plan.containers && plan.containers['src' + idx];
          var lpos = linkSpot(plan, 'src' + idx);
          var container = nearbyStruct(r, src.pos, cpos, STRUCTURE_CONTAINER);
          var link = nearbyStruct(r, src.pos, lpos, STRUCTURE_LINK);
          var assignedWork = 0;
          _.map(Game.creeps, function(creep) {
            if (!creep.memory || creep.memory.home !== r.name || creep.memory.role !== 'harvester') return null;
            var sourceMatch = creep.memory.sourceId === src.id;
            if (!sourceMatch && creep.memory.sourceId == null && Number(creep.memory.sourceIdx) === idx) sourceMatch = true;
            if (!sourceMatch || creep.spawning) return null;
            return assignedWork += creep.getActiveBodyparts ? creep.getActiveBodyparts(WORK) : 0;
          });
          var workTarget = sourceWorkTarget(src);
          return {
            id: src.id,
            idx: idx,
            energy: src.energy,
            energyCapacity: src.energyCapacity || 3000,
            regenerationTicks: 300,
            ticksToRegeneration: src.ticksToRegeneration || 300,
            work: assignedWork,
            workTarget: workTarget,
            workDeficit: Math.max(0, workTarget - assignedWork),
            container: container ? {
              id: container.id,
              x: container.pos.x,
              y: container.pos.y,
              planned: !!cpos && cpos.x === container.pos.x && cpos.y === container.pos.y,
              energy: res(container.store, RESOURCE_ENERGY),
              free: container.store.getFreeCapacity ? container.store.getFreeCapacity(RESOURCE_ENERGY) : null
            } : null,
            link: (link && link.my) ? {
              id: link.id,
              x: link.pos.x,
              y: link.pos.y,
              planned: !!lpos && lpos.x === link.pos.x && lpos.y === link.pos.y,
              energy: res(link.store, RESOURCE_ENERGY),
              free: link.store.getFreeCapacity ? link.store.getFreeCapacity(RESOURCE_ENERGY) : null,
              cooldown: link.cooldown || 0
            } : null
          };
        }),
        links: {
          ctrl: (ctrlLink && ctrlLink.my) ? {
            id: ctrlLink.id,
            energy: res(ctrlLink.store, RESOURCE_ENERGY),
            free: ctrlLink.store.getFreeCapacity ? ctrlLink.store.getFreeCapacity(RESOURCE_ENERGY) : null,
            cooldown: ctrlLink.cooldown || 0
          } : null,
          store: (storeLink && storeLink.my) ? {
            id: storeLink.id,
            energy: res(storeLink.store, RESOURCE_ENERGY),
            free: storeLink.store.getFreeCapacity ? storeLink.store.getFreeCapacity(RESOURCE_ENERGY) : null,
            cooldown: storeLink.cooldown || 0
          } : null
        },
        upkeep: (function() {
          var ctrlContainer = structAt(r, plan.containers && plan.containers.ctrl, STRUCTURE_CONTAINER);
          var towers = _.filter(r.find(FIND_MY_STRUCTURES), function(s) { return s.structureType === STRUCTURE_TOWER; });
          var ramparts = _.filter(r.find(FIND_STRUCTURES), function(s) { return s.structureType === STRUCTURE_RAMPART; });
          var rampartTarget = null;
          try {
            var table = require('config').rampartTargetHits || {};
            if (table[r.controller.level] != null) rampartTarget = table[r.controller.level];
          } catch (e) { rampartTarget = null; }
          var ctrlFeed = null;
          try { ctrlFeed = require('task_broker').controllerFeedMode(r); } catch (e) { ctrlFeed = null; }
          return {
            ctrlFeed: ctrlFeed,
            ctrlContainer: ctrlContainer ? {
              x: ctrlContainer.pos.x,
              y: ctrlContainer.pos.y,
              energy: res(ctrlContainer.store, RESOURCE_ENERGY),
              free: ctrlContainer.store.getFreeCapacity ? ctrlContainer.store.getFreeCapacity(RESOURCE_ENERGY) : null
            } : null,
            towers: _.map(towers, function(t) {
              return {
                energy: res(t.store, RESOURCE_ENERGY),
                capacity: t.store.getCapacity ? t.store.getCapacity(RESOURCE_ENERGY) : null
              };
            }),
            ramparts: {
              count: ramparts.length,
              minHits: ramparts.length ? _.min(_.map(ramparts, 'hits')) : null,
              target: rampartTarget
            }
          };
        })(),
        roads: (function() {
          var planSet = {};
          var packed = plan.roads || {};
          Object.keys(packed).forEach(function(key) {
            if (typeof packed[key] !== 'string' || !packed[key]) return;
            var parts = String(key).split(':');
            if (parts[0] === 'remote' && parts[1] !== r.name) return;
            packed[key].split(';').forEach(function(point) { if (point) planSet[point] = true; });
          });
          var roads = _.filter(r.find(FIND_STRUCTURES), function(s) { return s.structureType === STRUCTURE_ROAD; });
          var onPlan = _.filter(roads, function(s) { return planSet[s.pos.x + '.' + s.pos.y]; });
          var ratioOf = function(list) {
            var best = null;
            _.forEach(list, function(s) {
              if (!s.hitsMax) return;
              var value = s.hits / s.hitsMax;
              if (best == null || value < best) best = value;
            });
            return best == null ? null : Math.round(best * 1000) / 1000;
          };
          return {
            count: roads.length,
            planCount: Object.keys(planSet).length,
            onPlan: onPlan.length,
            offPlan: roads.length - onPlan.length,
            minHits: roads.length ? _.min(_.map(roads, 'hits')) : null,
            minOnPlanHits: onPlan.length ? _.min(_.map(onPlan, 'hits')) : null,
            minRatio: ratioOf(roads),
            minOnPlanRatio: ratioOf(onPlan)
          };
        })(),
        upgrade: mem.upgradeBudget || null,
        upgradeHold: mem.upgradeHold ? { on: !!mem.upgradeHold.on, guard: !!mem.upgradeHold.guard, at: mem.upgradeHold.at } : null,
        upgraderLeg: mem.upgraderLeg || null,
        linkRelief: mem.linkRelief ? { at: mem.linkRelief.at, n: mem.linkRelief.n,
          x: mem.linkRelief.x, y: mem.linkRelief.y } : null,
        linkReliefInPlace: mem.linkReliefInPlace ? { at: mem.linkReliefInPlace.at, n: mem.linkReliefInPlace.n } : null,
        upgradeCompete: mem.upgradeSupply ? { at: mem.upgradeSupply.competeAt, why: mem.upgradeSupply.competeWhy, free: mem.upgradeSupply.capFree || null } : null,
        builderFeed: mem.builderFeed || null,
        outOfReachRepair: mem.outOfReachRepair || null,
        outOfReachBelowFloor: mem.outOfReachBelowFloor || null,
        sites: _.map(r.find(FIND_MY_CONSTRUCTION_SITES), function(s) {
          return {
            id: s.id || [s.structureType, s.pos.x, s.pos.y].join(':'),
            type: s.structureType,
            progress: s.progress,
            total: s.progressTotal,
            wanted: siteWanted(r, s),
            x: s.pos.x,
            y: s.pos.y
          };
        }),
        demand: mem.demand || null,
        spawnQueue: mem.spawnQueue || null,
        spawnWaiting: mem.spawnWaiting || null,
        defenseLog: mem.defenseLog || null,
        upgraderStuck: mem.upgraderStuck ? { at: mem.upgraderStuck.at, retire: mem.upgraderStuck.retire || 0, streak: mem.upgraderStuck.streak || 0,
          backoffs: mem.upgraderStuck.backoffs || 0, backoffUntil: mem.upgraderStuck.backoffUntil || 0, held: mem.upgraderStuck.held || 0 } : null,
        spawnStall: mem.spawnStallLog || null,
        brainDefense: (Memory.brain && Memory.brain.rooms && Memory.brain.rooms[r.name] && Memory.brain.rooms[r.name].defense) || null,
        remotes: _.map(mem.remotes || {}, function(x, roomName) {
          if (typeof x === 'string') x = { room: x };
          x = x || {};
          var remoteName = x.room || (typeof roomName === 'string' ? roomName : null);
          var roomDemands = demands ? _.filter(demands, function(d) { return d.memory && d.memory.remoteRoom === remoteName; }) : null;
          var want = { remoteMiner: 0, reserver: 0, remoteHauler: 0 };
          var have = { remoteMiner: 0, reserver: 0, remoteHauler: 0 };
          var missing = [];
          _.forEach(roomDemands || [], function(d) {
            want[d.role] = (want[d.role] || 0) + 1;
            if (!slotFilled(r.name, d)) missing.push(d.slot);
          });
          _.forEach(Game.creeps, function(c) {
            var m = c.memory || {};
            if (m.home === r.name && m.remoteRoom === remoteName && have[m.role] != null) have[m.role]++;
          });
          var visible = Game.rooms[remoteName];
          var controller = visible && visible.controller;
          var reservation = visible ? (controller && controller.reservation ? {
            username: controller.reservation.username, ticksToEnd: controller.reservation.ticksToEnd, seenAt: Game.time
          } : null) : x.reservation || null;
          var sourceCount = x.sourceCount;
          if (sourceCount == null) {
            if (Array.isArray(x.sources)) sourceCount = x.sources.length;
            else if (typeof x.sources === 'number') sourceCount = x.sources;
            else sourceCount = 0;
          }
          return {
            room: remoteName,
            visible: !!visible,
            owner: controller && controller.owner ? controller.owner.username : null,
            controllerDistance: x.controllerDistance || 0,
            controllerDistanceVersion: x.controllerDistanceVersion || 0,
            controllerDistanceIncomplete: !!x.controllerDistanceIncomplete,
            controllerDistanceAt: x.controllerDistanceAt || 0,
            drop: x.drop || null,
            routes: _.map(Array.isArray(x.sources) ? x.sources : [], function(source) {
              var c = source.containerId && Game.getObjectById(source.containerId);
              return { id: source.id, distance: source.distance || 0,
                version: source.distanceVersion || 0, incomplete: !!source.distanceIncomplete,
                at: source.distanceAt || 0, roadComplete: !!source.roadComplete,
                roadTiles: (source.road || '').split(';').filter(Boolean).length,
                containerEnergy: c ? res(c.store, RESOURCE_ENERGY) : null,
                containerFree: c ? c.store.getFreeCapacity(RESOURCE_ENERGY) : null };
            }),
            drops: visible ? _.map(visible.find(FIND_DROPPED_RESOURCES).filter(function(d) {
              return d.resourceType === RESOURCE_ENERGY;
            }), function(d) { return {id: d.id, amount: d.amount, x: d.pos.x, y: d.pos.y}; }) : null,
            enabled: x.enabled !== false,
            containers: Array.isArray(x.sources) ? _.filter(x.sources, function(src) { return src && src.containerId; }).length : 0,
            want: want,
            have: have,
            missing: missing,
            demandKnown: demands !== null,
            suspendedUntil: x.suspendedUntil || 0,
            suspendReason: x.suspendReason || null,
            sourceCount: sourceCount,
            infrastructureComplete: !!x.infrastructureComplete,
            lastSeen: x.lastSeen || 0,
            reservation: reservation ? {
              username: reservation.username || null,
              ticksToEnd: reservation.ticksToEnd || 0,
              seenAt: reservation.seenAt || 0
            } : null
          };
        })
      };
    }),
    taskBroker: Memory.taskBroker || null,
    brain: Memory.brain ? { issuedAt: Memory.brain.issuedAt || 0, ttlMs: Memory.brain.ttlMs || 0,
      stale: !!Memory.brain.stale, ackTick: (Memory.brain.ack && Memory.brain.ack.tick) || 0,
      rooms: Object.keys(Memory.brain.rooms || {}).length } : null,
    brainRetired: (function () { try { var b = require('config').brain; return !!(b && b.retired); } catch (e) { return null; } })(),
    px: Game.resources && typeof PIXEL !== 'undefined' ? Game.resources[PIXEL] : null,
    bucket: Game.cpu.bucket,
    cpu: Game.cpu.getUsed(),
    cpuLimit: Game.cpu.limit,
    tickLimit: Game.cpu.tickLimit,
    hardStop: Memory.cpuHardStop || null,
    pixelGate: Memory.pixelGate || null,
    statsTail: (Memory.stats || []).slice(-5)
  };
  Memory._mon = JSON.stringify(out);
})()
""".strip()


def chunk_expression(expression, limit=700):
    chunks = []
    current = ''
    escaped = 0
    for char in expression:
        cost = len(json.dumps(char)) - 2
        if current and escaped + cost > limit:
            chunks.append(current)
            current = ''
            escaped = 0
        current += char
        escaped += cost
    if current:
        chunks.append(current)
    return chunks


def snapshot():
    nonce = str(time.time_ns())
    expression = PROBE.replace('__MONITOR_NONCE__', nonce)
    probe_key = '_monProbe_' + nonce
    chunks = chunk_expression(expression)
    for index, chunk in enumerate(chunks):
        operator = '=' if index == 0 else '+='
        response = console('Memory.' + probe_key + operator + json.dumps(chunk))
        if response.get('error'):
            raise RuntimeError('探针分片提交失败: ' + response['error'])
    response = console('eval(Memory.' + probe_key + ');delete Memory.' + probe_key)
    if response.get('error'):
        raise RuntimeError('探针执行提交失败: ' + response['error'])

    deadline = time.time() + 20
    while time.time() < deadline:
        time.sleep(2)
        mon = read_memory('_mon')
        if isinstance(mon, str):
            try:
                mon = json.loads(mon)
            except json.JSONDecodeError:
                mon = None
        if isinstance(mon, dict) and mon.get('schema') == 4 and mon.get('nonce') == nonce:
            try:
                console('delete Memory._mon')
            except Exception:
                pass
            return mon
    raise RuntimeError('探针无新鲜响应（bot 未运行、console 队列阻塞或表达式执行失败）')


def load_history(n=24):
    if not os.path.exists(LOG):
        return []
    rows = []
    with open(LOG) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(row, dict) and isinstance(row.get('mon'), dict):
                rows.append(row)
    return rows[-n:]


def room_map(mon):
    return {room.get('name'): room for room in mon.get('rooms', []) if room.get('name')}


def room_creeps(mon, room_name):
    return [c for c in mon.get('creeps', []) if c.get('home') == room_name]


def aid_summary(creeps):
    parts = []
    for creep in creeps:
        if not creep.get('aid'):
            continue
        parts.append('%s→%s %s@%s %s ttl%s' % (creep.get('aid'), creep.get('home'), creep.get('role'), creep.get('room'),
                                              creep.get('pos') or '?', creep.get('ttl') if creep.get('ttl') is not None else 'spawning'))
    return ' | '.join(parts)


def role_counts(creeps, ready_only=False):
    counts = {}
    for creep in creeps:
        if ready_only and creep.get('spawning'):
            continue
        role = creep.get('role') or 'unknown'
        counts[role] = counts.get(role, 0) + 1
    return counts


def count_workers(creeps, require_carry=False):
    total = 0
    for creep in creeps:
        if creep.get('spawning'):
            continue
        if (creep.get('work') or 0) <= 0:
            continue
        if require_carry and (creep.get('carry') or 0) <= 0:
            continue
        total += 1
    return total


REMOTE_ROLE_TAGS = (('remoteMiner', 'm'), ('reserver', 'r'), ('remoteHauler', 'h'))


def remote_active(remote, now):
    if not isinstance(remote, dict) or not remote.get('enabled'):
        return False
    until = remote.get('suspendedUntil') or 0
    return not (isinstance(until, (int, float)) and isinstance(now, (int, float)) and until > now)


def remote_shortfall(remote, now):
    if not remote_active(remote, now):
        return []
    want = remote.get('want') if isinstance(remote.get('want'), dict) else {}
    have = remote.get('have') if isinstance(remote.get('have'), dict) else {}
    short = []
    for role in ('remoteMiner', 'reserver', 'remoteHauler'):
        wanted = want.get(role) or 0
        alive = have.get(role) or 0
        if wanted > 0 and alive < wanted:
            short.append(role)
    return short


def remote_staffing(room, prev_room, now, dt):
    remotes = room.get('remotes') if isinstance(room.get('remotes'), list) else []
    prev = {}
    for prev_remote in ((prev_room or {}).get('remotes') or []):
        if isinstance(prev_remote, dict) and prev_remote.get('room'):
            prev[prev_remote['room']] = prev_remote
    prev_now = now - dt if isinstance(now, (int, float)) and isinstance(dt, (int, float)) else None
    summary = []
    issues = []
    for remote in remotes:
        if not isinstance(remote, dict) or not remote.get('room'):
            continue
        short = remote_shortfall(remote, now)
        summary.append({
            'room': remote['room'],
            'active': remote_active(remote, now),
            'reason': remote.get('suspendReason'),
            'suspendedUntil': remote.get('suspendedUntil') or 0,
            'containers': remote.get('containers') or 0,
            'sourceCount': remote.get('sourceCount') or 0,
            'want': remote.get('want') if isinstance(remote.get('want'), dict) else {},
            'have': remote.get('have') if isinstance(remote.get('have'), dict) else {},
            'missing': remote.get('missing') if isinstance(remote.get('missing'), list) else [],
            'demandKnown': remote.get('demandKnown', True),
            'reservation': ((remote.get('reservation') or {}).get('ticksToEnd')
                            if isinstance(remote.get('reservation'), dict) else None),
            'short': short,
        })
        if not short or not isinstance(dt, (int, float)) or dt < THRESHOLDS['remote_unstaffed_ticks']:
            continue
        still = [role for role in short if role in remote_shortfall(prev.get(remote['room']), prev_now)]
        if still:
            want = remote.get('want') or {}
            have = remote.get('have') or {}
            detail = ', '.join(f'{role} {have.get(role, 0)}/{want.get(role, 0)}' for role in still)
            issues.append(f'外矿 {remote["room"]} 两次采样缺编（相隔 {dt} ticks）: {detail}')
    return {'remotes': summary, 'issues': issues}


def remote_text(remote):
    name = remote.get('room')
    if not remote.get('active'):
        reason = remote.get('reason') or '?'
        until = remote.get('suspendedUntil') or 0
        state = '停用' if not isinstance(until, (int, float)) or until >= 2 ** 52 or not remote.get('enabled', True) else '暂停'
        return f'{name} {state}({reason})'
    want = remote.get('want') or {}
    have = remote.get('have') or {}
    short = set(remote.get('short') or [])
    bits = [name]
    if remote.get('demandKnown') is False:
        bits.append('需求未知')
    for role, tag in REMOTE_ROLE_TAGS:
        bits.append(f'{tag}{have.get(role, 0)}/{want.get(role, 0)}' + ('!' if role in short else ''))
    reservation = remote.get('reservation')
    bits.append(f'预定{reservation if isinstance(reservation, (int, float)) else "-"}')
    return ' '.join(bits)


def critical_floors(room):
    state = room.get('state') or {}
    stable_harvesters = state.get('stableHarvesters')
    if not isinstance(stable_harvesters, int) or stable_harvesters <= 0:
        stable_harvesters = max(1, len(room.get('sources') or []) or 1)
    recovering = bool(state.get('recovering'))
    rcl = room.get('rcl') or 0
    hold = room.get('upgradeHold') if isinstance(room.get('upgradeHold'), dict) else {}
    held = bool(hold.get('on')) and not hold.get('guard')
    return {
        'harvester': max(1, stable_harvesters),
        'hauler': 1 if rcl >= 2 else 0,
        'upgrader': 0 if recovering or held else (1 if rcl >= 2 else 0),
    }


def source_buffer_energy(room):
    total = 0
    for src in room.get('sources', []):
        container = src.get('container') or {}
        link = src.get('link') or {}
        total += container.get('energy') or 0
        total += link.get('energy') or 0
    return total


def site_progress_map(room):
    sites = room.get('sites', [])
    if not isinstance(sites, list):
        return {}
    return {site.get('id'): site for site in sites if isinstance(site, dict) and site.get('id')}


def spawn_summary(room):
    util = room.get('spawnUtil') or {}
    total = util.get('total')
    busy = util.get('busy')
    idle = util.get('idle')
    if total is None:
        spawns = room.get('spawns', [])
        if isinstance(spawns, list) and spawns and isinstance(spawns[0], dict):
            total = len(spawns)
            busy = sum(1 for s in spawns if s.get('spawning'))
            idle = total - busy
        else:
            spawning = room.get('spawning', [])
            if isinstance(spawning, list):
                total = len(spawning)
                busy = sum(1 for s in spawning if s != 'idle')
                idle = total - busy
            else:
                total = 0
                busy = 0
                idle = 0
    ratio = (busy / total) if total else 0
    return {'total': total, 'busy': busy, 'idle': idle, 'ratio': ratio}


def room_rate(cur_room, prev_room, dt):
    if not prev_room or dt <= 0:
        return None
    if cur_room.get('rcl') != prev_room.get('rcl'):
        return None
    return ((cur_room.get('prog') or 0) - (prev_room.get('prog') or 0)) / dt


def historical_rates(history, room_name, rcl):
    rates = []
    prev_room = None
    prev_tick = None
    for row in history:
        mon = row.get('mon') or {}
        room = room_map(mon).get(room_name)
        if not room or room.get('rcl') != rcl:
            prev_room = None
            prev_tick = None
            continue
        tick = mon.get('t')
        if prev_room and isinstance(tick, int) and isinstance(prev_tick, int) and tick > prev_tick:
            rate = room_rate(room, prev_room, tick - prev_tick)
            if rate is not None:
                rates.append(rate)
        prev_room = room
        prev_tick = tick
    return rates


def previous_room(history, room_name):
    for row in reversed(history):
        mon = row.get('mon') or {}
        room = room_map(mon).get(room_name)
        if room:
            return mon, room
    return None, None


def task_broker_room(mon, room_name):
    broker = mon.get('taskBroker') or {}
    rooms = broker.get('rooms') or {}
    room = rooms.get(room_name)
    return room if isinstance(room, dict) else None


def trend_label(delta):
    if not isinstance(delta, (int, float)):
        return None
    if delta > 0:
        return 'up'
    if delta < 0:
        return 'down'
    return 'flat'


def task_broker_trend(mon, room_name, history):
    current = task_broker_room(mon, room_name)
    if not current:
        return None
    prev_mon = history[-1].get('mon') if history else {}
    previous = task_broker_room(prev_mon or {}, room_name) if prev_mon else None
    metrics = {}
    for key in ('backlog', 'acted', 'deferred', 'idle'):
        current_value = current.get(key)
        previous_value = previous.get(key) if previous else None
        delta = None
        if isinstance(current_value, (int, float)) and isinstance(previous_value, (int, float)):
            delta = current_value - previous_value
        metrics[key] = {
            'current': current_value,
            'previous': previous_value,
            'delta': delta,
            'trend': trend_label(delta),
        }
    return metrics


def issue(text, room=None):
    return f'{room} {text}' if room else text


def inferred_harvester_work(room):
    sources = room.get('sources')
    if not isinstance(sources, list) or not sources:
        return None
    actual = 0
    target = 0
    has_signal = False
    per_source = []
    for source in sources:
        if not isinstance(source, dict):
            continue
        work = source.get('work')
        work_target = source.get('workTarget')
        if isinstance(work, (int, float)):
            actual += work
            has_signal = True
        capacity = source.get('energyCapacity', 3000)
        regeneration = source.get('regenerationTicks', 300)
        if not isinstance(work_target, (int, float)):
            if not isinstance(capacity, (int, float)) or capacity <= 0:
                capacity = 3000
            if not isinstance(regeneration, (int, float)) or regeneration <= 0:
                regeneration = 300
            work_target = max(1, min(15, math.ceil(capacity / (regeneration * 2))))
        else:
            has_signal = True
        target += work_target
        per_source.append({
            'id': source.get('id'),
            'idx': source.get('idx'),
            'work': work if isinstance(work, (int, float)) else 0,
            'target': work_target,
            'deficit': max(0, work_target - (work if isinstance(work, (int, float)) else 0)),
        })
    if not has_signal:
        return None
    return {
        'actual': actual,
        'target': target,
        'deficit': max(0, target - actual),
        'bySource': per_source,
    }


def analyze_room(mon, room, history):
    name = room.get('name') or '?'
    prev_mon, prev_room = previous_room(history, name)
    dt = (mon.get('t') or 0) - ((prev_mon or {}).get('t') or (mon.get('t') or 0))
    creeps = room_creeps(mon, name)
    ready_roles = role_counts(creeps, ready_only=True)
    total_roles = role_counts(creeps, ready_only=False)
    floors = critical_floors(room)
    demand = room.get('demand') if isinstance(room.get('demand'), dict) else {}
    demand_targets = demand.get('targets') if isinstance(demand.get('targets'), dict) else {}
    demand_planned = demand.get('planned') if isinstance(demand.get('planned'), dict) else {}
    dynamic_deficits = []
    for role, target in demand_targets.items():
        if not isinstance(target, (int, float)) or target <= 0:
            continue
        planned = demand_planned.get(role)
        actual = total_roles.get(role, 0)
        if not isinstance(planned, (int, float)):
            planned = actual
        if target > max(planned, actual):
            dynamic_deficits.append(role)
    inferred_work = inferred_harvester_work(room)
    harvester_work_deficit = demand.get('harvesterWorkDeficit')
    if not isinstance(harvester_work_deficit, (int, float)) and inferred_work:
        harvester_work_deficit = inferred_work['deficit']
    state = room.get('state') or {}
    recovering = bool(state.get('recovering'))
    spawns = spawn_summary(room)
    comparable_version = mon.get('scriptV') == (prev_mon or {}).get('scriptV')
    rate = room_rate(room, prev_room, dt) if comparable_version else None
    task_broker = task_broker_trend(mon, name, history)
    site_stalls = []
    if prev_room and comparable_version and dt >= THRESHOLDS['site_stall_ticks']:
        prev_sites = site_progress_map(prev_room)
        current_sites = site_progress_map(room)
        comparable_stalls = []
        queue_activity = any(site_id not in current_sites for site_id in prev_sites)
        for site_id, site in current_sites.items():
            prev_site = prev_sites.get(site_id)
            if not prev_site:
                progress = site.get('progress')
                if isinstance(progress, (int, float)) and progress > 0:
                    queue_activity = True
                continue
            progress = site.get('progress')
            prev_progress = prev_site.get('progress')
            if not isinstance(progress, (int, float)) or not isinstance(prev_progress, (int, float)):
                continue
            if progress != prev_progress:
                queue_activity = True
            elif site.get('wanted') is not False and prev_site.get('wanted') is not False:
                comparable_stalls.append({
                    'id': site_id,
                    'type': site.get('type'),
                    'progress': progress,
                    'total': site.get('total'),
                })
        if comparable_stalls and not queue_activity:
            site_stalls = comparable_stalls

    issues = []
    defense = room.get('defense') or {}
    safe_mode = defense.get('safeMode') or 0
    safe_mode_available = defense.get('safeModeAvailable')
    safe_mode_cooldown = defense.get('safeModeCooldown') or 0
    room_armed_hostiles = defense.get('armedHostiles') or 0
    previous_defense = (prev_room or {}).get('defense') or {}

    if safe_mode > 0:
        if (previous_defense.get('safeMode') or 0) <= 0:
            issues.append(issue(f'safe mode 已激活: 剩余 {safe_mode} ticks', name))
        else:
            issues.append(issue(f'safe mode 仍处于激活状态: 剩余 {safe_mode} ticks', name))
    elif room_armed_hostiles > 0 and safe_mode_available == 0:
        issues.append(issue('武装入侵且 safe mode 已耗尽', name))
    elif room_armed_hostiles > 0 and safe_mode_cooldown > 0:
        issues.append(issue(f'武装入侵且 safe mode 冷却中: 剩余 {safe_mode_cooldown} ticks', name))

    ready_h = ready_roles.get('harvester', 0)
    ready_hauler = ready_roles.get('hauler', 0)
    total_h = total_roles.get('harvester', 0)

    bootstrapping = (spawns.get('total') or 0) == 0
    bootstrap = None
    if bootstrapping:
        spawn_site = next((site for site in room.get('sites') or [] if site.get('type') == 'spawn'), None)
        pioneers = sum(1 for creep in mon.get('creeps') or []
                       if creep.get('role') == 'pioneer' and (creep.get('room') == name or creep.get('targetRoom') == name))
        bootstrap = {
            'spawnSite': {'progress': spawn_site.get('progress'), 'total': spawn_site.get('total')} if spawn_site else None,
            'pioneers': pioneers,
        }

    if ready_h == 0 and not bootstrapping:
        issues.append(issue(f'零 harvester（ready=0, total={total_h}, energy={room.get("energy")}/{room.get("cap")}）', name))

    for role, floor in floors.items():
        if floor <= 0 or bootstrapping:
            continue
        if role == 'upgrader' and recovering:
            continue
        ready = ready_roles.get(role, 0)
        if ready < floor:
            issues.append(issue(f'关键角色低于 floor: {role} {ready}/{floor}', name))

    emergency_workers = count_workers(creeps, require_carry=True)
    work_workers = count_workers(creeps, require_carry=False)
    room_energy = room.get('energy') or 0
    if ready_h == 0 and room_energy < 200 and not bootstrapping:
        if 150 <= room_energy < 200 and ready_hauler == 0 and emergency_workers == 0:
            issues.append(issue(f'恢复风险: {room_energy} 能量区间无 hauler 且无 WORK+CARRY 应急工', name))
        elif room_energy < 150 and work_workers == 0:
            issues.append(issue(f'恢复风险: {room_energy} 能量且无任何可工作的 creep', name))

    buffered = source_buffer_energy(room)
    if not recovering and ready_h > 0 and ready_hauler == 0 and buffered >= THRESHOLDS['missing_hauler_buffer']:
        issues.append(issue(f'缺运输: 源侧缓存 {buffered} 能量但无 hauler', name))

    upkeep = room.get('upkeep') if isinstance(room.get('upkeep'), dict) else None
    ctrl_container = (upkeep or {}).get('ctrlContainer') if upkeep else None
    prev_ctrl_container = ((prev_room or {}).get('upkeep') or {}).get('ctrlContainer') if prev_room else None
    ctrl_feed = (upkeep or {}).get('ctrlFeed')
    if (ctrl_container and not ctrl_feed and
            ctrl_container.get('energy') == 0 and ready_hauler > 0 and not recovering and
            prev_ctrl_container and prev_ctrl_container.get('energy') == 0 and dt >= THRESHOLDS['ctrl_container_empty_ticks']):
        issues.append(issue(f'upgrader 供能容器两次采样为空（相隔 {dt} ticks，hauler 在岗 {ready_hauler}）', name))

    queue = room.get('spawnQueue') if isinstance(room.get('spawnQueue'), dict) else {}
    queue_waiting = queue.get('waiting') if isinstance(queue.get('waiting'), dict) else None
    if (queue_waiting and isinstance(queue_waiting.get('waited'), (int, float)) and
            queue_waiting['waited'] > THRESHOLDS['spawn_queue_wait_ticks']):
        issues.append(issue(f'spawn 队头 {queue_waiting.get("key")}（{queue_waiting.get("cost")}）已等 {queue_waiting["waited"]} ticks，挡住 {queue.get("blocked")} 条', name))

    remote_status = remote_staffing(room, prev_room, mon.get('t'), dt)
    for text in remote_status['issues']:
        issues.append(issue(text, name))

    if site_stalls:
        issues.append(issue(
            '工地停滞: ' + ', '.join(
                f'{s["type"]}#{s["id"]} {s["progress"]}/{s["total"]}' for s in site_stalls[:3]
            ),
            name,
        ))

    if rate is not None and not recovering and dt >= THRESHOLDS['rate_window_ticks']:
        prior_rates = [x for x in historical_rates([r for r in history if (r.get('mon') or {}).get('scriptV') == mon.get('scriptV')], name, room.get('rcl')) if x > 0]
        baseline = statistics.median(prior_rates[-6:]) if prior_rates else 0
        upgrade_info = room.get('upgrade') if isinstance(room.get('upgrade'), dict) else {}
        capped_work = upgrade_info.get('cap') if isinstance(upgrade_info.get('cap'), (int, float)) else None
        capped_ok = capped_work is not None and capped_work > 0 and rate >= capped_work * THRESHOLDS['rate_regression_ratio']
        hold_info = room.get('upgradeHold') if isinstance(room.get('upgradeHold'), dict) else {}
        held = bool(hold_info.get('on')) and not hold_info.get('guard')
        if baseline > 0 and rate < baseline * THRESHOLDS['rate_regression_ratio'] and not capped_ok and not held:
            issues.append(issue(f'升级速率回退: {rate:.2f} prog/tick < 基线 {baseline:.2f} 的 80%', name))

    spawned = queue.get('spawned')
    accepted = len(spawned) if queue.get('at') == mon.get('t') and isinstance(spawned, list) else 0
    idle_after_actions = max(0, spawns['idle'] - accepted)
    deficits = [role for role, floor in floors.items() if floor > 0 and ready_roles.get(role, 0) < floor and not (recovering and role == 'upgrader')]
    if idle_after_actions > 0 and deficits and room_energy >= THRESHOLDS['spawn_idle_energy']:
        issues.append(issue(f'spawn 空闲但仍缺员: idle={spawns["idle"]}/{spawns["total"]}, 缺 {",".join(deficits)}', name))
    room_capacity = room.get('cap') or 0
    if idle_after_actions > 0 and dynamic_deficits and room_energy >= max(THRESHOLDS['spawn_idle_energy'], room_capacity):
        issues.append(issue(
            f'spawn 空闲但动态目标未满足: idle={spawns["idle"]}/{spawns["total"]}, 缺 {",".join(dynamic_deficits)}',
            name,
        ))
    if idle_after_actions > 0 and isinstance(harvester_work_deficit, (int, float)) and harvester_work_deficit > 0 and room_energy >= THRESHOLDS['spawn_idle_energy']:
        issues.append(issue(
            f'spawn 空闲但采集 WORK 吞吐未达目标: deficit={harvester_work_deficit:g}',
            name,
        ))

    roads = room.get('roads') if isinstance(room.get('roads'), dict) else {}
    upgrade = room.get('upgrade') if isinstance(room.get('upgrade'), dict) else {}
    state_info = room.get('state') if isinstance(room.get('state'), dict) else {}
    builder_total = total_roles.get('builder', 0)
    out_of_reach = state_info.get('builderOutOfReach')
    repair_debt = state_info.get('builderRepairDebt')
    builder_target = state_info.get('builderTarget')
    deferred = room.get('outOfReachBelowFloor')
    deferred = deferred if isinstance(deferred, dict) else {}
    deferred_at = deferred.get('at')
    min_ratio = roads.get('minOnPlanRatio')
    small_debt_deferred = (
        builder_target == 0
        and isinstance(mon.get('t'), (int, float))
        and isinstance(deferred_at, (int, float))
        and 0 <= mon['t'] - deferred_at <= 30
        and isinstance(repair_debt, (int, float))
        and deferred.get('count') == out_of_reach
        and deferred.get('debt') == repair_debt
        and isinstance(min_ratio, (int, float)) and min_ratio >= 0.2
    )
    if isinstance(out_of_reach, (int, float)) and out_of_reach > 0 and builder_total <= 0 and not small_debt_deferred:
        issues.append(issue(
            f'射程外有 {out_of_reach:g} 处待修但没有 builder（塔够不着，只能靠 builder）', name))
    elif isinstance(builder_target, (int, float)) and builder_target > 0 and builder_total <= 0 and not recovering:
        issues.append(issue(f'builder 编制缺口: 目标 {builder_target:g} 只、在岗 0 只', name))
    if upgrade:
        work = upgrade.get('work')
        cap = upgrade.get('cap')
        duty = upgrade.get('duty')
        if isinstance(work, (int, float)) and isinstance(cap, (int, float)) \
                and work > cap and isinstance(duty, (int, float)) and duty >= 1:
            issues.append(issue(f'升级限流没生效: work={work:g} > cap={cap:g} 但 duty={duty:g}', name))
        compete = room.get('upgradeCompete') if isinstance(room.get('upgradeCompete'), dict) else {}
        compete_at = compete.get('at')
        sampled_at = upgrade.get('at')
        recent_compete = (isinstance(compete_at, (int, float)) and isinstance(sampled_at, (int, float))
                          and 0 <= sampled_at - compete_at < 300)
        if upgrade.get('low') and cap is None and recent_compete:
            issues.append(issue(f'能量吃紧且有竞争需求（{compete.get("why")}）却没有取能上限（upgradeBudget.cap 为空）', name))
    if isinstance(min_ratio, (int, float)) and min_ratio < 0.2 and not recovering:
        issues.append(issue(
            f'方案内的路掉到 {min_ratio * 100:.0f}%（< 20% 危急线，最低 {roads.get("minOnPlanHits")} 血、'
            f'射程外 {out_of_reach if out_of_reach is not None else "?"} 处待修）', name))

    stuck = room.get('upgraderStuck') if isinstance(room.get('upgraderStuck'), dict) else {}
    backoff_until = stuck.get('backoffUntil') or 0
    now = mon.get('t') or 0
    if isinstance(backoff_until, (int, float)) and backoff_until > now > 0:
        issues.append(issue(f'升级者卡死看门狗退避中（连续 {stuck.get("streak")} 次退役控制器零进度，到 tick {backoff_until}）：'
                            f'控制器可能被围死或站位全被占，需要人看', name))
    stall = room.get('spawnStall') if isinstance(room.get('spawnStall'), dict) else {}
    prev_stall = (prev_room or {}).get('spawnStall') if isinstance((prev_room or {}).get('spawnStall'), dict) else {}
    def stall_count(log, key):
        sub = log.get(key) if isinstance(log.get(key), dict) else {}
        return int(sub.get('n') or 0)

    if prev_room is not None and 'spawnStall' in prev_room:
        stall_new = int(stall.get('n') or 0) - int(prev_stall.get('n') or 0)
        if stall_new > 0:
            issues.append(issue(f'spawn 出生口全被占、让路没解决，已放开非口袋方向 +{stall_new}'
                                f'（{stall.get("spawn")} 的 {stall.get("name")} 等了 {stall.get("waited")} tick）', name))
        cannot = stall.get('cannotVacate') if isinstance(stall.get('cannotVacate'), dict) else {}
        cannot_new = stall_count(stall, 'cannotVacate') - stall_count(prev_stall, 'cannotVacate')
        if cannot_new > 0:
            issues.append(issue(f'spawn 出生口被没有 MOVE 的 creep 堵住、无法让路 +{cannot_new}'
                                f'（{cannot.get("spawn")}：{",".join(cannot.get("blockers") or [])}）', name))
        trapped = stall.get('trapped') if isinstance(stall.get('trapped'), dict) else {}
        trapped_new = stall_count(stall, 'trapped') - stall_count(prev_stall, 'trapped')
        if trapped_new > 0:
            issues.append(issue(f'出生口袋里困着的 creep 回收 +{trapped_new}（{trapped.get("name")} @ ({trapped.get("x")},{trapped.get("y")})）', name))
        born_pocket_new = int(stall.get('bornPocket') or 0) - int(prev_stall.get('bornPocket') or 0)
        if born_pocket_new > 0:
            born = stall.get('born') if isinstance(stall.get('born'), dict) else {}
            issues.append(issue(f'有 creep 孵进了出生口袋 +{born_pocket_new}（{born.get("name")} @ ({born.get("x")},{born.get("y")})），不该发生', name))

    defense_log = room.get('defenseLog') if isinstance(room.get('defenseLog'), dict) else {}
    prev_defense_log = (prev_room or {}).get('defenseLog') if isinstance((prev_room or {}).get('defenseLog'), dict) else {}
    lost = int(defense_log.get('losses') or 0) - int(prev_defense_log.get('losses') or 0)
    if prev_room is not None and lost > 0:
        last_loss = defense_log.get('lastLoss') or {}
        issues.append(issue(f'defender 阵亡 +{lost}（{last_loss.get("room")} @ tick {last_loss.get("at")}）', name))

    return {
        'name': name,
        'readyRoles': ready_roles,
        'totalRoles': total_roles,
        'criticalFloors': floors,
        'demand': demand,
        'spawnQueue': room.get('spawnQueue') if isinstance(room.get('spawnQueue'), dict) else None,
        'dynamicDeficits': dynamic_deficits,
        'harvesterWorkDeficit': harvester_work_deficit,
        'harvesterWork': inferred_work,
        'recovering': recovering,
        'spawn': spawns,
        'taskBroker': task_broker,
        'sourceBuffer': buffered,
        'upkeep': upkeep,
        'bootstrap': bootstrap,
        'rate': rate,
        'siteStalls': site_stalls,
        'roads': roads,
        'upgrade': upgrade,
        'builderFeed': room.get('builderFeed') if isinstance(room.get('builderFeed'), dict) else None,
        'outOfReachRepair': room.get('outOfReachRepair') if isinstance(room.get('outOfReachRepair'), dict) else None,
        'maintenance': {
            'builderTarget': builder_target,
            'builders': builder_total,
            'repairDebt': repair_debt,
            'outOfReach': out_of_reach,
        },
        'remoteCount': len(room.get('remotes', [])),
        'remotes': remote_status['remotes'],
        'defense': defense,
        'defenseLog': defense_log,
        'brainDefense': room.get('brainDefense') if isinstance(room.get('brainDefense'), dict) else {},
        'issues': issues,
    }


def deploy_info(mon, prev_mon):
    current = mon.get('scriptV')
    previous = (prev_mon or {}).get('scriptV')
    numeric = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v > 1e12
    info = {'scriptV': current, 'previous': previous,
            'builtAt': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(current / 1000)) if numeric(current) else None,
            'changed': previous is not None and current != previous,
            'regressed': numeric(current) and numeric(previous) and current < previous}
    return info


def analyze_snapshot(mon, history):
    issues = []
    room_analysis = []
    for room in mon.get('rooms', []):
        analysis = analyze_room(mon, room, history)
        room_analysis.append(analysis)
        issues.extend(analysis['issues'])

    prev_mon = history[-1].get('mon') if history else {}
    dt = (mon.get('t') or 0) - (prev_mon.get('t') or (mon.get('t') or 0))
    if mon.get('errN'):
        issues.append(f'Memory.errors {mon["errN"]} 条: {mon.get("errs")}')
    if mon.get('armedHostiles'):
        hostile_rooms = mon.get('hostileRooms') if isinstance(mon.get('hostileRooms'), dict) else {}
        where = '，所在: ' + ', '.join(f'{room}×{n}' for room, n in sorted(hostile_rooms.items())) if hostile_rooms else ''
        issues.append(f'{mon["armedHostiles"]} 武装敌方 creep 入侵（可见 hostile 总数 {mon.get("hostiles", 0)}）{where}')
    for room in mon.get('rooms', []):
        plan_info = room.get('plan')
        plan_error = plan_info.get('error') if plan_info else None
        if plan_error:
            issues.append(issue(f'轮子规划失败（{plan_error.get("retryAt")} 重试）: {plan_error.get("message")}', room.get('name')))
        elif plan_info is not None and not plan_info.get('wheel'):
            issues.append(issue('房间还没有轮子方案（等 bucket）', room.get('name')))
        blocked = room.get('layoutBlocked') or []
        if len(blocked) > 6:
            bits = ', '.join(f'{b.get("type")}@{b.get("x")},{b.get("y")}<-{b.get("by")}' for b in blocked[:6])
            issues.append(issue(f'方案位被旧建筑占住 {len(blocked)} 处（拆迁调度每 50 tick 拆 1 个）: {bits} …', room.get('name')))

    brain = mon.get('brain') if 'brain' in mon else False
    retired = mon.get('brainRetired') if 'brainRetired' in mon else None
    if retired is False:
        issues.append('config.brain.retired 被删掉或变成 false：冻结指令会过期，segment 90 可能整份覆盖 Memory.brain')
    if retired is not True:
        if brain is None:
            issues.append('外脑指令缺失：Memory.brain 为空（segment 90 从未写入或被清掉），外矿/占领全部退回自治')
        elif brain:
            issued_at = brain.get('issuedAt') or 0
            if issued_at > 0:
                age_min = max(0.0, (time.time() * 1000 - issued_at) / 60000)
                if age_min >= THRESHOLDS['brain_age_alert_min']:
                    issues.append(f'外脑已 {age_min:.0f} 分钟没写入（segment 90），接近 6 小时宽限：到期后外矿白名单退回自治')
                elif age_min >= THRESHOLDS['brain_age_warn_min']:
                    issues.append(f'外脑 {age_min:.0f} 分钟没写入（segment 90），launchd 定时可能停了')
            if brain.get('stale'):
                issues.append('外脑指令已过 ttl，正在 6 小时宽限内沿用（Memory.brain.stale）')

    cpu = mon.get('cpu') or 0
    cpu_limit = mon.get('cpuLimit') or 0
    tick_limit = mon.get('tickLimit') or 0
    bucket_now = mon.get('bucket')
    over_limit = bool(cpu_limit) and cpu > max(THRESHOLDS['cpu_high_floor'], cpu_limit * THRESHOLDS['cpu_high_ratio'])
    afforded = isinstance(bucket_now, (int, float)) and bucket_now >= THRESHOLDS['cpu_bucket_ok']
    near_tick_limit = bool(tick_limit) and cpu > tick_limit * THRESHOLDS['cpu_tick_limit_ratio']
    if over_limit and (not afforded or near_tick_limit):
        issues.append(f'CPU 用量过高: {cpu:.1f}/{cpu_limit}' + (f'（bucket {bucket_now}）' if not afforded else f'（逼近 tickLimit {tick_limit}）'))

    hard = mon.get('hardStop') if isinstance(mon.get('hardStop'), dict) else {}
    prev_hard = prev_mon.get('hardStop') if isinstance(prev_mon.get('hardStop'), dict) else {}
    hard_new = int(hard.get('n') or 0) - int(prev_hard.get('n') or 0)
    if 'hardStop' in prev_mon and hard_new > 0:
        issues.append(f'creep 循环越过 tickLimit 硬停 +{hard_new} 次（最近 tick {hard.get("at")} 少跑 {hard.get("cut")} 只）')

    bucket = mon.get('bucket')
    prev_bucket = prev_mon.get('bucket')
    pixels = mon.get('px')
    prev_pixels = prev_mon.get('px')
    pixel_generated = isinstance(pixels, (int, float)) and isinstance(prev_pixels, (int, float)) and pixels > prev_pixels
    if isinstance(bucket, (int, float)) and bucket < THRESHOLDS['bucket_low'] and not pixel_generated:
        issues.append(f'CPU bucket 偏低: {bucket}')
    if (
        isinstance(bucket, (int, float)) and isinstance(prev_bucket, (int, float)) and dt > 60 and
        bucket < prev_bucket - THRESHOLDS['bucket_drop'] and
        bucket < prev_bucket * THRESHOLDS['bucket_drop_ratio'] and not pixel_generated
    ):
        issues.append(f'CPU bucket 回退过快: {prev_bucket} → {bucket} ({dt} ticks)')

    deploy = deploy_info(mon, prev_mon)
    if deploy['regressed']:
        issues.append(f"线上版本比上一样本旧: {deploy['previous']} → {deploy['scriptV']}（构建于 {deploy['builtAt']}），核对是否有意回滚")
    elif mon.get('scriptV') is None and prev_mon.get('scriptV') is not None:
        issues.append('Memory.SCRIPT_VERSION 缺失：无法确认线上代码版本')

    return {
        'sampledAt': time.time(),
        'at': time.strftime('%Y-%m-%d %H:%M:%S'),
        'mon': mon,
        'deploy': deploy,
        'analysis': {'rooms': room_analysis, 'dt': dt},
        'issues': issues,
    }


def write_entry(entry):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    if os.path.getsize(LOG) <= LOG_MAX_BYTES:
        return
    with open(LOG) as f:
        lines = f.readlines()
    kept = []
    total = 0
    for line in reversed(lines[-LOG_KEEP_ENTRIES:]):
        size = len(line.encode('utf-8'))
        if kept and total + size > LOG_MAX_BYTES:
            break
        kept.append(line)
        total += size
    kept.reverse()
    temp_log = LOG + '.tmp'
    with open(temp_log, 'w') as f:
        f.writelines(kept)
    os.replace(temp_log, LOG)


def print_summary(entry):
    mon = entry['mon']
    cpu = mon.get('cpu')
    cpu_text = f'{cpu:.2f}' if isinstance(cpu, (int, float)) else 'n/a'
    print(f'[{entry["at"]}] tick {mon.get("t")} cpu={cpu_text}/{mon.get("cpuLimit")} bucket={mon.get("bucket")} 版本={mon.get("scriptV")}')
    deploy = entry.get('deploy') or {}
    if deploy.get('changed'):
        print(f'  部署: 版本 {deploy.get("previous")} → {deploy.get("scriptV")}（构建于 {deploy.get("builtAt")}；'
              '上传后要等一次 global reset 才生效，与上传时间对照）')
    for room, analysis in zip(mon.get('rooms', []), entry.get('analysis', {}).get('rooms', [])):
        sp = analysis.get('spawn', {})
        rate = analysis.get('rate')
        rate_text = f'{rate:.2f} prog/tick' if isinstance(rate, (int, float)) else 'n/a'
        broker = analysis.get('taskBroker') or {}
        broker_bits = []
        for key in ('backlog', 'acted', 'deferred', 'idle'):
            metric = broker.get(key) or {}
            current = metric.get('current')
            delta = metric.get('delta')
            if isinstance(current, (int, float)) and isinstance(delta, (int, float)):
                sign = '↑' if delta > 0 else '↓' if delta < 0 else '→'
                broker_bits.append(f'{key}={current}({sign}{abs(delta):g})')
            elif isinstance(current, (int, float)):
                broker_bits.append(f'{key}={current}')
        broker_text = f' broker {" ".join(broker_bits)}' if broker_bits else ''
        print(
            f'  {room["name"]} RCL{room["rcl"]} 进度 {room.get("prog")}/{room.get("total") or "max"} '
            f'能量 {room["energy"]}/{room["cap"]} 存储 {room.get("storage", 0)} '
            f'spawn {sp.get("busy", 0)}/{sp.get("total", 0)} busy rate={rate_text}'
            f'{broker_text} 远程 {sum(1 for remote in analysis.get("remotes") or [] if remote.get("active"))}/{analysis.get("remoteCount", 0)}'
        )
        maint = analysis.get('maintenance') or {}
        roads = analysis.get('roads') or {}
        upgrade = analysis.get('upgrade') or {}
        if maint or roads or upgrade:
            bits = []
            if maint:
                target_text = f'{maint.get("builderTarget")}' if isinstance(maint.get('builderTarget'), (int, float)) else '?'
                bits.append(f'builder {maint.get("builders", 0)}/{target_text}')
                if isinstance(maint.get('repairDebt'), (int, float)):
                    bits.append(f'维修债 {maint["repairDebt"]:g} 血/射程外 {maint.get("outOfReach", "?")} 处')
            if roads:
                ratio = roads.get('minOnPlanRatio')
                ratio_text = f'{ratio * 100:.0f}%' if isinstance(ratio, (int, float)) else 'n/a'
                bits.append(f'路 {roads.get("onPlan", "?")}内/{roads.get("offPlan", "?")}外 最低(方案内) {ratio_text}')
            if upgrade:
                duty = upgrade.get('duty')
                duty_text = f'{duty:g}' if isinstance(duty, (int, float)) else 'n/a'
                cap_text = upgrade.get('cap') if isinstance(upgrade.get('cap'), (int, float)) else '不限'
                bits.append(f'控制器 {upgrade.get("work", "?")}WORK/上限 {cap_text} duty={duty_text}')
            print('    维修: ' + ' '.join(bits))
        defense = room.get('defense') or {}
        if defense.get('safeMode'):
            print(
                f'    防御: hostile={defense.get("hostiles", 0)} armed={defense.get("armedHostiles", 0)} '
                f'safeMode={defense.get("safeMode")} available={defense.get("safeModeAvailable", 0)} '
                f'cooldown={defense.get("safeModeCooldown", 0)}'
            )
        elif defense.get('armedHostiles') or defense.get('safeModeAvailable') == 0:
            print(
                f'    防御: hostile={defense.get("hostiles", 0)} armed={defense.get("armedHostiles", 0)} '
                f'safeMode=0 available={defense.get("safeModeAvailable", 0)} '
                f'cooldown={defense.get("safeModeCooldown", 0)}'
            )
        defense_log = analysis.get('defenseLog') or {}
        brain_defense = analysis.get('brainDefense') or {}
        if defense_log or brain_defense:
            bits = [f'出兵={defense_log.get("spawned", 0)} 阵亡={defense_log.get("losses", 0)}']
            last_loss = defense_log.get('lastLoss') or {}
            if last_loss:
                bits.append(f'最近阵亡={last_loss.get("room")}@{last_loss.get("at")}')
            skipped = defense_log.get('skipped') or {}
            if skipped:
                bits.append(f'不出兵={skipped.get("room")}({skipped.get("reason")})@{skipped.get("at")}')
            if brain_defense:
                bits.append('指令=' + ','.join(
                    f'{room_name}:{order.get("action")}' + (f'×{order["squad"].get("count")}' if isinstance(order.get('squad'), dict) else '')
                    for room_name, order in sorted(brain_defense.items()) if isinstance(order, dict)))
            print('    出兵: ' + ' '.join(bits))
        if room.get('sources'):
            src_bits = []
            for src in room['sources']:
                container = src.get('container') or {}
                link = src.get('link') or {}
                c_energy = container.get('energy')
                l_energy = link.get('energy')
                c_pos = f'@{container.get("x")},{container.get("y")}' if container.get('x') is not None else ''
                l_pos = f'@{link.get("x")},{link.get("y")}' if link.get('x') is not None else ''
                c_drift = '!' if container and container.get('planned') is False else ''
                l_drift = '!' if link and link.get('planned') is False else ''
                work = src.get('work')
                work_target = src.get('workTarget')
                work_text = f' w={work}/{work_target}' if isinstance(work, (int, float)) and isinstance(work_target, (int, float)) else ''
                src_bits.append(f's{src.get("idx")} src={src.get("energy")} c={c_energy}{c_pos}{c_drift} l={l_energy}{l_pos}{l_drift}{work_text}')
            print('    源: ' + ' | '.join(src_bits))
        upkeep = analysis.get('upkeep') or room.get('upkeep') or {}
        if upkeep:
            bits = []
            ctrl_container = upkeep.get('ctrlContainer')
            if ctrl_container:
                energy = ctrl_container.get('energy')
                free = ctrl_container.get('free')
                capacity = energy + free if isinstance(energy, (int, float)) and isinstance(free, (int, float)) else '?'
                feed = upkeep.get('ctrlFeed')
                bits.append(f'ctrl容器={energy}/{capacity}' + (f'(供能={feed})' if feed else ''))
            towers = upkeep.get('towers') or []
            if towers:
                bits.append('tower=' + ','.join(f'{t.get("energy")}/{t.get("capacity")}' for t in towers))
            ramparts = upkeep.get('ramparts') or {}
            if ramparts.get('count'):
                bits.append(f'rampart={ramparts.get("minHits")}/{ramparts.get("target")}')
            if bits:
                print('    维护: ' + ' '.join(bits))
            plan_info = room.get('plan') or {}
            demo = room.get('demolition') or []
            plan_bits = f'方案={plan_info.get("version") or "无"}' + ('' if plan_info.get('wheel') else '(非轮子)')
            if plan_info.get('error'):
                plan_bits += f' 规划失败:{plan_info["error"].get("message")}'
            if demo:
                plan_bits += ' 拆迁:' + ' | '.join(f'{d.get("t")} {d.get("type")}@{d.get("x")},{d.get("y")} {d.get("reason")}' for d in demo[:3])
            print('    规划: ' + plan_bits)
        bootstrap = analysis.get('bootstrap')
        if bootstrap:
            site = bootstrap.get('spawnSite') or {}
            site_text = f"{site.get('progress')}/{site.get('total')}" if site else '未放置'
            print(f"    开荒中: spawn 工地 {site_text}，pioneer {bootstrap.get('pioneers', 0)}")
        if isinstance(room.get('sites'), list) and room['sites']:
            site_bits = [f'{s.get("type")}#{s.get("id")} {s.get("progress")}/{s.get("total")}'
                         + ('（经济策略暂缓）' if s.get('wanted') is False else '') for s in room['sites'][:4]]
            print('    工地: ' + ' ; '.join(site_bits))
        demand = analysis.get('demand') or {}
        if demand:
            targets = demand.get('targets') or {}
            planned = demand.get('planned') or {}
            target_bits = ','.join(f'{role}={targets[role]}' for role in sorted(targets))
            planned_bits = ','.join(f'{role}={planned[role]}' for role in sorted(planned))
            backlog = demand.get('builderBacklog')
            backlog_text = f' builderBacklog={backlog}' if isinstance(backlog, (int, float)) else ''
            work = demand.get('harvesterWork')
            work_target = demand.get('harvesterWorkTarget')
            if not isinstance(work, (int, float)) or not isinstance(work_target, (int, float)):
                inferred = analysis.get('harvesterWork') or {}
                work = inferred.get('actual')
                work_target = inferred.get('target')
            work_text = f' harvesterWork={work}/{work_target}' if isinstance(work, (int, float)) and isinstance(work_target, (int, float)) else ''
            static_sources = demand.get('harvesterStaticSources')
            static_text = f' staticSources={static_sources}' if isinstance(static_sources, (int, float)) else ''
            print(f'    目标 targets={target_bits} planned={planned_bits}{backlog_text}{work_text}{static_text}')
        queue = analysis.get('spawnQueue') or {}
        waiting = queue.get('waiting') if isinstance(queue.get('waiting'), dict) else None
        reserved = queue.get('reserved') if isinstance(queue.get('reserved'), list) else []
        if waiting or reserved:
            head = (f'队头 {waiting.get("key")} 成本 {waiting.get("cost")} 预计 {waiting.get("eta")} tick 已等 {waiting.get("waited")} tick 挡住 {queue.get("blocked")} 条'
                    if waiting else '队头无等待')
            reserve_text = f' 预留 {",".join(str(k) for k in reserved)}' if reserved else ''
            print(f'    队列: {head} 收入 {queue.get("income")}/tick{reserve_text}')
        remotes = analysis.get('remotes') or []
        if remotes:
            print('    外矿: ' + ' | '.join(remote_text(remote) for remote in remotes))
        print(f'    角色 ready={analysis.get("readyRoles")} total={analysis.get("totalRoles")} floor={analysis.get("criticalFloors")} recovering={analysis.get("recovering")}')
    print(f'  creeps: {mon.get("roles")}  hostiles: {mon.get("hostiles")} armed: {mon.get("armedHostiles")}  errors: {mon.get("errN")}')
    aid_line = aid_summary(mon.get('creeps') or [])
    if aid_line:
        print('  援建: ' + aid_line)
    for text in entry.get('issues', []):
        print('  ⚠ ' + text)


ALERT_LABELS = {'new': '新增', 'escalated': '升级', 'urgent': '紧急未认领'}


def main():
    parser = argparse.ArgumentParser(description=DESCRIPTION)
    parser.add_argument('--samples', type=int, default=1)
    parser.add_argument('--interval', type=float, default=60, help='seconds between samples')
    parser.add_argument('--no-ack', action='store_true',
                        help='leave pending alerts for the hourly heartbeat (used by the launchd cron run)')
    args = parser.parse_args()
    if not 1 <= args.samples <= 10 or args.interval < 0:
        parser.error('samples must be 1..10 and interval nonnegative')
    import fcntl
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(os.path.join(ROOT, 'logs', 'monitor.lock'), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('监控已有采集进程；本次未采集，不视为健康', file=sys.stderr)
            return 2
        ledger = os.path.join(ROOT, 'logs', 'monitor-incidents.json')
        pending = []
        for index in range(args.samples):
            if index:
                time.sleep(args.interval)
            history = load_history()
            try:
                mon = snapshot()
                entry = analyze_snapshot(mon, history)
                health = monitor_health.assess(mon, history)
                entry['health'] = health
                entry['issues'].extend(f"{f['scope']} [{f['rule']}] {f['message']}" for f in health['findings'])
                state = monitor_health.update_state(ledger, entry)
                entry['incidentSummary'] = state['summary']
                write_entry(entry)
                print_summary(entry)
                print('  监控覆盖:', health['coverage'])
                print('  事件闭环:', state['summary'])
                for alert in state['lastSample']['alerts']:
                    print(f"  ‼ 本轮{ALERT_LABELS.get(alert['reason'], alert['reason'])} {alert['key']}: {alert['message']}")
                pending = state.get('pendingAlerts') or []
            except Exception as exc:
                monitor_health.record_failure(ledger, str(exc))
                print('监控采集/分析失败（未知，不是健康）: ' + str(exc), file=sys.stderr)
                return 2
        for alert in pending:
            print(f"  ‼ 待确认{ALERT_LABELS.get(alert['reason'], alert['reason'])} {alert['key']}"
                  f" (tick {alert.get('firstTick')}–{alert.get('lastTick')}): {alert.get('message')}")
        if pending and not args.no_ack:
            monitor_health.ack_alerts(ledger)
            print(f'  已确认 {len(pending)} 条待确认告警')
        return 1 if pending else 0

if __name__ == '__main__':
    sys.exit(main())
