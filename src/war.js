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

function warLive() {
    const w = state();
    return !!w && w.phase !== 'won' && w.phase !== 'done' && w.phase !== 'off';
}

function labCompounds() {
    if (!warLive()) return [];
    const set = [];
    for (const r of ['attacker', 'healer', 'claimer']) {
        for (const b of boostsFor(r)) if (set.indexOf(b) < 0) set.push(b);
    }
    return set;
}

function labActive(room) {
    return warLive() && !!room && room.name === home();
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

function gatherPos(role) {
    const g = cfg().gather || {};
    const d = { attacker: { x: 19, y: 1 }, healer: { x: 20, y: 1 }, claimer: { x: 21, y: 1 } };
    return g[role] || d[role] || d.claimer;
}

function staging() {
    return cfg().staging || 'W38S3';
}

function paused() {
    const m = typeof Memory !== 'undefined' ? Memory : null;
    const w = m && m.ags131War;
    return !!(w && !w.enabled && w.pausedAt);
}

function roomOf(c) {
    return (c && c.pos && c.pos.roomName) || (c && c.room && c.room.name) || null;
}

function dist(a, b) {
    if (!a || !b || !a.pos || !b.pos || roomOf(a) !== roomOf(b)) return Infinity;
    return Math.max(Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y));
}

function timing() {
    const c = cfg();
    return {
        boost: Number(c.boostTicks) || 30,
        squadToStaging: Number(c.squadToStaging) || 140,
        claimerSpawn: bodies().claimer.length * 3,
        claimerToStaging: Number(c.claimerToStaging) || 150,
        toController: Number(c.stagingToController) || 60,
        margin: Number(c.reliefMargin) || 60,
        entryTtl: Number(c.claimerEntryTtl) || 400,
        healerEntryTtl: Number(c.healerEntryTtl) || 500,
        healerMax: Number(c.healerMax) || 2,
        claimerMax: Number(c.claimerMax) || 3,
    };
}

function spawnLeft(c) {
    if (!c || !c.spawning) return 0;
    const spawns = (typeof Game !== 'undefined' && Game.spawns) || {};
    for (const n in spawns) {
        const sp = spawns[n];
        if (sp && sp.spawning && sp.spawning.name === c.name) return Number(sp.spawning.remainingTime) || 0;
    }
    return (c.body ? c.body.length : 50) * 3;
}

function deathTick(c) {
    const life = c.memory && c.memory.warRole === 'claimer' ? 600 : 1500;
    if (c.spawning) return Game.time + spawnLeft(c) + life;
    return Game.time + (Number(c.ticksToLive) || 0);
}

function etaToGather(c, role) {
    const T = timing();
    const st = staging();
    const leg = role === 'claimer' ? T.claimerToStaging : T.boost + T.squadToStaging;
    if (!c) return (role === 'claimer' ? T.claimerSpawn : 150) + leg;
    if (c.spawning) return spawnLeft(c) + leg;
    const rn = roomOf(c);
    if (rn === target()) return 0;
    if (rn === st) {
        const g = gatherPos(role);
        return Math.max(Math.abs(c.pos.x - g.x), Math.abs(c.pos.y - g.y));
    }
    if (rn === home()) return role === 'claimer' ? leg : (fullyBoosted(c) ? 0 : T.boost) + T.squadToStaging;
    const route = cfg().route || [];
    const i = route.indexOf(rn);
    const si = route.indexOf(st);
    if (i >= 0 && si > i) return (si - i) * 50;
    return role === 'claimer' ? leg : T.squadToStaging;
}

function primaryHealer() {
    const w = typeof Memory !== 'undefined' && Memory.ags131War;
    const hs = liveWar('healer');
    if (!hs.length) return undefined;
    const named = w && w.squad && hs.find((c) => c.name === w.squad.h);
    if (named) return named;
    const readyOnes = hs.filter((c) => !c.spawning);
    const pool = readyOnes.length ? readyOnes : hs;
    pool.sort((x, y) => deathTick(y) - deathTick(x));
    return pool[0];
}

function healerOk(c, entry) {
    return deathTick(c) - Math.max(entry, Game.time + etaToGather(c, 'healer')) >= timing().healerEntryTtl;
}

function healerNeeded(w) {
    const T = timing();
    const hs = liveWar('healer');
    if (!hs.length) return true;
    if (hs.some((c) => c.spawning)) return false;
    if (hs.length >= T.healerMax) return false;
    if (w.phase === 'assault' || w.phase === 'won') return false;
    const a = liveWar('attacker')[0];
    const entry = Game.time + Math.max(etaToGather(a, 'attacker'), Math.min.apply(null, hs.map((c) => etaToGather(c, 'healer'))));
    return !hs.some((c) => healerOk(c, entry));
}

function schedule(w) {
    const T = timing();
    const cs = liveWar('claimer');
    const arrive = T.claimerSpawn + T.claimerToStaging;
    const lead = arrive + T.toController + T.margin;
    const maxDeath = cs.length ? Math.max.apply(null, cs.map(deathTick)) : null;
    const relief = maxDeath == null ? null : maxDeath - lead;
    let entry = null;
    let next;
    if (w.phase === 'assault' || w.phase === 'won') {
        next = relief == null ? Game.time : relief;
    } else {
        const a = liveWar('attacker')[0];
        const hs = liveWar('healer');
        const pre = Game.time + Math.max(etaToGather(a, 'attacker'), hs.length ? Math.min.apply(null, hs.map((c) => etaToGather(c, 'healer'))) : etaToGather(null, 'healer'));
        const good = hs.filter((c) => healerOk(c, pre));
        const h = good.length ? good.sort((x, y) => etaToGather(x, 'healer') - etaToGather(y, 'healer'))[0] : null;
        entry = Game.time + Math.max(etaToGather(a, 'attacker'), etaToGather(h, 'healer'));
        const ok = cs.some((c) => deathTick(c) - Math.max(entry, Game.time + etaToGather(c, 'claimer')) >= T.entryTtl);
        next = ok && relief != null ? relief : Math.max(Game.time, entry - arrive);
    }
    w.plan = { entry, nextClaimerSpawn: next, reliefSpawn: relief, at: Game.time };
    return next;
}

function getDemands(room) {
    if (!spawnRoom(room)) return [];
    const w = state();
    const phase = w.phase || 'staging';
    if (phase === 'done' || phase === 'off') return [];
    if (Number(Game.cpu.bucket) < (Number(cfg().bucketMin) || 5000)) { w.bucketWait = Game.time; return []; }
    const out = [];
    if (!slotHeld('attacker', 0, 0)) out.push(demandRequest('attacker', 0, 0));
    if (healerNeeded(w)) out.push(demandRequest('healer', 'n', 0));
    const next = schedule(w);
    const cs = liveWar('claimer');
    const homeBusy = cs.some((c) => c.spawning || roomOf(c) === home());
    if (!homeBusy && cs.length < timing().claimerMax && Game.time >= next) out.push(demandRequest('claimer', 'n', 0));
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

function ready(c) {
    return !!c && !c.spawning;
}

function entryCheck(w) {
    const T = timing();
    const st = staging();
    const a = liveWar('attacker')[0];
    const staged = liveWar('healer').filter((c) => ready(c) && roomOf(c) === st);
    staged.sort((x, y) => Number(y.ticksToLive) - Number(x.ticksToLive));
    const h = staged[0] || primaryHealer();
    if (!ready(a) || !ready(h)) return { ok: false, why: 'missing' };
    if (roomOf(a) !== st || roomOf(h) !== st) return { ok: false, why: 'notStaged' };
    if (Number(h.ticksToLive) < T.healerEntryTtl) return { ok: false, why: 'healerTtl' };
    if (!fullyBoosted(a) || !fullyBoosted(h)) return { ok: false, why: 'boost' };
    if (h.hits < h.hitsMax || a.hits < a.hitsMax) return { ok: false, why: 'hurt' };
    if (a.ticksToLive != null && a.ticksToLive < (Number(cfg().attackerMinTtl) || 900)) return { ok: false, why: 'attackerTtl' };
    if (dist(a, h) > 3) return { ok: false, why: 'apart' };
    const cands = liveWar('claimer').filter((c) => ready(c) && roomOf(c) === st && fullyBoosted(c) &&
        Number(c.ticksToLive) >= T.entryTtl && dist(c, a) <= 3 && dist(c, h) <= 3);
    if (!cands.length) return { ok: false, why: 'claimer' };
    cands.sort((x, y) => Number(y.ticksToLive) - Number(x.ticksToLive));
    const plan = w.plan || {};
    if (!Number.isFinite(plan.reliefSpawn)) return { ok: false, why: 'noRelief' };
    return { ok: true, a, h, c: cands[0] };
}

function hostilesLeft(room) {
    if (!room) return true;
    const spawns = room.find(FIND_HOSTILE_SPAWNS) || [];
    const towers = (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_TOWER);
    return spawns.length + towers.length > 0;
}

function locked(room) {
    return !!(room && room.controller && Number(room.controller.upgradeBlocked) > 0);
}

function regroup(w, reason) {
    w.phase = 'staging';
    w.regroup = { at: Game.time, reason };
    w.crossAt = null;
    w.breach = null;
    w.squad = null;
    logEvent('retreat', { reason });
}

function cohesion(w) {
    const tgt = target();
    const room = Game.rooms[tgt];
    const a = liveWar('attacker')[0];
    const h = primaryHealer();
    if (!a) return { now: true, why: 'attackerDead' };
    if (!h) return { now: true, why: 'healerDead' };
    const line = Number(cfg().retreatBelow) || 0.5;
    if (a.hits < a.hitsMax * line || h.hits < h.hitsMax * line) return { now: true, why: 'hurt' };
    const aIn = roomOf(a) === tgt;
    const hIn = roomOf(h) === tgt;
    if (!aIn && !hIn) return null;
    if (aIn !== hIn) return { why: 'split' };
    if (dist(a, h) > 3) return { why: 'apart' };
    const cl = liveWar('claimer').filter((c) => ready(c) && roomOf(c) === tgt);
    if (!locked(room)) {
        if (!cl.some((c) => dist(c, h) <= 3)) return { why: 'claimerApart' };
    } else if (!cl.length && hostilesLeft(room)) {
        return { why: 'noClaimer' };
    }
    return null;
}

function squadTick(w) {
    const tgt = target();
    const st = staging();
    const troom = Game.rooms[tgt];
    if (troom && troom.controller) {
        if (locked(troom)) {
            if (!w.lockedSince) {
                w.lockedSince = Game.time;
                if (!w.firstHit) w.firstHit = Game.time;
                logEvent('controllerHit', { tick: Game.time, upgradeBlocked: Number(troom.controller.upgradeBlocked), downgrade: troom.controller.ticksToDowngrade });
            }
        } else if (w.lockedSince) {
            w.lockedSince = null;
        }
    }
    w.entries = w.entries || {};
    if (w.phase === 'assault' || w.phase === 'won') {
        for (const c of liveWar()) {
            if (ready(c) && roomOf(c) === tgt && w.entries[c.name] == null) {
                w.entries[c.name] = Game.time;
                logEvent('crossed', { name: c.name, role: c.memory.warRole, ttl: c.ticksToLive });
            }
        }
    }
    const names = Object.keys(w.entries);
    if (names.length > 12) for (const n of names.slice(0, names.length - 12)) delete w.entries[n];
    if (w.phase === 'staging') {
        const chk = entryCheck(w);
        w.entryWait = chk.ok ? null : chk.why;
        if (chk.ok) {
            w.phase = 'assault';
            w.squad = { a: chk.a.name, h: chk.h.name, c: chk.c.name, at: Game.time, cTtl: chk.c.ticksToLive };
            w.crossAt = null;
            w.breach = null;
            w.entries = {};
            logEvent('entered', { a: chk.a.name, h: chk.h.name, c: chk.c.name, cTtl: chk.c.ticksToLive, relief: w.plan && w.plan.reliefSpawn });
        }
        return;
    }
    if (w.phase !== 'assault' && w.phase !== 'won') return;
    if (!w.squad) { regroup(w, 'noSquad'); return; }
    const a = liveWar('attacker')[0];
    const h = primaryHealer();
    if (a && h && ready(a) && ready(h) && roomOf(a) === st && roomOf(h) === st) {
        const ga = gatherPos('attacker');
        const gh = gatherPos('healer');
        const at = (c, g) => c.pos.x === g.x && c.pos.y === g.y && !c.fatigue;
        if (at(a, ga) && at(h, gh)) w.crossAt = Game.time;
    }
    const b = cohesion(w);
    if (!b) { w.breach = null; return; }
    if (b.now) { regroup(w, b.why); return; }
    const prev = w.breach && w.breach.why === b.why ? w.breach.n : 0;
    w.breach = { why: b.why, n: prev + 1, at: Game.time };
    if (w.breach.n >= (Number(cfg().breachGrace) || 3)) regroup(w, b.why);
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
    if (w.pausedAt) {
        logEvent('resume', { from: 'pause', pausedAt: w.pausedAt });
        delete w.pausedAt;
        if (w.phase === 'assault' || w.phase === 'won') regroup(w, 'unpaused');
    }
    observe(w);

    const smLeft = w.safeModeEnd ? w.safeModeEnd - Game.time : 0;
    const resumeLead = Number(cfg().safeModeResumeLead) || 500;
    if (smLeft >= resumeLead && w.phase !== 'safemode') {
        w.phase = 'safemode';
        w.crossAt = null;
        w.squad = null;
        logEvent('retreat', { reason: 'safemode', end: w.safeModeEnd, left: smLeft });
    } else if (w.phase === 'safemode' && smLeft < resumeLead) {
        w.phase = 'staging';
        logEvent('resume', { left: smLeft });
    }
    schedule(w);
    squadTick(w);
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
    paused, gatherPos, staging, dist, roomOf, locked, schedule, entryCheck, cohesion, timing, deathTick,
    primaryHealer, healerNeeded, warLive,
};
