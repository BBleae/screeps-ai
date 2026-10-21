'use strict';
const movement = require('movement');
const defense = require('defense');
const remote = require('remote');
const retireMod = require('retire');
const actions = require('actions');
const { creepsHomeRole } = require('utils');

function range(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function closest(creep, list) {
    let best = null;
    let bestRange = Infinity;
    for (const item of list) {
        const r = range(creep.pos, item.pos);
        if (r < bestRange) { best = item; bestRange = r; }
    }
    return best;
}

function clamp(value) {
    return Math.max(1, Math.min(48, value));
}

function stepAway(creep, from) {
    const dx = Math.sign(creep.pos.x - from.pos.x) || 1;
    const dy = Math.sign(creep.pos.y - from.pos.y) || 0;
    const target = new RoomPosition(clamp(creep.pos.x + dx * 3), clamp(creep.pos.y + dy * 3), creep.room.name);
    movement.go(creep, target, { range: 0, reusePath: 3 });
}

function fightRanged(creep, hostiles) {
    const target = closest(creep, hostiles);
    const r = range(creep.pos, target.pos);
    if (creep.hits < creep.hitsMax) { creep.heal(creep); actions.note(creep, 'heal'); }
    const inRange = hostiles.filter((h) => range(creep.pos, h.pos) <= 3);
    if (inRange.length >= 2) { creep.rangedMassAttack(); actions.note(creep, 'rangedMassAttack'); }
    else if (r <= 3) { creep.rangedAttack(target); actions.note(creep, 'rangedAttack'); }
    if (r < 3) stepAway(creep, target);
    else if (r > 3) movement.go(creep, target, { range: 3, reusePath: 5 });
}

function fightMelee(creep, hostiles) {
    const target = closest(creep, hostiles);
    const ret = creep.attack(target);
    if (ret === OK) actions.note(creep, 'attack');
    else if (ret === ERR_NOT_IN_RANGE) {
        movement.go(creep, target, { range: 1, reusePath: 5 });
        if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) { creep.heal(creep); actions.note(creep, 'heal'); }
    }
}

function hitStructure(creep, structure) {
    const ranged = creep.memory.style === 'ranged';
    const ret = ranged ? creep.rangedAttack(structure) : creep.attack(structure);
    if (ret === ERR_NOT_IN_RANGE) movement.go(creep, structure, { range: ranged ? 3 : 1, reusePath: 10 });
}

function retire(creep) {
    creep.memory.retired = true;
    retireMod.retireAtSpawn(creep);
}

function squadMates(creep) {
    const out = [];
    for (const other of creepsHomeRole(creep.memory.home, 'defender')) {
        if (other.memory.targetRoom !== creep.memory.targetRoom) continue;
        if (other.spawning || other.memory.retired) continue;
        out.push(other);
    }
    return out;
}

function remoteRecord(creep) {
    const mem = Memory.rooms && Memory.rooms[creep.memory.home];
    return (mem && mem.remotes && mem.remotes[creep.memory.targetRoom]) || null;
}

function holdPosition(creep, hostiles) {
    const target = closest(creep, hostiles);
    const r = range(creep.pos, target.pos);
    const wantHeal = creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0;
    if (creep.memory.style === 'ranged') {
        if (r <= 3) { creep.rangedAttack(target); actions.note(creep, 'rangedAttack'); }
        if (wantHeal) { creep.heal(creep); actions.note(creep, 'heal'); }
        if (r < 3) stepAway(creep, target);
    } else if (r <= 1) {
        creep.attack(target);
        actions.note(creep, 'attack');
    } else if (wantHeal) {
        creep.heal(creep);
        actions.note(creep, 'heal');
    }
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 22, reusePath: 5 });
    }
}

function run(creep) {
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    const target = creep.memory.targetRoom || creep.memory.home;
    if (!target) return;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);
    if (creep.room.name !== target) {
        if (squad > 1 && creep.room.name === creep.memory.home && !creep.memory.launched) {
            const mates = squadMates(creep);
            if (mates.length < squad) {
                const home = Game.rooms[creep.memory.home];
                if (home && !defense.planFor(home, target)) { retire(creep); return; }
                const anchor = creep.room.find(FIND_MY_SPAWNS)[0];
                if (anchor && !creep.pos.inRangeTo(anchor.pos, 3)) movement.go(creep, anchor.pos, { range: 3, reusePath: 20 });
                return;
            }
            creep.memory.launched = true;
        }
        movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40 });
        return;
    }
    const record = remoteRecord(creep);
    if (record && creep.room.name !== creep.memory.home) {
        const home = Game.rooms[creep.memory.home];
        if (home) remote.observe(home, creep.room);
    }
    const ownRoom = !!(creep.room.controller && creep.room.controller.my);
    if (!ownRoom && require('pvp').fleeHighThreat(creep)) return;
    const pvpOk = (h) => ownRoom || !(h.owner && h.owner.username !== 'Invader' && h.owner.username !== 'Source Keeper') ||
        h.pos.findInRange(FIND_STRUCTURES, 3, { filter: (s) => s.structureType === STRUCTURE_CONTAINER }).length > 0;
    const hostiles = defense.armedHostiles(creep.room).filter(pvpOk);
    const any = hostiles.length ? hostiles : creep.room.find(FIND_HOSTILE_CREEPS).filter(pvpOk);
    if (any.length) {
        delete creep.memory.idleSince;
        if (squad > 1 && !creep.memory.engaged) {
            if (!creep.memory.arrivedAt) creep.memory.arrivedAt = Game.time;
            const here = squadMates(creep).filter((mate) => mate.room && mate.room.name === creep.room.name).length;
            if (here < squad && Game.time - creep.memory.arrivedAt < defense.settings().squadWait) {
                holdPosition(creep, any);
                return;
            }
            creep.memory.engaged = true;
        }
        if (creep.memory.style === 'ranged') fightRanged(creep, any);
        else fightMelee(creep, any);
        return;
    }
    const core = defense.invaderCore(creep.room);
    if (core) {
        delete creep.memory.idleSince;
        hitStructure(creep, core);
        return;
    }
    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) creep.heal(creep);
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        return;
    }
    if (!creep.memory.idleSince) creep.memory.idleSince = Game.time;
    if (Game.time - creep.memory.idleSince < defense.settings().idleTicks) return;
    retire(creep);
}

module.exports = { run };
