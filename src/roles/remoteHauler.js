'use strict';
const movement = require('movement');
const remote = require('remote');
const layout = require('layout');
const retireMod = require('retire');
const config = require('config');
const utils = require('utils');
const taskBroker = require('task_broker');
const haulStats = require('haul_stats');

const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
const STORAGE = typeof STRUCTURE_STORAGE === 'undefined' ? 'storage' : STRUCTURE_STORAGE;
const SPAWN = typeof STRUCTURE_SPAWN === 'undefined' ? 'spawn' : STRUCTURE_SPAWN;
const EXTENSION = typeof STRUCTURE_EXTENSION === 'undefined' ? 'extension' : STRUCTURE_EXTENSION;
const CONTAINER = typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER;
const ROAD = typeof STRUCTURE_ROAD === 'undefined' ? 'road' : STRUCTURE_ROAD;
const RAMPART = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
const WALL_MASK = typeof TERRAIN_MASK_WALL === 'undefined' ? 1 : TERRAIN_MASK_WALL;
const RC_OK = typeof OK === 'undefined' ? 0 : OK;
const RC_NOT_IN_RANGE = typeof ERR_NOT_IN_RANGE === 'undefined' ? -9 : ERR_NOT_IN_RANGE;

function settings() {
    return config.remote || {};
}

function setting(name, fallback) {
    const value = Number(settings()[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function activeWork(creep) {
    if (creep.getActiveBodyparts) return creep.getActiveBodyparts(typeof WORK === 'undefined' ? 'work' : WORK) > 0;
    return (creep.body || []).some((part) => (part.type || part) === 'work' && (part.hits == null || part.hits > 0));
}

function energyOf(target) {
    const store = target && target.store;
    return store ? Math.max(0, Number(store[ENERGY]) || 0) : 0;
}

function freeOf(target) {
    const store = target && target.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return Infinity;
    return Math.max(0, Number(store.getFreeCapacity(ENERGY)) || 0);
}

function posOf(target) {
    return target && target.pos ? target.pos : target;
}

function rangeTo(creep, target) {
    const a = creep && creep.pos;
    const b = posOf(target);
    if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return null;
    if (a.roomName && b.roomName && a.roomName !== b.roomName) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function isNear(creep, target) {
    const range = rangeTo(creep, target);
    return range != null && range <= 1;
}

function note(creep, why) {
    if (haulStats && typeof haulStats.note === 'function') haulStats.note(creep, why);
}

function homeMem(creep) {
    if (typeof Memory === 'undefined' || !Memory.rooms || !creep || !creep.memory || !creep.memory.home) return null;
    return Memory.rooms[creep.memory.home] || (Memory.rooms[creep.memory.home] = {});
}

function noteHaul(creep, key, amount) {
    const mem = homeMem(creep);
    if (!mem) return;
    const record = mem.remoteHaul || (mem.remoteHaul = {});
    record[key] = (Number(record[key]) || 0) + (amount == null ? 1 : amount);
    record.at = Game.time;
}

function startStopClock(creep, room) {
    if (creep.memory.stopAt != null) return;
    const anchor = room.storage || (typeof FIND_MY_SPAWNS !== 'undefined' ? (room.find(FIND_MY_SPAWNS) || [])[0] : null);
    const range = anchor ? rangeTo(creep, anchor) : null;
    if (range == null || !Number.isFinite(range)) return;
    creep.memory.stopAt = Game.time;
    creep.memory.stopDist = range;
}

function recordStop(creep, roomName) {
    const started = Number(creep.memory.stopAt);
    const dist = Number(creep.memory.stopDist) || 0;
    delete creep.memory.stopAt;
    delete creep.memory.stopDist;
    if (!(started > 0) || typeof Memory === 'undefined' || !Memory.rooms || !roomName) return;
    const stops = Math.max(0, Math.min(30, Game.time - started - dist));
    const mem = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    const record = mem.remoteStop || (mem.remoteStop = { ema: stops, n: 0 });
    record.ema = record.n > 0 ? Math.round((record.ema * 0.8 + stops * 0.2) * 100) / 100 : stops;
    record.n = (Number(record.n) || 0) + 1;
    record.last = stops;
    record.at = Game.time;
}


function newPlan() {
    return { acted: false, stopEnd: false, moved: false, built: false, exclude: new Set() };
}

function go(creep, plan, target, opts) {
    const range = rangeTo(creep, target);
    const want = opts && opts.range != null ? opts.range : 1;
    if (plan && (range == null || range > want)) plan.moved = true;
    return movement.go(creep, target, opts);
}

const tickLedger = { tick: -1, taken: {} };
function takenThisTick(id) {
    if (tickLedger.tick !== Game.time) { tickLedger.tick = Game.time; tickLedger.taken = {}; }
    return tickLedger.taken[id] || 0;
}
function recordTaken(id, amount) {
    if (!id) return;
    takenThisTick(id);
    tickLedger.taken[id] = (tickLedger.taken[id] || 0) + amount;
}

function retireNow(creep) {
    if (retireMod && typeof retireMod.retireAtSpawn === 'function') return retireMod.retireAtSpawn(creep);
    return null;
}

function noteTtl(creep, key, detail) {
    const mem = homeMem(creep);
    if (!mem) return;
    const record = mem.remoteTtl || (mem.remoteTtl = {});
    record[key] = (Number(record[key]) || 0) + 1;
    record.at = Game.time;
    if (detail) record.last = Object.assign({ kind: key, at: Game.time }, detail);
}

function nearMySpawn(creep) {
    if (!creep.room || typeof FIND_MY_SPAWNS === 'undefined') return false;
    return (creep.room.find(FIND_MY_SPAWNS) || []).some((spawn) => isNear(creep, spawn));
}

function retireEmpty(creep, plan) {
    creep.memory.retired = true;
    note(creep, 'retire');
    if (plan && plan.acted && nearMySpawn(creep)) return;
    if (retireNow(creep) === 'walk' && plan) plan.moved = true;
}


function ctrlFeedContainer(room) {
    if (taskBroker.controllerFeedMode(room) === 'link') return null;
    const plan = (Memory.rooms && Memory.rooms[room.name] || {}).plan;
    if (!plan || !plan.containers || !plan.containers.ctrl) return null;
    if (layout.controllerFedByStorage(room, plan)) return null;
    const container = layout.structureAt(room, plan.containers.ctrl.x, plan.containers.ctrl.y, STRUCTURE_CONTAINER);
    if (!container || !container.store || container.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
    const fillBelow = Number(config.upgraderFillBelow) || 0.8;
    if (container.store[RESOURCE_ENERGY] >= container.store.getCapacity(RESOURCE_ENERGY) * fillBelow) return null;
    return container;
}

function closestOf(creep, list) {
    if (!list || !list.length) return null;
    let best = null;
    let bestRange = Infinity;
    for (const item of list) {
        const range = rangeTo(creep, item);
        if (range == null) {
            const found = creep && creep.pos && typeof creep.pos.findClosestByRange === 'function' ? creep.pos.findClosestByRange(list) : null;
            return found || list[0];
        }
        if (range < bestRange) { best = item; bestRange = range; }
    }
    return best || list[0];
}

function openFor(creep, room, structure) {
    if (typeof taskBroker.pooledTasks !== 'function' || typeof taskBroker.availableFor !== 'function') return true;
    const tasks = deliverTasksByTarget(taskBroker.pooledTasks(room)).get(structure.id);
    if (!tasks || !tasks.length) return true;
    return tasks.some((task) => taskBroker.availableFor(task, creep) > 0);
}

const poolIndex = new WeakMap();
function deliverTasksByTarget(pool) {
    if (!pool || typeof pool !== 'object') return new Map();
    let index = poolIndex.get(pool);
    if (index) return index;
    index = new Map();
    for (const task of pool) {
        if (!task || task.kind !== 'deliver' || !task.target || task.target.id == null) continue;
        const list = index.get(task.target.id);
        if (list) list.push(task); else index.set(task.target.id, [task]);
    }
    poolIndex.set(pool, index);
    return index;
}

function homeTarget(room, creep, opts) {
    const options = opts || {};
    const exclude = options.exclude;
    const info = options.info || {};
    const allowed = (structure) => !!structure && !(exclude && structure.id != null && exclude.has(structure.id));
    const linkFeed = taskBroker.controllerFeedLink(room);
    if (linkFeed && linkFeed.starved && allowed(linkFeed.target)) { info.urgent = true; return linkFeed.target; }
    const feedFirst = ctrlFeedContainer(room);
    if (feedFirst && allowed(feedFirst) && feedFirst.store[RESOURCE_ENERGY] < feedFirst.store.getCapacity(RESOURCE_ENERGY) * (Number(config.controllerFeedStarvedBelow) || 0.1) &&
        room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
        !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room)) { info.urgent = true; return feedFirst; }
    const storageFeed = taskBroker.controllerFeedStorage(room);
    if (storageFeed && storageFeed.starved && allowed(storageFeed.target)) { info.urgent = true; return storageFeed.target; }
    const refillAt = Number(config.towerRefillAt) || 300;
    const hostile = room.find(FIND_HOSTILE_CREEPS).length > 0;
    const towers = room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => structure.structureType === STRUCTURE_TOWER && allowed(structure) &&
            structure.store && (structure.store.getFreeCapacity(RESOURCE_ENERGY) >= refillAt || hostile),
    });
    const urgentTowers = towers.filter((structure) => utils.towerUrgent(room, structure, hostile));
    if (urgentTowers.length) { info.urgent = true; return closestOf(creep, urgentTowers); }
    const spawnOrExt = room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
            allowed(structure) && structure.store && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (spawnOrExt.length) {
        if (rangeTo(creep, spawnOrExt[0]) == null) {
            const open = spawnOrExt.filter((structure) => openFor(creep, room, structure));
            if (open.length) return closestOf(creep, open);
        } else {
            const sorted = spawnOrExt.slice().sort((a, b) => rangeTo(creep, a) - rangeTo(creep, b));
            for (const structure of sorted) if (openFor(creep, room, structure)) return structure;
        }
    }
    if (linkFeed && allowed(linkFeed.target)) return linkFeed.target;
    const feed = ctrlFeedContainer(room);
    if (feed && allowed(feed)) return feed;
    if (towers.length) return closestOf(creep, towers);
    if (room.storage && room.storage.my && allowed(room.storage) && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
    return null;
}

function driveByTarget(creep, room, main, exclude) {
    if (typeof FIND_MY_STRUCTURES === 'undefined' || !creep.pos || typeof creep.pos.findInRange !== 'function') return null;
    const found = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
        filter: (s) => (s.structureType === SPAWN || s.structureType === EXTENSION) && s.store && freeOf(s) > 0,
    }) || [];
    for (const structure of found) {
        if (!structure || structure.id === (main && main.id)) continue;
        if (exclude && exclude.has(structure.id)) continue;
        const range = rangeTo(creep, structure);
        if (range == null || range > 1) continue;
        if (openFor(creep, room, structure)) return structure;
    }
    return null;
}


function idleHome(creep) {
    if (creep.store[RESOURCE_ENERGY] <= 0 && (remote.isDisabled(creep.memory.home, creep.memory.remoteRoom) || remote.isUnreachable(creep.memory.home, creep.memory.remoteRoom))) {
        note(creep, 'retire');
        retireNow(creep);
        return;
    }
    if (creep.store[RESOURCE_ENERGY] <= 0 && suspendedTooLong(creep)) {
        noteHaul(creep, 'suspendRetire');
        retireEmpty(creep, null);
        return;
    }
    note(creep, creep.store[RESOURCE_ENERGY] > 0 ? 'full' : 'park');
    const home = Game.rooms[creep.memory.home];
    if (!home || creep.room.name !== home.name) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 30 });
        return;
    }
    const anchor = home.storage || home.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 4)) movement.go(creep, anchor, { range: 4, reusePath: 25 });
}

function afterTransfer(creep, room, target, sent, before, plan, kind) {
    plan.acted = true;
    plan.exclude.add(target.id);
    if (typeof taskBroker.consume === 'function') taskBroker.consume(creep, room, target, sent, 'deliver');
    if (typeof taskBroker.setProjected === 'function') taskBroker.setProjected(creep, Math.max(0, before - sent));
    if (creep.room.name !== creep.memory.remoteRoom) creep.memory.remoteRoadDelivery = { at: Game.time, before };
    if (kind === 'driveBy') noteHaul(creep, 'driveBy');
    if (target.structureType === STORAGE) noteHaul(creep, 'storageDrops');
    else if (target.structureType === SPAWN || target.structureType === EXTENSION) noteHaul(creep, 'extStops');
}

function afterEmpty(creep, room, plan) {
    plan.stopEnd = true;
    noteHaul(creep, 'trips');
    recordStop(creep, room.name);
    creep.memory.state = 'collect';
    delete creep.memory.dropRoom;
    const home = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (remote.isSuspended(home, remoteRoom)) return;
    if (ttlRetire(creep, plan, room.name)) return;
    creep.memory.leg = 'out';
    creep.memory.legAt = Game.time;
    creep.memory.legRoom = room.name;
    const target = travelTarget(creep, home, remoteRoom);
    go(creep, plan, target.pos, { range: target.range, reusePath: 40 });
}

function deliver(creep, plan) {
    if (!creep.memory.dropRoom) creep.memory.dropRoom = remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    const dropName = creep.memory.dropRoom;
    const room = Game.rooms[dropName];
    if (!room || creep.room.name !== dropName) {
        go(creep, plan, new RoomPosition(25, 25, dropName), { range: 20, reusePath: 35 });
        return;
    }
    if (creep.memory.leg === 'back') recordLeg(creep, 'back', dropName);
    const energy = energyOf(creep);
    if (energy > 0) startStopClock(creep, room);
    if (energy <= 0) {
        creep.memory.state = 'collect';
        delete creep.memory.dropRoom;
        ttlRetire(creep, plan, dropName);
        return;
    }
    const info = {};
    const target = homeTarget(room, creep, { exclude: plan.exclude, info });
    if (!target) {
        if (dropName !== creep.memory.home) {
            creep.memory.dropRoom = creep.memory.home;
            delete creep.memory.stopAt;
            delete creep.memory.stopDist;
            go(creep, plan, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 35 });
            return;
        }
        idleHome(creep);
        return;
    }
    const reach = rangeTo(creep, target);
    if (reach != null && reach > 1) {
        const drive = info.urgent ? null : driveByTarget(creep, room, target, plan.exclude);
        if (drive) {
            const sent = Math.min(energy, freeOf(drive));
            if (sent > 0 && creep.transfer(drive, RESOURCE_ENERGY, sent) === RC_OK) {
                afterTransfer(creep, room, drive, sent, energy, plan, 'driveBy');
                plan.stopEnd = true;
                if (energy - sent <= 0) { afterEmpty(creep, room, plan); return; }
            }
        }
        go(creep, plan, target, { range: 1, reusePath: 20 });
        return;
    }
    const free = freeOf(target);
    const sent = Number.isFinite(free) ? Math.min(energy, free) : energy;
    const transferred = sent > 0 ? creep.transfer(target, RESOURCE_ENERGY, sent) : RC_NOT_IN_RANGE;
    if (transferred === RC_NOT_IN_RANGE) {
        go(creep, plan, target, { range: 1, reusePath: 20 });
        return;
    }
    if (transferred !== RC_OK) {
        plan.exclude.add(target.id);
        return;
    }
    afterTransfer(creep, room, target, sent, energy, plan, 'main');
    const left = Math.max(0, energy - sent);
    if (left <= 0) { afterEmpty(creep, room, plan); return; }
    const next = homeTarget(room, creep, { exclude: plan.exclude, info: {} });
    if (next && isNear(creep, next)) return;
    plan.stopEnd = true;
    if (next) go(creep, plan, next, { range: 1, reusePath: 20 });
}


function roadBuildCost(creep, site) {
    const work = creep.getActiveBodyparts ? creep.getActiveBodyparts(typeof WORK === 'undefined' ? 'work' : WORK) :
        (creep.body || []).filter((part) => (part.type || part) === 'work' && (part.hits == null || part.hits > 0)).length;
    const remaining = site.progressTotal == null ? Infinity : Math.max(0, site.progressTotal - (site.progress || 0));
    return Math.min(work * (typeof BUILD_POWER === 'undefined' ? 5 : BUILD_POWER), remaining, creep.store[RESOURCE_ENERGY]);
}

function settleRoadBudget(creep) {
    const pending = creep.memory.remoteRoadPending;
    if (pending && pending.at < Game.time) {
        const spent = pending.at === Game.time - 1 ?
            Math.min(pending.max, Math.max(0, pending.before - creep.store[RESOURCE_ENERGY])) : pending.max;
        creep.memory.remoteRoadSpent = (creep.memory.remoteRoadSpent || 0) + spent;
        const home = Memory.rooms && Memory.rooms[creep.memory.home];
        if (home && spent > 0 && pending.at === Game.time - 1) {
            const record = home.remoteRoadBudget || (home.remoteRoadBudget = { spent: 0, deliveredTrips: 0 });
            record.spent += spent;
        }
        delete creep.memory.remoteRoadPending;
    }
    const delivered = creep.memory.remoteRoadDelivery;
    if (delivered && delivered.at < Game.time) {
        if (delivered.at === Game.time - 1 && creep.store[RESOURCE_ENERGY] < delivered.before) {
            const home = Memory.rooms && Memory.rooms[creep.memory.home];
            if (home && creep.memory.remoteRoadSpent > 0) {
                const record = home.remoteRoadBudget || (home.remoteRoadBudget = { spent: 0, deliveredTrips: 0 });
                record.deliveredTrips++;
                record.maxTripSpent = Math.max(record.maxTripSpent || 0, creep.memory.remoteRoadSpent);
                record.delivered = (record.delivered || 0) + delivered.before - creep.store[RESOURCE_ENERGY];
                record.at = Game.time;
            }
            delete creep.memory.remoteRoadSpent;
        }
        delete creep.memory.remoteRoadDelivery;
    }
}

const TRAIL_MAX = 60;

function traceRoadTile(creep) {
    const trail = creep.memory.roadTrail || (creep.memory.roadTrail = []);
    if (trail.length >= TRAIL_MAX) return;
    const tag = creep.pos.x + '.' + creep.pos.y;
    if (trail[trail.length - 1] !== tag) trail.push(tag);
}

function flushRoadTrail(creep) {
    const trail = creep.memory.roadTrail;
    if (!trail) return;
    delete creep.memory.roadTrail;
    if (!Array.isArray(trail) || trail.length < 3 || trail.length >= TRAIL_MAX) return;
    if (typeof remote.noteRoadTrail !== 'function') return;
    remote.noteRoadTrail(creep.memory.home, creep.memory.remoteRoom, creep.memory.sourceId, creep.memory.srcIdx, trail.join(';'));
}

function nearbyInfrastructureWork(creep) {
    if (!activeWork(creep) || creep.store[RESOURCE_ENERGY] <= 0) return false;
    const inReach = (item) => { const range = rangeTo(creep, item); return range == null || range <= 3; };
    const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, {
        filter: (item) => inReach(item) && (item.structureType === STRUCTURE_CONTAINER ||
            (item.structureType === STRUCTURE_ROAD && roadBuildCost(creep, item) <= Math.max(0, 50 - (creep.memory.remoteRoadSpent || 0)))),
    })[0];
    if (site) {
        const before = creep.store[RESOURCE_ENERGY];
        if (creep.build(site) === RC_OK) {
            if (site.structureType !== STRUCTURE_ROAD) return 'container';
            creep.memory.remoteRoadPending = { at: Game.time, before, max: roadBuildCost(creep, site) };
            return 'road';
        }
    }
    const damaged = creep.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: (item) => inReach(item) && (item.structureType === STRUCTURE_ROAD || item.structureType === STRUCTURE_CONTAINER) &&
            item.hits < item.hitsMax * 0.5,
    })[0];
    if (damaged) {
        creep.repair(damaged);
        return 'repair';
    }
    return false;
}


function routeDistance(creep, sourceMemory) {
    const home = creep.memory.home;
    const record = typeof remote.getRemote === 'function' ? remote.getRemote(home, creep.memory.remoteRoom) : null;
    const drop = record && record.drop;
    const dropName = creep.memory.dropRoom || (drop && drop.room) || home;
    if (drop && drop.room === dropName && dropName !== home && Number(drop.distance) > 0) return Number(drop.distance);
    return Math.max(1, Number(sourceMemory && sourceMemory.distance) || 50);
}

function ladenPerTile(creep, sourceMemory) {
    if (sourceMemory && sourceMemory.roadComplete) return 1;
    const perTile = typeof utils.bodyTicksPerTile === 'function' ? utils.bodyTicksPerTile(creep.body) : 1;
    return Number.isFinite(perTile) ? Math.max(1, perTile) : 1;
}

function tripTicks(creep, sourceMemory) {
    const distance = routeDistance(creep, sourceMemory);
    const dropRoom = creep.memory.dropRoom || remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    const stops = typeof remote.deliveryStops === 'function' ? remote.deliveryStops(dropRoom) : setting('deliveryStopTicks', 10);
    return distance + distance * ladenPerTile(creep, sourceMemory) + stops + setting('turnTicks', 2);
}

function sourceRate(sourceMemory) {
    const regen = typeof ENERGY_REGEN_TIME === 'number' ? ENERGY_REGEN_TIME : 300;
    return Math.max(1, Number(sourceMemory && sourceMemory.energyCapacity) || 1500) / regen;
}

function sourceInflow(creep, sourceMemory) {
    if (!sourceMemory || !sourceMemory.spot) return 0;
    const spot = sourceMemory.spot;
    const list = typeof utils.creepsHomeRole === 'function' ? utils.creepsHomeRole(creep.memory.home, 'remoteMiner') : [];
    const power = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
    let work = 0;
    for (const miner of list) {
        if (!miner || miner.spawning || !miner.memory || miner.memory.sourceId !== sourceMemory.id || !miner.pos) continue;
        if (miner.pos.roomName !== creep.memory.remoteRoom || Math.max(Math.abs(miner.pos.x - spot.x), Math.abs(miner.pos.y - spot.y)) > 1) continue;
        work += typeof miner.getActiveBodyparts === 'function' ? miner.getActiveBodyparts(typeof WORK === 'undefined' ? 'work' : WORK)
            : (typeof utils.bodyPartCount === 'function' ? utils.bodyPartCount(miner.body, 'work') : 0);
    }
    return Math.min(sourceRate(sourceMemory), work * power);
}

function leaveEarly(creep, sourceMemory, load, capacity) {
    if (!(load > 0) || load < capacity * setting('departMinShare', 0.25)) return false;
    return sourceInflow(creep, sourceMemory) * tripTicks(creep, sourceMemory) <= load;
}


function ttlMargin() {
    return setting('ttlMargin', 20);
}

function recordLeg(creep, kind, dropRoom) {
    const started = Number(creep.memory.legAt);
    delete creep.memory.leg;
    delete creep.memory.legAt;
    delete creep.memory.legRoom;
    if (!(started > 0) || !dropRoom) return;
    const ticks = Game.time - started;
    const sourceMemory = remote.getSource(creep.memory.home, creep.memory.remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory || !(ticks > 0) || ticks > 4 * routeDistance(creep, sourceMemory) + 100) return;
    if (!sourceMemory.legs || sourceMemory.legs.room !== dropRoom) sourceMemory.legs = { room: dropRoom };
    const legs = sourceMemory.legs;
    legs[kind] = legs[kind] > 0 ? Math.round((legs[kind] * 0.7 + ticks * 0.3) * 10) / 10 : ticks;
    legs[kind + 'N'] = (Number(legs[kind + 'N']) || 0) + 1;
}

function legOf(sourceMemory, kind, dropRoom) {
    const legs = sourceMemory && sourceMemory.legs;
    return legs && legs.room === dropRoom && legs[kind] > 0 ? Number(legs[kind]) : null;
}

function backTicks(creep, sourceMemory, dropRoom) {
    const room = dropRoom || creep.memory.dropRoom || remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    return legOf(sourceMemory, 'back', room) || routeDistance(creep, sourceMemory) * ladenPerTile(creep, sourceMemory);
}

function outTicks(creep, sourceMemory, dropRoom) {
    return legOf(sourceMemory, 'out', dropRoom) || routeDistance(creep, sourceMemory);
}

function replacementPlanned(creep, sourceMemory) {
    const slot = creep.memory.slotKey;
    if (!slot) return false;
    const retiring = typeof utils.isRetiring === 'function' ? utils.isRetiring : () => false;
    const list = typeof utils.creepsHomeRole === 'function' ? utils.creepsHomeRole(creep.memory.home, 'remoteHauler') : [];
    if (list.some((other) => other && other !== creep && other.memory && other.memory.slotKey === slot && !retiring(other.memory))) return true;
    const lead = (creep.body || []).length * 3 + routeDistance(creep, sourceMemory) + 20;
    return creep.ticksToLive != null && creep.ticksToLive <= lead;
}

function containerAbsorbs(creep, sourceMemory, gap) {
    const container = sourceMemory && sourceMemory.containerId && typeof Game.getObjectById === 'function' ?
        Game.getObjectById(sourceMemory.containerId) : null;
    if (!container || !container.store) return true;
    const free = freeOf(container);
    return !Number.isFinite(free) || free >= gap * sourceInflow(creep, sourceMemory);
}

function ttlRetire(creep, plan, dropRoom) {
    if (creep.ticksToLive == null) return false;
    const sourceMemory = remote.getSource(creep.memory.home, creep.memory.remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory) return false;
    const cycle = Math.round(outTicks(creep, sourceMemory, dropRoom) + backTicks(creep, sourceMemory, dropRoom) + ttlMargin());
    if (creep.ticksToLive >= cycle) return false;
    const detail = { ttl: creep.ticksToLive, cycle, slot: creep.memory.slotKey || null };
    if (!replacementPlanned(creep, sourceMemory) && !containerAbsorbs(creep, sourceMemory, cycle - creep.ticksToLive)) {
        noteTtl(creep, 'keep', detail);
        return false;
    }
    noteTtl(creep, 'retire', detail);
    retireEmpty(creep, plan);
    return true;
}

function suspendedTooLong(creep) {
    const home = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!remote.isSuspended(home, remoteRoom) || typeof remote.suspensionLeft !== 'function') return false;
    const left = remote.suspensionLeft(home, remoteRoom);
    if (left > setting('suspendRetireAfter', 300)) return true;
    if (creep.ticksToLive == null) return false;
    const sourceMemory = remote.getSource(home, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    return left + routeDistance(creep, sourceMemory) >= creep.ticksToLive;
}


function droppedNear(creep, sourceMemory) {
    return creep.room.find(FIND_DROPPED_RESOURCES, {
        filter: (resource) => resource.resourceType === RESOURCE_ENERGY && resource.amount > 0 &&
            (!sourceMemory || !sourceMemory.spot || Math.max(Math.abs(resource.pos.x - sourceMemory.spot.x),
                Math.abs(resource.pos.y - sourceMemory.spot.y)) <= 3),
    });
}

function stepOffSpot(creep, plan, spot) {
    const room = creep.room;
    const terrain = room && typeof room.getTerrain === 'function' ? room.getTerrain() : null;
    const look = (kind, x, y) => (room && typeof room.lookForAt === 'function' && kind != null ? room.lookForAt(kind, x, y) || [] : []);
    const structuresKind = typeof LOOK_STRUCTURES === 'undefined' ? null : LOOK_STRUCTURES;
    const creepsKind = typeof LOOK_CREEPS === 'undefined' ? null : LOOK_CREEPS;
    const blockers = [];
    for (const kind of [typeof FIND_SOURCES === 'undefined' ? null : FIND_SOURCES, typeof FIND_MINERALS === 'undefined' ? null : FIND_MINERALS]) {
        if (kind != null && room && typeof room.find === 'function') for (const item of room.find(kind) || []) if (item && item.pos) blockers.push(item.pos);
    }
    if (room && room.controller && room.controller.pos) blockers.push(room.controller.pos);
    let best = null;
    let bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = creep.pos.x + dx;
        const y = creep.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48 || (x === spot.x && y === spot.y)) continue;
        if (terrain && terrain.get(x, y) === WALL_MASK) continue;
        if (blockers.some((pos) => pos.x === x && pos.y === y)) continue;
        if (look(structuresKind, x, y).some((s) => s.structureType !== ROAD && s.structureType !== CONTAINER &&
            !(s.structureType === RAMPART && s.my !== false))) continue;
        if (look(creepsKind, x, y).some((other) => other && other !== creep)) continue;
        const score = Math.max(Math.abs(x - spot.x), Math.abs(y - spot.y)) <= 1 ? 0 : 1;
        if (score < bestScore) { bestScore = score; best = { x, y }; }
    }
    if (!best) return false;
    creep.memory.spotYield = Game.time;
    noteHaul(creep, 'stepOff');
    go(creep, plan, new RoomPosition(best.x, best.y, room.name), { range: 0, reusePath: 5 });
    return true;
}

function depart(creep, plan, load) {
    creep.memory.state = 'deliver';
    if (!creep.memory.dropRoom) creep.memory.dropRoom = remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    plan.stopEnd = true;
    creep.memory.leg = 'back';
    creep.memory.legAt = Game.time;
    if (creep.memory.spotYield) {
        noteHaul(creep, 'yieldDepart');
        const mem = homeMem(creep);
        if (mem && mem.remoteHaul) mem.remoteHaul.yieldLoad = Math.max(Number(mem.remoteHaul.yieldLoad) || 0, load || 0);
        delete creep.memory.spotYield;
    }
    go(creep, plan, new RoomPosition(25, 25, creep.memory.dropRoom), { range: 20, reusePath: 35 });
}

function travelTarget(creep, homeName, remoteRoom) {
    const sourceMemory = remote.getSource(homeName, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    const spot = sourceMemory && sourceMemory.spot;
    if (spot && spot.x != null && spot.y != null) return { pos: new RoomPosition(spot.x, spot.y, remoteRoom), range: 1 };
    return { pos: new RoomPosition(25, 25, remoteRoom), range: 20 };
}

function collect(creep, plan) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (creep.room.name !== remoteRoom) {
        if (remote.noteTravel(creep)) return;
        const target = travelTarget(creep, homeName, remoteRoom);
        go(creep, plan, target.pos, { range: target.range, reusePath: 40 });
        return;
    }

    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);
    if (remote.isSuspended(homeName, remoteRoom)) {
        creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? 'deliver' : 'retreat';
        if (creep.memory.state === 'deliver') deliver(creep, plan);
        else idleHome(creep);
        return;
    }
    const sourceMemory = remote.getSource(homeName, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory || !sourceMemory.spot) return;
    if (!creep.memory.sourceId && sourceMemory.id) creep.memory.sourceId = sourceMemory.id;
    const spot = sourceMemory.spot;
    const container = creep.room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y)
        .find((structure) => structure.structureType === STRUCTURE_CONTAINER);
    const energy = energyOf(creep);
    const free = Math.max(0, Number(creep.store.getFreeCapacity(RESOURCE_ENERGY)) || 0);
    const capacity = energy + free;
    const onSpot = creep.pos.x === spot.x && creep.pos.y === spot.y;
    if (creep.memory.leg === 'out' && Math.max(Math.abs(creep.pos.x - spot.x), Math.abs(creep.pos.y - spot.y)) <= 1) {
        recordLeg(creep, 'out', creep.memory.legRoom);
    }
    const ttl = creep.ticksToLive;
    const back = ttl == null ? 0 : backTicks(creep, sourceMemory);
    if (ttl != null && energy > 0 && ttl < back) {
        const sent = container && isNear(creep, container) ? Math.min(energy, freeOf(container)) : 0;
        if (sent > 0 ? creep.transfer(container, RESOURCE_ENERGY, sent) === RC_OK : creep.drop(RESOURCE_ENERGY) === RC_OK) {
            noteTtl(creep, 'dump', { ttl, back: Math.round(back), energy });
            creep.memory.retired = true;
        }
        return;
    }

    const drops = droppedNear(creep, sourceMemory);
    let pile = null;
    for (const item of drops) if (isNear(creep, item) && (!pile || item.amount > pile.amount)) pile = item;
    const pileAvail = pile ? Math.max(0, Number(pile.amount) - takenThisTick(pile.id)) : 0;
    const containerNear = !!container && isNear(creep, container);
    const containerAvail = containerNear ? Math.max(0, energyOf(container) - takenThisTick(container.id)) : 0;
    let gained = 0;
    if (free > 0 && (pileAvail > 0 || containerAvail > 0)) {
        const pileTake = Math.min(free, pileAvail);
        const withdrawAmount = Math.min(containerAvail, free - pileTake);
        if (withdrawAmount > 0 && creep.withdraw(container, RESOURCE_ENERGY, withdrawAmount) === RC_OK) {
            gained += withdrawAmount;
            recordTaken(container.id, withdrawAmount);
            plan.acted = true;
        }
        if (pileTake > 0) {
            const before = energy + gained;
            if (creep.pickup(pile) === RC_OK) {
                gained += pileTake;
                recordTaken(pile.id, pileTake);
                plan.acted = true;
                creep.memory.remotePickupPending = { at: Game.time, before };
            }
        }
    }
    const load = energy + gained;
    if (capacity > 0 && load >= capacity) { depart(creep, plan, load); return; }
    if (ttl != null && ttl <= back + setting('ttlDepartMargin', 10)) {
        if (load > 0) {
            noteTtl(creep, 'depart', { ttl, back: Math.round(back), load });
            depart(creep, plan, load);
        } else {
            noteTtl(creep, 'retire', { ttl, back: Math.round(back), load: 0 });
            retireEmpty(creep, plan);
        }
        return;
    }
    if (container && leaveEarly(creep, sourceMemory, load, capacity)) {
        noteHaul(creep, 'partialDepart');
        depart(creep, plan, load);
        return;
    }
    if (container && !containerNear) {
        go(creep, plan, container, { range: 1, reusePath: 30, maxRooms: 1 });
        return;
    }
    if (gained > 0) {
        if (onSpot) stepOffSpot(creep, plan, spot);
        return;
    }
    const far = closestOf(creep, drops.filter((item) => !isNear(creep, item)));
    if (far) {
        go(creep, plan, far, { range: 1, reusePath: 15, maxRooms: 1 });
        return;
    }
    const worked = nearbyInfrastructureWork(creep);
    if (onSpot) { stepOffSpot(creep, plan, spot); return; }
    if (worked) return;
    note(creep, 'wait');
    const wait = new RoomPosition(spot.x, spot.y, remoteRoom);
    if (!creep.pos.inRangeTo(wait, 1)) go(creep, plan, wait, { range: 1, reusePath: 25, maxRooms: 1 });
}

function run(creep) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!homeName || !remoteRoom) return;
    if (require('pvp').fleeHighThreat(creep)) return;
    settleRoadBudget(creep);
    if (creep.room && creep.room.name !== remoteRoom) flushRoadTrail(creep);
    const pending = creep.memory.remotePickupPending;
    if (pending && pending.at < Game.time) {
        const gained = creep.store[RESOURCE_ENERGY] - pending.before;
        const mem = Memory.rooms && Memory.rooms[homeName];
        if (mem && pending.at === Game.time - 1 && gained > 0) {
            const record = mem.remoteEnergySalvaged || (mem.remoteEnergySalvaged = { amount: 0, n: 0 });
            record.amount += gained;
            record.n++;
            record.at = Game.time;
        }
        delete creep.memory.remotePickupPending;
    }
    if (creep.memory.retired) {
        note(creep, 'retire');
        retireNow(creep);
        return;
    }
    if (!creep.memory.state) creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? 'deliver' : 'collect';
    if (remote.keeperRetreat(creep)) { note(creep, 'keeperRetreat'); return; }
    const suspended = remote.isSuspended(homeName, remoteRoom);
    if (suspended && creep.memory.leg) { delete creep.memory.leg; delete creep.memory.legAt; delete creep.memory.legRoom; }
    const here = creep.room;
    if (suspended && creep.store[RESOURCE_ENERGY] <= 0) creep.memory.state = 'retreat';
    else if (suspended || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.state = 'deliver';
    else if (creep.memory.state === 'deliver' && creep.store[RESOURCE_ENERGY] <= 0) {
        const dropName = creep.memory.dropRoom;
        creep.memory.state = 'collect';
        delete creep.memory.dropRoom;
        if (creep.memory.stopAt != null && here && here.name === dropName) recordStop(creep, dropName);
        else { delete creep.memory.stopAt; delete creep.memory.stopDist; }
        if (here && here.name !== remoteRoom && here.controller && here.controller.my && ttlRetire(creep, null, dropName || here.name)) return;
    }
    else if (creep.memory.state === 'collect' && creep.store[RESOURCE_ENERGY] > 0 && here && here.name !== remoteRoom) {
        creep.memory.state = 'deliver';
    }
    else if (creep.memory.state === 'retreat') creep.memory.state = 'collect';

    const plan = newPlan();
    try {
        if (creep.memory.state === 'deliver') {
            if (!suspended && creep.room.name === remoteRoom) {
                traceRoadTile(creep);
                const work = nearbyInfrastructureWork(creep);
                if (work === 'container') return;
                if (work === 'road') plan.built = true;
            }
            deliver(creep, plan);
        }
        else if (creep.memory.state === 'retreat') idleHome(creep);
        else collect(creep, plan);
    } finally {
        if (plan.built && plan.moved) noteHaul(creep, 'buildMove');
        if (plan.stopEnd) {
            const mem = homeMem(creep);
            if (mem) {
                const act = mem.remoteHaulAct || (mem.remoteHaulAct = { ac: 0, acm: 0 });
                act.ac++;
                if (plan.moved) act.acm++;
                act.at = Game.time;
            }
        }
    }
}

module.exports = { run, homeTarget, driveByTarget, openFor, rangeTo };
