'use strict';
const movement = require('movement');
const links = require('links');
const retireMod = require('retire');

function atHub(creep, storage, store) {
    return creep.pos.inRangeTo(storage.pos, 1) && creep.pos.inRangeTo(store.pos, 1);
}

function record(room, field, amount) {
    if (typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem.operator || (mem.operator = { at: 0, withdrawn: 0, transferred: 0, reverse: 0, n: 0 });
    rec.at = Game.time;
    rec[field] = (Number(rec[field]) || 0) + Math.max(0, Number(amount) || 0);
    rec.n = (Number(rec.n) || 0) + 1;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 20 }); return; }
    const plan = (Memory.rooms[room.name] || {}).plan || {};
    const storage = room.storage;
    const store = links.storeLinkReady(room, plan);
    const station = store && links.operatorStation(room, plan);
    const carrying = (creep.store[RESOURCE_ENERGY] || 0) > 0;
    if (!storage || storage.my === false || !store || !station) {
        if (carrying && storage && storage.my !== false && storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            if (creep.transfer(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, storage, { range: 1, reusePath: 20 });
            return;
        }
        retireMod.retireAtSpawn(creep);
        return;
    }
    if (!atHub(creep, storage, store)) {
        movement.go(creep, station, { range: station.range != null ? station.range : 0, reusePath: 20 });
        return;
    }
    const reverse = typeof links.reverseCtrlFeedWanted === 'function' && links.reverseCtrlFeedWanted(room, plan);
    const floor = typeof links.reverseCtrlFeedAbove === 'function' ? links.reverseCtrlFeedAbove() : 0;
    if (carrying) {
        if (reverse) {
            const free = store.store.getFreeCapacity(RESOURCE_ENERGY);
            if (free <= 0) return;
            const amount = Math.min(creep.store[RESOURCE_ENERGY], free);
            if (amount > 0 && creep.transfer(store, RESOURCE_ENERGY, amount) === OK) record(room, 'reverse', amount);
            return;
        }
        if (storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return;
        const amount = Math.min(creep.store[RESOURCE_ENERGY], storage.store.getFreeCapacity(RESOURCE_ENERGY));
        if (amount > 0 && creep.transfer(storage, RESOURCE_ENERGY, amount) === OK) record(room, 'transferred', amount);
        return;
    }
    if (reverse) {
        const spare = Math.max(0, (storage.store[RESOURCE_ENERGY] || 0) - floor);
        const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
        const take = Math.min(spare, free);
        if (take <= 0) return;
        if (creep.withdraw(storage, RESOURCE_ENERGY, take) === OK) record(room, 'withdrawn', take);
        return;
    }
    const keep = links.operatorKeepEnergy(room, plan, store);
    const available = Math.max(0, (store.store[RESOURCE_ENERGY] || 0) - keep);
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
    const take = Math.min(available, free);
    if (take <= 0) return;
    if (creep.withdraw(store, RESOURCE_ENERGY, take) === OK) record(room, 'withdrawn', take);
}

module.exports = { run };
