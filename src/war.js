'use strict';
const config = require('config');

function cfg() {
    return config.war || {};
}

function state() {
    const m = typeof Memory !== 'undefined' ? Memory : null;
    if (!m) return null;
    const w = m.ags131War;
    if (!w || !w.enabled) return null;
    return w;
}

function active() {
    return !!state();
}

function home() {
    return cfg().home || 'W37S5';
}

function target() {
    return cfg().target || 'W38S2';
}

function repeat(part, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(part);
    return out;
}

function bodies() {
    const c = cfg();
    return {
        attacker: (c.attacker && c.attacker.body) ||
            repeat('tough', 8).concat(repeat('attack', 17), repeat('move', 25)),
        healer: (c.healer && c.healer.body) ||
            repeat('tough', 10).concat(repeat('heal', 15), repeat('move', 25)),
        claimer: (c.claimer && c.claimer.body) ||
            repeat('tough', 10).concat(repeat('claim', 4), repeat('move', 14)),
    };
}

function boostsFor(warRole) {
    const c = cfg();
    if (c.boosts && c.boosts[warRole]) return c.boosts[warRole].slice();
    if (warRole === 'attacker') return ['XGHO2', 'XUH2O'];
    if (warRole === 'healer') return ['XGHO2', 'XLHO2'];
    if (warRole === 'claimer') return ['XGHO2'];
    return [];
}

function labCompounds() {
    if (!active()) return [];
    const set = [];
    for (const r of ['attacker', 'healer', 'claimer']) {
        for (const b of boostsFor(r)) if (set.indexOf(b) < 0) set.push(b);
    }
    return set;
}

function labActive(room) {
    return active() && !!room && room.name === home();
}

function liveWar(warRole) {
    const out = [];
    if (typeof Game === 'undefined' || !Game.creeps) return out;
    const tgt = target();
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        const mem = c.memory || {};
        if (mem.role !== 'warrior' || mem.targetRoom !== tgt) continue;
        if (warRole && mem.warRole !== warRole) continue;
        if (mem.retired) continue;
        out.push(c);
    }
    return out;
}

function liveCount(warRole, minTtl) {
    let n = 0;
    for (const c of liveWar(warRole)) {
        if (c.spawning) { n++; continue; }
        if (minTtl && c.ticksToLive != null && c.ticksToLive <= minTtl) continue;
        n++;
    }
    return n;
}

function logEvent(e, data) {
    const w = state();
    if (!w) return;
    const cap = Number(cfg().eventCap) || 60;
    const events = Array.isArray(w.events) ? w.events : (w.events = []);
    const last = events[events.length - 1];
    if (last && last.e === e && JSON.stringify(last.d || null) === JSON.stringify(data || null) && e !== 'spawned') return;
    events.push({ t: Game.time, e, d: data || undefined });
    while (events.length > cap) events.shift();
}

function cpuPressure() {
    const roll = typeof Memory !== 'undefined' && Memory.cpuRoll;
    const line = Number(cfg().cpuPressureAvg) || 150;
    if (roll && roll.avg != null && roll.avg >= line) return true;
    const shed = typeof Memory !== 'undefined' && Memory.cpuShedForce;
    if (shed && Number(shed.until) > Game.time) return true;
    return false;
}

function lootHaulerCap(base) {
    if (!active()) return base;
    if (!cpuPressure()) return base;
    const cut = Number(cfg().lootHaulerCut) || 10;
    return Math.min(base, cut);
}

function spawnRoom(room) {
    return active() && room && room.name === home();
}

function demandRequest(warRole, idx, lead) {
    const c = cfg();
    const bd = bodies()[warRole];
    const cost = bd.reduce((s, p) => s + (BODY_COST[p] || 0), 0);
    const mem = {
        home: home(),
        role: 'warrior',
        warRole,
        targetRoom: target(),
        boosts: boostsFor(warRole),
        boostRoom: home(),
        boostWait: true,
        boostWaitMax: Number(c.boostWaitMax) || 400,
        slotKey: 'war:' + warRole + ':' + idx,
    };
    return {
        key: 'war:' + warRole + ':' + idx,
        role: 'warrior',
        tag: warRole,
        priority: Number(c.priority) != null ? Number(c.priority) : 0,
        vital: false,
        strategic: true,
        blocking: false,
        ordered: true,
        grace: 0,
        memory: mem,
        body: (budget) => (cost <= budget ? bd.slice() : []),
    };
}

const BODY_COST = { move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 };

function getDemands(room) {
    if (!spawnRoom(room)) return [];
    const w = state();
    const phase = w.phase || 'staging';
    if (phase === 'done' || phase === 'off') return [];
    if (Number(Game.cpu.bucket) < (Number(cfg().bucketMin) || 5000)) { w.bucketWait = Game.time; return []; }
    const out = [];
    const travelLead = Number(cfg().travelLead) || 260;
    if (!slotHeld('attacker', 0, 0)) out.push(demandRequest('attacker', 0, 0));
    if (!slotHeld('healer', 0, 0)) out.push(demandRequest('healer', 0, 0));
    const keep = Math.max(1, Number(cfg().claimerKeep) || 2);
    const held = [];
    for (let i = 0; i < keep; i++) held.push(slotHeld('claimer', i, travelLead));
    let spare = liveCount('claimer', travelLead) - held.filter(Boolean).length;
    for (let i = 0; i < keep; i++) {
        if (held[i]) continue;
        if (spare > 0) { spare--; continue; }
        out.push(demandRequest('claimer', i, travelLead));
    }
    if (w.claimSeq != null) delete w.claimSeq;
    return out;
}

function slotHeld(warRole, idx, minTtl) {
    const key = 'war:' + warRole + ':' + idx;
    if (typeof Game === 'undefined' || !Game.creeps) return false;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        const mem = c.memory || {};
        if (mem.role !== 'warrior' || mem.warRole !== warRole || mem.slotKey !== key) continue;
        if (mem.retired) continue;
        if (c.spawning) return true;
        if (minTtl && c.ticksToLive != null && c.ticksToLive <= minTtl) continue;
        return true;
    }
    return false;
}

const BOOST_PART = { XGHO2: 'tough', XUH2O: 'attack', XLHO2: 'heal' };

function fullyBoosted(c) {
    if (!c || !c.body) return false;
    const list = (c.memory && Array.isArray(c.memory.boosts)) ? c.memory.boosts : [];
    for (const compound of list) {
        const type = BOOST_PART[compound];
        if (!type) continue;
        for (const part of c.body) if (part.type === type && part.boost !== compound) return false;
    }
    return true;
}

function squadAtStaging() {
    const staging = cfg().staging || 'W38S3';
    const a = liveWar('attacker')[0];
    const h = liveWar('healer')[0];
    const cs = liveWar('claimer');
    if (!a || !h || !cs.length) return false;
    const atStage = (c) => c && !c.spawning && c.room && c.room.name === staging;
    if (!atStage(a) || !atStage(h)) return false;
    if (!cs.some(atStage)) return false;
    if (!fullyBoosted(a) || !fullyBoosted(h) || !cs.some((c) => atStage(c) && fullyBoosted(c))) {
        logEvent('boostMissing', { a: fullyBoosted(a), h: fullyBoosted(h) });
        return false;
    }
    if (h.hits < h.hitsMax) return false;
    if (a.ticksToLive != null && a.ticksToLive < (Number(cfg().attackerMinTtl) || 900)) return false;
    return true;
}

function observe(w) {
    const tgt = target();
    const room = Game.rooms[tgt];
    if (!room) return;
    const ctrl = room.controller;
    const smLeft = ctrl && Number(ctrl.safeMode) || 0;
    if (smLeft > 0) {
        w.safeModeEnd = Game.time + smLeft;
        logEvent('safeModeSeen', { end: w.safeModeEnd, left: smLeft });
    } else if (room.controller) {
        w.safeModeEnd = null;
    }
    const spawns = room.find(FIND_HOSTILE_SPAWNS) || [];
    const towers = (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_TOWER);
    const prev = w.seen || {};
    if (prev.spawn === undefined) { w.seen = { spawn: spawns.length, towers: towers.length }; return; }
    if (prev.spawn > 0 && spawns.length === 0) logEvent('spawnDestroyed', {});
    if (towers.length < prev.towers) logEvent('towerDestroyed', { left: towers.length });
    w.seen = { spawn: spawns.length, towers: towers.length };
    if (spawns.length === 0 && towers.length === 0 && w.phase === 'assault') {
        w.phase = 'won';
        logEvent('objectivesDown', {});
    }
}

function tick() {
    const w = state();
    if (!w) return;
    if (!w.home) w.home = home();
    if (!w.target) w.target = target();
    if (!w.phase) { w.phase = 'staging'; logEvent('start', {}); }
    observe(w);

    const smLeft = w.safeModeEnd ? w.safeModeEnd - Game.time : 0;
    const resumeLead = Number(cfg().safeModeResumeLead) || 500;
    if (smLeft >= resumeLead && w.phase !== 'safemode') {
        w.phase = 'safemode';
        logEvent('retreat', { reason: 'safemode', end: w.safeModeEnd, left: smLeft });
    } else if (w.phase === 'safemode' && smLeft < resumeLead) {
        w.phase = 'staging';
        logEvent('resume', { left: smLeft });
    }
    if (w.phase === 'staging' && squadAtStaging()) {
        w.phase = 'assault';
        logEvent('entered', {});
    }
    const names = {};
    for (const r of ['attacker', 'healer', 'claimer']) {
        names[r] = liveWar(r).map((c) => c.name);
    }
    w.creeps = names;
    w.at = Game.time;
}

module.exports = {
    active, labActive, labCompounds, lootHaulerCap, getDemands, tick, logEvent,
    home, target, boostsFor, cpuPressure, cfg, state, liveWar, fullyBoosted,
};
