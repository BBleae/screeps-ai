'use strict';

const movement = require('movement');
const config = require('config');
const utils = require('utils');
const layout = require('layout');
const links = require('links');
const { repairTargetHits } = require('utils');
const conquest = require('conquest');

const ROLE_WEIGHT = {
    harvester: 100,
    hauler: 80,
    upgrader: 70,
    builder: 55,
    remoteMiner: 75,
    skReaper: 85,
    remoteHauler: 65,
    courier: 60,
    feeder: 62,
    operator: 90,
    reserver: 45,
    scout: 20,
    lootHauler: 80,
    labTech: 80,
    defender: 95,
    siegeGuard: 95,
    claimer: 65,
    pioneer: 65,
    mineralMiner: 65,
    depositMiner: 65,
    siegeDismantler: 25,
    wallBreaker: 25,
    downgrader: 25,
    depositScout: 20,
};
const DEFAULT_WEIGHT = 20;
const NO_SKIP = ['harvester', 'hauler', 'lootHauler', 'defender', 'siegeGuard', 'labTech', 'warrior'];
const TASK_WEIGHT = {
    deliver: 8,
    harvest: 7,
    build: 5,
    repair: 4,
    upgrade: 3,
};
const TASK_VALUE = {
    deliver: 1,
    collect: 1,
    harvest: 1.1,
    build: 1.35,
    repair: 0.75,
    upgrade: 0.65,
};
const ACTION_RANGE = {
    deliver: 1,
    collect: 1,
    harvest: 1,
    build: 3,
    repair: 3,
    upgrade: 3,
};
const REPLAN_INTERVAL = 5;
const LEASE_TICKS = 5;
const STUCK_TICKS = 6;
const BLOCK_TICKS = 150;
const DELIVER_TIERS = [1, 2, 3, 4];
const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__taskBrokerRuntime || (runtimeGlobal.__taskBrokerRuntime = {
    tick: -1,
    plannedAt: -1,
    tasks: {},
    claimed: {},
    scores: {},
    metrics: {},
    cpuHeadroom: null,
    lastState: {},
});

function constant(name, fallback) {
    return typeof global[name] === 'undefined' ? fallback : global[name];
}

function activeParts(creep, type) {
    if (creep && typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(type);
    return (creep && creep.body || []).filter((part) => (part.type || part) === type && part.hits !== 0).length;
}

function positionOf(value) {
    return value && value.pos ? value.pos : value;
}

function distanceBetween(left, right) {
    const a = positionOf(left);
    const b = positionOf(right);
    if (!a || !b) return 50;
    if (a.roomName && b.roomName && a.roomName !== b.roomName) return 50;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function actionDistance(creep, task) {
    const raw = distanceBetween(creep, task && task.target);
    return Math.max(0, raw - (ACTION_RANGE[task && task.kind] || 1));
}

function energyOf(store) {
    return store && Number(store[constant('RESOURCE_ENERGY', 'energy')] || 0) || 0;
}

function freeEnergy(store) {
    if (!store) return 0;
    if (typeof store.getFreeCapacity === 'function') return Math.max(0, Number(store.getFreeCapacity(constant('RESOURCE_ENERGY', 'energy'))) || 0);
    return 0;
}

function addTask(tasks, task) {
    if (!task || !task.target || !task.id || task.backlog <= 0) return;
    task.weight = task.weight == null ? TASK_WEIGHT[task.kind] || 1 : task.weight;
    tasks.push(task);
}

function sourceContainerInflow(room, container, sources, miners) {
    if (!container || !container.pos) return 0;
    const source = (sources || []).find((item) => item && item.pos && distanceBetween(item, container) <= 1);
    if (!source) return 0;
    let work = 0;
    for (const miner of miners || []) {
        if (!miner.pos || distanceBetween(miner, container) > 1 || distanceBetween(miner, source) > 1) continue;
        work += activeParts(miner, constant('WORK', 'work'));
    }
    if (work <= 0) return 0;
    if (source.energy != null && !(Number(source.energy) > 0)) { noteRoomCounter(room, 'haulInflowDry'); return 0; }
    const linkType = constant('STRUCTURE_LINK', 'link');
    const structures = typeof room.find === 'function' ? room.find(constant('FIND_MY_STRUCTURES', 'myStructures')) || [] : [];
    const link = structures.find((s) => s.structureType === linkType && s.store && distanceBetween(s, source) <= 2);
    if (link && freeEnergy(link.store) >= 100) return 0;
    const rate = Number(source.energyCapacity || 3000) / (typeof ENERGY_REGEN_TIME === 'number' ? ENERGY_REGEN_TIME : 300);
    return Math.max(0, Math.min(rate, work * (typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2)));
}

function noteRoomCounter(room, key) {
    const name = room && room.name;
    if (!name || typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[name] || (Memory.rooms[name] = {});
    const rec = mem[key] || (mem[key] = { n: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.at = Game.time;
}

function spillSlots(creeps) {
    const haulers = (creeps || []).filter((creep) => creep.memory && creep.memory.role === 'hauler' && !creep.spawning).length;
    return haulers >= 3 ? 2 : 1;
}

function controllerFeedMode(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = (mem && mem.plan) || null;
    if (!plan) return null;
    const linkSpot = typeof layout.linkSpot === 'function' ? layout.linkSpot(plan, 'ctrl') : null;
    const link = linkSpot ? layout.structureAt(room, linkSpot.x, linkSpot.y, constant('STRUCTURE_LINK', 'link')) : null;
    if (link && link.my) return 'link';
    if (typeof layout.controllerFedByStorage === 'function' && layout.controllerFedByStorage(room, plan)) return 'storage';
    return null;
}

function controllerFeedContainer(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = (mem && mem.plan) || null;
    if (!plan || !plan.containers || !plan.containers.ctrl) return null;
    const spot = plan.containers.ctrl;
    const container = layout.structureAt(room, spot.x, spot.y, constant('STRUCTURE_CONTAINER', 'container'));
    if (!container || !container.store) return null;
    if (controllerFeedMode(room)) return null;
    return container;
}

function storageStationFeedsController(room, plan) {
    const storage = room && room.storage;
    if (!storage || storage.my === false || !storage.store || !plan) return false;
    if (typeof layout.controllerFedByStorage !== 'function' || !layout.controllerFedByStorage(room, plan)) return false;
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const band = Math.max(0, Number(config.controllerFeedStorageBand) || 0);
    return energyOf(storage.store) >= reserve + band;
}

function noteCtrlLinkSkip(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    if (!mem) return;
    const rec = mem.ctrlLinkFeedSkip || (mem.ctrlLinkFeedSkip = { n: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.at = Game.time;
}

function controllerFeedLink(room) {
    const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || {};
    const plan = mem.plan;
    if (!plan || links.storeLinkReady(room, plan)) return null;
    const target = links.getLink(room, plan, 'ctrl');
    if (!target || !target.store) return null;
    if (storageStationFeedsController(room, plan)) return null;
    const consumers = room.find(constant('FIND_MY_CREEPS', 'myCreeps')) || [];
    if (!consumers.some((creep) => !creep.spawning && creep.memory && creep.memory.role === 'upgrader')) return null;
    const energy = energyOf(target.store);
    const buffer = Math.max(0, Number(config.linkKeepAt) || 400);
    const backlog = Math.min(freeEnergy(target.store), buffer - energy);
    if (backlog <= 0) return null;
    const starved = energy < buffer * (Number(config.controllerFeedStarvedBelow) || 0.1) &&
        room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
        !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room);
    return { target, backlog, starved };
}

function controllerFeedStorage(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = (mem && mem.plan) || null;
    if (!plan || typeof layout.controllerFedByStorage !== 'function' || !layout.controllerFedByStorage(room, plan)) return null;
    const storage = room.storage;
    if (!storage || !storage.store) return null;
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const band = Math.max(0, Number(config.controllerFeedStorageBand) || 0);
    const floor = Math.max(Number(config.controllerFeedStorageFloor) || 2000, reserve + band);
    const energy = energyOf(storage.store);
    if (energy >= floor || freeEnergy(storage.store) <= 0) return null;
    const starved = energy < (Number(config.controllerFeedStorageStarved) || 500) &&
        room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
        !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room);
    if (mem && energy >= reserve) {
        const seen = mem.ctrlFeedBand && mem.ctrlFeedBand.n || 0;
        mem.ctrlFeedBand = { at: Game.time, energy, floor, n: seen + 1 };
    }
    return { target: storage, backlog: floor - energy, starved };
}

const needsRepairCache = { time: -1, rooms: {} };
function roomRepairTargets(room) {
    if (needsRepairCache.time !== Game.time) { needsRepairCache.time = Game.time; needsRepairCache.rooms = {}; }
    if (needsRepairCache.rooms[room.name]) return needsRepairCache.rooms[room.name];
    const found = utils.findCached(room, constant('FIND_STRUCTURES', 'structures')).filter((s) => utils.needsRepair(room, s));
    needsRepairCache.rooms[room.name] = found;
    return found;
}
function roomNeedsRepair(room) {
    return roomRepairTargets(room).length > 0;
}

const criticalCache = { time: -1, rooms: {} };
function roomCriticalStructures(room) {
    if (criticalCache.time !== Game.time) { criticalCache.time = Game.time; criticalCache.rooms = {}; }
    if (criticalCache.rooms[room.name]) return criticalCache.rooms[room.name];
    const found = utils.findCached(room, constant('FIND_STRUCTURES', 'structures')).filter((s) => utils.criticallyDamaged(room, s));
    criticalCache.rooms[room.name] = found;
    return found;
}
function criticalWithin(room, pos, range) {
    return roomCriticalStructures(room).some((s) => s.pos &&
        Math.max(Math.abs(s.pos.x - pos.x), Math.abs(s.pos.y - pos.y)) <= range);
}

function feeReserveOf(roomName) {
    const map = (config.terminalNetwork || {}).terminalFeeReserve;
    return Math.max(0, Number(map && map[roomName]) || 0);
}

function pendingBuy(room, terminal) {
    const b = (config.market || {}).buy;
    if (!b || !Array.isArray(b.rooms) || b.rooms.indexOf(room.name) < 0 || !Array.isArray(b.resources)) return false;
    const target = Number(b.target || 3000);
    return b.resources.some((res) => Number(terminal.store[res] || 0) + Number((room.storage && room.storage.store && room.storage.store[res]) || 0) < target);
}
function feeReserveFillAllowed(room, terminal) {
    const min = Math.max(0, Number((config.terminal || {}).energyFloorMinStorage) || 0);
    const st = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (st && energyOf(st.store) >= min) return true;
    return pendingBuy(room, terminal);
}

function terminalFillWant(room, terminal, storageRich) {
    const fee = feeReserveOf(room.name);
    if (fee > 0 && terminal && terminal.my !== false && terminal.store && feeReserveFillAllowed(room, terminal)) {
        const st = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
        const floor = Math.max(0, Number((config.terminalNetwork || {}).feeReserveStorageFloor) || 0);
        const short = fee - energyOf(terminal.store);
        if (st && short > 0) {
            const give = Math.min(short, energyOf(st.store) - floor);
            if (give > 0) return Math.max(give, terminalFillWantBase(room, terminal, storageRich));
        }
    }
    return Math.max(terminalFillWantBase(room, terminal, storageRich), senderFillWant(room, terminal, storageRich), terminalFloorWant(room, terminal), terminalRoomTargetWant(room, terminal));
}

function terminalRoomTarget(room, terminal) {
    const rule = ((config.terminal || {}).energyTargetByRoom || {})[room.name];
    const st = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!rule || !st || !terminal || terminal.my === false || !terminal.store) return 0;
    if (energyOf(st.store) + energyOf(terminal.store) < (Number(rule.minRoomEnergy) || 0)) return 0;
    return feeReserveOf(room.name) + Math.max(0, Number(rule.extra) || 0);
}

function terminalRoomTargetWant(room, terminal) {
    const target = terminalRoomTarget(room, terminal);
    if (!(target > 0)) return 0;
    return Math.max(0, Math.min(target - energyOf(terminal.store), energyOf(room.storage.store)));
}

function terminalFloorParams(room) {
    const c = config.terminal || {};
    const floor = Math.max(0, Number(c.energyFloor) || 0);
    const min = Math.max(0, Number(c.energyFloorMinStorage) || 0);
    const st = room && room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!(floor > 0) || !st || energyOf(st.store) < min) return null;
    return { floor, min, storage: energyOf(st.store) };
}
function terminalFillMargin(key) {
    const value = Number((config.terminal || {})[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
}
function terminalFloorWant(room, terminal) {
    const p = terminalFloorParams(room);
    if (!p || !terminal || terminal.my === false || !terminal.store) return 0;
    if (p.storage < p.min + terminalFillMargin('fillMargin')) return 0;
    return Math.max(0, Math.min(p.floor - energyOf(terminal.store), p.storage - p.min));
}

function senderFillWant(room, terminal, storageRich) {
    const net = config.terminalNetwork || {};
    const extra = Number(net.senderTerminalExtra) || 0;
    if (!storageRich || !(extra > 0) || !terminal || terminal.my === false || !terminal.store) return 0;
    const st = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!st) return 0;
    const se = energyOf(st.store), te = energyOf(terminal.store);
    if (se + te < (Number(net.starveSendAbove) || Number(net.sendAbove) || 0)) return 0;
    const storageFloor = Number(net.senderStorageFloor) || 30000;
    if (se < storageFloor + terminalFillMargin('senderFillMargin')) return 0;
    const reserve = Math.max(Number(net.feeReserve) || 0, feeReserveOf(room.name));
    return Math.max(0, Math.min(reserve + extra - te, se - storageFloor));
}

function terminalFillWantBase(room, terminal, storageRich) {
    const cfg = config.industry || {};
    const own = cfg.terminalFillByRoom && room && cfg.terminalFillByRoom[room.name];
    const target = Math.max(0, Number(own && own.target != null ? own.target : cfg.terminalTarget) || 0);
    if ((!storageRich && !own) || !(target > 0) || !terminal || terminal.my === false || !terminal.store) return 0;
    const storage = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!storage) return 0;
    const surplus = energyOf(storage.store) - Math.max(0, Number(own && own.storageAbove != null ? own.storageAbove : cfg.terminalFillStorageAbove) || 0);
    return Math.max(0, Math.min(target - energyOf(terminal.store), surplus));
}

function terminalEnergyWant(room, terminal) {
    if (!room || !terminal || terminal.my === false || !terminal.store) return 0;
    const roomMemory = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const storageRich = utils.storageRichState(room, roomMemory, config.upgrading || {});
    return Math.max(0, Math.floor(terminalFillWant(room, terminal, storageRich)));
}

function terminalDrainKeep(room, storageRich) {
    const fee = feeReserveOf(room.name);
    const base = terminalDrainKeepBase(room, storageRich);
    const keep = base != null ? Math.max(base, terminalRoomTarget(room, room.terminal)) : base;
    const fp = terminalFloorParams(room);
    if (fp && keep != null && keep < fp.floor) return Math.max(fp.floor, fee > 0 ? fee : 0);
    if (fee > 0 && keep != null) return Math.max(keep, fee);
    return keep;
}

function terminalDrainKeepBase(room, storageRich) {
    if (!storageRich) return 0;
    const below = Math.max(0, Number((config.industry || {}).terminalDrainStorageBelow) || 0);
    const storage = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!storage || !(below > 0) || energyOf(storage.store) >= below) return null;
    return Math.max(0, Number((config.terminalNetwork || {}).feeReserve) || 0);
}

function upgraderBoostRoom(room) {
    const cfg = config.industry || {};
    return !!(cfg.boostUpgraders && room && utils.upgraderBoostRooms().indexOf(room.name) >= 0);
}

function labEnergyWant(room, lab, storageRich, roomMemory) {
    const cfg = config.industry || {};
    const target = Math.max(0, Number(cfg.labEnergyTarget) || 0);
    if (!(target > 0) || !lab || lab.my === false || !lab.store) return 0;
    const storage = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!storage) return 0;
    const military = roomMemory && roomMemory.militaryLabs && typeof roomMemory.militaryLabs === 'object' && Object.values(roomMemory.militaryLabs).indexOf(lab.id) >= 0;
    if (military) {
        const min = Math.max(0, Number((config.terminal || {}).energyFloorMinStorage) || 0);
        if (energyOf(storage.store) < min) return 0;
        return Math.max(0, Math.min(target - energyOf(lab.store), energyOf(storage.store) - min));
    }
    const labsState = roomMemory && roomMemory.industryState && roomMemory.industryState.labs;
    const outBoost = !!labsState && (Array.isArray(labsState.boostOut) ? labsState.boostOut.indexOf(lab.id) >= 0 : labsState.boostOut === lab.id);
    if (!labsState || (labsState.boostLab !== lab.id && !outBoost)) return 0;
    const siege = outBoost || (Array.isArray(cfg.boostOnlyRooms) && cfg.boostOnlyRooms.indexOf(room.name) >= 0 && conquest.siegeCompounds().length > 0);
    if (!storageRich && !siege) return 0;
    const floor = siege ? Math.max(0, Number(cfg.siegeLabEnergyFloor != null ? cfg.siegeLabEnergyFloor : 10000)) : upgraderBoostRoom(room) ? Math.max(0, Number(cfg.boostLabEnergyFloor) || 0) : Math.max(0, Number(cfg.terminalFillStorageAbove) || 0);
    const surplus = energyOf(storage.store) - floor;
    return Math.max(0, Math.min(target - energyOf(lab.store), surplus));
}

function roomTasks(room) {
    const tasks = [];
    const ownedStructuresKind = constant('FIND_MY_STRUCTURES', constant('FIND_STRUCTURES', 'structures'));
    const allStructuresKind = constant('FIND_STRUCTURES', 'structures');
    const sitesKind = constant('FIND_MY_CONSTRUCTION_SITES', constant('FIND_CONSTRUCTION_SITES', 'constructionSites'));
    const sourcesKind = constant('FIND_SOURCES', 'sources');
    const spawnType = constant('STRUCTURE_SPAWN', 'spawn');
    const extensionType = constant('STRUCTURE_EXTENSION', 'extension');
    const towerType = constant('STRUCTURE_TOWER', 'tower');
    const containerType = constant('STRUCTURE_CONTAINER', 'container');
    const storageType = constant('STRUCTURE_STORAGE', 'storage');
    const terminalType = constant('STRUCTURE_TERMINAL', 'terminal');
    const labType = constant('STRUCTURE_LAB', 'lab');
    const tombstonesKind = constant('FIND_TOMBSTONES', 'tombstones');
    const dropsKind = constant('FIND_DROPPED_RESOURCES', 'droppedResources');
    const hostilesKind = constant('FIND_HOSTILE_CREEPS', 'hostileCreeps');
    const ownedStructures = typeof room.find === 'function' ? room.find(ownedStructuresKind) || [] : [];
    const structures = typeof room.find === 'function' ? room.find(allStructuresKind) || [] : [];
    const hostile = typeof room.find === 'function' && (room.find(hostilesKind) || []).length > 0;
    const towerRefillAt = Number(config.towerRefillAt) || 300;
    const ctrlFeed = controllerFeedContainer(room);
    const fillBelow = Number(config.upgraderFillBelow) || 0.8;
    const roomMemory = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const storageRich = utils.storageRichState(room, roomMemory, config.upgrading || {});
    let boostingCache = null;
    const boostingOn = () => (boostingCache == null ? (boostingCache = !!conquest.boostingEnabled()) : boostingCache);
    const ctrlCapacity = ctrlFeed && typeof ctrlFeed.store.getCapacity === 'function' ? ctrlFeed.store.getCapacity(constant('RESOURCE_ENERGY', 'energy')) : 2000;
    const feedPlan = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].plan) || null;
    let ctrlLink = storageRich && feedPlan && controllerFeedMode(room) === 'link' ? links.getLink(room, feedPlan, 'ctrl') : null;
    if (ctrlLink && storageStationFeedsController(room, feedPlan)) {
        if (ctrlLink.store && freeEnergy(ctrlLink.store) >= 200) noteCtrlLinkSkip(room);
        ctrlLink = null;
    }
    const richLink = !!(ctrlLink && ctrlLink.store && freeEnergy(ctrlLink.store) >= 200);
    const hubFed = typeof links.hubHaulMode === 'function' && links.hubHaulMode(room, feedPlan);
    const richFeed = storageRich && ((!!ctrlFeed && freeEnergy(ctrlFeed.store) > 0 && energyOf(ctrlFeed.store) < ctrlCapacity * fillBelow) || richLink);
    if (richLink) {
        addTask(tasks, { kind: 'deliver', id: ctrlLink.id + ':ctrlFeed', target: ctrlLink, backlog: freeEnergy(ctrlLink.store), weight: 9, tier: 1, roles: ['hauler', 'remoteHauler'] });
    } else {
        const linkFeed = controllerFeedLink(room);
        if (linkFeed) addTask(tasks, { kind: 'deliver', id: linkFeed.target.id + ':ctrlFeed', target: linkFeed.target,
            backlog: linkFeed.backlog, level: Math.max(0, Number(config.linkKeepAt) || 400), weight: linkFeed.starved ? 20 : 4, tier: linkFeed.starved ? 1 : 3,
            roles: ['hauler', 'remoteHauler'] });
    }
    const spawnNeeds = ownedStructures.some((structure) => (structure.structureType === spawnType || structure.structureType === extensionType) &&
        structure.store && freeEnergy(structure.store) > 0);
    for (const structure of ownedStructures) {
        const free = freeEnergy(structure.store);
        const towerUrgentNow = structure.structureType === towerType ? utils.towerUrgent(room, structure, hostile) : false;
        if (free <= 0) continue;
        if (structure.structureType === spawnType || structure.structureType === extensionType) {
            addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: free, weight: 10, tier: 1 });
        } else if (structure.structureType === towerType) {
            const urgent = towerUrgentNow;
            const alertRoom = (config.towerFullRooms || []).indexOf(room.name) >= 0;
            if (alertRoom && free >= 50 && !hostile && !urgent) {
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: free, weight: 11, tier: 1 });
            } else if (free >= towerRefillAt || hostile) {
                const needsBudget = energyOf(structure.store) < (Number(config.towerRepairReserve) || 500) + (Number(config.towerMaintenanceBudget) || 0);
                const towerRange = Number(config.towerCriticalRange) || (typeof TOWER_FALLOFF_RANGE !== 'undefined' ? TOWER_FALLOFF_RANGE : 20);
                const criticalNear = !urgent && needsBudget && structure.pos && criticalWithin(room, structure.pos, towerRange);
                const maintenance = !urgent && !criticalNear && needsBudget && roomNeedsRepair(room);
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: free,
                    weight: urgent || criticalNear ? 11 : maintenance ? (Number(config.towerMaintenanceWeight) || 5) : 2,
                    tier: urgent || criticalNear ? 1 : maintenance ? 3 : 4 });
                if (urgent && spawnNeeds && roomMemory && !roomMemory.towerFirstAt) roomMemory.towerFirstAt = Game.time;
                if (criticalNear && roomMemory) {
                    roomMemory.towerCritical = { at: Game.time, energy: energyOf(structure.store), x: structure.pos.x, y: structure.pos.y };
                }
            }
        } else if (structure.structureType === storageType) {
            const storageCap = Math.max(1, Number(config.storageDeliverBacklogCap) || 10000);
            addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: Math.min(free, storageCap), cap: storageCap, weight: 1, tier: 4, roles: ['hauler'] });
        } else if (structure.structureType === terminalType) {
            const fill = terminalFillWant(room, structure, storageRich);
            if (fill > 0) {
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: Math.min(free, fill), weight: 0.5, tier: 4, roles: ['hauler'] });
                if (roomMemory) roomMemory.terminalFill = { at: Game.time, want: fill, terminal: energyOf(structure.store) };
            }
        } else if (structure.structureType === labType) {
            const want = labEnergyWant(room, structure, storageRich, roomMemory);
            if (want > 0 && (boostingOn() || upgraderBoostRoom(room))) {
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: Math.min(free, want), weight: 0.4, tier: 4, roles: ['hauler'] });
                if (roomMemory) roomMemory.labEnergy = { at: Game.time, want, lab: structure.id, energy: energyOf(structure.store) };
            } else if (want > 0 && roomMemory) {
                roomMemory.labEnergyHeld = { at: Game.time, want, lab: structure.id, energy: energyOf(structure.store) };
            }
        }
    }
    if (ctrlFeed) {
        const capacity = ctrlCapacity;
        const free = freeEnergy(ctrlFeed.store);
        if (free > 0 && energyOf(ctrlFeed.store) < capacity * fillBelow) {
            const starved = energyOf(ctrlFeed.store) < capacity * (Number(config.controllerFeedStarvedBelow) || 0.1) &&
                room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
                !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room);
            addTask(tasks, { kind: 'deliver', id: ctrlFeed.id, target: ctrlFeed, backlog: free, until: capacity * fillBelow,
                weight: starved ? 20 : richFeed ? 9 : 4, tier: starved || richFeed ? 1 : 3, roles: ['hauler', 'remoteHauler'] });
        }
    }
    const storageFeed = controllerFeedStorage(room);
    if (storageFeed) {
        addTask(tasks, { kind: 'deliver', id: storageFeed.target.id + ':ctrlFeed', target: storageFeed.target, backlog: storageFeed.backlog,
            level: energyOf(storageFeed.target.store) + storageFeed.backlog,
            weight: storageFeed.starved ? 20 : 4, tier: storageFeed.starved ? 1 : 3, roles: ['hauler', 'remoteHauler'] });
    }
    const feedBelow = Number(config.builderFeedBelow) || 0.5;
    const feedWait = Number(config.builderFeedWait) || 30;
    const creepsKind = constant('FIND_MY_CREEPS', 'myCreeps');
    const builders = typeof room.find === 'function' ? room.find(creepsKind) || [] : [];
    for (const builder of builders) {
        const memory = builder.memory || {};
        if (memory.role !== 'builder' || !(Game.time - Number(memory.feedAt || -1e9) <= feedWait)) continue;
        const capacity = typeof builder.store.getCapacity === 'function' ? builder.store.getCapacity(constant('RESOURCE_ENERGY', 'energy')) : 0;
        const free = freeEnergy(builder.store);
        if (!capacity || free < 50) continue;
        const low = energyOf(builder.store) < capacity * feedBelow;
        addTask(tasks, { kind: 'deliver', id: builder.id, target: builder, backlog: free, weight: low ? 6 : 2, tier: low ? 2 : 4, roles: ['hauler'] });
    }
    const sourceList = typeof room.find === 'function' ? room.find(constant('FIND_SOURCES', 'sources')) || [] : [];
    const creepsHere = typeof room.find === 'function' ? room.find(constant('FIND_MY_CREEPS', 'myCreeps')) || [] : [];
    const miners = creepsHere.filter((creep) => creep.memory && (creep.memory.role === 'harvester' || creep.memory.role === 'remoteMiner'));
    const drops = typeof room.find === 'function' ? room.find(dropsKind) || [] : [];
    const hauling = config.hauling || {};
    const spillShare = Number(hauling.spillShare) || 0.9;
    const spillDrop = Number(hauling.spillDrop) || 500;
    const spillWeight = Number(hauling.spillWeight) || 10;
    const spillExitShare = Number(hauling.spillExitShare) || 0.6;
    const spillExitDrop = Number(hauling.spillExitDrop) || 200;
    const nearSource = (object) => sourceList.some((source) => source.pos && distanceBetween(source, object) <= 2);
    const energyType = constant('RESOURCE_ENERGY', 'energy');
    const spillState = roomMemory ? (roomMemory.spill || (roomMemory.spill = {})) : {};
    const spillBySource = {};
    const planContainers = (feedPlan && feedPlan.containers) || {};
    const atSpot = (s, spot) => !!spot && s.pos && s.pos.x === spot.x && s.pos.y === spot.y;
    const sourceContainerOf = (source) => {
        const near = structures.filter((s) => s.structureType === containerType && s.store && distanceBetween(s, source) <= 1);
        return near.find((s) => atSpot(s, planContainers.src0) || atSpot(s, planContainers.src1)) ||
            near.find((s) => !atSpot(s, planContainers.ctrl)) || null;
    };
    for (const source of sourceList) {
        if (!source || !source.id || !source.pos) continue;
        const container = sourceContainerOf(source);
        const capacity = container && typeof container.store.getCapacity === 'function' ? Number(container.store.getCapacity(energyType)) || 2000 : 2000;
        const stored = container ? energyOf(container.store) : 0;
        const pile = drops.reduce((sum, drop) => sum + (drop.resourceType === energyType && distanceBetween(drop, source) <= 2 ? Number(drop.amount) || 0 : 0), 0);
        const was = !!spillState[source.id];
        const now = was ? (stored >= capacity * spillExitShare || pile >= spillExitDrop) : (stored >= capacity * spillShare || pile >= spillDrop);
        if (now !== was) {
            if (now) spillState[source.id] = Game.time; else delete spillState[source.id];
            if (roomMemory) roomMemory.spillFlips = (Number(roomMemory.spillFlips) || 0) + 1;
        }
        spillBySource[source.id] = now;
    }
    for (const id of Object.keys(spillState)) if (!(id in spillBySource)) delete spillState[id];
    const spillingSourceOf = (object) => sourceList.find((source) => source.pos && spillBySource[source.id] && distanceBetween(source, object) <= 2);
    const spilling = Object.values(spillBySource).some(Boolean);
    const waits = [];
    runtime.waitSpots = runtime.waitSpots || {};
    runtime.waitSpots[room.name] = waits;
    for (const structure of structures) {
        if (structure.structureType !== containerType && structure.structureType !== storageType) continue;
        if (structure.structureType === storageType && structure.my === false) continue;
        if (structure.structureType === containerType && typeof links.skipSourceContainer === 'function' &&
            links.skipSourceContainer(room, feedPlan, structure)) continue;
        if (structure.structureType === containerType && nearSource(structure)) {
            const inflowHere = sourceContainerInflow(room, structure, sourceList, miners);
            if (inflowHere > 0) waits.push({ kind: 'collect', id: structure.id + ':collect', target: structure, backlog: energyOf(structure.store), inflow: inflowHere,
                inflowCap: sourceEnergyNear(structure, sourceList), wait: true });
        }
        const available = energyOf(structure.store);
        const isStorage = structure.structureType === storageType;
        const storageWeight = isStorage && (richFeed || hubFed) ? ((richLink && !spilling) || hubFed ? 8 : 6) : 2;
        let weight = structure.structureType === containerType ? 7 : storageWeight;
        let inflow = 0;
        let slots;
        let inflowCap;
        if (structure.structureType === containerType) {
            inflow = sourceContainerInflow(room, structure, sourceList, miners);
            if (inflow > 0) inflowCap = sourceEnergyNear(structure, sourceList);
            if (spillingSourceOf(structure)) { weight = spillWeight; slots = spillSlots(creepsHere); }
        }
        addTask(tasks, { kind: 'collect', id: structure.id + ':collect', target: structure, backlog: available,
            weight, inflow, inflowCap, slots, rich: isStorage && (richFeed || hubFed), hub: isStorage && hubFed });
    }
    const ownTerminal = room.terminal && room.terminal.my !== false && room.terminal.store ? room.terminal : null;
    const drainKeep = ownTerminal ? terminalDrainKeep(room, storageRich) : null;
    if (ownTerminal && drainKeep != null && energyOf(ownTerminal.store) > drainKeep) {
        addTask(tasks, { kind: 'collect', id: ownTerminal.id + ':collect', target: ownTerminal, backlog: energyOf(ownTerminal.store) - drainKeep,
            weight: 6, roles: ['hauler'], terminalDrain: true, drainKeep });
        if (drainKeep > 0 && roomMemory) roomMemory.terminalDrainLow = { at: Game.time, storage: energyOf(room.storage.store), terminal: energyOf(ownTerminal.store), keep: drainKeep };
    }
    for (const drop of drops) {
        if (drop.resourceType != null && drop.resourceType !== energyType) continue;
        if (typeof links.skipLinkedDrop === 'function' && links.skipLinkedDrop(room, feedPlan, drop)) continue;
        const amount = Number(drop.amount || 0);
        const spill = drop.resourceType === energyType && amount >= spillExitDrop && !!spillingSourceOf(drop);
        addTask(tasks, { kind: 'collect', id: drop.id, target: drop, backlog: amount, weight: spill ? spillWeight - 1 : 6,
            slots: spill ? spillSlots(creepsHere) : undefined });
    }
    const tombstones = typeof room.find === 'function' ? room.find(tombstonesKind) || [] : [];
    for (const tombstone of tombstones) {
        addTask(tasks, { kind: 'collect', id: tombstone.id + ':collect', target: tombstone, backlog: energyOf(tombstone.store), weight: 5, tombstone: true });
    }
    const ruinsKind = constant('FIND_RUINS', 'ruins');
    const ruins = typeof room.find === 'function' ? room.find(ruinsKind) || [] : [];
    for (const ruin of ruins) {
        if (energyOf(ruin.store) <= 0) continue;
        addTask(tasks, { kind: 'collect', id: ruin.id + ':collect', target: ruin, backlog: energyOf(ruin.store), weight: 5, tombstone: true });
    }
    const sites = typeof room.find === 'function' ? room.find(sitesKind) || [] : [];
    for (const site of sites) {
        if (typeof utils.siteWanted === 'function' && !utils.siteWanted(room, site)) continue;
        addTask(tasks, {
            kind: 'build', id: site.id, target: site,
            backlog: Math.max(0, (site.progressTotal || 0) - (site.progress || 0)),
            weight: site.structureType === spawnType ? 10 : site.structureType === towerType ? 9
                : site.structureType === constant('STRUCTURE_LINK', 'link') ? 8.7
                : (site.structureType === constant('STRUCTURE_STORAGE', 'storage') && !room.storage && (config.construction || {}).storageBeforeRoads !== false) ? 8.5
                : site.structureType === constant('STRUCTURE_ROAD', 'road') ? 8 : site.structureType === containerType ? 7 : 5,
        });
    }
    for (const structure of roomRepairTargets(room)) {
        addTask(tasks, {
            kind: 'repair', id: structure.id, target: structure,
            backlog: Math.max(0, repairTargetHits(room, structure) - structure.hits),
            weight: structure.structureType === towerType || structure.structureType === spawnType ? 7 : 3,
        });
    }
    const sources = typeof room.find === 'function' ? room.find(sourcesKind) || [] : [];
    for (const source of sources) {
        addTask(tasks, {
            kind: 'harvest', id: source.id, target: source,
            backlog: Math.max(0, Number(source.energy || 0)),
            weight: 7,
        });
    }
    const controller = room.controller;
    if (controller && controller.my) {
        const downgradeUrgency = controller.ticksToDowngrade == null ? 0 :
            Math.max(0, 10000 - controller.ticksToDowngrade);
        addTask(tasks, {
            kind: 'upgrade', id: controller.id || room.name + ':controller', target: controller,
            backlog: Math.max(1, downgradeUrgency),
            weight: downgradeUrgency > 5000 ? 8 : 3,
        });
    }
    return tasks;
}

const TASK_ROLES = { harvester: true, hauler: true, upgrader: true, builder: true, remoteHauler: true };

function taskParts(creep) {
    return {
        role: creep.memory && creep.memory.role,
        work: activeParts(creep, constant('WORK', 'work')) > 0,
        carry: activeParts(creep, constant('CARRY', 'carry')) > 0,
    };
}

function compatibleParts(parts, task) {
    const { role, work, carry } = parts;
    if (Array.isArray(task.roles) && !task.roles.includes(role)) return false;
    if (task.kind === 'harvest') return work && ['harvester', 'builder', 'upgrader'].includes(role);
    if (task.kind === 'deliver') return carry && ['hauler', 'harvester', 'builder', 'upgrader', 'remoteHauler'].includes(role);
    if (task.kind === 'collect') return carry && ['hauler', 'remoteHauler'].includes(role);
    if (task.kind === 'upgrade') return work && carry && ['upgrader', 'builder'].includes(role);
    if (task.kind === 'build' || task.kind === 'repair') return work && carry && ['builder', 'upgrader', 'remoteHauler'].includes(role);
    return false;
}

function taskCompatible(creep, task) {
    return compatibleParts(taskParts(creep), task);
}

function cpuHeadroom() {
    if (runtime.cpuHeadroom != null) return runtime.cpuHeadroom;
    const cpu = typeof Game !== 'undefined' && Game.cpu;
    if (!cpu || typeof cpu.getUsed !== 'function') {
        runtime.cpuHeadroom = 1;
        return runtime.cpuHeadroom;
    }
    const limit = Number(cpu.tickLimit || cpu.limit) || 0;
    if (!limit) {
        runtime.cpuHeadroom = 1;
        return runtime.cpuHeadroom;
    }
    runtime.cpuHeadroom = Math.max(0.25, Math.min(1, 1 - Number(cpu.getUsed() || 0) / limit));
    return runtime.cpuHeadroom;
}

function ttlUrgency(creep, travel) {
    if (creep.ticksToLive == null || creep.spawning) return 1;
    const remaining = Math.max(0, creep.ticksToLive - Math.max(0, Number(travel) || 0) - 3);
    const viability = Math.max(0.25, Math.min(1, remaining / 150));
    const urgency = 1 + Math.min(1, Math.max(0, 300 - creep.ticksToLive) / 300) * 0.4;
    return viability * urgency;
}

const AMOUNT_KINDS = { deliver: true, collect: true };
const MAX_CLAIMANTS = 6;

function setProjected(creep, energy) {
    if (!creep || !creep.name) return;
    runtime.projected = runtime.projected || {};
    runtime.projected[creep.name] = { t: Game.time, e: Math.max(0, Number(energy) || 0) };
}

function projectedEnergy(creep) {
    const entry = runtime.projected && runtime.projected[creep.name];
    if (entry && entry.t === Game.time) return entry.e;
    return energyOf(creep.store);
}

function creepCapacity(creep) {
    const store = creep && creep.store;
    if (store && typeof store.getCapacity === 'function') {
        const capacity = Number(store.getCapacity(constant('RESOURCE_ENERGY', 'energy')));
        if (Number.isFinite(capacity) && capacity > 0) return capacity;
    }
    return activeParts(creep, constant('CARRY', 'carry')) * 50;
}

function projectedFree(creep) {
    const entry = runtime.projected && runtime.projected[creep.name];
    const store = creep && creep.store;
    if (!entry || entry.t !== Game.time) return freeEnergy(store);
    const used = store && typeof store.getUsedCapacity === 'function' ? Number(store.getUsedCapacity()) || 0 : energyOf(store);
    const other = Math.max(0, used - energyOf(store));
    return Math.max(0, creepCapacity(creep) - other - entry.e);
}

function arrivalAmount(task, creep) {
    const backlog = Math.max(0, Number(task.backlog) || 0);
    if (task.kind !== 'collect' || !(task.inflow > 0) || !creep || !creep.pos) return backlog;
    const gained = task.inflow * actionDistance(creep.pos, task);
    return backlog + (task.inflowCap != null ? Math.min(gained, Math.max(0, Number(task.inflowCap) || 0)) : gained);
}

function sourceEnergyNear(container, sources) {
    const source = (sources || []).find((item) => item && item.pos && distanceBetween(item, container) <= 1);
    return source && source.energy != null ? Math.max(0, Number(source.energy) || 0) : undefined;
}

function claimAmount(task, creep) {
    if (task.kind === 'deliver') return Math.min(projectedEnergy(creep), Math.max(0, Number(task.backlog) || 0));
    const filling = task.wait || (creep.memory && task.target && creep.memory.fill === task.target.id);
    if (filling) return projectedFree(creep);
    return Math.min(projectedFree(creep), arrivalAmount(task, creep));
}

function reservedByOthers(task, creep) {
    const owners = claimants(task.id);
    const mine = creep ? owners.indexOf(creep.name) : -1;
    const myEta = mine >= 0 && creep.pos ? actionDistance(creep.pos, task) : 0;
    const home = task.target && task.target.pos && task.target.pos.roomName;
    const askerLocal = !creep || !creep.pos || !home || creep.pos.roomName === home;
    let sum = 0;
    for (let index = 0; index < owners.length; index++) {
        const name = owners[index];
        if (creep && name === creep.name) continue;
        const other = typeof Game !== 'undefined' && Game.creeps ? Game.creeps[name] : null;
        if (!other) continue;
        if (askerLocal && home && other.pos && other.pos.roomName && other.pos.roomName !== home) {
            noteRoomCounter(typeof Game !== 'undefined' && Game.rooms ? Game.rooms[home] : null, 'brokerFarClaims');
            continue;
        }
        if (mine >= 0 && other.pos) {
            const eta = actionDistance(other.pos, task);
            if (eta > myEta || (eta === myEta && index > mine)) continue;
        }
        sum += claimAmount(task, other);
    }
    return sum;
}

function availableFor(task, creep) {
    if (!task) return 0;
    if (!AMOUNT_KINDS[task.kind]) return Math.max(0, Number(task.backlog) || 0);
    return arrivalAmount(task, creep) - reservedByOthers(task, creep);
}

function taskYield(creep, task) {
    if (!creep || !task) return 0;
    const work = activeParts(creep, constant('WORK', 'work'));
    const carry = activeParts(creep, constant('CARRY', 'carry'));
    const backlog = Math.max(0, Number(task.backlog) || 0);
    if (task.kind === 'harvest') return Math.min(backlog, Math.min(10, work * 2));
    if (task.kind === 'collect' || task.kind === 'deliver') return Math.max(0, Math.min(availableFor(task, creep), carry * 50));
    if (task.kind === 'build') return Math.min(backlog, work * 5, carry * 5);
    if (task.kind === 'repair') return Math.min(backlog, work * 100, carry * 100);
    if (task.kind === 'upgrade') return Math.min(backlog, work, carry * 50, 15);
    return 0;
}

function estimatedCpu(creep, task, travel) {
    const bodyLength = Math.max(1, (creep && creep.body && creep.body.length) || 1);
    const pathCost = Math.max(0, Number(travel) || 0) > 3 ? 1.5 : 0.5;
    const actionCost = ['build', 'repair', 'upgrade'].includes(task && task.kind) ? 0.35 : 0.2;
    return 0.5 + pathCost + actionCost + Math.min(1, bodyLength / 50);
}

function scoreTask(creep, task) {
    if (!taskCompatible(creep, task)) return -Infinity;
    return scoreCompatible(creep, task);
}

function scoreCompatible(creep, task) {
    const yieldRate = taskYield(creep, task);
    if (yieldRate <= 0) return -Infinity;
    const roleWeight = ROLE_WEIGHT[creep.memory && creep.memory.role] || 10;
    const travel = actionDistance(creep.pos, task);
    const remaining = AMOUNT_KINDS[task.kind] ? availableFor(task, creep) : task.backlog;
    const backlog = Math.log1p(Math.max(0, remaining) / Math.max(1, yieldRate * (travel + 2))) + 1;
    const value = TASK_VALUE[task.kind] || 1;
    const cpuFactor = cpuHeadroom() / estimatedCpu(creep, task, travel);
    return roleWeight * task.weight * value * yieldRate * backlog * ttlUrgency(creep, travel) * cpuFactor /
        (travel + 1);
}

function taskSlots(task) {
    if (!task) return 1;
    if (Number(task.slots) > 0) return Math.max(1, Math.floor(task.slots));
    const backlog = Math.max(1, Number(task.backlog) || 1);
    const quantum = {
        harvest: 300,
        collect: 200,
        deliver: 200,
        build: 1000,
        repair: 1000,
        upgrade: 15,
    }[task.kind] || 200;
    const maximum = {
        harvest: 8,
        collect: 4,
        deliver: 4,
        build: 4,
        repair: 3,
        upgrade: 2,
    }[task.kind] || 1;
    return Math.max(1, Math.min(maximum, Math.ceil(backlog / quantum)));
}

function claimants(taskId) {
    const value = runtime.claimed[taskId];
    if (Array.isArray(value)) return value;
    if (value) return [value];
    return [];
}

function hasClaimCapacity(task, creep) {
    const owners = claimants(task.id);
    if (owners.includes(creep.name)) return true;
    if (AMOUNT_KINDS[task.kind] && !(Number(task.slots) > 0)) return owners.length < MAX_CLAIMANTS && availableFor(task, creep) > 0;
    return owners.length < taskSlots(task);
}

function claimTask(task, creep) {
    const owners = claimants(task.id);
    if (!owners.includes(creep.name)) owners.push(creep.name);
    runtime.claimed[task.id] = owners;
}

function releaseClaim(taskId, creep) {
    if (!taskId || !creep) return;
    const owners = claimants(taskId);
    const index = owners.indexOf(creep.name);
    if (index >= 0) owners.splice(index, 1);
}

function ensureTick() {
    if (runtime.tick === Game.time) return;
    runtime.tick = Game.time;
    runtime.claimed = {};
    runtime.scores = {};
    runtime.cpuHeadroom = null;
    runtime.projected = {};
    runtime.blocked = runtime.blocked || {};
    runtime.stuckTicks = runtime.stuckTicks || {};
    for (const creep of Object.values((typeof Game !== 'undefined' && Game.creeps) || {})) {
        const lease = creep && creep.memory && creep.memory.brokerTask;
        if (!lease || !lease.id || !(lease.until >= Game.time)) continue;
        const owners = claimants(lease.id);
        if (!owners.includes(creep.name)) owners.push(creep.name);
        runtime.claimed[lease.id] = owners;
    }
}

function consume(creep, room, target, amount, kind) {
    if (!room || !target || !target.id) return;
    beginTick();
    const sent = Math.max(0, Number(amount) || 0);
    for (const task of runtime.tasks[room.name] || []) {
        if (!task.target || task.target.id !== target.id) continue;
        if (kind && task.kind !== kind) continue;
        if (!AMOUNT_KINDS[task.kind]) continue;
        task.backlog = Math.max(0, (Number(task.backlog) || 0) - sent);
        releaseClaim(task.id, creep);
    }
}

function holdClaim(creep, taskId) {
    if (!creep || !taskId) return;
    beginTick();
    claimTask({ id: taskId }, creep);
}

function waitSpots(room) {
    if (!room) return [];
    beginTick();
    const spots = (runtime.waitSpots && runtime.waitSpots[room.name]) || [];
    const live = [];
    for (const spot of spots) {
        const target = typeof Game !== 'undefined' && typeof Game.getObjectById === 'function' ? Game.getObjectById(spot.target.id) || null : spot.target;
        if (!target || !target.store) continue;
        spot.target = target;
        spot.backlog = energyOf(target.store);
        live.push(spot);
    }
    return live;
}

function leaseSpot(creep, task) {
    if (!creep || !task || !task.id) return null;
    beginTick();
    return leaseTask(creep, { task });
}

function pooledTasks(room) {
    if (!room) return [];
    beginTick();
    return runtime.tasks[room.name] || [];
}

function isBlocked(task) {
    const until = runtime.blocked && runtime.blocked[task.id];
    return until != null && until > Game.time;
}

function roomPhase(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h) % REPLAN_INTERVAL;
}

function forceReplan() { runtime.roomPlannedAt = {}; runtime.refreshedAt = -1; }

function beginTick() {
    ensureTick();
    const planned = runtime.roomPlannedAt || (runtime.roomPlannedAt = {});
    if (runtime.refreshedAt === Game.time) return;
    runtime.refreshedAt = Game.time;
    runtime.plannedAt = Game.time;
    if (Game.time % REPLAN_INTERVAL === 0) {
        runtime.lastState = runtime.lastState || {};
        runtime.stuckTicks = runtime.stuckTicks || {};
        for (const name of Object.keys(runtime.lastState)) {
            if (!Game.creeps || !Game.creeps[name]) delete runtime.lastState[name];
        }
        for (const name of Object.keys(runtime.stuckTicks)) {
            if (!Game.creeps || !Game.creeps[name]) delete runtime.stuckTicks[name];
        }
    }
    const owned = {};
    const replanBudget = 8;
    const replanT0 = Game.cpu.getUsed();
    let deferredReplan = 0;
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my) continue;
        owned[room.name] = true;
        const last = planned[room.name];
        const due = !(last >= 0) || !runtime.tasks[room.name] || Game.time - last >= REPLAN_INTERVAL ||
            Game.time < last || (Game.time + roomPhase(room.name)) % REPLAN_INTERVAL === 0;
        if (due && (Game.cpu.getUsed() - replanT0) < replanBudget) {
            planned[room.name] = Game.time;
            runtime.tasks[room.name] = roomTasks(room);
            const metric = runtime.metrics[room.name] || { assigned: 0, idle: 0, deferred: 0, skippedCpu: 0, expired: 0 };
            metric.backlog = runtime.tasks[room.name].reduce((sum, task) => sum + task.backlog, 0);
            runtime.metrics[room.name] = metric;
        } else {
            if (due) deferredReplan++;
            const tasks = runtime.tasks[room.name];
            runtime.tasks[room.name] = refreshTasks(tasks);
            if (!runtime.metrics[room.name]) {
                runtime.metrics[room.name] = { backlog: (tasks || []).reduce((sum, task) => sum + task.backlog, 0),
                    assigned: 0, idle: 0, deferred: 0, skippedCpu: 0, expired: 0 };
            }
        }
    }
    if (deferredReplan > 0) {
        const mem = Memory.cpuDiag || (Memory.cpuDiag = {});
        mem.brokerDefer = (Number(mem.brokerDefer) || 0) + deferredReplan;
        mem.brokerDeferAt = Game.time;
    }
    for (const name of Object.keys(runtime.tasks)) if (!owned[name]) { delete runtime.tasks[name]; delete planned[name]; }
}

function refreshTasks(tasks) {
    if (typeof Game === 'undefined' || typeof Game.getObjectById !== 'function') return tasks;
    const kept = [];
    for (const task of tasks || []) {
        if (task.kind !== 'deliver' && task.kind !== 'collect') { kept.push(task); continue; }
        const live = Game.getObjectById(String(task.id).split(':')[0]);
        if (!live) continue;
        task.target = live;
        if (task.kind === 'deliver') {
            const energy = energyOf(live.store);
            let backlog = freeEnergy(live.store);
            if (task.until != null && energy >= task.until) backlog = 0;
            if (task.level != null) backlog = Math.min(backlog, task.level - energy);
            if (task.cap != null) backlog = Math.min(backlog, task.cap);
            task.backlog = backlog;
        } else {
            task.backlog = live.amount != null ? Number(live.amount || 0) : energyOf(live.store);
        }
        if (task.backlog > 0) kept.push(task);
    }
    return kept;
}

function tasksFor(creep) {
    const roomName = creep.memory && creep.memory.home || creep.room && creep.room.name;
    return runtime.tasks[roomName] || [];
}

function bestTask(creep, tasks, filter) {
    let best = null;
    let bestScore = -Infinity;
    let parts = null;
    for (const task of tasks || []) {
        if (filter && !filter(task)) continue;
        if (isBlocked(task)) continue;
        if (!compatibleParts(parts || (parts = taskParts(creep)), task)) continue;
        if (!hasClaimCapacity(task, creep)) continue;
        const score = scoreCompatible(creep, task);
        if (score > bestScore) { best = task; bestScore = score; }
    }
    return best ? { task: best, score: bestScore } : null;
}

function orderCreeps(creeps) {
    beginTick();
    const scored = (creeps || []).map((creep, index) => {
        const role = creep.memory && creep.memory.role;
        const bid = TASK_ROLES[role] ? bestTask(creep, tasksFor(creep)) : null;
        const score = bid ? bid.score : (ROLE_WEIGHT[creep.memory && creep.memory.role] || DEFAULT_WEIGHT) * ttlUrgency(creep, 0);
        runtime.scores[creep.name] = Math.round(score * 100) / 100;
        return { creep, score, index };
    });
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored.map((entry) => entry.creep);
}

function pickTask(creep, room, filter, claim) {
    if (!creep || !room) return null;
    beginTick();
    const tasks = runtime.tasks[room.name] || [];
    if (claim) {
        const leased = leasedTask(creep, tasks, filter);
        if (leased) return leased;
    }
    const candidate = bestTask(creep, tasks, filter);
    if (!candidate) return null;
    return claim ? leaseTask(creep, candidate) : candidate.task;
}

function metricFor(creep) {
    const room = creep.room && creep.room.name || creep.memory && creep.memory.home;
    if (!runtime.metrics[room]) runtime.metrics[room] = { backlog: 0, assigned: 0, idle: 0, deferred: 0, skippedCpu: 0, acted: 0 };
    return runtime.metrics[room];
}

function markSkipped(creep, reason) {
    const metric = metricFor(creep);
    if (reason === 'cpu') metric.skippedCpu++;
    else metric.idle++;
}

const ALWAYS_SKIPPABLE = ['reserver', 'scout', 'depositScout'];
let keepTick = -1;
let keepRooms = {};

function keepOneUpgrader(creep) {
    if (keepTick !== Game.time) { keepTick = Game.time; keepRooms = {}; }
    const room = (creep.memory && creep.memory.home) || (creep.room && creep.room.name) || '?';
    const kept = keepRooms[room];
    if (kept && kept !== creep.name) return false;
    keepRooms[room] = creep.name;
    return true;
}

function shouldRun(creep) {
    const score = runtime.scores[creep.name] || 0;
    const role = creep.memory && creep.memory.role;
    if (NO_SKIP.includes(role)) return true;
    if (role === 'upgrader') return keepOneUpgrader(creep);
    if (ALWAYS_SKIPPABLE.includes(role)) return false;
    return score >= 20;
}

function startCreep(creep) {
    beginTick();
    let movementCalls = 0;
    try {
        const movementStats = movement.stats();
        movementCalls = Number(movementStats && movementStats.calls) || 0;
    } catch (error) {
        movementCalls = 0;
    }
    const state = {
        x: creep.pos && creep.pos.x,
        y: creep.pos && creep.pos.y,
        roomName: creep.pos && creep.pos.roomName,
        energy: energyOf(creep.store),
    };
    runtime.lastState = runtime.lastState || {};
    const previous = runtime.lastState[creep.name];
    const changedSinceLastTick = !!previous && previous.tick < Game.time &&
        (previous.x !== state.x || previous.y !== state.y || previous.roomName !== state.roomName || previous.energy !== state.energy);
    runtime.lastState[creep.name] = Object.assign({ tick: Game.time }, state);
    return Object.assign(state, {
        movementCalls,
        brokerTask: creep.memory && creep.memory.brokerTask ? creep.memory.brokerTask.id : null,
        changedSinceLastTick,
    });
}

function wasIdle(creep) {
    const previous = runtime.lastState && creep && runtime.lastState[creep.name];
    if (!previous || !creep.pos || !(previous.tick < Game.time)) return false;
    return previous.x === creep.pos.x && previous.y === creep.pos.y && previous.roomName === creep.pos.roomName &&
        previous.energy === energyOf(creep.store);
}

function finishCreep(creep, before) {
    const metric = metricFor(creep);
    const moved = before && (before.x !== creep.pos.x || before.y !== creep.pos.y || before.roomName !== creep.pos.roomName);
    const energyChanged = before && before.energy !== energyOf(creep.store);
    if (moved || energyChanged) {
        metric.acted++;
        return;
    }
    if (before && before.changedSinceLastTick) metric.acted++;
    const lease = creep.memory && creep.memory.brokerTask;
    if (before && lease && before.brokerTask === lease.id) {
        runtime.stuckTicks = runtime.stuckTicks || {};
        runtime.blocked = runtime.blocked || {};
        const tired = Number(creep.fatigue) > 0;
        const leasedTarget = typeof Game.getObjectById === 'function' ? Game.getObjectById(String(lease.id).split(':')[0]) : null;
        const atTarget = !!(leasedTarget && distanceBetween(creep, leasedTarget) <= (ACTION_RANGE[lease.kind] || 1));
        const stuck = before.changedSinceLastTick || tired || atTarget ? 0 : (runtime.stuckTicks[creep.name] || 0) + 1;
        runtime.stuckTicks[creep.name] = stuck;
        if (stuck >= STUCK_TICKS) {
            runtime.blocked[lease.id] = Game.time + BLOCK_TICKS;
            delete creep.memory.brokerTask;
            runtime.stuckTicks[creep.name] = 0;
            metric.stuck = (metric.stuck || 0) + 1;
        }
    } else if (runtime.stuckTicks) {
        runtime.stuckTicks[creep.name] = 0;
    }
    let movementCalls = 0;
    try {
        const movementStats = movement.stats();
        movementCalls = Number(movementStats && movementStats.calls) || 0;
    } catch (error) {
        movementCalls = 0;
    }
    const movementIntent = before && movementCalls > (before.movementCalls || 0);
    const brokerIntent = before && before.brokerTask && creep.memory && creep.memory.brokerTask &&
        creep.memory.brokerTask.id === before.brokerTask;
    const role = creep.memory && creep.memory.role;
    const workTileIntent = ['harvester', 'upgrader'].includes(role) && activeParts(creep, constant('WORK', 'work')) > 0 &&
        typeof movement.isWorkTile === 'function' && movement.isWorkTile(creep, creep.pos);
    if (movementIntent || brokerIntent || workTileIntent) metric.deferred++;
    else metric.idle++;
}

function leaseTask(creep, candidate) {
    if (!candidate) return null;
    const task = candidate.task;
    const previous = creep.memory && creep.memory.brokerTask;
    if (previous && previous.id && previous.id !== task.id) releaseClaim(previous.id, creep);
    claimTask(task, creep);
    const metric = metricFor(creep);
    metric.assigned++;
    creep.memory.brokerTask = { kind: task.kind, id: task.id, until: Game.time + LEASE_TICKS };
    return task;
}

function leasedTask(creep, tasks, filter) {
    const lease = creep.memory && creep.memory.brokerTask;
    if (!lease) return null;
    const drop = () => { releaseClaim(lease.id, creep); delete creep.memory.brokerTask; return null; };
    if (lease.until < Game.time) return drop();
    const task = (tasks || []).find((item) => item.id === lease.id && item.kind === lease.kind);
    if (!task) return drop();
    if (isBlocked(task)) return drop();
    if (filter && !filter(task)) return null;
    if (AMOUNT_KINDS[task.kind] && availableFor(task, creep) <= 0) return drop();
    if (!hasClaimCapacity(task, creep)) return null;
    claimTask(task, creep);
    if (AMOUNT_KINDS[task.kind]) lease.until = Game.time + LEASE_TICKS;
    return task;
}

function runFallback(creep, room) {
    if (!creep || !room || !creep.memory || !['builder', 'upgrader'].includes(creep.memory.role)) return false;
    const state = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].state;
    if (state && (state.recovering || state.emergencyHarvest)) return false;
    beginTick();
    const tasks = tasksFor(creep);
    const carrying = energyOf(creep.store) > 0;
    const filter = carrying ? (task) => task.kind === 'deliver' ||
        (task.kind === 'upgrade' && (!room.storage || energyOf(room.storage.store) > 30000)) :
        (task) => task.kind === 'harvest';
    const candidate = leasedTask(creep, tasks, filter) || leaseTask(creep, bestTask(creep, tasks, filter));
    if (!candidate) return false;
    if (candidate.kind === 'harvest') {
        if (creep.pos.isNearTo(candidate.target.pos || candidate.target)) creep.harvest(candidate.target);
        else movement.go(creep, candidate.target, { reusePath: 15 });
        return true;
    }
    if (candidate.kind === 'deliver') {
        if (creep.transfer(candidate.target, constant('RESOURCE_ENERGY', 'energy')) === constant('ERR_NOT_IN_RANGE', -9)) {
            movement.go(creep, candidate.target, { reusePath: 15 });
        }
        return true;
    }
    if (candidate.kind === 'collect') {
        if (candidate.target.store && creep.withdraw) {
            if (creep.withdraw(candidate.target, constant('RESOURCE_ENERGY', 'energy')) === constant('ERR_NOT_IN_RANGE', -9)) {
                movement.go(creep, candidate.target, { reusePath: 15 });
            }
        } else if (creep.pickup) {
            if (creep.pickup(candidate.target) === constant('ERR_NOT_IN_RANGE', -9)) {
                movement.go(creep, candidate.target, { reusePath: 15 });
            }
        }
        return true;
    }
    if (candidate.kind === 'upgrade') {
        if (creep.upgradeController(room.controller) === constant('ERR_NOT_IN_RANGE', -9)) {
            movement.go(creep, room.controller, { reusePath: 20 });
        }
        return true;
    }
    return false;
}

function flush() {
    if (Game.time % 30 !== 0 || typeof Memory === 'undefined') return;
    const rooms = {};
    for (const [name, metric] of Object.entries(runtime.metrics)) {
        rooms[name] = {
            backlog: Math.round(metric.backlog),
            assigned: metric.assigned,
            acted: metric.acted,
            idle: metric.idle,
            deferred: metric.deferred,
            skippedCpu: metric.skippedCpu,
            stuck: metric.stuck || 0,
        };
    }
    Memory.taskBroker = {
        v: 1,
        t: Game.time,
        cpu: typeof Game !== 'undefined' && Game.cpu && typeof Game.cpu.getUsed === 'function' ?
            Math.round(Game.cpu.getUsed() * 10) / 10 : null,
        rooms,
    };
    for (const metric of Object.values(runtime.metrics)) {
        metric.assigned = 0;
        metric.acted = 0;
        metric.idle = 0;
        metric.deferred = 0;
        metric.skippedCpu = 0;
        metric.stuck = 0;
    }
}

module.exports = { upgraderBoostRoom, terminalFloorWant, terminalFillWant, terminalEnergyWant, terminalDrainKeep, feeReserveFillAllowed, labEnergyWant,
    forceReplan,
    controllerFeedLink,
    controllerFeedMode,
    controllerFeedStorage,
    beginTick,
    orderCreeps,
    shouldRun,
    markSkipped,
    startCreep,
    finishCreep,
    wasIdle,
    runFallback,
    pickTask,
    scoreTask,
    taskYield,
    taskSlots,
    roomTasks,
    pooledTasks,
    waitSpots,
    leaseSpot,
    holdClaim,
    availableFor,
    arrivalAmount,
    consume,
    setProjected,
    releaseClaim,
    flush,
    DELIVER_TIERS,
};
