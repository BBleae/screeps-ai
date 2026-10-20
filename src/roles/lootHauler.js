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
    const room = Game.rooms[home];
    if (!room || creep.room.name !== home || !room.storage) { goRoom(creep, home); return true; }
    const carrying = creep.store.getUsedCapacity ? creep.store.getUsedCapacity() > 0 : false;
    if (!carrying) return false;
    const order = creep.memory.lootOrder;
    const res = (creep.memory.salvageLoot ? conquest.salvagePickResource(creep.store, order) : null) || nonEnergyKey(creep.store) || ENERGY;
    if (creep.transfer(room.storage, res) === ERR_NOT_IN_RANGE) movement.go(creep, room.storage, { range: 1, reusePath: 15 });
    return true;
}

function run(creep) {
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
    if (salvage) {
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
        if (creep.withdraw(c, res) === ERR_NOT_IN_RANGE) movement.go(creep, c, { range: 1, reusePath: 5 });
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
