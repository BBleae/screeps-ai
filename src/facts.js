'use strict';

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const cache = runtimeGlobal.__factsCache || (runtimeGlobal.__factsCache = { at: -Infinity, data: null });
const REFRESH = 500;

function structuresOf(room, type) {
    if (!room || typeof room.find !== 'function') return [];
    const kind = typeof FIND_MY_STRUCTURES !== 'undefined' ? FIND_MY_STRUCTURES : 'myStructures';
    return (room.find(kind) || []).filter((s) => s && s.structureType === type);
}

function mineralOf(room) {
    if (typeof room.find !== 'function') return null;
    const list = room.find(typeof FIND_MINERALS !== 'undefined' ? FIND_MINERALS : 'minerals') || [];
    const m = list[0];
    if (!m || !m.pos) return null;
    const ext = structuresOf(room, typeof STRUCTURE_EXTRACTOR !== 'undefined' ? STRUCTURE_EXTRACTOR : 'extractor')[0];
    return { mineralId: m.id, mineralType: m.mineralType, pos: { x: m.pos.x, y: m.pos.y }, extractorId: ext ? ext.id : null };
}

function build() {
    const out = { owned: [], storage: [], terminal: [], factory: [], labs: {}, rcl: {}, rcl8: [], minerals: {} };
    for (const name of Object.keys(Game.rooms || {}).sort()) {
        const room = Game.rooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        out.owned.push(name);
        out.rcl[name] = room.controller.level;
        if (room.controller.level >= 8) out.rcl8.push(name);
        if (room.storage && room.storage.my !== false) out.storage.push(name);
        if (room.terminal && room.terminal.my !== false) out.terminal.push(name);
        if (structuresOf(room, typeof STRUCTURE_FACTORY !== 'undefined' ? STRUCTURE_FACTORY : 'factory').length) out.factory.push(name);
        const labs = structuresOf(room, typeof STRUCTURE_LAB !== 'undefined' ? STRUCTURE_LAB : 'lab').length;
        if (labs) out.labs[name] = labs;
        const mineral = mineralOf(room);
        if (mineral) out.minerals[name] = mineral;
    }
    return out;
}

function get(force) {
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    if (force || !cache.data || now - cache.at >= REFRESH || now < cache.at) {
        cache.data = build();
        cache.at = now;
        if (typeof Memory !== 'undefined') Memory.facts = Object.assign({ at: now }, cache.data);
    }
    return cache.data;
}

function mineral(roomName) {
    const all = get().minerals || {};
    return all[roomName] || null;
}

const MINERAL_KEYS = ['mineralId', 'mineralType', 'pos', 'extractorId'];
function withMineral(roomName, plan) {
    if (!plan) return plan;
    const live = mineral(roomName);
    if (!live) return plan;
    let out = plan;
    for (const k of MINERAL_KEYS) {
        if (plan[k] === undefined || live[k] == null) continue;
        if (JSON.stringify(plan[k]) === JSON.stringify(live[k])) continue;
        if (out === plan) out = Object.assign({}, plan);
        out[k] = live[k];
        noteMismatch(roomName, k, plan[k], live[k]);
    }
    return out;
}

function noteMismatch(roomName, key, was, now) {
    if (typeof Memory === 'undefined') return;
    const book = Memory.factsMismatch || (Memory.factsMismatch = {});
    const id = roomName + '.' + key;
    if (!book[id]) book[id] = { at: Game.time, config: was, live: now };
}

function factoryRooms() { return get().factory.slice(); }
function ownedRooms() { return get().owned.slice(); }
function rcl8Rooms() { return get().rcl8.slice(); }

module.exports = { get, mineral, withMineral, MINERAL_KEYS, factoryRooms, ownedRooms, rcl8Rooms, REFRESH };
