'use strict';

const ROLE_PRIORITIES = {
    hauler: 1,
    remoteHauler: 1,
    reserver: 1,
    scout: 1,
    attacker: 2,
    defender: 2,
    healer: 2,
};
const UNSUPPORTED_MOVE_OPTIONS = new Set([
    'ignoreCreeps',
    'reusePath',
    'serializeMemory',
    'noPathFinding',
    'ignore',
    'avoid',
    'serialize',
]);

const utils = require('utils');
const layout = require('layout');
const config = require('config');

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const state = runtimeGlobal.__movementState || (runtimeGlobal.__movementState = {});
state.stats = state.stats || {};
for (const key of ['calls', 'engineCalls', 'nativeCalls', 'inRange', 'invalidTargets', 'invalidations', 'creepResets',
    'beginTicks', 'endTicks', 'engineLoadErrors', 'workTileErrors', 'workTileCalls', 'workTileComputes']) {
    if (typeof state.stats[key] !== 'number') state.stats[key] = 0;
}

let engine = null;
let engineDisabled = false;
let api = null;

function resultCode(name, fallback) {
    return runtimeGlobal[name] === undefined ? fallback : runtimeGlobal[name];
}

function constructorsReady() {
    return typeof Creep === 'function' && Creep.prototype &&
        typeof PowerCreep === 'function' && PowerCreep.prototype &&
        typeof RoomPosition === 'function' && RoomPosition.prototype &&
        typeof Game !== 'undefined' && typeof PathFinder !== 'undefined';
}

function exposeEngineExports(loaded) {
    if (!api) return;
    for (const name of Object.keys(loaded)) {
        if (name in api || typeof loaded[name] !== 'function') continue;
        api[name] = function () {
            return callEngine(name, arguments);
        };
    }
}

function loadEngine() {
    if (engine) return engine;
    if (engineDisabled || !constructorsReady()) return null;
    try {
        engine = require('wheel_movement_engine');
        exposeEngineExports(engine);
        return engine;
    } catch (error) {
        engineDisabled = true;
        state.stats.engineLoadErrors += 1;
        state.lastEngineError = error && error.message ? error.message : String(error);
        return null;
    }
}

function callEngine(name, args) {
    const loaded = loadEngine();
    if (!loaded || typeof loaded[name] !== 'function') return undefined;
    return loaded[name].apply(loaded, args);
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRange(value) {
    if (!finiteNumber(value)) return 1;
    return Math.max(0, Math.floor(value));
}

function normalizePriority(creep, value) {
    let priority = value;
    if (!finiteNumber(priority)) priority = ROLE_PRIORITIES[creep && creep.memory && creep.memory.role] || 0;
    return Math.max(0, Math.min(2, Math.floor(priority)));
}

function normalizeOpts(creep, opts) {
    const normalized = {};
    for (const key in opts || {}) {
        if (key !== 'roomName') normalized[key] = opts[key];
    }
    normalized.range = normalizeRange(normalized.range);
    normalized.priority = normalizePriority(creep, normalized.priority);
    return normalized;
}

function toPos(creep, target, opts) {
    if (!target) return null;
    const candidate = target.pos || target;
    if (!finiteNumber(candidate.x) || !finiteNumber(candidate.y)) return null;
    const roomName = candidate.roomName || (opts && opts.roomName) || (creep && creep.pos && creep.pos.roomName);
    if (!roomName) return null;
    if (typeof RoomPosition === 'function') return new RoomPosition(candidate.x, candidate.y, roomName);
    return { x: candidate.x, y: candidate.y, roomName };
}

function sameRoom(left, right) {
    return !!left && !!right && left.roomName === right.roomName;
}

function rangeBetween(left, right) {
    if (!sameRoom(left, right)) return Infinity;
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

const KEEPER_SCAN_RADIUS = 4;
const keeperRoomCache = new Map();

function isKeeperRoom(name) {
    const coords = utils.roomCoords(name);
    if (!coords) return false;
    const dx = (coords.x < 0 ? -coords.x - 1 : coords.x) % 10;
    const dy = (coords.y < 0 ? -coords.y - 1 : coords.y) % 10;
    return dx >= 4 && dx <= 6 && dy >= 4 && dy <= 6 && !(dx === 5 && dy === 5);
}

function keeperRoomsNearHomes() {
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const name of Object.keys(gameRooms)) {
        const room = gameRooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        const coords = utils.roomCoords(name);
        if (!coords) continue;
        box.minX = Math.min(box.minX, coords.x - KEEPER_SCAN_RADIUS);
        box.maxX = Math.max(box.maxX, coords.x + KEEPER_SCAN_RADIUS);
        box.minY = Math.min(box.minY, coords.y - KEEPER_SCAN_RADIUS);
        box.maxY = Math.max(box.maxY, coords.y + KEEPER_SCAN_RADIUS);
    }
    if (box.minX === Infinity) return [];
    const key = [box.minX, box.maxX, box.minY, box.maxY].join(',');
    if (!keeperRoomCache.has(key)) {
        const rooms = [];
        for (let x = box.minX; x <= box.maxX; x++) {
            for (let y = box.minY; y <= box.maxY; y++) {
                const name = utils.roomNameAt(x, y);
                if (isKeeperRoom(name)) rooms.push(name);
            }
        }
        keeperRoomCache.set(key, rooms);
    }
    return keeperRoomCache.get(key);
}

function frozenOwnerRooms() {
    return utils.ownerDangerRooms();
}

function dangerRooms() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.danger && state.danger.tick === tick) return state.danger.rooms;
    const rooms = new Set(keeperRoomsNearHomes());
    const map = typeof Memory !== 'undefined' && Memory && Memory.map;
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    for (const name of Object.keys(map && typeof map === 'object' ? map : {})) {
        const entry = map[name];
        if (!entry || typeof entry !== 'object') continue;
        const visible = gameRooms[name];
        if (visible && visible.controller && visible.controller.my) continue;
        if (entry.class === 'sk' || entry.lairs > 0 || entry.owner || isKeeperRoom(name)) rooms.add(name);
    }
    for (const name of frozenOwnerRooms()) if (!(gameRooms[name] && gameRooms[name].controller && gameRooms[name].controller.my)) rooms.add(name);
    for (const name of (require('config').pvp || {}).dangerRooms || []) rooms.add(name);
    const pvp = typeof Memory !== 'undefined' && Memory && Memory.pvpThreat;
    for (const name of Object.keys(pvp || {})) if (pvp[name] && pvp[name].until > tick && !(gameRooms[name] && gameRooms[name].controller && gameRooms[name].controller.my)) rooms.add(name);
    state.danger = { tick, rooms };
    return rooms;
}

const COMBAT_PARTS = ['attack', 'ranged_attack', 'heal'];
const NPC_OWNERS = (config.npcOwners && config.npcOwners.length) ? config.npcOwners : ['Invader', 'Source Keeper', 'Power Bank', 'Screeps'];
function isHighwayRoom(name) {
    const c = utils.roomCoords(name);
    if (!c) return false;
    const dx = c.x < 0 ? -c.x - 1 : c.x, dy = c.y < 0 ? -c.y - 1 : c.y;
    return dx % 10 === 0 || dy % 10 === 0;
}
function isCombatCreep(creep) {
    return !!(creep && (creep.body || []).some((p) => COMBAT_PARTS.indexOf(p.type || p) >= 0));
}
function highwayBlocks() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.hwBlock && state.hwBlock.tick === tick) return state.hwBlock.rooms;
    const mem = typeof Memory !== 'undefined' && Memory ? (Memory.highwayBlock || (Memory.highwayBlock = {})) : {};
    const ttl = Number((require('config').pvp || {}).highwayBlockTtl) || 1500;
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    const hostileKind = typeof FIND_HOSTILE_CREEPS === 'undefined' ? 'hostileCreeps' : FIND_HOSTILE_CREEPS;
    const pvpCfg = require('config').pvp || {};
    const hostileUsers = new Set(pvpCfg.highThreat || []);
    const pvpMem = typeof Memory !== 'undefined' && Memory && Memory.pvpThreat || {};
    for (const k of Object.keys(pvpMem)) if (pvpMem[k] && pvpMem[k].user) hostileUsers.add(pvpMem[k].user);
    const aggMem = typeof Memory !== 'undefined' && Memory && Memory.pvpAggressors || {};
    const aggressors = new Set(utils.pvpAggressors());
    for (const u of pvpCfg.blockExclude || []) { aggressors.delete(u); hostileUsers.delete(u); }
    const detect = pvpCfg.highwayBlockDetect !== false;
    for (const name of Object.keys(gameRooms)) {
        if (!detect || !isHighwayRoom(name)) continue;
        const room = gameRooms[name];
        if (!room || typeof room.find !== 'function') continue;
        const players = (room.find(hostileKind) || []).filter((c) => c.owner && NPC_OWNERS.indexOf(c.owner.username) < 0 && isCombatCreep(c));
        const armed = players.filter((c) => hostileUsers.has(c.owner.username));
        if (armed.length) { mem[name] = { at: tick, until: tick + ttl, n: armed.length, user: armed[0].owner.username }; continue; }
        const agg = players.filter((c) => aggressors.has(c.owner.username));
        const until = agg.reduce((m, c) => Math.max(m, Number(aggMem[c.owner.username] && aggMem[c.owner.username].last) + ttl), 0);
        if (agg.length && until > tick) mem[name] = { at: tick, until, n: agg.length, user: agg[0].owner.username, source: 'aggressor' };
        else if (mem[name]) delete mem[name];
    }
    const rooms = new Set();
    for (const name of Object.keys(mem)) {
        const rec = mem[name];
        if (!rec || !(Number(rec.until) > tick)) { delete mem[name]; continue; }
        rooms.add(name);
    }
    for (const name of utils.tempAvoidRooms()) rooms.add(name);
    state.hwBlock = { tick, rooms };
    return rooms;
}
function civilianDangerRooms() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.civDanger && state.civDanger.tick === tick) return state.civDanger.rooms;
    const base = dangerRooms(), blocks = highwayBlocks();
    const rooms = blocks.size ? new Set([...base, ...blocks]) : base;
    state.civDanger = { tick, rooms, blocks };
    return rooms;
}
const civRoutes = new Map();
function civilianRouteOk(from, to) {
    const blocks = highwayBlocks();
    if (!blocks.size) return true;
    if (blocks.has(to)) return false;
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.findRoute !== 'function') return true;
    const danger = civilianDangerRooms();
    const sig = Array.from(blocks).sort().join(',');
    const key = from + '>' + to;
    const hit = civRoutes.get(key);
    if (hit && hit.sig === sig && Game.time - hit.at < 100) return hit.ok;
    let ok = true;
    try { ok = Array.isArray(map.findRoute(from, to, { routeCallback: (r) => (r !== to && danger.has(r) ? Infinity : 1) })); } catch (e) { ok = true; }
    civRoutes.set(key, { ok, at: Game.time, sig });
    return ok;
}

const refugeCache = new Map();
function civilianRefuge(from) {
    const rooms = typeof Game !== 'undefined' && Game.rooms || {};
    const here = rooms[from];
    if (here && here.controller && here.controller.my) return from;
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.findRoute !== 'function') return null;
    const sig = Array.from(highwayBlocks()).sort().join(',');
    const hit = refugeCache.get(from);
    if (hit && hit.sig === sig && Game.time - hit.at < 100) return hit.room;
    const danger = civilianDangerRooms();
    let best = null;
    let bestLen = Infinity;
    for (const name of Object.keys(rooms)) {
        const room = rooms[name];
        if (!room || !room.controller || !room.controller.my || danger.has(name)) continue;
        if (typeof map.getRoomLinearDistance === 'function' && map.getRoomLinearDistance(from, name) > 6) continue;
        let route;
        try { route = map.findRoute(from, name, { routeCallback: (r) => (danger.has(r) ? Infinity : 1) }); } catch (e) { route = null; }
        if (Array.isArray(route) && route.length < bestLen) { best = name; bestLen = route.length; }
    }
    refugeCache.set(from, { room: best, at: Game.time, sig });
    return best;
}

function rangedThreats() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.rangedThreat && state.rangedThreat.tick === tick) return state.rangedThreat.rooms;
    const rooms = {};
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    const hostileKind = typeof FIND_HOSTILE_CREEPS === 'undefined' ? 'hostileCreeps' : FIND_HOSTILE_CREEPS;
    for (const name of Object.keys(gameRooms)) {
        const room = gameRooms[name];
        if (!room || typeof room.find !== 'function' || (room.controller && room.controller.my)) continue;
        const list = (room.find(hostileKind) || []).filter((c) => c.owner && NPC_OWNERS.indexOf(c.owner.username) < 0 &&
            (c.body || []).some((p) => (p.type || p) === 'ranged_attack'));
        if (list.length) rooms[name] = list.map((c) => ({ x: c.pos.x, y: c.pos.y }));
    }
    state.rangedThreat = { tick, rooms };
    return rooms;
}
function rangedAvoidCallback(threats) {
    return function (roomName, costMatrix) {
        const list = threats[roomName];
        if (!list || !costMatrix || typeof costMatrix.set !== 'function') return costMatrix;
        for (const t of list) {
            for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
                const x = t.x + dx, y = t.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                if (costMatrix.get(x, y) >= 255) continue;
                costMatrix.set(x, y, 250);
            }
        }
        return costMatrix;
    };
}
function applyRangedAvoidance(creep, pos, moveOpts) {
    if (moveOpts.costCallback !== undefined || isCombatCreep(creep)) return;
    const threats = rangedThreats();
    if (!threats[creep.pos.roomName] && !threats[pos.roomName]) return;
    moveOpts.costCallback = rangedAvoidCallback(threats);
}

function applyDangerAvoidance(creep, pos, moveOpts) {
    if (moveOpts.avoidRooms !== undefined || !creep.pos || pos.roomName === creep.pos.roomName) return;
    const base = isCombatCreep(creep) ? dangerRooms() : civilianDangerRooms();
    if (!base.size) return;
    if (!base.has(pos.roomName)) { moveOpts.avoidRooms = base; return; }
    const rooms = new Set(base);
    rooms.delete(pos.roomName);
    if (rooms.size) moveOpts.avoidRooms = rooms;
}

function knownLairs(roomName) {
    const out = [];
    const seen = new Set();
    const add = (x, y) => { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); out.push({ x, y }); } };
    const lairType = typeof STRUCTURE_KEEPER_LAIR !== 'undefined' ? STRUCTURE_KEEPER_LAIR : 'keeperLair';
    const room = typeof Game !== 'undefined' && Game.rooms ? Game.rooms[roomName] : null;
    if (room && typeof room.find === 'function') {
        for (const s of room.find(FIND_STRUCTURES)) if (s && s.structureType === lairType && s.pos) add(s.pos.x, s.pos.y);
    }
    const map = typeof Memory !== 'undefined' && Memory.map;
    const entry = map && map[roomName];
    if (entry && Array.isArray(entry.lairPos)) {
        for (const p of entry.lairPos) if (p && typeof p.x === 'number' && typeof p.y === 'number') add(p.x, p.y);
    }
    return out;
}

function noteKeeperTransit(creep) {
    if (!creep || !creep.pos || typeof Memory === 'undefined') return;
    const room = creep.pos.roomName;
    const lairs = knownLairs(room);
    if (!lairs.length) return;
    let min = Infinity;
    for (const l of lairs) {
        const d = Math.max(Math.abs(l.x - creep.pos.x), Math.abs(l.y - creep.pos.y));
        if (d < min) min = d;
    }
    if (!isFinite(min)) return;
    const store = Memory.keeperTransit || (Memory.keeperTransit = {});
    if (store[room] == null || min < store[room]) store[room] = min;
}

function keeperAvoidCallback() {
    const cfg = (config && config.keeperAvoid) || {};
    const range = Math.max(1, Number(cfg.range) || 5);
    const weight = Math.max(1, Number(cfg.weight) || 40);
    return function (roomName, costMatrix) {
        if (!costMatrix || typeof costMatrix.set !== 'function' || typeof costMatrix.get !== 'function') return costMatrix;
        const lairs = knownLairs(roomName);
        if (!lairs.length) return costMatrix;
        for (const l of lairs) {
            for (let dx = -range; dx <= range; dx++) {
                for (let dy = -range; dy <= range; dy++) {
                    const x = l.x + dx;
                    const y = l.y + dy;
                    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (dist > range) continue;
                    const cur = costMatrix.get(x, y);
                    if (cur >= 255) continue;
                    costMatrix.set(x, y, Math.min(254, cur + (range - dist + 1) * weight));
                }
            }
        }
        return costMatrix;
    };
}

function hostileTerritoryRooms() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.hostileTerritory && state.hostileTerritory.tick === tick) return state.hostileTerritory.rooms;
    const rooms = new Set();
    const map = typeof Memory !== 'undefined' && Memory.map;
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    for (const name of Object.keys(map && typeof map === 'object' ? map : {})) {
        const entry = map[name];
        if (!entry || typeof entry !== 'object') continue;
        const visible = gameRooms[name];
        if (visible && visible.controller && visible.controller.my) continue;
        if (entry.owner) rooms.add(name);
    }
    state.hostileTerritory = { tick, rooms };
    return rooms;
}

const safeRoutes = new Map();
let safeRouteDanger = null;
let safeRouteSig = '';
function safeRouteExists(from, to, cacheTicks) {
    if (!from || !to || from === to) return true;
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.findRoute !== 'function') return true;
    const now = Game.time;
    const ttl = Number(cacheTicks) > 0 ? Number(cacheTicks) : 1000;
    const danger = dangerRooms();
    if (safeRouteDanger !== danger) {
        safeRouteDanger = danger;
        safeRouteSig = Array.from(danger).sort().join(',');
    }
    const key = from + '>' + to;
    const hit = safeRoutes.get(key);
    if (hit && hit.sig === safeRouteSig && now >= hit.at && now - hit.at < ttl) return hit.ok;
    const route = map.findRoute(from, to, { routeCallback: (roomName) => (roomName !== to && danger.has(roomName) ? Infinity : 1) });
    const ok = Array.isArray(route);
    safeRoutes.set(key, { ok, at: now, sig: safeRouteSig });
    return ok;
}

function resetSafeRoutes() {
    safeRoutes.clear();
    safeRouteDanger = null;
    safeRouteSig = '';
}

const detourRoutes = new Map();
function routeHitsBlock(from, to, blocks) {
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.findRoute !== 'function') return false;
    const sig = Array.from(blocks).sort().join(',');
    const key = from + '>' + to;
    const hit = detourRoutes.get(key);
    if (hit && hit.sig === sig && Game.time - hit.at < 100) return hit.hit;
    let route = null;
    try { route = map.findRoute(from, to); } catch (e) { route = null; }
    const res = Array.isArray(route) && route.some((step) => step && blocks.has(step.room) && step.room !== to);
    detourRoutes.set(key, { hit: res, at: Game.time, sig });
    return res;
}
function noteDetour(creep, pos) {
    const m = creep && creep.memory;
    if (!m || isCombatCreep(creep)) return;
    const blocks = highwayBlocks();
    const detouring = pos.roomName !== creep.pos.roomName && blocks.size > 0 && routeHitsBlock(creep.pos.roomName, pos.roomName, blocks);
    if (!detouring) {
        if (m.detour) {
            delete m.detour;
            resetCreepPath(creep);
            m.detourReset = { at: Game.time, why: 'cleared' };
        }
        return;
    }
    if (!m.detour || m.detour.to !== pos.roomName) { m.detour = { first: Game.time, since: Game.time, to: pos.roomName }; return; }
    const limit = Number((config.pvp || {}).detourTimeout) || 300;
    if (Game.time - m.detour.since >= limit) {
        m.detour.since = Game.time;
        m.detour.n = (Number(m.detour.n) || 0) + 1;
        resetCreepPath(creep);
        m.detourReset = { at: Game.time, why: 'timeout' };
    }
}
function detourStuck(creep) {
    const d = creep && creep.memory && creep.memory.detour;
    const limit = Number((config.pvp || {}).detourTimeout) || 300;
    return !!d && Game.time - Number(d.first) >= limit;
}

function go(creep, target, opts) {
    state.stats.calls += 1;
    const pos = toPos(creep, target, opts);
    if (!pos || !creep || !creep.pos || typeof creep.moveTo !== 'function') {
        state.stats.invalidTargets += 1;
        return resultCode('ERR_INVALID_TARGET', -7);
    }

    const moveOpts = normalizeOpts(creep, opts);
    if (rangeBetween(creep.pos, pos) <= moveOpts.range) {
        state.stats.inRange += 1;
        return resultCode('OK', 0);
    }
    if (pos.roomName !== creep.pos.roomName && moveOpts.avoidRooms === undefined && !isCombatCreep(creep) &&
        !civilianRouteOk(creep.pos.roomName, pos.roomName)) {
        state.stats.blockedWaits = (state.stats.blockedWaits || 0) + 1;
        if (creep.memory) creep.memory.blockedWait = Game.time;
        const refuge = civilianRefuge(creep.pos.roomName);
        if (refuge && refuge !== creep.pos.roomName) {
            state.stats.refugeMoves = (state.stats.refugeMoves || 0) + 1;
            if (creep.memory) creep.memory.blockedRefuge = refuge;
            const refugePos = new RoomPosition(25, 25, refuge);
            const refugeOpts = normalizeOpts(creep, Object.assign({}, opts || {}, { range: 20 }));
            applyDangerAvoidance(creep, refugePos, refugeOpts);
            if (loadEngine()) for (const key of UNSUPPORTED_MOVE_OPTIONS) delete refugeOpts[key];
            return creep.moveTo(refugePos, refugeOpts);
        }
        return resultCode('ERR_NO_PATH', -2);
    }
    applyDangerAvoidance(creep, pos, moveOpts);
    applyRangedAvoidance(creep, pos, moveOpts);
    noteDetour(creep, pos);

    const loaded = loadEngine();
    if (loaded) {
        for (const key of UNSUPPORTED_MOVE_OPTIONS) delete moveOpts[key];
        state.stats.engineCalls += 1;
    } else {
        state.stats.nativeCalls += 1;
    }
    return creep.moveTo(pos, moveOpts);
}

function memoryRoom(roomName) {
    if (!roomName || typeof Memory === 'undefined' || !Memory.rooms) return null;
    return Memory.rooms[roomName] || null;
}

function roomObject(roomName, creep) {
    if (typeof Game !== 'undefined' && Game.rooms && Game.rooms[roomName]) return Game.rooms[roomName];
    return creep && creep.room && creep.room.name === roomName ? creep.room : null;
}

function objectById(id) {
    if (!id || typeof Game === 'undefined' || typeof Game.getObjectById !== 'function') return null;
    return Game.getObjectById(id);
}

function activePart(creep, type) {
    const constant = runtimeGlobal[type.toUpperCase()] === undefined ? type : runtimeGlobal[type.toUpperCase()];
    if (creep && typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(constant) > 0;
    return !!(creep && creep.body || []).find((part) =>
        (part.type || part) === constant && (part.hits == null || part.hits > 0));
}

function energyKey() {
    return runtimeGlobal.RESOURCE_ENERGY === undefined ? 'energy' : runtimeGlobal.RESOURCE_ENERGY;
}

function storedEnergy(creep) {
    return creep && creep.store ? creep.store[energyKey()] || 0 : 0;
}

function freeCapacity(creep) {
    if (!creep || !creep.store || typeof creep.store.getFreeCapacity !== 'function') return null;
    return creep.store.getFreeCapacity(energyKey());
}

function structuresAt(room, spot) {
    if (!room || !spot || typeof room.lookForAt !== 'function') return [];
    const look = runtimeGlobal.LOOK_STRUCTURES === undefined ? 'structure' : runtimeGlobal.LOOK_STRUCTURES;
    const found = room.lookForAt(look, spot.x, spot.y);
    return Array.isArray(found) ? found : [];
}

function hasStructure(room, spot, typeName) {
    const type = runtimeGlobal[typeName] === undefined ? typeName.replace(/^STRUCTURE_/, '').toLowerCase() : runtimeGlobal[typeName];
    return structuresAt(room, spot).some((structure) => structure.structureType === type);
}

function sourceList(room) {
    const findSources = runtimeGlobal.FIND_SOURCES;
    if (!room || findSources === undefined || typeof room.find !== 'function') return [];
    const sources = room.find(findSources);
    return Array.isArray(sources) ? sources : [];
}

function harvesterSource(creep, room, roomMemory, plan) {
    const creepMemory = creep.memory || {};
    let source = objectById(creepMemory.sourceId);
    if (source) return source;
    const sources = sourceList(room);
    const ids = Array.isArray(plan && plan.sourceIds) ? plan.sourceIds :
        (Array.isArray(roomMemory && roomMemory.sources) ? roomMemory.sources : []);
    let index = Number.isInteger(creepMemory.sourceIdx) ? creepMemory.sourceIdx : 0;
    if (creepMemory.sourceId && ids.length) {
        const idIndex = ids.indexOf(creepMemory.sourceId);
        if (idIndex >= 0) index = idIndex;
    }
    if (ids[index]) source = sources.find((item) => item.id === ids[index]);
    return source || sources[index] || sources[0] || null;
}

function harvesterIndex(creep, roomMemory, plan) {
    const creepMemory = creep.memory || {};
    const ids = Array.isArray(plan && plan.sourceIds) ? plan.sourceIds :
        (Array.isArray(roomMemory && roomMemory.sources) ? roomMemory.sources : []);
    if (creepMemory.sourceId && ids.length) {
        const index = ids.indexOf(creepMemory.sourceId);
        if (index >= 0) return index;
    }
    return Number.isInteger(creepMemory.sourceIdx) ? creepMemory.sourceIdx : 0;
}

const workTileState = { tick: -1, byCreep: {} };

function harvesterWorkSpec(creep) {
    const home = creep.memory && creep.memory.home;
    if (!home || !creep.pos || creep.pos.roomName !== home) return null;
    const roomMemory = memoryRoom(home) || {};
    if (roomMemory.state && roomMemory.state.emergencyHarvest) return null;
    const room = roomObject(home, creep);
    const plan = roomMemory.plan || {};
    const source = harvesterSource(creep, room, roomMemory, plan);
    if (!source || !source.pos) return null;

    const index = harvesterIndex(creep, roomMemory, plan);
    const key = 'src' + index;
    const containerSpot = plan.containers && plan.containers[key];
    const workSpot = plan.workPositions && plan.workPositions[key] || containerSpot;
    const links = plan.links || {};
    const linkSpot = links[key] || (index === 0 ? links.src : null);
    const staticMode = workSpot && (hasStructure(room, containerSpot, 'STRUCTURE_CONTAINER') ||
        hasStructure(room, linkSpot, 'STRUCTURE_LINK'));
    if (staticMode) return { exact: { x: workSpot.x, y: workSpot.y, roomName: home } };

    if (creep.memory.dropMiner || !activePart(creep, 'carry')) return { near: source.pos, range: 1 };
    return { near: source.pos, range: 1, idle: 'hauling', source };
}

function upgraderWorkSpec(creep) {
    const home = creep.memory && creep.memory.home;
    if (!home || !creep.pos || creep.pos.roomName !== home) return null;
    const roomMemory = memoryRoom(home) || {};
    if (roomMemory.state && roomMemory.state.emergencyHarvest) return null;
    const room = roomObject(home, creep);
    const controller = room && room.controller;
    if (!controller || !controller.pos) return null;
    const station = layout.upgraderStation(room, roomMemory.plan || {});
    if (station && station.anchor) {
        const linkSpot = station.storageFed && typeof layout.linkSpot === 'function' ? layout.linkSpot(roomMemory.plan || {}, 'ctrl') : null;
        return { station, controller, linkSpot: linkSpot || null, idle: 'empty' };
    }
    return { near: controller.pos, range: 3, idle: 'empty' };
}

function remoteSourceRecord(creep, record) {
    const rawSources = record && record.sources;
    const sources = Array.isArray(rawSources) ? rawSources :
        (rawSources && typeof rawSources === 'object' ? Object.values(rawSources) : []);
    const sourceId = creep.memory && creep.memory.sourceId;
    if (sourceId) {
        const exact = sources.find((source) => source && source.id === sourceId);
        if (exact) return exact;
    }
    const index = Number.isInteger(creep.memory && creep.memory.srcIdx) ? creep.memory.srcIdx : 0;
    return sources[index] || sources[0] || null;
}

function remoteMinerWorkSpec(creep) {
    const creepMemory = creep.memory || {};
    const home = creepMemory.home;
    const remoteRoom = creepMemory.remoteRoom;
    if (!home || !remoteRoom || !creep.pos || creep.pos.roomName !== remoteRoom) return null;
    const homeMemory = memoryRoom(home);
    const record = homeMemory && homeMemory.remotes && homeMemory.remotes[remoteRoom];
    if (!record) return null;
    const source = remoteSourceRecord(creep, record);
    if (!source || !source.spot) return null;
    return { exact: { x: source.spot.x, y: source.spot.y, roomName: remoteRoom }, record };
}

function workSpecFor(creep, now) {
    if (workTileState.tick !== now) { workTileState.tick = now; workTileState.byCreep = {}; }
    const name = creep.name;
    const cached = name ? workTileState.byCreep[name] : null;
    if (cached && cached.creep === creep) return cached.spec;
    state.stats.workTileComputes += 1;
    const role = creep.memory.role;
    let spec = null;
    if (role === 'harvester') spec = harvesterWorkSpec(creep);
    else if (role === 'upgrader') spec = upgraderWorkSpec(creep);
    else if (role === 'remoteMiner') spec = remoteMinerWorkSpec(creep);
    if (name) workTileState.byCreep[name] = { creep, spec };
    return spec;
}

function isWorkTile(creep, pos) {
    try {
        if (!creep || !creep.memory || !pos) return true;
        const role = creep.memory.role;
        if (role !== 'harvester' && role !== 'upgrader' && role !== 'remoteMiner') return true;
        state.stats.workTileCalls += 1;
        const now = typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
        const spec = workSpecFor(creep, now);
        if (!spec) return true;
        if (spec.idle === 'empty' && storedEnergy(creep) <= 0) return true;
        if (spec.idle === 'hauling') {
            const free = freeCapacity(creep);
            if (free == null || free <= 0 || (spec.source.energy <= 0 && storedEnergy(creep) > 0)) return true;
        }
        if (spec.record && (spec.record.enabled === false || spec.record.suspendedUntil > now)) return true;
        if (spec.exact) return rangeBetween(pos, spec.exact) === 0;
        if (spec.station) {
            if (layout.atUpgraderStation(pos, spec.station, spec.controller)) return true;
            const spot = spec.linkSpot;
            return !!spot && rangeBetween(pos, { x: spot.x, y: spot.y, roomName: pos.roomName }) <= 1 && rangeBetween(pos, spec.controller.pos) <= 3;
        }
        return rangeBetween(pos, spec.near) <= spec.range;
    } catch (error) {
        state.stats.workTileErrors += 1;
        return true;
    }
}

const ROAD_SIG_INTERVAL = 50;
const ROAD_SIG_MIN_GAP = 200;
const FALLBACK_OBSTACLES = ['spawn', 'creep', 'powerCreep', 'source', 'mineral', 'deposit', 'controller', 'constructedWall', 'extension',
    'link', 'storage', 'tower', 'observer', 'powerSpawn', 'powerBank', 'lab', 'terminal', 'nuker', 'factory', 'invaderCore'];
let obstacleTypes = null;

function isObstacleType(type) {
    if (!obstacleTypes) {
        const list = typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && Array.isArray(OBSTACLE_OBJECT_TYPES) ? OBSTACLE_OBJECT_TYPES : FALLBACK_OBSTACLES;
        obstacleTypes = new Set(list);
    }
    return obstacleTypes.has(type);
}

function mixCell(cell, seed) {
    let h = (cell ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

function roomNetworkSignature(room) {
    const structures = utils.findCached(room, typeof FIND_STRUCTURES !== 'undefined' ? FIND_STRUCTURES : 'structures') || [];
    const roadType = typeof STRUCTURE_ROAD !== 'undefined' ? STRUCTURE_ROAD : 'road';
    const rampartType = typeof STRUCTURE_RAMPART !== 'undefined' ? STRUCTURE_RAMPART : 'rampart';
    let roads = 0;
    let obstacles = 0;
    for (const structure of structures) {
        const type = structure && structure.structureType;
        const pos = structure && structure.pos;
        if (!pos) continue;
        const cell = pos.x * 50 + pos.y + 1;
        if (type === roadType) roads = (roads + mixCell(cell, 0x9e3779b9)) >>> 0;
        else if (isObstacleType(type) || (type === rampartType && structure.my === false && !structure.isPublic)) {
            obstacles = (obstacles + mixCell(cell, 0x7f4a7c15)) >>> 0;
        }
    }
    return roads.toString(36) + ':' + obstacles.toString(36);
}

function refreshRoomNetworks() {
    if (typeof Game === 'undefined' || !Game.rooms) return;
    state.networks = state.networks || {};
    for (const name of Object.keys(Game.rooms)) {
        if (!utils.isRoomPhaseTick(name, ROAD_SIG_INTERVAL)) continue;
        const sig = roomNetworkSignature(Game.rooms[name]);
        const entry = state.networks[name];
        if (!entry) { state.networks[name] = { sig, inv: -Infinity }; continue; }
        if (entry.sig === sig || Game.time - entry.inv < ROAD_SIG_MIN_GAP) continue;
        if (Game.cpu && typeof Game.cpu.bucket === 'number' && Game.cpu.bucket < 1000) continue;
        invalidateRoom(name);
        entry.sig = sig;
        entry.inv = Game.time;
        state.stats.networkInvalidations = (Number(state.stats.networkInvalidations) || 0) + 1;
        if (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[name]) {
            const rec = Memory.rooms[name].pathRefresh || (Memory.rooms[name].pathRefresh = { n: 0 });
            rec.n = (Number(rec.n) || 0) + 1;
            rec.at = Game.time;
            rec.sig = sig;
            if (Game.rooms[name]) rec.regen = (Number(rec.regen) || 0) + 1;
        }
    }
}

function beginTick() {
    state.stats.beginTicks += 1;
    try { refreshRoomNetworks(); } catch (error) { state.lastNetworkError = error && error.message ? error.message : String(error); }
    return callEngine('preTickBetterMove', arguments);
}

function endTick(userIsWorkTile) {
    state.stats.endTicks += 1;
    return callEngine('endTickResolve', [typeof userIsWorkTile === 'function' ? userIsWorkTile : isWorkTile]);
}

function invalidateRoom(roomName) {
    if (!roomName) return resultCode('ERR_INVALID_ARGS', -10);
    state.stats.invalidations += 1;
    const loaded = loadEngine();
    if (!loaded) return undefined;
    if (typeof loaded.refreshRoom === 'function') return loaded.refreshRoom(roomName);
    const matrixResult = typeof loaded.deleteCostMatrix === 'function' ? loaded.deleteCostMatrix(roomName) : undefined;
    const pathResult = typeof loaded.deletePathInRoom === 'function' ? loaded.deletePathInRoom(roomName) : undefined;
    return pathResult === undefined ? matrixResult : pathResult;
}

function resetCreepPath(creep) {
    const name = creep && typeof creep === 'object' ? creep.name : creep;
    if (!name) return resultCode('ERR_INVALID_ARGS', -10);
    state.stats.creepResets += 1;
    const loaded = loadEngine();
    if (!loaded || typeof loaded.resetCreepPath !== 'function') return undefined;
    return loaded.resetCreepPath(name);
}

function stats() {
    return {
        calls: state.stats.calls,
        engineCalls: state.stats.engineCalls,
        nativeCalls: state.stats.nativeCalls,
        inRange: state.stats.inRange,
        invalidTargets: state.stats.invalidTargets,
        invalidations: state.stats.invalidations,
        creepResets: state.stats.creepResets,
        beginTicks: state.stats.beginTicks,
        endTicks: state.stats.endTicks,
        engineLoadErrors: state.stats.engineLoadErrors,
        workTileErrors: state.stats.workTileErrors,
        workTileCalls: state.stats.workTileCalls,
        workTileComputes: state.stats.workTileComputes,
        avoidKeptPaths: engine && typeof engine.avoidKeptPaths === 'function' ? engine.avoidKeptPaths() : 0,
        engineAvailable: !!engine,
        lastEngineError: state.lastEngineError || null,
    };
}

function passthrough(name) {
    return function () {
        return callEngine(name, arguments);
    };
}

api = {
    go,
    dangerRooms,
    beginTick,
    endTick,
    isWorkTile,
    invalidateRoom,
    resetCreepPath, noteDetour, detourStuck,
    keeperAvoidCallback,
    hostileTerritoryRooms,
    safeRouteExists, frozenOwnerRooms, civilianRefuge, rangedThreats, rangedAvoidCallback, highwayBlocks, civilianDangerRooms, civilianRouteOk, isHighwayRoom, isCombatCreep,
    resetSafeRoutes,
    knownLairs,
    noteKeeperTransit,
    stats,
    preTickBetterMove: beginTick,
    endTickResolve: passthrough('endTickResolve'),
    squadMove: passthrough('squadMove'),
    squadMoveTo: passthrough('squadMoveTo'),
    getSquadCostMatrix: passthrough('getSquadCostMatrix'),
    setPathClearDelay: passthrough('setPathClearDelay'),
    setHostileCostMatrixClearDelay: passthrough('setHostileCostMatrixClearDelay'),
    deleteCostMatrix: passthrough('deleteCostMatrix'),
    deletePath: passthrough('deletePath'),
    deletePathInRoom: passthrough('deletePathInRoom'),
    addAvoidRooms: passthrough('addAvoidRooms'),
    deleteAvoidRooms: passthrough('deleteAvoidRooms'),
    addAvoidExits: passthrough('addAvoidExits'),
    deleteAvoidExits: passthrough('deleteAvoidExits'),
    print: passthrough('print'),
    clear: passthrough('clear'),
};

module.exports = api;
