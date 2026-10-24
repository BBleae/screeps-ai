'use strict';
const config = require('config');
const layout = require('layout');
const movement = require('movement');
const retire = require('retire');
const taskBroker = require('task_broker');
const utils = require('utils');
const boost = require('boost');
const { findCached, creepsHomeRole } = utils;

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const fallbackBudgetState = runtimeGlobal.__roleEnergyFallbackBudget ||
    (runtimeGlobal.__roleEnergyFallbackBudget = { tick: -1, rooms: {} });

function ctrlLink(room, plan) {
    const spot = layout.linkSpot(plan, 'ctrl');
    if (!spot) return null;
    const link = layout.structureAt(room, spot.x, spot.y, STRUCTURE_LINK);
    return link && link.my ? link : null;
}

function energySourceAt(room, creep, plan) {
    const under = layout.structureAt(room, creep.pos.x, creep.pos.y, STRUCTURE_CONTAINER);
    if (under && under.store[RESOURCE_ENERGY] > 0) return under;
    const adjacent = findCached(room, FIND_STRUCTURES).find((s) => s.structureType === STRUCTURE_CONTAINER &&
        s.store[RESOURCE_ENERGY] > 0 &&
        Math.max(Math.abs(s.pos.x - creep.pos.x), Math.abs(s.pos.y - creep.pos.y)) <= 1);
    if (adjacent) return adjacent;
    const structures = findCached(room, FIND_STRUCTURES);
    const adjacentTo = (s) => Math.max(Math.abs(s.pos.x - creep.pos.x), Math.abs(s.pos.y - creep.pos.y)) <= 1;
    const link = structures.find((s) => s.my !== false && s.store && s.structureType === STRUCTURE_LINK &&
        s.store[RESOURCE_ENERGY] > 0 && adjacentTo(s));
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const near = structures.find((s) => s.my !== false && s.store && s.structureType === STRUCTURE_STORAGE &&
        s.store[RESOURCE_ENERGY] > reserve && adjacentTo(s));
    if (link) {
        if (near && typeof Memory !== 'undefined' && Memory.rooms) {
            const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
            const rec = mem.upgraderDrink || (mem.upgraderDrink = { linkOverStorage: 0 });
            rec.linkOverStorage = (Number(rec.linkOverStorage) || 0) + 1;
            rec.at = Game.time;
        }
        return link;
    }
    return near || null;
}

function withdrawable(structure) {
    const energy = structure.store[RESOURCE_ENERGY] || 0;
    if (structure.structureType !== STRUCTURE_STORAGE) return energy;
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    return Math.max(0, energy - reserve);
}

function repairStationBelow() {
    const value = Number(config.upgraderRepairStationBelow);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function ctrlStation(room, plan) {
    const station = layout.upgraderStation(room, plan);
    if (!station) return null;
    return Object.assign({}, station, { pos: new RoomPosition(station.pos.x, station.pos.y, room.name) });
}

function stationAnchorPos(station) {
    return station.anchor ? station.anchor.pos : station.pos;
}

function atStation(creep, station, ctrl) {
    return layout.atUpgraderStation(creep.pos, station, ctrl);
}

function goToStation(creep, station, ctrl) {
    const near = stationAnchorPos(station);
    if (creep.pos.inRangeTo(near, 1)) { movement.go(creep, ctrl, { range: 3, reusePath: 30 }); return; }
    const spots = station.spots || [station.pos];
    for (const spot of spots) {
        const taken = (creep.room.lookForAt(LOOK_CREEPS, spot.x, spot.y) || [])
            .some((other) => other && other.name !== creep.name);
        if (taken) continue;
        movement.go(creep, new RoomPosition(spot.x, spot.y, creep.room.name), { range: 0, reusePath: 30 });
        return;
    }
    movement.go(creep, near, { range: 1, reusePath: 30 });
}

function energyAroundSpot(room, spot) {
    let total = 0;
    const structures = findCached(room, FIND_STRUCTURES).filter((s) => s.store &&
        Math.max(Math.abs(s.pos.x - spot.x), Math.abs(s.pos.y - spot.y)) <= 1);
    for (const s of structures) {
        if (s.structureType === STRUCTURE_STORAGE) total += withdrawable(s);
        else if (s.structureType === STRUCTURE_LINK || s.structureType === STRUCTURE_CONTAINER) total += s.store[RESOURCE_ENERGY] || 0;
    }
    return total;
}

function spotWithEnergy(room, station, creep) {
    for (const spot of station.spots || []) {
        if (creep.pos.x === spot.x && creep.pos.y === spot.y) {
            if (energyAroundSpot(room, spot) > 0) return spot;
            continue;
        }
        const taken = (room.lookForAt(LOOK_CREEPS, spot.x, spot.y) || []).some((other) => other && other.name !== creep.name);
        if (taken) continue;
        if (energyAroundSpot(room, spot) > 0) return spot;
    }
    return null;
}

function hasActiveHauler(room) {
    return creepsHomeRole(room.name, 'hauler').some((creep) => !creep.spawning);
}

function reserveFor(room) {
    return Math.min(room.energyCapacityAvailable,
        config.recovery && config.recovery.emergencyHarvestBelow || 200);
}

function surplusEnergy(room) {
    if (fallbackBudgetState.tick !== Game.time) {
        fallbackBudgetState.tick = Game.time;
        fallbackBudgetState.rooms = {};
    }
    if (fallbackBudgetState.rooms[room.name] == null) {
        fallbackBudgetState.rooms[room.name] = Math.max(0, room.energyAvailable - reserveFor(room));
    }
    return fallbackBudgetState.rooms[room.name];
}

function takeSurplusEnergy(room, amount) {
    const available = surplusEnergy(room);
    const taken = Math.max(0, Math.min(available, amount));
    fallbackBudgetState.rooms[room.name] = available - taken;
    return taken;
}

function atLinkSide(room, plan, pos, ctrl) {
    const link = ctrlLink(room, plan);
    return !!link && Math.max(Math.abs(link.pos.x - pos.x), Math.abs(link.pos.y - pos.y)) <= 1 &&
        Math.max(Math.abs(ctrl.pos.x - pos.x), Math.abs(ctrl.pos.y - pos.y)) <= 3;
}

function linkSideSpot(room, plan, creep, ctrl) {
    const link = ctrlLink(room, plan);
    if (!link || !(Number(link.store[RESOURCE_ENERGY]) > 0)) return null;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const x = link.pos.x + dx;
            const y = link.pos.y + dy;
            if ((!dx && !dy) || x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (Math.max(Math.abs(ctrl.pos.x - x), Math.abs(ctrl.pos.y - y)) > 3) continue;
            if (utils.isWall(room, x, y) || utils.occupied(room, x, y)) continue;
            if ((room.lookForAt(LOOK_CREEPS, x, y) || []).some((other) => other && other.name !== creep.name)) continue;
            return { x, y };
        }
    }
    return null;
}

function linkReliefSpot(room, plan, station, creep, ctrl, mem) {
    const link = ctrlLink(room, plan);
    const keep = Math.max(0, Number(config.linkKeepAt) || 400);
    if (!link || !(Number(link.store[RESOURCE_ENERGY]) >= keep)) return null;
    const spots = station.spots || [station.pos];
    if (spots.some((spot) => Math.max(Math.abs(spot.x - link.pos.x), Math.abs(spot.y - link.pos.y)) <= 1)) return null;
    const crew = creepsHomeRole(room.name, 'upgrader').filter((other) => !other.spawning && !utils.isRetiring(other.memory))
        .map((other) => other.name).sort();
    if (crew[0] !== creep.name) return null;
    if (atLinkSide(room, plan, creep.pos, ctrl)) {
        if (mem) {
            const prev = mem.linkReliefInPlace || {};
            mem.linkReliefInPlace = { at: Game.time, first: prev.first != null ? prev.first : Game.time,
                n: (Number(prev.n) || 0) + 1, drank: Number(prev.drank) || 0 };
        }
        return null;
    }
    return linkSideSpot(room, plan, creep, ctrl);
}

function refillTarget(room, creep, plan, state) {
    if (plan.containers && plan.containers.ctrl) {
        const c = layout.structureAt(room, plan.containers.ctrl.x, plan.containers.ctrl.y, STRUCTURE_CONTAINER);
        if (c && c.store[RESOURCE_ENERGY] > 0) return { pos: new RoomPosition(c.pos.x, c.pos.y, room.name), target: c };
    }
    const l = ctrlLink(room, plan);
    if (l && l.store[RESOURCE_ENERGY] > 0) return { pos: new RoomPosition(l.pos.x, l.pos.y, room.name), target: l };
    if (state && state.recovering) return null;
    if (utils.spawnWaitingFor(room)) return null;
    const any = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
            s.store[RESOURCE_ENERGY] > 0,
    });
    if (!any) return null;
    const amount = takeSurplusEnergy(room, Math.min(
        creep.store.getFreeCapacity(RESOURCE_ENERGY), any.store[RESOURCE_ENERGY]));
    return amount > 0 ? { pos: any.pos, target: any, amount } : null;
}

const DUTY_PERIOD = 10;
const dutyCache = { time: -1, rooms: {} };
function upgradeDuty(room, mem) {
    if (dutyCache.time !== Game.time) { dutyCache.time = Game.time; dutyCache.rooms = {}; }
    if (dutyCache.rooms[room.name] != null) return dutyCache.rooms[room.name];
    const cap = utils.upgraderWorkCap(room, mem);
    const work = utils.upgraderWork(room);
    const duty = (!isFinite(cap) || work <= 0 || work <= cap) ? 1 : Math.max(0, Math.min(1, cap / work));
    dutyCache.rooms[room.name] = duty;
    return duty;
}

function dutyActive(creep, room, mem) {
    const duty = upgradeDuty(room, mem);
    if (duty >= 1) return true;
    const active = Math.max(1, Math.round(duty * DUTY_PERIOD));
    if (active >= DUTY_PERIOD) return true;
    const name = String(creep.name || '');
    let phase = 0;
    for (let i = 0; i < name.length; i++) phase += name.charCodeAt(i);
    return (Game.time + phase) % DUTY_PERIOD < active;
}

function reportBudget(room, mem, duty) {
    const track = mem.upgradeBudget || (mem.upgradeBudget = {});
    if (track.at && Game.time - track.at < 30) return;
    track.at = Game.time;
    track.supply = Math.round(utils.sourceSupply(room) * 100) / 100;
    track.work = utils.upgraderWork(room);
    const cap = utils.upgraderWorkCap(room, mem);
    track.cap = isFinite(cap) ? cap : null;
    track.duty = Math.round(duty * 1000) / 1000;
    track.storage = room.storage ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : null;
    track.low = !!utils.upgradeBudgetLow(room, mem);
    if (track.cap != null) track.lastHeld = { at: Game.time, cap: track.cap, work: track.work, duty: track.duty };
}

function noteStuck(mem, creep, action, range) {
    const log = mem.upgraderStuck || (mem.upgraderStuck = {});
    log.at = Game.time;
    log.name = creep.name;
    log.x = creep.pos.x;
    log.y = creep.pos.y;
    log.range = range;
    log.action = action;
    log[action] = (Number(log[action]) || 0) + 1;
}

function controllerMark(ctrl) {
    if (!ctrl) return null;
    const mark = { l: Number(ctrl.level) || 0, p: Number(ctrl.progress) || 0 };
    if (typeof ctrl.ticksToDowngrade === 'number') mark.d = Game.time + ctrl.ticksToDowngrade;
    return mark;
}

function noteRetireStreak(log, ctrl, settings) {
    const mark = controllerMark(ctrl);
    const prev = log.mark;
    const progressed = !prev || !mark || prev.l !== mark.l || prev.p !== mark.p ||
        (typeof prev.d === 'number' && typeof mark.d === 'number' && mark.d > prev.d + 1);
    log.streak = progressed ? 1 : (Number(log.streak) || 0) + 1;
    log.mark = mark;
    const after = Math.max(2, Number(settings.stuckBackoffAfter) || 3);
    if (log.streak >= after) {
        log.backoffUntil = Game.time + Math.max(1, Number(settings.stuckBackoffTicks) || 1500);
        log.backoffs = (Number(log.backoffs) || 0) + 1;
        log.backoffAt = Game.time;
    }
}

function freshUnderHold(creep, room) {
    const cfg = ((config.upgrading || {}).hold || {})[room.name] || {};
    const keep = Number(cfg.retireMaxTtl);
    return keep > 0 && creep.ticksToLive > keep;
}

function stuckWatchdog(creep, room, mem) {
    const memory = creep.memory;
    const settings = config.upgrading || {};
    const repathTicks = Math.max(1, Number(settings.stuckRepathTicks) || 50);
    const retireTicks = Math.max(repathTicks + 1, Number(settings.stuckRetireTicks) || 300);
    const ctrl = room.controller;
    const range = ctrl && ctrl.pos && creep.pos.roomName === room.name
        ? Math.max(Math.abs(creep.pos.x - ctrl.pos.x), Math.abs(creep.pos.y - ctrl.pos.y)) : null;
    const track = memory.upStuck;
    const moved = !track || track.x !== creep.pos.x || track.y !== creep.pos.y;
    if (memory.stuckRetiring) {
        if (moved || creep.fatigue > 0) memory.upStuck = { x: creep.pos.x, y: creep.pos.y, t: Game.time };
        else if (Game.time - Math.max(Number(track.t) || 0, Number(memory.stuckRetiring) || 0) >= retireTicks) {
            noteStuck(mem, creep, 'suicide', range);
            creep.suicide();
            return true;
        }
        retire.retireAtSpawn(creep);
        return true;
    }
    if (range == null || range <= 3 || creep.fatigue > 0) {
        if (track) delete memory.upStuck;
        return false;
    }
    if (moved) { memory.upStuck = { x: creep.pos.x, y: creep.pos.y, t: Game.time }; return false; }
    const stalled = Game.time - (Number(track.t) || Game.time);
    if (stalled >= retireTicks) {
        const log = mem.upgraderStuck || (mem.upgraderStuck = {});
        if (Number(log.backoffUntil) > Game.time) {
            if (!track.held) {
                track.held = Game.time;
                log.held = (Number(log.held) || 0) + 1;
                log.heldAt = Game.time;
            }
            return false;
        }
        memory.stuckRetiring = Game.time;
        noteStuck(mem, creep, 'retire', range);
        noteRetireStreak(log, ctrl, settings);
        retire.retireAtSpawn(creep);
        return true;
    }
    if (stalled >= repathTicks && !track.repath) {
        track.repath = Game.time;
        noteStuck(mem, creep, 'repath', range);
        movement.resetCreepPath(creep);
        mem.upgraderStuck.reset = (Number(mem.upgraderStuck.reset) || 0) + 1;
    }
    return false;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home)); return; }
    const plan = (Memory.rooms[room.name] || {}).plan || {};
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    if (!creep.memory.boostDone) {
        const ind = config.industry || {};
        if (!creep.memory.boosts && ind.boostUpgraders && utils.upgraderBoostRooms().indexOf(room.name) >= 0) {
            creep.memory.boosts = ['XGH2O'];
            const minParts = Number(ind.upgraderBoostMinParts);
            if (minParts > 0) creep.memory.boostMinParts = minParts;
        }
        if (creep.memory.boosts) {
            let busy = false;
            try { busy = boost.run(creep); } catch (e) { busy = false; }
            if (busy) return;
        }
        creep.memory.boostDone = true;
    }
    if (stuckWatchdog(creep, room, mem)) return;
    const held = utils.upgradeHold(room, mem);
    if (held && held.on && !held.guard && !freshUnderHold(creep, room)) {
        creep.memory.upgradeHoldRetire = Game.time;
        retire.retireAtSpawn(creep);
        return;
    }
    const state = mem.state || {};
    const ctrl = room.controller;
    reportBudget(room, mem, upgradeDuty(room, mem));

    const station = ctrlStation(room, plan);
    const conserveHold = !!utils.towerFloorHold(room);
    if (creep.store[RESOURCE_ENERGY] > 0) {
        if (station && !atStation(creep, station, ctrl) && !(station.storageFed && atLinkSide(room, plan, creep.pos, ctrl))) {
            goToStation(creep, station, ctrl);
            return;
        }
        const work = creep.getActiveBodyparts(WORK);
        if (!conserveHold && creep.store[RESOURCE_ENERGY] < work * 2) {
            const near = energySourceAt(room, creep, plan);
            const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
            if (near && free > 0) creep.withdraw(near, RESOURCE_ENERGY, Math.min(free, withdrawable(near)));
        }
        const stationContainer = station && !station.storageFed && station.container ? station.container : null;
        if (stationContainer && stationContainer.hits != null && stationContainer.hitsMax &&
            stationContainer.hits < stationContainer.hitsMax * repairStationBelow() &&
            creep.pos.inRangeTo(stationContainer, 3) && creep.repair(stationContainer) === OK) return;
        if (!dutyActive(creep, room, mem)) return;
        const ret = creep.upgradeController(ctrl);
        if (ret === ERR_NOT_IN_RANGE) movement.go(creep, ctrl, { reusePath: 30 });
        return;
    }

    if (conserveHold) {
        if (!creep.pos.inRangeTo(ctrl, 3)) movement.go(creep, ctrl, { range: 3, reusePath: 30 });
        return;
    }
    const near = energySourceAt(room, creep, plan);
    const relief = station && station.storageFed && !(near && near.structureType === STRUCTURE_LINK) ? linkReliefSpot(room, plan, station, creep, ctrl, mem) : null;
    if (relief) {
        mem.linkRelief = { at: Game.time, n: (Number(mem.linkRelief && mem.linkRelief.n) || 0) + 1, x: relief.x, y: relief.y };
        movement.go(creep, new RoomPosition(relief.x, relief.y, room.name), { range: 0, reusePath: 30 });
        return;
    }
    if (near) {
        const amount = Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), withdrawable(near));
        const ret = creep.withdraw(near, RESOURCE_ENERGY, amount);
        const inPlace = mem && mem.linkReliefInPlace;
        if (ret === OK && inPlace && inPlace.at === Game.time) inPlace.drank = (Number(inPlace.drank) || 0) + amount;
        return;
    }
    if (station && station.storageFed) {
        const spot = spotWithEnergy(room, station, creep);
        if (spot && !(creep.pos.x === spot.x && creep.pos.y === spot.y)) {
            movement.go(creep, new RoomPosition(spot.x, spot.y, room.name), { range: 0, reusePath: 30 });
            return;
        }
        const side = !spot && linkSideSpot(room, plan, creep, ctrl);
        if (side) {
            mem.upgraderLinkSide = { at: Game.time, n: (Number(mem.upgraderLinkSide && mem.upgraderLinkSide.n) || 0) + 1, x: side.x, y: side.y };
            movement.go(creep, new RoomPosition(side.x, side.y, room.name), { range: 0, reusePath: 30 });
            return;
        }
    }
    if (station && (station.container || station.storageFed) && hasActiveHauler(room)) {
        if (!atStation(creep, station, ctrl)) goToStation(creep, station, ctrl);
        return;
    }
    const refill = refillTarget(room, creep, plan, state);
    if (refill) {
        if (creep.pos.isNearTo(refill.pos)) {
            if (refill.amount == null) creep.withdraw(refill.target, RESOURCE_ENERGY);
            else creep.withdraw(refill.target, RESOURCE_ENERGY, refill.amount);
        } else {
            movement.go(creep, refill.pos, { reusePath: 25 });
        }
        return;
    }
    if (taskBroker.runFallback(creep, room)) return;
    if (!creep.pos.inRangeTo(ctrl, 2)) movement.go(creep, ctrl, { range: 2, reusePath: 30 });
}

module.exports = { run };
