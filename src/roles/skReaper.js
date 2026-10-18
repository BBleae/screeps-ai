'use strict';
const movement = require('movement');
const remote = require('remote');
const actions = require('actions');
const retireMod = require('retire');

function keepersIn(room) {
    if (!room) return [];
    return room.find(FIND_HOSTILE_CREEPS).filter((creep) => remote.isKeeper(creep));
}

function nextLair(room) {
    if (!room) return null;
    const lairs = room.find(FIND_STRUCTURES).filter((structure) => structure.structureType === STRUCTURE_KEEPER_LAIR);
    let best = null;
    for (const lair of lairs) {
        if (lair.ticksToSpawn == null) continue;
        if (!best || lair.ticksToSpawn < best.ticksToSpawn) best = lair;
    }
    return best || lairs[0] || null;
}

function rangeBetween(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function holdStandoff(creep, anchorPos, standoff, reusePath) {
    if (rangeBetween(creep.pos, anchorPos) === standoff) return;
    const spot = remote.ringTile(creep.room, anchorPos, standoff, creep.pos);
    if (spot) movement.go(creep, spot, { range: 0, reusePath });
    else movement.go(creep, new RoomPosition(anchorPos.x, anchorPos.y, creep.room.name), { range: standoff, reusePath });
}

function heal(creep) {
    if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
        actions.note(creep, 'heal');
    }
}

function noteCombat(creep, record, target, fired) {
    if (!record) return;
    const log = record.skReaper || (record.skReaper = { first: Game.time, shots: 0, kills: 0 });
    const last = creep.memory.skTarget;
    if (last && (!target || target.id !== last) && !Game.getObjectById(last) &&
        Number(creep.memory.skTargetHits) <= 2 * 10 * Math.max(1, creep.getActiveBodyparts ? creep.getActiveBodyparts(RANGED_ATTACK) : 1)) {
        log.kills = (Number(log.kills) || 0) + 1;
        log.lastKill = Game.time;
    }
    if (fired && target) {
        log.shots = (Number(log.shots) || 0) + 1;
        log.at = Game.time;
        creep.memory.skTarget = target.id;
        creep.memory.skTargetHits = target.hits;
    } else if (!target) {
        delete creep.memory.skTarget;
        delete creep.memory.skTargetHits;
    }
}

function validateActive(homeName, targetRoom) {
    return require('conquest').skValidateOn(homeName, targetRoom);
}

function run(creep) {
    const homeName = creep.memory.home;
    const targetRoom = creep.memory.remoteRoom;
    creep.memory.lastTtl = creep.ticksToLive;
    const blocked = creep.memory.validate ? !validateActive(homeName, targetRoom)
        : (remote.isDisabled(homeName, targetRoom) || remote.isUnreachable(homeName, targetRoom));
    if (!homeName || !targetRoom || blocked) {
        creep.memory.retired = true;
        retireMod.retireAtSpawn(creep);
        return;
    }
    heal(creep);
    if (creep.memory.validate) {
        const m = Memory.skReaperValidate || (Memory.skReaperValidate = {});
        const rec = m[targetRoom] || (m[targetRoom] = { name: creep.name, spawnedSeen: Game.time, minHits: creep.hits, kills: 0, shots: 0 });
        rec.at = Game.time; rec.room = creep.room.name; rec.hits = creep.hits; rec.hitsMax = creep.hitsMax;
        if (creep.hits < rec.minHits) rec.minHits = creep.hits;
        rec.keepers = creep.room.name === targetRoom ? keepersIn(creep.room).length : null;
    }

    if (require('conquest').boostGateHold(targetRoom) && creep.room.name !== targetRoom) {
        if (homeName && creep.room.name !== homeName) movement.go(creep, new RoomPosition(25, 25, homeName), { range: 20, reusePath: 20 });
        return;
    }
    if (creep.room.name !== targetRoom) {
        if (remote.noteTravel(creep)) return;
        movement.go(creep, new RoomPosition(25, 25, targetRoom), { range: 20, reusePath: 40 });
        return;
    }
    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);

    const record = remote.getRemote(homeName, targetRoom);
    const standoff = Math.max(1, Number(remote.skSettings().reaperStandoff) || 3);
    const keepers = keepersIn(creep.room);
    if (keepers.length) {
        let target = null;
        let range = Infinity;
        for (const keeper of keepers) {
            const distance = rangeBetween(creep.pos, keeper.pos);
            if (distance < range) { target = keeper; range = distance; }
        }
        let fired = false;
        if (range <= 3) {
            fired = creep.rangedAttack(target) === OK;
            actions.note(creep, 'rangedAttack');
        }
        if (creep.memory.validate && fired) { const rec = Memory.skReaperValidate && Memory.skReaperValidate[targetRoom]; if (rec) rec.shots = (rec.shots || 0) + 1; }
        noteCombat(creep, record, target, fired);
        holdStandoff(creep, target.pos, standoff, 5);
        return;
    }
    noteCombat(creep, record, null, false);
    const lair = nextLair(creep.room);
    if (lair) holdStandoff(creep, lair.pos, standoff, 10);
}

module.exports = { run, keepersIn, nextLair, validateActive };
