'use strict';
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

function isStaticBody(creep) {
    const limit = Number(config.harvesting && config.harvesting.mobileTicksPerTile) || 3;
    return bodyTicksPerTile(creep.body) > limit;
}

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
    const spotIn = (spot) => (spot ? { x: spot.x, y: spot.y, roomName: room.name } : null);
    const atSpot = (spot) => !!spot && creep.pos.roomName === spot.roomName && creep.pos.x === spot.x && creep.pos.y === spot.y;
    let workSpot = spotIn(configuredWorkValid ? configuredWorkSpot : container ? container.pos : link ? link.pos : containerSpot);
    if (!hasCarry && container) workSpot = spotIn(container.pos);
    if (creep.memory.dropMiner || !hasCarry) {
        if (container && workSpot && !atSpot(workSpot)) {
            movement.go(creep, workSpot, { range: 0, reusePath: 20 });
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
        if (workSpot && !atSpot(workSpot)) {
            movement.go(creep, workSpot, { range: 0, reusePath: 30 });
            if (creep.pos.isNearTo(src.pos)) creep.harvest(src);
            return;
        }
        if (containerNeedsRepair(container, creep)) {
            creep.repair(container);
            return;
        }
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
                    if (!(creep.memory.xferBatch >= amount)) creep.memory.xferBatch = amount;
                }
            }
        }
        if (!target && !container && site && creep.store[RESOURCE_ENERGY] >= Math.min(creep.store.getCapacity(RESOURCE_ENERGY) || 0, workOf(creep) * 5)) {
            creep.build(site);
            return;
        }
        const onContainer = container && creep.pos.x === container.pos.x && creep.pos.y === container.pos.y;
        if (freeAfter < harvestAmount && !onContainer) return;
        creep.harvest(src);
        return;
    }

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
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) < workOf(creep) * 2) creep.drop(RESOURCE_ENERGY);
        return;
    }

    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
    if (free === 0 || (src.energy <= 0 && creep.store[RESOURCE_ENERGY] > 0)) {
        const target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
        });
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, target, { reusePath: 15 });
        } else if (free === 0) {
            creep.drop(RESOURCE_ENERGY);
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
