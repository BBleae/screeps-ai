'use strict';
/** 援建搬运（aid.js 派出）：从母房（memory.from）的 storage 取能量，送到弱房（memory.home），投递分层与 remoteHauler 回家一致：
 *  spawn/ext → 低于储备的塔 → 控制器容器 → 和平期塔 → storage（弱房经济没起来，spawn 优先；只挑没被本房 hauler 预留满的 spawn/ext）。
 *  母房 storage 低于 config.aid.exportKeep 时不取（母房自己还要用），弱房放不下时在 spawn 旁等；母房没了 storage 就去最近的 spawn 回收退役。
 *  同 tick 取送 + 起步（引擎允许 withdraw/transfer 与 move 同 tick，射程按 tick 开始时的位置算、store 下一 tick 才变）：取满的那一 tick
 *  就朝弱房走；每次投递后同 tick 挑下一站（排除刚投过的那格）起步、broker 同 tick 扣减，投空的那一 tick 就回母房 */
const config = require('config');
const movement = require('movement');
const retireMod = require('retire');
const haulStats = require('haul_stats');
const taskBroker = require('task_broker');
const { homeTarget, rangeTo } = require('roles_remoteHauler');

function goToRoom(creep, roomName) {
    movement.go(creep, new RoomPosition(25, 25, roomName), { range: 20, reusePath: 35 });
}

function freeOf(target) {
    const store = target && target.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return Infinity;
    return Math.max(0, Number(store.getFreeCapacity(RESOURCE_ENERGY)) || 0);
}

function load(creep) {
    const from = Game.rooms[creep.memory.from];
    if (creep.room.name !== creep.memory.from) { goToRoom(creep, creep.memory.from); return; }
    const storage = from && from.storage;
    if (!storage || storage.my === false || !storage.store) { retireMod.retireAtSpawn(creep); return; }
    const keep = require('utils').aidExportLevels(config.aid, config.upgrading).keep;
    const spare = Number(storage.store[RESOURCE_ENERGY] || 0) - keep;
    if (spare <= 0) {
        haulStats.note(creep, 'wait');
        if (!creep.pos.inRangeTo(storage.pos, 3)) movement.go(creep, storage, { range: 3, reusePath: 25 });
        return;
    }
    const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
    const amount = Math.min(spare, free);
    const range = rangeTo(creep, storage);
    if (range != null && range > 1) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    const ret = creep.withdraw(storage, RESOURCE_ENERGY, amount);
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    // 取满的那一 tick 就出发（下一 tick run() 看到满仓也会转投递）；只取到零头（storage 只剩导出线以上一点）时照旧等
    if (ret === OK && amount >= free) {
        creep.memory.state = 'deliver';
        goToRoom(creep, creep.memory.home);
    }
}

function deliver(creep) {
    const home = Game.rooms[creep.memory.home];
    if (!home || creep.room.name !== creep.memory.home) { goToRoom(creep, creep.memory.home); return; }
    const exclude = new Set();
    const target = homeTarget(home, creep, { exclude });
    if (!target) {
        haulStats.note(creep, 'full');
        const anchor = home.storage || home.find(FIND_MY_SPAWNS)[0];
        if (anchor && !creep.pos.inRangeTo(anchor.pos, 3)) movement.go(creep, anchor, { range: 3, reusePath: 25 });
        return;
    }
    const range = rangeTo(creep, target);
    if (range != null && range > 1) { movement.go(creep, target, { range: 1, reusePath: 20 }); return; }
    const energy = Number(creep.store[RESOURCE_ENERGY]) || 0;
    const free = freeOf(target);
    const sent = Number.isFinite(free) ? Math.min(energy, free) : energy;
    const ret = creep.transfer(target, RESOURCE_ENERGY, sent);
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, target, { range: 1, reusePath: 20 }); return; }
    if (ret !== OK) return;
    if (typeof taskBroker.consume === 'function') taskBroker.consume(creep, home, target, sent, 'deliver');
    const left = energy - sent;
    if (left <= 0) { goToRoom(creep, creep.memory.from); return; }   // 投空的那一 tick 就回母房取货
    exclude.add(target.id);
    const next = homeTarget(home, creep, { exclude });
    const nextRange = next ? rangeTo(creep, next) : null;
    if (next && nextRange != null && nextRange > 1) movement.go(creep, next, { range: 1, reusePath: 20 });
}

function run(creep) {
    if (!creep.memory.home || !creep.memory.from) return;
    if (creep.store[RESOURCE_ENERGY] <= 0) creep.memory.state = 'load';
    else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.state = 'deliver';
    else if (!creep.memory.state) creep.memory.state = 'deliver';
    if (creep.memory.state === 'load') load(creep);
    else deliver(creep);
}

module.exports = { run };
