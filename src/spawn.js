'use strict';
const config = require('config');
const utils = require('utils');
const { creepsHome, creepsHomeRole } = utils;
const layout = require('layout');
const links = require('links');
const retire = require('retire');
const remote = require('remote');
const brain = require('brain');
const expansion = require('expansion');
const aid = require('aid');
const defense = require('defense');
const conquest = require('conquest');
const depositMod = require('deposit');
const wallBreach = require('wall_breach');
const queue = require('spawn_queue');
const spawnExit = require('spawn_exit');
const { makeBody, bodyCost, bodyPartCount, carryCapacity, packedPathLength, pathLength, repeat, logErr, needsRepair, creepName, bodyTicksPerTile, isRetiring } = utils;

const PRIORITY = ['harvester', 'hauler', 'operator', 'upgrader', 'builder', 'feeder', 'mineralMiner', 'labTech', 'scout'];

const cpuPhases = { tick: -1, ticks: 0, ms: {} };
let phaseOn = false;
let phaseMark = 0;
function phaseBegin() {
    const every = Math.max(1, Math.floor(Number((config.cpuProfile || {}).sampleEvery) || 5));
    phaseOn = Game.time % every === 0 && !!Game.cpu && typeof Game.cpu.getUsed === 'function';
    if (!phaseOn) return;
    if (cpuPhases.tick !== Game.time) { cpuPhases.tick = Game.time; cpuPhases.ticks++; }
    phaseMark = Game.cpu.getUsed();
}
function lap(name) {
    if (!phaseOn) return;
    const now = Game.cpu.getUsed();
    cpuPhases.ms[name] = (cpuPhases.ms[name] || 0) + (now - phaseMark);
    phaseMark = now;
}
function cpuDigest() {
    const out = {};
    if (cpuPhases.ticks > 0) {
        for (const key of Object.keys(cpuPhases.ms)) {
            const value = Math.round(cpuPhases.ms[key] / cpuPhases.ticks * 1000) / 1000;
            if (value > 0) out[key] = value;
        }
    }
    cpuPhases.ticks = 0;
    cpuPhases.ms = {};
    return out;
}
const MIN_HARVESTER_COST = 200;
const BODY_UPGRADE_ROLES = ['harvester', 'hauler', 'upgrader', 'builder'];
const BODY_UPGRADE_COOLDOWN = 150;

function hasBodyPart(creep, type) {
    return (creep.body || []).some((part) => part.type === type && part.hits !== 0);
}

function spawnDirections(spawn) {
    if (!spawn || !spawn.pos) return null;
    const room = (Game.rooms && Game.rooms[spawn.pos.roomName]) || spawn.room;
    if (!room || typeof room.getTerrain !== 'function') return null;
    const { open, pockets } = spawnExit.computeSpawnDirections(room, spawn);
    const dirs = pockets.length && open.length ? open : null;
    if (pockets.length && Memory.rooms) {
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const log = mem.spawnPocket || (mem.spawnPocket = {});
        log[spawn.name || spawn.id] = { at: Game.time, pockets, dirs: dirs || null };
    }
    return dirs;
}
const releaseStalledSpawns = spawnExit.releaseStalledSpawns;

function spawnOptions(spawn, memory) {
    const opts = { memory };
    const dirs = spawnDirections(spawn);
    if (dirs) opts.directions = dirs;
    return opts;
}

const upgraderLegCache = {};
function controllerTravelTicks(roomName, body) {
    let moves = 0, heavy = 0;
    for (const part of body || []) {
        const type = part.type || part;
        if (type === 'move') moves++;
        else heavy++;
    }
    const road = Math.max(1, Math.ceil(heavy / (2 * Math.max(1, moves))));
    const plain = Math.max(1, Math.ceil(heavy / Math.max(1, moves)));
    const swamp = Math.max(1, Math.ceil(heavy * 5 / Math.max(1, moves)));
    const mem = Memory.rooms && Memory.rooms[roomName];
    const room = Game.rooms && Game.rooms[roomName];
    const cache = upgraderLegCache[roomName] || (upgraderLegCache[roomName] = {});
    const bodyKey = (moves ? "mobile:" : "immobile:") + road + "," + plain + "," + swamp + ":" + (body || []).length;
    const previous = cache[bodyKey];
    if (!room || !room.controller) {
        if (mem) mem.upgraderLeg = { at: Game.time, ticks: null, complete: false, reason: 'noVision' };
        return null;
    }
    const plan = mem && mem.plan || {};
    const station = layout.upgraderStation(room, plan);
    const anchor = station && (station.anchor ? station.anchor.pos : station.pos);
    const spawns = room.find(FIND_MY_SPAWNS).slice(0, 3);
    const key = JSON.stringify([road, plain, swamp, room.controller.level, room.controller.pos.x, room.controller.pos.y,
        anchor && anchor.x, anchor && anchor.y, station && station.pos, station && station.spots, plan.version, plan.roads && plan.roads.ctrl,
        spawns.map(s => [s.pos.x, s.pos.y])]);
    if (previous && previous.key === key && Game.time >= previous.at && Game.time - previous.at < 100) return previous.ticks;
    let ticks = 0, complete = false, goals = [], searches = 0, ops = 0;
    const terrain = room.getTerrain ? room.getTerrain() : Game.map && Game.map.getRoomTerrain && Game.map.getRoomTerrain(roomName);
    if (moves && terrain && spawns.length && typeof PathFinder !== 'undefined' && typeof PathFinder.search === 'function') {
        const matrix = new PathFinder.CostMatrix();
        const roads = new Set();
        const blocked = new Set();
        for (const s of room.find(FIND_STRUCTURES)) {
            const tile = s.pos.x + ',' + s.pos.y;
            if (s.structureType === STRUCTURE_ROAD) roads.add(tile);
            else if (s.structureType !== STRUCTURE_CONTAINER &&
                !(s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic))) blocked.add(tile);
        }
        if (room.controller.my || room.controller.safeMode) {
            const obstacles = new Set(OBSTACLE_OBJECT_TYPES);
            for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
                if (obstacles.has(site.structureType)) blocked.add(site.pos.x + ',' + site.pos.y);
            }
        }
        for (const object of room.find(FIND_SOURCES).concat(room.find(FIND_MINERALS), [room.controller])) {
            blocked.add(object.pos.x + ',' + object.pos.y);
        }
        for (const tile of roads) { const [x, y] = tile.split(',').map(Number); matrix.set(x, y, 1); }
        for (const tile of blocked) { const [x, y] = tile.split(',').map(Number); matrix.set(x, y, 255); }
        const center = anchor || room.controller.pos;
        const range = anchor ? 1 : 3;
        for (let x = Math.max(1, center.x - range); x <= Math.min(48, center.x + range); x++) {
            for (let y = Math.max(1, center.y - range); y <= Math.min(48, center.y + range); y++) {
                const pos = new RoomPosition(x, y, roomName);
                if (!blocked.has(x + ',' + y) && !(terrain.get(x, y) & TERRAIN_MASK_WALL) &&
                    (!station || layout.atUpgraderStation(pos, station, room.controller))) goals.push({ pos, range: 0 });
            }
        }
        const passable = pos => pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) &&
            pos.x > 0 && pos.y > 0 && pos.x < 49 && pos.y < 49 &&
            !blocked.has(pos.x + ',' + pos.y) && !(terrain.get(pos.x, pos.y) & TERRAIN_MASK_WALL);
        const preferred = station ? Array.from(new Map((station.spots || [station.pos]).filter(passable)
            .map(pos => [pos.x + ',' + pos.y, pos])).values()) : [];
        const branches = preferred.slice(0, 9).map(pos => [{ pos: new RoomPosition(pos.x, pos.y, roomName), range: 0 }]);
        branches.push(goals);
        complete = goals.length > 0 && preferred.length <= 9;
        const valid = new Set(goals.map(goal => goal.pos.x + ',' + goal.pos.y));
        if (complete) for (const spawn of spawns) for (const branch of branches) {
            if (ops >= 7500) { complete = false; break; }
            const maxOps = Math.min(2500, 7500 - ops);
            searches++;
            const result = PathFinder.search(spawn.pos, branch, { plainCost: 2, swampCost: 10,
                maxRooms: 1, maxOps, roomCallback: name => name === roomName ? matrix : false });
            ops += result && Number.isFinite(result.ops) ? Math.max(0, Math.min(maxOps, result.ops)) : maxOps;
            if (!result || result.incomplete || !Array.isArray(result.path)) { complete = false; continue; }
            let travel = 0, arrived = valid.has(spawn.pos.x + ',' + spawn.pos.y);
            for (const pos of result.path) {
                if (arrived) break;
                travel += roads.has(pos.x + ',' + pos.y) ? road :
                    (terrain.get(pos.x, pos.y) & TERRAIN_MASK_SWAMP) ? swamp : plain;
                arrived = valid.has(pos.x + ',' + pos.y);
            }
            if (!arrived) complete = false;
            ticks = Math.max(ticks, travel);
        }
    }
    const pathTicks = complete ? ticks : null;
    const baseLead = Math.max(config.spawnLead.upgrader || 0, (body || []).length * 3 + 12);
    const lifetime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    const reason = complete && ticks + baseLead >= lifetime ? 'lifetime' : undefined;
    if (reason) complete = false;
    if (!complete) ticks = null;
    for (const entry of Object.keys(cache)) {
        if (Game.time < cache[entry].at || Game.time - cache[entry].at >= 100) delete cache[entry];
    }
    if (!cache[bodyKey] && Object.keys(cache).length >= 8) {
        const oldest = Object.keys(cache).sort((a, b) => cache[a].at - cache[b].at)[0];
        delete cache[oldest];
    }
    cache[bodyKey] = { key, at: Game.time, ticks };
    if (mem) mem.upgraderLeg = { at: Game.time, ticks, complete, spawns: spawns.length, goals: goals.length, searches, ops, pathTicks, reason };
    return ticks;
}

function walkTicks(body, tiles) {
    if (!tiles) return 0;
    let moves = 0;
    let heavy = 0;
    for (const part of body || []) {
        const type = part.type || part;
        if (type === 'move') moves++;
        else if (type !== 'carry') heavy++;
    }
    const perTile = Math.max(1, Math.ceil(heavy / (2 * Math.max(1, moves))));
    return tiles * perTile;
}

function harvestLegTiles(room, index) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!mem) return 0;
    const refresh = Math.max(100, Number((config.harvesting || {}).legRefreshTicks) || 1500);
    const track = mem.harvestLeg || (mem.harvestLeg = { at: -1e9, tiles: [] });
    if (Game.time - Number(track.at) >= refresh) {
        track.at = Game.time;
        track.tiles = [];
        const plan = mem.plan || {};
        const spawns = room.find(FIND_MY_SPAWNS);
        const sources = layout.resolveSources(room, mem, plan) || [];
        const matrix = new PathFinder.CostMatrix();
        for (const structure of room.find(FIND_STRUCTURES)) {
            if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
            else if (structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART) matrix.set(structure.pos.x, structure.pos.y, 255);
        }
        sources.forEach((source, i) => {
            const spot = (plan.workPositions && plan.workPositions['src' + i]) || (plan.containers && plan.containers['src' + i]);
            const goal = spot ? { pos: new RoomPosition(spot.x, spot.y, room.name), range: 0 } : (source && source.pos ? { pos: source.pos, range: 1 } : null);
            if (!goal) return;
            let best = null;
            for (const spawn of spawns) {
                const ret = PathFinder.search(spawn.pos, goal, { plainCost: 2, swampCost: 10, maxRooms: 1, roomCallback: () => matrix });
                if (ret && !ret.incomplete && ret.path) best = best == null ? ret.path.length : Math.min(best, ret.path.length);
            }
            track.tiles[i] = best == null ? 0 : best;
        });
    }
    return Number(track.tiles[index]) || 0;
}

function replaceLead(creep, role) {
    const lead = roleLead(creep, role);
    if (role !== 'harvester' || !creep.memory || creep.memory.dropMiner) return lead;
    const room = Game.rooms[creep.memory.home];
    if (!room) return lead;
    const index = Number.isInteger(creep.memory.sourceIdx) ? creep.memory.sourceIdx : 0;
    return lead + walkTicks(creep.body, harvestLegTiles(room, index));
}

function roleLead(creep, role) {
    const base = config.spawnLead[role] || 0;
    const body = creep.body || [];
    const spawnTime = body.length * 3;
    let lead = Math.max(base, spawnTime + 12);
    if (role === 'upgrader' && creep.memory && creep.memory.home) lead += controllerTravelTicks(creep.memory.home, body) || 0;
    return lead;
}

function countReadyRole(room, role) {
    let n = 0;
    for (const creep of creepsHomeRole(room.name, role)) {
        if (isRetiring(creep.memory)) continue;
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, role)) continue;
        n++;
    }
    return n;
}

function countPlannedRole(room, role) {
    let n = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, role)) {
        if (isRetiring(creep.memory)) continue;
        seen.add(creep.name);
        if (creep.spawning) { n++; continue; }
        const ttl = creep.ticksToLive;
        const lead = replaceLead(creep, role);
        if (role === 'harvester' && ttl != null && ttl <= lead && ttl > roleLead(creep, role)) {
            const mem = Memory.rooms[room.name];
            if (mem) mem.harvesterEarlyReplace = { at: Game.time, name: creep.name, ttl, lead: roleLead(creep, role), replaceLead: lead };
        }
        if (ttl != null && ttl <= lead) continue;
        n++;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        if (seen.has(spawn.spawning.name) || Game.creeps[spawn.spawning.name]) continue;
        const mem = Memory.creeps[spawn.spawning.name];
        if (mem.home === room.name && mem.role === role) n++;
    }
    return n;
}

function countReadyWorkers(room) {
    let n = 0;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;
        if (creep.spawning) continue;
        if (!creep.room || creep.room.name !== room.name) continue;
        if (!hasBodyPart(creep, 'work')) continue;
        const ttl = creep.ticksToLive;
        const lead = roleLead(creep, creep.memory.role || 'harvester');
        if (ttl != null && ttl <= lead) continue;
        n++;
    }
    return n;
}

function stableHarvesterTarget(room, mem, sources) {
    const sourceCount = Math.max(1, (sources && sources.length) || 1);
    return Math.min(sourceCount, config.recovery.stableHarvesters);
}

function coreHarvesterTarget(room, sources) {
    const survival = config.survival[room.controller.level] || {};
    const stable = stableHarvesterTarget(room, null, sources);
    return Math.max(1, Math.min(stable, Number(survival.harvester || 0) || stable));
}

function roomState(room, mem, sources) {
    if (mem.state && mem.state.at === Game.time) return mem.state;
    const stableHarvesters = stableHarvesterTarget(room, mem, sources);
    const readyHarvesters = countReadyRole(room, 'harvester');
    const plannedHarvesters = countPlannedRole(room, 'harvester');
    const state = {
        at: Game.time,
        stableHarvesters,
        readyHarvesters,
        plannedHarvesters,
        readyWorkers: countReadyWorkers(room),
        recovering: readyHarvesters < stableHarvesters,
    };
    mem.state = state;
    return state;
}

const towerReachCache = { time: -1, rooms: {} };
function outOfTowerRepair(room) {
    if (towerReachCache.time !== Game.time) { towerReachCache.time = Game.time; towerReachCache.rooms = {}; }
    if (towerReachCache.rooms[room.name]) return towerReachCache.rooms[room.name];
    const range = Math.max(1, Number(config.towerCriticalRange) || 20);
    const wallRatio = Math.max(0, Math.min(1, Number(config.towerRepairBelow) || 0.6));
    const towers = room.find(FIND_MY_STRUCTURES).filter((s) => s.structureType === STRUCTURE_TOWER);
    let count = 0;
    let debt = 0;
    let critical = 0;
    for (const structure of room.find(FIND_STRUCTURES)) {
        if (structure.structureType === STRUCTURE_RAMPART || structure.structureType === STRUCTURE_WALL) continue;
        if (!needsRepair(room, structure)) continue;
        const covered = towers.some((tower) => Math.max(Math.abs(tower.pos.x - structure.pos.x),
            Math.abs(tower.pos.y - structure.pos.y)) <= range);
        if (covered) continue;
        count++;
        debt += Math.max(0, (Number(structure.hitsMax) || 0) * wallRatio - (Number(structure.hits) || 0));
        if (utils.criticallyDamaged(room, structure)) critical++;
    }
    const info = { count, debt: Math.round(debt), critical };
    towerReachCache.rooms[room.name] = info;
    return info;
}

function rampartRaiseWork(room, structures) {
    const floor = utils.wallFloorHits();
    if (!(floor > 0)) return false;
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!(mem && mem.storageRich && mem.storageRich.on)) return false;
    const n = structures.filter((s) => s.structureType === STRUCTURE_RAMPART && s.hits >= floor && needsRepair(room, s)).length;
    if (n > 0) mem.rampartRaise = { at: Game.time, n };
    return n > 0;
}

function hasBuilderWork(room) {
    if (room.find(FIND_MY_CONSTRUCTION_SITES).some((site) => utils.siteWanted(room, site))) return true;
    const structures = room.find(FIND_STRUCTURES);
    const critical = structures.find((s) => needsRepair(room, s) && utils.criticallyDamaged(room, s));
    if (critical) {
        const mem = Memory.rooms && Memory.rooms[room.name];
        if (mem) {
            const armed = room.find(FIND_MY_STRUCTURES).some((s) => s.structureType === STRUCTURE_TOWER &&
                s.store && s.store[RESOURCE_ENERGY] >= 500);
            if (armed) {
                const noSites = room.find(FIND_MY_CONSTRUCTION_SITES).length === 0;
                const seen = mem.criticalRepair || {};
                mem.criticalRepair = { at: Game.time, hits: critical.hits, type: critical.structureType,
                    n: (Number(seen.n) || 0) + 1, noSites: !!seen.noSites || noSites };
            }
        }
        return true;
    }
    const armedTower = room.find(FIND_MY_STRUCTURES).some((s) => s.structureType === STRUCTURE_TOWER &&
        s.store && s.store[RESOURCE_ENERGY] >= 500);
    if (armedTower) {
        const outOfReach = outOfTowerRepair(room);
        const minDebt = Math.max(0, Number((config.construction || {}).outOfReachMinDebt) || 0);
        if (outOfReach.count > 0 && outOfReach.debt < minDebt) {
            const mem = Memory.rooms && Memory.rooms[room.name];
            if (mem) mem.outOfReachBelowFloor = { at: Game.time, count: outOfReach.count, debt: outOfReach.debt };
        }
        if (rampartRaiseWork(room, structures)) return true;
        if (outOfReach.count === 0 || outOfReach.debt < minDebt) return false;
        const mem = Memory.rooms && Memory.rooms[room.name];
        if (mem) {
            const seen = mem.outOfReachRepair || {};
            mem.outOfReachRepair = { at: Game.time, count: outOfReach.count, debt: outOfReach.debt,
                n: (Number(seen.n) || 0) + 1 };
        }
        return true;
    }
    return structures.some((s) => needsRepair(room, s));
}

function constructionBacklog(room) {
    const settings = config.construction || {};
    const weights = settings.weights || {};
    const byType = {};
    let raw = 0;
    let weighted = 0;
    const sites = (room.find(FIND_MY_CONSTRUCTION_SITES) || []).filter((site) => utils.siteWanted(room, site));
    for (const site of sites) {
        const remaining = Math.max(0, Number(site.progressTotal || 0) - Number(site.progress || 0));
        if (!remaining) continue;
        const type = site.structureType || 'unknown';
        const normalizedType = String(type).indexOf('structure_') === 0 ? String(type).slice(10) : type;
        const configuredWeight = weights[type] == null ? weights[normalizedType] : weights[type];
        const numericWeight = Number(configuredWeight);
        const weight = configuredWeight == null || !Number.isFinite(numericWeight) ? 0.1 : Math.max(0, numericWeight);
        raw += remaining;
        weighted += remaining * weight;
        byType[type] = (byType[type] || 0) + remaining;
    }
    return {
        raw: Math.round(raw),
        weighted: Math.round(weighted),
        sites: sites.length,
        byType,
    };
}

function builderWorkEstimate(room) {
    const desired = bodyPlan(room, 'builder');
    const desiredWork = Math.max(1, bodyPartCount(desired, 'work'));
    let count = 0;
    let work = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'builder')) {
        if (isRetiring(creep.memory)) continue;
        if (creep.ticksToLive != null && !creep.spawning && creep.ticksToLive <= roleLead(creep, 'builder')) continue;
        seen.add(creep.name);
        count++;
        const workParts = bodyPartCount(creep.body, 'work');
        work += workParts > 0 ? workParts : desiredWork;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || seen.has(spawn.spawning.name) || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        const pending = Memory.creeps[spawn.spawning.name];
        if (pending.home !== room.name || pending.role !== 'builder') continue;
        count++;
        work += desiredWork;
    }
    return { count, work, desiredWork };
}

function remoteIncome(room) {
    const mem = (Memory.rooms && Memory.rooms[room.name]) || {};
    const records = mem.remotes || {};
    const factor = Number((config.construction || {}).remoteIncomeFactor || 0.8);
    let income = 0;
    for (const name in records) {
        const record = records[name];
        if (!record || !record.enabled || record.suspendedUntil > Game.time) continue;
        for (const source of record.sources || []) {
            const mined = creepsHomeRole(room.name, 'remoteMiner').some((creep) =>
                creep.memory.remoteRoom === name && creep.memory.sourceId === source.id && !creep.spawning);
            if (mined) income += 10 * factor;
        }
    }
    return income;
}

function builderTarget(room, backlog) {
    if (!hasBuilderWork(room)) return 0;
    const roster = config.roster[room.controller.level] || {};
    const settings = config.construction || {};
    const horizon = Math.max(1, Number(settings.horizon || 300));
    const progressPerWork = Math.max(1, Number(settings.progressPerWork || 5));
    const utilization = Math.max(0.2, Math.min(1, Number(settings.utilization || 0.8)));
    const limits = settings.maxBuilders || {};
    const surplusExtra = !room.storage && utils.energySurplus(room) ? Math.max(0, Number(config.energySurplus && config.energySurplus.extraBuilders) || 0) : 0;
    let max = Math.max(1, Number(limits[room.controller.level] || roster.builder || 1)) + surplusExtra;
    if (((settings.luxuryStorageAboveByRoom || {})[room.name] != null || (settings.luxuryAfterTerminal || []).indexOf(room.name) >= 0) &&
        !utils.luxuryAllowed(room)) max = 1;
    const estimate = builderWorkEstimate(room);
    const sourceCount = Math.max(1, (room.find(FIND_SOURCES) || []).length);
    const incomeShare = Math.max(0.1, Math.min(1, Number(settings.incomeShare || 0.6)));
    const buildDuty = Math.max(0.2, Math.min(1, Number(settings.buildDuty || 0.5)));
    const outOfReach = outOfTowerRepair(room);
    const repairWork = Math.ceil(outOfReach.debt / (100 * buildDuty * horizon));
    const byHorizon = Math.ceil((backlog || constructionBacklog(room)).weighted /
        (progressPerWork * horizon * utilization)) + repairWork;
    const income = sourceCount * 10 + remoteIncome(room);
    const incomeWork = Math.max(1, Math.ceil(income * incomeShare / (progressPerWork * buildDuty)));
    const requiredWork = Math.min(byHorizon, incomeWork);
    const additionalWork = Math.max(0, requiredWork - estimate.work);
    const additional = Math.ceil(additionalWork / Math.max(1, estimate.desiredWork));
    const baseline = Math.max(1, Number(roster.builder || 0));
    const byIncome = Math.max(baseline, Math.ceil(incomeWork / Math.max(1, estimate.desiredWork)));
    return Math.min(max, byIncome, Math.max(baseline, estimate.count + additional));
}

function structureAt(room, pos, type) {
    if (!pos) return null;
    return room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).find((s) => s.structureType === type) || null;
}

function sourceContainer(room, mem, source, index) {
    const planned = mem.plan && mem.plan.containers && mem.plan.containers['src' + index];
    const atPlan = structureAt(room, planned, STRUCTURE_CONTAINER);
    if (atPlan && atPlan.my !== false) return atPlan;
    if (!source) return null;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === STRUCTURE_CONTAINER &&
        structure.my !== false &&
        Math.max(Math.abs(structure.pos.x - source.pos.x), Math.abs(structure.pos.y - source.pos.y)) <= 1) || null;
}

function sourceLinkAt(room, mem, source, index) {
    const links = mem.plan && mem.plan.links;
    const planned = links && (index === 0 ? (links.src0 || links.src) : links.src1);
    const atPlan = structureAt(room, planned, STRUCTURE_LINK);
    if (atPlan && atPlan.my !== false) return atPlan;
    if (!source) return null;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === STRUCTURE_LINK &&
        structure.my !== false &&
        Math.max(Math.abs(structure.pos.x - source.pos.x), Math.abs(structure.pos.y - source.pos.y)) <= 1) || null;
}

function harvesterSourceIndex(memory, sources) {
    if (memory && memory.sourceId && Array.isArray(sources)) {
        const mapped = sources.findIndex((source) => source && source.id === memory.sourceId);
        if (mapped >= 0) return mapped;
    }
    if (memory && Number.isInteger(memory.sourceIdx) && sources && sources.length) {
        return Math.max(0, Math.min(memory.sourceIdx, sources.length - 1));
    }
    return -1;
}

function sourceWorkRequirement(source) {
    const settings = config.harvesting || {};
    const capacity = Math.max(1, Number(source && source.energyCapacity) || Number(settings.defaultCapacity) || 3000);
    const regeneration = Math.max(1, Number(settings.regenerationTicks) || 300);
    const harvestPower = Math.max(1, Number(settings.harvestPower) || 2);
    const maximum = Math.max(1, Number(settings.maxWorkPerSource) || 15);
    return Math.max(1, Math.min(maximum, Math.ceil(capacity / (regeneration * harvestPower))));
}

function harvesterStaticReady(room, mem, sources, index) {
    const source = sources && sources[index];
    if (!source) return false;
    return !!sourceContainer(room, mem, source, index) && !sourceLinkAt(room, mem, source, index);
}

function harvesterBody(room, mem, sources, index, cap) {
    const budget = Math.max(200, Number(cap) || room.energyCapacityAvailable || 200);
    if (budget >= 150 && harvesterStaticReady(room, mem, sources, index)) {
        return makeBody('staticHarvester', budget);
    }
    return makeBody('harvester', budget);
}

function harvesterDemand(room, mem, sources) {
    const bySource = [];
    let targetWork = 0;
    let actualWork = 0;
    for (let index = 0; index < (sources || []).length; index++) {
        const desired = harvesterBody(room, mem, sources, index, room.energyCapacityAvailable);
        const bodyTarget = bodyPartCount(desired, 'work');
        const target = sourceWorkRequirement(sources[index]);
        const assigned = assignedHomeHarvesters(room, index, sources);
        const work = assigned.reduce((sum, creep) => sum + bodyPartCount(creep.body, 'work'), 0);
        targetWork += target;
        actualWork += work;
        bySource.push({
            index,
            id: sources[index] && sources[index].id,
            targetWork: target,
            bodyTargetWork: bodyTarget,
            actualWork: work,
            deficit: Math.max(0, target - work),
            assigned: assigned.length,
            staticReady: harvesterStaticReady(room, mem, sources, index),
        });
    }
    return { targetWork, actualWork, deficit: Math.max(0, targetWork - actualWork), bySource };
}

function staticHarvesterSources(room, mem, sources) {
    let total = 0;
    for (let index = 0; index < (sources || []).length; index++) {
        if (harvesterStaticReady(room, mem, sources, index)) total++;
    }
    return total;
}

function harvesterTarget(room, mem, sources) {
    const roster = config.roster[room.controller.level] || {};
    const demand = harvesterDemand(room, mem, sources);
    const assignments = harvesterAssignmentStats(room, sources);
    let desired = 0;
    for (const item of demand.bySource) {
        const bodyWork = Math.max(1, item.bodyTargetWork);
        const stat = assignments[item.index] || { count: 0, work: 0 };
        const count = Math.max(0, stat.count || 0);
        if (!count) {
            desired += Math.max(1, Math.ceil(item.targetWork / bodyWork));
            continue;
        }
        const residual = Math.max(0, item.targetWork - Math.max(0, Number(stat.work) || 0));
        desired += count + Math.ceil(residual / bodyWork);
    }
    return Math.max(Number(roster.harvester || 0), coreHarvesterTarget(room, sources), desired);
}

function harvesterAssignmentStats(room, sources) {
    const stats = (sources || []).map(() => ({ count: 0, work: 0, spawning: 0 }));
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        if (isRetiring(creep.memory)) continue;
        seen.add(creep.name);
        if (!creep.spawning && creep.ticksToLive != null && creep.ticksToLive <= replaceLead(creep, 'harvester')) continue;
        const index = harvesterSourceIndex(creep.memory, sources);
        if (index < 0 || !stats[index]) continue;
        stats[index].count++;
        if (creep.spawning) stats[index].spawning++;
        stats[index].work += bodyPartCount(creep.body, 'work');
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || seen.has(spawn.spawning.name) || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory.home !== room.name || memory.role !== 'harvester') continue;
        const index = harvesterSourceIndex(memory, sources);
        if (index < 0 || !stats[index]) continue;
        stats[index].count++;
        stats[index].spawning++;
        stats[index].work += bodyPartCount(harvesterBody(room, (Memory.rooms && Memory.rooms[room.name]) || {}, sources, index,
            room.energyCapacityAvailable), 'work');
    }
    return stats;
}

function dropMinedSource(room, mem, source, index, sources) {
    if (sourceContainer(room, mem, source, index)) return false;
    const link = sourceLinkAt(room, mem, source, index);
    if (link && link.my) return false;
    const limit = Number(config.harvesting && config.harvesting.mobileTicksPerTile) || 3;
    return assignedHomeHarvesters(room, index, sources).some((creep) => bodyTicksPerTile(creep.body) > limit);
}

function hasHomeHaulingSource(room, mem, sources) {
    if (links.hubHaulMode(room, (mem && mem.plan) || {}, sources)) return true;
    for (let index = 0; index < (sources || []).length; index++) {
        const source = sources[index];
        if (sourceContainer(room, mem, source, index) && assignedHomeHarvesters(room, index, sources).length > 0) return true;
        if (dropMinedSource(room, mem, source, index, sources)) return true;
    }
    const drops = room.find(FIND_DROPPED_RESOURCES).some((resource) =>
        resource.resourceType === RESOURCE_ENERGY && resource.amount >= 80);
    if (drops) return true;
    const tombstones = room.find(FIND_TOMBSTONES).some((tombstone) => tombstone.store[RESOURCE_ENERGY] >= 50);
    if (tombstones) return true;
    return !!(room.storage && room.storage.my && room.storage.store[RESOURCE_ENERGY] > 20000);
}

function assignedHomeHarvesters(room, sourceIdx, sources) {
    const out = [];
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        if (isRetiring(creep.memory)) continue;
        if (harvesterSourceIndex(creep.memory, sources) !== sourceIdx || creep.memory.dropMiner) continue;
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, 'harvester')) continue;
        out.push(creep);
    }
    return out;
}

function plannedSourcePathLength(room, mem, idx, source) {
    const roadKey = 'src' + idx;
    const planned = mem.plan && mem.plan.roads && mem.plan.roads[roadKey];
    if (planned) return packedPathLength(planned);
    const anchor = (room.find(FIND_MY_SPAWNS)[0] || { pos: new RoomPosition(25, 25, room.name) }).pos;
    return pathLength(anchor, source.pos, { range: 1, maxRooms: 1 });
}

function controllerLegLength(room, mem) {
    const plan = (mem && mem.plan) || {};
    const ctrlContainer = plan.containers && plan.containers.ctrl;
    if (!ctrlContainer) return 0;
    const linkSpot = layout.linkSpot(plan, 'ctrl');
    const ctrlLink = linkSpot ? structureAt(room, linkSpot, STRUCTURE_LINK) : null;
    if (ctrlLink && ctrlLink.my) return 0;
    if (layout.controllerFedByStorage(room, plan)) return 0;
    if (plan.roads && plan.roads.ctrl) return packedPathLength(plan.roads.ctrl);
    const anchor = (room.find(FIND_MY_SPAWNS)[0] || { pos: new RoomPosition(25, 25, room.name) }).pos;
    return pathLength(anchor, new RoomPosition(ctrlContainer.x, ctrlContainer.y, room.name), { range: 1, maxRooms: 1 });
}

function averageHaulerCarry(room) {
    let total = 0;
    let n = 0;
    for (const creep of creepsHomeRole(room.name, 'hauler')) {
        if (isRetiring(creep.memory)) continue;
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, 'hauler')) continue;
        total += carryCapacity(creep.body);
        n++;
    }
    if (n > 0) return Math.max(50, Math.floor(total / n));
    return Math.max(50, carryCapacity(makeBody('hauler', room.energyCapacityAvailable)));
}

const HAUL_CARRY_CAPACITY = typeof CARRY_CAPACITY === 'number' ? CARRY_CAPACITY : 50;

function extensionCapacity(level) {
    return (typeof EXTENSION_ENERGY_CAPACITY !== 'undefined' && EXTENSION_ENERGY_CAPACITY[level]) || (level >= 8 ? 200 : level >= 7 ? 100 : 50);
}

function coreSizing() {
    const s = (config.hauling || {}).sizing || {};
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
        mode: s.mode === 'model' || s.mode === 'legacy' ? s.mode : 'measured',
        u: Math.max(0.2, Math.min(1, num(s.u, 0.75))),
        window: Math.max(1, num(s.window, 1500)),
        fallbackShare: Math.max(0, Math.min(1, num(s.fallbackShare, 0.5))),
        minBodyCarry: s.minBodyCarry || {},
        maxBodyCarry: s.maxBodyCarry || {},
        refillTicks: Math.max(1, num(s.refillTicks, 300)),
        refillTicksRich: Math.max(1, num(s.refillTicksRich, 150)),
        baseDistance: Math.max(1, num(s.baseDistance, 5)),
        shrinkEvery: Math.max(0, num(s.shrinkEvery, 1500)),
        shrinkMin: Math.max(1, num(s.shrinkMin, 2)),
        residualShare: Math.max(0, num(s.residualShare, 0.25)),
        upgradeCarryStep: Math.max(0, num(s.upgradeCarryStep, 0.25)),
        tempWaitTicks: Math.max(0, num(s.tempWaitTicks, 100)),
    };
}

function maxBodyCarryFor(roomName, full, sizing) {
    const table = (sizing || coreSizing()).maxBodyCarry;
    const value = Number(table && table[roomName]);
    return Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(full, Math.floor(value))) : full;
}

function minBodyCarryFor(level, sizing) {
    const table = (sizing || coreSizing()).minBodyCarry;
    const value = Number(table && table[level]);
    return Math.max(1, Number.isFinite(value) && value > 0 ? value : 4);
}

const refillGeometryCache = { time: -1, rooms: {} };
function refillGeometry(room, mem) {
    if (refillGeometryCache.time !== Game.time) { refillGeometryCache.time = Game.time; refillGeometryCache.rooms = {}; }
    const cached = refillGeometryCache.rooms[room.name];
    if (cached) return cached;
    const anchor = room.storage && room.storage.my !== false && room.storage.pos;
    const out = { ext: 0, extFrom: 'none', towers: [] };
    const dist = (pos) => (anchor ? Math.max(Math.abs(pos.x - anchor.x), Math.abs(pos.y - anchor.y)) : 0);
    let extSum = 0;
    let extN = 0;
    let spawnSum = 0;
    let spawnN = 0;
    for (const structure of room.find(FIND_MY_STRUCTURES)) {
        if (!structure || !structure.pos) continue;
        if (structure.structureType === STRUCTURE_EXTENSION) { extSum += dist(structure.pos); extN++; }
        else if (structure.structureType === STRUCTURE_SPAWN) { spawnSum += dist(structure.pos); spawnN++; }
        else if (structure.structureType === STRUCTURE_TOWER) out.towers.push(structure);
    }
    if (anchor) {
        out.extFrom = extN ? 'built' : 'plan';
        if (!extN) {
            for (const spot of (mem && mem.plan && mem.plan.ext) || []) {
                if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) { extSum += dist(spot); extN++; }
            }
            if (!extN) out.extFrom = 'spawn';
        }
        const n = extN + spawnN;
        if (n) out.ext = (extSum + spawnSum) / n;
        else { out.ext = coreSizing().baseDistance; out.extFrom = 'default'; }
    }
    refillGeometryCache.rooms[room.name] = out;
    return out;
}

function measuredCoreNeed(room, mem, sizing) {
    const ctl = mem.haulCtl || (mem.haulCtl = {});
    const meas = ctl.meas || (ctl.meas = { out: 0, ticks: 0, busy: 0, dep: 0, n: 0 });
    const stats = typeof Memory !== 'undefined' ? Memory.haulStats : null;
    const bucket = stats && Number(stats.v) >= 1 && stats.rooms && stats.rooms[room.name] && stats.rooms[room.name].hauler;
    const flushAt = stats ? Number(stats.t) : NaN;
    if (bucket && Number.isFinite(flushAt)) {
        const snap = { v: stats.v, since: stats.since, at: flushAt, t: Number(bucket.t) || 0, idle: Number(bucket.idle) || 0,
            out: Number(bucket.out) || 0, churn: Number(bucket.churn) || 0, tch: Number(bucket.tch) || 0, dep: Number(bucket.dep) || 0 };
        const base = ctl.base;
        if (!base || base.v !== snap.v || base.since !== snap.since) ctl.base = snap;
        else if (snap.at > base.at) {
            const d = { t: snap.t - base.t, idle: snap.idle - base.idle, out: snap.out - base.out, churn: snap.churn - base.churn,
                tch: snap.tch - (Number(base.tch) || 0), dep: snap.dep - base.dep };
            const dTicks = snap.at - base.at;
            ctl.base = snap;
            if (Object.values(d).every((value) => value >= 0) && d.idle <= d.t && d.churn + d.tch <= d.out) {
                const decay = Math.pow(1 - 1 / sizing.window, d.t);
                meas.out = meas.out * decay + (d.out - d.churn - d.tch);
                meas.ticks = meas.ticks * decay + dTicks;
                meas.busy = meas.busy * decay + (d.t - d.idle);
                meas.dep = meas.dep * decay + d.dep;
                meas.n = (Number(meas.n) || 0) + d.t;
                meas.at = Game.time;
            } else ctl.resets = (Number(ctl.resets) || 0) + 1;
        }
    }
    const flow = meas.ticks > 0 ? meas.out / meas.ticks : 0;
    const trip = meas.dep > 0 ? meas.busy / meas.dep : 0;
    const valid = meas.n >= sizing.window && meas.ticks > 0;
    return { valid, flow, trip, carry: valid ? flow * trip / (HAUL_CARRY_CAPACITY * sizing.u) : 0, n: meas.n };
}

function plannedHaulerCarry(room, perBody) {
    let carry = 0;
    let heads = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'hauler')) {
        if (isRetiring(creep.memory)) continue;
        seen.add(creep.name);
        if (!creep.spawning) {
            const ttl = creep.ticksToLive;
            if (ttl != null && ttl <= replaceLead(creep, 'hauler')) continue;
        }
        carry += carryCapacity(creep.body || []) / HAUL_CARRY_CAPACITY;
        heads++;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        if (seen.has(spawn.spawning.name) || Game.creeps[spawn.spawning.name]) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory.home === room.name && memory.role === 'hauler') { carry += Math.max(0, Number(perBody) || 0); heads++; }
    }
    return { carry, heads };
}

function coreCarryNeed(terms, n) {
    let need = 0;
    if (terms.flowA > 0) {
        const den = n - terms.flowB / terms.u;
        need = Math.max(need, den > 0 ? (terms.flowA / terms.u) / den : Infinity);
    }
    if (terms.measA > 0) need = Math.max(need, terms.measA / n);
    if (terms.burstA > 0) {
        const den = n - terms.burstB;
        need = Math.max(need, den > 0 ? terms.burstA / den : Infinity);
    }
    return need;
}

function coreCarryAt(terms, c) {
    return {
        flow: (terms.flowA + terms.flowB * c) / terms.u,
        base: (terms.baseA + terms.baseB * c) / terms.u,
        measured: terms.measA,
        burst: terms.burstA + terms.burstB * c,
    };
}

function sizeCoreFleet(terms, full, floorHeads, ceilHeads) {
    const start = Math.max(1, floorHeads);
    const stop = Math.max(start, ceilHeads);
    for (let n = start; n <= stop; n++) {
        const need = coreCarryNeed(terms, n);
        if (need <= full + 1e-9) return { heads: n, need, capped: false };
    }
    return { heads: stop, need: coreCarryNeed(terms, stop), capped: true };
}

function sizeHysteresis(mem, want, ctx) {
    const ctl = mem.haulCtl || (mem.haulCtl = {});
    const regime = ctx.level + ':' + (ctx.hub ? 'hub' : '-') + ':' + ctx.mode;
    const prev = Number(ctl.per);
    let reason = null;
    if (!(prev > 0)) reason = 'init';
    else if (ctl.regime !== regime) reason = 'regime';
    else if (want > prev) reason = 'grow';
    else if (want <= prev - ctx.shrinkMin && Game.time - Number(ctl.perAt || 0) >= ctx.shrinkEvery) reason = 'shrink';
    if (reason) {
        const log = ctl.decisions || (ctl.decisions = []);
        log.push({ at: Game.time, per: want, prev: prev > 0 ? prev : null, reason, mode: ctx.mode, full: ctx.full, cstar: ctx.cstar });
        if (log.length > 10) log.shift();
        ctl.per = want;
        ctl.perAt = Game.time;
        ctl.regime = regime;
    } else if (want < prev) ctl.held = { at: Game.time, want, per: prev, n: (Number(ctl.held && ctl.held.n) || 0) + 1 };
    return Math.max(ctx.cMin, Math.min(ctx.full, Number(ctl.per)));
}

function estimateHomeHaulerTarget(room, mem, sources) {
    const level = room.controller.level;
    const floors = config.hauling && config.hauling.floor || {};
    const ceils = config.hauling && config.hauling.ceil || {};
    const floor = floors[level] != null ? floors[level] : 0;
    const ceil = ceils[level] != null ? ceils[level] : floor;
    if (level < 2) return floor;

    const hauling = config.hauling || {};
    const sizing = coreSizing();
    const turnBuffer = Number.isFinite(Number(hauling.turnBuffer)) ? Math.max(0, Number(hauling.turnBuffer)) : 2;
    const minRoundTrip = (config.hauling && config.hauling.minRoundTrip) || 6;
    const legShare = Math.max(0, Math.min(1, Number(config.hauling && config.hauling.controllerLegShare) || 0));
    const utilization = Math.max(0.2, Math.min(1, Number(config.hauling && config.hauling.utilization) || 1));

    if (!hasHomeHaulingSource(room, mem, sources)) return 0;
    const controllerLeg = legShare > 0 ? controllerLegLength(room, mem) : 0;
    let production = 0;
    let travel = 0;
    let linkFed = 0;
    let overflow = false;
    const plan = mem.plan || {};
    const hubStore = level >= 7 && links.storeLinkReady(room, plan) && links.operatorStation(room, plan) ? links.getLink(room, plan, 'store') : null;
    let linkBudget = hubStore ? Infinity
        : (links.getLink(room, plan, 'ctrl') ? Math.min(upgraderWork(room), utils.upgraderWorkCap(room, mem)) : 0);
    let linkDrain = 0;
    const spillShare = Math.max(0, Math.min(1, Number(hauling.spillShare) || 0.9));

    for (let idx = 0; idx < sources.length; idx++) {
        const source = sources[idx];
        const container = sourceContainer(room, mem, source, idx);
        if (container && container.store) {
            const capacity = typeof container.store.getCapacity === 'function' ? Number(container.store.getCapacity(RESOURCE_ENERGY)) || 2000 : 2000;
            if (Number(container.store[RESOURCE_ENERGY] || 0) >= capacity * spillShare) overflow = true;
        }
        const sourceLink = sourceLinkAt(room, mem, source, idx);
        const linked = !!(sourceLink && sourceLink.my) && (idx === 0 || level >= 6);
        const haulable = !!container || dropMinedSource(room, mem, source, idx, sources);
        if (!linked && !haulable) continue;

        let work = 0;
        for (const creep of assignedHomeHarvesters(room, idx, sources)) work += bodyPartCount(creep.body, 'work');
        if (work <= 0) continue;

        let energyPerTick = Math.min(10, work * 2);
        if (linked) {
            const carried = Math.min(energyPerTick, linkBudget);
            linkBudget -= carried;
            linkDrain += carried;
            energyPerTick -= carried;
            if (energyPerTick < 1) { linkFed++; continue; }
            if (!haulable) continue;
        }
        production += energyPerTick;
        const oneWay = plannedSourcePathLength(room, mem, idx, source) + legShare * controllerLeg;
        const roundTrip = Math.max(minRoundTrip, oneWay * 2 + turnBuffer);
        travel += energyPerTick * roundTrip;
    }

    const upgrading = config.upgrading || {};
    const ctrlSpot = mem.plan && mem.plan.containers && mem.plan.containers.ctrl;
    const storageRich = utils.storageRichState(room, mem, upgrading);
    if (storageRich && ctrlSpot && !layout.controllerFedByStorage(room, mem.plan || {}) && feederTarget(room, mem) === 0) {
        const oneWay = Math.max(1, Math.abs(room.storage.pos.x - ctrlSpot.x), Math.abs(room.storage.pos.y - ctrlSpot.y));
        const roundTrip = Math.max(minRoundTrip, oneWay * 2 + turnBuffer);
        travel += (Number(upgrading.storageFeedRate) || 20) * roundTrip;
    }

    const extCap = extensionCapacity(level);
    const stopTicks = Math.max(0, Number(hauling.deliveryStopTicks) || 0);
    const spend = spawnSpendRate(room, mem);
    const share = production > 0 ? Math.max(0, Math.min(1, spend / production)) : 0;
    const storageFed = !!(room.storage && room.storage.my !== false);
    const geometry = refillGeometry(room, mem);
    const baseTrip = storageFed ? 2 * geometry.ext + turnBuffer : 0;
    const baseFlow = storageFed ? Math.max(0, spend - production) : 0;
    const refill = storageRich ? sizing.refillTicksRich : sizing.refillTicks;
    const cap = room.energyCapacityAvailable;
    const aidCapacity = Number((config.aid || {}).untilCapacity) || 0;
    const measure = sizing.mode === 'measured' ? measuredCoreNeed(room, mem, sizing) : null;
    const measured = !!(measure && measure.valid && cap >= aidCapacity);
    const mode = sizing.mode === 'model' ? 'model' : measured ? 'measured' : 'fallback';
    const terms = {
        u: utilization,
        flowA: (travel + baseFlow * baseTrip) / HAUL_CARRY_CAPACITY,
        flowB: stopTicks * (production * share + baseFlow) / extCap,
        baseA: baseFlow * baseTrip / HAUL_CARRY_CAPACITY,
        baseB: stopTicks * baseFlow / extCap,
        measA: measured ? measure.carry : 0,
        burstA: storageFed ? cap * baseTrip / (HAUL_CARRY_CAPACITY * refill) : 0,
        burstB: storageFed ? stopTicks * cap / (extCap * refill) : 0,
    };
    const linkDrop = Math.max(0, Number(hauling.linkFloorDrop) || 0);
    const linkMin = Math.max(0, Number(hubStore ? hauling.linkFloorMinStore : hauling.linkFloorMin) || 0);
    const effectiveFloor = linkFed > 0 && linkDrop > 0 ? Math.max(Math.min(floor, linkMin), floor - linkFed * linkDrop) : floor;
    const full = bodyPartCount(makeBody('hauler', cap), 'carry');
    const bodyMax = maxBodyCarryFor(room.name, full, sizing);
    const cMin = Math.max(1, Math.min(minBodyCarryFor(level, sizing), bodyMax));
    if (!(production > 0 || linkFed > 0 || storageFed)) {
        delete mem.haulModel;
        return floor;
    }
    const fleet = sizeCoreFleet(terms, full, effectiveFloor, ceil);
    let want = Math.max(cMin, Math.min(bodyMax, Math.ceil(fleet.need - 1e-9)));
    if (mode === 'fallback' || sizing.mode === 'legacy') want = Math.max(want, Math.min(bodyMax, Math.ceil(full * sizing.fallbackShare)));
    const at = coreCarryAt(terms, want);
    const cstar = Math.max(at.flow, at.measured, at.burst);
    const perBody = sizeHysteresis(mem, want, { level, hub: !!hubStore, mode, full: bodyMax, cMin, cstar: Math.round(cstar * 10) / 10,
        shrinkEvery: sizing.shrinkEvery, shrinkMin: sizing.shrinkMin });
    const demand = cstar > 0 ? sizeCoreFleet(terms, full, 1, ceil).heads : 0;
    const towerReserve = Number(config.towerRepairReserve) || 500;
    const latch = mem.towerUrgent || {};
    const towerStress = geometry.towers.some((tower) => (tower.store && Number(tower.store[RESOURCE_ENERGY] || 0) < towerReserve) || Number(latch[tower.id]) > 0);
    const combat = towerStress && defense.armedHostiles(room).length > 0;
    const waiting = mem.spawnWaiting;
    const storageEnergy = storageFed ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
    const refillLag = !!(waiting && utils.spawnWaitingFor(room) && Game.time - Number(waiting.since) >= sizing.tempWaitTicks &&
        storageEnergy >= Number(waiting.cost) - room.energyAvailable);
    const temp = combat ? 'combat' : refillLag ? 'refill' : overflow ? 'overflow' : null;
    const heads = temp ? Math.min(Math.max(fleet.heads, ceil), fleet.heads + 1) : fleet.heads;
    if (temp) {
        const seen = mem.haulTemp || (mem.haulTemp = {});
        if (seen.at !== Game.time) { seen.at = Game.time; seen.why = temp; seen[temp] = (Number(seen[temp]) || 0) + 1; }
    }
    const round = (value, k) => Math.round(value * k) / k;
    const deliveryTicks = stopTicks * share * perBody * HAUL_CARRY_CAPACITY / extCap;
    const previous = mem.haulModel || {};
    mem.haulModel = {
        production, spawnShare: round(share, 100), deliveryTicks: round(deliveryTicks, 10),
        maxDeliveryTicks: Math.max(Number(previous.maxDeliveryTicks) || 0, round(deliveryTicks, 10)),
        carry: averageHaulerCarry(room), spend: round(spend, 100),
        load: round((terms.flowA + terms.flowB * perBody) / Math.max(1, perBody), 100), demand, floor: effectiveFloor, linkFed, linkDrain,
        flow: round(at.flow, 10), base: round(at.base, 10), measured: round(at.measured, 10), burst: round(at.burst, 10),
        cstar: round(cstar, 10), want, perBody, heads: fleet.heads, temp, full, bodyMax, min: cMin, capped: fleet.capped, mode,
        meas: measure ? { n: Math.round(measure.n), flow: round(measure.flow, 100), trip: round(measure.trip, 10) } : null,
        dBase: round(geometry.ext, 10), extFrom: geometry.extFrom, refill, at: Game.time,
    };
    return heads;
}

function coreHaulerCarry(room, mem) {
    const cap = room.energyCapacityAvailable;
    const full = maxBodyCarryFor(room.name, bodyPartCount(makeBody('hauler', cap), 'carry'));
    const level = room.controller && room.controller.level || 1;
    const minCarry = Math.max(1, Math.min(full, minBodyCarryFor(level)));
    const model = mem && mem.haulModel;
    if (!model || !(Number(model.perBody) > 0)) return { parts: full, full, need: null, heads: null, min: minCarry };
    const parts = Math.max(minCarry, Math.min(full, Math.ceil(Number(model.perBody))));
    return { parts, full, need: model.cstar != null ? model.cstar : null, heads: model.heads != null ? model.heads : null, min: minCarry };
}

function haulerBudgetForCarry(parts) {
    return Math.max(200, Math.floor(parts / 2) * 150 + (parts % 2 ? 100 : 0));
}

function coreHaulerBody(room, mem, budget) {
    const size = coreHaulerCarry(room, mem);
    return makeBody('hauler', Math.min(room.energyCapacityAvailable, haulerBudgetForCarry(size.parts), Math.max(150, budget)));
}

function mineralMinerTarget(room, mem) {
    if (utils.towerFloorHold(room)) return 0;
    const miner = require('roles_mineralMiner');
    const plan = miner.directive(room);
    return plan && plan.count === 1 && miner.spawnReady(room, plan) ? 1 : 0;
}

function labTechTarget(room, mem) {
    const settings = config.industry || {};
    const count = Math.max(0, Math.floor(Number(settings.labTechs) || 0));
    if (!count || room.controller.level < 6) return 0;
    const industry = require('industry');
    let militaryActive = false;
    try { militaryActive = require('conquest').militaryCompounds().length > 0; } catch (e) { militaryActive = false; }
    if (!militaryActive && !(industry.labsAllowed ? industry.labsAllowed(room) : industry.canSpend(room)) && !(industry.boostOnlyRoom && industry.boostOnlyRoom(room))) return 0;
    let plan = null;
    try { plan = industry.labPlan(room); } catch (error) { plan = null; }
    if (!plan) return 0;
    return (plan.wants && plan.wants.length) || (plan.drains && plan.drains.length) ? count : 0;
}

function labTechBody(cap) {
    const fill = Math.max(50, Number((config.industry || {}).labFill) || 1000);
    return makeBody('labTech', cap, { carry: Math.ceil(fill / 50) });
}

function upgraderTarget(room, mem) {
    const roster = config.roster[room.controller.level] || {};
    const base = Math.max(0, Number(roster.upgrader || 0));
    if (!base) return 0;
    const held = utils.upgradeHold(room, mem);
    if (held && held.on) return held.guard ? 1 : 0;
    const settings = config.upgrading || {};
    const forceRich = (settings.forceRichUpgraders || []).indexOf(room.name) >= 0;
    const storageRich = forceRich || utils.storageRichState(room, mem, settings);
    const limits = (storageRich && settings.maxUpgradersRich) || settings.maxUpgraders || {};
    const storageEnergy = room.storage && room.storage.my !== false && room.storage.store ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
    const ctrlLink = links.getLink(room, mem.plan || {}, 'ctrl');
    const linkFed = !!ctrlLink;
    const max = Math.max(base, Number(limits[room.controller.level]) || base);
    const supply = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
    const supplyWork = utils.upgraderSupplyWork(room, mem);
    const workCap = Math.min(utils.upgraderWorkCap(room, mem), supplyWork == null ? Infinity : supplyWork);
    let capCount = Infinity;
    if (Number.isFinite(workCap)) {
        const perBody = Math.max(1, bodyPartCount(upgraderBody(room, mem, room.energyCapacityAvailable), 'work'));
        capCount = Math.max(base, Math.ceil(workCap / perBody));
    }
    supply.capCount = Number.isFinite(capCount) ? capCount : null;
    const surplusWork = utils.upgradeSurplusWork(room, mem);
    if (surplusWork > 0 && Number.isFinite(workCap)) {
        const perBody = Math.max(1, bodyPartCount(upgraderBody(room, mem, room.energyCapacityAvailable), 'work'));
        let have = 0;
        let n = 0;
        for (const creep of creepsHomeRole(room.name, 'upgrader')) {
            if (isRetiring(creep.memory)) continue;
            if (!creep.spawning && creep.ticksToLive != null && creep.ticksToLive <= replaceLead(creep, 'upgrader')) continue;
            have += bodyPartCount(creep.body, 'work');
            n++;
        }
        const slots = utils.surplusBodyPlan(room, surplusWork).slots;
        const want = Math.min(max, slots || Infinity, n + Math.ceil(Math.max(0, surplusWork - have) / perBody));
        supply.surplus = { at: Game.time, work: surplusWork, have, n, want };
        return slots ? want : Math.max(base, want);
    }
    const planned = mem.plan && mem.plan.containers && mem.plan.containers.ctrl;
    const container = structureAt(room, planned, STRUCTURE_CONTAINER);
    const fedByStorage = layout.controllerFedByStorage(room, mem.plan || {});
    if (!fedByStorage && !linkFed && (!container || !container.store)) {
        supply.extra = 0;
        return base;
    }
    if (fedByStorage && upgraderLowMode(room, mem)) {
        supply.extra = 0;
    }
    if (supply.at !== Game.time) {
        let ratio;
        let src;
        if (fedByStorage) {
            src = 'storage';
            const fullAt = Math.max(1, Number(settings.storageFullAt) || 30000);
            ratio = Math.max(0, Math.min(1, Number(room.storage.store[RESOURCE_ENERGY] || 0) / fullAt));
        } else {
            src = 'container';
            if (container && container.store) {
                const capacity = Math.max(1, Number(container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 0) || 2000);
                ratio = Math.max(0, Math.min(1, Number(container.store[RESOURCE_ENERGY] || 0) / capacity));
            } else {
                ratio = 0;
            }
            if (linkFed) {
                const linkEnergy = ctrlLink && ctrlLink.store ? Number(ctrlLink.store[RESOURCE_ENERGY] || 0) : 0;
                if (linkEnergy > 0) { ratio = 1; src = 'link'; }
                if (storageEnergy > 0) {
                    const fullAt = Math.max(1, Number(settings.storageFullAt) || 30000);
                    const fromStorage = Math.min(1, storageEnergy / fullAt);
                    if (fromStorage > ratio) { ratio = fromStorage; src = 'storage'; }
                }
            }
        }
        const alpha = Math.max(0.001, Math.min(1, Number(settings.alpha) || 0.02));
        supply.ema = supply.at < 0 ? ratio : supply.ema + alpha * (ratio - supply.ema);
        supply.emaMax = Math.max(Number(supply.emaMax) || 0, supply.ema);
        supply.src = src;
        supply.at = Game.time;
        const interval = Math.max(0, Number(settings.changeInterval) || 0);
        const canChange = supply.changedAt < 0 || Game.time - supply.changedAt >= interval;
        const raiseAbove = Number(settings.raiseAbove) || 0.7;
        const lowerBelow = Number(settings.lowerBelow) || 0.15;
        if (canChange && supply.ema >= raiseAbove && room.energyAvailable >= room.energyCapacityAvailable && base + supply.extra < Math.min(max, capCount)) {
            supply.extra++;
            supply.changedAt = Game.time;
        } else if (canChange && supply.ema <= lowerBelow && supply.extra > 0) {
            supply.extra--;
            supply.changedAt = Game.time;
        }
    }
    return Math.min(max, capCount, base + Math.max(0, supply.extra));
}

function feederDistance(room, ctrlSpot) {
    return Math.max(1, Math.abs(room.storage.pos.x - ctrlSpot.x), Math.abs(room.storage.pos.y - ctrlSpot.y));
}

function feederTarget(room, mem) {
    const settings = config.upgrading || {};
    const count = Math.max(0, Math.floor(Number(settings.feeders) || 0));
    if (!count || !room.storage || room.storage.my === false || !room.storage.store) return 0;
    const plan = mem.plan || {};
    const ctrlSpot = plan.containers && plan.containers.ctrl;
    if (!ctrlSpot || layout.controllerFedByStorage(room, plan) || links.getLink(room, plan, 'ctrl')) return 0;
    if (!structureAt(room, ctrlSpot, STRUCTURE_CONTAINER)) return 0;
    if (feederDistance(room, ctrlSpot) > (Number(settings.feederMaxDistance) || 15)) return 0;
    return utils.storageRichState(room, mem, settings) ? count : 0;
}

function operatorTarget(room, mem) {
    const settings = config.hauling || {};
    const count = Math.max(0, Math.floor(Number(settings.operators) || 0));
    if (!count || !room.controller || room.controller.level < 7) return 0;
    const plan = (mem && mem.plan) || {};
    if (!links.storeLinkReady(room, plan)) return 0;
    const sources = layout.resolveSources(room, mem, plan);
    for (let index = 0; index < (sources || []).length; index++) {
        if (links.sourceFedToStore(room, plan, sources[index], index)) return count;
    }
    return 0;
}

function operatorBody(room, mem, cap) {
    const settings = config.hauling || {};
    const carry = Math.max(1, Math.min(16, Number(settings.operatorCarry) || 8));
    const body = makeBody('operator', cap, { carry });
    const minCarry = Math.max(1, Number(settings.operatorMinCarry) || 4);
    return bodyPartCount(body, 'carry') >= minCarry && bodyCost(body) <= cap ? body : [];
}

function feederBody(room, mem, cap) {
    const settings = config.upgrading || {};
    const ctrlSpot = mem.plan && mem.plan.containers && mem.plan.containers.ctrl;
    const distance = ctrlSpot && room.storage ? feederDistance(room, ctrlSpot) : 6;
    const carry = Math.max(4, Math.min(16, Math.ceil((Number(settings.feederRate) || 20) * (distance * 2 + 4) / 50)));
    const body = makeBody('feeder', cap, { carry });
    return bodyPartCount(body, 'carry') >= Math.max(1, Number(settings.feederMinCarry) || 4) && bodyCost(body) <= cap ? body : [];
}

function targetFor(room, role, mem, sources, backlog) {
    const state = roomState(room, mem, sources);
    const roster = config.roster[room.controller.level] || {};
    if (state.recovering && role !== 'harvester' && role !== 'hauler' && role !== 'operator') return 0;
    if (role === 'harvester') return harvesterTarget(room, mem, sources);
    if (role === 'hauler') return estimateHomeHaulerTarget(room, mem, sources);
    if (role === 'upgrader') return upgraderTarget(room, mem);
    if (role === 'builder') return utils.conserving(room) || utils.towerFirstHold(room) ? 0 : builderTarget(room, backlog || constructionBacklog(room));
    if (role === 'feeder') return feederTarget(room, mem);
    if (role === 'operator') return operatorTarget(room, mem);
    if (role === 'mineralMiner') return mineralMinerTarget(room, mem);
    if (role === 'labTech') return labTechTarget(room, mem);
    if (role === 'scout') {
        if (room.controller.level < 4) return 0;
        const external = brain.directive(room.name);
        if (external) return Math.max(0, Number(external.scouts || 0));
    }
    return roster[role] || 0;
}

function recoverySpawnReserve(room) {
    const settings = config.recovery || {};
    const configured = settings.spawnReserve == null ? settings.emergencyHarvestBelow : settings.spawnReserve;
    const reserve = Number(configured);
    if (!Number.isFinite(reserve) || reserve <= 0) return 0;
    const capacity = Number(room && room.energyCapacityAvailable);
    return Number.isFinite(capacity) && capacity > 0 ? Math.min(reserve, capacity) : reserve;
}

function assignHarvesterSource(room, mem, assignedNow, sources) {
    const stats = harvesterAssignmentStats(room, sources);
    const demand = harvesterDemand(room, mem, sources).bySource;
    for (const idx in assignedNow || {}) {
        if (!stats[idx]) stats[idx] = { count: 0, work: 0 };
        stats[idx].count += assignedNow[idx];
        stats[idx].work += assignedNow[idx] * Math.max(1, bodyPartCount(harvesterBody(room, mem, sources, Number(idx), room.energyCapacityAvailable), 'work'));
    }
    const n = (sources && sources.length) || 1;
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
        const item = demand[i] || { targetWork: sourceWorkRequirement(sources[i]), bodyTargetWork: 1 };
        const stat = stats[i] || { count: 0, work: 0 };
        const requiredCount = Math.max(1, Math.ceil(item.targetWork / Math.max(1, item.bodyTargetWork)));
        const countDeficit = Math.max(0, requiredCount - stat.count);
        const workDeficit = Math.max(0, item.targetWork - stat.work);
        const score = countDeficit * 100000 + workDeficit * 100 - stat.count;
        if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
}

function matchesDemand(memory, item) {
    if (!memory || memory.home !== item.memory.home || memory.role !== item.role) return false;
    if (item.memory.aid) return memory.slotKey === item.slot;
    if (memory.slotKey) return memory.slotKey === item.slot;
    if (memory.remoteRoom !== item.memory.remoteRoom) return false;
    if (item.memory.sourceId && memory.sourceId !== item.memory.sourceId) return false;
    if (item.memory.haulSlot != null && memory.haulSlot !== item.memory.haulSlot) return false;
    return true;
}

function countPlannedDemand(room, item) {
    let count = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(item.memory.home, item.role)) {
        if (isRetiring(creep.memory)) continue;
        if (!matchesDemand(creep.memory, item)) continue;
        seen.add(creep.name);
        if (creep.spawning) { count++; continue; }
        if (creep.ticksToLive != null && creep.ticksToLive <= item.lead) continue;
        count++;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        if (seen.has(spawn.spawning.name) || Game.creeps[spawn.spawning.name]) continue;
        if (matchesDemand(Memory.creeps[spawn.spawning.name], item)) count++;
    }
    return count;
}

function bodyPlan(room, role, mem, source, sourceIdx) {
    if (!room || !room.energyCapacityAvailable) return [];
    mem = mem || layout.roomMem(room);
    if (role === 'harvester') {
        const sources = Array.isArray(source) ? source : source ? [source] : [];
        const index = Array.isArray(source) ? (sourceIdx || 0) : 0;
        return harvesterBody(room, mem, sources, index, room.energyCapacityAvailable);
    }
    if (role === 'upgrader') return upgraderBody(room, mem, room.energyCapacityAvailable);
    if (role === 'hauler') return coreHaulerBody(room, mem, room.energyCapacityAvailable);
    return makeBody(role, room.energyCapacityAvailable);
}

function upgraderLowMode(room, mem) {
    if (!layout.controllerFedByStorage(room, mem.plan || {})) return false;
    return utils.upgradeBudgetLow(room, mem);
}

function upgraderWork(room) {
    return utils.upgraderWork(room);
}

const linkFedWorkCache = { time: -1, rooms: {} };
function linkFedWork(room, mem) {
    if (linkFedWorkCache.time !== Game.time) { linkFedWorkCache.time = Game.time; linkFedWorkCache.rooms = {}; }
    if (linkFedWorkCache.rooms[room.name] != null) return linkFedWorkCache.rooms[room.name];
    const plan = mem && mem.plan;
    let work = 0;
    if (plan && links.getLink(room, plan, 'ctrl')) {
        const settings = config.harvesting || {};
        const perSource = Math.ceil((Number(settings.defaultCapacity) || 3000) / Math.max(1, Number(settings.regenerationTicks) || 300));
        work = links.senderLinks(room, plan).length * perSource;
    }
    linkFedWorkCache.rooms[room.name] = work;
    return work;
}

function upgraderBody(room, mem, budget) {
    const settings = config.upgrading || {};
    const cap = room.energyCapacityAvailable;
    let allowance = Math.min(cap, Math.max(200, Number(budget) || cap));
    const energyKey = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
    const storageE = Number((room.storage && room.storage.my !== false && room.storage.store && room.storage.store[energyKey]) || 0)
        + Number((room.terminal && room.terminal.my !== false && room.terminal.store && room.terminal.store[energyKey]) || 0);
    const poorBelow = Number(settings.poorBelow) || 10000;
    if (storageE < poorBelow) {
        const share = settings.poorBudgetShare != null ? Number(settings.poorBudgetShare) : 0.5;
        allowance = Math.min(allowance, Math.max(200, Math.floor(cap * share)));
    }
    if (upgraderLowMode(room, mem)) {
        allowance = Math.min(allowance, Math.max(200, Number(settings.lowBudget) || 550, utils.upgraderBudgetForWork(linkFedWork(room, mem))));
    }
    const rclMax = room.controller && room.controller.level >= 8 ? 15 : 50;
    const supplyWork = utils.upgraderSupplyWork(room, mem);
    const held = utils.upgradeHold(room, mem);
    const holdWork = held && held.on ? Math.max(1, Number((((settings.hold || {})[room.name]) || {}).work) || 2) : Infinity;
    const maxWork = Math.min(holdWork, supplyWork == null ? rclMax : Math.min(rclMax, supplyWork));
    if (supplyWork != null && mem && supplyWork < rclMax && Math.floor((allowance - 150) / 100) > supplyWork) {
        const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
        const seen = track.sizeCap;
        if (!seen || seen.at !== Game.time) {
            track.sizeCap = { at: Game.time, cap: supplyWork, would: Math.min(rclMax, 47, Math.floor((allowance - 150) / 100)), n: (Number(seen && seen.n) || 0) + 1 };
        }
    }
    const tier = utils.upgradeSurplusWork(room, mem);
    if (tier > 0 && !(held && held.on) && room.controller && room.controller.level < 8) {
        const sp = utils.surplusBodyPlan(room, tier);
        return makeBody('upgrader', allowance, { maxWork: Math.min(sp.work, maxWork), move: sp.move });
    }
    return makeBody('upgrader', allowance, { maxWork });
}

function plannedUpgraderWork(room) {
    let work = 0;
    for (const creep of creepsHomeRole(room.name, 'upgrader')) {
        if (isRetiring(creep.memory)) continue;
        const ttl = creep.ticksToLive;
        if (!creep.spawning && ttl != null && ttl <= replaceLead(creep, 'upgrader')) continue;
        work += bodyPartCount(creep.body, 'work');
    }
    return work;
}

function bodyImproves(creep, desired, role) {
    const currentCost = bodyCost(creep.body || []);
    const desiredCost = bodyCost(desired || []);
    if (role === 'harvester') {
        if (bodyPartCount(desired, 'work') > bodyPartCount(creep.body, 'work')) return true;
        const desiredStatic = bodyPartCount(desired, 'carry') === 0;
        const currentStatic = bodyPartCount(creep.body, 'carry') === 0;
        return desiredStatic !== currentStatic;
    }
    if (role === 'hauler') {
        const have = bodyPartCount(creep.body, 'carry');
        const step = Math.max(2, Math.ceil(have * coreSizing().upgradeCarryStep));
        if (bodyPartCount(desired, 'carry') < have + step) return false;
    }
    if (role === 'upgrader') {
        const share = Math.max(0, Math.min(1, Number((config.upgrading || {}).upgradeWorkShare) || 0.5));
        if (bodyPartCount(creep.body, 'work') >= bodyPartCount(desired, 'work') * share) return false;
    }
    if (desiredCost <= currentCost) return false;
    const lifeTime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    const ttl = creep.ticksToLive == null ? lifeTime : creep.ticksToLive;
    const waste = currentCost * ttl / lifeTime;
    return desiredCost - currentCost >= waste;
}

function hasPendingBodyUpgrade(room, creep) {
    const memory = creep.memory || {};
    const replacement = memory.bodyUpgradePending;
    if (!replacement) return false;
    if (Game.creeps && Game.creeps[replacement]) return true;
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (spawn.spawning && spawn.spawning.name === replacement) return true;
    }
    if (Memory.creeps && Memory.creeps[replacement]) return true;
    const at = Number(memory.bodyUpgradeAt || 0);
    if (at && Game.time - at < BODY_UPGRADE_COOLDOWN) return true;
    delete memory.bodyUpgradePending;
    delete memory.bodyUpgradeAt;
    return false;
}

function upgradeRoleEnabled(room, state, role, mem, sources) {
    if (role === 'harvester') return true;
    if (role === 'upgrader') return !state.recovering && (config.roster[room.controller.level] || {}).upgrader > 0;
    if (role === 'builder') return hasBuilderWork(room);
    if (role === 'hauler') return estimateHomeHaulerTarget(room, mem, sources) > 0;
    return false;
}

function modernHarvesterWork(room, sources, sourceIdx, desired) {
    const desiredWork = bodyPartCount(desired, 'work');
    const desiredStatic = bodyPartCount(desired, 'carry') === 0;
    let work = 0;
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        if (isRetiring(creep.memory)) continue;
        const memory = creep.memory;
        if (memory.dropMiner) continue;
        if (harvesterSourceIndex(memory, sources) !== sourceIdx) continue;
        const creepWork = bodyPartCount(creep.body, 'work');
        if (creepWork < desiredWork || (bodyPartCount(creep.body, 'carry') === 0) !== desiredStatic) continue;
        work += creepWork;
    }
    return work;
}

function bodyUpgradeCandidates(room, state, mem, sources) {
    if (state.recovering || state.readyWorkers <= 0) return [];
    const candidates = [];
    for (const creep of creepsHome(room.name)) {
        const role = creep.memory.role;
        if (!BODY_UPGRADE_ROLES.includes(role) || creep.spawning) continue;
        if (creep.memory.dropMiner || hasPendingBodyUpgrade(room, creep)) continue;
        if (!upgradeRoleEnabled(room, state, role, mem, sources)) continue;
        let sourceIdx = Number.isInteger(creep.memory.sourceIdx) ? creep.memory.sourceIdx : 0;
        if (role === 'harvester' && creep.memory.sourceId) {
            const mapped = sources.findIndex((source) => source && source.id === creep.memory.sourceId);
            if (mapped >= 0) sourceIdx = mapped;
        }
        const desired = role === 'harvester' ? harvesterBody(room, mem, sources, sourceIdx, room.energyCapacityAvailable) :
            bodyPlan(room, role, mem);
        const desiredCost = bodyCost(desired);
        const currentCost = bodyCost(creep.body || []);
        if (!desired.length || !bodyImproves(creep, desired, role)) continue;
        if (role === 'harvester' && sources && sources[sourceIdx] &&
            modernHarvesterWork(room, sources, sourceIdx, desired) >= sourceWorkRequirement(sources[sourceIdx])) continue;
        const ttl = creep.ticksToLive == null ? 1500 : creep.ticksToLive;
        if (creep.ticksToLive != null && ttl <= roleLead(creep, role)) continue;
        const priority = role === 'harvester' ? 100 : role === 'hauler' ? 80 : role === 'upgrader' ? 60 : 40;
        const urgency = Math.max(0, 1500 - ttl) / 20;
        const deficit = Math.max(0, desiredCost - currentCost) / 10 +
            Math.max(0, bodyPartCount(desired, 'work') - bodyPartCount(creep.body, 'work')) * 2;
        candidates.push({ creep, role, desired, desiredCost, score: priority + urgency + deficit });
    }
    return candidates.sort((left, right) => right.score - left.score || left.creep.name.localeCompare(right.creep.name));
}

function tryBodyUpgrade(room, spawn, state, mem, sources, energyBudget) {
    const candidates = bodyUpgradeCandidates(room, state, mem, sources);
    for (const candidate of candidates) {
        if (candidate.desiredCost > energyBudget) continue;
        const name = creepName(candidate.role, 'upgrade');
        const memory = Object.assign({}, candidate.creep.memory, {
            home: room.name,
            role: candidate.role,
            bodyPlanCost: candidate.desiredCost,
            replaces: candidate.creep.name,
            bodyGeneration: Number(candidate.creep.memory.bodyGeneration || 0) + 1,
        });
        delete memory.dropMiner;
        delete memory.bodyUpgradePending;
        delete memory.bodyUpgradeAt;
        if (candidate.role === 'harvester' && bodyPartCount(candidate.desired, 'carry') === 0) memory.staticMiner = true;
        else delete memory.staticMiner;
        const ret = spawn.spawnCreep(candidate.desired, name, spawnOptions(spawn, memory));
        if (ret === OK) {
            recordSpawnSpend(room, mem, candidate.desiredCost);
            candidate.creep.memory.bodyUpgradePending = name;
            candidate.creep.memory.bodyUpgradeAt = Game.time;
            return { cost: candidate.desiredCost, name, replaces: candidate.creep.name };
        }
        if (ret !== ERR_BUSY && ret !== ERR_NOT_ENOUGH_ENERGY) {
            logErr('spawn.bodyUpgrade ' + room.name, new Error('spawnCreep ' + ret + ' ' + candidate.role));
        }
    }
    return null;
}

function retireReplaced(creep) {
    if (!creep || !creep.memory || creep.spawning) return false;
    if (creep.memory.bodyUpgradeRetiring) { retire.retireAtSpawn(creep); return true; }
    const replacementName = creep.memory.bodyUpgradePending;
    if (!replacementName) return false;
    const replacement = Game.creeps && Game.creeps[replacementName];
    if (!replacement || replacement.spawning || replacement.hits === 0) return false;
    const remoteRoom = creep.memory.remoteRoom;
    if (remoteRoom && replacement.room && replacement.room.name !== remoteRoom) {
        const handover = Number(queueSettings().upgradeHandover) || 0;
        if (Game.time - Number(creep.memory.bodyUpgradeAt || 0) < handover) return false;
    }
    creep.memory.bodyUpgradeRetiring = true;
    retire.retireAtSpawn(creep);
    return true;
}

function writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets) {
    const backlog = builderBacklog || constructionBacklog(room);
    const sources = layout.resolveSources(room, mem, mem.plan);
    const harvest = harvesterDemand(room, mem, sources);
    const demand = mem.demand || {};
    demand.at = Game.time;
    demand.targets = Object.assign({}, targets);
    demand.planned = Object.assign({}, plannedCounts);
    demand.builderBacklog = backlog.weighted;
    demand.builderBacklogDetail = {
        raw: backlog.raw,
        weighted: backlog.weighted,
        sites: backlog.sites,
        byType: Object.assign({}, backlog.byType),
    };
    demand.harvesterWork = harvest.actualWork;
    demand.harvesterWorkTarget = harvest.targetWork;
    demand.harvesterWorkDeficit = harvest.deficit;
    demand.harvesterBySource = harvest.bySource;
    demand.harvesterWorkMax = harvest.targetWork;
    demand.harvesterStaticSources = staticHarvesterSources(room, mem, sources);
    demand.sourceCount = (sources || []).length;
    demand.haulerTarget = targets.hauler || 0;
    demand.upgradeSupply = mem.upgradeSupply ? {
        ema: Math.round(Number(mem.upgradeSupply.ema || 0) * 100) / 100,
        extra: Number(mem.upgradeSupply.extra || 0),
    } : null;
    demand.remote = (remoteDemands || []).length;
    mem.demand = demand;
    if (state) {
        state.builderTarget = targets.builder || 0;
        state.builderBacklog = backlog.weighted;
        const outOfReach = outOfTowerRepair(room);
        state.builderRepairDebt = outOfReach.debt;
        state.builderOutOfReach = outOfReach.count;
    }
}

function residualHarvesterBody(room, mem, sources, index, cap, workNeeded) {
    const budget = Math.max(0, Number(cap) || 0);
    if (budget < 150) return [];
    const desired = harvesterBody(room, mem, sources, index, Math.max(200, budget));
    const maxWork = Math.max(1, bodyPartCount(desired, 'work'));
    const requested = Math.max(1, Math.min(maxWork, Math.ceil(Number(workNeeded) || 1)));
    const staticMode = harvesterStaticReady(room, mem, sources, index);
    for (let work = requested; work >= 1; work--) {
        if (staticMode) {
            const minimum = work * 100 + 50;
            if (minimum > budget) continue;
            const move = Math.max(1, Math.min(Math.ceil(work / 2), Math.floor((budget - work * 100) / 50)));
            if (work * 100 + move * 50 <= budget) return repeat('work', work).concat(repeat('move', move));
            continue;
        }
        const minimum = work * 100 + 100;
        if (minimum > budget) continue;
        const move = Math.max(1, Math.min(work, Math.floor((budget - work * 100 - 50) / 50)));
        if (work * 100 + 50 + move * 50 <= budget) {
            return repeat('work', work).concat(['carry'], repeat('move', move));
        }
    }
    return [];
}

function queueSettings() {
    const settings = config.spawnQueue || {};
    return {
        richBuilderStorage: Number(settings.richBuilderStorage) || 0,
        classes: Object.assign({ defense: 0, survival: 1, expansion: 2, remoteMaintain: 3, development: 4, aid: 5, remote: 6, opportunistic: 7 }, settings.classes || {}),
        grace: Object.assign({ defense: 0, survival: 30, expansion: 300, remoteMaintain: 60, development: 150, aid: 300, remote: 300 }, settings.grace || {}),
        busyDemandInterval: settings.busyDemandInterval == null ? 7 : Number(settings.busyDemandInterval),
        quietDemandInterval: settings.quietDemandInterval == null ? 5 : Number(settings.quietDemandInterval),
        minShare: settings.minShare == null ? 0.5 : Number(settings.minShare),
        minCostShare: settings.minCostShare == null ? 0.5 : Number(settings.minCostShare),
        upgradePayback: settings.upgradePayback == null ? 2 : Number(settings.upgradePayback),
        upgradeHandover: settings.upgradeHandover == null ? 200 : Number(settings.upgradeHandover),
        incomeAlpha: settings.incomeAlpha == null ? 0.05 : Number(settings.incomeAlpha),
        incomeSamples: settings.incomeSamples == null ? 10 : Number(settings.incomeSamples),
        fallbackIncomePerSource: settings.fallbackIncomePerSource == null ? 5 : Number(settings.fallbackIncomePerSource),
        reserveMargin: settings.reserveMargin == null ? 20 : Number(settings.reserveMargin),
        reserveMaxLead: settings.reserveMaxLead == null ? 150 : Number(settings.reserveMaxLead),
        minIncome: settings.minIncome == null ? 1 : Number(settings.minIncome),
        survivalShrinkAfter: settings.survivalShrinkAfter == null ? 300 : Number(settings.survivalShrinkAfter),
    };
}

function replacementReserveRequests(room, mem, state, sources, settings, income) {
    const requests = [];
    if (state.readyWorkers === 0 || !(income > 0)) return requests;
    const cap = room.energyCapacityAvailable;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;
        const memory = creep.memory;
        if (creep.spawning || memory.dropMiner || memory.aid) continue;
        if (memory.role !== 'harvester' && memory.role !== 'hauler' && memory.role !== 'operator') continue;
        if (creep.ticksToLive == null) continue;
        const remaining = creep.ticksToLive - replaceLead(creep, memory.role);
        if (remaining <= 0) continue;
        const ideal = memory.role === 'harvester'
            ? harvesterBody(room, mem, sources, Math.max(0, harvesterSourceIndex(memory, sources)), cap)
            : memory.role === 'operator' ? operatorBody(room, mem, cap) : coreHaulerBody(room, mem, cap);
        const cost = Math.min(bodyCost(ideal), Math.ceil(cap * settings.minShare));
        if (!(cost > 0)) continue;
        const eta = Math.min(queue.ticksToAfford(cost - room.energyAvailable, income), settings.reserveMaxLead);
        if (!(remaining <= eta + settings.reserveMargin)) continue;
        const reserveLog = mem.reserveLog && typeof mem.reserveLog === 'object' && !mem.reserveLog.role ? mem.reserveLog : (mem.reserveLog = {});
        reserveLog[memory.role] = { at: Game.time, cost, ideal: bodyCost(ideal), capacity: cap, remaining: Math.round(remaining) };
        requests.push({
            key: 'reserve:' + memory.role + ':' + creep.name,
            role: memory.role,
            priority: settings.classes.survival + 0.5,
            grace: 0,
            reserve: cost,
            vital: true,
        });
    }
    return requests;
}

const SPAWN_SELF_REGEN_BELOW = typeof SPAWN_ENERGY_CAPACITY === 'number' ? SPAWN_ENERGY_CAPACITY : 300;

function spawnSelfRegen(room) {
    return room.find(FIND_MY_SPAWNS).filter((spawn) => spawn.store && (spawn.store[RESOURCE_ENERGY] || 0) < SPAWN_SELF_REGEN_BELOW).length;
}

function updateSpawnIncome(room, mem, settings) {
    const track = mem.spawnIncome || (mem.spawnIncome = { ema: 0, n: 0, last: null, at: -1 });
    const energy = room.energyAvailable;
    if (track.at === Game.time - 1 && track.last != null && track.last < room.energyCapacityAvailable) {
        const regen = track.last < SPAWN_SELF_REGEN_BELOW ? spawnSelfRegen(room) : 0;
        if (!regen && track.last >= SPAWN_SELF_REGEN_BELOW && spawnSelfRegen(room) > 0) track.noRegen = (Number(track.noRegen) || 0) + 1;
        const delta = energy - track.last - regen;
        if (delta >= 0) {
            track.ema = (Number(track.ema) || 0) + settings.incomeAlpha * (delta - (Number(track.ema) || 0));
            track.n++;
        }
    }
    track.last = energy;
    track.at = Game.time;
    return track;
}

function spawnSpendAlpha() {
    return 1 / Math.max(1, Number((config.hauling || {}).spawnSpendWindow) || 1500);
}

function creepLifeTicks(body) {
    const life = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    const claimLife = typeof CREEP_CLAIM_LIFE_TIME === 'number' ? CREEP_CLAIM_LIFE_TIME : 600;
    return bodyPartCount(body, 'claim') > 0 ? claimLife : life;
}

function spawnUpkeep(room) {
    let total = 0;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;
        const body = creep.body || [];
        if (body.length) total += bodyCost(body) / creepLifeTicks(body);
    }
    return total;
}

function spawnSpendTrack(room, mem) {
    const track = mem.spawnSpend;
    if (track && typeof track === 'object' && Number.isFinite(Number(track.ema)) && Number.isFinite(Number(track.at))) return track;
    return (mem.spawnSpend = { ema: spawnUpkeep(room), at: Game.time, n: 0 });
}

function spawnSpendRate(room, mem) {
    if (!mem) return 0;
    const track = spawnSpendTrack(room, mem);
    const dt = Math.max(0, Game.time - Number(track.at));
    return Math.max(0, Number(track.ema) || 0) * Math.pow(1 - spawnSpendAlpha(), dt);
}

function recordSpawnSpend(room, mem, cost) {
    if (!mem || !(cost > 0)) return;
    const track = spawnSpendTrack(room, mem);
    track.ema = spawnSpendRate(room, mem) + spawnSpendAlpha() * cost;
    track.at = Game.time;
    track.n = (Number(track.n) || 0) + 1;
}

function harvesterDelivers(room, mem, sources, creep) {
    if (!hasBodyPart(creep, 'carry')) return false;
    const limit = Number(config.harvesting && config.harvesting.mobileTicksPerTile) || 3;
    if (bodyTicksPerTile(creep.body) > limit) return false;
    const index = harvesterSourceIndex(creep.memory, sources);
    const source = index >= 0 && sources ? sources[index] : null;
    if (!source) return true;
    if (sourceContainer(room, mem, source, index)) return false;
    const link = sourceLinkAt(room, mem, source, index);
    return !(link && link.my);
}

function incomeEstimate(room, mem, state, sources, settings) {
    const readyHarvesters = state && state.readyHarvesters != null ? state.readyHarvesters : countReadyRole(room, 'harvester');
    if (!readyHarvesters) return 0;
    let carriers = 0;
    let minersNotCarrying = 0;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;
        if (creep.spawning) continue;
        if (creep.memory.role === 'hauler') carriers++;
        else if (creep.memory.role === 'harvester') {
            if (harvesterDelivers(room, mem, sources, creep)) carriers++;
            else if (hasBodyPart(creep, 'carry')) minersNotCarrying++;
        }
    }
    if (minersNotCarrying && mem && mem.spawnIncome) {
        const seen = mem.spawnIncome.minerNotCarrier || {};
        if (seen.at !== Game.time) mem.spawnIncome.minerNotCarrier = { at: Game.time, n: (Number(seen.n) || 0) + 1, miners: minersNotCarrying };
    }
    if (!carriers) {
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (!creep || !creep.memory || creep.memory.role !== 'remoteHauler' || creep.spawning || isRetiring(creep.memory)) continue;
            const drop = creep.memory.dropRoom || remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
            if (drop === room.name) { carriers++; break; }
        }
    }
    if (!carriers && mem && mem.spawnIncome && creepsHome(room.name).some((creep) => creep.memory.role === 'harvester' && hasBodyPart(creep, 'carry') && !creep.spawning)) {
        const seen = mem.spawnIncome.noCarrier || {};
        mem.spawnIncome.noCarrier = { at: Game.time, n: (Number(seen.n) || 0) + 1 };
    }
    if (!carriers) return 0;
    const track = mem.spawnIncome;
    if (track && track.n >= settings.incomeSamples) {
        const ema = Math.max(0, Number(track.ema) || 0);
        if (ema >= (Number(settings.minIncome) || 0)) return ema;
        track.starved = (Number(track.starved) || 0) + 1;
        return 0;
    }
    return settings.fallbackIncomePerSource * Math.max(1, (sources || []).length);
}

function demandRequest(room, item, cls, settings, flags) {
    const body = item.body || [];
    const cost = bodyCost(body);
    return Object.assign({
        key: cls + ':' + item.slot,
        role: item.role,
        item,
        priority: settings.classes[cls],
        grace: item.grace != null ? Number(item.grace) : (settings.grace[cls] || 0),
        neededBy: item.neededBy,
        ordered: true,
        minCostShare: typeof item.bodyFor === 'function' ? settings.minCostShare : undefined,
        memory: Object.assign({}, item.memory, { home: item.memory.home || room.name, role: item.role, slotKey: item.slot }),
        body: (budget) => {
            if (body.length && cost <= budget) return body;
            if (typeof item.bodyFor !== 'function') return [];
            const scaled = item.bodyFor(Math.max(0, budget)) || [];
            return scaled.length && bodyCost(scaled) <= budget ? scaled : [];
        },
    }, flags || {});
}

function coreContainerGap(room, mem, sources) {
    const plan = mem && mem.plan;
    if (!plan || !plan.containers) return 0;
    let gap = 0;
    (sources || []).forEach((source, index) => {
        if (!plan.containers['src' + index]) return;
        if (sourceContainer(room, mem, source, index) || sourceLinkAt(room, mem, source, index)) return;
        if (structureAt(room, plan.containers['src' + index], STRUCTURE_CONTAINER)) return;
        gap++;
    });
    if (plan.containers.ctrl && !structureAt(room, plan.containers.ctrl, STRUCTURE_CONTAINER) &&
        !(plan.links && plan.links.ctrl && structureAt(room, plan.links.ctrl, STRUCTURE_LINK)) &&
        !layout.controllerFedByStorage(room, plan)) gap++;
    return gap;
}

function coreRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, baseUpgraders, settings) {
    const requests = [];
    const cap = room.energyCapacityAvailable;
    const planned = Object.assign({}, plannedCounts);
    const assignPreview = {};
    for (let n = planned.harvester; n < survivalTargets.harvester; n++) {
        const sourceIdx = assignHarvesterSource(room, mem, assignPreview, sources);
        assignPreview[sourceIdx] = (assignPreview[sourceIdx] || 0) + 1;
        const memory = { home: room.name, role: 'harvester', sourceIdx };
        if (sources[sourceIdx]) memory.sourceId = sources[sourceIdx].id;
        requests.push({
            key: 'core:harvester:' + n,
            role: 'harvester',
            priority: settings.classes.survival,
            grace: settings.grace.survival,
            vital: true,
            memory,
            sourceIdx,
            body: (budget) => (budget < MIN_HARVESTER_COST ? [] : harvesterBody(room, mem, sources, sourceIdx, Math.min(cap, budget))),
            finalize: (body, creepMemory) => { if (bodyPartCount(body, 'carry') === 0) creepMemory.staticMiner = true; },
        });
    }
    if (state.readyWorkers === 0) return requests;
    const haulerPlan = coreHaulerCarry(room, mem);
    if (planned.hauler < targets.hauler) {
        const model = mem.haulModel || {};
        mem.haulerSize = { at: Game.time, parts: haulerPlan.parts, full: haulerPlan.full, need: haulerPlan.need, count: targets.hauler,
            heads: haulerPlan.heads, min: haulerPlan.min, mode: model.mode, temp: model.temp, production: model.production, flow: model.flow,
            base: model.base, measured: model.measured, burst: model.burst, spend: model.spend };
    }
    for (let n = planned.hauler; n < targets.hauler; n++) {
        const cls = (n < 2 || n < survivalTargets.hauler) ? 'survival' : 'development';
        requests.push({
            key: 'core:hauler:' + n,
            role: 'hauler',
            priority: cls === 'survival' ? settings.classes.survival : settings.classes.development,
            grace: settings.grace[cls],
            vital: cls === 'survival',
            memory: { home: room.name, role: 'hauler' },
            body: (budget) => {
                const body = coreHaulerBody(room, mem, Math.min(cap, budget));
                return bodyCost(body) <= budget ? body : [];
            },
        });
    }
    const cstar = Number(haulerPlan.need) || 0;
    if (planned.hauler >= targets.hauler && targets.hauler > 0 && cstar > 0) {
        const live = plannedHaulerCarry(room, haulerPlan.parts);
        const gap = cstar - live.carry;
        const minGap = Math.max(2, Math.ceil(cstar * coreSizing().residualShare));
        if (gap >= minGap) {
            const parts = Math.max(haulerPlan.min, Math.min(haulerPlan.parts, Math.ceil(gap)));
            mem.haulerResidual = { at: Game.time, live: Math.round(live.carry * 10) / 10, heads: live.heads, cstar, gap: Math.round(gap * 10) / 10, parts };
            requests.push({
                key: 'core:hauler:x',
                role: 'hauler',
                priority: settings.classes.development,
                grace: settings.grace.development,
                memory: { home: room.name, role: 'hauler' },
                body: (budget) => {
                    const body = makeBody('hauler', Math.min(cap, haulerBudgetForCarry(parts), Math.max(150, budget)));
                    return bodyCost(body) <= budget ? body : [];
                },
            });
        }
    }
    for (let n = planned.operator; n < (targets.operator || 0); n++) {
        requests.push({
            key: 'core:operator:' + n,
            role: 'operator',
            priority: settings.classes.survival + 0.25,
            grace: settings.grace.survival,
            vital: true,
            memory: { home: room.name, role: 'operator' },
            body: (budget) => {
                const body = operatorBody(room, mem, Math.min(cap, Math.max(200, budget)));
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    const richUpgrade = !!mem.remoteSpawnCapped;
    const upWorkCap = planned.upgrader < targets.upgrader ? utils.upgraderSupplyWork(room, mem) : null;
    let upWork = upWorkCap == null ? 0 : plannedUpgraderWork(room);
    if (planned.upgrader === 0 && mem.upgradeBudget && mem.upgradeBudget.work) { mem.upgradeBudget.work = 0; mem.upgradeBudget.at = Game.time; }
    const upPerBody = upWorkCap == null ? 0 : bodyPartCount(upgraderBody(room, mem, cap), 'work');
    const holdGuard = utils.upgradeHold(room, mem);
    const towerHoldUp = utils.towerFirstHold(room) && !(room.controller && room.controller.ticksToDowngrade < 5000) && !(holdGuard && holdGuard.guard);
    if (towerHoldUp && planned.upgrader < targets.upgrader) {
        const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
        track.towerHold = Game.time;
    }
    for (let n = planned.upgrader; !towerHoldUp && n < targets.upgrader; n++) {
        if (upWorkCap != null && upWork >= upWorkCap) {
            const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
            track.workGate = { at: Game.time, cap: upWorkCap, planned: upWork, held: targets.upgrader - n };
            break;
        }
        upWork += upPerBody;
        const economyThin = planned.hauler < 2 || planned.harvester < survivalTargets.harvester;
        const noUpgrader = n === 0 && planned.upgrader === 0;
        const cls = noUpgrader && !economyThin ? 'firstUpgrader' : economyThin ? 'opportunistic'
            : (n < baseUpgraders || richUpgrade ? 'development' : 'opportunistic');
        requests.push({
            key: 'core:upgrader:' + n,
            role: 'upgrader',
            priority: cls === 'firstUpgrader' ? settings.classes.remoteMaintain - 0.5 : settings.classes[cls],
            grace: settings.grace[cls] || settings.grace.development,
            opportunistic: cls === 'opportunistic',
            jumpable: true,
            memory: { home: room.name, role: 'upgrader' },
            body: (budget) => {
                const body = upgraderBody(room, mem, Math.min(cap, Math.max(200, budget)));
                return bodyCost(body) <= budget ? body : [];
            },
        });
    }
    const containerGap = planned.builder === 0 ? coreContainerGap(room, mem, sources) : 0;
    const criticalGap = planned.builder === 0 && containerGap === 0 && utils.hasCriticalStructure(room);
    if (criticalGap) {
        const seen = mem.criticalBuilder || {};
        mem.criticalBuilder = { at: Game.time, n: (Number(seen.n) || 0) + 1 };
    }
    const richBuilderAt = Number(settings.richBuilderStorage) || 0;
    const richBuilder = planned.builder === 0 && richBuilderAt > 0 && !!room.storage &&
        (Number(room.storage.store[RESOURCE_ENERGY]) || 0) >= richBuilderAt;
    for (let n = planned.builder; n < targets.builder; n++) {
        const vitalBuilder = n === 0 && (containerGap > 0 || criticalGap || require('wallfix').needsWorker(room));
        const richFirst = n === 0 && !vitalBuilder && richBuilder;
        requests.push({
            key: 'core:builder:' + n,
            role: 'builder',
            priority: vitalBuilder ? settings.classes.survival + 0.75 : richFirst ? settings.classes.remoteMaintain - 0.5 : settings.classes.development,
            grace: vitalBuilder ? settings.grace.survival : settings.grace.development,
            vital: vitalBuilder,
            memory: { home: room.name, role: 'builder' },
            body: (budget) => {
                const full = !!(Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].builderSurge);
                const body = makeBody('builder', full ? cap : Math.min(cap, Math.max(200, budget)));
                return bodyCost(body) <= budget ? body : [];
            },
        });
    }
    for (let n = planned.feeder; n < (targets.feeder || 0); n++) {
        requests.push({
            key: 'core:feeder:' + n,
            role: 'feeder',
            priority: settings.classes.development,
            grace: settings.grace.development,
            memory: { home: room.name, role: 'feeder' },
            body: (budget) => {
                const body = feederBody(room, mem, Math.min(cap, Math.max(200, budget)));
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    for (let n = planned.mineralMiner; n < (targets.mineralMiner || 0); n++) {
        requests.push({
            key: 'core:mineralMiner:' + n,
            role: 'mineralMiner',
            priority: settings.classes.opportunistic,
            grace: 0,
            opportunistic: true,
            memory: { home: room.name, role: 'mineralMiner' },
            body: (budget) => {
                const plan = require('roles_mineralMiner').directive(room);
                const body = plan && Array.isArray(plan.body) ? plan.body : [];
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    for (let n = planned.labTech; n < (targets.labTech || 0); n++) {
        requests.push({
            key: 'core:labTech:' + n,
            role: 'labTech',
            priority: (config.industry || {}).labTechClass ? settings.classes[(config.industry || {}).labTechClass] : settings.classes.opportunistic,
            grace: 0,
            opportunistic: true,
            memory: { home: room.name, role: 'labTech' },
            body: (budget) => {
                const body = labTechBody(Math.min(cap, Math.max(200, budget)));
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    for (let n = planned.scout; n < targets.scout; n++) {
        const body = makeBody('scout', cap);
        requests.push({
            key: 'core:scout:' + n,
            role: 'scout',
            priority: settings.classes.opportunistic,
            grace: 0,
            opportunistic: true,
            memory: { home: room.name, role: 'scout' },
            body: (budget) => (bodyCost(body) <= budget ? body : []),
        });
    }
    return requests;
}

function harvesterUpgradeRequests(room, state, mem, sources, settings) {
    const requests = [];
    if (state.readyWorkers === 0) return requests;
    for (const candidate of bodyUpgradeCandidates(room, state, mem, sources)) {
        if (candidate.role !== 'harvester') continue;
        const memory = Object.assign({}, candidate.creep.memory, {
            home: room.name,
            role: 'harvester',
            bodyPlanCost: candidate.desiredCost,
            replaces: candidate.creep.name,
            bodyGeneration: Number(candidate.creep.memory.bodyGeneration || 0) + 1,
        });
        delete memory.dropMiner;
        delete memory.bodyUpgradePending;
        delete memory.bodyUpgradeAt;
        if (bodyPartCount(candidate.desired, 'carry') === 0) memory.staticMiner = true;
        else delete memory.staticMiner;
        requests.push({
            key: 'upgrade:harvester:' + candidate.creep.name,
            role: 'harvester',
            tag: 'upgrade',
            priority: settings.classes.survival,
            grace: 0,
            ordered: true,
            vital: true,
            strategic: true,
            opportunistic: true,
            blocking: false,
            memory,
            sourceIdx: harvesterSourceIndex(candidate.creep.memory, sources),
            body: (budget) => (candidate.desiredCost <= budget ? candidate.desired : []),
            onSpawn: (creepMemory, name) => {
                candidate.creep.memory.bodyUpgradePending = name;
                candidate.creep.memory.bodyUpgradeAt = Game.time;
            },
        });
    }
    return requests;
}

function demandUpgradeRequests(room, items, settings) {
    const requests = [];
    const payback = Number(settings.upgradePayback) || 0;
    if (!(payback > 0)) return requests;
    for (const item of items || []) {
        if (typeof item.throughput !== 'function' || !item.body || !item.body.length) continue;
        const idealCost = bodyCost(item.body);
        const idealRate = item.throughput(item.body);
        if (!(idealCost > 0) || !(idealRate > 0)) continue;
        let holder = null;
        let holderRate = -Infinity;
        let pending = false;
        for (const creep of creepsHomeRole(item.memory.home, item.role)) {
            if (!matchesDemand(creep.memory, item)) continue;
            if (creep.spawning || (creep.memory.replaces && Game.creeps[creep.memory.replaces])) { pending = true; break; }
            if (hasPendingBodyUpgrade(room, creep)) { pending = true; break; }
            const rate = item.throughput(creep.body || []);
            if (rate > holderRate) { holder = creep; holderRate = rate; }
        }
        if (pending || !holder) continue;
        const ttl = holder.ticksToLive == null ? 1500 : holder.ticksToLive;
        const remaining = ttl - (item.lead || 0);
        if (remaining <= 0) continue;
        const gain = (idealRate - holderRate) * remaining;
        if (!(gain >= payback * idealCost)) continue;
        const urgent = item.role === 'remoteMiner' && holderRate < idealRate * 0.5;
        if (urgent) {
            const homeMem = Memory.rooms && Memory.rooms[item.memory.home || room.name];
            if (homeMem) {
                const event = { at: Game.time, slot: item.slot, rate: holderRate, ideal: idealRate };
                homeMem.minerUpgradeUrgent = event;
                const log = homeMem.minerUpgradeLog = (homeMem.minerUpgradeLog || []).filter((entry) => entry && entry.slot !== item.slot);
                log.push(event);
                if (log.length > 6) log.splice(0, log.length - 6);
            }
        }
        const memory = Object.assign({}, item.memory, {
            home: item.memory.home || room.name,
            role: item.role,
            slotKey: item.slot,
            replaces: holder.name,
            bodyGeneration: Number(holder.memory.bodyGeneration || 0) + 1,
        });
        requests.push({
            key: 'upgrade:' + item.slot,
            role: item.role,
            tag: 'upgrade',
            item,
            priority: urgent ? settings.classes.remoteMaintain : settings.classes.remote,
            grace: 0,
            ordered: true,
            opportunistic: !urgent,
            blocking: false,
            memory,
            body: (budget) => (idealCost <= budget ? item.body : []),
            onSpawn: (creepMemory, name) => {
                holder.memory.bodyUpgradePending = name;
                holder.memory.bodyUpgradeAt = Game.time;
            },
        });
    }
    return requests;
}

function elasticHarvesterRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, settings, upgrading) {
    const requests = [];
    if (state.readyWorkers === 0) return requests;
    if (plannedCounts.harvester < survivalTargets.harvester) return requests;
    const cap = room.energyCapacityAvailable;
    const demandBySource = harvesterDemand(room, mem, sources).bySource;
    const stats = harvesterAssignmentStats(room, sources);
    let keep = Math.max(0, recoverySpawnReserve(room));
    if (cap - keep < MIN_HARVESTER_COST) keep = 0;
    const assignPreview = {};
    for (let n = Math.max(plannedCounts.harvester, survivalTargets.harvester); n < targets.harvester; n++) {
        const sourceIdx = assignHarvesterSource(room, mem, assignPreview, sources);
        const item = demandBySource[sourceIdx] || {};
        const stat = stats[sourceIdx] || { work: 0 };
        const previewWork = (assignPreview[sourceIdx] || 0) * Math.max(1, Number(item.bodyTargetWork) || 1);
        const workNeeded = Math.max(0, Number(item.targetWork || 0) - Number(stat.work || 0) - previewWork);
        if (workNeeded <= 0 || upgrading.has(sourceIdx)) break;
        assignPreview[sourceIdx] = (assignPreview[sourceIdx] || 0) + 1;
        const memory = { home: room.name, role: 'harvester', sourceIdx };
        if (sources[sourceIdx]) memory.sourceId = sources[sourceIdx].id;
        requests.push({
            key: 'core:harvester:elastic:' + sourceIdx,
            role: 'harvester',
            tag: 'elastic',
            priority: settings.classes.remote,
            grace: 0,
            ordered: true,
            strategic: true,
            opportunistic: true,
            blocking: false,
            memory,
            sourceIdx,
            body: (budget) => {
                const available = Math.max(0, Math.min(cap, budget) - keep);
                const body = residualHarvesterBody(room, mem, sources, sourceIdx, available, workNeeded);
                return body.length && bodyCost(body) + keep <= budget ? body : [];
            },
            finalize: (body, creepMemory) => { if (bodyPartCount(body, 'carry') === 0) creepMemory.staticMiner = true; },
        });
    }
    return requests;
}

function scheduleHandoffs(room, requests, remoteDemands, allSpawns, settings, context) {
    const initial = queue.schedule(requests, context);
    if (initial.actions.length < context.spawnsFree || !initial.actions.length) return initial;
    const releases = initial.actions.map((action) => action.body.length * 3);
    for (const spawn of allSpawns) if (spawn.spawning) releases.push(spawn.spawning.remainingTime);
    const blockingTicks = Math.min(...releases);
    const handoffs = remote.reserverHandoffs(room, remoteDemands, blockingTicks);
    const additions = [];
    for (const item of handoffs) {
        if (requests.some((request) => request.item && request.item.slot === item.slot)) continue;
        if (bodyCost(item.body) > context.energy) continue;
        const request = demandRequest(room, item, 'remoteMaintain', settings, { opportunistic: true, jumpable: true });
        request.handoffBlockingTicks = blockingTicks;
        request.handoffCandidate = initial.actions.map((action) => ({ role: action.request.role, parts: action.body.length, cost: action.cost }));
        additions.push(request);
    }
    if (!additions.length) return initial;
    return queue.schedule(additions.concat(requests), context);
}

function run(room) {
    phaseBegin();
    try {
        runQueue(room);
    } finally {
        lap('exec');
        phaseOn = false;
    }
}

function runQueue(room) {
    const mem = Memory.rooms[room.name] || {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = mem;
    const sources = layout.resolveSources(room, mem, mem.plan);
    const state = roomState(room, mem, sources);
    const settings = queueSettings();
    updateSpawnIncome(room, mem, settings);
    const allSpawns = room.find(FIND_MY_SPAWNS);
    try { releaseStalledSpawns(room, mem, allSpawns); } catch (error) { logErr('spawn.releaseStalledSpawns ' + room.name, error); }
    try { spawnExit.markPocketTrapped(room, mem, allSpawns); } catch (error) { logErr('spawnExit.markPocketTrapped ' + room.name, error); }
    const hostilePause = utils.spawnPausedByHostile(room);
    if (hostilePause > 0) {
        mem.spawnQueue = { at: Game.time, paused: 'hostile', hostiles: hostilePause };
        delete mem.spawnWaiting;
        lap('pre');
        return;
    }
    const idle = allSpawns.filter((s) => !s.spawning);
    lap('pre');
    if (!idle.length) {
        const interval = Math.max(1, Math.floor(Number(queueSettings().busyDemandInterval) || 1));
        if (interval > 1 && !utils.isRoomPhaseTick(room.name, interval)) {
            try { upgraderTarget(room, mem); } catch (error) { logErr('spawn.upgraderTarget ' + room.name, error); }
            mem.spawnQueue = { at: Game.time, busy: true };
            if (mem.demand) mem.demand.skipped = (mem.demand.skipped || 0) + 1;
            lap('busy');
            return;
        }
    }
    const quietInterval = Math.max(1, Math.floor(Number(queueSettings().quietDemandInterval) || 1));
    const quiet = mem.spawnQuiet;
    if (idle.length && quietInterval > 1 && quiet && Number(quiet.at) <= Game.time && Game.time - Number(quiet.at) < quietInterval &&
        !utils.isRoomPhaseTick(room.name, quietInterval) && !state.recovering && state.readyWorkers > 0 &&
        !(room.find(FIND_HOSTILE_CREEPS) || []).length) {
        try { upgraderTarget(room, mem); } catch (error) { logErr('spawn.upgraderTarget ' + room.name, error); }
        mem.spawnQueue = Object.assign({}, mem.spawnQueue, { at: Game.time, idle: idle.length, quiet: true });
        if (mem.demand) mem.demand.quietSkipped = (mem.demand.quietSkipped || 0) + 1;
        lap('quiet');
        return;
    }
    const waitingHead = mem.spawnWaiting;
    const baseWait = Math.max(1, Math.floor(Number(queueSettings().waitingDemandInterval) || 1));
    const starved = Number((room.storage && room.storage.store[RESOURCE_ENERGY]) || 0) < Number(queueSettings().starvedStorage || 2000);
    const waitInterval = starved && waitingHead ?
        Math.max(baseWait, Math.min(Number(queueSettings().starvedWaitInterval) || 25, Math.floor(Number(waitingHead.eta) || 0))) : baseWait;
    const lastQueue = mem.spawnQueue || {};
    if (idle.length && waitInterval > 1 && waitingHead && Number(waitingHead.at) <= Game.time &&
        Game.time - Number(waitingHead.at) < waitInterval && room.energyAvailable < Number(waitingHead.cost) &&
        !(lastQueue.spawned && lastQueue.spawned.length) &&
        (waitInterval > baseWait || !utils.isRoomPhaseTick(room.name, waitInterval)) && !state.recovering && state.readyWorkers > 0 &&
        !(room.find(FIND_HOSTILE_CREEPS) || []).length) {
        try { upgraderTarget(room, mem); } catch (error) { logErr('spawn.upgraderTarget ' + room.name, error); }
        if (mem.demand) mem.demand.waitSkipped = (mem.demand.waitSkipped || 0) + 1;
        lap('quiet');
        return;
    }
    mem.spawnQuiet = null;
    const survival = config.survival[room.controller.level] || {};
    const sourceHarvesters = coreHarvesterTarget(room, sources);
    const plannedCounts = {};
    for (const role of PRIORITY) plannedCounts[role] = countPlannedRole(room, role);
    lap('counts');
    const defenseDemands = idle.length ? defense.getDemands(room) : [];
    const expansionDemands = idle.length && !state.recovering ? expansion.getDemands(room) : [];
    const aidDemands = idle.length && !state.recovering ? aid.getDemands(room) : [];
    const remoteOnly = idle.length && !state.recovering ? remote.getDemands(room) : [];
    const conquestDemands = idle.length && !state.recovering ? conquest.getDemands(room) : [];
    let depositDemands = [];
    if (idle.length && !state.recovering) { try { depositDemands = depositMod.getDemands(room); } catch (e) { utils.logErr('deposit.getDemands', e); } }
    let breachDemands = [];
    if (idle.length && !state.recovering) { try { breachDemands = wallBreach.getDemands(room); } catch (e) { utils.logErr('wall_breach.getDemands', e); } }
    const remoteDemands = defenseDemands.concat(expansionDemands, aidDemands, remoteOnly, conquestDemands);
    lap('demands');
    const builderBacklog = constructionBacklog(room);
    lap('backlog');
    const targets = {
        harvester: targetFor(room, 'harvester', mem, sources),
        hauler: targetFor(room, 'hauler', mem, sources),
        upgrader: targetFor(room, 'upgrader', mem, sources),
        builder: targetFor(room, 'builder', mem, sources, builderBacklog),
        feeder: targetFor(room, 'feeder', mem, sources),
        operator: targetFor(room, 'operator', mem, sources),
        mineralMiner: targetFor(room, 'mineralMiner', mem, sources),
        labTech: targetFor(room, 'labTech', mem, sources),
        scout: targetFor(room, 'scout', mem, sources),
    };
    lap('targets');
    const baseUpgraders = Math.max(0, Number((config.roster[room.controller.level] || {}).upgrader || 0));
    const containersMissing = coreContainerGap(room, mem, sources) > 0;
    if (containersMissing) {
        targets.builder = Math.max(1, Number(targets.builder) || 0);
        const seen = mem.containerGapBuilder || {};
        mem.containerGapBuilder = { at: Game.time, recovering: !!state.recovering, n: (Number(seen.n) || 0) + 1 };
    }
    const wallGap = require('wallfix').needsWorker(room);
    if (wallGap) {
        targets.builder = Math.max(1, Number(targets.builder) || 0);
        mem.wallFixBuilder = { at: Game.time };
    }
    const surge = require('wallfix').builderSurge(room);
    if (surge > 0) targets.builder = surge;
    const survivalTargets = {
        harvester: Math.min(survival.harvester || 0, sourceHarvesters) || sourceHarvesters,
        hauler: Math.min(survival.hauler || 0, targets.hauler),
        upgrader: (state.recovering || containersMissing) ? 0 : Math.min(survival.upgrader || 0, targets.upgrader),
    };
    const assignStats = harvesterAssignmentStats(room, sources);
    const uncoveredSources = assignStats.filter((stat) => !stat.count).length;
    const coverIdx = idle.length ? assignStats.findIndex((stat) => stat.count > 0 && stat.spawning === stat.count) : -1;
    if (coverIdx >= 0) {
        const seenCover = mem.harvesterSpawnCover || {};
        mem.harvesterSpawnCover = { at: Game.time, src: coverIdx, idle: idle.length, n: (Number(seenCover.n) || 0) + 1 };
    }
    if (uncoveredSources > 0 && !state.recovering) {
        survivalTargets.harvester = Math.max(survivalTargets.harvester, plannedCounts.harvester + uncoveredSources);
    }
    writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);
    lap('write');
    if (!idle.length) {
        mem.spawnQueue = { at: Game.time, busy: true };
        return;
    }

    const assignedHarvesterSources = {};
    let energyBudget = room.energyAvailable;
    if (state.readyWorkers === 0 &&
        plannedCounts.hauler > 0 &&
        energyBudget >= config.recovery.emergencyDropMinerAt &&
        energyBudget < config.recovery.emergencyHarvestBelow) {
        const body = ['work', 'move'];
        const name = creepName('harvester', 'drop');
        const sourceIdx = assignHarvesterSource(room, mem, assignedHarvesterSources, sources);
        const memory = { home: room.name, role: 'harvester', sourceIdx, dropMiner: true };
        if (sources[sourceIdx]) memory.sourceId = sources[sourceIdx].id;
        if (idle[0].spawnCreep(body, name, spawnOptions(idle[0], memory)) === OK) {
            recordSpawnSpend(room, mem, bodyCost(body));
            plannedCounts.harvester++;
            writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);
            return;
        }
    }

    const requests = [];
    const slotCounts = {};
    const unmet = (item) => {
        if (slotCounts[item.slot] == null) slotCounts[item.slot] = countPlannedDemand(room, item);
        return slotCounts[item.slot] < 1 && item.body && item.body.length;
    };
    for (const item of defenseDemands) {
        if (!unmet(item)) continue;
        const cls = item.cls === 'remoteMaintain' ? 'remoteMaintain' : 'defense';
        requests.push(demandRequest(room, item, cls, settings, {
            strategic: cls === 'defense',
            jumpable: cls !== 'defense',
            blocking: false,
            onSpawn: () => {
                const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
                log.spawned += 1;
                log.lastAt = Game.time;
                log.lastSlot = item.slot;
            },
        }));
    }
    for (const request of coreRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, baseUpgraders, settings)) {
        request.onSpawn = () => {
            plannedCounts[request.role]++;
            if (request.role === 'harvester') {
                assignedHarvesterSources[request.sourceIdx] = (assignedHarvesterSources[request.sourceIdx] || 0) + 1;
            }
        };
        requests.push(request);
    }
    const income = incomeEstimate(room, mem, state, sources, settings);
    for (const request of replacementReserveRequests(room, mem, state, sources, settings, income)) requests.push(request);
    if (state.readyWorkers !== 0) {
        for (const item of expansionDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'expansion', settings, { strategic: true }));
        for (const item of aidDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'aid', settings, { strategic: item.strategic !== false }));
        for (const item of remoteOnly.filter((d) => d.starvedLine).concat(remoteOnly.filter((d) => !d.starvedLine))) if (unmet(item)) requests.push(demandRequest(room, item, item.maintain ? 'remoteMaintain' : 'remote', settings, { jumpable: true }));
        for (const item of conquestDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'conquest', settings, { jumpable: true, blocking: false }));
        for (const item of depositDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'opportunistic', settings, { jumpable: true, blocking: false, opportunistic: true }));
        for (const item of breachDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'remote', settings, { jumpable: true, blocking: false }));
    }
    const upgrading = new Set();
    for (const request of harvesterUpgradeRequests(room, state, mem, sources, settings)) {
        upgrading.add(request.sourceIdx);
        requests.push(request);
    }
    for (const request of elasticHarvesterRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, settings, upgrading)) {
        request.onSpawn = () => {
            plannedCounts.harvester++;
            assignedHarvesterSources[request.sourceIdx] = (assignedHarvesterSources[request.sourceIdx] || 0) + 1;
        };
        requests.push(request);
    }
    if (state.readyWorkers !== 0 && !state.recovering) {
        for (const request of demandUpgradeRequests(room, remoteOnly.filter((item) => !unmet(item)), settings)) requests.push(request);
    }
    for (const request of requests) {
        if (request.item) {
            const item = request.item;
            const previous = request.onSpawn;
            request.onSpawn = (...args) => {
                slotCounts[item.slot] = (slotCounts[item.slot] || 0) + 1;
                if (previous) previous(...args);
            };
        }
    }
    const previousSince = mem.spawnSince || {};
    const since = {};
    for (const request of requests) since[request.key] = previousSince[request.key] != null ? previousSince[request.key] : Game.time;
    mem.spawnSince = since;
    lap('requests');
    const result = scheduleHandoffs(room, requests, remoteOnly, allSpawns, settings, {
        now: Game.time,
        energy: energyBudget,
        capacity: room.energyCapacityAvailable,
        income,
        spawnsFree: idle.length,
        busySpawnTimes: allSpawns.filter((spawn) => spawn.spawning).map((spawn) => spawn.spawning.remainingTime),
        since,
        minShare: settings.minShare,
        survivalShrinkAfter: settings.survivalShrinkAfter,
    });

    lap('schedule');
    if (!(income > 0) && result.waiting && energyBudget >= 200) {
        const head = requests.find((request) => request.key === result.waiting.key);
        if (head && !head.vital && !(head.reserve > 0)) {
            const seen = mem.zeroIncomeHeld || {};
            mem.zeroIncomeHeld = { at: Game.time, key: head.key, energy: energyBudget, n: (Number(seen.n) || 0) + 1 };
        }
    }

    const usedSpawns = new Set();
    const spawnedKeys = [];
    const freeSpawns = idle.slice();
    for (const action of result.actions) {
        const spawn = freeSpawns.shift();
        if (!spawn) break;
        const request = action.request;
        const memory = Object.assign({}, request.memory);
        if (request.finalize) request.finalize(action.body, memory);
        const name = creepName(request.role, request.tag);
        const ret = spawn.spawnCreep(action.body, name, spawnOptions(spawn, memory));
        if (ret === OK) {
            energyBudget -= action.cost;
            recordSpawnSpend(room, mem, action.cost);
            usedSpawns.add(spawn);
            spawnedKeys.push(request.key);
            const spawnLog = mem.spawnLog || (mem.spawnLog = []);
            spawnLog.push({ t: Game.time, key: request.key, cost: action.cost, scaled: !!action.scaled });
            if (spawnLog.length > 10) spawnLog.shift();
            if (!mem.spawnFirst) mem.spawnFirst = spawnLog[spawnLog.length - 1];
            if (request.handoffBlockingTicks) mem.reserveHandoff = {
                at: Game.time, name, remoteRoom: request.memory.remoteRoom,
                blockedTicks: request.handoffBlockingTicks, lead: request.item.lead, candidates: request.handoffCandidate,
            };
            if (request.onSpawn) request.onSpawn(memory, name);
            continue;
        }
        if (ret !== ERR_BUSY && ret !== ERR_NOT_ENOUGH_ENERGY) {
            logErr('spawn.queue ' + room.name, new Error('spawnCreep ' + ret + ' ' + request.key));
        }
    }
    const waiting = result.waiting;
    mem.spawnWaiting = waiting ? {
        cost: waiting.cost,
        at: Game.time,
        since: waiting.since,
        eta: waiting.eta,
        key: waiting.key,
        role: waiting.role,
    } : null;
    mem.spawnQueue = {
        at: Game.time,
        idle: idle.length,
        requests: requests.length,
        income: Math.round(income * 10) / 10,
        spawned: spawnedKeys,
        reserved: result.reserved,
        blocked: result.blocked.length,
        waiting: waiting ? { key: waiting.key, cost: waiting.cost, eta: waiting.eta, waited: Game.time - waiting.since } : null,
    };
    writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);

    const pending = requests.some((request) => !request.opportunistic && !request.reserve && !spawnedKeys.includes(request.key));
    if (pending) return;
    let bodyUpgraded = false;
    if (room.energyAvailable >= room.energyCapacityAvailable) {
        for (const spawn of idle) {
            if (usedSpawns.has(spawn)) continue;
            const upgrade = tryBodyUpgrade(room, spawn, state, mem, sources, energyBudget);
            if (upgrade) {
                energyBudget -= upgrade.cost;
                usedSpawns.add(spawn);
                bodyUpgraded = true;
            }
        }
        writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);
    }
    if (!requests.length && !spawnedKeys.length && !bodyUpgraded) mem.spawnQuiet = { at: Game.time };
}

module.exports = { run, cpuDigest, retireReplaced, spawnDirections, releaseStalledSpawns, constructionBacklog, builderTarget, roleLead, upgraderBody, upgraderTarget, upgraderLowMode, countReadyRole, averageHaulerCarry, countPlannedDemand, feederTarget, feederBody, operatorTarget, operatorBody, labTechTarget, labTechBody, updateSpawnIncome, coreHaulerCarry, spawnSpendRate, bodyImproves };
