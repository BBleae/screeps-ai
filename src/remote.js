'use strict';

const config = require('config');
const brain = require('brain');
const wheelLayout = require('wheel_layout');
const defense = require('defense');
const movement = require('movement');
const { logErr, bodyCost, bodyPartCount, roomCoords, roomDistance, isRetiring, roomPhase, creepsHomeRole, removeSite } = require('utils');

function positiveSetting(name, fallback) {
    const value = config.remote && config.remote[name];
    return typeof value === 'number' && value > 0 ? value : fallback;
}

const HOSTILE_COOLDOWN = positiveSetting('hostileSuspend', 150);
const RESERVATION_BUFFER = positiveSetting('reservationBuffer', 25);
const DEMAND_BUFFER = 100;
const SPAWN_TICKS_PER_PART = typeof CREEP_SPAWN_TIME === 'number' ? CREEP_SPAWN_TIME : 3;
const MAX_REMOTE_SITES = 6;
const MIN_RESIDUAL_CARRY = 4;
const INFRA_INTERVAL = positiveSetting('roadSiteInterval', 11);
const INFRA_REFRESH = 25;
const MEMORY_VERSION = 1;
const DISTANCE_VERSION = 3;

const ATTACK_PART = typeof ATTACK === 'undefined' ? 'attack' : ATTACK;
const RANGED_ATTACK_PART = typeof RANGED_ATTACK === 'undefined' ? 'ranged_attack' : RANGED_ATTACK;
const HEAL_PART = typeof HEAL === 'undefined' ? 'heal' : HEAL;
const WORK_PART = typeof WORK === 'undefined' ? 'work' : WORK;
const CLAIM_PART = typeof CLAIM === 'undefined' ? 'claim' : CLAIM;
const INVADER_CORE = typeof STRUCTURE_INVADER_CORE === 'undefined' ? 'invaderCore' : STRUCTURE_INVADER_CORE;
const CREEP_LIFE = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
const CLAIM_LIFE = typeof CREEP_CLAIM_LIFE_TIME === 'number' ? CREEP_CLAIM_LIFE_TIME : 600;

function sourceRecord(raw) {
    const pos = raw && raw.pos || {};
    const spot = raw && raw.spot || null;
    return {
        id: raw && raw.id || null,
        pos: { x: pos.x || 0, y: pos.y || 0 },
        spot: spot ? { x: spot.x, y: spot.y } : null,
        distance: raw && raw.distance || 0,
        distanceVersion: raw && raw.distanceVersion || 0,
        distanceIncomplete: !!(raw && raw.distanceIncomplete),
        distanceAt: raw && raw.distanceAt || 0,
        energyCapacity: raw && raw.energyCapacity || 0,
        containerId: raw && raw.containerId || null,
        road: raw && raw.road || '',
        routePlanAt: raw && raw.routePlanAt || 0,
        roadComplete: !!(raw && raw.roadComplete),
    };
}

function remoteRecord(roomName, raw) {
    raw = raw || {};
    let sources = [];
    if (Array.isArray(raw.sources)) sources = raw.sources.map(sourceRecord);
    else if (raw.sources && typeof raw.sources === 'object') sources = Object.values(raw.sources).map(sourceRecord);
    const reservation = raw.reservation || {};
    return {
        room: roomName,
        enabled: raw.enabled !== false,
        sourceCount: raw.sourceCount || (typeof raw.sources === 'number' ? raw.sources : sources.length),
        lastSeen: raw.lastSeen || 0,
        suspendedUntil: raw.suspendedUntil || 0,
        suspendReason: raw.suspendReason || null,
        clearReservation: raw.clearReservation === true,
        unreachableCount: raw.unreachableCount || 0,
        unreachableAt: raw.unreachableAt || 0,
        controllerId: raw.controllerId || null,
        controllerPos: raw.controllerPos || null,
        controllerDistance: raw.controllerDistance || 0,
        controllerDistanceVersion: raw.controllerDistanceVersion || 0,
        controllerDistanceIncomplete: !!raw.controllerDistanceIncomplete,
        controllerDistanceAt: raw.controllerDistanceAt || 0,
        reservation: {
            username: reservation.username || null,
            ticksToEnd: reservation.ticksToEnd || 0,
            seenAt: reservation.seenAt || 0,
        },
        sources,
        infrastructureComplete: !!raw.infrastructureComplete,
        drop: raw.drop || null,
        sk: !!raw.sk,
        lairs: raw.lairs == null ? null : Number(raw.lairs),
    };
}

const KEEPER_OWNER = 'Source Keeper';

function skSettings() {
    return Object.assign({ enabled: false, minRcl: 7, maxRoomsPerHome: 1, reaperUnits: 12, reaperMinUnits: 9,
        keeperSafeRange: 4, reaperStandoff: 3, lairWarnTicks: 10, minerWork: 7,
        maxReaperLosses: 2, lossWindow: 3000, lossCooldown: 5000 }, config.sk || {});
}

function skEnabled(homeName) {
    const order = brain.get(homeName, 'skMining', undefined);
    if (typeof order === 'boolean') return order;
    return skSettings().enabled === true;
}

function skAllowed(home) {
    if (!home || !home.controller || !skEnabled(home.name)) return false;
    return (home.controller.level || 0) >= Math.max(1, Number(skSettings().minRcl) || 7);
}

function skWhitelisted(homeName, roomName) {
    const whitelist = remoteWhitelist(homeName);
    return Array.isArray(whitelist) && whitelist.includes(roomName);
}

function isKeeper(creep) {
    return !!(creep && creep.owner && creep.owner.username === KEEPER_OWNER);
}

function skReaperBody(capacity) {
    const cfg = skSettings();
    const units = Math.min(Math.max(1, Number(cfg.reaperUnits) || 12), 12, Math.floor((capacity || 0) / 500));
    if (units < Math.max(1, Number(cfg.reaperMinUnits) || 9)) return [];
    return repeat('ranged_attack', units).concat(repeat('move', units * 2), repeat('heal', units));
}

function skMinerBody(capacity, roadComplete) {
    const cap = capacity || 0;
    const halfMove = roadComplete !== false;
    const maxWork = Math.max(1, Number(skSettings().minerWork) || 7);
    for (let work = maxWork; work >= 2; work--) {
        const move = halfMove ? Math.ceil((work + 1) / 2) : work + 1;
        if (work * 100 + 50 + move * 50 <= cap) return repeat('work', work).concat(['carry'], repeat('move', move));
    }
    return [];
}

function reaperOnStation(homeName, roomName) {
    return creepsHomeRole(homeName, 'skReaper').some((creep) => !creep.spawning && !isRetiring(creep.memory) &&
        creep.memory.remoteRoom === roomName && creep.room && creep.room.name === roomName);
}

function ringTile(room, center, range, from) {
    if (!room || !center) return null;
    const terrain = typeof room.getTerrain === 'function' ? room.getTerrain() : null;
    const wall = typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : 1;
    let best = null;
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
            const x = center.x + dx;
            const y = center.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain && (terrain.get(x, y) & wall)) continue;
            if (room.lookForAt(LOOK_STRUCTURES, x, y).some((structure) => structure.structureType !== STRUCTURE_ROAD &&
                structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART)) continue;
            const distance = from ? Math.max(Math.abs(from.x - x), Math.abs(from.y - y)) : 0;
            if (!best || distance < best.distance) best = { x, y, distance };
        }
    }
    return best ? new RoomPosition(best.x, best.y, room.name) : null;
}

function keeperThreatFor(creep) {
    if (!creep || !creep.room || !creep.pos || creep.room.name !== creep.memory.remoteRoom) return null;
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (!record || !record.sk) return null;
    const cfg = skSettings();
    const range = Math.max(1, Number(cfg.keeperSafeRange) || 4);
    const warn = Math.max(0, Number(cfg.lairWarnTicks) || 0);
    let closest = null;
    const consider = (pos, kind) => {
        const distance = Math.max(Math.abs(creep.pos.x - pos.x), Math.abs(creep.pos.y - pos.y));
        if (distance > range) return;
        if (!closest || distance < closest.distance) closest = { pos, kind, distance };
    };
    for (const hostile of creep.room.find(FIND_HOSTILE_CREEPS)) if (isKeeper(hostile) && hostile.pos) consider(hostile.pos, 'keeper');
    if (warn > 0) {
        for (const structure of creep.room.find(FIND_STRUCTURES)) {
            if (structure.structureType !== STRUCTURE_KEEPER_LAIR || structure.ticksToSpawn == null) continue;
            if (structure.ticksToSpawn <= warn) consider(structure.pos, 'lair');
        }
    }
    return closest;
}

function keeperRetreat(creep) {
    const threat = keeperThreatFor(creep);
    if (!threat) return false;
    const safe = Math.max(1, Number(skSettings().keeperSafeRange) || 4) + 1;
    const spot = ringTile(creep.room, threat.pos, safe, creep.pos);
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (record) record.skRetreat = { at: Game.time, kind: threat.kind, n: (Number(record.skRetreat && record.skRetreat.n) || 0) + 1 };
    if (spot) movement.go(creep, spot, { range: 0, reusePath: 3 });
    return true;
}

function noteSkHarvest(creep, result) {
    if (result !== OK || !creep || !creep.memory) return;
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (!record || !record.sk) return;
    const log = record.skHarvest || (record.skHarvest = { first: Game.time, n: 0 });
    log.n = (Number(log.n) || 0) + 1;
    log.at = Game.time;
}

function noteReaperLoss(name, memory) {
    if (!memory || memory.role !== 'skReaper' || isRetiring(memory)) return false;
    if (!(Number(memory.lastTtl) > 5)) return false;
    const record = getRemote(memory.home, memory.remoteRoom);
    if (!record || !record.sk || record.enabled === false || Number(record.suspendedUntil) === Number.MAX_SAFE_INTEGER) return false;
    const cfg = skSettings();
    const log = record.skLosses && Game.time - Number(record.skLosses.at || 0) <= Number(cfg.lossWindow || 3000)
        ? record.skLosses : { n: 0 };
    log.n = (Number(log.n) || 0) + 1;
    log.at = Game.time;
    log.last = name;
    record.skLosses = log;
    if (log.n >= Math.max(1, Number(cfg.maxReaperLosses) || 2)) {
        record.suspendedUntil = Math.max(Number(record.suspendedUntil) || 0, Game.time + Math.max(1, Number(cfg.lossCooldown) || 5000));
        record.suspendReason = 'skReaperLost';
        log.n = 0;
        log.suspendedAt = Game.time;
    }
    return true;
}

function syncKeeperRooms(home, remotes) {
    const allowed = skAllowed(home);
    const limit = Math.max(0, Number(skSettings().maxRoomsPerHome) || 0);
    let count = 0;
    for (const roomName in remotes) {
        const record = remotes[roomName];
        if (!record || !record.sk) continue;
        if (allowed && skWhitelisted(home.name, roomName) && count < limit) { count++; continue; }
        record.sk = false;
        record.enabled = false;
        record.suspendReason = 'keeperRoom';
        record.suspendedUntil = Number.MAX_SAFE_INTEGER;
    }
    if (!allowed) return;
    for (const roomName in remotes) {
        if (count >= limit) break;
        const record = remotes[roomName];
        if (!record || record.sk || !(record.lairs > 0) || record.suspendReason !== 'keeperRoom') continue;
        if (!skWhitelisted(home.name, roomName) || !withinDistance(home.name, roomName)) continue;
        record.sk = true;
        record.enabled = true;
        record.suspendedUntil = 0;
        record.suspendReason = null;
        count++;
    }
}

function homeMemory(homeName) {
    Memory.rooms = Memory.rooms || {};
    const mem = Memory.rooms[homeName] || (Memory.rooms[homeName] = {});
    const raw = mem.remotes;
    if (Array.isArray(raw)) {
        const migrated = {};
        for (const item of raw) {
            const roomName = typeof item === 'string' ? item : item && item.room;
            if (roomName) migrated[roomName] = remoteRecord(roomName, item);
        }
        mem.remotes = migrated;
    } else if (!raw || typeof raw !== 'object') {
        mem.remotes = {};
    } else if (mem.remoteMemoryVersion !== MEMORY_VERSION) {
        for (const roomName in raw) raw[roomName] = remoteRecord(roomName, raw[roomName]);
    }
    mem.remoteMemoryVersion = MEMORY_VERSION;
    return mem;
}

function homeNameOf(home) {
    return typeof home === 'string' ? home : home && home.name;
}

function getRemote(home, remoteRoom) {
    const homeName = homeNameOf(home);
    if (!homeName || !Memory.rooms || !Memory.rooms[homeName]) return null;
    const remotes = homeMemory(homeName).remotes;
    return remotes[remoteRoom] || null;
}

function getSource(home, remoteRoom, sourceId, sourceIdx) {
    const record = getRemote(home, remoteRoom);
    if (!record) return null;
    if (sourceId) {
        const exact = record.sources.find((source) => source.id === sourceId);
        if (exact) return exact;
    }
    if (sourceIdx != null && record.sources[sourceIdx]) return record.sources[sourceIdx];
    return record.sources[0] || null;
}

function myUsername(home) {
    return home && home.controller && home.controller.owner && home.controller.owner.username || null;
}

function activeParts(creep, type) {
    if (creep.getActiveBodyparts) return creep.getActiveBodyparts(type);
    let count = 0;
    for (const part of creep.body || []) {
        if ((part.type || part) === type && (part.hits == null || part.hits > 0)) count++;
    }
    return count;
}

function threatReason(room, ignoreKeepers) {
    const dangerous = room.find(FIND_HOSTILE_CREEPS).some((creep) => {
        if (ignoreKeepers && isKeeper(creep)) return false;
        if (activeParts(creep, ATTACK_PART) > 0 || activeParts(creep, RANGED_ATTACK_PART) > 0 || activeParts(creep, HEAL_PART) > 0) return true;
        const owner = creep.owner && creep.owner.username;
        const npc = owner === 'Invader' || owner === 'Source Keeper';
        return npc && (activeParts(creep, WORK_PART) > 0 || activeParts(creep, CLAIM_PART) > 0);
    });
    if (dangerous) return 'hostileCreep';
    const core = room.find(FIND_STRUCTURES).some((structure) => structure.structureType === INVADER_CORE);
    return core ? 'invaderCore' : null;
}

function ownedByMe(roomName) {
    const room = Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my);
}

function expansionTarget(roomName) {
    for (const name in Memory.rooms || {}) {
        const expansion = Memory.rooms[name] && Memory.rooms[name].expansion;
        if (expansion && expansion.target === roomName) return true;
    }
    return false;
}

const exitCache = (typeof global !== 'undefined' ? global : {}).__remoteExitCache ||
    ((typeof global !== 'undefined' ? global : {}).__remoteExitCache = {});

function directExits(homeName) {
    let exits = exitCache[homeName];
    if (!exits) {
        exits = Game.map.describeExits(homeName) || {};
        exitCache[homeName] = exits;
    }
    return exits;
}

function cededRoom(roomName) {
    const list = config.remote && config.remote.ceded;
    return Array.isArray(list) && list.includes(roomName);
}

function remoteWhitelist(homeName) {
    const list = rawWhitelist(homeName);
    return Array.isArray(list) && list.some(cededRoom) ? list.filter((roomName) => !cededRoom(roomName)) : list;
}

function rawWhitelist(homeName) {
    const assign = config.remote && config.remote.assign;
    if (assign && Array.isArray(assign[homeName])) {
        const extra = breachUnlocked(homeName).filter((roomName) => !assign[homeName].includes(roomName));
        return extra.length ? assign[homeName].concat(extra) : assign[homeName];
    }
    return brain.get(homeName, 'remotes', null);
}

function breachUnlocked(homeName) {
    try { return require('wall_breach').unlockedRemotes(homeName); } catch (error) { return []; }
}

function assignedRoom(homeName, roomName) {
    const assign = config.remote && config.remote.assign;
    return !!(assign && Array.isArray(assign[homeName]) && (assign[homeName].includes(roomName) || breachUnlocked(homeName).includes(roomName)));
}

function canClearReservation(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !!(record && record.clearReservation && record.enabled !== false &&
        (record.suspendReason || '').indexOf('foreignReservation:') === 0);
}

function isAdjacent(homeName, roomName) {
    return Object.values(directExits(homeName)).includes(roomName);
}

function withinRange(homeName, roomName) {
    if (isAdjacent(homeName, roomName)) return true;
    const maxRange = Math.max(1, Number(config.remote && config.remote.maxRange) || 1);
    const whitelist = remoteWhitelist(homeName);
    return Array.isArray(whitelist) && whitelist.includes(roomName) && roomDistance(homeName, roomName) <= maxRange;
}

function withinDistance(homeName, roomName) {
    if (isAdjacent(homeName, roomName)) return true;
    const maxRange = Math.max(1, Number(config.remote && config.remote.maxRange) || 1);
    return roomDistance(homeName, roomName) <= maxRange;
}

function edgePosition(direction) {
    if (+direction === 1) return { x: 25, y: 49 };
    if (+direction === 3) return { x: 0, y: 25 };
    if (+direction === 5) return { x: 25, y: 0 };
    if (+direction === 7) return { x: 49, y: 25 };
    return null;
}

function exitEdgePosition(direction) {
    if (+direction === 1) return { x: 25, y: 0 };
    if (+direction === 3) return { x: 49, y: 25 };
    if (+direction === 5) return { x: 25, y: 49 };
    if (+direction === 7) return { x: 0, y: 25 };
    return null;
}

function entryPosition(homeName, roomName) {
    const exits = directExits(homeName);
    for (const direction in exits) {
        if (exits[direction] !== roomName) continue;
        const edge = edgePosition(direction);
        if (edge) return edge;
    }
    if (Game.map && typeof Game.map.findRoute === 'function') {
        const route = Game.map.findRoute(roomName, homeName);
        if (Array.isArray(route) && route.length && route[0].exit != null) {
            const edge = exitEdgePosition(route[0].exit);
            if (edge) return edge;
        }
    }
    return { x: 25, y: 25 };
}

function walkableSpot(room, sourcePos, entry, taken) {
    let best = null;
    let bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = sourcePos.x + dx;
        const y = sourcePos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) continue;
        if (taken.has(x + '.' + y)) continue;
        const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
        if (structures.some((structure) => structure.structureType !== STRUCTURE_ROAD &&
            structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART)) continue;
        const score = Math.max(Math.abs(x - entry.x), Math.abs(y - entry.y));
        if (score < bestScore) {
            bestScore = score;
            best = { x, y };
        }
    }
    return best;
}

function anchorFor(home) {
    return home.storage || home.find(FIND_MY_SPAWNS)[0] || { pos: new RoomPosition(25, 25, home.name) };
}

function routeHops(from, to) {
    if (from === to) return 0;
    const route = Game.map && typeof Game.map.findRoute === 'function' ? Game.map.findRoute(from, to) : null;
    return Array.isArray(route) ? route.length : Infinity;
}

function storedEnergy(room) {
    const store = room && room.storage && room.storage.my !== false && room.storage.store;
    return store ? Number(store[RESOURCE_ENERGY] || 0) : 0;
}

function refreshDropRoom(home, record) {
    const spotSource = (record.sources || []).find((source) => source.spot);
    const target = spotSource ? new RoomPosition(spotSource.spot.x, spotSource.spot.y, record.room) : null;
    const homeHops = routeHops(record.room, home.name);
    const candidates = [{ room: home.name, hops: homeHops }];
    const richerMargin = positiveSetting('dropRicherMargin', 50000);
    const homeStored = storedEnergy(home);
    const skippedRicher = [];
    for (const candidate of Object.values(Game.rooms || {})) {
        if (!candidate.controller || !candidate.controller.my || candidate.name === home.name) continue;
        if (!candidate.storage && !candidate.find(FIND_MY_SPAWNS).length) continue;
        if (storedEnergy(candidate) - homeStored >= richerMargin) { skippedRicher.push(candidate.name); continue; }
        const hops = routeHops(record.room, candidate.name);
        if (hops <= homeHops) candidates.push({ room: candidate.name, hops });
    }
    let best = candidates[0];
    for (const candidate of candidates) {
        const room = Game.rooms[candidate.room];
        const estimate = {};
        candidate.distance = room && target ? routeLength(anchorFor(room).pos, target, candidate.hops + 1, 0, estimate) : null;
        candidate.incomplete = estimate.incomplete;
        if (candidate === best) continue;
        if (candidate.distance != null && (best.distance == null || (best.incomplete && !candidate.incomplete) ||
            (!!best.incomplete === !!candidate.incomplete && candidate.distance < best.distance))) best = candidate;
    }
    record.drop = { room: best.room, hops: best.hops, distance: best.room !== home.name ? (best.distance || null) : null, at: Game.time, distanceVersion: DISTANCE_VERSION };
    if (skippedRicher.length) record.drop.skippedRicher = skippedRicher;
}

function dropNeedsRefresh(home, record) {
    if (!record.drop) return true;
    if (record.drop.distanceVersion !== DISTANCE_VERSION) {
        return Game.time % INFRA_REFRESH === (roomPhase(home.name, INFRA_REFRESH) +
            roomPhase(record.room, INFRA_REFRESH)) % INFRA_REFRESH;
    }
    return Game.time - Number(record.drop.at || 0) >= positiveSetting('dropRefreshTicks', 500);
}

function dropRoom(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return (record && record.drop && record.drop.room) || homeNameOf(home);
}

function geometricDistance(from, to, range) {
    const a = roomCoords(from.roomName);
    const b = roomCoords(to.roomName);
    if (!a || !b) return 0;
    return Math.max(0, Math.max(Math.abs((b.x - a.x) * 50 + to.x - from.x),
        Math.abs((b.y - a.y) * 50 + to.y - from.y)) - (range || 0));
}

function searchRoomBudget(routeRooms) {
    return Number.isFinite(routeRooms) ? Math.min(64, Math.max(16, routeRooms)) : 16;
}

function routeLength(from, to, maxRooms, range, estimate) {
    const result = PathFinder.search(from, { pos: to, range: range || 0 }, {
        plainCost: 2,
        swampCost: 8,
        maxRooms: searchRoomBudget(maxRooms),
        maxOps: 10000,
    });
    if (estimate) estimate.incomplete = !!result.incomplete;
    if (!result.incomplete && result.path) return result.path.length;
    return Math.max(geometricDistance(from, to, range),
        50 + Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)));
}

function planRoute(home, room, spot) {
    const anchor = anchorFor(home);
    const target = new RoomPosition(spot.x, spot.y, room.name);
    const plan = Memory.rooms && Memory.rooms[home.name] && Memory.rooms[home.name].plan;
    const result = PathFinder.search(anchor.pos, { pos: target, range: 1 }, {
        plainCost: 2,
        swampCost: 8,
        maxRooms: searchRoomBudget(routeHops(home.name, room.name) + 1),
        maxOps: 10000,
        roomCallback: (roomName) => {
            const matrix = new PathFinder.CostMatrix();
            if (roomName === home.name && plan && plan.wheel) {
                for (const entry of wheelLayout.plannedEntries(plan)) {
                    if (entry.type === STRUCTURE_ROAD) matrix.set(entry.pos.x, entry.pos.y, 1);
                    else if (entry.type !== STRUCTURE_RAMPART && entry.type !== STRUCTURE_CONTAINER) matrix.set(entry.pos.x, entry.pos.y, 255);
                }
            }
            const visible = Game.rooms[roomName];
            if (visible) {
                for (const structure of visible.find(FIND_STRUCTURES)) {
                    if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
                }
            }
            return matrix;
        },
    });
    if (result.incomplete || !result.path || !result.path.length) return null;
    const byRoom = {};
    for (const pos of result.path) {
        if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) continue;
        if (pos.roomName === room.name && pos.x === spot.x && pos.y === spot.y) continue;
        (byRoom[pos.roomName] || (byRoom[pos.roomName] = [])).push(pos.x + '.' + pos.y);
    }
    const packedByRoom = {};
    for (const name in byRoom) packedByRoom[name] = byRoom[name].join(';');
    return packedByRoom;
}

function planRoad(room, entry, spot) {
    const start = new RoomPosition(entry.x, entry.y, room.name);
    const target = new RoomPosition(spot.x, spot.y, room.name);
    const result = PathFinder.search(start, { pos: target, range: 0 }, {
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
    });
    if (result.incomplete || !result.path) return '';
    return result.path
        .filter((pos) => pos.roomName === room.name && pos.x > 0 && pos.x < 49 && pos.y > 0 && pos.y < 49 &&
            (pos.x !== spot.x || pos.y !== spot.y))
        .map((pos) => pos.x + '.' + pos.y)
        .join(';');
}

function unpackRoad(packed) {
    if (!packed) return [];
    return packed.split(';').filter(Boolean).map((item) => {
        const parts = item.split('.');
        return { x: +parts[0], y: +parts[1] };
    });
}

function at(room, look, pos, type) {
    if (!pos) return null;
    return room.lookForAt(look, pos.x, pos.y).find((item) => item.structureType === type) || null;
}

function refreshInfrastructure(room, record) {
    let complete = record.sources.length > 0;
    for (const source of record.sources) {
        const container = at(room, LOOK_STRUCTURES, source.spot, STRUCTURE_CONTAINER);
        if (container) delete source.containerLostAt;
        else if (source.containerId) source.containerLostAt = Game.time;
        source.containerId = container ? container.id : null;
        const route = source.routeRoads;
        let roadComplete = !!route && Object.values(route).some((packed) => unpackRoad(packed).length > 0);
        if (roadComplete) {
            for (const name in route) {
                const visible = name === room.name ? room : Game.rooms[name];
                if (!visible) { roadComplete = false; break; }
                if (unpackRoad(route[name]).some((pos) => !at(visible, LOOK_STRUCTURES, pos, STRUCTURE_ROAD))) {
                    roadComplete = false;
                    break;
                }
            }
        }
        if (source.roadComplete && !roadComplete && !record.roadCoverageRepair) {
            record.roadCoverageRepair = { at: Game.time, source: source.id, reason: 'incompleteRoadCoverage' };
        }
        source.roadComplete = roadComplete;
        if (!container || !roadComplete) complete = false;
    }
    record.infrastructureComplete = complete;
}

function refreshVisible(home, record, room) {
    const now = Game.time;
    const username = myUsername(home);
    record.lastSeen = now;
    if (record.unreachableCount) record.unreachableCount = 0;
    const controller = room.controller;
    record.controllerId = controller && controller.id || null;
    record.controllerPos = controller ? { x: controller.pos.x, y: controller.pos.y } : null;

    if (controller && controller.owner && (!username || controller.owner.username !== username)) {
        record.enabled = false;
        record.suspendReason = 'foreignOwner:' + controller.owner.username;
        record.suspendedUntil = Number.MAX_SAFE_INTEGER;
    }

    const reservation = controller && controller.reservation;
    record.reservation = {
        username: reservation && reservation.username || null,
        ticksToEnd: reservation && reservation.ticksToEnd || 0,
        seenAt: now,
    };
    record.clearReservation = false;
    if (reservation && (!username || reservation.username !== username)) {
        record.suspendedUntil = Math.max(record.suspendedUntil, now + reservation.ticksToEnd + RESERVATION_BUFFER);
        record.suspendReason = 'foreignReservation:' + reservation.username;
        if (reservation.username === 'Invader' && !room.find(FIND_STRUCTURES).some((s) => s.structureType === INVADER_CORE)) {
            record.clearReservation = true;
        }
    } else if (String(record.suspendReason || '').indexOf('foreignReservation:') === 0) {
        record.suspendedUntil = 0;
        record.suspendReason = null;
    }

    if (record.lairs == null) {
        record.lairs = room.find(FIND_STRUCTURES)
            .filter((structure) => structure.structureType === STRUCTURE_KEEPER_LAIR).length;
    }
    const keeperLairs = record.lairs;
    if (keeperLairs > 0) {
        if (record.sk) {
            if (record.suspendReason === 'keeperRoom') {
                record.suspendReason = null;
                record.suspendedUntil = 0;
                record.enabled = true;
            }
        } else {
            record.enabled = false;
            record.suspendReason = 'keeperRoom';
            record.suspendedUntil = Number.MAX_SAFE_INTEGER;
        }
    }

    require('utils').notePvpThreat(room);
    const threat = threatReason(room, record.sk);
    if (threat) {
        record.suspendedUntil = Math.max(record.suspendedUntil, now + HOSTILE_COOLDOWN);
        record.suspendReason = threat;
        defense.recordThreat(record, defense.armedHostiles(room).filter((creep) => !(record.sk && isKeeper(creep))));
    } else if (record.enabled && (record.suspendedUntil <= now ||
        record.suspendReason === 'hostileCreep' || record.suspendReason === 'invaderCore')) {
        record.suspendedUntil = 0;
        record.suspendReason = null;
        record.threat = null;
    }

    const pvpRec = Memory.pvpThreat && Memory.pvpThreat[room.name];
    if (pvpRec && pvpRec.until > now) {
        record.suspendedUntil = Math.max(record.suspendedUntil || 0, pvpRec.until);
        record.suspendReason = 'pvpThreat:' + pvpRec.user;
    }

    const previous = {};
    for (const source of record.sources) if (source.id) previous[source.id] = source;
    const taken = new Set(record.sources.filter((source) => source.spot).map((source) => source.spot.x + '.' + source.spot.y));
    const entry = entryPosition(home.name, room.name);
    record.entry = { x: entry.x, y: entry.y };
    const anchor = anchorFor(home);
    const visibleSources = room.find(FIND_SOURCES).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const minSources = Math.max(1, Number(config.remote && config.remote.minSources) || 1);
    if (visibleSources.length < minSources) {
        record.enabled = false;
        record.suspendReason = 'sourceCount:' + visibleSources.length;
        record.suspendedUntil = Number.MAX_SAFE_INTEGER;
    }
    const next = [];
    for (const source of visibleSources) {
        const old = previous[source.id] || {};
        let spot = old.spot;
        if (!spot) spot = walkableSpot(room, source.pos, entry, taken);
        if (!spot) continue;
        taken.add(spot.x + '.' + spot.y);
        const target = new RoomPosition(spot.x, spot.y, room.name);
        const invalidDistance = old.distance && old.distance < geometricDistance(anchor.pos, target, 0);
        const needsDistance = invalidDistance || old.distanceVersion !== DISTANCE_VERSION || !old.distance ||
            (old.distanceIncomplete && now - (old.distanceAt || 0) >= INFRA_REFRESH);
        const estimate = {};
        const distance = !needsDistance && old.distance || routeLength(anchor.pos, target, routeHops(home.name, room.name) + 1, 0, estimate);
        if (needsDistance && old.distance && !record.distanceRepair) record.distanceRepair = { at: now, source: source.id, before: old.distance, after: distance };
        let routeRoads = old.routeRoads || null;
        const attemptRoute = !routeRoads && (!old.routePlanAt || now - old.routePlanAt >= INFRA_REFRESH);
        if (attemptRoute) routeRoads = planRoute(home, room, spot);
        const road = (routeRoads && routeRoads[room.name]) || old.road || (attemptRoute ? planRoad(room, entry, spot) : '');
        const nextSource = sourceRecord({
            id: source.id,
            pos: { x: source.pos.x, y: source.pos.y },
            spot,
            distance,
            distanceVersion: DISTANCE_VERSION,
            distanceIncomplete: needsDistance ? !!estimate.incomplete : !!old.distanceIncomplete,
            distanceAt: needsDistance ? now : old.distanceAt,
            energyCapacity: source.energyCapacity,
            containerId: old.containerId,
            road,
            routePlanAt: attemptRoute ? now : old.routePlanAt,
            roadComplete: old.roadComplete,
        });
        if (routeRoads) nextSource.routeRoads = routeRoads;
        if (old.haulNeed != null) nextSource.haulNeed = old.haulNeed;
        if (old.haulStops != null) nextSource.haulStops = old.haulStops;
        if (old.containerLostAt) nextSource.containerLostAt = old.containerLostAt;
        if (old.legs) nextSource.legs = old.legs;
        if (old.roadMismatch) nextSource.roadMismatch = old.roadMismatch;
        if (old.roadAdoptedAt) nextSource.roadAdoptedAt = old.roadAdoptedAt;
        if (old.roadReplan) nextSource.roadReplan = old.roadReplan;
        next.push(nextSource);
    }
    record.sources = next;
    record.sourceCount = next.length;

    if (controller && record.controllerPos) {
        const target = new RoomPosition(record.controllerPos.x, record.controllerPos.y, room.name);
        if (record.controllerDistanceVersion !== DISTANCE_VERSION || !record.controllerDistance || record.controllerDistance < geometricDistance(anchor.pos, target, 1) ||
            (record.controllerDistanceIncomplete && now - (record.controllerDistanceAt || 0) >= INFRA_REFRESH)) {
            const estimate = {};
            record.controllerDistance = routeLength(anchor.pos, target, routeHops(home.name, room.name) + 1, 1, estimate);
            record.controllerDistanceVersion = DISTANCE_VERSION;
            record.controllerDistanceIncomplete = !!estimate.incomplete;
            record.controllerDistanceAt = now;
        }
    }
    if (now % INFRA_REFRESH === roomPhase(room.name, INFRA_REFRESH) || !record.infrastructureComplete) {
        refreshInfrastructure(room, record);
    }
    return record;
}

function globalSiteCount() {
    return Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
}

function homeRemoteRoadSites(remotes) {
    let n = 0;
    for (const site of Object.values(Game.constructionSites || {})) {
        const record = site.structureType === STRUCTURE_ROAD && remotes && remotes[site.pos.roomName];
        if (record && record.enabled) n++;
    }
    return n;
}

function foreignRemoteRoadSites(remotes) {
    let n = 0;
    for (const site of Object.values(Game.constructionSites || {})) {
        const record = site.structureType === STRUCTURE_ROAD && remotes && remotes[site.pos.roomName];
        if (record && !record.enabled) n++;
    }
    return n;
}

function usedByAnotherHome(homeName, roomName) {
    for (const otherName in Memory.rooms || {}) {
        if (otherName === homeName) continue;
        const record = Memory.rooms[otherName] && Memory.rooms[otherName].remotes && Memory.rooms[otherName].remotes[roomName];
        if (record && record.enabled) return true;
    }
    return false;
}

function trimRemoteSites(homeName, roomName) {
    if (usedByAnotherHome(homeName, roomName)) return 0;
    let removed = 0;
    for (const site of Object.values(Game.constructionSites || {})) {
        if (!site.pos || site.pos.roomName !== roomName || site.structureType === STRUCTURE_SPAWN) continue;
        if (removeSite(site, 'remoteOff')) removed++;
    }
    return removed;
}

function yieldRoadSite(roomName, remotes) {
    const candidates = Object.values(Game.constructionSites || {}).filter((site) => site.structureType === STRUCTURE_ROAD && site.pos &&
        remotes && remotes[site.pos.roomName] && !(site.progress > 0));
    candidates.sort((left, right) => (left.pos.roomName === roomName ? 0 : 1) - (right.pos.roomName === roomName ? 0 : 1));
    for (const site of candidates) {
        if (removeSite(site, 'remoteYield')) return true;
    }
    return false;
}

function containerGap(remotes) {
    return Object.values(remotes || {}).some((record) => record && record.enabled && !(record.suspendedUntil > Game.time) &&
        (record.sources || []).some((source) => !source.containerId));
}

function pruneOrphanRoadSites(room, record) {
    const wanted = new Set();
    for (const homeName in Memory.rooms || {}) {
        const remotes = (Memory.rooms[homeName] || {}).remotes || {};
        for (const name in remotes) {
            const other = remotes[name];
            if (!other || !other.enabled) continue;
            for (const source of other.sources || []) {
                if (name === room.name) for (const pos of unpackRoad(source.road)) wanted.add(pos.x + '.' + pos.y);
                for (const pos of unpackRoad(source.routeRoads && source.routeRoads[room.name])) wanted.add(pos.x + '.' + pos.y);
            }
        }
    }
    let removed = 0;
    let lost = 0;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
        if (site.structureType !== STRUCTURE_ROAD || wanted.has(site.pos.x + '.' + site.pos.y)) continue;
        const progress = Number(site.progress) || 0;
        if (removeSite(site, 'orphanRoad')) { removed++; lost += progress; }
    }
    if (removed) {
        const log = record.orphanRoadSites || (record.orphanRoadSites = { n: 0, lost: 0 });
        log.at = Game.time;
        log.n = (Number(log.n) || 0) + removed;
        log.lost = (Number(log.lost) || 0) + lost;
    }
    return removed;
}

function noteRoadTrail(home, remoteRoom, sourceId, sourceIdx, packed) {
    const record = getRemote(home, remoteRoom);
    const source = record && getSource(home, remoteRoom, sourceId, sourceIdx);
    if (!source) return;
    const trail = unpackRoad(packed);
    const planned = unpackRoad(source.road);
    if (trail.length < 3 || !planned.length) return;
    for (let i = 1; i < trail.length; i++) {
        if (Math.max(Math.abs(trail[i].x - trail[i - 1].x), Math.abs(trail[i].y - trail[i - 1].y)) > 1) return;
    }
    const onPlan = new Set(planned.map((pos) => pos.x + '.' + pos.y));
    const matched = trail.filter((pos) => onPlan.has(pos.x + '.' + pos.y)).length;
    if (matched / trail.length >= positiveSetting('roadTrailMatchShare', 0.5)) {
        delete source.roadMismatch;
        return;
    }
    source.roadMismatch = (Number(source.roadMismatch) || 0) + 1;
    if (source.roadMismatch < positiveSetting('roadTrailLegs', 3)) return;
    delete source.roadMismatch;
    const adoptedAt = Number(source.roadAdoptedAt);
    if (Number.isFinite(adoptedAt) && Game.time - adoptedAt < positiveSetting('roadTrailCooldown', 1500)) return;
    const spot = source.spot || {};
    const seen = new Set();
    const adopted = [];
    for (let i = trail.length - 1; i >= 0; i--) {
        const pos = trail[i];
        const tag = pos.x + '.' + pos.y;
        if (seen.has(tag)) continue;
        seen.add(tag);
        if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) continue;
        if (pos.x === spot.x && pos.y === spot.y) continue;
        adopted.push(tag);
    }
    if (!adopted.length) return;
    if (source.roadReplan) {
        source.roadReplan.n = (Number(source.roadReplan.n) || 1) + 1;
        source.roadReplan.lastAt = Game.time;
        source.roadReplan.lastWas = planned.length;
        source.roadReplan.lastTiles = adopted.length;
    } else {
        source.roadReplan = { at: Game.time, was: planned.length, tiles: adopted.length, n: 1 };
    }
    source.roadAdoptedAt = Game.time;
    source.road = adopted.join(';');
    if (source.routeRoads) source.routeRoads[remoteRoom] = source.road;
    source.roadComplete = false;
}

function placeInfrastructure(room, record, remotes) {
    if (!record.enabled || record.suspendedUntil > Game.time) return;
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    for (const source of record.sources) {
        if (at(room, LOOK_STRUCTURES, source.spot, STRUCTURE_CONTAINER) ||
            at(room, LOOK_CONSTRUCTION_SITES, source.spot, STRUCTURE_CONTAINER)) continue;
        if (sites.length >= MAX_REMOTE_SITES || globalSiteCount() >= 100) {
            const cooldown = positiveSetting('roadYieldCooldown', 1500);
            const recent = Number.isFinite(Number(record.roadYieldAt)) && Game.time - Number(record.roadYieldAt) < cooldown;
            if (!recent && yieldRoadSite(room.name, remotes)) {
                record.roadSitesYielded = (Number(record.roadSitesYielded) || 0) + 1;
                record.roadYieldAt = Game.time;
            } else record.containerBlockedAt = Game.time;
            return;
        }
        if (room.createConstructionSite(source.spot.x, source.spot.y, STRUCTURE_CONTAINER) === OK) record.containerSiteAt = Game.time;
        return;
    }
    const homeCap = positiveSetting('roadSitesPerHome', 12);
    if ((sites.length >= MAX_REMOTE_SITES || homeRemoteRoadSites(remotes) >= homeCap) && pruneOrphanRoadSites(room, record) > 0) return;
    if (sites.length >= MAX_REMOTE_SITES) return;
    if (globalSiteCount() >= 100 - Math.max(0, Number(config.remoteContainerSiteReserve) || 0)) { record.roadsHeldAt = Game.time; return; }
    if (containerGap(remotes)) return;
    const mine = homeRemoteRoadSites(remotes);
    const others = foreignRemoteRoadSites(remotes);
    if (others > 0 || mine >= homeCap) record.roadQuota = { at: Game.time, mine, others, cap: homeCap };
    let budget = Math.min(MAX_REMOTE_SITES - sites.length, homeCap - mine);
    for (const source of record.sources) {
        for (const pos of unpackRoad(source.road)) {
            if (budget <= 0) return;
            if (at(room, LOOK_STRUCTURES, pos, STRUCTURE_ROAD) ||
                at(room, LOOK_CONSTRUCTION_SITES, pos, STRUCTURE_ROAD)) continue;
            const blocking = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y)
                .some((structure) => structure.structureType !== STRUCTURE_RAMPART);
            if (blocking) continue;
            if (room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD) === OK) budget--;
        }
    }
}

function candidatePool(home, neighbors) {
    const whitelist = remoteWhitelist(home.name);
    if (Array.isArray(whitelist)) return whitelist.filter((roomName) => withinRange(home.name, roomName));
    if (!Memory.map || !neighbors.every((roomName) => Memory.map[roomName])) return [];
    return neighbors;
}

function admitCandidates(home, remotes) {
    const level = home.controller && home.controller.level || 0;
    const maxRooms = config.remote && config.remote.maxRooms && config.remote.maxRooms[level] || 0;
    if (maxRooms <= 0) return;
    const neighbors = Object.values(directExits(home.name));
    const pool = candidatePool(home, neighbors);
    if (!pool.length || !Memory.map) return;
    const whitelisted = Array.isArray(remoteWhitelist(home.name));
    const limit = whitelisted ? Math.max(maxRooms, pool.length) : maxRooms;
    const selected = Object.values(remotes).filter((record) => record.enabled).length;
    if (selected >= limit) return;
    const username = myUsername(home);
    const skOk = skAllowed(home);
    const skLimit = Math.max(0, Number(skSettings().maxRoomsPerHome) || 0);
    let skCount = Object.values(remotes).filter((record) => record.sk && record.enabled).length;
    const candidates = pool
        .filter((roomName) => !remotes[roomName] && !ownedByMe(roomName) && !expansionTarget(roomName) && !cededRoom(roomName))
        .map((roomName) => ({ roomName, info: Memory.map[roomName] }))
        .filter((entry) => {
            const info = entry.info;
            const minSources = Math.max(1, Number(config.remote && config.remote.minSources) || 1);
            if (!info || !(info.sources >= minSources) || info.unreachable || info.owner) return false;
            const keeperRoom = info.lairs > 0;
            if (keeperRoom && !(skOk && skWhitelisted(home.name, entry.roomName))) return false;
            if (info.reservation && info.reservation.username && info.reservation.username !== username &&
                !(info.reservation.username === 'Invader' && assignedRoom(home.name, entry.roomName))) return false;
            const recentThreat = Game.time - (info.at || 0) <= HOSTILE_COOLDOWN &&
                (keeperRoom ? info.invaderCore : (info.armedHostiles > 0 || info.invaderCore || info.threat));
            return !recentThreat;
        })
        .sort((a, b) => b.info.sources - a.info.sources || a.roomName.localeCompare(b.roomName));
    let count = selected;
    for (const candidate of candidates) {
        if (count >= limit) break;
        const info = candidate.info;
        const keeperRoom = info.lairs > 0;
        if (keeperRoom && skCount >= skLimit) continue;
        if (keeperRoom) skCount++;
        remotes[candidate.roomName] = remoteRecord(candidate.roomName, {
            sk: keeperRoom,
            lairs: info.lairs == null ? null : info.lairs,
            sourceCount: info.sources,
            controllerId: info.controllerId,
            controllerPos: info.controllerPos,
            reservation: info.reservation ? {
                username: info.reservation.username,
                ticksToEnd: info.reservation.ticksToEnd,
                seenAt: info.at,
            } : null,
            sources: (info.sourceData || []).map((source) => ({
                id: source.id,
                pos: { x: source.x, y: source.y },
                energyCapacity: source.energyCapacity,
            })),
        });
        count++;
    }
}

function syncHomeRoads(home, mem) {
    const plan = Memory.rooms && Memory.rooms[home.name] && Memory.rooms[home.name].plan;
    if (!plan || !plan.wheel) return;
    plan.roads = plan.roads || {};
    const wanted = {};
    for (const roomName in mem.remotes) {
        const record = mem.remotes[roomName];
        if (!record || !record.enabled) continue;
        for (const source of record.sources || []) {
            const segment = source.routeRoads && source.routeRoads[home.name];
            if (segment) wanted['remote:' + roomName + ':' + source.id] = segment;
        }
    }
    for (const key of Object.keys(plan.roads)) {
        if (key.startsWith('remote:') && !wanted[key]) delete plan.roads[key];
    }
    for (const key in wanted) plan.roads[key] = wanted[key];
}

function run(home) {
    if (!home || !home.controller || !home.controller.my) return {};
    const mem = homeMemory(home.name);
    if (home.controller.level < config.remote.minRcl) return mem.remotes;
    for (const roomName in mem.remotes) if (ownedByMe(roomName)) delete mem.remotes[roomName];
    for (const roomName in mem.remotes) if (cededRoom(roomName)) delete mem.remotes[roomName];
    for (const roomName in mem.remotes) {
        const stale = mem.remotes[roomName];
        if (stale && stale.roadReplan) delete stale.roadReplan;
    }
    const whitelist = remoteWhitelist(home.name);
    if (Array.isArray(whitelist)) {
        for (const roomName in mem.remotes) {
            const record = mem.remotes[roomName];
            if (!whitelist.includes(roomName) && record.enabled) {
                record.enabled = false;
                record.suspendReason = 'notWhitelisted';
            } else if (whitelist.includes(roomName) && !record.enabled &&
                record.suspendedUntil !== Number.MAX_SAFE_INTEGER && withinRange(home.name, roomName)) {
                record.enabled = true;
                if (record.suspendedUntil <= Game.time) {
                    record.suspendedUntil = 0;
                    record.suspendReason = null;
                }
            }
        }
    }
    syncKeeperRooms(home, mem.remotes);
    applyAvoidHolds(home.name, mem.remotes);
    admitCandidates(home, mem.remotes);
    for (const roomName in mem.remotes) {
        const record = mem.remotes[roomName];
        if (!withinDistance(home.name, roomName)) {
            record.enabled = false;
            record.suspendReason = 'tooFar';
        }
        const infraTick = Game.time % INFRA_INTERVAL === roomPhase(roomName, INFRA_INTERVAL);
        if (!record.enabled) {
            if (infraTick) trimRemoteSites(home.name, roomName);
            continue;
        }
        try {
            if (dropNeedsRefresh(home, record)) refreshDropRoom(home, record);
        } catch (error) {
            logErr('remote.drop ' + home.name + '->' + roomName, error);
        }
        const room = Game.rooms[roomName];
        if (!room) continue;
        try {
            refreshVisible(home, record, room);
            if (infraTick) placeInfrastructure(room, record, mem.remotes);
        } catch (error) {
            logErr('remote.run ' + home.name + '->' + roomName, error);
        }
    }
    syncHomeRoads(home, mem);
    try { staffRemotes(home, mem); } catch (error) { logErr('remote.staff ' + home.name, error); }
    return mem.remotes;
}

function observe(home, room) {
    if (!home || !room) return null;
    const record = getRemote(home, room.name);
    if (!record || !withinDistance(home.name, room.name)) return record;
    if (record.lastSeen === Game.time) return record;
    return refreshVisible(home, record, room);
}

function noteTravel(creep) {
    const here = creep.room;
    if (here && here.controller && here.controller.my) {
        delete creep.memory._tp;
        delete creep.memory._ts;
        return false;
    }
    const posKey = creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y;
    if (creep.memory._tp === posKey) creep.memory._ts = (creep.memory._ts || 0) + 1;
    else { creep.memory._tp = posKey; creep.memory._ts = 0; }
    if (creep.memory._ts < config.remote.stuckTicks) return false;
    creep.memory._ts = 0;
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (!record) return false;
    record.enabled = false;
    record.suspendReason = 'unreachable';
    record.unreachableCount = (record.unreachableCount || 0) + 1;
    record.unreachableAt = Game.time;
    const base = Math.max(1, Number(config.remote.unreachableTicks) || 3000);
    const cap = Math.max(base, Number(config.remote.unreachableMaxTicks) || base * 8);
    record.suspendedUntil = Game.time + Math.min(cap, base * Math.pow(2, record.unreachableCount - 1));
    console.log('[remote] ' + creep.memory.home + ' → ' + creep.memory.remoteRoom + ' unreachable ×' + record.unreachableCount + ': ' + creep.name + ' stuck at ' + posKey +
        '，冷却 ' + (record.suspendedUntil - Game.time));
    return true;
}

function isUnreachable(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !!record && record.suspendReason === 'unreachable' && record.suspendedUntil > Game.time;
}

function isDisabled(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !record || record.enabled === false;
}

function isSuspended(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !record || !record.enabled || record.suspendedUntil > Game.time || require('utils').pvpDangerRoom(remoteRoom);
}

function suspensionLeft(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    if (!record) return 0;
    if (record.suspendedUntil === Number.MAX_SAFE_INTEGER) return Infinity;
    return Math.max(0, Number(record.suspendedUntil || 0) - Game.time);
}

function effectiveReservation(record, username) {
    const reservation = record && record.reservation;
    if (!reservation || !reservation.username || reservation.username !== username) return 0;
    return Math.max(0, reservation.ticksToEnd - Math.max(0, Game.time - reservation.seenAt));
}

function repeat(part, count) {
    const result = [];
    for (let i = 0; i < count; i++) result.push(part);
    return result;
}

function controllerTravelDistance(home, record) {
    let distance = record.controllerDistance || 50;
    const targetRoom = roomCoords(record.room);
    const target = record.controllerPos;
    if (!targetRoom || !target) return distance;
    const spawns = home.find(FIND_MY_SPAWNS);
    const origins = spawns.length ? spawns.map((spawn) => spawn.pos) : [anchorFor(home).pos];
    for (const origin of origins) {
        const sourceRoom = roomCoords(origin.roomName || home.name);
        if (!sourceRoom) continue;
        const dx = (targetRoom.x - sourceRoom.x) * 50 + target.x - origin.x;
        const dy = (targetRoom.y - sourceRoom.y) * 50 + target.y - origin.y;
        distance = Math.max(distance, Math.max(Math.abs(dx), Math.abs(dy)) - 1);
    }
    return distance;
}

function applyAvoidHolds(homeName, remotes) {
    const map = config.remote && config.remote.holdWhileAvoid;
    if (!map || !remotes) return;
    const avoid = require('utils').tempAvoidRooms();
    const rules = (config.pvp && config.pvp.tempAvoid) || {};
    for (const roomName in remotes) {
        const record = remotes[roomName];
        if (!record) continue;
        const holdRoom = map[roomName];
        if (holdRoom && avoid.has(holdRoom)) {
            const rule = rules[holdRoom] || {};
            const until = Number(rule.until) || (Game.time + 1500);
            if (!(Number(record.suspendedUntil) >= until)) {
                record.suspendedUntil = until;
                record.suspendReason = 'avoidHold:' + holdRoom;
            }
            record.avoidHold = { room: holdRoom, until };
        } else if (record.avoidHold) {
            const hold = record.avoidHold;
            const ours = String(record.suspendReason || '').indexOf('avoidHold:') === 0;
            if (ours || Number(record.suspendedUntil) === Number(hold.until)) {
                if (Number(record.suspendedUntil) <= Number(hold.until)) record.suspendedUntil = 0;
                if (ours) record.suspendReason = null;
            }
            delete record.avoidHold;
        }
    }
}

function reserverOnHold(home, record) {
    const map = config.remote && config.remote.holdReserver;
    const until = map && Number(map[record.room]);
    if (!until || record.reserverHoldReleased) return false;
    const stored = Number((home.storage && home.storage.store[RESOURCE_ENERGY]) || 0);
    if (stored >= until) { record.reserverHoldReleased = Game.time; return false; }
    return true;
}

function reserverBody(capacity) {
    if (capacity >= positiveSetting('reserverDoubleClaimCapacity', 1650)) return ['claim', 'claim', 'move', 'move'];
    if (capacity >= 650) return ['claim', 'move'];
    return [];
}

function reservationKeepFor(roomName) {
    const remote = config.remote || {};
    const byRoom = remote.reservationKeepByRoom;
    const v = byRoom && Number(byRoom[roomName]);
    if (v > 0) return v;
    return positiveSetting('reservationKeep', 1000);
}

function reserveDespitePvp(roomName) {
    const list = (config.remote || {}).reserveDespitePvp;
    return Array.isArray(list) && list.indexOf(roomName) >= 0;
}

function reservationNotForeign(record, username) {
    const r = record && record.reservation;
    return !r || !r.username || r.username === username;
}

function remoteMinerBody(capacity, roadComplete) {
    if (capacity >= 800 && roadComplete === false) return repeat('work', 5).concat(['carry'], repeat('move', 5));
    if (capacity >= 700) return repeat('work', 5).concat(['carry'], repeat('move', 3));
    if (capacity >= 600) return repeat('work', 4).concat(['carry'], repeat('move', 3));
    if (capacity >= 350) return repeat('work', 2).concat(['carry'], repeat('move', 2));
    return [];
}

function remoteHaulerBody(capacity, roadReady, maintenance, maxCarry) {
    let best = [];
    const carryCap = Math.max(1, Math.min(32, Number(maxCarry) || 32));
    for (let carry = 1; carry <= carryCap; carry++) {
        const work = maintenance ? 1 : 0;
        const move = roadReady ? Math.ceil((carry + work) / 2) : carry + work;
        const cost = work * 100 + carry * 50 + move * 50;
        const length = work + carry + move;
        if (cost > capacity || length > 50) break;
        best = repeat('work', work).concat(repeat('carry', carry), repeat('move', move));
    }
    return best;
}

function carryParts(body) {
    return body.filter((part) => part === 'carry').length;
}

function reserverCapReached(homeName, roomName) {
    const caps = (config.remote || {}).maxReservers || {};
    const cap = Number(caps[roomName]);
    if (!(cap > 0)) return false;
    return creepsHomeRole(homeName, 'reserver').filter((creep) => creep.memory.remoteRoom === roomName).length >= cap;
}

function hasReserver(homeName, roomName) {
    return creepsHomeRole(homeName, 'reserver').some((creep) => !isRetiring(creep.memory) && creep.memory.remoteRoom === roomName);
}

function reserverStartDeadline(home, record, username) {
    const controller = record.controllerPos;
    if (!controller) return null;
    const incumbents = creepsHomeRole(home.name, 'reserver').filter((creep) => {
        const pos = creep.pos;
        return !creep.spawning && !isRetiring(creep.memory) && creep.memory.remoteRoom === record.room &&
            pos && pos.roomName === record.room && Math.max(Math.abs(pos.x-controller.x), Math.abs(pos.y-controller.y)) <= 1 &&
            Number.isFinite(creep.ticksToLive) && (creep.body || []).some((part) => part.type === CLAIM_PART && part.hits !== 0);
    });
    if (!incumbents.length) return null;
    const coverage = Math.max(...incumbents.map((creep) => creep.ticksToLive)) + effectiveReservation(record, username);
    return Game.time + coverage - 2 * 3 - controllerTravelDistance(home, record) - 20;
}

function reserveGain(home, record, sources) {
    const work = {};
    for (const creep of creepsHomeRole(home.name, 'remoteMiner')) {
        if (isRetiring(creep.memory) || creep.memory.remoteRoom !== record.room) continue;
        work[creep.memory.sourceId] = (work[creep.memory.sourceId] || 0) + bodyPartCount(creep.body, 'work');
    }
    const regen = 300;
    const neutral = (typeof SOURCE_ENERGY_NEUTRAL_CAPACITY === 'number' ? SOURCE_ENERGY_NEUTRAL_CAPACITY : 1500) / regen;
    const reserved = (typeof SOURCE_ENERGY_CAPACITY === 'number' ? SOURCE_ENERGY_CAPACITY : 3000) / regen;
    const power = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
    let gain = 0;
    let unmanned = 0;
    let manned = 0;
    for (const source of sources || []) {
        if (!work[source.id]) { unmanned++; continue; }
        manned++;
        const rate = work[source.id] * power;
        gain += Math.min(rate, reserved) - Math.min(rate, neutral);
    }
    return { gain, unmanned, manned };
}

function haulBudget(home, capacity) {
    const settings = config.remote || {};
    const below = Number(settings.lowStorageHaulBelow);
    if (!(below > 0) || !home || !home.storage) return capacity;
    const energy = (st) => (st && st.store && Number(st.store[RESOURCE_ENERGY] || 0)) || 0;
    if (energy(home.storage) + energy(home.terminal) >= below) return capacity;
    const floor = Math.max(0, Number(settings.lowStorageHaulMin) || 0);
    return Math.min(capacity, Math.max(Number(home.energyAvailable) || 0, floor));
}

function capHaulBody(home, capacity, item, bodyAt) {
    const budget = haulBudget(home, capacity);
    if (budget >= capacity) return;
    const body = bodyAt(budget) || [];
    if (body.length && carryParts(body.map((p) => (p && p.type) || p)) > 0) {
        item.body = body;
        item.lowStorageCap = budget;
    }
}

function demand(role, slot, body, memory, lead, priority, bodyFor) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, bodyFor };
}

function deliveryStops(dropRoom) {
    const settings = config.remote || {};
    const fallback = Math.max(0, Number(settings.deliveryStopTicks) || 0);
    const record = dropRoom && Memory.rooms && Memory.rooms[dropRoom] && Memory.rooms[dropRoom].remoteStop;
    const minSamples = Math.max(1, Number(settings.stopMinSamples) || 3);
    if (!record || !(Number(record.n) >= minSamples) || !Number.isFinite(Number(record.ema))) return fallback;
    return Math.max(1, Math.min(fallback || 10, Number(record.ema)));
}

function roundTripTicks(source, distance, dropRoom) {
    const turn = Math.max(0, Number((config.remote || {}).turnTicks));
    return distance * 2 + (Number.isFinite(turn) ? turn : 4) + deliveryStops(dropRoom);
}

function requiredCarryFor(source, distance, dropRoom) {
    const rate = Math.max(5, (source.energyCapacity || 1500) / 300);
    const utilization = Math.max(0.5, Math.min(1, Number((config.remote || {}).haulUtilization) || 1));
    return Math.max(1, Math.ceil(rate * roundTripTicks(source, distance, dropRoom) / (50 * utilization)));
}

function haulerSlots(source, distance, capacity, dropRoom) {
    const requiredCarry = requiredCarryFor(source, distance, dropRoom);
    const slots = [];
    let plannedCarry = 0;
    let slotIndex = 0;
    while (plannedCarry < requiredCarry && slotIndex < 8) {
        const maintenance = slotIndex === 0;
        const need = Math.max(1, requiredCarry - plannedCarry);
        const maxCarry = slotIndex === 0 ? need : Math.max(MIN_RESIDUAL_CARRY, need);
        const body = remoteHaulerBody(capacity, source.roadComplete, maintenance, maxCarry);
        const carry = carryParts(body);
        if (!carry) break;
        slots.push({ slotIndex, body, carry });
        plannedCarry += carry;
        slotIndex++;
    }
    return slots;
}

function staffingSettings() {
    const remote = config.remote || {};
    const queue = config.spawnQueue || {};
    return {
        share: remote.upkeepShare == null ? 0.5 : Math.max(0, Number(remote.upkeepShare)),
        slack: remote.upkeepSlack == null ? 1.3 : Math.max(1, Number(remote.upkeepSlack)),
        samples: queue.incomeSamples == null ? 200 : Number(queue.incomeSamples),
        minIncome: queue.minIncome == null ? 1 : Number(queue.minIncome),
    };
}

function roomIncome(mem, settings) {
    const track = mem.spawnIncome;
    if (!track || Number(track.n) < settings.samples) return null;
    const ema = Math.max(0, Number(track.ema) || 0);
    return ema >= settings.minIncome ? ema : 0;
}

function recordPlan(record, capacity, homeName) {
    let upkeep = 0;
    let value = 0;
    let spawnTime = 0;
    for (const source of record.sources || []) {
        const miner = record.sk ? skMinerBody(capacity, source.roadComplete) : remoteMinerBody(capacity, source.roadComplete);
        if (!miner.length) continue;
        upkeep += bodyCost(miner) / CREEP_LIFE;
        spawnTime += miner.length * SPAWN_TICKS_PER_PART / CREEP_LIFE;
    }
    if (record.sk) {
        const reaper = skReaperBody(capacity);
        upkeep += bodyCost(reaper) / CREEP_LIFE;
        spawnTime += reaper.length * SPAWN_TICKS_PER_PART / CREEP_LIFE;
    }
    const reserver = record.sk ? [] : reserverBody(capacity);
    if (reserver.length) {
        const claims = Math.max(1, reserver.filter((part) => part === CLAIM_PART).length);
        upkeep += bodyCost(reserver) / (CLAIM_LIFE * claims);
        spawnTime += reserver.length * SPAWN_TICKS_PER_PART / (CLAIM_LIFE * claims);
    }
    const self = !record.drop || record.drop.room === homeName;
    const dropDistance = !self && record.drop && record.drop.distance > 0 ? record.drop.distance : null;
    const dropName = (record.drop && record.drop.room) || homeName;
    for (const source of record.sources || []) {
        if (self) value += Math.max(5, (source.energyCapacity || 1500) / 300);
        if (!source.containerId) continue;
        const distance = dropDistance || source.distance || 50;
        for (const slot of haulerSlots(source, distance, capacity, dropName)) {
            upkeep += bodyCost(slot.body) / CREEP_LIFE;
            spawnTime += slot.body.length * SPAWN_TICKS_PER_PART / CREEP_LIFE;
        }
    }
    return { upkeep, value, spawnTime };
}

function remoteSpawnCap(home, mem) {
    const above = positiveSetting('spawnCapStorageAbove', 100000);
    const below = Math.min(above, positiveSetting('spawnCapStorageBelow', 60000));
    const storage = home.storage && home.storage.my !== false && home.storage.store;
    const stored = storage ? Number(storage[RESOURCE_ENERGY] || 0) : 0;
    const was = !!mem.remoteSpawnCapped;
    const on = stored >= above || (was && stored >= below);
    if (on !== was) mem.remoteSpawnCapped = on;
    if (!on) return Infinity;
    const spawns = typeof home.find === 'function' ? home.find(FIND_MY_SPAWNS).length : 1;
    return Math.max(1, spawns) * positiveSetting('richSpawnShare', 0.5);
}

function staffRemotes(home, mem) {
    const settings = staffingSettings();
    const capacity = home.energyCapacityAvailable || 0;
    const income = roomIncome(mem, settings);
    const budget = income == null ? Infinity : income * settings.share;
    const spawnCap = remoteSpawnCap(home, mem);
    const entries = [];
    const unreachable = [];
    for (const roomName in mem.remotes) {
        const record = mem.remotes[roomName];
        if (!record.enabled) { delete record.staffed; continue; }
        if (record.suspendReason === 'unreachable' && record.suspendedUntil > Game.time) {
            record.staffed = false;
            unreachable.push(record.room);
            continue;
        }
        const plan = recordPlan(record, capacity, home.name);
        entries.push({ record, upkeep: plan.upkeep, value: plan.value, spawnTime: plan.spawnTime });
    }
    entries.sort((a, b) => (b.value - b.upkeep) - (a.value - a.upkeep) || a.record.room.localeCompare(b.record.room));
    let used = 0;
    let spawnUsed = 0;
    const staffed = [];
    const dropped = [];
    const selfFundedRooms = [];
    const spawnCapped = [];
    const overBudget = [];
    const cost = {};
    for (const entry of entries) {
        cost[entry.record.room] = Math.round(entry.upkeep * 100) / 100;
        const limit = budget * (entry.record.staffed ? settings.slack : 1);
        const selfFunded = entry.value > entry.upkeep;
        if (selfFunded) selfFundedRooms.push(entry.record.room);
        const spawnLimit = spawnCap * (entry.record.staffed ? 1.1 : 1);
        const spawnOk = spawnUsed + entry.spawnTime <= spawnLimit;
        if (!spawnOk && (selfFunded || used + entry.upkeep <= limit)) spawnCapped.push(entry.record.room);
        if (spawnOk && (selfFunded || used + entry.upkeep <= limit)) {
            if (used + entry.upkeep > limit) overBudget.push(entry.record.room);
            entry.record.staffed = true;
            used += entry.upkeep;
            spawnUsed += entry.spawnTime;
            staffed.push(entry.record.room);
        } else {
            entry.record.staffed = false;
            dropped.push(entry.record.room);
        }
    }
    if (overBudget.length) mem.remoteOverBudgetSeen = { at: Game.time, rooms: overBudget, budget: Math.round(budget * 10) / 10 };
    if (spawnCapped.length) mem.remoteSpawnCappedSeen = { at: Game.time, rooms: spawnCapped, cap: spawnCap, used: Math.round(spawnUsed * 1000) / 1000 };
    mem.remoteStaff = {
        at: Game.time,
        income: income == null ? null : Math.round(income * 10) / 10,
        budget: income == null ? null : Math.round(budget * 10) / 10,
        used: Math.round(used * 10) / 10,
        staffed,
        dropped,
        selfFunded: selfFundedRooms,
        spawnCap: Number.isFinite(spawnCap) ? spawnCap : null,
        spawnUsed: Math.round(spawnUsed * 1000) / 1000,
        spawnCapped,
        overBudget,
        unreachable,
        cost,
    };
    return mem.remoteStaff;
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my || home.controller.level < config.remote.minRcl) return [];
    const remotes = homeMemory(home.name).remotes;
    const username = myUsername(home);
    const capacity = home.energyCapacityAvailable;
    const demands = [];
    let priority = 0;
    const rank = {};
    const assigned = (config.remote && config.remote.assign && config.remote.assign[home.name]) || [];
    (Array.isArray(assigned) ? assigned.concat(breachUnlocked(home.name)) : []).forEach((name, index) => { if (!(name in rank)) rank[name] = index; });
    const rankOf = (record) => (record.room in rank ? rank[record.room] : 1000);
    const ready = (record) => ((record.sources || []).some((source) => source.containerId) ? 0 : 1);
    const records = Object.values(remotes).sort((a, b) => (ready(a) - ready(b)) || (rankOf(a) - rankOf(b)) || a.room.localeCompare(b.room));
    for (const record of records) {
        if (record.enabled && record.clearReservation && record.suspendedUntil > Game.time && !record.sk &&
            withinDistance(home.name, record.room) && !hasReserver(home.name, record.room)) {
            const clearBody = reserverBody(capacity);
            if (clearBody.length) {
                demands.push(demand('reserver', 'reserver:' + record.room, clearBody, { home: home.name, remoteRoom: record.room },
                    clearBody.length * 3 + controllerTravelDistance(home, record) + 20, priority++));
            }
            continue;
        }
        if (record.enabled && record.suspendedUntil > Game.time && !record.sk &&
            reserveDespitePvp(record.room) &&
            String(record.suspendReason || '').indexOf('pvpThreat:') === 0 && !record.threat &&
            reservationNotForeign(record, username) && withinDistance(home.name, record.room)) {
            const watchBody = reserverBody(capacity);
            const reserveKeep = reservationKeepFor(record.room);
            const reserveLead = positiveSetting('reserverGrace', 60) + watchBody.length * 3 + controllerTravelDistance(home, record) + 20;
            const reservationLeft = effectiveReservation(record, username);
            const due = watchBody.length && reservationLeft <= reserveLead + DEMAND_BUFFER + reserveKeep;
            const hasFresh = creepsHomeRole(home.name, 'reserver').some((creep) => !isRetiring(creep.memory) &&
                creep.memory.remoteRoom === record.room && (creep.spawning || creep.ticksToLive > reserveLead) &&
                bodyPartCount(creep.body, CLAIM_PART) >= watchBody.filter((part) => part === CLAIM_PART).length);
            if (due && !hasFresh) {
                record.reserveDespitePvp = { at: Game.time, reservation: reservationLeft, keep: reserveKeep };
                demands.push(demand('reserver', 'reserver:' + record.room, watchBody,
                    { home: home.name, remoteRoom: record.room }, reserveLead, priority++, (budget) => reserverBody(budget)));
            }
            continue;
        }
        if (!record.enabled || record.suspendedUntil > Game.time || !withinDistance(home.name, record.room)) continue;
        if (record.staffed === false) continue;
        const maintain = ready(record) === 0;
        const sources = record.sources.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const probing = record.unreachableAt > 0 && !(record.lastSeen > record.unreachableAt);
        if (record.sk) {
            if (!skAllowed(home)) continue;
            const reaperBody = skReaperBody(capacity);
            if (!reaperBody.length) { record.skHeld = { at: Game.time, capacity }; continue; }
            const travel = sources.reduce((best, source) => Math.min(best, source.distance || 50), 50);
            const reaperDemand = demand('skReaper', 'skReaper:' + record.room, reaperBody,
                { home: home.name, remoteRoom: record.room }, reaperBody.length * 3 + travel + 20, priority++);
            reaperDemand.maintain = maintain;
            demands.push(reaperDemand);
            if (!reaperOnStation(home.name, record.room)) { record.skWaitReaper = Game.time; continue; }
            if (!record.skStation) record.skStation = { first: Game.time };
            record.skStation.at = Game.time;
        }
        const minerBodyFor = (budget, roadComplete) => (record.sk ? skMinerBody(budget, roadComplete) : remoteMinerBody(budget, roadComplete));
        for (const source of sources) {
            const minerBody = minerBodyFor(capacity, source.roadComplete);
            if (!minerBody.length) continue;
            const slot = 'remoteMiner:' + record.room + ':' + source.id;
            const lead = minerBody.length * 3 + (source.distance || 50) + 20;
            const minerDemand = demand('remoteMiner', slot, minerBody,
                { home: home.name, remoteRoom: record.room, sourceId: source.id }, lead, priority++,
                (budget) => minerBodyFor(budget, source.roadComplete));
            minerDemand.maintain = maintain && !!source.containerId;
            const sourceRate = Math.max(5, (source.energyCapacity || 1500) / 300);
            minerDemand.throughput = (body) => Math.min(sourceRate, bodyPartCount(body, 'work') * 2);
            demands.push(minerDemand);
            if (probing) break;
        }
        if (probing) continue;

        const reserveBody = record.sk ? [] : reserverBody(capacity);
        const reserveGrace = positiveSetting('reserverGrace', 60);
        const reserveLead = reserveGrace + reserveBody.length * 3 + controllerTravelDistance(home, record) + 20;
        const reserveKeep = reservationKeepFor(record.room);
        const reservationLeft = effectiveReservation(record, username);
        if (reserveBody.length && reservationLeft > reserveLead + DEMAND_BUFFER + reserveKeep && hasReserver(home.name, record.room)) {
            record.reserverSkip = { at: Game.time, reservation: reservationLeft };
        }
        const reserveDue = reserveBody.length && reservationLeft <= reserveLead + DEMAND_BUFFER + reserveKeep;
        const usable = reserveDue ? reserveGain(home, record, sources) : null;
        if (usable && usable.manned > 0 && usable.unmanned === 0 && usable.gain < positiveSetting('reserveMinGain', 1)) {
            record.reserverWeakMiner = { at: Game.time, gain: usable.gain, n: (Number(record.reserverWeakMiner && record.reserverWeakMiner.n) || 0) + 1 };
        } else if (reserveDue && require('utils').towerFirstHold(home)) {
            record.reserverTowerFirst = Game.time;
        } else if (reserveDue && reserverOnHold(home, record)) {
            record.reserverOnHold = Game.time;
        } else if (reserveDue && reserverCapReached(home.name, record.room)) {
            record.reserverCapped = Game.time;
        } else if (reserveDue && creepsHomeRole(home.name, 'reserver').some((creep) => !isRetiring(creep.memory) &&
                creep.memory.remoteRoom === record.room && (creep.spawning || creep.ticksToLive > reserveLead) &&
                bodyPartCount(creep.body, CLAIM_PART) >= reserveBody.filter((part) => part === CLAIM_PART).length)) {
            record.reserverEnRoute = Game.time;
        } else if (reserveDue) {
            const slot = 'reserver:' + record.room;
            const doubleClaim = positiveSetting('reserverDoubleClaimCapacity', 1650);
            const replacing = hasReserver(home.name, record.room);
            const startDeadline = replacing ? reserverStartDeadline(home, record, username) : null;
            const criticalHandoff = startDeadline != null && startDeadline <= Game.time + reserveGrace;
            const reserveDemand = demand('reserver', slot, reserveBody,
                { home: home.name, remoteRoom: record.room }, reserveLead, priority++,
                capacity >= doubleClaim && replacing
                    ? (budget) => { if (budget >= doubleClaim || criticalHandoff) return reserverBody(budget); record.reserverHeld = Game.time; return []; }
                    : (budget) => reserverBody(budget));
            reserveDemand.grace = reserveGrace;
            if (startDeadline != null) reserveDemand.neededBy = startDeadline;
            reserveDemand.maintain = maintain;
            demands.push(reserveDemand);
        }

        const dropDistance = record.drop && record.drop.room !== home.name && record.drop.distance > 0 ? record.drop.distance : null;
        const dropName = (record.drop && record.drop.room) || home.name;
        for (const source of sources) {
            const distance = dropDistance || source.distance || 50;
            const lost = !source.containerId && Number(source.containerLostAt) > 0;
            if (!source.containerId && !lost) continue;
            const rate = Math.max(5, (source.energyCapacity || 1500) / 300);
            const towerFirst = require('utils').towerFirstHold(home);
            const planSource = towerFirst ? Object.assign({}, source, { energyCapacity: Math.min(Number(source.energyCapacity) || 1500, 1500) }) : source;
            const planned = haulerSlots(planSource, distance, capacity, dropName);
            const slots = lost ? planned.filter((plan) => plan.slotIndex === 0) : planned;
            if (lost) record.containerLostHaul = { at: Game.time, source: source.id, lostAt: source.containerLostAt };
            source.haulNeed = requiredCarryFor(source, distance, dropName);
            source.haulStops = deliveryStops(dropName);
            const starvedRooms = (config.remote || {}).starvedHaulFirst || [];
            let starvedLine = false;
            if (starvedRooms.indexOf(home.name) >= 0) {
                const liveCarry = creepsHomeRole(home.name, 'remoteHauler').filter((creep) => !isRetiring(creep.memory) &&
                    creep.memory.remoteRoom === record.room && creep.memory.sourceId === source.id)
                    .reduce((sum, creep) => sum + bodyPartCount(creep.body, 'carry'), 0);
                starvedLine = liveCarry * 2 < source.haulNeed;
                if (starvedLine) record.starvedHaul = { at: Game.time, live: liveCarry, need: source.haulNeed };
            }
            const lineHaulers = towerFirst ? creepsHomeRole(home.name, 'remoteHauler').filter((creep) => !isRetiring(creep.memory) &&
                creep.memory.remoteRoom === record.room && creep.memory.sourceId === source.id) : [];
            const lineNeed = towerFirst ? requiredCarryFor(planSource, distance, dropName) : 0;
            if (towerFirst) source.haulNeedTowerFirst = lineNeed;
            for (const plan of slots) {
                let { slotIndex, body, carry: bodyCarry } = plan;
                const slot = 'remoteHauler:' + record.room + ':' + source.id + ':' + slotIndex;
                if (towerFirst) {
                    const others = lineHaulers.filter((creep) => creep.memory.slotKey !== slot)
                        .reduce((sum, creep) => sum + bodyPartCount(creep.body, 'carry'), 0);
                    const gap = Math.max(MIN_RESIDUAL_CARRY, lineNeed - others);
                    if (gap < bodyCarry) {
                        const trimmed = remoteHaulerBody(capacity, source.roadComplete, slotIndex === 0, gap);
                        if (carryParts(trimmed)) { body = trimmed; bodyCarry = carryParts(trimmed); }
                    }
                }
                const lead = body.length * 3 + distance + 20;
                const haulDemand = demand('remoteHauler', slot, body, {
                    home: home.name,
                    remoteRoom: record.room,
                    sourceId: source.id,
                    haulSlot: slotIndex,
                    state: 'collect',
                }, lead, priority++, (budget) => remoteHaulerBody(budget, source.roadComplete, slotIndex === 0, bodyCarry));
                capHaulBody(home, capacity, haulDemand, (b) => remoteHaulerBody(b, source.roadComplete, slotIndex === 0, bodyCarry));
                haulDemand.maintain = true;
                if (starvedLine) haulDemand.starvedLine = true;
                haulDemand.throughput = (body) => Math.min(rate, carryParts(body.map((part) => (part && part.type) || part)) * 50 / roundTripTicks(source, distance, dropName));
                demands.push(haulDemand);
            }
            const residual = lost ? null : residualHaulerDemand(home, record, source, slots, distance, capacity, priority, dropName);
            if (residual) {
                const gap = residual.residual && residual.residual.gap;
                capHaulBody(home, capacity, residual, (b) => remoteHaulerBody(b, source.roadComplete, false, gap));
                demands.push(residual); priority++;
            }
        }
    }
    return demands;
}

function residualHaulerDemand(home, record, source, slots, distance, capacity, priority, dropName) {
    if (!slots.length) return null;
    if ((home.energyAvailable || 0) >= bodyCost(slots[0].body)) return null;
    const required = requiredCarryFor(source, distance, dropName);
    const prefix = 'remoteHauler:' + record.room + ':' + source.id + ':';
    const lead = slots[0].body.length * 3 + distance + 20;
    const live = creepsHomeRole(home.name, 'remoteHauler').filter((creep) => !isRetiring(creep.memory) &&
        creep.memory.remoteRoom === record.room && creep.memory.sourceId === source.id &&
        (creep.spawning || creep.ticksToLive == null || creep.ticksToLive > lead));
    const filled = slots.every((slot) => live.some((creep) => creep.memory.slotKey === prefix + slot.slotIndex));
    if (!filled) return null;
    const liveCarry = live.reduce((sum, creep) => sum + carryParts((creep.body || []).map((part) => (part && part.type) || part)), 0);
    const gap = required - liveCarry;
    if (gap < MIN_RESIDUAL_CARRY) return null;
    const body = remoteHaulerBody(capacity, source.roadComplete, false, gap);
    if (!carryParts(body)) return null;
    const item = demand('remoteHauler', prefix + 'x', body, {
        home: home.name, remoteRoom: record.room, sourceId: source.id, haulSlot: 'x', state: 'collect',
    }, body.length * 3 + distance + 20, priority, (budget) => remoteHaulerBody(budget, source.roadComplete, false, gap));
    item.maintain = true;
    item.residual = { required, live: liveCarry, gap };
    record.residualSeen = { at: Game.time, source: source.id, required, live: liveCarry, gap };
    return item;
}

function reserverHandoffs(home, demands, blockingTicks) {
    if (!(blockingTicks > 0)) return [];
    return (demands || []).filter((item) => {
        if (item.role !== 'reserver') return false;
        const assigned = creepsHomeRole(home.name, 'reserver').filter((creep) =>
            !isRetiring(creep.memory) && creep.memory.remoteRoom === item.memory.remoteRoom);
        if (!assigned.length || assigned.some((creep) => creep.spawning || creep.ticksToLive == null ||
            creep.ticksToLive > item.lead + blockingTicks)) return false;
        return assigned.some((creep) => creep.ticksToLive > item.lead);
    });
}

module.exports = { reserverCapReached,
    dropRoom,
    remoteWhitelist,
    canClearReservation,
    noteTravel,
    isUnreachable,
    run,
    applyAvoidHolds,
    cededRoom,
    observe,
    getDemands,
    reserverHandoffs,
    getRemote,
    getSource,
    isSuspended,
    suspensionLeft,
    threatReason,
    effectiveReservation,
    reservationKeepFor,
    reserveDespitePvp,
    reserverBody,
    remoteMinerBody,
    remoteHaulerBody,
    haulBudget,
    haulerSlots,
    requiredCarryFor,
    deliveryStops,
    staffRemotes,
    entryPosition,
    noteRoadTrail,
    pruneOrphanRoadSites,
    isDisabled,
    skSettings,
    skAllowed,
    skReaperBody,
    skMinerBody,
    reaperOnStation,
    ringTile,
    isKeeper,
    keeperThreatFor,
    keeperRetreat,
    noteSkHarvest,
    noteReaperLoss };
