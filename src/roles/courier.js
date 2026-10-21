'use strict';
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
    let spare = Number(storage.store[RESOURCE_ENERGY] || 0) - keep;
    if (creep.memory.oneShot) {
        const o = Memory.aidOneShot;
        const left = o && !o.paused && o.from === creep.memory.from && o.to === creep.memory.home ? Math.max(0, Number(o.amount) - (Number(o.withdrawn) || 0)) : 0;
        if (left <= 0) {
            if ((Number(creep.store[RESOURCE_ENERGY]) || 0) > 0) { creep.memory.state = 'deliver'; goToRoom(creep, creep.memory.home); return; }
            retireMod.retireAtSpawn(creep); return;
        }
        spare = Math.min(spare, left);
    }
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
    if (ret === OK && creep.memory.oneShot && Memory.aidOneShot) {
        const o = Memory.aidOneShot;
        o.withdrawn = (Number(o.withdrawn) || 0) + amount;
        (o.trips || (o.trips = [])).push([Game.time, creep.name, amount]);
        if (o.withdrawn >= Number(o.amount)) {
            Memory.aidOneShotDone = Object.assign({}, o, { doneAt: Game.time });
            delete Memory.aidOneShot;
        }
        if (amount < free) { creep.memory.state = 'deliver'; goToRoom(creep, creep.memory.home); return; }
    }
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, storage, { range: 1, reusePath: 20 }); return; }
    if (ret === OK && amount >= free) {
        creep.memory.state = 'deliver';
        goToRoom(creep, creep.memory.home);
    }
}

function deliver(creep) {
    const home = Game.rooms[creep.memory.home];
    if (!home || creep.room.name !== creep.memory.home) { goToRoom(creep, creep.memory.home); return; }
    const exclude = new Set();
    const target = creep.memory.oneShot ? (oneShotTarget(home, creep) || homeTarget(home, creep, { exclude })) : homeTarget(home, creep, { exclude });
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
    if (left <= 0) { goToRoom(creep, creep.memory.from); return; }
    exclude.add(target.id);
    const next = homeTarget(home, creep, { exclude });
    const nextRange = next ? rangeTo(creep, next) : null;
    if (next && nextRange != null && nextRange > 1) movement.go(creep, next, { range: 1, reusePath: 20 });
}

function oneShotTarget(home, creep) {
    const below = Number((config.towerFirst || {})[home.name]) || 500;
    const mine = home.find(FIND_MY_STRUCTURES) || [];
    const towers = mine.filter((s) => s.structureType === STRUCTURE_TOWER && s.store && Number(s.store[RESOURCE_ENERGY] || 0) < below);
    const pick = (list) => list.length ? (creep.pos && creep.pos.findClosestByRange ? creep.pos.findClosestByRange(list) : list[0]) : null;
    if (towers.length) return pick(towers);
    const se = mine.filter((s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && freeOf(s) > 0);
    if (se.length) return pick(se);
    if (home.storage && home.storage.my !== false && freeOf(home.storage) > 0) return home.storage;
    return null;
}

function run(creep) {
    if (!creep.memory.home || !creep.memory.from) return;
    if (creep.memory.oneShot && Memory.aidOneShot && !Memory.aidOneShot.paused && creep.hits < creep.hitsMax) {
        Memory.aidOneShot.paused = { reason: 'courierDamaged', at: Game.time, name: creep.name, room: creep.room && creep.room.name,
            hits: creep.hits, hitsMax: creep.hitsMax, resume: 'W29S3 terminal 建成后用 terminal 送剩余量' };
        console.log('[aid] oneShot 暂停：' + creep.name + ' 在 ' + (creep.room && creep.room.name) + ' 掉血 ' + creep.hits + '/' + creep.hitsMax);
    }
    if (creep.store[RESOURCE_ENERGY] <= 0) creep.memory.state = 'load';
    else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.state = 'deliver';
    else if (!creep.memory.state) creep.memory.state = 'deliver';
    if (creep.memory.state === 'load') load(creep);
    else deliver(creep);
}

module.exports = { run };
