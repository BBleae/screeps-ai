'use strict';
const movement = require('movement');
const conquest = require('conquest');
const retireMod = require('retire');
const boost = require('boost');

const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;

function goRoom(creep, roomName) {
    movement.go(creep, new RoomPosition(25, 25, roomName), { range: 20, reusePath: 20 });
}

function nonEnergyKey(store) {
    for (const k in store) if (k !== ENERGY && Number(store[k]) > 0) return k;
    return null;
}

const stepCache = { at: -1, by: {} };
function routeSteps(creep, from, to) {
    if (from === to) return 25;
    if (Game.time - stepCache.at > 1500) { stepCache.at = Game.time; stepCache.by = {}; }
    const key = from + ':' + to;
    if (stepCache.by[key] != null) return stepCache.by[key];
    const avoid = movement.lootAvoidFor ? movement.lootAvoidFor(creep, new RoomPosition(25, 25, to)) : null;
    const r = Game.map.findRoute(from, to, { routeCallback: (n) => (n !== to && avoid && avoid.has(n) ? Infinity : 1) });
    const steps = Array.isArray(r) ? r.length * 50 + 25 : Infinity;
    stepCache.by[key] = steps;
    return steps;
}

const DROP_REFRESH = 20000;
function dropList(target) {
    const all = Memory.lootDrop || (Memory.lootDrop = {});
    const rec = all[target];
    if (rec && Game.time - rec.at < DROP_REFRESH && Array.isArray(rec.list) && rec.list.length) return rec.list;
    const lr = require('config').lootRoutes || {};
    const hard = new Set(lr.hardAvoid || []);
    const out = [];
    for (const name in Game.rooms) {
        const r = Game.rooms[name];
        if (!r.controller || !r.controller.my || !r.storage) continue;
        if (Game.map.getRoomLinearDistance(target, name) > 12) continue;
        const route = name === target ? [] : Game.map.findRoute(target, name, { routeCallback: (n) => (n !== name && hard.has(n) ? Infinity : 1) });
        if (!Array.isArray(route)) continue;
        out.push([name, route.length]);
    }
    out.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    all[target] = { at: Game.time, list: out };
    return out;
}

function storageOk(room) {
    const st = room && room.storage;
    if (!st || !st.store) return false;
    const cap = typeof st.store.getCapacity === 'function' ? Number(st.store.getCapacity()) : 1000000;
    const used = typeof st.store.getUsedCapacity === 'function' ? Number(st.store.getUsedCapacity()) : 0;
    return used < cap * (Number((require('config').conquest || {}).lootDropFullShare) || 0.9);
}

function dropRoom(creep) {
    const m = creep.memory;
    const target = m.targetRoom;
    if (!target) return m.home;
    const list = dropList(target);
    for (const [name] of list) if (storageOk(Game.rooms[name])) return name;
    return list.length ? list[0][0] : m.home;
}

function needTicks(creep, from, to) {
    return routeSteps(creep, from, to) * 1.2 + 50;
}

function nearestStorage(creep) {
    const here = creep.room.name;
    if (creep.room.controller && creep.room.controller.my && creep.room.storage) return here;
    let best = null;
    let bestSteps = Infinity;
    for (const name in Game.rooms) {
        const r = Game.rooms[name];
        if (!r.controller || !r.controller.my || !r.storage) continue;
        if (Game.map.getRoomLinearDistance(here, name) * 50 > bestSteps) continue;
        const steps = routeSteps(creep, here, name);
        if (steps < bestSteps || (steps === bestSteps && storageOk(r))) { best = name; bestSteps = steps; }
    }
    return best;
}

function ttlCheck(creep, carrying) {
    const ttl = creep.ticksToLive;
    const m = creep.memory;
    if (ttl == null) return null;
    if (m.dying) return carrying ? 'deliver' : 'retire';
    const here = creep.room.name;
    const drop = dropRoom(creep);
    if (carrying && ttl < needTicks(creep, here, drop)) {
        m.dying = { to: nearestStorage(creep) || drop, at: Game.time, ttl };
        m.state = 'deliver';
        return 'deliver';
    }
    if (!carrying && m.state !== 'deliver') {
        const target = m.targetRoom;
        const out = here === target ? 0 : routeSteps(creep, here, target);
        if (ttl < (out + routeSteps(creep, target, drop)) * 1.2 + 50) return 'retire';
    }
    return null;
}

function freeStand(creep, obj) {
    const room = obj.room;
    if (!room || typeof room.getTerrain !== 'function') return null;
    const terrain = room.getTerrain();
    let best = null;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const x = obj.pos.x + dx;
            const y = obj.pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain.get(x, y) & TERRAIN_MASK_WALL) continue;
            const sts = room.lookForAt(LOOK_STRUCTURES, x, y);
            if (sts.some((st) => !(st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER || (st.structureType === STRUCTURE_RAMPART && (st.my || st.isPublic))))) continue;
            if (room.lookForAt(LOOK_CREEPS, x, y).some((c) => c.name !== creep.name)) continue;
            const d = creep.pos.getRangeTo(x, y);
            if (d < bestD) { bestD = d; best = new RoomPosition(x, y, room.name); }
        }
    }
    return best;
}

function moveNear(creep, obj) {
    const spot = creep.pos.roomName === obj.pos.roomName ? freeStand(creep, obj) : null;
    if (spot) movement.go(creep, spot, { range: 0, reusePath: 5 });
    else movement.go(creep, obj, { range: 1, reusePath: 20 });
}

const DROP_REACH = 3;
function topLoot(res, order) {
    const list = Array.isArray(order) && order.length ? order : [];
    if (list.indexOf('byValue') >= 0) return conquest.lootTier(res) <= 1;
    const cut = list.indexOf('battery');
    if (cut < 0) return false;
    const i = list.indexOf(res);
    return i >= 0 && i <= cut;
}

function topUpDrop(creep, near) {
    if (!creep.store || creep.store.getFreeCapacity() <= 0) return false;
    const drops = ((conquest.coverInfo(creep.room) || {}).dropped || []).filter((r) => r.resourceType === ENERGY && (creep.pos.getRangeTo(r) <= DROP_REACH || (near && near.pos && near.pos.getRangeTo(r) <= DROP_REACH)));
    if (!drops.length) return false;
    const dr = creep.pos.findClosestByRange(drops) || drops[0];
    if (creep.pickup(dr) === ERR_NOT_IN_RANGE) movement.go(creep, dr, { range: 1, reusePath: 5 });
    return true;
}

const PICK_DETOUR = 10;
function routePickup(creep) {
    const m = creep.memory;
    if (m.dying || !creep.store || creep.store.getFreeCapacity() <= 0) { delete m.pick; return false; }
    const lr = require('config').lootRoutes || {};
    const list = lr[m.targetRoom];
    if (!Array.isArray(list) || list.indexOf(creep.room.name) < 0) { delete m.pick; return false; }
    let obj = m.pick ? Game.getObjectById(m.pick) : null;
    if (obj && (obj.pos.roomName !== creep.room.name || creep.pos.getRangeTo(obj) > PICK_DETOUR)) obj = null;
    if (!obj) {
        delete m.pick;
        if (Game.time % 5 !== 0) return false;
        const outbound = m.state !== 'deliver';
        const near = (o) => creep.pos.getRangeTo(o) <= PICK_DETOUR;
        const tombs = creep.room.find(FIND_TOMBSTONES).filter((t) => t.creep && t.creep.my && t.store.getUsedCapacity() > 0 && near(t) && !(outbound && conquest.salvagePickResource(t.store, m.lootOrder) === ENERGY));
        const own = creep.room.controller && creep.room.controller.my;
        const drops = own ? [] : creep.room.find(FIND_DROPPED_RESOURCES).filter((r) => near(r) && (r.resourceType !== ENERGY ? r.amount > 0 : !outbound && r.amount >= 50));
        const all = tombs.concat(drops);
        if (!all.length) return false;
        obj = creep.pos.findClosestByRange(all);
        if (!obj) return false;
        m.pick = obj.id;
    }
    if (obj.store) {
        const res = conquest.salvagePickResource(obj.store, m.lootOrder);
        if (!res || (m.state !== 'deliver' && res === ENERGY)) { delete m.pick; return false; }
        if (creep.withdraw(obj, res) === ERR_NOT_IN_RANGE) movement.go(creep, obj, { range: 1, reusePath: 5 });
    } else if (creep.pickup(obj) === ERR_NOT_IN_RANGE) movement.go(creep, obj, { range: 1, reusePath: 5 });
    return true;
}

function handOff(creep) {
    if (creep.ticksToLive == null || creep.ticksToLive >= 120 || creep.room.name !== creep.memory.targetRoom) return false;
    const res = nonEnergyKey(creep.store) || (creep.store[ENERGY] > 0 ? ENERGY : null);
    if (!res) return false;
    const mate = creep.pos.findInRange(FIND_MY_CREEPS, 1).find((c) => c.memory && c.memory.role === 'lootHauler' && c.ticksToLive > 300 && c.store.getFreeCapacity() > 0);
    if (!mate) return false;
    return creep.transfer(mate, res) === OK;
}

function boostedCarry(creep) {
    return (creep.body || []).some((p) => p.type === CARRY && p.boost);
}

function noteUnload(creep, res, amount) {
    const m = creep.memory;
    const st = Memory.lootStats || (Memory.lootStats = { since: Game.time, by: {} });
    const key = m.targetRoom || '?';
    const rec = st.by[key] || (st.by[key] = { amt: 0, bAmt: 0, nonE: 0, trips: 0, tripT: 0, bTrips: 0, bTripT: 0, to: {} });
    rec.amt += amount;
    if (res !== ENERGY) rec.nonE += amount;
    if (boostedCarry(creep)) rec.bAmt += amount;
    rec.to[creep.room.name] = (rec.to[creep.room.name] || 0) + amount;
}

function noteTrip(creep) {
    const m = creep.memory;
    if (m.tripAt && !m.dying) {
        const st = Memory.lootStats || (Memory.lootStats = { since: Game.time, by: {} });
        const rec = st.by[m.targetRoom];
        if (rec) {
            const t = Game.time - m.tripAt;
            rec.trips++;
            rec.tripT += t;
            if (boostedCarry(creep)) { rec.bTrips++; rec.bTripT += t; }
        }
    }
    m.tripAt = Game.time;
}

function deliver(creep) {
    if (handOff(creep)) return true;
    const m = creep.memory;
    const home = m.dying && m.dying.to ? m.dying.to : dropRoom(creep);
    m.drop = home;
    const room = Game.rooms[home];
    if (!room || creep.room.name !== home || !room.storage) {
        if (routePickup(creep)) return true;
        goRoom(creep, home);
        return true;
    }
    const carrying = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() > 0 : false;
    if (!carrying) { noteTrip(creep); return false; }
    const order = m.lootOrder;
    const res = conquest.salvagePickResource(creep.store, order) || nonEnergyKey(creep.store) || ENERGY;
    const term = room.terminal;
    const used = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() : 0;
    const dest = !storageOk(room) && term && term.my !== false && term.store && typeof term.store.getFreeCapacity === 'function' && term.store.getFreeCapacity() >= used + 20000 ? term : room.storage;
    const amount = Number(creep.store[res] || 0);
    const ret = creep.transfer(dest, res);
    if (ret === ERR_NOT_IN_RANGE) movement.go(creep, dest, { range: 1, reusePath: 15 });
    else if (ret === OK) noteUnload(creep, res, Math.min(amount, typeof dest.store.getFreeCapacity === 'function' ? Number(dest.store.getFreeCapacity(res)) || amount : amount));
    return true;
}


function parkInside(creep) {
    const p = creep.pos;
    if (p.x > 2 && p.x < 47 && p.y > 2 && p.y < 47) return;
    const anchor = creep.room.find(FIND_MY_CREEPS).find((c) => c.memory && c.memory.role === 'siegeDismantler');
    movement.go(creep, anchor ? anchor.pos : new RoomPosition(25, 25, creep.room.name), { range: anchor ? 3 : 5, reusePath: 20 });
}

const mateCache = { tick: -1, by: {} };
function salvageMates(target) {
    if (mateCache.tick !== Game.time) { mateCache.tick = Game.time; mateCache.by = {}; }
    if (!mateCache.by[target]) {
        mateCache.by[target] = Object.keys(Game.creeps).filter((n) => {
            const m = Game.creeps[n].memory;
            return m && m.role === 'lootHauler' && m.salvageLoot && !m.retired && m.targetRoom === target;
        }).sort();
    }
    return mateCache.by[target];
}

function keepCount(target) {
    for (const d of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (d && d.target === target && d.keepHaulers != null) return Number(d.keepHaulers) || 0;
    return 2;
}

function toPull(creep) {
    const pd = conquest.pullDirective();
    if (!pd) return false;
    const m = creep.memory;
    m.salvageFrom = m.targetRoom;
    m.salvageOrder = m.lootOrder;
    m.targetRoom = pd.target;
    m.pullLoot = true;
    m.pull = pd.pull;
    delete m.deliverTo;
    m.lootOrder = pd.lootOrder;
    delete m.salvageLoot;
    delete m.ruin;
    delete m.src;
    return true;
}

function backToSalvage(creep) {
    const m = creep.memory;
    const room = Game.rooms[m.salvageFrom];
    if (!room || conquest.storesLocked(room)) return;
    m.targetRoom = m.salvageFrom;
    m.salvageLoot = true;
    m.lootOrder = m.salvageOrder;
    for (const k of ['pullLoot', 'pull', 'src', 'salvageFrom', 'salvageOrder', 'salvageDeliver', 'deliverTo']) delete m[k];
}

function lootHoldRun(creep) {
    if (typeof Memory === 'undefined') return false;
    const m = creep.memory;
    if (m.retired) return false;
    const lr = require('config').lootRoutes || {};
    const list = lr[m.targetRoom];
    const back = lr.reentry && lr.reentry[creep.room.name];
    if (back && Array.isArray(list) && list.indexOf(creep.room.name) < 0) {
        movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 50, avoidRooms: new Set(lr.hardAvoid || []) });
        return true;
    }
    const h = Memory.lootHold;
    if (!h || !(h === true || h[m.targetRoom])) return false;
    const home = m.home;
    if (!home) return false;
    if (creep.room.name !== home) { movement.go(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 }); return true; }
    const p = creep.pos;
    if (p.x <= 2 || p.x >= 47 || p.y <= 2 || p.y >= 47) movement.go(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 });
    return true;
}

const GATE_STALE = 50;
function gateArmed(name) {
    const mem = Memory.lootGate || (Memory.lootGate = {});
    const room = Game.rooms[name];
    if (room) {
        const utils = require('utils');
        const armed = room.find(FIND_HOSTILE_CREEPS).filter((c) => !utils.isAlly(c) && (c.body || []).some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK)));
        const rec = mem[name];
        if (!rec || rec.at !== Game.time) mem[name] = { at: Game.time, n: armed.length, user: armed.length && armed[0].owner ? armed[0].owner.username : null };
        return armed.length > 0;
    }
    const rec = mem[name];
    if (rec && Game.time - rec.at < GATE_STALE) return rec.n > 0;
    if (!rec || !rec.obsAt || Game.time - rec.obsAt > 5) {
        for (const r of Object.values(Game.rooms)) {
            if (!r.controller || !r.controller.my) continue;
            if (Game.map.getRoomLinearDistance(r.name, name) > 10) continue;
            const obs = r.find(FIND_MY_STRUCTURES).find((x) => x.structureType === STRUCTURE_OBSERVER);
            if (obs && obs.observeRoom(name) === OK) { mem[name] = Object.assign({}, rec || { at: 0, n: 0 }, { obsAt: Game.time }); break; }
        }
    }
    return rec ? rec.n > 0 : false;
}

function nextRoom(creep, dest) {
    const m = creep.memory;
    const here = creep.room.name;
    if (m.gNext && m.gNext.from === here && m.gNext.to === dest && Game.time - m.gNext.at < 20) return m.gNext.next;
    const avoid = movement.lootAvoidFor ? movement.lootAvoidFor(creep, new RoomPosition(25, 25, dest)) : null;
    const r = here === dest ? [] : Game.map.findRoute(here, dest, { routeCallback: (n) => (n !== dest && avoid && avoid.has(n) ? Infinity : 1) });
    const next = Array.isArray(r) && r.length ? r[0].room : null;
    m.gNext = { from: here, to: dest, next, at: Game.time };
    return next;
}

function gateHold(creep) {
    const lr = require('config').lootRoutes || {};
    const gates = lr.gates || {};
    const gateRooms = Array.isArray(lr.gateRooms) ? lr.gateRooms : [];
    const here = creep.room.name;
    const m = creep.memory;
    if (creep.spawning) return false;
    const back = m.retired || m.state === 'deliver';
    const dest = back ? (m.retired ? m.home : (m.dying && m.dying.to) || m.drop || m.home) : m.targetRoom;
    if (!dest || dest === here) { delete m.gateWait; return false; }
    const route = Array.isArray(lr[m.targetRoom]) ? lr[m.targetRoom] : [];
    const onRoute = route.indexOf(here) >= 0 || gateRooms.indexOf(here) >= 0 || Object.keys(gates).some((g) => Array.isArray(gates[g]) && gates[g].indexOf(here) >= 0);
    if (!onRoute || !(Game.map && typeof Game.map.findRoute === 'function')) { delete m.gateWait; return false; }
    const gate = nextRoom(creep, dest);
    if (!gate || gate === dest && !back) { delete m.gateWait; return false; }
    const listed = gateRooms.indexOf(gate) >= 0 || (Array.isArray(gates[gate]) && gates[gate].indexOf(here) >= 0);
    if (!listed) { delete m.gateWait; return false; }
    if (!gateArmed(gate) || (gateRooms.indexOf(here) >= 0 && gateArmed(here))) { delete m.gateWait; return false; }
    if (!m.gateWait) m.gateWait = Game.time;
    const p = creep.pos;
    if (p.x <= 2 || p.x >= 47 || p.y <= 2 || p.y >= 47) movement.go(creep, new RoomPosition(25, 25, here), { range: 10, reusePath: 20 });
    return true;
}

function track(creep) {
    const m = creep.memory;
    m.dk = [creep.room.name, creep.pos.x, creep.pos.y, creep.ticksToLive, Game.time];
    const used = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() : 0;
    if (!used) { delete m.ds; return; }
    const ds = {};
    for (const k in creep.store) if (Number(creep.store[k]) > 0) ds[k] = creep.store[k];
    m.ds = ds;
}

function noteDeath(name, mem) {
    if (!mem || mem.role !== 'lootHauler' || !Array.isArray(mem.dk)) return;
    const log = Array.isArray(Memory.haulerDeaths) ? Memory.haulerDeaths : (Memory.haulerDeaths = []);
    log.push({ name, at: Game.time, room: mem.dk[0], x: mem.dk[1], y: mem.dk[2], ttl: mem.dk[3], seen: mem.dk[4], store: mem.ds || {}, home: mem.home, target: mem.targetRoom, dying: mem.dying || null });
    while (log.length > 50) log.shift();
}

function run(creep) {
    if (creep.spawning) return;
    track(creep);
    if (creep.memory.boosts && creep.room.name === creep.memory.home && boost.run(creep)) return;
    if (lootHoldRun(creep)) return;
    if (gateHold(creep)) return;
    if (creep.memory.pullLoot && creep.memory.salvageFrom && Game.time % 10 === 0) backToSalvage(creep);
    const target = creep.memory.targetRoom;
    const home = creep.memory.home;
    if (!target || !home) return;
    const salvage = !!creep.memory.salvageLoot;
    const full = creep.store.getFreeCapacity ? creep.store.getFreeCapacity() <= 0 : false;
    const carrying = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() > 0 : false;
    const retreat = conquest.retreatFor(target);
    if (conquest.boostGateHold(target)) {
        if (!carrying && creep.room.name !== home) { goRoom(creep, home); return; }
        if (!carrying) return;
    }
    const due = ttlCheck(creep, carrying);
    if (due === 'retire') { retireMod.retireAtSpawn(creep); return; }
    if (full || retreat || due === 'deliver' || creep.memory.state === 'deliver') {
        creep.memory.state = 'deliver';
        if (!deliver(creep)) {
            if (retreat || creep.memory.dying) { retireMod.retireAtSpawn(creep); return; }
            delete creep.memory.state;
        }
        return;
    }
    if (retreat) { creep.memory.state = 'deliver'; return; }
    if (creep.room.name !== target) { if (!routePickup(creep)) goRoom(creep, target); return; }
    if (creep.memory.pullLoot) {
        let src = creep.memory.src && Game.getObjectById(creep.memory.src);
        if (!src || !(src.store && src.store.getUsedCapacity() > 0)) {
            src = null;
            for (const id of creep.memory.pull || []) {
                const o = Game.getObjectById(id);
                if (o && o.store && o.store.getUsedCapacity() > 0) { src = o; break; }
            }
            creep.memory.src = src ? src.id : null;
        }
        if (!src) { if (carrying) creep.memory.state = 'deliver'; else retireMod.retireAtSpawn(creep); return; }
        const res = conquest.salvagePickResource(src.store, creep.memory.lootOrder);
        if (!res) { creep.memory.state = 'deliver'; return; }
        if (creep.withdraw(src, res) === ERR_NOT_IN_RANGE) movement.go(creep, src, { range: 1, reusePath: 50 });
        return;
    }
    if (salvage) {
        const cachedRuin = creep.memory.ruin && Game.getObjectById(creep.memory.ruin);
        if (cachedRuin && Game.time % 5 !== 0) {
            const r0 = conquest.salvagePickResource(cachedRuin.store, creep.memory.lootOrder);
            if (r0 && !topLoot(r0, creep.memory.lootOrder) && topUpDrop(creep, cachedRuin)) return;
            if (r0) {
                if (creep.withdraw(cachedRuin, r0) === ERR_NOT_IN_RANGE) moveNear(creep, cachedRuin);
                return;
            }
        }
        delete creep.memory.ruin;
        const threat = conquest.salvageArmedThreat(creep.room);
        if (threat) {
            creep.memory.state = 'deliver';
            deliver(creep);
            return;
        }
        const ruins = conquest.salvageUncovered(creep.room);
        if (conquest.storesLocked(creep.room)) {
            const idx = salvageMates(target).indexOf(creep.name);
            const drops = (conquest.coverInfo(creep.room) || {}).dropped || [];
            if ((idx >= keepCount(target) || (!ruins.length && !drops.length)) && !carrying && toPull(creep)) return;
        }
        if (!ruins.length) {
            const drops = (conquest.coverInfo(creep.room) || {}).dropped || [];
            if (drops.length && !full) {
                const dr = creep.pos.findClosestByRange(drops) || drops[0];
                if (creep.pickup(dr) === ERR_NOT_IN_RANGE) movement.go(creep, dr, { range: 1, reusePath: 20 });
                return;
            }
            if (carrying) { creep.memory.state = 'deliver'; return; }
            parkInside(creep);
            return;
        }
        const order = creep.memory.lootOrder;
        ruins.sort((a, b) => conquest.salvagePriorityScore(b.store, order) - conquest.salvagePriorityScore(a.store, order));
        const best = conquest.salvagePriorityScore(ruins[0].store, order);
        const tied = ruins.filter((o) => conquest.salvagePriorityScore(o.store, order) === best).slice(0, 5);
        const c = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(tied) || ruins[0] : ruins[0];
        const res = conquest.salvagePickResource(c.store, order);
        if (!res) { creep.memory.state = 'deliver'; return; }
        if (!topLoot(res, order) && topUpDrop(creep, c)) return;
        creep.memory.ruin = c.id;
        if (creep.withdraw(c, res) === ERR_NOT_IN_RANGE) moveNear(creep, c);
        return;
    }
    const containers = conquest.lootContainersOf(creep.room, creep.memory.lootTiles);
    if (!containers.length) { if (carrying) creep.memory.state = 'deliver'; else parkInside(creep); return; }
    const c = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(containers) : containers[0];
    const res = nonEnergyKey(c.store);
    if (!res) { creep.memory.state = 'deliver'; return; }
    if (creep.withdraw(c, res) === ERR_NOT_IN_RANGE) movement.go(creep, c, { range: 1, reusePath: 5 });
}

module.exports = { run, freeStand, topLoot, topUpDrop, gateArmed, gateHold, noteDeath, dropList, dropRoom, ttlCheck, routePickup, needTicks };
