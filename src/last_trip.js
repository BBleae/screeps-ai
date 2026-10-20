'use strict';
const config = require('config');
const movement = require('movement');
const retireMod = require('retire');

const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
const DEFAULT_ROLES = ['labTech', 'hauler', 'feeder', 'courier'];

function settings() {
    return Object.assign({ enabled: true, margin: 20, maxCheck: 200, roles: DEFAULT_ROLES, salvageRoles: ['labTech'], salvageMin: 20 }, config.lastTrip || {});
}

function ownSinks(room) {
    if (!room || !room.controller || !room.controller.my) return [];
    return [room.terminal, room.storage].filter((s) => s && s.my !== false && s.store);
}

function used(creep) {
    const s = creep.store;
    if (!s) return 0;
    if (typeof s.getUsedCapacity === 'function') return Number(s.getUsedCapacity()) || 0;
    let n = 0;
    for (const k in s) if (typeof s[k] === 'number') n += s[k];
    return n;
}

function cargoKey(store) {
    let energy = false;
    for (const k in store) {
        if (typeof store[k] !== 'number' || store[k] <= 0) continue;
        if (k !== ENERGY) return k;
        energy = true;
    }
    return energy ? ENERGY : null;
}

function range(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function routeSteps(from, to) {
    if (from === to) return 0;
    const map = Game.map;
    if (map && typeof map.findRoute === 'function') {
        const r = map.findRoute(from, to);
        if (Array.isArray(r)) return r.length * 50;
        return Infinity;
    }
    return map && typeof map.getRoomLinearDistance === 'function' ? map.getRoomLinearDistance(from, to) * 50 : 50;
}

function sinkPlan(creep) {
    const here = ownSinks(creep.room);
    if (here.length) {
        let best = here[0];
        for (const s of here) if (range(creep.pos, s.pos) < range(creep.pos, best.pos)) best = s;
        return { room: creep.room.name, steps: range(creep.pos, best.pos) };
    }
    const home = creep.memory.home;
    if (!home) return null;
    const hr = Game.rooms[home];
    if (hr && !ownSinks(hr).length) return null;
    const m = creep.memory;
    if (!m.ltR || m.ltR[0] !== creep.room.name || Game.time - m.ltR[2] >= 10) m.ltR = [creep.room.name, routeSteps(creep.room.name, home), Game.time];
    const steps = m.ltR[1];
    return { room: home, steps: steps == null ? Infinity : steps };
}

function pickSink(room, key) {
    const list = ownSinks(room);
    const order = key === ENERGY ? [room.storage, room.terminal] : [room.terminal, room.storage];
    for (const s of order) {
        if (!s || list.indexOf(s) < 0) continue;
        if (typeof s.store.getFreeCapacity !== 'function' || Number(s.store.getFreeCapacity(key)) > 0) return s;
    }
    return null;
}

function releaseLease(creep) {
    const lease = creep.memory.brokerTask;
    if (!lease) return;
    try { if (lease.id) require('task_broker').releaseClaim(lease.id, creep); } catch (e) { }
    delete creep.memory.brokerTask;
}

function dying(creep) {
    const s = settings();
    const ttl = creep.ticksToLive;
    if (ttl == null || ttl > Number(s.maxCheck)) return false;
    if (creep.memory.lastTrip) return true;
    const plan = sinkPlan(creep);
    if (!plan) return false;
    return ttl < plan.steps + Number(s.margin);
}

function unload(creep) {
    const key = cargoKey(creep.store);
    if (!key) return false;
    const room = ownSinks(creep.room).length ? creep.room : Game.rooms[creep.memory.home];
    const sink = room ? pickSink(room, key) : null;
    if (!sink) {
        if (creep.memory.home && creep.room.name !== creep.memory.home) movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 20 });
        return true;
    }
    if (creep.pos.roomName !== sink.pos.roomName || range(creep.pos, sink.pos) > 1) {
        movement.go(creep, sink, { range: 1, reusePath: 20 });
        return true;
    }
    creep.transfer(sink, key);
    return true;
}

function run(creep) {
    const s = settings();
    if (s.enabled === false || !creep || !creep.memory) return false;
    if (s.roles.indexOf(creep.memory.role) < 0) return false;
    if (!dying(creep)) return false;
    if (!creep.memory.lastTrip) creep.memory.lastTrip = Game.time;
    releaseLease(creep);
    delete creep.memory.labId;
    delete creep.memory.salvage;
    delete creep.memory.ownSalv;
    delete creep.memory.fill;
    if (used(creep) > 0) return unload(creep);
    retireMod.retireAtSpawn(creep);
    return true;
}

const cache = { tick: -1, rooms: {} };

function ownPiles(room) {
    if (cache.tick !== Game.time) { cache.tick = Game.time; cache.rooms = {}; }
    if (cache.rooms[room.name]) return cache.rooms[room.name];
    const min = Number(settings().salvageMin) || 0;
    const out = [];
    for (const t of room.find(FIND_TOMBSTONES) || []) {
        if (!t.creep || !t.creep.my || !t.store) continue;
        for (const k in t.store) if (k !== ENERGY && Number(t.store[k]) > 0) { out.push(t); break; }
    }
    for (const r of room.find(FIND_DROPPED_RESOURCES) || []) {
        if (r.resourceType !== ENERGY && Number(r.amount) >= min) out.push(r);
    }
    cache.rooms[room.name] = out;
    return out;
}

function hasOwnPiles(room) {
    return !!(room && room.controller && room.controller.my && ownPiles(room).length);
}

function salvage(creep) {
    const s = settings();
    if (s.enabled === false || !creep || !creep.memory) return false;
    if (s.salvageRoles.indexOf(creep.memory.role) < 0) return false;
    const room = creep.room;
    if (!room || room.name !== creep.memory.home || !room.controller || !room.controller.my) { delete creep.memory.ownSalv; return false; }
    if (creep.memory.lastTrip || used(creep) > 0) { delete creep.memory.ownSalv; return false; }
    if (!pickSink(room, 'X')) return false;
    let obj = creep.memory.ownSalv ? Game.getObjectById(creep.memory.ownSalv) : null;
    const piles = ownPiles(room);
    if (obj && piles.indexOf(obj) < 0 && !piles.some((p) => p.id === obj.id)) obj = null;
    if (!obj) {
        delete creep.memory.ownSalv;
        if (!piles.length) return false;
        const taken = new Set();
        for (const c of room.find(FIND_MY_CREEPS) || []) if (c.name !== creep.name && c.memory && c.memory.ownSalv) taken.add(c.memory.ownSalv);
        const free = piles.filter((p) => !taken.has(p.id));
        if (!free.length) return false;
        obj = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(free) || free[0] : free[0];
        creep.memory.ownSalv = obj.id;
    }
    delete creep.memory.labId;
    if (range(creep.pos, obj.pos) > 1) { movement.go(creep, obj, { range: 1, reusePath: 20 }); return true; }
    if (obj.store) {
        const key = Object.keys(obj.store).find((k) => k !== ENERGY && Number(obj.store[k]) > 0);
        if (key) creep.withdraw(obj, key);
    } else creep.pickup(obj);
    delete creep.memory.ownSalv;
    return true;
}

module.exports = { run, salvage, dying, hasOwnPiles, ownPiles, sinkPlan };
