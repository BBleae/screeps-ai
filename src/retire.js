'use strict';
const config = require('config');
const utils = require('utils');
const movement = require('movement');

const state = { tick: -1, claimed: new Set() };

function settings() {
    return Object.assign({ walkShare: 0.8, tilesPerRoom: 50, recheckTicks: 10, crippledGrace: 10 }, config.retire || {});
}

function claimedThisTick() {
    if (state.tick !== Game.time) { state.tick = Game.time; state.claimed = new Set(); }
    return state.claimed;
}

function mySpawns() {
    const out = [];
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || typeof room.find !== 'function') continue;
        for (const spawn of room.find(FIND_MY_SPAWNS) || []) out.push(spawn);
    }
    return out;
}

function roomHops(from, to) {
    if (from === to) return 0;
    const map = typeof Game !== 'undefined' && Game.map;
    if (map && typeof map.findRoute === 'function') {
        const route = map.findRoute(from, to);
        if (!Array.isArray(route)) return null;
        if (route.length) return route.length;
    }
    return utils.roomDistance(from, to);
}

function rangeTo(pos, other) {
    return Math.max(Math.abs(pos.x - other.x), Math.abs(pos.y - other.y));
}

function travelTicks(creep, spawn, hops) {
    const tilesPerRoom = Number(settings().tilesPerRoom) || 50;
    const tiles = hops === 0 ? rangeTo(creep.pos, spawn.pos) : hops * tilesPerRoom + tilesPerRoom / 2;
    const perTile = utils.bodyTicksPerTile(creep.body);
    return perTile === Infinity ? Infinity : tiles * perTile;
}

function pickSpawn(creep) {
    let best = null;
    for (const spawn of mySpawns()) {
        if (!spawn || !spawn.pos) continue;
        const hops = roomHops(creep.pos.roomName, spawn.pos.roomName);
        if (!Number.isFinite(hops)) continue;
        const range = hops === 0 ? rangeTo(creep.pos, spawn.pos) : 0;
        if (!best || hops < best.hops || (hops === best.hops && range < best.range)) best = { spawn, hops, range };
    }
    return best;
}

function giveUp(creep) {
    delete creep.memory.retireSpawn;
    delete creep.memory.retireCheckAt;
    if (typeof creep.suicide === 'function') creep.suicide();
    return 'suicide';
}

function worthWalking(creep, spawn, hops) {
    const ttl = creep.ticksToLive == null ? Infinity : Number(creep.ticksToLive);
    return travelTicks(creep, spawn, hops) < settings().walkShare * ttl;
}

function retireAtSpawn(creep) {
    if (!creep || !creep.memory || !creep.pos) return 'wait';
    if (creep.spawning) return 'wait';
    let spawn = creep.memory.retireSpawn ? Game.getObjectById(creep.memory.retireSpawn) : null;
    if (!spawn || !spawn.pos) {
        delete creep.memory.retireSpawn;
        const pick = pickSpawn(creep);
        if (!pick || !worthWalking(creep, pick.spawn, pick.hops)) return giveUp(creep);
        spawn = pick.spawn;
        creep.memory.retireSpawn = spawn.id;
        creep.memory.retireCheckAt = Game.time;
    } else if (Game.time - Number(creep.memory.retireCheckAt || 0) >= settings().recheckTicks) {
        const hops = roomHops(creep.pos.roomName, spawn.pos.roomName);
        if (!Number.isFinite(hops) || !worthWalking(creep, spawn, hops)) return giveUp(creep);
        creep.memory.retireCheckAt = Game.time;
    }
    if (creep.pos.roomName === spawn.pos.roomName && creep.pos.isNearTo(spawn.pos)) {
        const claimed = claimedThisTick();
        if (claimed.has(spawn.id)) return 'wait';
        const ret = typeof spawn.recycleCreep === 'function' ? spawn.recycleCreep(creep) : ERR_INVALID_TARGET;
        if (ret !== OK) return giveUp(creep);
        claimed.add(spawn.id);
        return 'recycle';
    }
    const moved = movement.go(creep, spawn.pos, { range: 1, reusePath: 30 });
    if (moved === ERR_NO_PATH) return giveUp(creep);
    return 'walk';
}

function noteCrippled(creep, lost) {
    const home = creep.memory.home;
    if (!home || typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const log = Array.isArray(mem.crippledLog) ? mem.crippledLog : (mem.crippledLog = []);
    log.push({ name: creep.name, role: creep.memory.role, room: creep.pos.roomName, lost, ttl: creep.ticksToLive == null ? null : creep.ticksToLive, at: Game.time });
    while (log.length > 20) log.shift();
}

function retireCrippled(creep) {
    if (!creep || !creep.memory || creep.spawning) return false;
    const memory = creep.memory;
    const lost = utils.crippledParts(creep);
    if (!lost) {
        if (memory.crippled) { delete memory.retireSpawn; delete memory.retireCheckAt; }
        if (memory.crippled || memory.crippledSince != null) { delete memory.crippled; delete memory.crippledSince; }
        return false;
    }
    if (!memory.crippled) {
        if (memory.crippledSince == null) { memory.crippledSince = Game.time; return false; }
        if (Game.time - memory.crippledSince < settings().crippledGrace) return false;
        memory.crippled = Game.time;
        delete memory.crippledSince;
        noteCrippled(creep, lost);
    }
    retireAtSpawn(creep);
    return true;
}

function retirePocketTrapped(creep) {
    const trapped = creep && creep.memory && creep.memory.pocketTrapped;
    if (!trapped || creep.spawning) return false;
    const spawn = Game.getObjectById(trapped.spawn);
    if (!spawn || !spawn.pos || !creep.pos || creep.pos.roomName !== spawn.pos.roomName || creep.pos.x !== trapped.x || creep.pos.y !== trapped.y ||
        Math.max(Math.abs(creep.pos.x - spawn.pos.x), Math.abs(creep.pos.y - spawn.pos.y)) > 1) {
        delete creep.memory.pocketTrapped;
        return false;
    }
    const claimed = claimedThisTick();
    if (claimed.has(spawn.id)) return true;
    const ret = typeof spawn.recycleCreep === 'function' ? spawn.recycleCreep(creep) : ERR_INVALID_TARGET;
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[spawn.pos.roomName];
    const log = mem && mem.spawnStallLog && mem.spawnStallLog.trapped;
    if (log) { log.code = ret; log.codeAt = Game.time; }
    if (ret !== OK) { giveUp(creep); return true; }
    claimed.add(spawn.id);
    if (log) log.recycled = (Number(log.recycled) || 0) + 1;
    return true;
}

module.exports = { retireAtSpawn, retireCrippled, retirePocketTrapped };
