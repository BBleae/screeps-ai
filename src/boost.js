'use strict';
const config = require('config');
const movement = require('movement');

const MINERAL_PER_PART = typeof LAB_BOOST_MINERAL !== 'undefined' ? LAB_BOOST_MINERAL : 30;
const ENERGY_PER_PART = typeof LAB_BOOST_ENERGY !== 'undefined' ? LAB_BOOST_ENERGY : 20;

function maxWait(creep) {
    const own = creep && creep.memory && Number(creep.memory.boostWaitMax);
    if (own > 0) return own;
    const value = Number((config.conquest || {}).boostMaxWait);
    return Number.isFinite(value) && value > 0 ? value : 100;
}

function wanted(creep) {
    const mem = creep.memory || {};
    const list = Array.isArray(mem.boosts) ? mem.boosts : [];
    if (!list.length || mem.boostDone) return [];
    const applied = new Set((creep.body || []).map((part) => part.boost).filter(Boolean));
    const skipped = new Set(Array.isArray(mem.boostSkip) ? mem.boostSkip : []);
    return list.filter((compound) => !applied.has(compound) && !skipped.has(compound));
}

function partTypeFor(compound) {
    if (typeof BOOSTS === 'undefined' || !BOOSTS) return null;
    for (const partType of Object.keys(BOOSTS)) {
        if (BOOSTS[partType] && BOOSTS[partType][compound]) return partType;
    }
    return null;
}

function usableParts(lab, compound, parts, minParts) {
    const store = lab && lab.store;
    if (!store) return 0;
    const want = Math.max(1, parts);
    const n = Math.min(want, Math.floor(Number(store[compound] || 0) / MINERAL_PER_PART), Math.floor(Number(store[RESOURCE_ENERGY] || 0) / ENERGY_PER_PART));
    const floor = Number(minParts) > 0 ? Math.min(want, Math.floor(Number(minParts))) : want;
    return n >= floor ? n : 0;
}

function labFor(room, compound, parts, minParts) {
    const labs = room.find(FIND_MY_STRUCTURES).filter((s) => s.structureType === STRUCTURE_LAB);
    const roles = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].labRoles;
    const preferred = roles && roles.boost;
    if (preferred) labs.sort((a, b) => (b.id === preferred) - (a.id === preferred));
    for (const lab of labs) if (usableParts(lab, compound, parts, minParts) > 0) return lab;
    return null;
}

function roomStock(room, compound) {
    const labs = room.find(FIND_MY_STRUCTURES).filter((s) => s.structureType === STRUCTURE_LAB);
    return labs.reduce((sum, lab) => sum + Number((lab.store && lab.store[compound]) || 0), 0);
}

function boostRoomReady(creep) {
    const mem = creep.memory || {};
    const room = mem.boostRoom && Game.rooms[mem.boostRoom];
    if (!room || !room.controller || !room.controller.my) return false;
    const reserve = Number(mem.boostReserve) || 0;
    for (const compound of wanted(creep)) {
        const partType = partTypeFor(compound);
        const parts = (creep.body || []).filter((part) => part.type === partType && !part.boost).length;
        if (parts && roomStock(room, compound) - parts * MINERAL_PER_PART >= reserve) return true;
    }
    return false;
}

function nextJob(creep) {
    const room = creep.room;
    if (!room || !room.controller || !room.controller.my) return null;
    const home = creep.memory && (creep.memory.boostRoom || creep.memory.home);
    if (home && room.name !== home) return null;
    const reserve = Number(creep.memory && creep.memory.boostReserve) || 0;
    for (const compound of wanted(creep)) {
        const partType = partTypeFor(compound);
        if (!partType) continue;
        const parts = (creep.body || []).filter((part) => part.type === partType && !part.boost).length;
        if (!parts) continue;
        if (reserve > 0 && roomStock(room, compound) - parts * MINERAL_PER_PART < reserve) continue;
        const minParts = creep.memory && creep.memory.boostMinParts;
        const lab = labFor(room, compound, parts, minParts);
        if (lab) return { compound, partType, parts: usableParts(lab, compound, parts, minParts), lab, partial: usableParts(lab, compound, parts, minParts) < parts };
    }
    return null;
}

function pending(creep) {
    const mem = creep.memory || {};
    if (!Array.isArray(mem.boosts) || !mem.boosts.length || mem.boostDone) return false;
    if (!nextJob(creep) && !(mem.boostWait && wanted(creep).length && creep.room && creep.room.name === (mem.boostRoom || mem.home))) return false;
    if (mem.boostSince == null) mem.boostSince = Game.time;
    if (Game.time - mem.boostSince >= maxWait(creep)) {
        mem.boostDone = true;
        return false;
    }
    return true;
}

function noteBoost(creep, compound, partType, parts) {
    if (typeof Memory === 'undefined') return;
    const home = (creep.memory && creep.memory.home) || (creep.room && creep.room.name);
    if (!home) return;
    Memory.rooms = Memory.rooms || {};
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const log = Array.isArray(mem.boostLog) ? mem.boostLog : (mem.boostLog = []);
    log.unshift({ at: Game.time, creep: creep.name, role: creep.memory && creep.memory.role, compound, part: partType, parts, room: creep.room && creep.room.name });
    log.length = Math.min(log.length, 10);
}

function apply(creep) {
    const job = nextJob(creep);
    if (!job) return false;
    const ret = job.partial ? job.lab.boostCreep(creep, job.parts) : job.lab.boostCreep(creep);
    if (ret === ERR_NOT_IN_RANGE) { movement.go(creep, job.lab, { range: 1, reusePath: 10 }); return true; }
    if (ret === OK) { noteBoost(creep, job.compound, job.partType, job.parts); return true; }
    const mem = creep.memory;
    mem.boostSkip = (Array.isArray(mem.boostSkip) ? mem.boostSkip : []).concat([job.compound]);
    return false;
}

function run(creep) {
    if (!creep.memory || !Array.isArray(creep.memory.boosts) || !creep.memory.boosts.length) return false;
    if (!pending(creep)) return false;
    if (apply(creep)) return true;
    return !!(creep.memory.boostWait && !creep.memory.boostDone && wanted(creep).length && !nextJob(creep));
}

module.exports = { roomStock, boostRoomReady, wanted, partTypeFor, usableParts, labFor, nextJob, pending, apply, run, noteBoost, MINERAL_PER_PART, ENERGY_PER_PART };
