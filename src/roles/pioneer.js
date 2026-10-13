'use strict';
/** 开荒工：在新房就地采能，建 spawn 工地，没工地就升级 controller；新房 spawn 建成后转为该房 builder */
const movement = require('movement');
const expansion = require('expansion');
const retire = require('retire');

function pioneersOn(room, sourceId, except) {
    let n = 0;
    for (const other of Object.values(Game.creeps)) {
        if (other.name === except || other.memory.role !== 'pioneer' || other.memory.targetRoom !== room.name) continue;
        if (other.memory.sourceId === sourceId) n++;
    }
    return n;
}

/** 分源：一个 source 只有 10 e/tick，4 WORK 的 pioneer 两只挤一个源会浪费一半；选 pioneer 最少的源，记进内存 */
function pickSource(creep) {
    const room = creep.room;
    const remembered = creep.memory.sourceId && Game.getObjectById(creep.memory.sourceId);
    if (remembered && remembered.room && remembered.room.name === room.name) return remembered;
    let best = null;
    let bestKey = null;
    for (const source of room.find(FIND_SOURCES)) {
        const load = pioneersOn(room, source.id, creep.name);
        const distance = Math.max(Math.abs(source.pos.x - creep.pos.x), Math.abs(source.pos.y - creep.pos.y));
        const key = load * 100 + distance;
        if (bestKey == null || key < bestKey) { best = source; bestKey = key; }
    }
    if (best) creep.memory.sourceId = best.id;
    return best;
}

function nearestEnergy(creep) {
    const drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50,
    });
    if (drop) return { kind: 'drop', target: drop };
    const source = pickSource(creep);
    return source ? { kind: 'source', target: source } : null;
}

function run(creep) {
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
    const target = creep.memory.targetRoom;
    if (!target) return;
    if (creep.room.name !== target) {
        if (expansion.noteStuck(creep)) return;
        movement.noteKeeperTransit(creep);   // 遥测：记录穿 SK 房时到 lair 的最近距离（私服断言用）
        // 允许穿 SK 房（只避他人占领房）+ 保持离 keeper lair 距离，去 SK 环外的目标房建 spawn
        movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40,
            avoidRooms: movement.hostileTerritoryRooms(), costCallback: movement.keeperAvoidCallback() });
        return;
    }
    const room = creep.room;
    if (room.controller && room.controller.my && room.find(FIND_MY_SPAWNS).length) {
        // 新房已有 spawn：转为该房的 builder，由新房自己的经济链接管
        creep.memory.home = room.name;
        creep.memory.role = 'builder';
        delete creep.memory.targetRoom;
        delete creep.memory.slotKey;
        return;
    }
    // 采满再干活：否则采一 tick 就带着 8 能量往返工地，工地进度只有 1 点/tick（线上 W34S7 实测）
    if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) creep.memory.working = false;
    if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.working = true;
    if (!creep.memory.working) {
        const energy = nearestEnergy(creep);
        if (!energy) return;
        const ret = energy.kind === 'drop' ? creep.pickup(energy.target) : creep.harvest(energy.target);
        if (ret === ERR_NOT_IN_RANGE) movement.go(creep, energy.target, { range: 1, reusePath: 20 });
        return;
    }
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length) {
        const site = sites.find((s) => s.structureType === STRUCTURE_SPAWN) || sites[0];
        if (creep.build(site) === ERR_NOT_IN_RANGE) movement.go(creep, site, { range: 3, reusePath: 20 });
        return;
    }
    if (room.controller && room.controller.my) {
        if (creep.upgradeController(room.controller) === ERR_NOT_IN_RANGE) movement.go(creep, room.controller, { range: 3, reusePath: 20 });
        return;
    }
    // 还没占下：在 controller 附近等 claimer
    if (room.controller && !creep.pos.inRangeTo(room.controller, 3)) movement.go(creep, room.controller, { range: 3, reusePath: 30 });
}

module.exports = { run };
