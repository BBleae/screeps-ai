'use strict';
/** 静态矿工：站源旁容器上持续采掘；有 link 时喂 link；
 *  容器未建好时切换为"采满→送 spawn/ext"往返模式 */
const layout = require('layout');
const movement = require('movement');
const config = require('config');
const { findCached, bodyTicksPerTile, creepsHomeRole } = require('utils');

function chebyshev(left, right) {
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function linkNear(room, plan, idx, source) {
    const spot = layout.linkSpot(plan, idx === 1 ? 'src1' : 'src0');
    if (spot) {
        const planned = layout.structureAt(room, spot.x, spot.y, STRUCTURE_LINK);
        if (planned && planned.my) return planned;
    }
    if (!source || typeof room.find !== 'function') return null;
    const nearby = findCached(room, FIND_STRUCTURES).filter((structure) =>
        structure.structureType === STRUCTURE_LINK && structure.my && chebyshev(structure.pos, source.pos) <= 1);
    nearby.sort((left, right) => chebyshev(left.pos, source.pos) - chebyshev(right.pos, source.pos) ||
        left.pos.y - right.pos.y || left.pos.x - right.pos.x);
    return nearby[0] || null;
}

function workOf(creep) {
    return creep.body.filter((part) => part.type === WORK && part.hits !== 0).length;
}

/** 本 creep 的 WORK 少于同源另一只在房内的矿工，且那只已 ≥5 WORK ⇒ 本 creep 多余 */
function redundantSmallMiner(creep, room, src) {
    const mine = workOf(creep);
    if (mine >= 5) return false;
    for (const other of creepsHomeRole(room.name, 'harvester')) {
        if (other === creep) continue;
        if (other.memory.sourceId !== src.id || other.spawning || !other.room || other.room.name !== room.name) continue;
        if (workOf(other) >= 5 && workOf(other) > mine) return true;
    }
    return false;
}

function nearbyContainer(room, source, spot) {
    if (spot) {
        const planned = layout.structureAt(room, spot.x, spot.y, STRUCTURE_CONTAINER);
        if (planned) return planned;
    }
    if (!source || typeof room.find !== 'function') return null;
    const nearby = findCached(room, FIND_STRUCTURES).filter((structure) =>
        structure.structureType === STRUCTURE_CONTAINER && chebyshev(structure.pos, source.pos) <= 1);
    nearby.sort((left, right) => chebyshev(left.pos, source.pos) - chebyshev(right.pos, source.pos) ||
        left.pos.y - right.pos.y || left.pos.x - right.pos.x);
    return nearby[0] || null;
}

/** 源旁的容器工地：规划位优先，否则源 1 格内任意容器工地（矿工自建） */
function containerSiteNear(room, source, spot) {
    if (spot && typeof room.lookForAt === 'function') {
        const planned = (room.lookForAt(LOOK_CONSTRUCTION_SITES, spot.x, spot.y) || [])
            .find((site) => site.structureType === STRUCTURE_CONTAINER);
        if (planned) return planned;
    }
    if (!source || typeof room.find !== 'function') return null;
    return findCached(room, FIND_MY_CONSTRUCTION_SITES).find((site) =>
        site.structureType === STRUCTURE_CONTAINER && chebyshev(site.pos, source.pos) <= 1) || null;
}

function hasHauler(room) {
    return creepsHomeRole(room.name, 'hauler').some((other) => !other.spawning);
}

/** 静态身体：平地每格 > mobileTicksPerTile tick（5W1C1M = 6）——往返送 spawn 一趟 50 能量要上百 tick，不如原地落地/自建容器 */
function isStaticBody(creep) {
    const limit = Number(config.harvesting && config.harvesting.mobileTicksPerTile) || 3;
    return bodyTicksPerTile(creep.body) > limit;
}

/** 容器缺血 ≥ 一次 repair 能补的量（WORK × REPAIR_POWER 100）且身上有能量：这 tick 修容器 */
function containerNeedsRepair(container, creep) {
    if (!container || !(config.harvesting && config.harvesting.selfRepairContainer)) return false;
    if (container.hits == null || container.hitsMax == null) return false;
    const work = workOf(creep);
    if (work <= 0 || (creep.store[RESOURCE_ENERGY] || 0) < work) return false;
    return container.hitsMax - container.hits >= work * 100;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home)); return; }
    const mem = Memory.rooms[room.name] || {};
    const sources = layout.resolveSources(room, mem, mem.plan);
    let idx = creep.memory.sourceId ? sources.findIndex((source) => source.id === creep.memory.sourceId) : -1;
    if (idx < 0) idx = Math.max(0, Math.min(creep.memory.sourceIdx || 0, sources.length - 1));
    const src = sources[idx];
    if (!src) return;
    if (creep.memory.sourceId !== src.id) creep.memory.sourceId = src.id;
    if (creep.memory.sourceIdx !== idx) creep.memory.sourceIdx = idx;
    // 同一个源已有 ≥5 WORK 的更大矿工在房内（援建矿工到位）：小矿工退役让出容器位，别占着工位让大矿工干等
    if (redundantSmallMiner(creep, room, src)) { creep.suicide(); return; }
    const plan = mem.plan || {};
    const key = 'src' + idx;
    const containerSpot = plan.containers && plan.containers[key];
    const container = nearbyContainer(room, src, containerSpot);
    const configuredWorkSpot = plan.workPositions && plan.workPositions[key];
    const configuredWorkValid = configuredWorkSpot && chebyshev(configuredWorkSpot, src.pos) <= 1 &&
        (!container || chebyshev(configuredWorkSpot, container.pos) <= 1);
    const link = linkNear(room, plan, idx, src);
    const hasCarry = creep.body.some((part) => part.type === 'carry' && part.hits !== 0);
    // 工位必须带 roomName：援建矿工出生在母房，不带房间的 {x,y} 会被解析成当前房间的同名坐标，走到那里就"以为到位"
    const spotIn = (spot) => (spot ? { x: spot.x, y: spot.y, roomName: room.name } : null);
    const atSpot = (spot) => !!spot && creep.pos.roomName === spot.roomName && creep.pos.x === spot.x && creep.pos.y === spot.y;
    let workSpot = spotIn(configuredWorkValid ? configuredWorkSpot : container ? container.pos : link ? link.pos : containerSpot);
    if (!hasCarry && container) workSpot = spotIn(container.pos);
    if (creep.memory.dropMiner || !hasCarry) {
        if (container && workSpot && !atSpot(workSpot)) {
            movement.go(creep, workSpot, { range: 0, reusePath: 20 });
            // 工位被占时挨着源就先采：能量落地由 hauler 捡，比干等强
            if (creep.pos.isNearTo(src.pos)) creep.harvest(src);
            return;
        }
        if (creep.pos.isNearTo(src.pos)) {
            creep.harvest(src);
            if (!container && creep.store[RESOURCE_ENERGY] > 0) creep.drop(RESOURCE_ENERGY);
        } else {
            movement.go(creep, src, { reusePath: 20 });
        }
        return;
    }

    const site = containerSiteNear(room, src, containerSpot);
    if (container || (link && workSpot)) {
        // 静态采掘模式
        if (workSpot && !atSpot(workSpot)) {
            movement.go(creep, workSpot, { range: 0, reusePath: 30 });
            if (creep.pos.isNearTo(src.pos)) creep.harvest(src);
            return;
        }
        // 容器缺血：这 tick 用身上的能量修（repair 与 harvest 同管线，只能二选一；transfer 会和 repair 抢同一份能量，一起跳过）
        if (containerNeedsRepair(container, creep)) {
            creep.repair(container);
            return;
        }
        // CARRY 与 WORK intent 可并行（引擎先处理 transfer 再处理 harvest）。攒批交货：仓里还放得下 transferBatchHarvests 次采集就不交，
        // 每个 intent 约 0.2 CPU，5W1C 从每 tick 交 10 变成每 4 tick 交 40（线上 2026-10-08：26 个源矿工每 tick 一次 transfer ≈ 5 CPU）
        const harvestAmount = workOf(creep) * (Number(config.harvesting && config.harvesting.harvestPower) || 2);
        const batch = Math.max(1, Number(config.harvesting && config.harvesting.transferBatchHarvests) || 1);
        let freeAfter = creep.store.getFreeCapacity(RESOURCE_ENERGY);
        let target = null;
        if (creep.store[RESOURCE_ENERGY] > 0) {
            if (link && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) target = link;
            else if (container && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) target = container;
            if (target && freeAfter < harvestAmount * batch) {
                const amount = Math.min(creep.store[RESOURCE_ENERGY], target.store.getFreeCapacity(RESOURCE_ENERGY));
                if (amount > 0 && creep.transfer(target, RESOURCE_ENERGY, amount) === OK) {
                    freeAfter += amount;
                    // 遥测：生涯最大单次交货量（私服生效断言 harvester.batchTransfer 看它）。记最大值而非最近一次：
                    // link/容器装满时一次只能塞进剩余空位（私服 2026-10-08 终态 link 800/800 时最后一次只交 13），最近值反映的是 sink 余量不是攒批；
                    // 只在变大时写，Memory 也不用每批都改
                    if (!(creep.memory.xferBatch >= amount)) creep.memory.xferBatch = amount;
                }
            }
        }
        // link 满了又没有容器：手上的能量拿去建容器工地，否则只能落地（线上 W33S7 源 (14,6)：link 785/800、容器工地 462/5000、地上一堆）
        if (!target && !container && site && creep.store[RESOURCE_ENERGY] >= Math.min(creep.store.getCapacity(RESOURCE_ENERGY) || 0, workOf(creep) * 5)) {
            creep.build(site);
            return;
        }
        // 交完仍装不下这次采集、脚下又不是容器（只有 link 的工位，link 满了）：溢出会落地，宁可这 tick 不采，等 link 送走再继续
        const onContainer = container && creep.pos.x === container.pos.x && creep.pos.y === container.pos.y;
        if (freeAfter < harvestAmount && !onContainer) return;
        creep.harvest(src);
        return;
    }

    // 容器还没建成：静态身体（或房里已有 hauler 的机动身体）站到容器规划位，用自己采的能量把容器工地建起来；
    // 没有工地就原地采、满了落地等 hauler 捡。往返送 spawn 只留给 bootstrap 期没有 hauler 的机动身体
    const staticBody = isStaticBody(creep);
    if (site && (staticBody || hasHauler(room))) {
        const buildSpot = spotIn(configuredWorkValid ? configuredWorkSpot : site.pos);
        if (buildSpot && !atSpot(buildSpot) && !creep.pos.isNearTo(src.pos)) {
            movement.go(creep, buildSpot, { range: 0, reusePath: 20 });
            return;
        }
        if (buildSpot && !atSpot(buildSpot)) movement.go(creep, buildSpot, { range: 0, reusePath: 20 });
        const work = workOf(creep);
        const capacity = creep.store.getCapacity(RESOURCE_ENERGY) || 0;
        // build 与 harvest 同管线：攒够一次 build 的量（WORK × 5，最多一仓）再建，其余 tick 采集
        if (creep.store[RESOURCE_ENERGY] >= Math.min(capacity, work * 5)) creep.build(site);
        else creep.harvest(src);
        return;
    }
    if (staticBody) {
        if (workSpot && !atSpot(workSpot)) {
            movement.go(creep, workSpot, { range: 0, reusePath: 20 });
            if (creep.pos.isNearTo(src.pos)) creep.harvest(src);
            return;
        }
        if (!creep.pos.isNearTo(src.pos)) { movement.go(creep, src, { reusePath: 20 }); return; }
        creep.harvest(src);
        // 仓快满就落地（drop 与 harvest 不同管线，同 tick 都生效）：能量堆由 hauler/builder 捡，比 1 MOVE 拖着 50 能量走 100 tick 强
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) < workOf(creep) * 2) creep.drop(RESOURCE_ENERGY);
        return;
    }

    // 往返模式（容器建成前）
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
    if (free === 0 || (src.energy <= 0 && creep.store[RESOURCE_ENERGY] > 0)) {
        const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
        });
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, target, { reusePath: 15 });
        } else if (free === 0) {
            creep.drop(RESOURCE_ENERGY); // 哪都放不下就丢地上，别堵在源边
        }
        return;
    }
    if (creep.pos.isNearTo(src.pos)) {
        creep.harvest(src);
    } else {
        movement.go(creep, src, { reusePath: 15 });
    }
}

module.exports = { run };
