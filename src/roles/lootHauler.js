'use strict';
const movement = require('movement');
const conquest = require('conquest');
const retireMod = require('retire');

const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;

function goRoom(creep, roomName) {
    movement.go(creep, new RoomPosition(25, 25, roomName), { range: 20, reusePath: 20 });
}

function nonEnergyKey(store) {
    for (const k in store) if (k !== ENERGY && Number(store[k]) > 0) return k;
    return null;
}

function deliver(creep, home) {
    if (creep.memory.deliverTo) home = creep.memory.deliverTo;
    const room = Game.rooms[home];
    if (!room || creep.room.name !== home || !room.storage) { goRoom(creep, home); return true; }
    const carrying = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() > 0 : false;
    if (!carrying) return false;
    const order = creep.memory.lootOrder;
    const res = (creep.memory.salvageLoot ? conquest.salvagePickResource(creep.store, order) : null) || nonEnergyKey(creep.store) || ENERGY;
    const term = room.terminal;
    const used = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() : 0;
    const dest = creep.memory.pullLoot && term && term.my !== false && term.store && typeof term.store.getFreeCapacity === 'function' && term.store.getFreeCapacity() >= used + 20000 ? term : room.storage;
    if (creep.transfer(dest, res) === ERR_NOT_IN_RANGE) movement.go(creep, dest, { range: 1, reusePath: 15 });
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
    if (m.deliverTo) m.salvageDeliver = m.deliverTo;
    m.targetRoom = pd.target;
    m.pullLoot = true;
    m.pull = pd.pull;
    m.deliverTo = (pd.deliverTo && pd.deliverTo[m.home]) || Object.values(pd.deliverTo || {})[0] || m.home;
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
    if (m.salvageDeliver) m.deliverTo = m.salvageDeliver; else delete m.deliverTo;
    for (const k of ['pullLoot', 'pull', 'src', 'salvageFrom', 'salvageOrder', 'salvageDeliver']) delete m[k];
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

function run(creep) {
    if (lootHoldRun(creep)) return;
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
    if (full || retreat || creep.memory.state === 'deliver') {
        creep.memory.state = 'deliver';
        if (!deliver(creep, home)) {
            if (retreat) { retireMod.retireAtSpawn(creep); return; }
            delete creep.memory.state;
        }
        return;
    }
    if (retreat) { creep.memory.state = 'deliver'; return; }
    if (creep.room.name !== target) { goRoom(creep, target); return; }
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
            if (r0) {
                if (creep.withdraw(cachedRuin, r0) === ERR_NOT_IN_RANGE) movement.go(creep, cachedRuin, { range: 1, reusePath: 50 });
                return;
            }
        }
        delete creep.memory.ruin;
        const threat = conquest.salvageArmedThreat(creep.room);
        if (threat) {
            creep.memory.state = 'deliver';
            deliver(creep, home);
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
        const c = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(ruins.slice(0, Math.min(5, ruins.length))) || ruins[0] : ruins[0];
        const res = conquest.salvagePickResource(c.store, order);
        if (!res) { creep.memory.state = 'deliver'; return; }
        creep.memory.ruin = c.id;
        if (creep.withdraw(c, res) === ERR_NOT_IN_RANGE) movement.go(creep, c, { range: 1, reusePath: 50 });
        return;
    }
    const containers = conquest.lootContainersOf(creep.room, creep.memory.lootTiles);
    if (!containers.length) { if (carrying) creep.memory.state = 'deliver'; else parkInside(creep); return; }
    const c = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(containers) : containers[0];
    const res = nonEnergyKey(c.store);
    if (!res) { creep.memory.state = 'deliver'; return; }
    if (creep.withdraw(c, res) === ERR_NOT_IN_RANGE) movement.go(creep, c, { range: 1, reusePath: 5 });
}

module.exports = { run };
