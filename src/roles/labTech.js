'use strict';
/**
 * 实验室搬运工（labTech，移植 overmind-absorb 7f4ab27）：照 industry.labPlan 把矿物从 terminal/storage 装进 lab，
 * 再把产物（与装错的货）从 lab 收回 terminal。
 *
 * 这是矿物链上断掉的那一环：矿物躺在 terminal 里，industry 认得出 lab 分工，但没有人把矿物搬进 lab——labs 建好了也永远不反应。
 * 刻意不走 task_broker / hauler：那两处只搬能量、承载账号全部的能量收入；矿物是独立的低频货流（一次装 labFill、几百 tick 才动一次）。
 *
 * 没活干（没有取送计划 / 都装满了 / 库里没货）先在原地等 labTechIdleTicks，再退役回收：
 * 两批之间的空档很短，一有空就回收会为每一批重孵一只。
 * 遥测（私服生效断言 minerals.labChain）：Memory.rooms[母房].labTech {loaded, loadedAmount, drained, drainedAmount, at}
 */
const config = require('config');
const movement = require('movement');
const retireMod = require('retire');
const industry = require('industry');

/** 手里唯一的那种货（labTech 一次只搬一种） */
function carrying(creep) {
    const store = creep.store || {};
    for (const key of Object.keys(store)) {
        if (typeof store[key] === 'number' && store[key] > 0) return key;
    }
    return null;
}

/** 取货点：优先 terminal（矿物的正经去处），否则 storage */
function sourceFor(room, mineral) {
    for (const holder of [room.terminal, room.storage]) {
        if (holder && holder.my !== false && holder.store && Number(holder.store[mineral] || 0) > 0) return holder;
    }
    return null;
}

/** 收回的货送哪：terminal 优先（市场/终端调剂都从它出），满了退 storage */
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

function idle(creep) {
    if (creep.memory.labIdleSince == null) creep.memory.labIdleSince = Game.time;
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

    // 手里有货：装进记下的那个 lab（memory.labId），否则送回 terminal（产物 / 装错的货 / 计划变了）
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
        // 装不进去（lab 里换成了别的矿物 / 满了）：忘掉目标，下一 tick 送回 terminal
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
            delete creep.memory.labId;   // 收回来的货送 terminal
            const ret = creep.withdraw(lab, drain.mineral);
            if (ret === ERR_NOT_IN_RANGE) movement.go(creep, lab, { range: 1, reusePath: 20 });
            else if (ret === OK) note(creep, 'drained', Math.min(drain.amount, creep.store.getFreeCapacity()));
            return;
        }
    }
    const want = plan && plan.wants && plan.wants.find((entry) => sourceFor(room, entry.mineral));
    if (!want) { idle(creep); return; }
    delete creep.memory.labIdleSince;
    const from = sourceFor(room, want.mineral);
    creep.memory.labId = want.labId;
    const amount = Math.min(want.amount, creep.store.getFreeCapacity(), Number(from.store[want.mineral] || 0));
    if (creep.withdraw(from, want.mineral, amount > 0 ? amount : undefined) === ERR_NOT_IN_RANGE) {
        movement.go(creep, from, { range: 1, reusePath: 20 });
    }
}

module.exports = { run, carrying, sourceFor, deliverTarget };
