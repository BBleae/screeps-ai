'use strict';
const config = require('config');

function settings() {
    return Object.assign({ every: 5, minTtl: 1000, spawnTicks: 150 }, (config.conquest || {}).lootSplitRun || {});
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

function pool() {
    const out = [];
    for (const name of Object.keys(Game.creeps || {})) {
        const c = Game.creeps[name];
        const m = c && c.memory;
        if (!m || m.role !== 'lootHauler' || c.spawning) continue;
        if (m.sideLoot || m.pullLoot || m.retired || m.dying || m.retireSpawn) continue;
        if (!m.salvageLoot && !m.splitFrom) continue;
        out.push(c);
    }
    return out;
}

function used(c) {
    return c.store && typeof c.store.getUsedCapacity === 'function' ? Number(c.store.getUsedCapacity()) || 0 : 0;
}

function sendBack(c) {
    const m = c.memory;
    m.targetRoom = m.splitFrom;
    if (m.splitTiles !== undefined) m.lootTiles = m.splitTiles;
    for (const k of ['splitFrom', 'splitTiles', 'splitAt', 'src', 'pick', 'stk', 'skip', 'lootTier', 'gNext', '_move']) delete m[k];
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

function run(force) {
    if (typeof Memory === 'undefined') return null;
    const s = Memory.lootWarLoot;
    if (!s || !s.target || s.doneAt) return null;
    const cfg = settings();
    if (!force && Game.time % Math.max(1, Number(cfg.every) || 5) !== 0) return null;
    const all = pool();
    const on = all.filter((c) => c.memory.targetRoom === s.target);
    if (roomEmpty(s)) {
        s.doneAt = Game.time;
        for (const c of on) if (c.memory.splitFrom) sendBack(c);
        log(s, 'done', { back: on.length });
        return { done: true, back: on.length };
    }
    const want = Math.max(0, Number(s.haulers) || 8);
    const relief = reliefTtl(s, cfg);
    const old = relief > 0 ? on.filter((c) => c.ticksToLive != null && c.ticksToLive < relief) : [];
    const active = on.length - old.length;
    const need = want - active;
    s.on = on.length;
    s.active = active;
    s.reliefAt = relief;
    s.relief = old.map((c) => c.name);
    if (need <= 0) return { moved: 0, on: on.length };
    const minTtl = Number(cfg.minTtl) || 1000;
    const cand = all.filter((c) => c.memory.targetRoom !== s.target && (c.ticksToLive == null || c.ticksToLive >= minTtl))
        .sort((a, b) => (used(a) > 0) - (used(b) > 0) || (Number(b.ticksToLive) || 0) - (Number(a.ticksToLive) || 0) || (a.name < b.name ? -1 : 1));
    const moved = [];
    for (const c of cand.slice(0, need)) { retarget(c, s); moved.push(c.name); }
    if (moved.length) log(s, old.length ? 'relief' : 'moved', old.length ? { names: moved, old: s.relief } : { names: moved });
    s.on = on.length + moved.length;
    s.active = active + moved.length;
    return { moved: moved.length, on: s.on, names: moved };
}

module.exports = { run, pool, retarget, sendBack, roomEmpty, settings, reliefTtl };
