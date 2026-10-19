'use strict';
const layout = require('layout');
const config = require('config');
const movement = require('movement');
const taskBroker = require('task_broker');
const links = require('links');
const haulStats = require('haul_stats');
const { findCached, logErr, storageRichState, towerUrgent, spawnWaitingFor } = require('utils');

function energyIn(store) {
    return store ? Number(store[RESOURCE_ENERGY] || 0) : 0;
}

function freeIn(target) {
    const store = target && target.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return 0;
    return Math.max(0, Number(store.getFreeCapacity(RESOURCE_ENERGY)) || 0);
}

function amountAt(target) {
    if (!target) return 0;
    return target.amount != null ? Number(target.amount) || 0 : energyIn(target.store);
}

function posOf(target) {
    return target && target.pos ? target.pos : target;
}

function distance(creep, target) {
    const pos = posOf(target);
    if (!pos || !creep.pos || (pos.roomName && pos.roomName !== creep.pos.roomName)) return 50;
    return Math.max(Math.abs(creep.pos.x - pos.x), Math.abs(creep.pos.y - pos.y));
}

function near(creep, target) {
    return distance(creep, target) <= 1;
}

function hauling() {
    return config.hauling || {};
}

function ctrlContainer(room) {
    if (taskBroker.controllerFeedMode(room) === 'link') return null;
    const plan = (Memory.rooms[room.name] || {}).plan;
    if (!plan || !plan.containers || !plan.containers.ctrl) return null;
    if (layout.controllerFedByStorage(room, plan)) return null;
    return layout.structureAt(room, plan.containers.ctrl.x, plan.containers.ctrl.y, STRUCTURE_CONTAINER);
}

const consumerReserveBudget = { tick: -1, rooms: {} };
const roomContexts = { tick: -1, rooms: {} };

function contextFor(room) {
    if (roomContexts.tick !== Game.time) { roomContexts.tick = Game.time; roomContexts.rooms = {}; }
    let ctx = roomContexts.rooms[room.name];
    if (ctx) return ctx;
    const plan = (Memory.rooms[room.name] || {}).plan;
    ctx = { plan, hubFed: links.hubHaulMode(room, plan), demand: null, urgent: null };
    roomContexts.rooms[room.name] = ctx;
    return ctx;
}

function consumerTasks(room) {
    return taskBroker.pooledTasks(room).filter((task) => task.kind === 'deliver' && task.target &&
        task.target.store && task.target.structureType !== STRUCTURE_STORAGE &&
        !(task.target.structureType === STRUCTURE_CONTAINER && srcIsPlanned(room, task.target)) &&
        (!task.roles || task.roles.includes('hauler')) && task.backlog > 0);
}

function consumerDemand(room, ctx) {
    if (ctx.demand == null) {
        const open = consumerTasks(room).reduce((sum, task) => sum + Math.max(0, taskBroker.availableFor(task, null)), 0);
        ctx.demand = Math.max(0, open - idleStorageCargo(room, ctx));
    }
    return ctx.demand;
}

function idleStorageCargo(room, ctx) {
    if (ctx.idleCargo != null) return ctx.idleCargo;
    let sum = 0;
    for (const other of findCached(room, FIND_MY_CREEPS) || []) {
        const memory = other && other.memory;
        if (!memory || memory.role !== 'hauler' || memory.home !== room.name || !memory.hubCargo) continue;
        if (memory.brokerTask && memory.brokerTask.until >= Game.time) continue;
        sum += energyIn(other.store);
    }
    ctx.idleCargo = sum;
    return sum;
}

function isUrgent(room, ctx) {
    if (ctx.urgent != null) return ctx.urgent;
    const share = Number(hauling().urgentSpawnShare);
    let urgent = spawnWaitingFor(room) ||
        room.energyAvailable < room.energyCapacityAvailable * (Number.isFinite(share) ? share : 0.3);
    if (!urgent) urgent = taskBroker.pooledTasks(room).some((task) => task.kind === 'deliver' && task.tier === 1 && task.weight >= 11 && task.backlog > 0);
    ctx.urgent = urgent;
    return urgent;
}

function storageCargoLocked(creep) {
    if (!creep.memory.hubCargo) return false;
    const since = Number(creep.memory.hubCargoAt);
    const release = Number(hauling().storageCargoRelease) || 100;
    return !(since > 0 && Game.time - since > release);
}

function markStorageCargo(creep) {
    creep.memory.hubCargo = true;
    creep.memory.hubCargoAt = Game.time;
}

function releaseStorageResidual(creep, load, capacity) {
    if (!storageCargoLocked(creep)) return false;
    if (load >= Math.max(50, capacity * (Number(hauling().topUpShare) || 0.25))) return false;
    delete creep.memory.hubCargo;
    delete creep.memory.hubCargoAt;
    noteCounter(creep.room || Game.rooms[creep.memory.home], 'haulCargoRelease');
    return true;
}

function noteCounter(room, key) {
    if (!room || !room.name) return;
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem[key] || (mem[key] = { n: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.at = Game.time;
}


const DELIVER_PASSES = [
    (task) => task.tier === 1 && task.weight >= 10,
    (task) => task.tier === 1,
    (task) => task.tier === 2,
    (task) => task.tier === 3,
    (task) => task.tier === 4,
];

function deliverFilter(creep, room, exclude) {
    const locked = storageCargoLocked(creep);
    return (candidate) => candidate.kind === 'deliver' && candidate.target && candidate.target.store &&
        !(exclude && exclude.has(candidate.target.id)) &&
        !(locked && candidate.target.structureType === STRUCTURE_STORAGE) &&
        !(candidate.target.structureType === STRUCTURE_CONTAINER && srcIsPlanned(room, candidate.target));
}

function openTarget(creep, room, target) {
    const ctx = contextFor(room);
    if (!ctx.deliverIndex) {
        ctx.deliverIndex = {};
        for (const task of taskBroker.pooledTasks(room)) {
            if (task.kind !== 'deliver' || !task.target || !task.target.id) continue;
            (ctx.deliverIndex[task.target.id] || (ctx.deliverIndex[task.target.id] = [])).push(task);
        }
    }
    const tasks = ctx.deliverIndex[target.id];
    if (!tasks || !tasks.length) return true;
    return tasks.some((task) => taskBroker.availableFor(task, creep) > 0);
}

function pickDeliver(creep, room, exclude) {
    const base = deliverFilter(creep, room, exclude);
    let threw = false;
    try {
        for (const pass of DELIVER_PASSES) {
            const task = taskBroker.pickTask(creep, room, (candidate) => pass(candidate) && base(candidate), true);
            if (!task || !task.target) continue;
            if (task.target.structureType !== STRUCTURE_STORAGE) {
                const ctx = contextFor(room);
                ctx.demand = null;
                ctx.idleCargo = null;
            }
            return { target: task.target, task };
        }
    } catch (error) { threw = true; logErr('hauler.auctionTarget ' + creep.name, error); }
    const target = fallbackDeliver(creep, room, exclude, threw);
    return target ? { target, task: null } : null;
}

function fallbackDeliver(creep, room, exclude, threw) {
    const open = (structure) => !(exclude && exclude.has(structure.id)) && (threw || openTarget(creep, room, structure));
    const linkFeed = taskBroker.controllerFeedLink(room);
    if (threw && linkFeed && linkFeed.starved && open(linkFeed.target)) return linkFeed.target;
    const towerRefillAt = Number(config.towerRefillAt) || 300;
    const towerFilter = (s) => s.structureType === STRUCTURE_TOWER && freeIn(s) >= towerRefillAt && open(s);
    const hostile = room.find(FIND_HOSTILE_CREEPS).length > 0;
    let target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: (s) => towerFilter(s) && towerUrgent(room, s, hostile) });
    if (target) return target;
    target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && freeIn(s) > 0 && open(s),
    });
    if (target || !threw) return target || null;
    if (linkFeed && open(linkFeed.target)) return linkFeed.target;
    const uc = ctrlContainer(room);
    if (uc && freeIn(uc) > 0 && energyIn(uc.store) < uc.store.getCapacity(RESOURCE_ENERGY) * config.upgraderFillBelow && open(uc)) return uc;
    if (!uc) {
        const feed = taskBroker.controllerFeedStorage(room);
        if (feed && !storageCargoLocked(creep) && open(feed.target)) return feed.target;
    }
    target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: towerFilter });
    if (target) return target;
    const st = room.storage;
    if (st && st.my && !storageCargoLocked(creep) && freeIn(st) > 0 && !(exclude && exclude.has(st.id))) return st;
    return null;
}

function driveByTarget(creep, room, main, mainTask, exclude) {
    if (mainTask && mainTask.weight >= 11) return null;
    const found = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
        filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && freeIn(s) > 0,
    }) || [];
    for (const structure of found) {
        if (!structure || structure.id === (main && main.id) || distance(creep, structure) > 1) continue;
        if (exclude && exclude.has(structure.id)) continue;
        if (openTarget(creep, room, structure)) return structure;
    }
    return null;
}


function pickupBar(creep, target, free, urgent) {
    if (urgent) return Math.min(free, 50);
    const settings = hauling();
    const minimum = Number(settings.pickupMin) || 100;
    const share = Number(settings.pickupShare) || 0.5;
    const perTile = Number(settings.pickupPerTile) || 25;
    const travel = Math.max(0, distance(creep, target) - 1);
    return Math.min(free, Math.max(minimum, Math.min(free * share, minimum + perTile * travel)));
}

function hubNeedsEnergy(room, ctx) {
    return !ctx.hubFed || consumerTasks(room).length > 0;
}

function collectFilter(creep, room, ctx, free, exclude, allowStorage, loaded) {
    const urgent = isUrgent(room, ctx);
    const hubNeeds = hubNeedsEnergy(room, ctx);
    const plan = ctx.plan;
    return (candidate) => {
        if (candidate.kind !== 'collect' || !candidate.target) return false;
        const target = candidate.target;
        if (exclude && exclude.has(target.id)) return false;
        const available = taskBroker.availableFor(candidate, creep);
        if (candidate.tombstone) {
            const bar = distance(creep, target) <= 5 ? Math.min(free, 50) : pickupBar(creep, target, free, urgent);
            return available >= bar;
        }
        if (available < pickupBar(creep, target, free, urgent)) return false;
        if (target.amount != null) return target.resourceType === RESOURCE_ENERGY;
        if (target.structureType === STRUCTURE_STORAGE) {
            if (loaded) { noteCounter(room, 'haulLoadedStorageSkip'); return false; }
            return hubNeeds && (candidate.rich || candidate.hub) && (allowStorage || candidate.weight >= 8 || candidate.hub) &&
                storageWithdrawBudget(creep, room, ctx, free) >= Math.min(50, free);
        }
        if (target.structureType === STRUCTURE_TERMINAL) return !!candidate.terminalDrain;
        return target.structureType === STRUCTURE_CONTAINER && srcIsPlanned(room, target) &&
            !links.skipSourceContainer(room, plan, target);
    };
}

function pickCollect(creep, room, ctx, free, exclude, loaded) {
    try {
        const task = taskBroker.pickTask(creep, room, collectFilter(creep, room, ctx, free, exclude, false, loaded), true) ||
            taskBroker.pickTask(creep, room, collectFilter(creep, room, ctx, free, exclude, true, loaded), true);
        return task && task.target ? { target: task.target, task } : null;
    } catch (error) {
        logErr('hauler.auctionSource ' + creep.name, error);
        const target = fallbackCollect(creep, room, ctx);
        return target ? { target, task: null } : null;
    }
}

function fallbackCollect(creep, room, ctx) {
    const plan = ctx.plan;
    const hubNeeds = hubNeedsEnergy(room, ctx);
    const st = room.storage;
    if (ctx.hubFed && hubNeeds && st && st.my && energyIn(st.store) >= 50) return st;
    const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER && energyIn(s.store) >= 100 &&
            plan && srcIsPlanned(room, s) && !links.skipSourceContainer(room, plan, s),
    });
    if (container) return container;
    const drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 80 && !links.skipLinkedDrop(room, plan, r),
    });
    if (drop) return drop;
    if (st && st.my && hubNeeds && (ctx.hubFed || storageRichState(room, Memory.rooms[room.name], config.upgrading || {}))) return st;
    return creep.pos.findClosestByPath(FIND_TOMBSTONES, { filter: (t) => energyIn(t.store) >= 50 }) ||
        (typeof FIND_RUINS !== 'undefined' ? creep.pos.findClosestByPath(FIND_RUINS, { filter: (t) => energyIn(t.store) >= 50 }) : null);
}

function storageWithdrawBudget(creep, room, ctx, free) {
    if (!room.storage || !room.storage.my) return 0;
    if (consumerReserveBudget.tick !== Game.time) { consumerReserveBudget.tick = Game.time; consumerReserveBudget.rooms = {}; }
    const reserved = consumerReserveBudget.rooms[room.name] || 0;
    const reserve = ctx.hubFed ? 0 : Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const available = Math.max(0, energyIn(room.storage.store) - reserve - reserved);
    const unreserved = Math.max(0, consumerDemand(room, ctx) - reserved);
    return Math.min(available, unreserved, free);
}

const WAIT_HORIZON = 30;
function waitTarget(creep, room, ctx, exclude) {
    let best = null;
    let bestAmount = 0;
    const spots = taskBroker.waitSpots(room).filter((task) => task.target && !(exclude && exclude.has(task.target.id)) &&
        srcIsPlanned(room, task.target) && !links.skipSourceContainer(room, ctx.plan, task.target));
    const sticky = creep.memory.fill && spots.find((task) => task.target.id === creep.memory.fill);
    if (sticky && taskBroker.availableFor(sticky, creep) + sticky.inflow * WAIT_HORIZON > 0) return sticky;
    for (const task of spots) {
        const travel = Math.max(0, distance(creep, task.target) - 1);
        const score = taskBroker.availableFor(task, creep) + task.inflow * Math.max(0, WAIT_HORIZON - travel);
        if (score > bestAmount) { best = task; bestAmount = score; }
    }
    return best;
}


function newPlan() {
    return { move: null, moveRange: 1, pickup: false, withdraw: false, transfer: false, gained: 0, exclude: new Set(), fillKept: false };
}

function roundTripEstimate(creep, room) {
    const anchor = room.storage || room.find(FIND_MY_SPAWNS)[0];
    return anchor ? 2 * distance(creep, anchor) + 10 : 40;
}

function opportunistic(creep, room, plan, free, delivering) {
    if (free <= 0) return;
    const drops = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, { filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0 }) || [];
    let drop = null;
    for (const item of drops) if (distance(creep, item) <= 1 && (!drop || item.amount > drop.amount)) drop = item;
    const dropAmount = drop ? Number(drop.amount) || 0 : 0;
    if (drop && creep.pickup(drop) === OK) {
        const got = Math.min(free, dropAmount);
        plan.pickup = true;
        plan.gained += got;
        plan.exclude.add(drop.id);
        taskBroker.consume(creep, room, drop, got, 'collect');
    }
    const left = free - plan.gained;
    if (!delivering || left < 10) return;
    const kinds = [FIND_TOMBSTONES];
    if (typeof FIND_RUINS !== 'undefined') kinds.push(FIND_RUINS);
    for (const kind of kinds) {
        const found = creep.pos.findInRange(kind, 1, { filter: (t) => t.store && energyIn(t.store) > 0 }) || [];
        const tomb = found.find((t) => distance(creep, t) <= 1);
        const have = tomb ? energyIn(tomb.store) : 0;
        if (tomb && creep.withdraw(tomb, RESOURCE_ENERGY, Math.min(left, have)) === OK) {
            const got = Math.min(left, have);
            plan.withdraw = true;
            plan.gained += got;
            plan.exclude.add(tomb.id);
            taskBroker.consume(creep, room, tomb, got, 'collect');
            return;
        }
    }
}

function planAfterDelivery(creep, room, ctx, plan, left, capacity) {
    if (left > 0) {
        const next = pickDeliver(creep, room, plan.exclude);
        if (next) { if (!near(creep, next.target)) plan.move = next.target; return; }
        releaseStorageResidual(creep, left, capacity);
        if (storageCargoLocked(creep) || capacity - left < capacity * (Number(hauling().topUpShare) || 0.25)) return;
    }
    const free = capacity - left;
    const source = pickCollect(creep, room, ctx, free, plan.exclude, left > 0);
    if (source) { if (!near(creep, source.target)) plan.move = source.target; return; }
    if (left > 0) return;
    const wait = waitTarget(creep, room, ctx, plan.exclude);
    if (wait && !near(creep, wait.target)) plan.move = wait.target;
}

function noteTerminalFill(room, carried, want) {
    if (typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem.terminalFillSent || (mem.terminalFillSent = { n: 0, amount: 0, capped: 0, trimmed: 0 });
    const sent = Math.max(0, Math.min(carried, want));
    rec.n = (Number(rec.n) || 0) + 1;
    rec.amount = (Number(rec.amount) || 0) + sent;
    if (want < carried) { rec.capped = (Number(rec.capped) || 0) + 1; rec.trimmed = (Number(rec.trimmed) || 0) + (carried - sent); }
    rec.at = Game.time;
}

function deliver(creep, room, ctx, plan, energy, capacity) {
    const load = energy + plan.gained;
    const choice = pickDeliver(creep, room, plan.exclude);
    if (!choice) {
        releaseStorageResidual(creep, load, capacity);
        if (!storageCargoLocked(creep) && capacity - load >= capacity * (Number(hauling().topUpShare) || 0.25) &&
            collect(creep, room, ctx, plan, load, capacity)) return;
        haulStats.note(creep, 'full');
        park(creep, room, plan);
        return;
    }
    const target = choice.target;
    if (near(creep, target)) {
        let sent = Math.min(energy, freeIn(target));
        if (target.structureType === STRUCTURE_TERMINAL) {
            const want = taskBroker.terminalEnergyWant(room, target);
            noteTerminalFill(room, sent, want);
            if (want < sent) sent = want;
            if (sent <= 0) {
                plan.exclude.add(target.id);
                planAfterDelivery(creep, room, ctx, plan, load, capacity);
                return;
            }
        }
        if (sent > 0 && creep.transfer(target, RESOURCE_ENERGY, sent) === OK) {
            plan.transfer = true;
            taskBroker.consume(creep, room, target, sent, 'deliver');
            plan.exclude.add(target.id);
            const left = Math.max(0, load - sent);
            taskBroker.setProjected(creep, left);
            planAfterDelivery(creep, room, ctx, plan, left, capacity);
        }
        return;
    }
    const drive = driveByTarget(creep, room, target, choice.task, plan.exclude);
    if (drive) {
        const sent = Math.min(energy, freeIn(drive));
        if (sent > 0 && creep.transfer(drive, RESOURCE_ENERGY, sent) === OK) {
            plan.transfer = true;
            taskBroker.consume(creep, room, drive, sent, 'deliver');
            plan.exclude.add(drive.id);
            const left = Math.max(0, load - sent);
            taskBroker.setProjected(creep, left);
            if (left <= 0) { planAfterDelivery(creep, room, ctx, plan, 0, capacity); return; }
        }
    }
    plan.move = target;
}

function shouldLeave(creep, room, ctx, load, capacity, task) {
    if (load >= capacity * (Number(hauling().leaveShare) || 0.9)) return true;
    if (isUrgent(room, ctx)) return true;
    const inflow = task && task.inflow > 0 ? task.inflow : 0;
    if (!inflow) return true;
    return inflow * roundTripEstimate(creep, room) <= load;
}

function collect(creep, room, ctx, plan, carried, capacity) {
    const free = Math.max(0, capacity - carried);
    if (free <= 0) return false;
    const pick = pickCollect(creep, room, ctx, free, plan.exclude, carried > 0);
    if (pick) {
        const target = pick.target;
        if (target.id === creep.memory.fill) plan.fillKept = true;
        if (!near(creep, target)) { plan.move = target; return true; }
        const got = takeFrom(creep, room, ctx, plan, target, free, pick.task);
        if (got > 0) leaveOrFill(creep, room, ctx, plan, target, pick.task, carried + got, capacity);
        return true;
    }
    if (carried <= 0 && consumerFallback(creep, room, ctx, plan, free)) return true;
    const wait = waitTarget(creep, room, ctx, plan.exclude);
    if (!wait) return false;
    if (carried > 0 && creep.memory.fill && wait.target.id !== creep.memory.fill) {
        dropFill(creep, room);
        return false;
    }
    haulStats.note(creep, 'wait');
    taskBroker.leaseSpot(creep, wait);
    if (wait.target.id === creep.memory.fill) plan.fillKept = true;
    if (!near(creep, wait.target)) { plan.move = wait.target; return true; }
    if (creep.memory.fill !== wait.target.id) noteFill(room, 'start', carried / Math.max(1, capacity));
    creep.memory.fill = wait.target.id;
    plan.fillKept = true;
    const stock = amountAt(wait.target);
    if (stock >= Math.min(free, FILL_CHUNK) && !plan.withdraw) {
        const got = takeFrom(creep, room, ctx, plan, wait.target, free, wait);
        if (got > 0) leaveOrFill(creep, room, ctx, plan, wait.target, wait, carried + got, capacity);
    }
    return true;
}
const FILL_CHUNK = 100;

function leaveOrFill(creep, room, ctx, plan, target, task, load, capacity) {
    taskBroker.setProjected(creep, load);
    if (shouldLeave(creep, room, ctx, load, capacity, task)) {
        if (creep.memory.fill) noteFill(room, 'left', load / Math.max(1, capacity));
        delete creep.memory.fill;
        const next = pickDeliver(creep, room, plan.exclude);
        if (next && !near(creep, next.target)) plan.move = next.target;
        return;
    }
    if (creep.memory.fill !== target.id) noteFill(room, 'start', load / Math.max(1, capacity));
    creep.memory.fill = target.id;
    plan.fillKept = true;
    taskBroker.holdClaim(creep, target.id + ':collect');
}

function noteFill(room, kind, share) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem.haulFill || (mem.haulFill = { start: 0, left: 0, share: 0 });
    rec[kind] = (Number(rec[kind]) || 0) + 1;
    if (kind === 'left') rec.share = Math.round(((Number(rec.share) || 0) * (rec.left - 1) + share) / rec.left * 100) / 100;
    rec.at = Game.time;
}

function dropFill(creep, room) {
    if (!creep.memory.fill) return;
    noteFill(room, 'drop');
    delete creep.memory.fill;
}

function takeFrom(creep, room, ctx, plan, target, free, task) {
    const before = task && task.target && task.target.id === target.id ? Math.min(amountAt(target), Math.max(0, Number(task.backlog) || 0)) : amountAt(target);
    if (target.amount != null) {
        if (plan.pickup) return 0;
        if (creep.pickup(target) !== OK) return 0;
        plan.pickup = true;
        const got = Math.min(free, before);
        plan.exclude.add(target.id);
        taskBroker.consume(creep, room, target, got, 'collect');
        return got;
    }
    if (plan.withdraw) return 0;
    const isStorage = target.structureType === STRUCTURE_STORAGE;
    let amount = Math.min(free, before);
    if (isStorage) amount = Math.min(amount, storageWithdrawBudget(creep, room, ctx, free));
    if (amount <= 0 || (isStorage && amount < 50 && amount < free)) return 0;
    if (creep.withdraw(target, RESOURCE_ENERGY, amount) !== OK) return 0;
    plan.withdraw = true;
    plan.exclude.add(target.id);
    taskBroker.consume(creep, room, target, amount, 'collect');
    if (target.structureType === STRUCTURE_TERMINAL) {
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const rec = mem.terminalDrain || (mem.terminalDrain = { n: 0, amount: 0 });
        rec.n = (Number(rec.n) || 0) + 1;
        rec.amount = (Number(rec.amount) || 0) + amount;
        rec.at = Game.time;
        if (task && Number(task.drainKeep) > 0) rec.low = (Number(rec.low) || 0) + amount;
    }
    if (isStorage) {
        markStorageCargo(creep);
        consumerReserveBudget.rooms[room.name] = (consumerReserveBudget.rooms[room.name] || 0) + amount;
        if (ctx.hubFed) {
            const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
            const rec = mem.hubBudgetedWithdraw || (mem.hubBudgetedWithdraw = { n: 0, amount: 0 });
            rec.n = (Number(rec.n) || 0) + 1;
            rec.amount = (Number(rec.amount) || 0) + amount;
            rec.at = Game.time;
        }
    }
    return amount;
}

function consumerFallback(creep, room, ctx, plan, free) {
    if (ctx.hubFed || !room.storage || !room.storage.my || plan.withdraw) return false;
    const amount = storageWithdrawBudget(creep, room, ctx, free);
    if (amount < 50) return false;
    if (!near(creep, room.storage)) { plan.move = room.storage; return true; }
    const ret = creep.withdraw(room.storage, RESOURCE_ENERGY, amount);
    if (ret !== OK) return true;
    plan.withdraw = true;
    consumerReserveBudget.rooms[room.name] = (consumerReserveBudget.rooms[room.name] || 0) + amount;
    markStorageCargo(creep);
    const memory = Memory.rooms[room.name];
    memory.storageConsumerFallback = (memory.storageConsumerFallback || 0) + amount;
    taskBroker.consume(creep, room, room.storage, amount, 'collect');
    taskBroker.setProjected(creep, amount);
    const next = pickDeliver(creep, room, plan.exclude);
    if (next && !near(creep, next.target)) plan.move = next.target;
    return true;
}

function park(creep, room, plan) {
    const anchor = room.storage || room.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) { plan.move = anchor; plan.moveRange = 3; }
}


function nonEnergyIn(store) {
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') {
        return Math.max(0, (Number(store.getUsedCapacity()) || 0) - (Number(store.getUsedCapacity(RESOURCE_ENERGY)) || 0));
    }
    let sum = 0;
    for (const key of Object.keys(store)) {
        if (key === RESOURCE_ENERGY || typeof store[key] !== 'number') continue;
        sum += Math.max(0, store[key]);
    }
    return sum;
}

function firstNonEnergyType(store) {
    if (!store) return null;
    for (const key of Object.keys(store)) {
        if (key === RESOURCE_ENERGY || typeof store[key] !== 'number' || store[key] <= 0) continue;
        return key;
    }
    return null;
}

function salvageSink(room, type) {
    return [room.terminal, room.storage].find((s) => s && s.my && s.store &&
        typeof s.store.getFreeCapacity === 'function' &&
        Number(s.store.getFreeCapacity(type == null ? undefined : type)) > 0) || null;
}

function salvageTargets(room) {
    const piles = {};
    const add = (pos, amount, item) => {
        if (!pos || !(amount > 0)) return;
        const key = pos.x + ',' + pos.y;
        const pile = piles[key] || (piles[key] = { pos, amount: 0, items: [] });
        pile.amount += amount;
        pile.items.push(item);
    };
    for (const kind of [FIND_TOMBSTONES, typeof FIND_RUINS !== 'undefined' ? FIND_RUINS : null]) {
        if (kind == null) continue;
        for (const item of findCached(room, kind) || []) add(item.pos, nonEnergyIn(item.store), item);
    }
    for (const drop of findCached(room, FIND_DROPPED_RESOURCES) || []) {
        if (!drop.resourceType || drop.resourceType === RESOURCE_ENERGY) continue;
        add(drop.pos, Number(drop.amount) || 0, drop);
    }
    return Object.keys(piles).map((key) => piles[key]);
}

function salvageClaimed(room, self) {
    const claimed = new Set();
    for (const other of findCached(room, FIND_MY_CREEPS) || []) {
        const claim = other && other.memory && other.memory.salvage;
        if (!claim || (self && other.name === self.name)) continue;
        claimed.add(claim.x + ',' + claim.y);
    }
    return claimed;
}

function salvageNum(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function pickSalvage(creep, room, targets) {
    const settings = config.salvage || {};
    const minAmount = salvageNum(settings.minAmount, 30);
    const perTile = salvageNum(settings.perTile, 0);
    const maxRange = salvageNum(settings.maxRange, 40);
    const claimed = salvageClaimed(room, creep);
    let best = null;
    let bestScore = 0;
    for (const pile of targets) {
        if (claimed.has(pile.pos.x + ',' + pile.pos.y)) continue;
        const travel = distance(creep, pile);
        if (travel > maxRange || pile.amount < minAmount + perTile * travel) continue;
        const score = pile.amount / (travel + 1);
        if (score > bestScore) { best = pile; bestScore = score; }
    }
    return best;
}

function salvagePickup(creep, room) {
    const settings = config.salvage || {};
    const abandon = () => { delete creep.memory.salvage; return false; };
    if (settings.enabled === false) return abandon();
    const targets = salvageTargets(room);
    if (!targets.length) return abandon();
    if (!salvageSink(room)) return abandon();
    const store = creep.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return abandon();
    let free = Number(store.getFreeCapacity()) || 0;
    if (free <= 0) return false;
    const claim = creep.memory.salvage;
    const stale = claim && Game.time - (Number(claim.at) || 0) > salvageNum(settings.timeout, 200);
    let pos = claim && claim.room === room.name && !stale ? claim : null;
    if (claim && !pos) delete creep.memory.salvage;
    const empty = !(Number(store.getUsedCapacity()) > 0);
    if (!pos) {
        if (!empty) return false;
        const pile = pickSalvage(creep, room, targets);
        if (!pile || isUrgent(room, contextFor(room))) return false;
        creep.memory.salvage = { x: pile.pos.x, y: pile.pos.y, room: room.name, at: Game.time };
        dropFill(creep, room);
        leaveBroker(creep);
        pos = creep.memory.salvage;
    } else if (empty && isUrgent(room, contextFor(room))) {
        return abandon();
    }
    const key = pos.x + ',' + pos.y;
    const pile = targets.find((item) => item.pos.x + ',' + item.pos.y === key);
    if (!pile) return abandon();
    if (distance(creep, pile) > 1) { movement.go(creep, pile.items[0], { range: 1, reusePath: 20 }); return true; }
    let took = 0;
    const container = pile.items.find((item) => item.store && nonEnergyIn(item.store) > 0);
    const type = container ? firstNonEnergyType(container.store) : null;
    if (type) {
        const amount = Math.min(free, Number(container.store[type]) || 0);
        if (amount > 0 && creep.withdraw(container, type, amount) === OK) { took += amount; free -= amount; }
    }
    if (free > 0) {
        const loose = pile.items.find((item) => item.amount != null && item.resourceType !== RESOURCE_ENERGY && Number(item.amount) > 0);
        if (loose && creep.pickup(loose) === OK) took += Math.min(free, Number(loose.amount) || 0);
    }
    if (took > 0) noteSalvage(room, took);
    return true;
}

function leaveBroker(creep) {
    const lease = creep.memory && creep.memory.brokerTask;
    if (!lease) return;
    if (lease.id) taskBroker.releaseClaim(lease.id, creep);
    delete creep.memory.brokerTask;
}

function noteSalvage(room, amount) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem.salvaged || (mem.salvaged = { n: 0, amount: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.amount = (Number(rec.amount) || 0) + amount;
    rec.at = Game.time;
}

function salvageCargo(creep, room) {
    const store = creep.store;
    if (!store || typeof store.getUsedCapacity !== 'function') return false;
    if (!(Number(store.getUsedCapacity()) > energyIn(store))) return false;
    const type = Object.keys(store).find((key) => key !== RESOURCE_ENERGY && Number(store[key]) > 0);
    if (!type) return false;
    const st = stashCfg(room);
    const sink = (st && type === st.resource && room.storage && room.storage.my && room.storage.store.getFreeCapacity(type) > 0)
        ? room.storage : salvageSink(room, type);
    if (!sink) { creep.drop(type); noteCounter(room, 'haulSalvage'); return false; }
    leaveBroker(creep);
    if (near(creep, sink)) { creep.transfer(sink, type); noteCounter(room, 'haulSalvage'); }
    else movement.go(creep, sink, { range: 1, reusePath: 20 });
    return true;
}

function stashCfg(room) {
    const all = hauling().stash;
    return all && room && all[room.name] ? all[room.name] : null;
}
function stashPull(creep, room, ctx, plan) {
    const st = stashCfg(room);
    if (!st || plan.withdraw || !room.terminal || !room.storage || !room.storage.my) return false;
    const res = st.resource;
    const over = Number(room.terminal.store[res] || 0) - Number(st.keep || 0);
    if (!(over > 0)) return false;
    if (Number(room.storage.store.getFreeCapacity(res)) <= Number(st.storageFree || 50000)) return false;
    if (isUrgent(room, ctx)) return false;
    const free = Number(creep.store.getFreeCapacity()) || 0;
    if (free <= 0) return false;
    if (!near(creep, room.terminal)) { plan.move = room.terminal; plan.moveRange = 1; return true; }
    const amount = Math.min(free, over);
    if (creep.withdraw(room.terminal, res, amount) === OK) {
        plan.withdraw = true;
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const rec = mem.stashed || (mem.stashed = { amount: 0 });
        rec.amount = (Number(rec.amount) || 0) + amount; rec.at = Game.time;
    }
    return true;
}

function unstashCfg(room) {
    const all = hauling().unstash;
    return all && room && all[room.name] ? all[room.name] : null;
}
function unstashPull(creep, room, ctx, plan) {
    const st = unstashCfg(room);
    if (!st || plan.withdraw || !room.terminal || !room.terminal.my || !room.storage) return false;
    const res = st.resource;
    const short = Number(st.target || 0) - Number(room.terminal.store[res] || 0);
    const have = Number(room.storage.store[res] || 0);
    if (!(short > 0) || !(have > 0)) return false;
    if (Number(room.terminal.store.getFreeCapacity(res)) <= Number(st.terminalFree || 20000)) return false;
    if (isUrgent(room, ctx)) return false;
    const free = Number(creep.store.getFreeCapacity()) || 0;
    if (free <= 0) return false;
    if (!near(creep, room.storage)) { plan.move = room.storage; plan.moveRange = 1; return true; }
    const amount = Math.min(free, short, have);
    if (creep.withdraw(room.storage, res, amount) === OK) {
        plan.withdraw = true;
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const rec = mem.unstashed || (mem.unstashed = { amount: 0 });
        rec.amount = (Number(rec.amount) || 0) + amount; rec.at = Game.time;
    }
    return true;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 20 }); return; }
    if (salvagePickup(creep, room)) return;
    if (salvageCargo(creep, room)) return;
    const energy = energyIn(creep.store);
    const free = freeIn(creep);
    const capacity = energy + free;
    if (!energy) { delete creep.memory.hubCargo; delete creep.memory.hubCargoAt; }
    const ctx = contextFor(room);
    const plan = newPlan();
    let fill = creep.memory.fill ? Game.getObjectById(creep.memory.fill) : null;
    if (creep.memory.fill && (!fill || (fill.pos && fill.pos.roomName !== room.name))) { delete creep.memory.fill; fill = null; }
    let collecting = energy <= 0;
    if (!collecting && fill && !isUrgent(room, ctx) && energy < capacity * (Number(hauling().leaveShare) || 0.9)) collecting = true;
    if (!collecting && creep.memory.fill) {
        noteFill(room, 'left', energy / Math.max(1, capacity));
        delete creep.memory.fill;
    }
    try {
        opportunistic(creep, room, plan, free, !collecting);
        if (collecting) {
            if (!collect(creep, room, ctx, plan, energy + plan.gained, capacity)) {
                if (energy + plan.gained > 0) deliver(creep, room, ctx, plan, energy, capacity);
                else if (!stashPull(creep, room, ctx, plan) && !unstashPull(creep, room, ctx, plan)) { haulStats.note(creep, 'park'); park(creep, room, plan); }
            }
        } else {
            deliver(creep, room, ctx, plan, energy, capacity);
        }
    } finally {
        if (creep.memory.fill && !plan.fillKept) dropFill(creep, room);
        if (plan.move) movement.go(creep, plan.move, { range: plan.moveRange, reusePath: 20 });
    }
}

function srcIsPlanned(room, s) {
    const plan = (Memory.rooms[room.name] || {}).plan;
    const containers = plan && plan.containers;
    if (containers) {
        for (const key of ['src0', 'src1']) {
            const c = containers[key];
            if (c && c.x === s.pos.x && c.y === s.pos.y) return true;
        }
        const ctrl = containers.ctrl;
        if (ctrl && ctrl.x === s.pos.x && ctrl.y === s.pos.y) return false;
    }
    const sources = findCached(room, FIND_SOURCES) || [];
    return sources.some((source) => Math.max(
        Math.abs(source.pos.x - s.pos.x),
        Math.abs(source.pos.y - s.pos.y),
    ) <= 1);
}

module.exports = { run, srcIsPlanned, unstashPull };
