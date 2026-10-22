'use strict';
const config = require('config');

function settings() {
    return Object.assign({ rooms: {} }, config.sideLoot || {});
}

function roomCfg(target) {
    const c = settings().rooms[target];
    return c && c.enabled !== false ? c : null;
}

function mem(target) {
    const all = Memory.sideLoot || (Memory.sideLoot = {});
    return all[target] || (all[target] = {});
}

function armed(room) {
    const utils = require('utils');
    return (room.find(FIND_HOSTILE_CREEPS) || []).filter((c) => !utils.isAlly(c) && (c.body || []).some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK)));
}

function hostileTowers(room) {
    return (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_TOWER && s.store && Number(s.store[RESOURCE_ENERGY]) >= 10);
}

function observe(target) {
    const room = Game.rooms[target];
    if (!room || typeof room.find !== 'function') return null;
    const m = mem(target);
    if (m.at === Game.time) return m;
    const conquest = require('conquest');
    const left = {};
    let total = 0;
    for (const o of conquest.loadTargets(room)) {
        if (o.store) for (const k in o.store) { const n = Number(o.store[k]) || 0; if (n > 0) { left[k] = (left[k] || 0) + n; total += n; } }
        else if (o.resourceType) { left[o.resourceType] = (left[o.resourceType] || 0) + Number(o.amount || 0); total += Number(o.amount || 0); }
    }
    const threats = armed(room);
    const towers = hostileTowers(room);
    m.at = Game.time;
    m.left = left;
    m.total = total;
    m.threat = threats.length ? { n: threats.length, user: threats[0].owner && threats[0].owner.username, at: Game.time } : null;
    if (threats.length) m.threatAt = Game.time;
    m.towers = towers.length;
    m.owner = room.controller && room.controller.owner ? room.controller.owner.username : null;
    if (!total) { if (!m.doneAt) m.doneAt = Game.time; } else delete m.doneAt;
    return m;
}

function run() {
    for (const target of Object.keys(settings().rooms)) {
        if (!roomCfg(target)) continue;
        try { observe(target); } catch (e) { }
    }
}

function blocked(target, c) {
    const m = mem(target);
    if (m.doneAt) return 'done';
    if (m.towers > 0) return 'towers';
    if (m.threatAt && Game.time - m.threatAt < (Number(c.threatHold) || 300)) return 'threat';
    return null;
}

function bodyFor(budget, c) {
    const conquest = require('conquest');
    return conquest.repeatBody(['carry', 'move'], Math.min(budget, Number(c.budget) || 2500));
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const out = [];
    const rooms = settings().rooms;
    for (const target of Object.keys(rooms)) {
        const c = roomCfg(target);
        if (!c || c.home !== home.name) continue;
        const m = mem(target);
        const why = blocked(target, c);
        if (why) { m.wait = why; continue; }
        if (Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < (Number(c.minBucket) || 6000)) { m.wait = 'bucket'; continue; }
        const floor = Number(c.storageFloor) || 0;
        if (floor && home.storage && Number(home.storage.store[RESOURCE_ENERGY] || 0) < floor) { m.wait = 'floor'; continue; }
        delete m.wait;
        const n = Math.max(0, Number(c.haulers) || 0);
        const body = bodyFor(home.energyCapacityAvailable, c);
        for (let i = 0; i < n; i++) {
            const slot = 'side:' + target + ':' + home.name + ':' + i;
            out.push({ role: 'lootHauler', slot, body,
                memory: { role: 'lootHauler', slotKey: slot, home: home.name, targetRoom: target, sideLoot: true, lootOrder: Array.isArray(c.order) ? c.order.slice() : undefined },
                lead: Number(c.lead) || 100, priority: i, cls: 'opportunistic',
                bodyFor: (b) => bodyFor(b, c) });
        }
    }
    return out;
}

function orderScore(obj, order) {
    if (!obj || !Array.isArray(order) || !order.length) return 0;
    if (!obj.store) {
        const i = order.indexOf(obj.resourceType);
        return i >= 0 ? order.length - i : 0;
    }
    let best = 0;
    for (let i = 0; i < order.length; i++) if (Number(obj.store[order[i]]) > 0) { best = order.length - i; break; }
    return best;
}

module.exports = { settings, roomCfg, mem, observe, run, blocked, getDemands, bodyFor, orderScore, armed };
