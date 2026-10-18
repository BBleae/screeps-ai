'use strict';
const config = require('config');
const movement = require('movement');

const DEFAULT_SKIP = ['harvester', 'remoteMiner', 'mineralMiner', 'depositMiner', 'skReaper', 'wallBreaker', 'siegeDismantler', 'remoteHauler', 'hauler', 'lootHauler'];
const cache = { t: -1, rooms: {} };

function settings() {
    return config.wallFix || {};
}

function targetHits() {
    const v = Number(settings().target);
    return v > 0 ? v : 30000;
}

function enabled() {
    return settings().enabled !== false;
}

function lowRamparts(room) {
    if (!room || typeof room.find !== 'function') return [];
    if (cache.t !== Game.time) { cache.t = Game.time; cache.rooms = {}; }
    const hit = cache.rooms[room.name];
    if (hit && hit.room === room) return hit.list;
    const limit = targetHits();
    const list = room.controller && room.controller.my
        ? room.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_RAMPART && s.my !== false && s.hits < limit && s.hits < s.hitsMax)
            .sort((a, b) => a.hits - b.hits)
        : [];
    cache.rooms[room.name] = { room, list };
    return list;
}

function skipRoles() {
    const list = settings().skipRoles;
    return Array.isArray(list) ? list : DEFAULT_SKIP;
}

function bodyHas(creep, part) {
    return (creep.body || []).some((p) => p.type === part && p.hits > 0);
}

function eligible(creep, room) {
    if (!creep || creep.spawning || !room) return false;
    if (creep.memory.home !== room.name) return false;
    if (skipRoles().includes(creep.memory.role)) return false;
    return bodyHas(creep, WORK) && bodyHas(creep, CARRY);
}

function workers(room) {
    return Object.values(Game.creeps || {}).filter((c) => c.memory && c.memory.home === room.name && !skipRoles().includes(c.memory.role) &&
        (c.body || []).some((p) => p.type === WORK) && (c.body || []).some((p) => p.type === CARRY));
}

function needsWorker(room) {
    if (!enabled() || !lowRamparts(room).length) return false;
    return workers(room).length === 0;
}

function energySource(room, creep) {
    const stores = room.find(FIND_STRUCTURES).filter((s) => s.store &&
        (s.structureType === STRUCTURE_TERMINAL || s.structureType === STRUCTURE_STORAGE ||
            s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK) &&
        (s.store[RESOURCE_ENERGY] || 0) >= 50);
    const dropped = room.find(FIND_DROPPED_RESOURCES).filter((r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 50);
    const tombs = room.find(FIND_TOMBSTONES).filter((t) => (t.store[RESOURCE_ENERGY] || 0) >= 50);
    const all = stores.concat(dropped, tombs);
    if (!all.length) return null;
    return creep.pos.findClosestByRange(all) || all[0];
}

function note(room, creep, target) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const prev = mem.wallFix || {};
    mem.wallFix = { at: Game.time, creep: creep.name, x: target.pos.x, y: target.pos.y, hits: target.hits,
        n: (Number(prev.n) || 0) + 1, low: lowRamparts(room).length };
}

function gather(creep, room) {
    const src = energySource(room, creep);
    if (src) {
        if (!creep.pos.isNearTo(src)) { movement.go(creep, src.pos, { range: 1, reusePath: 10 }); return; }
        if (src.amount != null) creep.pickup(src);
        else creep.withdraw(src, RESOURCE_ENERGY);
        return;
    }
    const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (!source) return;
    if (!creep.pos.isNearTo(source)) { movement.go(creep, source.pos, { range: 1, reusePath: 10 }); return; }
    creep.harvest(source);
}

function run(creep) {
    if (!enabled()) return false;
    const room = creep.room;
    if (!eligible(creep, room)) return false;
    const list = lowRamparts(room);
    if (!list.length) {
        if (creep.memory.wallFix) delete creep.memory.wallFix;
        return false;
    }
    const energy = creep.store[RESOURCE_ENERGY] || 0;
    if (energy === 0) creep.memory.wallFix = 'get';
    else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || !creep.memory.wallFix) creep.memory.wallFix = 'fix';
    if (creep.memory.wallFix === 'get') { gather(creep, room); return true; }
    const band = list.filter((r) => r.hits <= list[0].hits + 5000);
    const range = (r) => Math.max(Math.abs(r.pos.x - creep.pos.x), Math.abs(r.pos.y - creep.pos.y));
    const target = band.reduce((best, r) => (range(r) < range(best) ? r : best), band[0]);
    if (!creep.pos.inRangeTo(target, 3)) { movement.go(creep, target.pos, { range: 3, reusePath: 10 }); return true; }
    if (creep.repair(target) === OK) note(room, creep, target);
    return true;
}

module.exports = { run, lowRamparts, needsWorker, eligible, targetHits };
