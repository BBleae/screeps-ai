'use strict';
const config = require('config');
const layout = require('layout');
const movement = require('movement');
const taskBroker = require('task_broker');
const { findCached, logErr, needsRepair, criticallyDamaged, energySurplus, creepsHomeRole, compareRepairTargets, isRetiring, spawnWaitingFor, siteWanted, conserving } = require('utils');

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const fallbackBudgetState = runtimeGlobal.__roleEnergyFallbackBudget ||
    (runtimeGlobal.__roleEnergyFallbackBudget = { tick: -1, rooms: {} });

function damagedStructure(room) {
    const usable = findCached(room, FIND_STRUCTURES).filter((s) => needsRepair(room, s));
    return usable.length ? usable.sort((a, b) => compareRepairTargets(room, a, b))[0] : null;
}

const criticalCache = { time: -1, rooms: {} };
function criticalList(room) {
    if (criticalCache.time !== Game.time) { criticalCache.time = Game.time; criticalCache.rooms = {}; }
    if (criticalCache.rooms[room.name] !== undefined) return criticalCache.rooms[room.name];
    const list = findCached(room, FIND_STRUCTURES).filter((s) => criticallyDamaged(room, s));
    criticalCache.rooms[room.name] = list;
    return list;
}

function linkDrawMargin() {
    return Math.max(100, Number(config.linkDrawMargin) || 250);
}

function spawnHungry(room) {
    const hungry = spawnWaitingFor(room);
    if (hungry) {
        const mem = Memory.rooms[room.name];
        if (mem && (!mem.builderHunger || mem.builderHunger.at !== Game.time)) {
            mem.builderHunger = { at: Game.time, n: (Number(mem.builderHunger && mem.builderHunger.n) || 0) + 1 };
        }
    }
    return hungry;
}

function spawnShortfall(room) {
    const waiting = (Memory.rooms[room.name] || {}).spawnWaiting;
    return waiting && waiting.cost > 0 ? Math.max(0, waiting.cost - room.energyAvailable) : 0;
}

function energySourceFor(creep, room, ctrlShare) {
    const linkKeep = Math.max(0, Number(config.linkKeepAt) || 0) + linkDrawMargin();
    const hungry = spawnHungry(room);
    const shortfall = hungry ? spawnShortfall(room) : 0;
    const overflowAt = Math.max(0, Number((config.hauling || {}).sourceLinkOverflow) || 1500);
    const candidates = findCached(room, FIND_STRUCTURES).filter((s) => {
        if (!s || !s.store || s.my === false) return false;
        const energy = Number(s.store[RESOURCE_ENERGY] || 0);
        if (energy < 50) return false;
        if (s.structureType === STRUCTURE_CONTAINER) {
            if (isControllerContainer(room, s)) return energy >= s.store.getCapacity(RESOURCE_ENERGY) * ctrlShare;
            return !hungry || energy >= overflowAt;
        }
        if (s.structureType === STRUCTURE_STORAGE) return !hungry || energy - shortfall >= 50;
        if (s.structureType === STRUCTURE_LINK) {
            if (hungry) return false;
            const plan = (Memory.rooms[room.name] || {}).plan;
            if (!plan || !plan.links) return false;
            const spot = layout.linkSpot(plan, 'ctrl') || {};
            const storeSpot = layout.linkSpot(plan, 'store') || {};
            const isReceiver = (s.pos.x === spot.x && s.pos.y === spot.y) || (s.pos.x === storeSpot.x && s.pos.y === storeSpot.y);
            return isReceiver && energy >= linkKeep;
        }
        return false;
    });
    return creep.pos.findClosestByPath(candidates) || null;
}

function isControllerContainer(room, structure) {
    if (!structure || structure.structureType !== STRUCTURE_CONTAINER) return false;
    const plan = (Memory.rooms[room.name] || {}).plan;
    const planned = plan && plan.containers && plan.containers.ctrl;
    if (planned) return structure.pos.x === planned.x && structure.pos.y === planned.y;
    if (!room.controller || !structure.pos.inRangeTo(room.controller.pos, 2)) return false;
    return !findCached(room, FIND_SOURCES).some((source) =>
        Math.max(Math.abs(source.pos.x - structure.pos.x), Math.abs(source.pos.y - structure.pos.y)) <= 1);
}

function criticalNear(creep, room) {
    const list = criticalList(room);
    if (!list.length) return null;
    let here = null;
    for (const structure of list) {
        if (!creep.pos.inRangeTo(structure.pos, 3)) continue;
        if (!here || compareRepairTargets(room, structure, here) < 0) here = structure;
    }
    if (here) return here;
    return list.slice().sort((a, b) => compareRepairTargets(room, a, b))[0];
}

function repairHold(creep, room) {
    const id = creep.memory.repairId;
    if (!id) return null;
    const target = Game.getObjectById(id);
    const line = Number(config.towerRepairBelow) || 0.6;
    if (!target || !target.pos || target.pos.roomName !== room.name || target.structureType === STRUCTURE_RAMPART ||
        target.structureType === STRUCTURE_WALL || !(target.hits < target.hitsMax * line)) {
        delete creep.memory.repairId;
        return null;
    }
    if (!criticallyDamaged(room, target)) {
        const mem = Memory.rooms[room.name];
        if (mem && (!mem.builderRepairHold || mem.builderRepairHold.at !== Game.time)) {
            mem.builderRepairHold = { at: Game.time, n: (Number(mem.builderRepairHold && mem.builderRepairHold.n) || 0) + 1, id: target.id };
        }
    }
    return target;
}

function samePosition(left, right) {
    return !!left && !!right && left.x === right.x && left.y === right.y;
}

function sitePriority(room, site) {
    const plan = (Memory.rooms[room.name] || {}).plan || {};
    const containers = plan.containers || {};
    if (site.structureType === STRUCTURE_SPAWN) return -1;
    if (site.structureType === STRUCTURE_TOWER) return room.energyCapacityAvailable >= 550 ? 0 : 10;
    if (site.structureType === STRUCTURE_CONTAINER) {
        if (samePosition(site.pos, containers.src0) || samePosition(site.pos, containers.src1)) return 1;
        if (samePosition(site.pos, containers.ctrl)) return 2;
        return 3;
    }
    if (site.structureType === STRUCTURE_LINK) return 1.5;
    if (site.structureType === STRUCTURE_EXTENSION && room.energyCapacityAvailable < 550) return 4;
    if (site.structureType === STRUCTURE_STORAGE && !room.storage && (config.construction || {}).storageBeforeRoads !== false) return 4.5;
    if (site.structureType === STRUCTURE_ROAD) return 5;
    if (site.structureType === STRUCTURE_RAMPART || site.structureType === STRUCTURE_WALL) return 20;
    return 10;
}

function nextSite(room) {
    return findCached(room, FIND_MY_CONSTRUCTION_SITES).filter((site) => siteWanted(room, site)).sort((left, right) => {
        const priority = sitePriority(room, left) - sitePriority(room, right);
        if (priority !== 0) return priority;
        return (left.progressTotal - left.progress) - (right.progressTotal - right.progress);
    })[0];
}

function withdrawRoomSurplus(creep, room, state) {
    if (state.recovering) return false;
    if (spawnHungry(room)) return false;
    if (fallbackBudgetState.tick !== Game.time) {
        fallbackBudgetState.tick = Game.time;
        fallbackBudgetState.rooms = {};
    }
    if (fallbackBudgetState.rooms[room.name] == null) {
        const reserve = Math.min(room.energyCapacityAvailable,
            config.recovery && config.recovery.emergencyHarvestBelow || 200);
        fallbackBudgetState.rooms[room.name] = Math.max(0, room.energyAvailable - reserve);
    }
    const amount = Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), fallbackBudgetState.rooms[room.name]);
    if (amount <= 0) return false;
    const source = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (structure) => (structure.structureType === STRUCTURE_SPAWN ||
            structure.structureType === STRUCTURE_EXTENSION) && structure.store[RESOURCE_ENERGY] > 0,
    });
    if (!source) return false;
    const withdrawal = Math.min(amount, source.store[RESOURCE_ENERGY]);
    fallbackBudgetState.rooms[room.name] -= withdrawal;
    const result = creep.withdraw(source, RESOURCE_ENERGY,
        withdrawal);
    if (result === ERR_NOT_IN_RANGE) movement.go(creep, source, { reusePath: 15 });
    return result === OK || result === ERR_NOT_IN_RANGE;
}

function harvestForSite(creep, room, site) {
    if (!site || !creep.body.some((part) => part.type === WORK && part.hits !== 0)) return false;
    const sources = room.find(FIND_SOURCES).slice().sort((left, right) => {
        const leftFromCreep = Math.max(Math.abs(left.pos.x - creep.pos.x), Math.abs(left.pos.y - creep.pos.y));
        const rightFromCreep = Math.max(Math.abs(right.pos.x - creep.pos.x), Math.abs(right.pos.y - creep.pos.y));
        if (leftFromCreep !== rightFromCreep) return leftFromCreep - rightFromCreep;
        const leftFromSite = Math.max(Math.abs(left.pos.x - site.pos.x), Math.abs(left.pos.y - site.pos.y));
        const rightFromSite = Math.max(Math.abs(right.pos.x - site.pos.x), Math.abs(right.pos.y - site.pos.y));
        return leftFromSite - rightFromSite;
    });
    const source = sources.find((candidate) => candidate.energy > 0) || sources[0];
    if (!source) return false;
    if (creep.pos.isNearTo(source.pos)) creep.harvest(source);
    else movement.go(creep, source, { reusePath: 15 });
    return true;
}

function hasHauler(room) {
    return creepsHomeRole(room.name, 'hauler').length > 0;
}

function noteFeed(room, key) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!mem) return;
    const track = mem.builderFeed || (mem.builderFeed = { at: 0, wait: 0, self: 0 });
    track.at = Game.time;
    track[key] = (Number(track[key]) || 0) + 1;
}

function haulerIncoming(creep, room) {
    for (const hauler of creepsHomeRole(room.name, 'hauler')) {
        if (hauler.spawning) continue;
        if (isRetiring(hauler.memory)) continue;
        const lease = hauler.memory && hauler.memory.brokerTask;
        if (lease && lease.kind === 'deliver' && lease.id === creep.id) return true;
        if (lease) continue;
        if (hauler.store && Number(hauler.store[RESOURCE_ENERGY] || 0) > 0) return true;
    }
    return false;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home)); return; }
    const state = (Memory.rooms[room.name] || {}).state || {};
    if (require('utils').towerFirstHold(room)) {
        const key = RESOURCE_ENERGY;
        const below = Number((require('config').towerFirst || {})[room.name]) || 500;
        const tower = creep.store[key] > 0 ? creep.pos.findClosestByRange(findCached(room, FIND_MY_STRUCTURES).filter((s) =>
            s.structureType === STRUCTURE_TOWER && s.store[key] < below)) : null;
        if (tower) { if (creep.transfer(tower, key) === ERR_NOT_IN_RANGE) movement.go(creep, tower, { reusePath: 15 }); }
        else if (room.storage && !creep.pos.inRangeTo(room.storage, 3)) movement.go(creep, room.storage, { range: 3, reusePath: 30 });
        return;
    }
    if (conserving(room)) {
        if (creep.store[RESOURCE_ENERGY] > 0) {
            const fill = room.energyAvailable < room.energyCapacityAvailable
                ? creep.pos.findClosestByRange(findCached(room, FIND_MY_STRUCTURES).filter((s) =>
                    (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0))
                : null;
            const dest = fill || room.storage;
            if (dest && creep.transfer(dest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, dest, { reusePath: 15 });
        } else if (room.storage && !creep.pos.inRangeTo(room.storage, 3)) {
            movement.go(creep, room.storage, { range: 3, reusePath: 30 });
        }
        return;
    }

    const hasLoad = creep.store[RESOURCE_ENERGY] > 0;
    if (hasLoad && creep.memory.waitSince) delete creep.memory.waitSince;
    const site = nextSite(room);

    if (hasLoad) {
        const critical = repairHold(creep, room) || criticalNear(creep, room);
        if (critical) {
            creep.memory.repairId = critical.id;
            if (creep.repair(critical) === ERR_NOT_IN_RANGE) movement.go(creep, critical, { reusePath: 15 });
            return;
        }
    } else if (creep.memory.repairId) {
        delete creep.memory.repairId;
    }

    if (hasLoad && site) {
        const ret = creep.build(site);
        if (ret === ERR_NOT_IN_RANGE) movement.go(creep, site, { reusePath: 15 });
        else {
            creep.memory.feedAt = Game.time;
            creep.memory.siteId = site.id;
        }
        return;
    }
    const waitedTooLong = Game.time - Number(creep.memory.waitSince || Game.time) > (config.builderFeedMaxWait || 50);
    const surplus = !room.storage && energySurplus(room);
    const ctrlShare = Number(config.energySurplus && config.energySurplus.ctrlShare) || 0.75;
    const nearSource = hasLoad ? null : energySourceFor(creep, room, ctrlShare);
    const selfFetch = !!nearSource && Math.max(
        Math.abs(nearSource.pos.x - creep.pos.x), Math.abs(nearSource.pos.y - creep.pos.y)) <= (config.builderSelfFetchRange || 8);
    if (!hasLoad && site && !waitedTooLong && !surplus && !selfFetch &&
        Game.time - (creep.memory.feedAt || -1e9) <= (config.builderFeedWait || 30) &&
        creep.pos.inRangeTo(site.pos, 3)) {
        if (haulerIncoming(creep, room)) {
            if (!creep.memory.waitSince) creep.memory.waitSince = Game.time;
            noteFeed(room, 'wait');
            return;
        }
        noteFeed(room, 'self');
    }
    if (hasLoad && !site) {
        const broken = damagedStructure(room);
        if (broken) {
            if (creep.repair(broken) === ERR_NOT_IN_RANGE) movement.go(creep, broken, { reusePath: 15 });
            return;
        }
        const st = room.storage;
        if (st && st.my && st.store[RESOURCE_ENERGY] > config.builderUpgradeAbove) {
            if (creep.upgradeController(room.controller) === ERR_NOT_IN_RANGE) movement.go(creep, room.controller, { reusePath: 20 });
            return;
        }
    }
    if (!hasLoad || (site && creep.store.getFreeCapacity() > 0 && !room.storage)) {
        const spawnFirst = !room.storage && room.energyCapacityAvailable < (config.builderSpawnFirstBelow || 800) &&
            room.energyAvailable < room.energyCapacityAvailable && hasHauler(room) && !waitedTooLong && !surplus;
        const pile = spawnFirst ? null : creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
            filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 100,
        });
        const src = spawnFirst ? null : nearSource;
        const range = (target) => Math.max(Math.abs(target.pos.x - creep.pos.x), Math.abs(target.pos.y - creep.pos.y));
        if (pile && (!src || range(pile) <= range(src))) {
            if (creep.pickup(pile) === ERR_NOT_IN_RANGE) movement.go(creep, pile, { reusePath: 15 });
            return;
        }
        if (src) {
            const roomMemory = Memory.rooms && (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
            if (roomMemory) {
                const entry = { at: Game.time, type: src.structureType, x: src.pos.x, y: src.pos.y };
                const log = roomMemory.builderSourceLog || (roomMemory.builderSourceLog = []);
                const last = log[log.length - 1];
                if (!last || last.type !== entry.type || last.x !== entry.x || last.y !== entry.y) {
                    log.push(entry);
                    if (log.length > 4) log.shift();
                }
                roomMemory.builderSource = entry;
                if (!roomMemory.builderSourceFirst) roomMemory.builderSourceFirst = entry;
            }
            const ret = creep.withdraw(src, RESOURCE_ENERGY);
            if (ret === ERR_NOT_IN_RANGE) movement.go(creep, src, { reusePath: 15 });
            return;
        }
        if (spawnFirst && site) {
            if (!creep.memory.waitSince) creep.memory.waitSince = Game.time;
            if (!creep.pos.inRangeTo(site.pos, 3)) movement.go(creep, site, { reusePath: 15 });
            else creep.memory.feedAt = Game.time;
            creep.memory.siteId = site.id;
            return;
        }
        if (!spawnFirst && withdrawRoomSurplus(creep, room, state)) return;
        if (harvestForSite(creep, room, site)) return;
    }
    if (site && hasLoad) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) movement.go(creep, site, { reusePath: 15 });
        return;
    }
    if (taskBroker.runFallback(creep, room)) return;
    const anchor = room.storage || room.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 3)) movement.go(creep, anchor.pos, { range: 3, reusePath: 20 });
}

module.exports = { run, nextSite };
