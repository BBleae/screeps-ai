'use strict';
const config = require('config');

function settings() {
    return Object.assign({ enabled: false, targets: [], unlock: {}, maxPairs: 10, fallbackAfter: 600, fleeTicks: 300, minBucket: 3000 },
        config.wallBreach || {});
}

function mem() {
    const m = Memory.wallBreach || (Memory.wallBreach = {});
    m.done = m.done || {};
    m.askedAt = m.askedAt || {};
    m.fleeUntil = m.fleeUntil || {};
    m.skip = m.skip || {};
    return m;
}

function keyOf(target) {
    return target.room + ':' + target.x + ':' + target.y;
}

function isDone(key) {
    return !!(Memory.wallBreach && Memory.wallBreach.done && Memory.wallBreach.done[key]);
}

function isSkipped(key) {
    return !!(Memory.wallBreach && Memory.wallBreach.skip && Memory.wallBreach.skip[key]);
}

function pendingTargets() {
    return (settings().targets || []).filter((target) => !isDone(keyOf(target)) && !isSkipped(keyOf(target)));
}

function targetByKey(key) {
    return (settings().targets || []).find((target) => keyOf(target) === key) || null;
}

function breakerBody(budget, maxPairs) {
    const pairs = Math.min(Math.max(0, Number(maxPairs) || 10), Math.floor((Number(budget) || 0) / 150));
    const body = [];
    for (let i = 0; i < pairs; i++) body.push('work');
    for (let i = 0; i < pairs; i++) body.push('move');
    return body;
}

function allowedWall(structure) {
    if (!structure) return false;
    const wallType = typeof STRUCTURE_WALL === 'undefined' ? 'constructedWall' : STRUCTURE_WALL;
    return structure.structureType === wallType && !structure.owner && structure.my !== true && Number(structure.hits) > 0;
}

function fleeing(key) {
    const until = Memory.wallBreach && Memory.wallBreach.fleeUntil && Memory.wallBreach.fleeUntil[key];
    return !!(until && until > Game.time);
}

function workable(target) {
    const key = keyOf(target);
    if (fleeing(key)) return false;
    const blocked = Memory.wallBreach && Memory.wallBreach.blocked;
    if (blocked && blocked.key === key) return false;
    const pvp = Memory.pvpThreat && Memory.pvpThreat[target.room];
    return !(pvp && pvp.until > Game.time);
}

function nextTargetFor(homeName) {
    return pendingTargets().find((target) => (target.home === homeName || target.fallbackHome === homeName) && workable(target)) || null;
}

function getDemands(home) {
    const cfg = settings();
    if (!cfg.enabled || !home || !home.controller || !home.controller.my) return [];
    if (Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < cfg.minBucket) return [];
    const m = mem();
    if (cfg.unlock && cfg.unlock[home.name] && Game.time % 100 === 0) {
        try { measureUnlocks(); } catch (error) { m.measureError = String(error && error.message || error); }
    }
    const out = [];
    for (const target of pendingTargets()) {
        const key = keyOf(target);
        if (!workable(target)) continue;
        let mine = target.home === home.name;
        if (mine && !m.askedAt[key]) m.askedAt[key] = Game.time;
        if (!mine && target.fallbackHome === home.name && m.askedAt[key] && Game.time - m.askedAt[key] >= cfg.fallbackAfter) mine = true;
        if (!mine) continue;
        const body = breakerBody(home.energyCapacityAvailable, cfg.maxPairs);
        if (!body.length) continue;
        out.push({ role: 'wallBreaker', slot: 'breach:' + key, body,
            memory: { role: 'wallBreaker', slotKey: 'breach:' + key, home: home.name, breachKey: key },
            lead: 0, priority: 0, bodyFor: (budget) => breakerBody(budget, cfg.maxPairs) });
        break;
    }
    return out;
}

function markDone(key) {
    const m = mem();
    if (m.done[key]) return;
    m.done[key] = Game.time;
    try { measureUnlocks(key); } catch (error) { m.measureError = String(error && error.message || error); }
}

function markSkipped(key, types) {
    const m = mem();
    m.blocked = { key, at: Game.time, types: types || [] };
    m.skip[key] = Game.time;
}

function entryAfter(rule, entry) {
    return (rule.after || []).concat(entry.after || []);
}

function entryReady(rule, entry) {
    return entryAfter(rule, entry).every(isDone);
}

function blockingCost(room) {
    const matrix = new PathFinder.CostMatrix();
    for (const structure of room.find(FIND_STRUCTURES)) {
        const type = structure.structureType;
        if (type === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
        else if (type === STRUCTURE_CONTAINER || (type === STRUCTURE_RAMPART && structure.my)) continue;
        else matrix.set(structure.pos.x, structure.pos.y, 255);
    }
    return matrix;
}

function measureUnlocks(doneKey) {
    const cfg = settings();
    const m = mem();
    m.measured = m.measured || {};
    for (const homeName in cfg.unlock || {}) {
        const rule = cfg.unlock[homeName];
        const home = Game.rooms[homeName];
        if (!home || !home.storage) continue;
        const prior = m.measured[homeName] || {};
        const due = (rule.rooms || []).filter((entry) => entryReady(rule, entry) &&
            (!prior[entry.room] || (doneKey && entryAfter(rule, entry).includes(doneKey))));
        if (!due.length) continue;
        const out = m.measured[homeName] = prior;
        for (const entry of due) {
            const cpuFrom = Game.cpu && typeof Game.cpu.getUsed === 'function' ? Game.cpu.getUsed() : 0;
            const allowed = new Set([homeName, entry.room].concat(rule.via || [], entry.via || []));
            const steps = (entry.sources || []).map((source) => {
                const result = PathFinder.search(home.storage.pos, { pos: new RoomPosition(source.x, source.y, entry.room), range: 1 }, {
                    plainCost: 2, swampCost: 8, maxRooms: allowed.size + 1, maxOps: 20000,
                    roomCallback: (roomName) => {
                        if (!allowed.has(roomName)) return false;
                        const room = Game.rooms[roomName];
                        return room ? blockingCost(room) : undefined;
                    },
                });
                return result.incomplete ? null : result.path.length;
            });
            const cpu = Game.cpu && typeof Game.cpu.getUsed === 'function' ? Math.round((Game.cpu.getUsed() - cpuFrom) * 100) / 100 : null;
            out[entry.room] = { steps, ok: steps.length > 0 && steps.every((n) => n != null && n <= entry.maxSteps), at: Game.time, cpu };
        }
    }
}

function unlockedRemotes(homeName) {
    const cfg = settings();
    const rule = cfg.unlock && cfg.unlock[homeName];
    if (!rule) return [];
    const measured = Memory.wallBreach && Memory.wallBreach.measured && Memory.wallBreach.measured[homeName];
    if (!measured) return [];
    return (rule.rooms || []).filter((entry) => entryReady(rule, entry) && measured[entry.room] && measured[entry.room].ok)
        .map((entry) => entry.room);
}

module.exports = { settings, keyOf, isDone, isSkipped, pendingTargets, targetByKey, breakerBody, allowedWall, fleeing, workable,
    nextTargetFor, getDemands, markDone, markSkipped, measureUnlocks, unlockedRemotes, mem };
