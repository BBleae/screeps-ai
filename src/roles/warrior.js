'use strict';
const config = require('config');
const movement = require('movement');
const boost = require('boost');
const retireMod = require('retire');
const war = require('war');

const TOP_DIR = typeof TOP !== 'undefined' ? TOP : 1;

function wcfg() {
    return config.war || {};
}

function avoidSet() {
    const list = (wcfg().avoid || ['W37S3', 'W37S2', 'W37S1', 'W39S1', 'W39S2', 'W39S3']);
    return new Set(list);
}

function goWar(creep, pos, range) {
    movement.go(creep, pos, { range: range == null ? 1 : range, reusePath: 5, avoidRooms: avoidSet() });
}

function homePos(creep) {
    return new RoomPosition(25, 25, creep.memory.home);
}

function retreatHome(creep) {
    const h = creep.memory.home;
    if (creep.room.name === h) {
        if (creep.hits >= creep.hitsMax && creep.ticksToLive != null && creep.ticksToLive < 120) {
            retireMod.retireAtSpawn(creep);
            return;
        }
        const spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
        if (spawn && !creep.pos.inRangeTo(spawn.pos, 3)) goWar(creep, spawn.pos, 3);
        return;
    }
    goWar(creep, homePos(creep), 20);
}

function gatherTile(creep) {
    const g = war.gatherPos(creep.memory.warRole);
    return new RoomPosition(g.x, g.y, war.staging());
}

function claimerWaitTile(creep) {
    const t = gatherTile(creep);
    const room = Game.rooms[t.roomName];
    if (!room || typeof room.lookForAt !== 'function') return t;
    const kind = typeof LOOK_CREEPS !== 'undefined' ? LOOK_CREEPS : 'creep';
    const here = room.lookForAt(kind, t.x, t.y) || [];
    if (!here.length || here.some((c) => c.name === creep.name)) return t;
    return new RoomPosition(t.x + 1, t.y + 1, t.roomName);
}

function toGather(creep) {
    const t = creep.memory.warRole === 'claimer' ? claimerWaitTile(creep) : gatherTile(creep);
    if (creep.room.name === t.roomName && creep.pos.x === t.x && creep.pos.y === t.y) return true;
    goWar(creep, t, 0);
    return false;
}

function holdPaused(creep) {
    if (creep.memory.warRole === 'healer') healAround(creep);
    if (creep.room.name === creep.memory.home) { retreatHome(creep); return; }
    toGather(creep);
}

function targetRoomPos(xy) {
    return new RoomPosition(xy.x, xy.y, war.target());
}

function enemyTowers(room) {
    return (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_TOWER);
}

function inTarget(c) {
    return !!c && !c.spawning && war.roomOf(c) === war.target();
}

function squad() {
    return { a: war.liveWar('attacker')[0], h: war.primaryHealer() };
}

function leadClaimer(w, near) {
    const cs = war.liveWar('claimer').filter(inTarget);
    if (!cs.length) return null;
    const named = w.squad && cs.find((c) => c.name === w.squad.c);
    if (named) return named;
    cs.sort((x, y) => war.dist(x, near) - war.dist(y, near));
    return cs[0];
}

function stepOffEdge(creep) {
    if (creep.pos.y < 48 && creep.pos.y > 1 && creep.pos.x > 1 && creep.pos.x < 48) return false;
    goWar(creep, new RoomPosition(creep.pos.x, Math.min(47, Math.max(2, creep.pos.y)), creep.room.name), 0);
    return true;
}

function crossOrHold(creep, w) {
    const gathered = toGather(creep);
    if (gathered && w.crossAt === Game.time) creep.move(TOP_DIR);
}

function pickAttackTarget(creep, room) {
    const spawns = room.find(FIND_HOSTILE_SPAWNS) || [];
    if (spawns.length) return creep.pos.findClosestByRange(spawns);
    const towers = enemyTowers(room);
    if (towers.length) {
        const order = wcfg().towerOrder || [{ x: 30, y: 26 }, { x: 39, y: 27 }];
        for (const o of order) {
            const t = towers.find((tw) => tw.pos.x === o.x && tw.pos.y === o.y);
            if (t) return t;
        }
        return creep.pos.findClosestByRange(towers);
    }
    const hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    if (hostiles.length) return creep.pos.findClosestByRange(hostiles);
    const ext = (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_EXTENSION);
    if (ext.length) return creep.pos.findClosestByRange(ext);
    const other = (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType !== STRUCTURE_CONTROLLER);
    return other.length ? creep.pos.findClosestByRange(other) : null;
}

function runAttacker(creep, w, room) {
    if (w.phase === 'staging') { toGather(creep); return; }
    if (!inTarget(creep)) { crossOrHold(creep, w); return; }
    const { h } = squad();
    if (stepOffEdge(creep)) return;
    if (!war.locked(room)) {
        if (h && inTarget(h) && war.dist(creep, h) > 1) goWar(creep, h.pos, 1);
        return;
    }
    const target = pickAttackTarget(creep, room);
    if (!target) { if (h && war.dist(creep, h) > 1) goWar(creep, h.pos, 1); return; }
    if (creep.pos.isNearTo(target.pos)) { creep.attack(target); return; }
    if (h && inTarget(h) && war.dist(creep, h) > 2) return;
    goWar(creep, target.pos, 1);
}

function healPick(creep) {
    let best = null;
    let bestScore = 0;
    for (const c of war.liveWar()) {
        if (!c || c.spawning || war.roomOf(c) !== creep.room.name) continue;
        const deficit = c.hitsMax - c.hits;
        if (deficit <= 0) continue;
        const d = war.dist(creep, c);
        if (d > 3) continue;
        let score = deficit + (d <= 1 ? 1 : 0);
        if (c.memory.warRole === 'claimer') score += 100000;
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
}

function healTick(creep, leader) {
    const t = healPick(creep);
    if (t) {
        if (war.dist(creep, t) <= 1) creep.heal(t);
        else creep.rangedHeal(t);
        return;
    }
    if (leader && war.dist(creep, leader) <= 1) creep.heal(leader);
    else creep.heal(creep);
}

function runHealer(creep, w, room) {
    if (w.phase === 'staging') { toGather(creep); healAround(creep); return; }
    if (!inTarget(creep)) { crossOrHold(creep, w); healAround(creep); return; }
    const { a } = squad();
    const leader = war.locked(room) ? a : (leadClaimer(w, creep) || a);
    healTick(creep, leader);
    if (stepOffEdge(creep)) return;
    if (leader && inTarget(leader) && war.dist(creep, leader) > 1) goWar(creep, leader.pos, 1);
}

function healAround(creep) {
    if (creep.hits < creep.hitsMax) { creep.heal(creep); return; }
    const near = creep.pos.findClosestByRange(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax && c.id !== creep.id });
    if (!near) return;
    if (creep.pos.isNearTo(near.pos)) creep.heal(near);
    else if (creep.pos.inRangeTo(near.pos, 3)) creep.rangedHeal(near);
}

const APPROACH = [{ x: 20, y: 2 }, { x: 19, y: 2 }, { x: 21, y: 2 }];

function pairAtGather(a, h) {
    const st = war.staging();
    const ga = war.gatherPos('attacker');
    const gh = war.gatherPos('healer');
    return !!a && !!h && !a.spawning && !h.spawning && war.roomOf(a) === st && war.roomOf(h) === st &&
        a.pos.x === ga.x && a.pos.y === ga.y && h.pos.x === gh.x && h.pos.y === gh.y;
}

function approachTile(creep) {
    const st = war.staging();
    for (const t of APPROACH) {
        const taken = Object.keys(Game.creeps).some((n) => {
            const c = Game.creeps[n];
            return c.name !== creep.name && c.pos && c.pos.roomName === st && c.pos.x === t.x && c.pos.y === t.y;
        });
        if (!taken) return new RoomPosition(t.x, t.y, st);
    }
    return null;
}

function claimerStage(creep) {
    const { a, h } = squad();
    if (pairAtGather(a, h)) {
        const t = approachTile(creep);
        if (t) {
            if (creep.room.name === t.roomName && creep.pos.x === t.x && creep.pos.y === t.y) return;
            goWar(creep, t, 0);
            return;
        }
        if (creep.room.name === war.staging() && Math.max(Math.abs(creep.pos.x - h.pos.x), Math.abs(creep.pos.y - h.pos.y)) <= 1) return;
    }
    toGather(creep);
}

function runClaimer(creep, w, room) {
    if (w.phase === 'staging') { claimerStage(creep); return; }
    const { a, h } = squad();
    const ctrlXy = wcfg().controllerPos || { x: 22, y: 20 };
    if (!inTarget(creep)) {
        if (inTarget(a) && inTarget(h)) goWar(creep, targetRoomPos(ctrlXy), 1);
        else claimerStage(creep);
        return;
    }
    const ctrl = room && room.controller;
    if (!ctrl) return;
    if (creep.pos.isNearTo(ctrl.pos)) { creep.attackController(ctrl); return; }
    if (!war.locked(room) && h && inTarget(h) && war.dist(creep, h) > 2 && creep.pos.y < 48) return;
    goWar(creep, ctrl.pos, 1);
}

function boostedParts(creep) {
    const out = {};
    for (const p of creep.body || []) if (p.boost) out[p.boost] = (out[p.boost] || 0) + 1;
    return out;
}

function homeUnboost(creep, w) {
    const mem = creep.memory;
    if (!mem.goHome) { mem.goHome = Game.time; war.logEvent('goHome', { name: creep.name, role: mem.warRole, ttl: creep.ticksToLive }); }
    if (creep.memory.warRole === 'healer') healAround(creep);
    if (creep.room.name !== mem.home) { goWar(creep, homePos(creep), 20); return; }
    const parts = boostedParts(creep);
    const cc = war.clearCfg();
    if (!mem.unboosted && Object.keys(parts).length) {
        if (!mem.unboostSince) mem.unboostSince = Game.time;
        const late = Game.time - mem.unboostSince > cc.unboostWait || (creep.ticksToLive != null && creep.ticksToLive < 8);
        if (!late) {
            const kind = typeof FIND_MY_STRUCTURES !== 'undefined' ? FIND_MY_STRUCTURES : 'myStructures';
            const hr = Game.rooms[mem.home] || creep.room;
            const labs = (typeof hr.find === 'function' ? hr.find(kind) || [] : []).filter((s) => s.structureType === 'lab');
            const near = labs.filter((l) => creep.pos.isNearTo(l.pos));
            const free = near.find((l) => !l.cooldown);
            if (free) {
                const r = free.unboostCreep(creep);
                if (r === OK) {
                    const returned = {};
                    for (const k of Object.keys(parts)) returned[k] = parts[k] * 15;
                    mem.unboosted = Game.time;
                    war.recordUnboost(w, creep, returned);
                }
                return;
            }
            const idle = labs.filter((l) => !l.cooldown);
            const goal = creep.pos.findClosestByRange(idle.length ? idle : labs);
            if (goal) { if (!creep.pos.isNearTo(goal.pos)) goWar(creep, goal.pos, 1); return; }
        }
        mem.unboosted = Game.time;
        war.logEvent('unboostSkip', { name: creep.name, role: mem.warRole, parts });
    } else if (!mem.unboosted) {
        mem.unboosted = Game.time;
        war.recordUnboost(w, creep, {});
    }
    mem.retired = true;
    retireMod.retireAtSpawn(creep);
}

function stomp(creep, pos) {
    const d = Math.max(Math.abs(creep.pos.x - pos.x), Math.abs(creep.pos.y - pos.y));
    if (d === 1 && typeof creep.pos.getDirectionTo === 'function') { creep.move(creep.pos.getDirectionTo(pos)); return; }
    goWar(creep, pos, 0);
}

function clearHurt(w, a, h) {
    const line = Number(wcfg().retreatBelow) || 0.5;
    const low = (c) => c && c.hits < c.hitsMax * line;
    const full = (c) => !c || c.hits >= c.hitsMax;
    if (low(a) || low(h)) { if (!w.clearHurt) { w.clearHurt = Game.time; war.logEvent('retreat', { reason: 'hurt', mode: 'clear' }); } }
    else if (w.clearHurt && full(a) && full(h)) delete w.clearHurt;
    return !!w.clearHurt;
}

function intoTarget(creep) {
    const ctrlXy = wcfg().controllerPos || { x: 22, y: 20 };
    goWar(creep, targetRoomPos(ctrlXy), 1);
}

function pairOf(w) {
    const p = w.phase2 || {};
    return { a: p.a ? Game.creeps[p.a] : null, h: p.h ? Game.creeps[p.h] : null };
}

function clearAttacker(creep, w, room) {
    const ttlLow = creep.ticksToLive != null && creep.ticksToLive < war.clearCfg().homeTtl;
    if (creep.memory.goHome || ttlLow || w.mode !== 'clear') { homeUnboost(creep, w); return; }
    const { h } = pairOf(w);
    if (clearHurt(w, creep, h)) { toGather(creep); return; }
    if (!inTarget(creep)) { intoTarget(creep); return; }
    if (stepOffEdge(creep)) return;
    const t = war.clearTarget(creep, war.clearScan(room));
    const hFar = h && inTarget(h) && war.dist(creep, h) > 2;
    if (!t) return;
    if (t.kind === 'site') {
        if (creep.pos.x === t.obj.pos.x && creep.pos.y === t.obj.pos.y) return;
        if (!hFar) stomp(creep, t.obj.pos);
        return;
    }
    let obj = t.obj;
    if (t.kind === 'struct' && typeof room.lookForAt === 'function') {
        const kind = typeof LOOK_STRUCTURES !== 'undefined' ? LOOK_STRUCTURES : 'structure';
        const ramp = (room.lookForAt(kind, obj.pos.x, obj.pos.y) || []).find((s) => s.structureType === 'rampart' && !s.my);
        if (ramp) obj = ramp;
    }
    if (creep.pos.isNearTo(obj.pos)) { creep.attack(obj); return; }
    if (!hFar) goWar(creep, obj.pos, 1);
}

function clearHealer(creep, w, room) {
    const { a } = pairOf(w);
    const ttlLow = creep.ticksToLive != null && creep.ticksToLive < war.clearCfg().homeTtl;
    if (creep.memory.goHome || ttlLow || !a || (a.memory && (a.memory.goHome || a.memory.retired)) || w.mode !== 'clear') { homeUnboost(creep, w); return; }
    if (clearHurt(w, a, creep)) { healTick(creep, a); if (war.roomOf(a) !== war.roomOf(creep) || war.dist(creep, a) > 1) goWar(creep, a.pos, 1); return; }
    const scan = inTarget(creep) ? war.clearScan(room) : null;
    if (scan && scan.sites.length && !scan.creeps.length) {
        healAround(creep);
        if (stepOffEdge(creep)) return;
        const at = war.clearTarget(a, scan);
        const site = war.pickSite(creep, scan.sites, at && at.kind === 'site' ? at.obj.id : null);
        if (site) { stomp(creep, site.pos); return; }
    }
    healTick(creep, a);
    if (war.roomOf(a) !== war.roomOf(creep) || war.dist(creep, a) > 1) goWar(creep, a.pos, 1);
}

function clearClaimer(creep, w, room) {
    if (!inTarget(creep)) { intoTarget(creep); return; }
    const ctrl = room && room.controller;
    if (!ctrl) return;
    if (!creep.pos.isNearTo(ctrl.pos)) { goWar(creep, ctrl.pos, 1); return; }
    if (!(Number(ctrl.upgradeBlocked) > 1) && !(Number(ctrl.safeMode) > 0)) creep.attackController(ctrl);
}

function runWatcher(creep, w, room) {
    if (!inTarget(creep)) { intoTarget(creep); return; }
    if (stepOffEdge(creep)) return;
    const hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    if (hostiles.length) {
        const t = creep.pos.findClosestByRange(hostiles);
        if (creep.pos.isNearTo(t.pos)) creep.attack(t); else goWar(creep, t.pos, 1);
        return;
    }
    const siteKind = typeof FIND_HOSTILE_CONSTRUCTION_SITES !== 'undefined' ? FIND_HOSTILE_CONSTRUCTION_SITES : 'hostileSites';
    const sites = room.find(siteKind) || [];
    if (sites.length) {
        const t = creep.pos.findClosestByRange(sites);
        if (!(creep.pos.x === t.pos.x && creep.pos.y === t.pos.y)) stomp(creep, t.pos);
    }
}

function runPhase2(creep, w) {
    const room = Game.rooms[war.target()];
    const role = creep.memory.warRole;
    if (role === 'attacker' || role === 'healer') {
        if (w.phase === 'safemode' || w.costCapped) { homeUnboost(creep, w); return; }
        if (role === 'attacker') clearAttacker(creep, w, room); else clearHealer(creep, w, room);
        return;
    }
    if (w.phase === 'safemode') { retreatHome(creep); return; }
    if (role === 'claimer') clearClaimer(creep, w, room);
    else if (role === 'watcher') runWatcher(creep, w, room);
}

const BOOST_TTL_FLOOR = { attacker: 1100, healer: 1000, claimer: 400 };

function boostRetry(creep) {
    const mem = creep.memory;
    if (!mem.boostDone || !creep.room || creep.room.name !== mem.home || war.fullyBoosted(creep)) return false;
    const floor = BOOST_TTL_FLOOR[mem.warRole] || 0;
    if (creep.ticksToLive != null && creep.ticksToLive < floor) {
        mem.retired = true;
        war.logEvent('boostRetire', { name: creep.name, role: mem.warRole });
        retireMod.retireAtSpawn(creep);
        return true;
    }
    delete mem.boostDone;
    delete mem.boostSince;
    delete mem.boostSkip;
    return false;
}

function run(creep) {
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    const w = war.state();
    if (!w) {
        if (war.paused()) holdPaused(creep);
        else retreatHome(creep);
        return;
    }
    if (w.mode) { if (!creep.spawning) runPhase2(creep, w); return; }
    if (creep.memory.warRole === 'healer' && w.phase === 'staging' && creep.ticksToLive != null && creep.ticksToLive < war.timing().healerEntryTtl) {
        const other = war.liveWar('healer').find((c) => c.name !== creep.name && !c.spawning && war.fullyBoosted(c));
        if (other) {
            creep.memory.retired = true;
            war.logEvent('healerRetire', { name: creep.name, ttl: creep.ticksToLive, by: other.name });
            retireMod.retireAtSpawn(creep);
            return;
        }
    }
    if (w.costCapped) { retreatHome(creep); if (creep.memory.warRole === 'healer') healAround(creep); return; }
    if (boostRetry(creep)) return;
    if (boost.run(creep)) return;
    const room = Game.rooms[war.target()];
    if (w.phase === 'safemode') { retreatHome(creep); if (creep.memory.warRole === 'healer') healAround(creep); return; }
    if (creep.memory.warRole === 'attacker') runAttacker(creep, w, room);
    else if (creep.memory.warRole === 'healer') runHealer(creep, w, room);
    else if (creep.memory.warRole === 'claimer') runClaimer(creep, w, room);
}

module.exports = { run, boostRetry };
