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
        const ruins = conquest.salvageRuins(creep.room);
        if (!ruins.length) {
            if (carrying) { creep.memory.state = 'deliver'; return; }
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
    if (!containers.length) { creep.memory.state = 'deliver'; return; }
    const c = creep.pos.findClosestByRange ? creep.pos.findClosestByRange(containers) : containers[0];
    const res = nonEnergyKey(c.store);
    if (!res) { creep.memory.state = 'deliver'; return; }
    if (creep.withdraw(c, res) === ERR_NOT_IN_RANGE) movement.go(creep, c, { range: 1, reusePath: 5 });
}

module.exports = { run };
