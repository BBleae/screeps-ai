'use strict';
const config = require('config');
const utils = require('utils');
const movement = require('movement');

const SPAWN_DIR_OFFSETS = [null, [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const ALL_DIRECTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

function settings() {
    return Object.assign({ minTiles: 10, stallTicks: 5, vacateAt: 1, vacateHoldTicks: 10, vacateSearch: 3, trappedScanInterval: 20 },
        config.spawnPocket || {});
}

function spawnBlocksMovement(structure) {
    const type = structure && structure.structureType;
    if (!type || type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER) return false;
    if (type === STRUCTURE_RAMPART) return structure.my === false && !structure.isPublic;
    return true;
}

function walkability(room, opts) {
    const withSites = !(opts && opts.sites === false);
    const blocked = new Set();
    const roads = new Set();
    for (const s of utils.findCached(room, FIND_STRUCTURES) || []) {
        if (!s || !s.pos) continue;
        if (s.structureType === STRUCTURE_ROAD) roads.add(s.pos.x * 50 + s.pos.y);
        else if (spawnBlocksMovement(s)) blocked.add(s.pos.x * 50 + s.pos.y);
    }
    for (const site of withSites ? room.find(FIND_MY_CONSTRUCTION_SITES) || [] : []) {
        if (site && site.pos && spawnBlocksMovement({ structureType: site.structureType, my: true })) blocked.add(site.pos.x * 50 + site.pos.y);
    }
    for (const kind of [FIND_SOURCES, FIND_MINERALS]) {
        for (const o of room.find(kind) || []) if (o && o.pos) blocked.add(o.pos.x * 50 + o.pos.y);
    }
    const terrain = room.getTerrain();
    return (x, y) => x >= 0 && x <= 49 && y >= 0 && y <= 49 && !blocked.has(x * 50 + y) &&
        (!(terrain.get(x, y) & TERRAIN_MASK_WALL) || roads.has(x * 50 + y));
}

function dirTile(spawn, dir) {
    return { x: spawn.pos.x + SPAWN_DIR_OFFSETS[dir][0], y: spawn.pos.y + SPAWN_DIR_OFFSETS[dir][1] };
}

function dirOf(spawn, pos) {
    for (let dir = 1; dir <= 8; dir++) {
        const t = dirTile(spawn, dir);
        if (t.x === pos.x && t.y === pos.y) return dir;
    }
    return null;
}

function computeSpawnDirections(room, spawn, walk) {
    const minTiles = Math.max(2, Number(settings().minTiles) || 10);
    const walkable = walk || walkability(room);
    const regionReaches = (sx, sy) => {
        const seen = new Set([sx * 50 + sy]);
        const queue = [[sx, sy]];
        while (queue.length && seen.size < minTiles) {
            const [x, y] = queue.shift();
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                const key = nx * 50 + ny;
                if (seen.has(key) || !walkable(nx, ny)) continue;
                seen.add(key);
                queue.push([nx, ny]);
            }
        }
        return seen.size >= minTiles;
    };
    const open = [];
    const pockets = [];
    for (let dir = 1; dir <= 8; dir++) {
        const { x, y } = dirTile(spawn, dir);
        if (!walkable(x, y)) continue;
        if (regionReaches(x, y)) open.push(dir);
        else pockets.push(dir);
    }
    return { open, pockets };
}

function stallLog(mem) {
    return mem.spawnStallLog || (mem.spawnStallLog = { n: 0 });
}

function roomMem(roomName) {
    if (typeof Memory === 'undefined' || !Memory.rooms || !roomName) return null;
    return Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
}

function hasActive(creep, type) {
    return (creep.body || []).some((part) => part.type === type && part.hits !== 0);
}

function requestVacate(room, mem, spawn, sp, walk) {
    const dirs = Array.isArray(sp.directions) && sp.directions.length ? sp.directions : ALL_DIRECTIONS;
    const own = [];
    for (const dir of dirs) {
        const t = dirTile(spawn, dir);
        if (t.x < 1 || t.x > 48 || t.y < 1 || t.y > 48 || !walk(t.x, t.y)) continue;
        const creeps = typeof room.lookForAt === 'function' ? room.lookForAt(LOOK_CREEPS, t.x, t.y) || [] : [];
        if (!creeps.length) return null;
        for (const creep of creeps) if (creep && creep.my !== false && creep.memory) own.push({ creep, x: t.x, y: t.y });
    }
    if (!own.length) return null;
    const active = own.find((b) => b.creep.memory.vacate && b.creep.memory.vacate.name === sp.name && Number(b.creep.memory.vacate.until) >= Game.time);
    if (active) return active.creep.name;
    const log = stallLog(mem);
    const key = spawn.name || spawn.id;
    const movable = own.filter((b) => hasActive(b.creep, MOVE));
    if (!movable.length) {
        const prev = log.cannotVacate;
        if (!prev || prev.name !== sp.name || prev.spawn !== key) {
            log.cannotVacate = { n: (Number(prev && prev.n) || 0) + 1, at: Game.time, spawn: key, name: sp.name,
                blockers: own.map((b) => b.creep.name).slice(0, 4), reason: 'noMove' };
        }
        return null;
    }
    const pick = movable.find((b) => !(b.creep.fatigue > 0)) || movable[0];
    const s = settings();
    pick.creep.memory.vacate = { spawn: spawn.id, name: sp.name, x: pick.x, y: pick.y, until: Game.time + Math.max(2, Number(s.vacateHoldTicks) || 10) };
    const prev = log.vacate || {};
    log.vacate = { n: (Number(prev.n) || 0) + 1, at: Game.time, spawn: key, name: sp.name, blocker: pick.creep.name,
        role: pick.creep.memory.role || null, x: pick.x, y: pick.y, fatigue: pick.creep.fatigue || 0, moved: Number(prev.moved) || 0,
        failed: Number(prev.failed) || 0 };
    return pick.creep.name;
}

function noteBorn(room, mem, spawn, rec) {
    const creep = Game.creeps && Game.creeps[rec.name];
    if (!creep || creep.spawning || !creep.pos || creep.pos.roomName !== spawn.pos.roomName) return;
    const dir = dirOf(spawn, creep.pos);
    const pocket = dir != null && computeSpawnDirections(room, spawn, walkability(room, { sites: false })).pockets.includes(dir);
    const log = stallLog(mem);
    log.born = { at: Game.time, spawn: spawn.name || spawn.id, name: rec.name, x: creep.pos.x, y: creep.pos.y, dir,
        waited: rec.since != null ? Game.time - rec.since : 0, vacate: rec.vacate || null, released: !!rec.done, pocket };
    if (pocket) log.bornPocket = (Number(log.bornPocket) || 0) + 1;
    const history = Array.isArray(log.bornHistory) ? log.bornHistory : (log.bornHistory = []);
    history.push({ at: Game.time, spawn: log.born.spawn, name: rec.name, x: creep.pos.x, y: creep.pos.y, pocket, vacate: rec.vacate || null });
    while (history.length > 10) history.shift();
}

function releaseStalledSpawns(room, mem, spawns) {
    const s = settings();
    const stallTicks = Math.max(1, Number(s.stallTicks) || 5);
    const vacateAt = Number.isFinite(Number(s.vacateAt)) ? Number(s.vacateAt) : 1;
    let stall = mem.spawnStall;
    let walk = null;
    for (const spawn of spawns || []) {
        const sp = spawn && spawn.spawning;
        const key = spawn && (spawn.name || spawn.id);
        let rec = stall && stall[key];
        if (rec && (!sp || sp.name !== rec.name || !(Number(sp.remainingTime) <= vacateAt))) {
            if (!sp || sp.name !== rec.name) {
                try { noteBorn(room, mem, spawn, rec); } catch (error) { utils.logErr('spawnExit.noteBorn ' + room.name, error); }
            }
            delete stall[key];
            rec = null;
        }
        if (!sp) continue;
        const remaining = Number(sp.remainingTime);
        if (!(remaining <= vacateAt)) continue;
        const stalled = remaining <= 0;
        if (!walk) walk = walkability(room);
        const vacate = requestVacate(room, mem, spawn, sp, walk);
        if (!rec && (stalled || vacate)) {
            stall = stall || (mem.spawnStall = {});
            rec = stall[key] = { name: sp.name, since: stalled ? Game.time : null };
        }
        if (!rec) continue;
        if (vacate) rec.vacate = vacate;
        if (stalled && rec.since == null) rec.since = Game.time;
        if (!stalled || rec.done || Game.time - rec.since < stallTicks) continue;
        rec.done = Game.time;
        const log = stallLog(mem);
        const dirs = Array.isArray(sp.directions) && sp.directions.length ? sp.directions.slice() : null;
        if (!dirs || ALL_DIRECTIONS.every((d) => dirs.includes(d))) {
            log.surrounded = { at: Game.time, spawn: key, name: sp.name, waited: Game.time - rec.since };
            continue;
        }
        const extra = computeSpawnDirections(room, spawn, walk).open.filter((d) => !dirs.includes(d));
        if (!extra.length) {
            log.noRelease = { at: Game.time, spawn: key, name: sp.name, waited: Game.time - rec.since, from: dirs };
            continue;
        }
        const to = dirs.concat(extra);
        const code = typeof sp.setDirections === 'function' ? sp.setDirections(to) : null;
        log.n = (Number(log.n) || 0) + 1;
        log.at = Game.time;
        log.spawn = key;
        log.name = sp.name;
        log.waited = Game.time - rec.since;
        log.from = dirs;
        log.to = to;
        log.code = code;
    }
    if (stall && !Object.keys(stall).length) delete mem.spawnStall;
}

function vacateTarget(creep, room) {
    const walk = walkability(room);
    const spawns = room.find(FIND_MY_SPAWNS) || [];
    const nearSpawn = (x, y) => spawns.some((sp) => sp && sp.pos && Math.max(Math.abs(sp.pos.x - x), Math.abs(sp.pos.y - y)) <= 1);
    const occupied = (x, y) => typeof room.lookForAt === 'function' && (room.lookForAt(LOOK_CREEPS, x, y) || []).length > 0;
    const limit = Math.max(1, Number(settings().vacateSearch) || 3);
    const start = creep.pos;
    const seen = new Set([start.x * 50 + start.y]);
    let frontier = [[start.x, start.y]];
    for (let depth = 1; depth <= limit && frontier.length; depth++) {
        const next = [];
        for (const [x, y] of frontier) {
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                const key = nx * 50 + ny;
                if (seen.has(key) || nx < 1 || nx > 48 || ny < 1 || ny > 48 || !walk(nx, ny)) continue;
                seen.add(key);
                if (!nearSpawn(nx, ny) && !occupied(nx, ny)) return { x: nx, y: ny };
                next.push([nx, ny]);
            }
        }
        frontier = next;
    }
    return null;
}

function vacateLog(roomName) {
    const mem = roomMem(roomName);
    if (!mem) return {};
    const log = stallLog(mem);
    return log.vacate || (log.vacate = { n: 0, moved: 0, failed: 0 });
}

function runVacate(creep) {
    const v = creep && creep.memory && creep.memory.vacate;
    if (!v) return false;
    const spawn = Game.getObjectById(v.spawn);
    const sp = spawn && spawn.spawning;
    if (!spawn || !spawn.pos || !sp || sp.name !== v.name || !(Number(v.until) >= Game.time)) {
        delete creep.memory.vacate;
        return false;
    }
    if (creep.spawning) return false;
    if (creep.pos.roomName !== spawn.pos.roomName ||
        Math.max(Math.abs(creep.pos.x - spawn.pos.x), Math.abs(creep.pos.y - spawn.pos.y)) > 1) return true;
    const log = vacateLog(spawn.pos.roomName);
    if (!hasActive(creep, MOVE)) {
        delete creep.memory.vacate;
        log.failed = (Number(log.failed) || 0) + 1;
        log.failedWhy = { at: Game.time, name: creep.name, why: 'noMove' };
        return false;
    }
    if (creep.fatigue > 0) return true;
    const room = spawn.room || (Game.rooms && Game.rooms[spawn.pos.roomName]);
    const target = room && vacateTarget(creep, room);
    if (!target) {
        delete creep.memory.vacate;
        log.failed = (Number(log.failed) || 0) + 1;
        log.failedWhy = { at: Game.time, name: creep.name, why: 'noTile' };
        return false;
    }
    movement.go(creep, new RoomPosition(target.x, target.y, spawn.pos.roomName), { range: 0, priority: 2, reusePath: 0 });
    if (v.moved == null) {
        v.moved = Game.time;
        log.moved = (Number(log.moved) || 0) + 1;
        log.last = { at: Game.time, name: creep.name, from: { x: creep.pos.x, y: creep.pos.y }, to: target };
    }
    return true;
}

function markPocketTrapped(room, mem, spawns) {
    const interval = Math.max(1, Number(settings().trappedScanInterval) || 20);
    if (!(spawns && spawns.length) || !utils.isRoomPhaseTick(room.name, interval) || typeof room.lookForAt !== 'function') return 0;
    let walk = null;
    let marked = 0;
    for (const spawn of spawns) {
        if (!spawn || !spawn.pos) continue;
        if (!walk) walk = walkability(room, { sites: false });
        const { pockets } = computeSpawnDirections(room, spawn, walk);
        for (const dir of pockets) {
            const t = dirTile(spawn, dir);
            for (const creep of room.lookForAt(LOOK_CREEPS, t.x, t.y) || []) {
                if (!creep || creep.my === false || !creep.memory || creep.spawning || creep.memory.pocketTrapped) continue;
                const seen = creep.memory.pocketSeen;
                if (seen && Number(seen.at) === Game.time) continue;
                if (!seen || seen.x !== t.x || seen.y !== t.y || !(Game.time - Number(seen.at) <= interval)) {
                    creep.memory.pocketSeen = { x: t.x, y: t.y, at: Game.time };
                    continue;
                }
                delete creep.memory.pocketSeen;
                creep.memory.pocketTrapped = { spawn: spawn.id, x: t.x, y: t.y, at: Game.time };
                const log = stallLog(mem);
                const prev = log.trapped || {};
                log.trapped = { n: (Number(prev.n) || 0) + 1, at: Game.time, spawn: spawn.name || spawn.id, name: creep.name,
                    role: creep.memory.role || null, x: t.x, y: t.y, recycled: Number(prev.recycled) || 0 };
                marked++;
            }
        }
    }
    return marked;
}

module.exports = { SPAWN_DIR_OFFSETS, ALL_DIRECTIONS, walkability, computeSpawnDirections, releaseStalledSpawns, requestVacate, runVacate,
    vacateTarget, markPocketTrapped, settings };
