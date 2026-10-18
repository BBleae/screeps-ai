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

function triggerHits() {
    const v = Number(settings().trigger);
    return v > 0 ? Math.min(v, targetHits()) : targetHits();
}

function activeRamparts(room) {
    const list = lowRamparts(room);
    if (!room || !room.name) return list;
    const rooms = Memory.rooms || (Memory.rooms = {});
    const mem = rooms[room.name] || (rooms[room.name] = {});
    if (!list.length) {
        if (mem.wallFixOn) delete mem.wallFixOn;
        return list;
    }
    if (mem.wallFixOn) return list;
    if (list[0].hits >= triggerHits()) return [];
    mem.wallFixOn = Game.time;
    return list;
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

function mobile(creep) {
    const body = creep.body || [];
    const moves = body.filter((p) => p.type === MOVE).length;
    return moves * 4 >= body.length - moves;
}

function workers(room) {
    return Object.values(Game.creeps || {}).filter((c) => c.memory && c.memory.home === room.name && !skipRoles().includes(c.memory.role) &&
        (c.body || []).some((p) => p.type === WORK) && (c.body || []).some((p) => p.type === CARRY) && mobile(c));
}

function needsWorker(room) {
    if (!enabled() || !activeRamparts(room).length) return false;
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

function roadCfg(room) {
    const all = settings().roads || {};
    return room && all[room.name] ? all[room.name] : null;
}

const roadCache = { t: -1, rooms: {} };
function roadTargets(room) {
    const cfg = roadCfg(room);
    if (!cfg || !room.controller || !room.controller.my) return [];
    if (roadCache.t !== Game.time) { roadCache.t = Game.time; roadCache.rooms = {}; }
    const hit = roadCache.rooms[room.name];
    if (hit && hit.room === room) return hit.list;
    const share = Number(cfg.fixTo) > 0 ? Number(cfg.fixTo) : 0.8;
    const critical = Number(cfg.criticalHits) > 0 ? Number(cfg.criticalHits) : 500;
    const terrain = typeof room.getTerrain === 'function' ? room.getTerrain() : null;
    const swampMask = typeof TERRAIN_MASK_SWAMP === 'undefined' ? 2 : TERRAIN_MASK_SWAMP;
    const list = [];
    for (const s of room.find(FIND_STRUCTURES)) {
        if (s.structureType !== STRUCTURE_ROAD || !(s.hits < s.hitsMax * share)) continue;
        const crit = s.hits <= critical;
        const swamp = !!terrain && (terrain.get(s.pos.x, s.pos.y) & swampMask) !== 0;
        if (crit || swamp) list.push({ s, crit });
    }
    list.sort((a, b) => (b.crit - a.crit) || (a.s.hits / a.s.hitsMax - b.s.hits / b.s.hitsMax));
    roadCache.rooms[room.name] = { room, list };
    return list;
}

function fixRoads(creep, room) {
    const cfg = roadCfg(room);
    if (!cfg || (cfg.roles || ['builder']).indexOf(creep.memory.role) < 0) return false;
    const list = roadTargets(room);
    if (!list.length) {
        if (creep.memory.roadFix) delete creep.memory.roadFix;
        return false;
    }
    const energy = creep.store[RESOURCE_ENERGY] || 0;
    if (energy === 0) creep.memory.roadFix = 'get';
    else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || !creep.memory.roadFix) creep.memory.roadFix = 'fix';
    if (creep.memory.roadFix === 'get') { gather(creep, room); return true; }
    const share = Number(cfg.fixTo) > 0 ? Number(cfg.fixTo) : 0.8;
    const held = creep.memory.roadFixId ? Game.getObjectById(creep.memory.roadFixId) : null;
    const keep = held && held.pos && held.pos.roomName === room.name && held.hits < held.hitsMax * share ? { s: held } : null;
    const crit = list.filter((e) => e.crit);
    const pool = crit.length ? crit : list;
    const range = (r) => Math.max(Math.abs(r.pos.x - creep.pos.x), Math.abs(r.pos.y - creep.pos.y));
    const target = keep ? keep.s : pool.reduce((best, e) => (range(e.s) < range(best) ? e.s : best), pool[0].s);
    creep.memory.roadFixId = target.id;
    if (!creep.pos.inRangeTo(target, 3)) { movement.go(creep, target.pos, { range: 3, reusePath: 10 }); return true; }
    if (creep.repair(target) === OK) {
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const prev = mem.roadFix || {};
        mem.roadFix = { at: Game.time, creep: creep.name, x: target.pos.x, y: target.pos.y, hits: target.hits,
            n: (Number(prev.n) || 0) + 1, left: list.length, crit: crit.length };
    }
    return true;
}

function run(creep) {
    if (!enabled()) return false;
    const room = creep.room;
    if (!eligible(creep, room)) return false;
    const list = activeRamparts(room);
    if (!list.length) {
        if (creep.memory.wallFix) delete creep.memory.wallFix;
        return fixRoads(creep, room);
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

module.exports = { run, lowRamparts, activeRamparts, needsWorker, eligible, targetHits, triggerHits, roadTargets };
