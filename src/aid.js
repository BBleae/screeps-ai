'use strict';
const config = require('config');
const utils = require('utils');
const movement = require('movement');

function cfg() {
    return Object.assign({ untilCapacity: 1300, storageBelow: 10000, minHomeCapacity: 800, maxRange: 2, haulerCarry: 12, builderWork: 5, lead: 200,
        couriers: 1, exportAbove: 10000, exportKeep: 5000, courierBudget: 1600, routeCacheTicks: 1000 }, config.aid || {});
}

function routeOk(from, to, c) {
    try { return movement.safeRouteExists(from, to, c.routeCacheTicks); }
    catch (e) { utils.logErr('aid.safeRoute ' + from + '>' + to, e); return true; }
}

function demand(role, slot, body, memory, lead, priority, bodyFor, strategic) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, bodyFor, strategic: strategic !== false };
}

function sourceManned(creeps, entry, lead) {
    return creeps.some((creep) => creep.memory.role === 'harvester' && alive(creep, lead) &&
        (creep.memory.sourceId ? creep.memory.sourceId === entry.id : creep.memory.sourceIdx === entry.index));
}

function hasHauler(creeps, lead) {
    return creeps.some((creep) => creep.memory.role === 'hauler' && alive(creep, lead) && utils.bodyPartCount(creep.body, 'carry') > 0);
}

function shortHanded(room, creeps, lead) {
    return roomSources(room).some((entry) => !sourceManned(creeps, entry, lead)) || !hasHauler(creeps, lead);
}

const linearDistance = utils.roomDistance;

function needsAid(home, room) {
    const c = cfg();
    if (!room || !room.controller || !room.controller.my || room.name === home.name) return false;
    if (typeof room.find === 'function' && !(room.find(FIND_MY_SPAWNS) || []).length) return false;
    if (room.storage && room.storage.store && Number(room.storage.store[RESOURCE_ENERGY] || 0) >= c.storageBelow) return false;
    if (room.energyCapacityAvailable >= c.untilCapacity) return false;
    if (home.energyCapacityAvailable < c.minHomeCapacity) return false;
    if (linearDistance(home.name, room.name) > c.maxRange) return false;
    if (routeOk(home.name, room.name, c)) return true;
    const mem = Memory.rooms && Memory.rooms[home.name];
    if (mem) mem.aidNoRoute = { room: room.name, at: Game.time };
    return false;
}

function markStranded(creep) {
    const mem = creep && creep.memory;
    if (!mem || !mem.aid || !mem.home || creep.spawning || utils.isRetiring(mem) || !creep.room || creep.room.name === mem.home) return false;
    if (routeOk(creep.room.name, mem.home, cfg())) return false;
    mem.bodyUpgradeRetiring = true;
    if (Memory.rooms) {
        const target = Memory.rooms[mem.home] || (Memory.rooms[mem.home] = {});
        target.aidStranded = { name: creep.name, role: mem.role, from: creep.room.name, aid: mem.aid, at: Game.time };
    }
    return true;
}

function targets(home) {
    const out = [];
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (needsAid(home, room)) out.push(room);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

function alive(creep, lead) {
    if (creep.spawning) return true;
    return creep.ticksToLive == null || creep.ticksToLive > lead;
}

function roomSources(room) {
    const mem = (Memory.rooms && Memory.rooms[room.name]) || {};
    const ids = Array.isArray(mem.sources) ? mem.sources : [];
    const found = typeof room.find === 'function' ? room.find(FIND_SOURCES) || [] : [];
    if (ids.length) {
        return ids.map((id, index) => ({ id, index, source: found.find((s) => s.id === id) || null }));
    }
    return found.map((source, index) => ({ id: source.id, index, source }));
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const c = cfg();
    const demands = [];
    let priority = 0;
    for (const room of targets(home)) {
        const cap = home.energyCapacityAvailable;
        const creeps = utils.creepsHome(room.name).filter((creep) => !utils.isRetiring(creep.memory));
        const minerBody = utils.makeBody('staticHarvester', cap);
        for (const entry of roomSources(room)) {
            const work = creeps
                .filter((creep) => creep.memory.role === 'harvester' && alive(creep, c.lead) &&
                    (creep.memory.sourceId ? creep.memory.sourceId === entry.id : creep.memory.sourceIdx === entry.index))
                .reduce((sum, creep) => sum + utils.bodyPartCount(creep.body, 'work'), 0);
            if (work >= 5) continue;
            demands.push(demand('harvester', 'aid:harvester:' + room.name + ':' + entry.index, minerBody,
                { home: room.name, sourceIdx: entry.index, sourceId: entry.id, staticMiner: true, aid: home.name }, c.lead, priority++,
                (budget) => utils.makeBody('staticHarvester', budget), !sourceManned(creeps, entry, c.lead)));
        }
        const carry = creeps.filter((creep) => creep.memory.role === 'hauler' && alive(creep, c.lead))
            .reduce((sum, creep) => sum + utils.bodyPartCount(creep.body, 'carry'), 0);
        if (carry < c.haulerCarry) {
            demands.push(demand('hauler', 'aid:hauler:' + room.name, utils.makeBody('hauler', cap), { home: room.name, aid: home.name }, c.lead, priority++,
                (budget) => utils.makeBody('hauler', budget), !hasHauler(creeps, c.lead)));
        }
        const sites = typeof room.find === 'function' ? (room.find(FIND_MY_CONSTRUCTION_SITES) || []).length : 0;
        const builderWork = creeps.filter((creep) => creep.memory.role === 'builder' && alive(creep, c.lead))
            .reduce((sum, creep) => sum + utils.bodyPartCount(creep.body, 'work'), 0);
        if (sites > 0 && builderWork < c.builderWork) {
            demands.push(demand('builder', 'aid:builder:' + room.name, utils.makeBody('builder', cap), { home: room.name, aid: home.name }, c.lead, priority++,
                (budget) => utils.makeBody('builder', budget), false));
        }
        const storage = home.storage;
        const levels = utils.aidExportLevels(c, config.upgrading);
        const holdExport = (c.exportAfterTerminal || []).indexOf(home.name) >= 0 && !(home.terminal && home.terminal.my !== false);
        const exportable = !holdExport && storage && storage.my !== false && storage.store && Number(storage.store[RESOURCE_ENERGY] || 0) >= levels.above;
        const couriers = creeps.filter((creep) => creep.memory.role === 'courier' && alive(creep, c.lead)).length;
        const weakSpawns = typeof room.find === 'function' ? (room.find(FIND_MY_SPAWNS) || []).length : 0;
        if (exportable && couriers < c.couriers && weakSpawns > 0) {
            const budget = Math.min(cap, c.courierBudget);
            demands.push(demand('courier', 'aid:courier:' + room.name, utils.makeBody('hauler', budget), { home: room.name, from: home.name, aid: home.name }, c.lead, priority++,
                (b) => utils.makeBody('hauler', Math.min(b, c.courierBudget)), false));
        }
    }
    oneShotDemands(home, demands, priority);
    return demands;
}

function oneShot() {
    const o = Memory.aidOneShot;
    if (!o || !o.from || !o.to || !(Number(o.amount) > 0)) return null;
    return o;
}
function oneShotRemaining() {
    const o = oneShot();
    return o ? Math.max(0, Number(o.amount) - (Number(o.withdrawn) || 0)) : 0;
}
function oneShotByTerminal(home, o, remaining) {
    const t = home.terminal, dest = Game.rooms[o.to], dt = dest && dest.terminal;
    if (!t || t.my === false || !dt || t.cooldown > 0) return;
    const have = Number(t.store[RESOURCE_ENERGY] || 0);
    let amount = Math.min(remaining, 5000);
    const cost = (a) => (typeof Game.market !== 'undefined' && Game.market.calcTransactionCost ? Game.market.calcTransactionCost(a, home.name, o.to) : 0);
    while (amount > 0 && amount + cost(amount) > have) amount -= 500;
    if (amount <= 0) return;
    if (t.send(RESOURCE_ENERGY, amount, o.to, 'aidOneShot') === OK) {
        o.withdrawn = (Number(o.withdrawn) || 0) + amount;
        (o.trips || (o.trips = [])).push([Game.time, 'terminal', amount]);
        if (o.withdrawn >= Number(o.amount)) { Memory.aidOneShotDone = Object.assign({}, o, { doneAt: Game.time }); delete Memory.aidOneShot; }
    }
}
function oneShotDemands(home, demands, priority) {
    const o = oneShot();
    if (!o || o.from !== home.name) return;
    const remaining = oneShotRemaining();
    if (remaining <= 0) return;
    if (o.paused) { oneShotByTerminal(home, o, remaining); return; }
    const c = cfg();
    const maxCouriers = Math.max(1, Number(o.couriers) || 2);
    const budget = Math.min(home.energyCapacityAvailable, Number(o.budget) || 2500);
    const body = utils.makeBody('hauler', budget);
    const perTrip = utils.bodyPartCount(body, 'carry') * 50;
    const live = Object.values(Game.creeps || {}).filter((cr) => cr.memory && cr.memory.oneShot && cr.memory.role === 'courier' && !utils.isRetiring(cr.memory));
    const want = Math.min(maxCouriers, Math.ceil(remaining / Math.max(1, perTrip)));
    for (let i = 0; i < want; i++) {
        const slot = 'aid:oneshot:' + o.to + ':' + i;
        if (live.some((cr) => cr.memory.slotKey === slot)) continue;
        demands.push(demand('courier', slot, body, { home: o.to, from: o.from, aid: o.from, oneShot: true }, c.lead, priority++,
            (b) => utils.makeBody('hauler', Math.min(b, budget)), true));
    }
}

module.exports = { oneShotRemaining, getDemands, needsAid, linearDistance, shortHanded, markStranded };
