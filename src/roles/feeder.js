'use strict';
const movement = require('movement');
const layout = require('layout');
const config = require('config');
const utils = require('utils');
const retireMod = require('retire');
const haulStats = require('haul_stats');

function ctrlContainer(room) {
    const plan = (Memory.rooms[room.name] || {}).plan;
    const spot = plan && plan.containers && plan.containers.ctrl;
    return spot ? layout.structureAt(room, spot.x, spot.y, STRUCTURE_CONTAINER) : null;
}

function energyOf(target) {
    return target && target.store ? Math.max(0, Number(target.store[RESOURCE_ENERGY]) || 0) : 0;
}

function freeOf(target) {
    return target && target.store && typeof target.store.getFreeCapacity === 'function' ?
        Math.max(0, Number(target.store.getFreeCapacity(RESOURCE_ENERGY)) || 0) : 0;
}

function reach(creep, target) {
    const a = creep && creep.pos;
    const b = target && target.pos;
    if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return null;
    if (a.roomName && b.roomName && a.roomName !== b.roomName) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 20 }); return; }
    const storage = room.storage;
    const container = ctrlContainer(room);
    const rich = utils.storageRichState(room, Memory.rooms[room.name] || {}, config.upgrading || {});
    const energy = energyOf(creep);
    const carrying = energy > 0;
    if (!storage || storage.my === false || !container || (!rich && !carrying)) {
        retireMod.retireAtSpawn(creep);
        return;
    }
    if (carrying) {
        const free = freeOf(container);
        if (free <= 0) {
            haulStats.note(creep, 'full');
            if (!creep.pos.inRangeTo(container.pos, 2)) movement.go(creep, container, { range: 2, reusePath: 20 });
            return;
        }
        const range = reach(creep, container);
        if (range != null && range > 1) { movement.go(creep, container, { range: 1, reusePath: 20 }); return; }
        const sent = Math.min(energy, free);
        const ret = creep.transfer(container, RESOURCE_ENERGY, sent);
        if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, container, { range: 1, reusePath: 20 }); return; }
        if (ret === OK && energy - sent <= 0 && rich) movement.go(creep, storage, { range: 1, reusePath: 20 });
        return;
    }
    const range = reach(creep, storage);
    if (range != null && range > 1) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    const amount = Math.min(freeOf(creep), energyOf(storage));
    if (amount <= 0) return;
    const ret = creep.withdraw(storage, RESOURCE_ENERGY, amount);
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    if (ret === OK) movement.go(creep, container, { range: freeOf(container) > 0 ? 1 : 2, reusePath: 20 });
}

module.exports = { run };
