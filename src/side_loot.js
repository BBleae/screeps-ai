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

function isArmed(c) {
    const utils = require('utils');
    return !utils.isAlly(c) && (c.body || []).some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK));
}

function armed(room) {
    return (room.find(FIND_HOSTILE_CREEPS) || []).filter(isArmed);
}

function hostileTowers(room) {
    return (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_TOWER && s.store && Number(s.store[RESOURCE_ENERGY]) >= 10);
}

function homesOf(c) {
    if (c.homes && typeof c.homes === 'object') return c.homes;
    if (c.home) { const o = {}; o[c.home] = Number(c.haulers) || 0; return o; }
    return {};
}

function logEvent(target, e, d) {
    const m = mem(target);
    const ev = Array.isArray(m.events) ? m.events : (m.events = []);
    ev.push(Object.assign({ t: Game.time, e }, d || {}));
    while (ev.length > 30) ev.shift();
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
    if (!total) {
        if (!m.doneAt) { m.doneAt = Game.time; logEvent(target, 'done', {}); }
    } else delete m.doneAt;
    return m;
}

function remotePause(target, c) {
    const m = mem(target);
    const pr = c.pauseRemotes || {};
    if (!Object.keys(pr).length) return;
    if (m.doneAt) {
        if (m.remotesPaused && !m.remotesResumedAt) { m.remotesResumedAt = Game.time; logEvent(target, 'remotesResumed', { remotes: m.remotesPaused }); }
        return;
    }
    if (!m.remotesPaused) { m.remotesPaused = pr; m.remotesPausedAt = Game.time; logEvent(target, 'remotesPaused', { remotes: pr }); }
}

function run() {
    for (const target of Object.keys(settings().rooms)) {
        const c = roomCfg(target);
        if (!c) continue;
        try { observe(target); } catch (e) { }
        try { remotePause(target, c); } catch (e) { }
    }
}

function pausedRemotesFor(home) {
    const out = new Set();
    const rooms = settings().rooms;
    for (const target of Object.keys(rooms)) {
        const c = roomCfg(target);
        if (!c || !c.pauseRemotes) continue;
        const list = c.pauseRemotes[home];
        if (!Array.isArray(list) || !list.length) continue;
        if (mem(target).doneAt) continue;
        for (const r of list) out.add(r);
    }
    return out;
}

function filterRemoteDemands(home, demands) {
    if (!Array.isArray(demands) || !demands.length) return demands;
    const paused = pausedRemotesFor(home);
    if (!paused.size) return demands;
    return demands.filter((d) => !(d && d.memory && paused.has(d.memory.remoteRoom)));
}

function blocked(target, c) {
    const m = mem(target);
    if (m.doneAt) return 'done';
    if (m.towers > 0) return 'towers';
    if (m.threatAt && Game.time - m.threatAt < (Number(c.threatHold) || 300)) return 'threat';
    if (m.damageAt && Game.time - m.damageAt < (Number(c.damageHold) || 300)) return 'damage';
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
        if (!c) continue;
        const homes = homesOf(c);
        if (!(home.name in homes)) continue;
        const m = mem(target);
        const why = blocked(target, c);
        if (why) { m.wait = why; continue; }
        if (Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < (Number(c.minBucket) || 6000)) { m.wait = 'bucket'; continue; }
        const floor = Number(c.storageFloor) || 0;
        if (floor && home.storage && Number(home.storage.store[RESOURCE_ENERGY] || 0) < floor) { m.wait = 'floor:' + home.name; continue; }
        delete m.wait;
        const n = Math.max(0, Number(homes[home.name]) || 0);
        const body = bodyFor(home.energyCapacityAvailable, c);
        for (let i = 0; i < n; i++) {
            const slot = 'side:' + target + ':' + home.name + ':' + i;
            out.push({ role: 'lootHauler', slot, body,
                memory: { role: 'lootHauler', slotKey: slot, home: home.name, targetRoom: target, sideLoot: true, lootOrder: Array.isArray(c.order) ? c.order.slice() : undefined },
                lead: Number(c.lead) || 100, priority: i, cls: c.spawnClass || 'conquest',
                bodyFor: (b) => bodyFor(b, c) });
        }
    }
    return out;
}

function unloadRoom(creep, steps, ok) {
    const c = roomCfg(creep.memory.targetRoom);
    if (!c || !Array.isArray(c.unload) || !c.unload.length) return null;
    const list = c.unload.map((r) => [r, steps(creep.memory.targetRoom, r)]).filter((x) => Number.isFinite(x[1])).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
    for (const [name] of list) if (ok(Game.rooms[name])) return name;
    return null;
}

function noteDamage(creep) {
    const m = creep.memory;
    if (!m.sideLoot || !(creep.hits < creep.hitsMax)) return false;
    const target = m.targetRoom;
    const sm = mem(target);
    if (!(sm.damageAt === Game.time)) {
        sm.damageAt = Game.time;
        logEvent(target, 'haulerDamaged', { name: creep.name, room: creep.room.name, hits: creep.hits, hitsMax: creep.hitsMax });
    }
    return true;
}

function avoidCallback(room, radius) {
    if (!room || typeof room.find !== 'function') return null;
    const list = armed(room);
    if (!list.length) return null;
    const r = Number(radius) || 5;
    const name = room.name;
    const pts = list.map((c) => ({ x: c.pos.x, y: c.pos.y }));
    return function (roomName, cm) {
        if (roomName !== name || !cm || typeof cm.set !== 'function') return cm;
        for (const p of pts) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
            const x = p.x + dx, y = p.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (cm.get(x, y) >= 255) continue;
            cm.set(x, y, 250);
        }
        return cm;
    };
}

function moveOpts(creep, opts) {
    if (!creep.memory.sideLoot) return opts;
    const c = roomCfg(creep.memory.targetRoom) || {};
    const cb = avoidCallback(creep.room, c.avoidRadius);
    if (!cb) return opts;
    return Object.assign({}, opts, { costCallback: cb, reusePath: Math.min(Number(opts && opts.reusePath) || 5, 3) });
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

module.exports = { settings, roomCfg, mem, observe, run, blocked, getDemands, bodyFor, orderScore, armed, homesOf, pausedRemotesFor, filterRemoteDemands, remotePause, unloadRoom, noteDamage, avoidCallback, moveOpts, logEvent };
