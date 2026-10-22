'use strict';
const movement = require('movement');
const conquest = require('conquest');
const retireMod = require('retire');
const boost = require('boost');
const lootBlocked = require('loot_blocked');
const sideLoot = require('side_loot');

const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;

function mv(creep, target, opts) {
    return movement.go(creep, target, creep.memory && creep.memory.sideLoot ? sideLoot.moveOpts(creep, opts) : opts);
}

function goRoom(creep, roomName) {
    mv(creep, new RoomPosition(25, 25, roomName), { range: 20, reusePath: 20 });
}

function nonEnergyKey(store) {
    for (const k in store) if (k !== ENERGY && Number(store[k]) > 0) return k;
    return null;
}

const STEP_REFRESH = 20000;
const STEP_RETRY = 1500;
const stepBudget = { at: -1, n: 0 };

function anchor(name) {
    const r = Game.rooms[name];
    if (r && r.storage && r.storage.pos) return r.storage.pos;
    return new RoomPosition(25, 25, name);
}

function roomCount(from, to, hard) {
    const r = Game.map.findRoute(from, to, { routeCallback: (n) => (n !== to && hard && hard.has(n) ? Infinity : 1) });
    return Array.isArray(r) ? r : null;
}

function pathCalc(from, to, hard) {
    const route = roomCount(from, to, hard);
    if (!route) return { s: Infinity, n: Infinity, ok: 0 };
    const rough = route.length * 50 + 25;
    if (typeof PathFinder === 'undefined' || !PathFinder.search) return { s: rough, n: rough, ok: 0 };
    const allowed = new Set([from].concat(route.map((x) => x.room)));
    const res = PathFinder.search(anchor(from), { pos: anchor(to), range: 1 }, {
        plainCost: 1,
        swampCost: 5,
        maxOps: 20000,
        maxRooms: allowed.size + 1,
        roomCallback: (name) => {
            if (!allowed.has(name)) return false;
            const room = Game.rooms[name];
            if (!room) return undefined;
            const cm = new PathFinder.CostMatrix();
            for (const st of room.find(FIND_STRUCTURES)) {
                if (st.structureType === STRUCTURE_ROAD) cm.set(st.pos.x, st.pos.y, 1);
                else if (st.structureType === STRUCTURE_CONTAINER) continue;
                else if (st.structureType === STRUCTURE_RAMPART && st.my) continue;
                else cm.set(st.pos.x, st.pos.y, 255);
            }
            return cm;
        },
    });
    if (!res || res.incomplete || !Array.isArray(res.path) || !Number.isFinite(res.cost)) return { s: rough, n: rough, ok: 0 };
    return { s: res.cost, n: res.path.length, ok: 1 };
}

function pathSteps(from, to) {
    if (from === to) return 25;
    const all = Memory.lootDrop || (Memory.lootDrop = {});
    const book = all._steps || (all._steps = {});
    const key = from + ':' + to;
    const rec = book[key];
    if (rec && Game.time - rec.at < (rec.ok ? STEP_REFRESH : STEP_RETRY)) return rec.s;
    if (stepBudget.at !== Game.time) { stepBudget.at = Game.time; stepBudget.n = 0; }
    const lr = require('config').lootRoutes || {};
    const hard = new Set(lr.hardAvoid || []);
    if (stepBudget.n >= 1) {
        if (rec) return rec.s;
        const route = roomCount(from, to, hard);
        return route ? route.length * 50 + 25 : Infinity;
    }
    stepBudget.n++;
    let got;
    try { got = pathCalc(from, to, hard); } catch (e) {
        const route = roomCount(from, to, hard);
        const rough = route ? route.length * 50 + 25 : Infinity;
        got = { s: rough, n: rough, ok: 0 };
    }
    book[key] = { s: got.s, n: got.n, ok: got.ok, at: Game.time };
    return got.s;
}

function routeSteps(creep, from, to) {
    return pathSteps(from, to);
}

function emptySteps(from, to) {
    const s = pathSteps(from, to);
    const rec = Memory.lootDrop && Memory.lootDrop._steps && Memory.lootDrop._steps[from + ':' + to];
    return rec && rec.ok && rec.n > 0 ? rec.n : s;
}

const DROP_REFRESH = 20000;
function dropList(target) {
    const all = Memory.lootDrop || (Memory.lootDrop = {});
    const rec = all[target];
    if (rec && rec.v === 3 && Game.time - rec.at < DROP_REFRESH && Array.isArray(rec.list) && rec.list.length) return rec.list;
    const lr = require('config').lootRoutes || {};
    const onRoute = new Set(Array.isArray(lr[target]) ? lr[target] : []);
    const out = [];
    let partial = false;
    for (const name in Game.rooms) {
        const r = Game.rooms[name];
        if (!r.controller || !r.controller.my || !r.storage) continue;
        if (Game.map.getRoomLinearDistance(target, name) > 12) continue;
        const steps = pathSteps(target, name);
        if (!Number.isFinite(steps)) continue;
        const book = all._steps && all._steps[target + ':' + name];
        if (name !== target && !(book && book.ok)) partial = true;
        out.push([name, steps, onRoute.has(name) ? 0 : 1]);
    }
    out.sort((a, b) => a[1] - b[1] || a[2] - b[2] || (a[0] < b[0] ? -1 : 1));
    all[target] = { v: 3, at: partial ? Game.time - DROP_REFRESH + 100 : Game.time, list: out };
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
    if (m.sideLoot) {
        const u = sideLoot.unloadRoom(creep, pathSteps, storageOk);
        if (u) return u;
    }
    const fixed = ((require('config').conquest || {}).lootDropFixed || {})[target];
    if (fixed && storageOk(Game.rooms[fixed])) return fixed;
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
        const out = here === target ? 0 : emptySteps(here, target);
        if (ttl < out + needTicks(creep, target, drop)) return 'retire';
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
        if (creep.withdraw(obj, res) === ERR_NOT_IN_RANGE) mv(creep, obj, { range: 1, reusePath: 5 });
    } else if (creep.pickup(obj) === ERR_NOT_IN_RANGE) mv(creep, obj, { range: 1, reusePath: 5 });
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

function lootStats() {
    const cur = Memory.lootStats;
    if (cur && cur.v === 2) return cur;
    Memory.lootStats = { v: 2, since: Game.time, by: {}, hours: [] };
    if (cur) Memory.lootStats.prev = { since: cur.since, until: Game.time, by: cur.by };
    return Memory.lootStats;
}

function noteUnload(creep, res, amount) {
    const m = creep.memory;
    const st = lootStats();
    const key = m.targetRoom || '?';
    const rec = st.by[key] || (st.by[key] = { amt: 0, bAmt: 0, nonE: 0, trips: 0, tN: 0, tripT: 0, bTrips: 0, bTN: 0, bTripT: 0, to: {}, res: {} });
    rec.amt += amount;
    if (res !== ENERGY) rec.nonE += amount;
    if (boostedCarry(creep)) rec.bAmt += amount;
    rec.to[creep.room.name] = (rec.to[creep.room.name] || 0) + amount;
    const byRes = rec.res || (rec.res = {});
    byRes[res] = (byRes[res] || 0) + amount;
    const hourKey = new Date().toISOString().slice(0, 13);
    const hours = Array.isArray(st.hours) ? st.hours : (st.hours = []);
    let h = hours[hours.length - 1];
    if (!h || h.h !== hourKey) { h = { h: hourKey, at: Game.time, by: {} }; hours.push(h); while (hours.length > 24) hours.shift(); }
    const hb = h.by[key] || (h.by[key] = {});
    hb[res] = (hb[res] || 0) + amount;
}

function noteTrip(creep) {
    const m = creep.memory;
    const st = lootStats();
    const rec = st.by[m.targetRoom || '?'];
    if (rec) {
        const b = boostedCarry(creep);
        rec.trips++;
        if (b) rec.bTrips++;
        if (m.tripAt && !m.dying) {
            const t = Game.time - m.tripAt;
            rec.tN++;
            rec.tripT += t;
            if (b) { rec.bTN++; rec.bTripT += t; }
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
    if (!carrying) { noteTrip(creep); delete m.src; delete m.lootTier; return false; }
    const res = biggest(creep.store) || ENERGY;
    const term = room.terminal;
    const used = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() : 0;
    const dest = !storageOk(room) && term && term.my !== false && term.store && typeof term.store.getFreeCapacity === 'function' && term.store.getFreeCapacity() >= used + 20000 ? term : room.storage;
    const amount = Number(creep.store[res] || 0);
    const ret = creep.transfer(dest, res);
    if (ret === ERR_NOT_IN_RANGE) mv(creep, dest, { range: 1, reusePath: 15 });
    else if (ret === OK) noteUnload(creep, res, Math.min(amount, typeof dest.store.getFreeCapacity === 'function' ? Number(dest.store.getFreeCapacity(res)) || amount : amount));
    return true;
}


function parkInside(creep) {
    const p = creep.pos;
    if (p.x > 2 && p.x < 47 && p.y > 2 && p.y < 47) return;
    const anchor = creep.room.find(FIND_MY_CREEPS).find((c) => c.memory && c.memory.role === 'siegeDismantler');
    mv(creep, anchor ? anchor.pos : new RoomPosition(25, 25, creep.room.name), { range: anchor ? 3 : 5, reusePath: 20 });
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
    if (!room || !conquest.loadTargets(room).length) return;
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
        mv(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 50, avoidRooms: new Set(lr.hardAvoid || []) });
        return true;
    }
    const h = Memory.lootHold;
    if (!h || !(h === true || h[m.targetRoom])) return false;
    const home = m.home;
    if (!home) return false;
    if (creep.room.name !== home) { mv(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 }); return true; }
    const p = creep.pos;
    if (p.x <= 2 || p.x >= 47 || p.y <= 2 || p.y >= 47) mv(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 });
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
    if (p.x <= 2 || p.x >= 47 || p.y <= 2 || p.y >= 47) mv(creep, new RoomPosition(25, 25, here), { range: 10, reusePath: 20 });
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
    log.push({ name, at: Game.time, room: mem.dk[0], x: mem.dk[1], y: mem.dk[2], ttl: mem.dk[3], seen: mem.dk[4], store: mem.ds || {}, home: mem.home, target: mem.targetRoom, dying: mem.dying || null, retired: !!(mem.retireSpawn || mem.retired) });
    while (log.length > 50) log.shift();
}

const STALE_KEYS = ['deliverTo', 'energyTo', 'salvageDeliver'];

function boostHere(creep) {
    const m = creep.memory;
    const at = m.boostRoom || m.home;
    if (creep.room.name !== at) return false;
    if (m.home === at && !m.tripAt) return true;
    const used = creep.store && creep.store.getUsedCapacity ? creep.store.getUsedCapacity() : 0;
    return !!m.tripAt && m.drop === at && !used;
}

function dropStaleBoosts(creep) {
    const m = creep.memory;
    if (!Array.isArray(m.boosts) || !m.boosts.length) return false;
    const hb = ((require('config').conquest || {}).haulerBoost || {})[m.targetRoom];
    const allowed = hb && Array.isArray(hb.compounds) && Array.isArray(hb.homes) && hb.homes.indexOf(m.home) >= 0 ? hb.compounds : [];
    const keep = m.boosts.filter((c) => allowed.indexOf(c) >= 0);
    if (keep.length === m.boosts.length) return false;
    if (keep.length) m.boosts = keep;
    else {
        delete m.boosts;
        delete m.boostMinParts;
        delete m.boostRoom;
        delete m.boostReserve;
        delete m.boostSince;
        m.boostDone = true;
    }
    return true;
}

function boostedWith(creep, list) {
    return (creep.body || []).some((p) => p.boost && list.indexOf(p.boost) >= 0);
}

const BAD_RETRY = 1500;
const STUCK_TICKS = 10;

function distTo(creep, obj) {
    if (creep.pos.roomName === obj.pos.roomName) return creep.pos.getRangeTo(obj);
    const rooms = Game.map.getRoomLinearDistance(creep.pos.roomName, obj.pos.roomName);
    return rooms * 50 + Math.max(Math.abs(creep.pos.x - obj.pos.x), Math.abs(creep.pos.y - obj.pos.y));
}

function queued(creep, obj) {
    if (creep.pos.roomName !== obj.pos.roomName || creep.pos.getRangeTo(obj) > 3) return false;
    return !freeStand(creep, obj);
}

function stuckTick(creep, obj) {
    const m = creep.memory;
    const t = Array.isArray(m.stk) ? m.stk : (m.stk = [Infinity, 0]);
    if (creep.fatigue > 0) return t[1];
    if (queued(creep, obj)) { t[0] = Infinity; t[1] = 0; return 0; }
    const d = distTo(creep, obj);
    if (d < t[0]) { t[0] = d; t[1] = 0; } else t[1]++;
    return t[1];
}
const OBSTACLES = new Set(typeof OBSTACLE_OBJECT_TYPES !== 'undefined' ? OBSTACLE_OBJECT_TYPES : ['spawn', 'extension', 'constructedWall', 'link', 'storage', 'tower', 'observer', 'powerSpawn', 'extractor', 'lab', 'terminal', 'nuker', 'factory', 'invaderCore']);

function badBook(roomName) {
    const all = Memory.lootBad || (Memory.lootBad = {});
    const book = all[roomName] || (all[roomName] = {});
    for (const id in book) if (Game.time - book[id] >= BAD_RETRY) delete book[id];
    return book;
}

const matrixCache = { tick: -1, by: {} };
function loadMatrix(room) {
    if (matrixCache.tick !== Game.time) { matrixCache.tick = Game.time; matrixCache.by = {}; }
    if (matrixCache.by[room.name]) return matrixCache.by[room.name];
    const cm = new PathFinder.CostMatrix();
    for (const st of room.find(FIND_STRUCTURES)) {
        if (st.structureType === STRUCTURE_ROAD) { if (!cm.get(st.pos.x, st.pos.y)) cm.set(st.pos.x, st.pos.y, 1); }
        else if (conquest.hostileRampart(st) || OBSTACLES.has(st.structureType)) cm.set(st.pos.x, st.pos.y, 255);
    }
    matrixCache.by[room.name] = cm;
    return cm;
}

function closestByPath(creep, list) {
    if (!list.length) return { obj: null, incomplete: false };
    const goals = list.map((o) => ({ pos: o.pos, range: 1 }));
    const res = PathFinder.search(creep.pos, goals, {
        plainCost: 1, swampCost: 5, maxRooms: 1, maxOps: 4000,
        roomCallback: (name) => (name === creep.room.name ? loadMatrix(creep.room) : false),
    });
    if (!res || res.incomplete) return { obj: null, incomplete: true };
    const end = res.path.length ? res.path[res.path.length - 1] : creep.pos;
    let best = null;
    let bestR = Infinity;
    for (const o of list) {
        const r = Math.max(Math.abs(o.pos.x - end.x), Math.abs(o.pos.y - end.y));
        if (r <= 1 && r < bestR) { best = o; bestR = r; }
    }
    return { obj: best, incomplete: false };
}

function reachable(creep, obj) {
    if (creep.pos.roomName !== obj.pos.roomName) return true;
    const res = PathFinder.search(creep.pos, { pos: obj.pos, range: 1 }, {
        plainCost: 1, swampCost: 5, maxRooms: 1, maxOps: 4000,
        roomCallback: (name) => (name === creep.room.name ? loadMatrix(creep.room) : false),
    });
    if (!res || res.incomplete) return false;
    const end = res.path.length ? res.path[res.path.length - 1] : creep.pos;
    return Math.max(Math.abs(obj.pos.x - end.x), Math.abs(obj.pos.y - end.y)) <= 1;
}

const SKIP_TICKS = 30;

function biggest(store) {
    let best = null;
    for (const k in store) {
        const n = Number(store[k]);
        if (n > 0 && (!best || n > Number(store[best]))) best = k;
    }
    return best;
}

function isT3(res) {
    return /^X[A-Z0-9]+$/.test(res);
}

function resRank(res) {
    if (isT3(res)) return 0;
    if (res === 'battery') return 1;
    if (res === ENERGY) return 3;
    return 2;
}

function loadPick(store, order) {
    if (Array.isArray(order) && order.length) {
        const r = conquest.salvagePickResource(store, order);
        if (r) return r;
    }
    let best = null;
    let bestR = Infinity;
    for (const k in store) {
        const n = Number(store[k]);
        if (!(n > 0)) continue;
        const r = resRank(k);
        if (r < bestR || (r === bestR && n > Number(store[best]))) { best = k; bestR = r; }
    }
    return best;
}

function tierOf(obj) {
    if (!obj) return 3;
    if (!obj.store) return obj.resourceType && isT3(obj.resourceType) ? 1 : obj.resourceType === 'battery' ? 2 : 3;
    let t = 3;
    for (const k in obj.store) {
        if (!(Number(obj.store[k]) > 0)) continue;
        if (isT3(k)) return 1;
        if (k === 'battery') t = 2;
    }
    return t;
}

function pickTarget(creep) {
    const m = creep.memory;
    const book = badBook(creep.room.name);
    let list = conquest.loadTargets(creep.room).filter((o) => !book[o.id]);
    if (m.skip && Game.time - m.skip[1] < SKIP_TICKS) {
        const rest = list.filter((o) => o.id !== m.skip[0]);
        if (rest.length) list = rest;
    } else if (m.skip) delete m.skip;
    const tiers = [[], [], []];
    if (m.sideLoot && Array.isArray(m.lootOrder) && m.lootOrder.length) {
        let top = 0;
        for (const o of list) top = Math.max(top, sideLoot.orderScore(o, m.lootOrder));
        for (const o of list) tiers[sideLoot.orderScore(o, m.lootOrder) === top ? 0 : 2].push(o);
    } else {
        tiers.splice(2, 0, []);
        for (const o of list) {
            const t = tierOf(o);
            tiers[t < 3 ? t - 1 : (o.structureType === STRUCTURE_STORAGE || o.structureType === STRUCTURE_TERMINAL ? 2 : 3)].push(o);
        }
    }
    let obj = null;
    let tier = 0;
    for (let i = 0; i < tiers.length && !obj; i++) {
        if (!tiers[i].length) continue;
        const got = closestByPath(creep, tiers[i]);
        if (got.incomplete) for (const o of tiers[i]) { book[o.id] = Game.time; lootBlocked.note(creep.room.name, o); }
        if (got.obj) { obj = got.obj; tier = i + 1; }
    }
    try { lootBlocked.analyze(creep.room, creep.pos); } catch (e) { }
    delete m.stk;
    if (!obj) { delete m.src; delete m.lootTier; return null; }
    m.src = obj.id;
    m.lootTier = tier;
    return obj;
}

function stillLoadable(obj, roomName) {
    if (!obj || !obj.pos || obj.pos.roomName !== roomName) return false;
    return obj.store ? conquest.usedOf(obj.store) > 0 : Number(obj.amount) > 0;
}

function haulThreat(room) {
    const c = conquest.salvageArmedThreat(room);
    if (!c) return null;
    const towers = (room.find(FIND_HOSTILE_STRUCTURES) || []).some((s) => s.structureType === STRUCTURE_TOWER);
    if (towers) return c;
    const utils = require('utils');
    return (room.find(FIND_HOSTILE_CREEPS) || []).find((h) => !utils.isAlly(h) && (h.body || []).some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK))) || null;
}

function loadStep(creep, carrying) {
    const m = creep.memory;
    let obj = m.src ? Game.getObjectById(m.src) : null;
    if (haulThreat(creep.room)) { if (carrying) m.state = 'deliver'; else parkInside(creep); return; }
    if (!m.sideLoot && stillLoadable(obj, creep.room.name) && creep.pos.getRangeTo(obj) > 1 && tierOf(obj) > (m.lootTier || 3)) obj = null;
    if (!stillLoadable(obj, creep.room.name)) obj = pickTarget(creep);
    if (!obj && !carrying && Memory.lootBad && Memory.lootBad[creep.room.name] && Object.keys(Memory.lootBad[creep.room.name]).length && !(Game.time - (m.badClr || 0) < 50)) {
        m.badClr = Game.time;
        delete Memory.lootBad[creep.room.name];
        obj = pickTarget(creep);
    }
    if (!obj) {
        if (carrying) { m.state = 'deliver'; return; }
        if (m.sideLoot) {
            if (sideLoot.mem(m.targetRoom).doneAt) retireMod.retireAtSpawn(creep);
            else parkInside(creep);
            return;
        }
        if (toPull(creep)) return;
        parkInside(creep);
        return;
    }
    const range = creep.pos.getRangeTo(obj);
    if (range > 1) {
        const k = stuckTick(creep, obj);
        if (k >= STUCK_TICKS) {
            if (reachable(creep, obj)) m.skip = [obj.id, Game.time];
            else { badBook(creep.room.name)[obj.id] = Game.time; lootBlocked.note(creep.room.name, obj); }
            delete m.src; delete m.stk;
            return;
        }
        mv(creep, obj, { range: 1, reusePath: 5 });
        return;
    }
    delete m.stk;
    const ret = obj.store ? creep.withdraw(obj, loadPick(obj.store, m.sideLoot ? m.lootOrder : null)) : creep.pickup(obj);
    if (ret !== OK && ret !== ERR_NOT_IN_RANGE) { badBook(creep.room.name)[obj.id] = Game.time; delete m.src; delete m.stk; }
}

function run(creep) {
    if (creep.spawning) return;
    track(creep);
    const m0 = creep.memory;
    for (const k of STALE_KEYS) if (m0[k] !== undefined) delete m0[k];
    dropStaleBoosts(creep);
    if (Array.isArray(m0.boosts) && m0.boosts.length) {
        if (boostedWith(creep, m0.boosts)) m0.boostDone = true;
        else if (m0.boostDone) delete m0.boostDone;
        if (m0.boostSince !== undefined) delete m0.boostSince;
        if (!m0.boostDone && boostHere(creep) && boost.nextJob(creep) && boost.apply(creep)) return;
    }
    if (m0.sideLoot && sideLoot.noteDamage(creep) && creep.room.name !== m0.home && sideLoot.armed(creep.room).length) {
        if (creep.store.getUsedCapacity && creep.store.getUsedCapacity() > 0) m0.state = 'deliver';
        else { goRoom(creep, m0.home); return; }
    }
    if (lootHoldRun(creep)) return;
    if (gateHold(creep)) return;
    if (creep.memory.pullLoot && creep.memory.salvageFrom && Game.time % 10 === 0) backToSalvage(creep);
    const target = creep.memory.targetRoom;
    const home = creep.memory.home;
    if (!target || !home) return;
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
    loadStep(creep, carrying);
}

module.exports = { dropStaleBoosts, reachable, queued, pathSteps, pathCalc, boostHere, run, freeStand, stuckTick, closestByPath, loadStep, pickTarget, biggest, loadPick, tierOf, gateArmed, gateHold, noteDeath, dropList, dropRoom, ttlCheck, routePickup, needTicks };
