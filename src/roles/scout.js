'use strict';
const movement = require('movement');
const remote = require('remote');
const { logErr } = require('utils');

function nextTarget(home) {
    const remotes = Memory.rooms && Memory.rooms[home] && Memory.rooms[home].remotes;
    const records = Array.isArray(remotes) ? remotes : Object.values(remotes || {});
    for (const record of records) {
        const roomName = typeof record === 'string' ? record : record && record.room;
        if (!roomName || record.enabled === false) continue;
        const sourceIncomplete = !Array.isArray(record.sources) || record.sources.length !== 2 ||
            record.sources.some((source) => !source.id || !source.spot);
        const controllerIncomplete = !record.controllerId || !record.controllerPos || !record.controllerDistance;
        if ((sourceIncomplete || controllerIncomplete) && Game.time - (record.lastSeen || 0) > 5) return roomName;
        const suspensionExpired = record.suspendedUntil > 0 && record.suspendedUntil <= Game.time;
        if (suspensionExpired && Game.time - (record.lastSeen || 0) > 50) return roomName;
    }
    const exits = Game.map.describeExits(home) || {};
    for (const roomName of Object.values(exits)) {
        const info = Memory.map[roomName];
        if (!info || Game.time - (info.at || 0) > 5000) return roomName;
    }
    return null;
}

function activeParts(creep, type) {
    if (creep.getActiveBodyparts) return creep.getActiveBodyparts(type);
    return (creep.body || []).filter((part) => (part.type || part) === type && (part.hits == null || part.hits > 0)).length;
}

function armedHostiles(room) {
    const dangerousParts = [
        typeof ATTACK === 'undefined' ? 'attack' : ATTACK,
        typeof RANGED_ATTACK === 'undefined' ? 'ranged_attack' : RANGED_ATTACK,
        typeof HEAL === 'undefined' ? 'heal' : HEAL,
        typeof WORK === 'undefined' ? 'work' : WORK,
        typeof CLAIM === 'undefined' ? 'claim' : CLAIM,
    ];
    return room.find(FIND_HOSTILE_CREEPS)
        .filter((creep) => dangerousParts.some((part) => activeParts(creep, part) > 0)).length;
}

function record(room, home) {
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const structures = room.find(FIND_STRUCTURES);
    const controller = room.controller;
    const reservation = controller && controller.reservation;
    const sources = room.find(FIND_SOURCES).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const armed = armedHostiles(room);
    const invaderCore = structures.some((structure) => structure.structureType ===
        (typeof STRUCTURE_INVADER_CORE === 'undefined' ? 'invaderCore' : STRUCTURE_INVADER_CORE));
    const info = {
        at: Game.time,
        source: 'scout',
        sources: sources.length,
        sourceData: sources.map((source) => ({
            id: source.id,
            x: source.pos.x,
            y: source.pos.y,
            energyCapacity: source.energyCapacity,
        })),
        lairs: structures.filter((structure) => structure.structureType === STRUCTURE_KEEPER_LAIR).length,
        controllerId: controller && controller.id || null,
        controllerPos: controller ? { x: controller.pos.x, y: controller.pos.y } : null,
        owner: controller && controller.owner ? controller.owner.username : null,
        reservation: reservation ? { username: reservation.username, ticksToEnd: reservation.ticksToEnd } : null,
        mineral: (room.find(FIND_MINERALS)[0] || {}).mineralType || null,
        hostiles: hostiles.length,
        armedHostiles: armed,
        invaderCore,
        threat: armed > 0 || invaderCore,
    };
    Memory.map[room.name] = info;
    if (home) remote.observe(home, room);
    return info;
}

function run(creep) {
    if (!Memory.map) Memory.map = {};
    const home = creep.memory.home;
    const target = creep.memory.target || nextTarget(home);

    if (!target) {
        const room = Game.rooms[home];
        const anchor = room && (room.storage || room.find(FIND_MY_SPAWNS)[0]);
        if (room && anchor && !creep.pos.inRangeTo(anchor.pos, 4)) movement.go(creep, anchor.pos, { range: 4, reusePath: 30 });
        return;
    }
    creep.memory.target = target;
    const room = Game.rooms[target];
    if (room) {
        try { record(room, Game.rooms[home]); } catch (e) { logErr('scout.record ' + target, e); }
        delete creep.memory.target;
        return;
    }
    const ret = movement.go(creep, new RoomPosition(25, 25, target), { reusePath: 40 });
    if (ret === ERR_NO_PATH) {
        Memory.map[target] = {
            at: Game.time,
            sources: 0,
            lairs: 0,
            owner: null,
            reservation: null,
            mineral: null,
            hostiles: 0,
            armedHostiles: 0,
            invaderCore: false,
            threat: false,
            unreachable: true,
        };
        delete creep.memory.target;
    }
}

module.exports = { run, record, nextTarget };
