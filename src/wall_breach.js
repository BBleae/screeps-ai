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
    return m;
}

function keyOf(target) {
    return target.room + ':' + target.x + ':' + target.y;
}

function isDone(key) {
    return !!(Memory.wallBreach && Memory.wallBreach.done && Memory.wallBreach.done[key]);
}

function pendingTargets() {
    return (settings().targets || []).filter((target) => !isDone(keyOf(target)));
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
    return structure.structureType === wallType && !structure.owner && structure.my !== true;
}

function fleeing(key) {
    const until = Memory.wallBreach && Memory.wallBreach.fleeUntil && Memory.wallBreach.fleeUntil[key];
    return !!(until && until > Game.time);
}

function getDemands(home) {
    const cfg = settings();
    if (!cfg.enabled || !home || !home.controller || !home.controller.my) return [];
    if (Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < cfg.minBucket) return [];
    const m = mem();
    const out = [];
    for (const target of pendingTargets()) {
        const key = keyOf(target);
        if (fleeing(key) || (m.blocked && m.blocked.key === key)) continue;
        const pvp = Memory.pvpThreat && Memory.pvpThreat[target.room];
        if (pvp && pvp.until > Game.time) continue;
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
    try { measureUnlocks(); } catch (error) { m.measureError = String(error && error.message || error); }
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

function measureUnlocks() {
    const cfg = settings();
    const m = mem();
    m.measured = m.measured || {};
    for (const homeName in cfg.unlock || {}) {
        const rule = cfg.unlock[homeName];
        if (!(rule.after || []).every(isDone)) continue;
        const home = Game.rooms[homeName];
        if (!home || !home.storage) continue;
        const allowed = new Set([homeName].concat((rule.rooms || []).map((entry) => entry.room), rule.via || []));
        const out = m.measured[homeName] = {};
        for (const entry of rule.rooms || []) {
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
            out[entry.room] = { steps, ok: steps.length > 0 && steps.every((n) => n != null && n <= entry.maxSteps), at: Game.time };
        }
    }
}

function unlockedRemotes(homeName) {
    const cfg = settings();
    const rule = cfg.unlock && cfg.unlock[homeName];
    if (!rule || !(rule.after || []).every(isDone)) return [];
    const measured = Memory.wallBreach && Memory.wallBreach.measured && Memory.wallBreach.measured[homeName];
    if (!measured) return [];
    return (rule.rooms || []).filter((entry) => measured[entry.room] && measured[entry.room].ok).map((entry) => entry.room);
}

module.exports = { settings, keyOf, isDone, pendingTargets, targetByKey, breakerBody, allowedWall, fleeing, getDemands, markDone,
    measureUnlocks, unlockedRemotes, mem };
