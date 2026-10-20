'use strict';
const config = require('config');
const movement = require('movement');
const retireMod = require('retire');
const industry = require('industry');

function carrying(creep) {
    const store = creep.store || {};
    for (const key of Object.keys(store)) {
        if (typeof store[key] === 'number' && store[key] > 0) return key;
    }
    return null;
}

function sourceFor(room, mineral) {
    for (const holder of [room.terminal, room.storage]) {
        if (holder && holder.my !== false && holder.store && Number(holder.store[mineral] || 0) > 0) return holder;
    }
    return null;
}

function deliverTarget(room) {
    for (const holder of [room.terminal, room.storage]) {
        if (holder && holder.my !== false && holder.store && holder.store.getFreeCapacity() > 0) return holder;
    }
    return null;
}

function note(creep, key, amount) {
    const home = creep.memory.home;
    if (!home || !Memory.rooms) return;
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const rec = mem.labTech || (mem.labTech = { loaded: 0, loadedAmount: 0, drained: 0, drainedAmount: 0 });
    rec[key] = (Number(rec[key]) || 0) + 1;
    rec[key + 'Amount'] = (Number(rec[key + 'Amount']) || 0) + Math.max(0, Number(amount) || 0);
    rec.at = Game.time;
}

function idle(creep, plan) {
    if (creep.memory.labIdleSince == null) creep.memory.labIdleSince = Game.time;
    if (plan && plan.product && (config.industry || {}).labTechStayWhileReacting !== false) return;
    const wait = Math.max(0, Number((config.industry || {}).labTechIdleTicks) || 0);
    if (Game.time - creep.memory.labIdleSince >= wait) {
        creep.memory.retired = true;
        retireMod.retireAtSpawn(creep);
    }
}

function run(creep) {
    const home = creep.memory.home;
    const room = home && Game.rooms[home];
    if (!room) { if (home) movement.go(creep, new RoomPosition(25, 25, home), { range: 20, reusePath: 20 }); return; }
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    const held = carrying(creep);

    if (held) {
        delete creep.memory.labIdleSince;
        const lab = creep.memory.labId ? Game.getObjectById(creep.memory.labId) : null;
        const toLab = !!(lab && lab.room && lab.room.name === room.name);
        const dest = toLab ? lab : deliverTarget(room);
        if (!dest) { idle(creep); return; }
        const amount = Number(creep.store[held] || 0);
        const ret = creep.transfer(dest, held);
        if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, dest, { range: 1, reusePath: 20 }); return; }
        if (ret === OK && toLab) note(creep, 'loaded', Math.min(amount, Number(dest.store.getFreeCapacity(held)) || amount));
        delete creep.memory.labId;
        return;
    }

    let plan = null;
    try { plan = industry.labPlan(room); } catch (error) { plan = null; }
    const drain = plan && plan.drains && plan.drains[0];
    if (drain) {
        const lab = Game.getObjectById(drain.labId);
        if (lab) {
            delete creep.memory.labIdleSince;
            delete creep.memory.labId;
            const ret = creep.withdraw(lab, drain.mineral);
            if (ret === ERR_NOT_IN_RANGE) movement.go(creep, lab, { range: 1, reusePath: 20 });
            else if (ret === OK) note(creep, 'drained', Math.min(drain.amount, creep.store.getFreeCapacity()));
            return;
        }
    }
    const want = plan && plan.wants && plan.wants.find((entry) => sourceFor(room, entry.mineral));
    if (!want) { idle(creep, plan); return; }
    delete creep.memory.labIdleSince;
    const from = sourceFor(room, want.mineral);
    creep.memory.labId = want.labId;
    const amount = Math.min(want.amount, creep.store.getFreeCapacity(), Number(from.store[want.mineral] || 0));
    if (creep.withdraw(from, want.mineral, amount > 0 ? amount : undefined) === ERR_NOT_IN_RANGE) {
        movement.go(creep, from, { range: 1, reusePath: 20 });
    }
}

module.exports = { run, carrying, sourceFor, deliverTarget };
