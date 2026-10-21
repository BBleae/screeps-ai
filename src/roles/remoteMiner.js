'use strict';

const movement = require('movement');
const remote = require('remote');
const retireMod = require('retire');

function homeAnchor(room) {
    return room && (room.storage || room.find(FIND_MY_SPAWNS)[0]);
}

function depositTarget(room) {
    if (!room) return null;
    if (room.storage && room.storage.my && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
    return room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => (structure.structureType === STRUCTURE_SPAWN ||
            structure.structureType === STRUCTURE_EXTENSION || structure.structureType === STRUCTURE_CONTAINER) &&
            structure.store && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    })[0] || null;
}

function retreat(creep) {
    if (remote.isDisabled(creep.memory.home, creep.memory.remoteRoom) || remote.isUnreachable(creep.memory.home, creep.memory.remoteRoom)) {
        retireMod.retireAtSpawn(creep);
        return;
    }
    const home = Game.rooms[creep.memory.home];
    if (!home) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 30 });
        return;
    }
    if (creep.room.name !== home.name) {
        movement.go(creep, new RoomPosition(25, 25, home.name), { range: 20, reusePath: 30 });
        return;
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
        const target = depositTarget(home);
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                movement.go(creep, target, { range: 1, reusePath: 20 });
            }
            return;
        }
    }
    const anchor = homeAnchor(home);
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 4)) movement.go(creep, anchor, { range: 4, reusePath: 25 });
}

function sourceObject(room, sourceMemory, sourceIdx) {
    let source = sourceMemory && sourceMemory.id && Game.getObjectById(sourceMemory.id);
    if (source) return source;
    const sources = room.find(FIND_SOURCES).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (sourceMemory && sourceMemory.id) source = sources.find((item) => item.id === sourceMemory.id);
    return source || sources[sourceIdx || 0] || sources[0] || null;
}

function run(creep) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!homeName || !remoteRoom) return;
    if (require('pvp').fleeHighThreat(creep)) return;
    if (remote.isSuspended(homeName, remoteRoom)) {
        retreat(creep);
        return;
    }
    if (creep.room.name !== remoteRoom) {
        if (remote.noteTravel(creep)) return;
        movement.go(creep, new RoomPosition(25, 25, remoteRoom), { range: 20, reusePath: 40 });
        return;
    }

    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);
    if (remote.isSuspended(homeName, remoteRoom)) {
        retreat(creep);
        return;
    }
    if (remote.keeperRetreat(creep)) return;
    const sourceMemory = remote.getSource(homeName, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory || !sourceMemory.spot) return;
    if (!creep.memory.sourceId && sourceMemory.id) creep.memory.sourceId = sourceMemory.id;
    const source = sourceObject(creep.room, sourceMemory, creep.memory.srcIdx);
    if (!source) return;

    const spot = new RoomPosition(sourceMemory.spot.x, sourceMemory.spot.y, remoteRoom);
    if (!creep.pos.isEqualTo(spot.x, spot.y)) {
        movement.go(creep, spot, { range: 0, reusePath: 30 });
        if (creep.pos.isNearTo(source.pos)) remote.noteSkHarvest(creep, creep.harvest(source));
        return;
    }

    const container = creep.room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y)
        .find((structure) => structure.structureType === STRUCTURE_CONTAINER);
    const site = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, spot.x, spot.y)
        .find((constructionSite) => constructionSite.structureType === STRUCTURE_CONTAINER && constructionSite.my !== false);
    if (site) {
        const had = creep.store[RESOURCE_ENERGY];
        const drop = creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            ? creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, { filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0 })[0] : null;
        if (drop) creep.pickup(drop);
        if (had > 0) {
            creep.build(site);
            if (drop) {
                const record = remote.getRemote(homeName, remoteRoom);
                if (record && (!record.minerPickupBuild || record.minerPickupBuild.at !== Game.time)) {
                    record.minerPickupBuild = { at: Game.time, n: (Number(record.minerPickupBuild && record.minerPickupBuild.n) || 0) + 1 };
                }
            }
        } else remote.noteSkHarvest(creep, creep.harvest(source));
        return;
    }
    if (container && container.hits < container.hitsMax * 0.75 && creep.store[RESOURCE_ENERGY] > 0 && Game.time % 5 === 0) {
        creep.repair(container);
        return;
    }
    if (container && creep.store[RESOURCE_ENERGY] > 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        creep.transfer(container, RESOURCE_ENERGY);
    }
    if (container && creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0 && container.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return;
    remote.noteSkHarvest(creep, creep.harvest(source));
}

module.exports = { run };
