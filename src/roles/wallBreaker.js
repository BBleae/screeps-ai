'use strict';
const movement = require('movement');
const breach = require('wall_breach');

function armedHere(room) {
    return room.find(FIND_HOSTILE_CREEPS).some((creep) => creep.body && creep.body.some((part) =>
        part.hits > 0 && (part.type === ATTACK || part.type === RANGED_ATTACK || part.type === HEAL)));
}

function goHome(creep) {
    const home = creep.memory.home;
    if (home && creep.room.name !== home) movement.go(creep, new RoomPosition(25, 25, home), { range: 20, reusePath: 10 });
}

function retire(creep) {
    try { require('retire').retireAtSpawn(creep); } catch (error) { creep.suicide(); }
}

function run(creep) {
    if (creep.spawning) return;
    const m = creep.memory;
    const key = m.breachKey;
    const target = breach.targetByKey(key);
    if (!target || breach.isDone(key) || !breach.settings().enabled) { retire(creep); return 'retire'; }
    if (require('pvp').fleeHighThreat(creep)) { breach.mem().fleeUntil[key] = Game.time + breach.settings().fleeTicks; return 'flee'; }
    const own = creep.room.controller && creep.room.controller.my;
    if (!own && armedHere(creep.room)) {
        breach.mem().fleeUntil[key] = Game.time + breach.settings().fleeTicks;
        goHome(creep);
        return 'flee';
    }
    if (breach.fleeing(key)) { goHome(creep); return 'flee'; }
    const pos = new RoomPosition(target.x, target.y, target.room);
    if (creep.room.name !== target.room) { movement.go(creep, pos, { range: 1, reusePath: 20 }); return 'move'; }
    const wall = creep.room.lookForAt(LOOK_STRUCTURES, target.x, target.y).find((structure) => breach.allowedWall(structure));
    if (!wall) {
        const other = creep.room.lookForAt(LOOK_STRUCTURES, target.x, target.y).filter((s) => s.structureType !== STRUCTURE_ROAD);
        if (!other.length) { breach.markDone(key); retire(creep); return 'done'; }
        breach.mem().blocked = { key, at: Game.time, types: other.map((s) => s.structureType) };
        retire(creep);
        return 'blocked';
    }
    if (!creep.pos.isNearTo(wall)) { movement.go(creep, wall.pos, { range: 1, reusePath: 20 }); return 'move'; }
    creep.dismantle(wall);
    return 'dismantle';
}

module.exports = { run, armedHere };
