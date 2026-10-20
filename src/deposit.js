'use strict';
const config = require('config');
const { logErr } = require('utils');

const FIND_DEP = typeof FIND_DEPOSITS !== 'undefined' ? FIND_DEPOSITS : 122;

const DEFAULTS = {
    enabled: true,
    types: ['silicon', 'mist'],
    maxHops: 3,
    maxCooldown: 100,
    seenTtl: 1500,
    cacheTtl: 20000,
    routeTtl: 20000,
    minDecay: 1500,
    maxActive: 2,
    scanEvery: 20,
    cpuAvgMax: 145,
    cpuSamples: 10,
    minBucket: 3000,
    minRcl: 6,
    minBudget: 1950,
    maxSets: 5,
    scout: true,
    scoutRevisit: 1500,
    avoidRooms: [],
    pvpSkipTicks: 3000,
    allowRooms: [],
    preferNorthWest: true,
};

function settings() {
    return Object.assign({}, DEFAULTS, config.deposit || {});
}

function mem() {
    const m = Memory.deposits || (Memory.deposits = {});
    if (!m.list) m.list = {};
    if (!m.routes) m.routes = {};
    if (!m.visits) m.visits = {};
    return m;
}

function parseRoom(name) {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name || '');
    if (!m) return null;
    return { x: Number(m[2]), y: Number(m[4]), name };
}

function isHighway(name) {
    const p = parseRoom(name);
    return !!p && (p.x % 10 === 0 || p.y % 10 === 0);
}

function isKeeperRoom(name) {
    const p = parseRoom(name);
    if (!p) return false;
    const fx = p.x % 10, fy = p.y % 10;
    return fx >= 4 && fx <= 6 && fy >= 4 && fy <= 6 && !(fx === 5 && fy === 5);
}

function myName() {
    for (const n in Game.rooms) {
        const c = Game.rooms[n].controller;
        if (c && c.my && c.owner) return c.owner.username;
    }
    return null;
}

function blockedRoom(name, target, me) {
    if (name === target) return false;
    if (isKeeperRoom(name)) return true;
    if (require('utils').pvpDangerRoom(name)) return true;
    const info = Memory.map && Memory.map[name];
    if (info && info.owner && info.owner !== me) return true;
    return false;
}

function hops(home, target, cfg) {
    const m = mem();
    const key = home + ':' + target;
    const hit = m.routes[key];
    if (hit && Game.time - hit.at < cfg.routeTtl) return hit.h == null ? Infinity : hit.h;
    let h = null;
    if (Game.map.getRoomLinearDistance(home, target) <= cfg.maxHops) {
        const me = myName();
        const route = Game.map.findRoute(home, target, { routeCallback: (name) => (blockedRoom(name, target, me) ? Infinity : 1) });
        if (Array.isArray(route) && route.length <= cfg.maxHops) h = route.length;
    }
    m.routes[key] = { h, at: Game.time };
    return h == null ? Infinity : h;
}

function homes(cfg) {
    const out = [];
    for (const n in Game.rooms) {
        const r = Game.rooms[n];
        if (!r.controller || !r.controller.my || !r.terminal || (r.controller.level || 0) < cfg.minRcl) continue;
        out.push(r);
    }
    return out;
}

function note(room) {
    require('utils').notePvpThreat(room);
    if (!room || !isHighway(room.name)) return;
    const cfg = settings();
    const m = mem();
    m.visits[room.name] = Game.time;
    const highThreat = (config.pvp && config.pvp.highThreat) || [];
    const armed = room.find(FIND_HOSTILE_CREEPS).some((c) => {
        if (!c || !c.body) return false;
        const owner = c.owner && c.owner.username;
        if (owner && highThreat.indexOf(owner) >= 0) return true;
        return c.body.some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK));
    });
    for (const d of room.find(FIND_DEP)) {
        if (cfg.types.indexOf(d.depositType) < 0) continue;
        const prev = m.list[d.id] || {};
        m.list[d.id] = Object.assign(prev, {
            room: room.name, type: d.depositType, x: d.pos.x, y: d.pos.y,
            cd: d.lastCooldown || 0, decayAt: Game.time + (d.ticksToDecay || 0), at: Game.time,
            hostileUntil: armed ? Game.time + 300 : (prev.hostileUntil || 0),
        });
    }
}

function cpuOk(cfg) {
    if (Game.cpu.bucket < cfg.minBucket) return false;
    const stats = Array.isArray(Memory.stats) ? Memory.stats : [];
    const recent = stats.slice(-cfg.cpuSamples).map((s) => Number(s && s.cpu)).filter((v) => v > 0);
    if (!recent.length) return true;
    return recent.reduce((a, b) => a + b, 0) / recent.length <= cfg.cpuAvgMax;
}

function northWestScore(roomName) {
    const p = parseRoom(roomName);
    if (!p) return 0;
    const west = roomName[0] === 'W' ? -p.x : p.x;
    const north = roomName.indexOf('N') >= 0 ? p.y : -p.y;
    return north * 1000 + west;
}

function recentlyPvpDeposit(roomName, cfg) {
    const ticks = Number(cfg.pvpSkipTicks) || 0;
    if (!(ticks > 0) || !roomName) return false;
    const flee = Memory.pvpFlee && Memory.pvpFlee[roomName];
    if (flee && Number(flee.at) > 0 && Game.time - flee.at <= ticks) return true;
    const threat = Memory.pvpThreat && Memory.pvpThreat[roomName];
    if (!threat) return false;
    if (Number(threat.until) > Game.time) return true;
    if (Number(threat.at) > 0 && Game.time - threat.at <= ticks) return true;
    return false;
}

function workable(d, cfg) {
    if (!d || cfg.types.indexOf(d.type) < 0) return false;
    if ((cfg.avoidRooms || []).indexOf(d.room) >= 0) return false;
    const allow = cfg.allowRooms || [];
    if (allow.length && allow.indexOf(d.room) < 0) return false;
    if (require('utils').pvpDangerRoom(d.room)) return false;
    if (recentlyPvpDeposit(d.room, cfg)) return false;
    return Game.time - d.at <= cfg.seenTtl && d.cd <= cfg.maxCooldown &&
        d.decayAt - Game.time >= cfg.minDecay && !(d.hostileUntil > Game.time);
}

function run() {
    const cfg = settings();
    if (!cfg.enabled || Game.time % cfg.scanEvery !== 0) return;
    const m = mem();
    for (const n in Game.rooms) if (isHighway(n)) { try { note(Game.rooms[n]); } catch (e) { logErr('deposit.note ' + n, e); } }
    for (const id in m.list) {
        const d = m.list[id];
        if (Game.time - d.at > cfg.cacheTtl || d.decayAt < Game.time) delete m.list[id];
        else if (d.home && !workable(d, cfg)) d.home = null;
    }
    for (const k in m.routes) if (Game.time - m.routes[k].at > cfg.routeTtl) delete m.routes[k];
    for (const r in m.visits) if (Game.time - m.visits[r] > cfg.cacheTtl) delete m.visits[r];
    let active = Object.values(m.list).filter((d) => d.home).length;
    if (active >= cfg.maxActive || !cpuOk(cfg)) { m.gate = { at: Game.time, active, cpuOk: cpuOk(cfg) }; return; }
    const hs = homes(cfg);
    const candidates = Object.keys(m.list).filter((id) => !m.list[id].home && workable(m.list[id], cfg))
        .sort((a, b) => (m.list[a].cd - m.list[b].cd) ||
            (cfg.preferNorthWest ? (northWestScore(m.list[b].room) - northWestScore(m.list[a].room)) : 0));
    for (const id of candidates) {
        if (active >= cfg.maxActive) break;
        const d = m.list[id];
        let best = null, bestH = Infinity;
        for (const h of hs) {
            if (h.energyCapacityAvailable < cfg.minBudget) continue;
            const n = hops(h.name, d.room, cfg);
            if (n < bestH) { bestH = n; best = h; }
        }
        if (!best) { d.noHome = Game.time; continue; }
        d.home = best.name;
        d.hops = bestH;
        d.assignedAt = Game.time;
        active++;
    }
}

function minerBody(budget, cfg) {
    const set = ['work', 'work', 'work', 'carry', 'carry', 'move', 'move', 'move', 'move', 'move'];
    const n = Math.min(cfg.maxSets, Math.floor(budget / 650));
    if (n < 3) return [];
    const body = [];
    for (const type of ['work', 'carry', 'move']) for (let i = 0; i < n; i++) for (const p of set) if (p === type) body.push(p);
    return body;
}

function scoutHome(cfg) {
    const hs = homes(cfg).map((r) => r.name).sort();
    return hs.length ? hs[0] : null;
}

function patrolTargets(home, cfg) {
    const p = parseRoom(home);
    if (!p) return [];
    const m = mem();
    const out = [];
    const ew = home[0], ns = /[NS]/.exec(home)[0];
    for (let dx = -cfg.maxHops; dx <= cfg.maxHops; dx++) for (let dy = -cfg.maxHops; dy <= cfg.maxHops; dy++) {
        const x = p.x + dx, y = p.y + dy;
        if (x < 0 || y < 0) continue;
        const name = ew + x + ns + y;
        if (!isHighway(name)) continue;
        if ((cfg.avoidRooms || []).indexOf(name) >= 0) continue;
        if (Game.time - (m.visits[name] || 0) < cfg.scoutRevisit) continue;
        if (hops(home, name, cfg) === Infinity) continue;
        out.push(name);
    }
    return out.sort((a, b) => (m.visits[a] || 0) - (m.visits[b] || 0));
}

function getDemands(home) {
    const cfg = settings();
    if (!cfg.enabled || !home || !home.controller || !home.controller.my) return [];
    const out = [];
    if (Game.cpu.bucket < cfg.minBucket) return out;
    const m = Memory.deposits;
    if (m && m.list) {
        for (const id in m.list) {
            const d = m.list[id];
            if (d.home !== home.name || !workable(d, cfg)) continue;
            const body = minerBody(home.energyCapacityAvailable, cfg);
            if (!body.length) continue;
            out.push({ role: 'depositMiner', slot: 'deposit:' + id, body,
                memory: { role: 'depositMiner', slotKey: 'deposit:' + id, home: home.name, depositId: id, depositRoom: d.room },
                lead: body.length * 3 + (d.hops || 3) * 50, priority: 0, cls: 'opportunistic',
                bodyFor: (b) => minerBody(b, cfg) });
        }
    }
    if (cfg.scout && scoutHome(cfg) === home.name && cpuOk(cfg) && patrolTargets(home.name, cfg).length) {
        out.push({ role: 'depositScout', slot: 'depositScout', body: ['move'],
            memory: { role: 'depositScout', slotKey: 'depositScout', home: home.name }, lead: 0, priority: 1, cls: 'opportunistic' });
    }
    return out;
}

module.exports = {
    recentlyPvpDeposit, settings, run, note, hops, workable, cpuOk, minerBody, patrolTargets, getDemands, isHighway, isKeeperRoom, scoutHome };
