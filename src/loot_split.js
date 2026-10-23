'use strict';
const config = require('config');

function settings() {
    return Object.assign({ every: 5, minTtl: 1000, spawnTicks: 150, finalRooms: ['W35S1', 'W37S2'], guard: { rooms: ['W39S0', 'W39S1'], clear: 100, maxMult: 16, hold: 1500, lend: 'W37S2' } }, (config.conquest || {}).lootSplitRun || {});
}

function quota(v, dflt) {
    if (v == null || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, n) : dflt;
}

function reliefTtl(s, cfg) {
    if (Number(s.reliefTtl) > 0) return Number(s.reliefTtl);
    const hauler = require('roles_lootHauler');
    const unload = s.unload || ((config.conquest || {}).lootDropFixed || {})[s.target];
    if (!unload) return 0;
    const back = hauler.pathSteps(s.target, unload);
    const out = hauler.pathSteps(unload, s.target);
    if (!Number.isFinite(back) || !Number.isFinite(out)) return 0;
    return Math.round(back * 1.2 + 50 + out + (Number(cfg.spawnTicks) || 0));
}

function lockOf(m) {
    if (!m) return null;
    if (m.lootLock) return m.lootLock;
    return m.w35lock ? 'W35S1' : null;
}

function haulers() {
    const out = [];
    for (const name of Object.keys(Game.creeps || {})) {
        const c = Game.creeps[name];
        if (c && c.memory && c.memory.role === 'lootHauler') out.push(c);
    }
    return out;
}

function pool() {
    const out = [];
    for (const c of haulers()) {
        const m = c.memory;
        if (c.spawning || lockOf(m)) continue;
        if (m.sideLoot || m.pullLoot || m.retired || m.dying || m.retireSpawn) continue;
        if (!m.salvageLoot && !m.splitFrom) continue;
        out.push(c);
    }
    return out;
}

function used(c) {
    return c.store && typeof c.store.getUsedCapacity === 'function' ? Number(c.store.getUsedCapacity()) || 0 : 0;
}

function liveRooms() {
    let list = [];
    try { list = require('conquest').directives(); } catch (e) { list = []; }
    return new Set(list.filter((d) => d && d.type === 'salvageLoot' && !d.completed && d.phase !== 'done').map((d) => d.target));
}

function nextRoom(cfg, live, skip) {
    for (const r of cfg.finalRooms || []) if (r && r !== skip && live.has(r)) return r;
    return null;
}

const MOVE_KEYS = ['splitFrom', 'splitTiles', 'splitAt', 'src', 'pick', 'stk', 'skip', 'lootTier', 'gNext', '_move'];

function moveTo(c, room) {
    const m = c.memory;
    m.targetRoom = room;
    m.lootTiles = null;
    for (const k of MOVE_KEYS) delete m[k];
}

function sendBack(c, cfg, live) {
    const m = c.memory;
    if (cfg && live && m.splitFrom && !live.has(m.splitFrom)) {
        const alt = nextRoom(cfg, live, m.targetRoom);
        if (alt) { moveTo(c, alt); return; }
    }
    m.targetRoom = m.splitFrom;
    if (m.splitTiles !== undefined) m.lootTiles = m.splitTiles;
    for (const k of MOVE_KEYS) delete m[k];
}

function retarget(c, s) {
    const m = c.memory;
    m.splitFrom = m.targetRoom;
    m.splitTiles = m.lootTiles === undefined ? null : m.lootTiles;
    m.splitAt = Game.time;
    m.targetRoom = s.target;
    m.slotKey = 'split:' + s.target + ':' + c.name;
    m.lootTiles = null;
    m.salvageLoot = true;
    delete m.relieved;
    delete m.lentFrom;
    for (const k of ['src', 'pick', 'stk', 'skip', 'lootTier', 'gNext', '_move']) delete m[k];
    if (used(c) > 0) m.state = 'deliver';
}

function roomEmpty(s) {
    const room = Game.rooms[s.target];
    if (!room || typeof room.find !== 'function') return false;
    return require('conquest').loadTargets(room).length === 0;
}

function log(s, e, d) {
    const ev = Array.isArray(s.events) ? s.events : (s.events = []);
    ev.push(Object.assign({ t: Game.time, e }, d || {}));
    while (ev.length > 20) ev.shift();
}

function batteryLeft(room) {
    if (!room || typeof room.find !== 'function') return null;
    const B = typeof RESOURCE_BATTERY !== 'undefined' ? RESOURCE_BATTERY : 'battery';
    let n = 0;
    for (const st of room.find(FIND_STRUCTURES) || []) if (!st.my && st.store) n += Number(st.store[B] || 0);
    for (const r of (room.find(FIND_RUINS) || []).concat(room.find(FIND_TOMBSTONES) || [])) if (r.store) n += Number(r.store[B] || 0);
    for (const d of room.find(FIND_DROPPED_RESOURCES) || []) if (d.resourceType === B) n += Number(d.amount || 0);
    return n;
}

function releaseLock(s, room, why, list) {
    const L = s.locks[room];
    let n = 0;
    for (const c of list) {
        const m = c.memory;
        if (lockOf(m) !== room) continue;
        delete m.lootLock;
        delete m.w35lock;
        m.salvageLoot = true;
        n++;
    }
    L.releasedAt = Game.time;
    L.why = why;
    log(s, 'unlock', { room, why, n });
}

function runLocks(s, cfg, live, all) {
    const locks = s.locks;
    if (!locks || typeof locks !== 'object') return null;
    const out = {};
    for (const room of Object.keys(locks)) {
        const L = locks[room];
        if (!L || L.releasedAt) continue;
        const mine = all.filter((c) => lockOf(c.memory) === room);
        const until = L.until || 'battery';
        const left = until === 'battery' ? batteryLeft(Game.rooms[room]) : null;
        if (!live.has(room) || left === 0) { releaseLock(s, room, !live.has(room) ? 'done' : 'battery', all); out[room] = { released: true }; continue; }
        for (const c of mine) {
            const m = c.memory;
            if (!m.salvageLoot) m.salvageLoot = true;
            if (m.targetRoom !== room && !m.finalRun) moveTo(c, room);
        }
        const n = Math.max(0, Number(L.n) || 0);
        const alive = mine.filter((c) => !c.memory.finalRun && !c.memory.relieved).length;
        const minTtl = Number(cfg.minTtl) || 1000;
        const added = [];
        if (alive < n) {
            const cand = pool().filter((c) => !c.memory.finalRun && !c.memory.relieved && (c.ticksToLive == null || c.ticksToLive >= minTtl))
                .sort((a, b) => (b.memory.targetRoom === room) - (a.memory.targetRoom === room) || (a.memory.targetRoom === s.target) - (b.memory.targetRoom === s.target) ||
                    (used(a) > 0) - (used(b) > 0) || (Number(b.ticksToLive) || 0) - (Number(a.ticksToLive) || 0) || (a.name < b.name ? -1 : 1));
            for (const c of cand.slice(0, n - alive)) {
                c.memory.lootLock = room;
                c.memory.salvageLoot = true;
                if (c.memory.targetRoom !== room) moveTo(c, room);
                added.push(c.name);
            }
            if (added.length) log(s, 'lock', { room, names: added });
        }
        L.have = alive + added.length;
        L.battery = left;
        out[room] = { have: L.have, added };
    }
    return out;
}

function runDead(s, cfg, live) {
    const moved = [];
    const rooms = new Set(cfg.finalRooms || []);
    for (const c of haulers()) {
        const m = c.memory;
        if (c.spawning || m.sideLoot || m.pullLoot || !m.salvageLoot) continue;
        if (!rooms.has(m.targetRoom) || live.has(m.targetRoom)) continue;
        const to = nextRoom(cfg, live, m.targetRoom);
        if (!to) continue;
        moveTo(c, to);
        moved.push(c.name);
    }
    if (moved.length) log(s, 'reroute', { names: moved });
    return moved;
}

function armedSeen(name, observe) {
    const room = Game.rooms[name];
    const hauler = require('roles_lootHauler');
    if (!room || typeof room.find !== 'function') { if (observe) { try { hauler.gateArmed(name); } catch (e) { } } return null; }
    const armed = hauler.gateArmed(name);
    if (!armed) return false;
    const rec = (Memory.lootGate || {})[name] || {};
    return { room: name, user: rec.user || null, n: rec.n || 1 };
}

function guardRooms(cfg) {
    const g = cfg.guard || {};
    return Array.isArray(g.rooms) ? g.rooms : [];
}

function sight(s, cfg, observe) {
    const rooms = guardRooms(cfg);
    if (!rooms.length) return null;
    let seen = null;
    for (const r of rooms) { const a = armedSeen(r, observe); if (a && !seen) seen = a; }
    if (!seen) return null;
    const P = s.pause && typeof s.pause === 'object' ? s.pause : (s.pause = { on: false });
    P.seen = Game.time;
    P.by = seen.user;
    P.room = seen.room;
    return seen;
}

function guard(s, cfg) {
    const g = cfg.guard || {};
    if (!guardRooms(cfg).length) return false;
    const seen = sight(s, cfg, true);
    const P = s.pause && typeof s.pause === 'object' ? s.pause : (s.pause = { on: false });
    const clear = Math.max(1, Number(g.clear) || 100);
    const mult = Math.max(1, Number(P.mult) || 1);
    const quiet = Game.time - Number(P.seen || 0);
    if (P.seen != null && quiet < clear * mult) {
        if (!P.on) {
            if (P.resumedAt && Game.time - P.resumedAt < clear * mult * 2) P.mult = Math.min(Math.max(1, Number(g.maxMult) || 16), mult * 2);
            P.on = true;
            P.at = Game.time;
            log(s, 'pause', { room: P.room, by: P.by, mult: P.mult || 1 });
        }
    } else if (P.on) {
        P.on = false;
        P.resumedAt = Game.time;
        log(s, 'resume', { quiet });
    } else if (P.mult > 1 && P.resumedAt && Game.time - P.resumedAt >= (Number(g.hold) || 1500)) {
        delete P.mult;
    }
    return !!(P.on || seen);
}

function lendRoom(cfg, live, target) {
    const r = (cfg.guard || {}).lend;
    return r && r !== target && live.has(r) ? r : null;
}

function lend(s, cfg, live, want) {
    const to = lendRoom(cfg, live, s.target);
    if (!to) return null;
    const mine = pool().filter((c) => c.memory.lentFrom === s.target && c.memory.targetRoom === to);
    const need = Math.max(0, Number(want) || 0) - mine.length;
    if (need <= 0) return { to, n: mine.length };
    const minTtl = Number(cfg.minTtl) || 1000;
    const cand = pool().filter((c) => c.memory.targetRoom !== to && c.memory.targetRoom !== s.target && !c.memory.relieved && !c.memory.finalRun && (c.ticksToLive == null || c.ticksToLive >= minTtl))
        .sort((a, b) => (used(a) > 0) - (used(b) > 0) || (Number(b.ticksToLive) || 0) - (Number(a.ticksToLive) || 0) || (a.name < b.name ? -1 : 1));
    const moved = [];
    for (const c of cand.slice(0, need)) { moveTo(c, to); c.memory.lentFrom = s.target; moved.push(c.name); }
    if (moved.length) log(s, 'lend', { to, names: moved });
    return { to, n: mine.length + moved.length, moved };
}

function divert(s, cfg, live, on) {
    const moved = [];
    const to = lendRoom(cfg, live, s.target);
    for (const c of on) {
        if (c.room && c.room.name === s.target) continue;
        const m = c.memory;
        if (to) { moveTo(c, to); m.lentFrom = s.target; m.pausedFrom = s.target; moved.push(c.name); continue; }
        const back = m.splitFrom && live.has(m.splitFrom) ? m.splitFrom : nextRoom(cfg, live, s.target);
        if (!back) continue;
        if (back === m.splitFrom) sendBack(c, cfg, live);
        else moveTo(c, back);
        m.pausedFrom = s.target;
        moved.push(c.name);
    }
    if (moved.length) log(s, 'divert', { names: moved });
    return moved;
}

function run(force) {
    if (typeof Memory === 'undefined') return null;
    const s = Memory.lootWarLoot;
    if (!s) return null;
    const cfg = settings();
    if (s.target && !s.doneAt && !force && Game.time % Math.max(1, Number(cfg.every) || 5) !== 0) { sight(s, cfg, false); return null; }
    if (!force && Game.time % Math.max(1, Number(cfg.every) || 5) !== 0) return null;
    const live = liveRooms();
    const every = haulers();
    const locks = runLocks(s, cfg, live, every);
    const rerouted = runDead(s, cfg, live);
    if (!s.target || s.doneAt) return locks || rerouted.length ? { locks, rerouted } : null;
    const all = pool();
    const on = all.filter((c) => c.memory.targetRoom === s.target);
    if (roomEmpty(s)) {
        s.doneAt = Game.time;
        for (const c of on) if (c.memory.splitFrom) sendBack(c, cfg, live);
        log(s, 'done', { back: on.length });
        return { done: true, back: on.length };
    }
    if (guard(s, cfg)) {
        const diverted = divert(s, cfg, live, on);
        const stay = on.filter((c) => diverted.indexOf(c.name) < 0);
        s.on = stay.length;
        s.active = stay.length;
        const lent = lend(s, cfg, live, quota(s.haulers, 8) - stay.length);
        return { paused: true, diverted, on: s.on, lent };
    }
    const want = quota(s.haulers, 8);
    const relief = reliefTtl(s, cfg);
    const old = relief > 0 ? on.filter((c) => c.ticksToLive != null && c.ticksToLive < relief) : [];
    const out = [];
    for (const c of old) {
        if (!c.memory.relieved) c.memory.relieved = Game.time;
        if (c.room && c.room.name === s.target) continue;
        let gone = false;
        try { gone = require('roles_lootHauler').finalRun(c); } catch (e) { gone = false; }
        if (gone) out.push(c.name);
    }
    if (out.length) log(s, 'release', { names: out });
    const active = on.length - old.length;
    const need = want - active;
    s.on = on.length - out.length;
    s.active = active;
    s.reliefAt = relief;
    s.relief = old.map((c) => c.name);
    if (need <= 0) return { moved: 0, on: s.on };
    const minTtl = Number(cfg.minTtl) || 1000;
    const cand = all.filter((c) => c.memory.targetRoom !== s.target && !c.memory.relieved && !c.memory.finalRun && (c.ticksToLive == null || c.ticksToLive >= minTtl))
        .sort((a, b) => (b.memory.lentFrom === s.target) - (a.memory.lentFrom === s.target) || (used(a) > 0) - (used(b) > 0) || (Number(b.ticksToLive) || 0) - (Number(a.ticksToLive) || 0) || (a.name < b.name ? -1 : 1));
    const moved = [];
    for (const c of cand.slice(0, need)) { retarget(c, s); moved.push(c.name); }
    if (moved.length) log(s, old.length ? 'relief' : 'moved', old.length ? { names: moved, old: s.relief } : { names: moved });
    s.on += moved.length;
    s.active = active + moved.length;
    return { moved: moved.length, on: s.on, names: moved };
}

module.exports = { moveTo, lend, lendRoom, run, pool, retarget, sendBack, roomEmpty, settings, reliefTtl, lockOf, quota, guard, sight, runLocks, runDead, batteryLeft, liveRooms };
