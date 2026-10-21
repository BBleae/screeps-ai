'use strict';

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const cache = runtimeGlobal.__factsCache || (runtimeGlobal.__factsCache = { at: -Infinity, data: null });
const REFRESH = 500;

function structuresOf(room, type) {
    if (!room || typeof room.find !== 'function') return [];
    const kind = typeof FIND_MY_STRUCTURES !== 'undefined' ? FIND_MY_STRUCTURES : 'myStructures';
    return (room.find(kind) || []).filter((s) => s && s.structureType === type);
}

function build() {
    const out = { owned: [], storage: [], terminal: [], factory: [], labs: {}, rcl: {}, rcl8: [] };
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

function factoryRooms() { return get().factory.slice(); }
function ownedRooms() { return get().owned.slice(); }
function rcl8Rooms() { return get().rcl8.slice(); }

module.exports = { get, factoryRooms, ownedRooms, rcl8Rooms, REFRESH };
