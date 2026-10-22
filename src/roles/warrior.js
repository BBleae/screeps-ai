'use strict';
const config = require('config');
const movement = require('movement');
const boost = require('boost');
const retireMod = require('retire');
const war = require('war');
const escort = require('roles_escort');

const TOP_DIR = typeof TOP !== 'undefined' ? TOP : 1;

function wcfg() {
    return config.war || {};
}

function avoidSet() {
    const list = (wcfg().avoid || ['W37S3', 'W37S2', 'W37S1', 'W39S1', 'W39S2', 'W39S3']);
    return new Set(list);
}

function siteAvoid(roomName, cm) {
    if (roomName !== war.target() || !cm || typeof cm.set !== 'function') return cm;
    const room = Game.rooms[roomName];
    if (!room || typeof room.find !== 'function') return cm;
    const kind = typeof FIND_HOSTILE_CONSTRUCTION_SITES !== 'undefined' ? FIND_HOSTILE_CONSTRUCTION_SITES : 'hostileSites';
    const urgent = war.clearCfg().urgentSites;
    for (const s of room.find(kind) || []) {
        if (urgent.indexOf(s.structureType) >= 0) continue;
        if (cm.get(s.pos.x, s.pos.y) < 60) cm.set(s.pos.x, s.pos.y, 60);
    }
    return cm;
}

function goWar(creep, pos, range) {
    const opts = { range: range == null ? 1 : range, reusePath: 5, avoidRooms: avoidSet() };
    const w = war.state();
    if (w && w.mode && pos && pos.roomName === war.target()) opts.costCallback = siteAvoid;
    movement.go(creep, pos, opts);
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
    if (war.noClaimer()) {
        const ds = war.liveWar('dismantler').filter(inTarget).filter((d) => !d.memory.done);
        return ds.length ? ds[0] : null;
    }
    const cs = war.liveWar('claimer').filter(inTarget);
    if (!cs.length) return null;
    const named = w.squad && cs.find((c) => c.name === w.squad.c);
    if (named) return named;
    cs.sort((x, y) => war.dist(x, near) - war.dist(y, near));
    return cs[0];
}

function stepOffEdge(creep) {
    const lo = war.noClaimer() ? 0 : 1;
    if (creep.pos.y < 49 - lo && creep.pos.y > lo && creep.pos.x > lo && creep.pos.x < 49 - lo) return false;
    goWar(creep, new RoomPosition(creep.pos.x, Math.min(48 - lo, Math.max(lo + 1, creep.pos.y)), creep.room.name), 0);
    return true;
}

function entryTile() {
    const e = wcfg().entryPos;
    return e ? new RoomPosition(e.x, e.y, war.target()) : null;
}

function crossOrHold(creep, w) {
    const e = war.noClaimer() ? entryTile() : null;
    if (e) { crossNoClaimer(creep, w, e); return; }
    const gathered = toGather(creep);
    if (gathered && w.crossAt === Game.time) creep.move(TOP_DIR);
}

function crossNoClaimer(creep, w, e) {
    const role = creep.memory.warRole;
    if (role === 'healer') {
        healAround(creep);
        const a = war.liveWar('attacker')[0];
        const lead = a && !a.spawning ? a : null;
        if (lead && war.roomOf(lead) === war.roomOf(creep) && war.dist(creep, lead) <= 1 && !inTarget(lead)) return;
        if (lead) goWar(creep, lead.pos, 1);
        else toGather(creep);
        return;
    }
    if (role === 'attacker') {
        const h = war.nearHealer(creep);
        if (h && !escortReady(creep, h)) return;
        if (h && w.squad) w.squad.h = h.name;
        goWar(creep, e, 0);
        return;
    }
    const a = war.liveWar('attacker')[0];
    if (!a || !inTarget(a)) { toGather(creep); return; }
    goWar(creep, e, 1);
}

function allySet() {
    const a = (config.allies && config.allies.names) || [];
    return new Set(a);
}

function notAlly(o) {
    return !(o && o.owner && allySet().has(o.owner.username));
}

function hasPart(c, type) {
    return Array.isArray(c.body) && c.body.some((p) => p.type === type && (p.hits == null || p.hits > 0));
}

function inCorridor(p) {
    return p.x <= 1 || p.y <= 1 || p.x >= 48 || p.y >= 48 || (p.x >= 27 && p.y <= 3);
}

function supportCreep(room, towers) {
    const keys = towers;
    const near = (c, list, r) => list.some((o) => Math.max(Math.abs(o.pos.x - c.pos.x), Math.abs(o.pos.y - c.pos.y)) <= r);
    const energyOf = (c) => (c.store ? Number(c.store.energy != null ? c.store.energy : (typeof c.store.getUsedCapacity === 'function' ? c.store.getUsedCapacity('energy') : 0)) || 0 : 0);
    return (room.find(FIND_HOSTILE_CREEPS) || []).filter(notAlly).filter((c) => {
        if (!c.pos || c.spawning || inCorridor(c.pos)) return false;
        const work = hasPart(c, 'work');
        const carry = hasPart(c, 'carry');
        if (!work && !carry) return false;
        if (work && near(c, keys, 3)) return true;
        return carry && energyOf(c) > 0 && near(c, towers, 2);
    });
}

function lootAttackTarget(creep, room) {
    const order = wcfg().towerOrder || [];
    const towers = enemyTowers(room).filter(notAlly);
    if (war.noClaimer() && towers.length) {
        const sup = supportCreep(room, towers);
        if (sup.length) return creep.pos.findClosestByRange(sup);
    }
    if (towers.length) {
        for (const o of order) {
            const t = towers.find((tw) => tw.pos.x === o.x && tw.pos.y === o.y);
            if (t) return t;
        }
        return creep.pos.findClosestByRange(towers);
    }
    const spawns = (room.find(FIND_HOSTILE_SPAWNS) || []).filter(notAlly);
    if (spawns.length) return creep.pos.findClosestByRange(spawns);
    const hostiles = (room.find(FIND_HOSTILE_CREEPS) || []).filter(notAlly);
    if (hostiles.length) return creep.pos.findClosestByRange(hostiles);
    return null;
}

function escortHealers(room) {
    return war.liveWar('healer').filter((c) => inTarget(c) && c.room.name === room.name).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function attackerHealer(w, room) {
    const hs = escortHealers(room);
    if (!hs.length) return null;
    if (w && w.squad && w.squad.h) {
        const named = hs.find((h) => h.name === w.squad.h);
        if (named) return named;
    }
    return hs[0];
}

function claimerHealer(w, room) {
    const hs = escortHealers(room);
    if (!hs.length) return null;
    const ah = attackerHealer(w, room);
    const other = hs.find((h) => !ah || h.name !== ah.name);
    if (other) return other;
    return war.locked(room) ? null : ah;
}

function escortLeaderFor(healer, w, room) {
    const a = war.liveWar('attacker')[0];
    const c = leadClaimer(w, healer);
    const ah = attackerHealer(w, room);
    if (ah && healer.name === ah.name) {
        if (a) return a;
        return c;
    }
    return c || a;
}

function breachWall(room, w) {
    const b = wcfg().breach;
    if (!b || w.breachDone || !room) return null;
    return wallOrRampAt(room, b.x, b.y, true);
}

function escortHealerFor(leader, w, room) {
    if (leader && leader.memory && leader.memory.warRole === 'attacker') return attackerHealer(w, room);
    return claimerHealer(w, room) || attackerHealer(w, room);
}

function escortReady(leader, healer) {
    if (!healer) return true;
    if (war.roomOf(leader) !== war.roomOf(healer)) return false;
    if (war.dist(leader, healer) > 1) return false;
    return (leader.fatigue || 0) === 0 && (healer.fatigue || 0) === 0;
}

function pickAttackTarget(creep, room) {
    if (war.lootWar()) return lootAttackTarget(creep, room);
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
    if (war.lootWar() && stepOffEdge(creep)) return;
    if (war.lootWar()) { runAttackerLoot(creep, w, room); return; }
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
    if (war.lootWar()) { runHealerLoot(creep, w, room); return; }
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
    if (war.lootWar()) { runClaimerLoot(creep, w, room, ctrl); return; }
    if (creep.pos.isNearTo(ctrl.pos)) { creep.attackController(ctrl); return; }
    if (!war.locked(room) && h && inTarget(h) && war.dist(creep, h) > 2 && creep.pos.y < 48) return;
    goWar(creep, ctrl.pos, 1);
}

function cpos(c) {
    return c ? { x: c.pos.x, y: c.pos.y, room: c.pos.roomName, hits: c.hits, hitsMax: c.hitsMax, fatigue: c.fatigue || 0 } : null;
}

function runAttackerLoot(creep, w, room) {
    const h = escortHealerFor(creep, w, room);
    if (!war.noClaimer() && !war.locked(room)) {
        if (h && inTarget(h) && war.dist(creep, h) > 1 && escortReady(h, creep)) goWar(creep, h.pos, 1);
        return;
    }
    const target = (war.noClaimer() && breachWall(room, w)) || lootAttackTarget(creep, room);
    if (!target) { if (h && inTarget(h) && war.dist(creep, h) > 1) goWar(creep, h.pos, 1); return; }
    if (creep.pos.isNearTo(target.pos)) { creep.attack(target); return; }
    if (!escortReady(creep, h)) return;
    goWar(creep, target.pos, 1);
}

function towerDmgAt(t, pos) {
    if (!t || !t.pos) return 0;
    const e = t.store ? (t.store.energy != null ? Number(t.store.energy) : 10) : 10;
    if (e < 10) return 0;
    const r = Math.max(Math.abs(t.pos.x - pos.x), Math.abs(t.pos.y - pos.y));
    if (r <= 5) return 600;
    if (r >= 20) return 150;
    return 600 - (r - 5) * 30;
}

function squadHealTarget(creep, room) {
    const towers = room ? enemyTowers(room).filter(notAlly) : [];
    const mates = war.liveWarAll().filter((c) => c.room && c.room.name === creep.room.name && creep.pos.inRangeTo(c.pos, 3));
    if (!mates.some((c) => c.name === creep.name)) mates.push(creep);
    let best = null;
    let bv = Infinity;
    for (const c of mates) {
        const inc = towers.reduce((n, t) => n + towerDmgAt(t, c.pos), 0);
        const v = (c.hits - inc) / c.hitsMax;
        const near = creep.pos.isNearTo(c.pos) ? 0 : 0.0001;
        if (v + near < bv) { bv = v + near; best = c; }
    }
    return best;
}

function runHealerLoot(creep, w, room) {
    const leader = escortLeaderFor(creep, w, room);
    if (war.noClaimer()) {
        const t = squadHealTarget(creep, room);
        if (t) { if (t.name === creep.name || creep.pos.isNearTo(t.pos)) creep.heal(t); else creep.rangedHeal(t); }
        if (stepOffEdge(creep)) return;
        if (leader && inTarget(leader) && war.dist(creep, leader) > 1) goWar(creep, leader.pos, 1);
        return;
    }
    const inTower = enemyTowers(room).length > 0;
    const plan = escort.healPlan(cpos(leader), cpos(creep), inTower);
    if (plan && plan.target) {
        const tc = leader && inTarget(leader) && plan.target.x === leader.pos.x && plan.target.y === leader.pos.y ? leader : creep;
        if (plan.kind === 'heal') creep.heal(tc);
        else if (plan.kind === 'rangedHeal') creep.rangedHeal(tc);
        else if (creep.hits < creep.hitsMax) creep.heal(creep);
    } else {
        const h1 = mostHurtInRange(creep, 1);
        if (h1) creep.heal(h1);
        else { const h3 = mostHurtInRange(creep, 3); if (h3) creep.rangedHeal(h3); else if (creep.hits < creep.hitsMax) creep.heal(creep); }
    }
    if (stepOffEdge(creep)) return;
    if (leader && inTarget(leader) && war.dist(creep, leader) > 1) goWar(creep, leader.pos, 1);
}

function runClaimerLoot(creep, w, room, ctrl) {
    const h = escortHealerFor(creep, w, room);
    if (creep.pos.isNearTo(ctrl.pos)) { creep.attackController(ctrl); return; }
    if (h && inTarget(h) && !escortReady(creep, h) && creep.pos.y < 48) return;
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
    if (d === 1) { goWar(creep, pos, 0); return; }
    if (creep.memory) creep.memory.stompAt = { x: pos.x, y: pos.y, t: Game.time };
    goWar(creep, pos, 1);
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
    const scan = war.clearScan(room);
    if (scan && war.clearCfg().pairHomeAfterSites && !scan.creeps.length && !scan.sites.length) { homeUnboost(creep, w); return; }
    const t = war.clearTarget(creep, scan);
    const hFar = !!scan && scan.creeps.length > 0 && h && inTarget(h) && war.dist(creep, h) > 2;
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
    if (scan && !scan.creeps.length) {
        const at = war.clearTarget(a, scan);
        const site = scan.sites.length ? war.pickSite(creep, scan.sites, at && at.kind === 'site' ? at.obj.id : null) : null;
        if (site) {
            healAround(creep);
            if (stepOffEdge(creep)) return;
            stomp(creep, site.pos);
            return;
        }
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
    const canHit = !war.noClaimer() && (creep.body || []).some((p) => p.type === 'attack');
    const hostiles = canHit ? (room.find(FIND_HOSTILE_CREEPS) || []) : [];
    if (hostiles.length) {
        const t = creep.pos.findClosestByRange(hostiles);
        if (creep.pos.isNearTo(t.pos)) creep.attack(t); else goWar(creep, t.pos, 1);
        return;
    }
    const scan = war.clearScan(room);
    const site = scan && scan.liveSites.length ? war.pickSite(creep, scan.liveSites, null) : null;
    if (site) { stomp(creep, site.pos); return; }
    const park = war.clearCfg().watchPark || wcfg().controllerPos || { x: 22, y: 20 };
    if (creep.pos.x === park.x && creep.pos.y === park.y) return;
    if (stepOffEdge(creep)) return;
    stomp(creep, targetRoomPos(park));
}

function hostileCombat(room) {
    if (!room) return false;
    return (room.find(FIND_HOSTILE_CREEPS) || []).some((c) => (c.body || []).some((p) => (p.type === 'attack' || p.type === 'ranged_attack' || p.type === 'heal' || p.type === 'work') && p.hits > 0));
}

function dismantlerFinish(creep, w) {
    if (!creep.memory.done) { creep.memory.done = Game.time; war.logEvent('dismantlerDone', { name: creep.name, left: w.clear && w.clear.left }); }
    creep.memory.retired = true;
    retireMod.retireAtSpawn(creep);
}

function runDismantler(creep, w, room) {
    if (creep.memory.done || w.mode !== 'clear') { dismantlerFinish(creep, w); return; }
    const danger = !!w.enemySafe || w.phase === 'safemode' || (!!room && hostileCombat(room));
    if (danger) {
        if (!creep.memory.fled) { creep.memory.fled = Game.time; war.logEvent('retreat', { reason: w.enemySafe || w.phase === 'safemode' ? 'enemySafeMode' : 'hostile', who: creep.name }); }
        retreatHome(creep);
        return;
    }
    if (creep.memory.fled) { delete creep.memory.fled; war.logEvent('resume', { who: creep.name }); }
    if (!inTarget(creep)) { intoTarget(creep); return; }
    if (stepOffEdge(creep)) return;
    const scan = war.clearScan(room);
    if (!scan) return;
    const range = Number(war.clearCfg().siteRange) || 5;
    const nearSites = scan.sites.filter((o) => Math.max(Math.abs(o.pos.x - creep.pos.x), Math.abs(o.pos.y - creep.pos.y)) <= range);
    const site = nearSites.length ? war.pickSite(creep, nearSites, null) : null;
    if (site) { stomp(creep, site.pos); return; }
    if (!scan.structs.length) { dismantlerFinish(creep, w); return; }
    let obj = war.pickStruct(creep, scan.structs);
    if (typeof room.lookForAt === 'function') {
        const kind = typeof LOOK_STRUCTURES !== 'undefined' ? LOOK_STRUCTURES : 'structure';
        const ramp = (room.lookForAt(kind, obj.pos.x, obj.pos.y) || []).find((s) => s.structureType === 'rampart' && !s.my);
        if (ramp) obj = ramp;
    }
    if (creep.pos.isNearTo(obj.pos)) { creep.dismantle(obj); return; }
    goWar(creep, obj.pos, 1);
}

function runPhase2(creep, w) {
    const room = Game.rooms[war.target()];
    const role = creep.memory.warRole;
    if (role === 'attacker' || role === 'healer') {
        if (w.phase === 'safemode' || w.costCapped || w.enemySafe) { homeUnboost(creep, w); return; }
        if (role === 'attacker') clearAttacker(creep, w, room); else clearHealer(creep, w, room);
        return;
    }
    if (role === 'dismantler') { runDismantler(creep, w, room); return; }
    if (w.phase === 'safemode' || w.enemySafe) { retreatHome(creep); return; }
    if (role === 'claimer' && war.noClaimer()) { creep.memory.retired = true; retireMod.retireAtSpawn(creep); return; }
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

const HUNT_RANK = [/^(Builder|Maintenance)/, /^Upgrader/, /^(Miner|Harvester)/];

function huntRank(c) {
    const n = String((c && c.name) || '');
    const i = HUNT_RANK.findIndex((re) => re.test(n));
    return i < 0 ? HUNT_RANK.length : i;
}

function huntPick(creep, list) {
    let best = null;
    let bk = null;
    for (const c of list) {
        const k = [huntRank(c), war.dist(creep, c)];
        if (!bk || k[0] < bk[0] || (k[0] === bk[0] && k[1] < bk[1])) { bk = k; best = c; }
    }
    return best;
}

function huntDone(creep, why) {
    creep.memory.retired = true;
    war.logEvent('huntDone', { name: creep.name, why, ttl: creep.ticksToLive });
    retireMod.retireAtSpawn(creep);
}

function runHunter(creep) {
    if (creep.spawning) return;
    const room = Game.rooms[war.target()];
    const w = war.state() || {};
    if (w.enemySafe || (room && room.controller && room.controller.safeMode)) { huntDone(creep, 'safemode'); return; }
    if (!inTarget(creep)) { intoTarget(creep); return; }
    const scan = war.clearScan(room);
    const foes = scan ? scan.creeps.filter((c) => !c.spawning) : [];
    if (!foes.length) {
        if (scan && !scan.creeps.length) huntDone(creep, 'cleared');
        else if (stepOffEdge(creep)) return;
        return;
    }
    const t = huntPick(creep, foes);
    if (creep.pos.isNearTo(t.pos)) { creep.attack(t); return; }
    if (stepOffEdge(creep)) return;
    goWar(creep, t.pos, 1);
}

function run(creep) {
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    if (creep.memory.warRole === 'hunter') { runHunter(creep); return; }
    const w = war.state();
    if (!w) {
        if (war.paused()) holdPaused(creep);
        else retreatHome(creep);
        return;
    }
    if (w.mode) { if (!creep.spawning) runPhase2(creep, w); return; }
    if (creep.memory.warRole === 'healer' && w.phase === 'staging' && creep.ticksToLive != null && creep.ticksToLive < war.timing().healerEntryTtl) {
        const other = war.liveWar('healer').find((c) => c.name !== creep.name && !c.spawning && war.fullyBoosted(c));
        if (other && war.noClaimer()) {
            if (!creep.memory.unfit) { creep.memory.unfit = Game.time; war.logEvent('healerUnfit', { name: creep.name, ttl: creep.ticksToLive, by: other.name, kept: true }); }
        } else if (other) {
            creep.memory.retired = true;
            war.logEvent('healerRetire', { name: creep.name, ttl: creep.ticksToLive, by: other.name });
            retireMod.retireAtSpawn(creep);
            return;
        }
    }
    if (w.withdraw) { if (creep.memory.warRole === 'dismantler') retreatHome(creep); else homeUnboost(creep, w); return; }
    if (w.costCapped) { retreatHome(creep); if (creep.memory.warRole === 'healer') healAround(creep); return; }
    if (boostRetry(creep)) return;
    if (boost.run(creep)) return;
    const room = Game.rooms[war.target()];
    if (w.phase === 'safemode') { retreatHome(creep); if (creep.memory.warRole === 'healer') healAround(creep); return; }
    if (creep.memory.warRole === 'attacker') runAttacker(creep, w, room);
    else if (creep.memory.warRole === 'healer') runHealer(creep, w, room);
    else if (creep.memory.warRole === 'claimer') runClaimer(creep, w, room);
    else if (creep.memory.warRole === 'dismantler') runDismantlerLoot(creep, w, room);
}

function mostHurtInRange(creep, range) {
    let best = null;
    let bestRatio = 1;
    for (const c of war.liveWar()) {
        if (!c || c.spawning || war.roomOf(c) !== creep.room.name) continue;
        if (c.hits >= c.hitsMax) continue;
        if (war.dist(creep, c) > range) continue;
        const ratio = c.hits / c.hitsMax;
        if (ratio < bestRatio) { bestRatio = ratio; best = c; }
    }
    return best;
}

function wallOrRampAt(room, x, y, allowOverLoot) {
    if (!room || typeof room.lookForAt !== 'function') return null;
    const lk = typeof LOOK_STRUCTURES !== 'undefined' ? LOOK_STRUCTURES : 'structure';
    const here = room.lookForAt(lk, x, y) || [];
    const wall = here.find((o) => o.structureType === 'constructedWall' && notAlly(o));
    if (wall) return wall;
    const ramp = here.find((o) => o.structureType === 'rampart' && !o.my && notAlly(o));
    if (!ramp) return null;
    if (allowOverLoot) return ramp;
    const loot = here.find((o) => war.FORBIDDEN_LOOT.indexOf(o.structureType) >= 0);
    return loot ? null : ramp;
}

function dismantleTargetLoot(creep, w, room) {
    const wc = wcfg();
    if (wc.breach && !w.breachDone) {
        const b = wallOrRampAt(room, wc.breach.x, wc.breach.y, true);
        if (b) return b;
    }
    const towers = enemyTowers(room).filter(notAlly);
    const order = wc.towerOrder || [];
    for (const o of order) {
        const t = towers.find((tw) => tw.pos.x === o.x && tw.pos.y === o.y);
        if (!t) continue;
        const r = wallOrRampAt(room, t.pos.x, t.pos.y, false);
        if (r) return r;
    }
    for (const t of towers) {
        const r = wallOrRampAt(room, t.pos.x, t.pos.y, false);
        if (r) return r;
    }
    const sp = wc.spawnPos;
    if (sp) {
        const spawns = (room.find(FIND_HOSTILE_SPAWNS) || []).filter(notAlly);
        const es = spawns.find((s) => s.pos.x === sp.x && s.pos.y === sp.y) || spawns[0];
        if (es) { const r = wallOrRampAt(room, es.pos.x, es.pos.y, false); if (r) return r; }
    }
    const objs = [];
    if (wc.breach && !w.breachDone) objs.push(wc.breach);
    for (const t of towers) objs.push(t.pos);
    if (!objs.length) return null;
    let near = null;
    let nd = Infinity;
    for (const o of objs) { const d = Math.max(Math.abs(creep.pos.x - o.x), Math.abs(creep.pos.y - o.y)); if (d < nd) { nd = d; near = o; } }
    if (!near) return null;
    let blk = null;
    let bd = nd;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = creep.pos.x + dx;
            const y = creep.pos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            const d = Math.max(Math.abs(x - near.x), Math.abs(y - near.y));
            if (d >= nd) continue;
            const wr = wallOrRampAt(room, x, y, false);
            if (wr && d < bd) { bd = d; blk = wr; }
        }
    }
    return blk;
}

function recycleDismantler(creep, w) {
    if (!creep.memory.done) { creep.memory.done = Game.time; war.logEvent('dismantlerDone', { name: creep.name, breachDone: w.breachDone || null, towersDownAt: w.towersDownAt || null }); }
    if (creep.room.name === creep.memory.home) { creep.memory.retired = true; retireMod.retireAtSpawn(creep); return; }
    retreatHome(creep);
}

function runDismantlerLoot(creep, w, room) {
    if (w.phase === 'staging') { toGather(creep); return; }
    if (!inTarget(creep)) { crossOrHold(creep, w); return; }
    if (stepOffEdge(creep)) return;
    if (creep.memory.done || w.towersDownAt) { recycleDismantler(creep, w); return; }
    const target = dismantleTargetLoot(creep, w, room);
    if (!target) { recycleDismantler(creep, w); return; }
    if (creep.pos.isNearTo(target.pos)) { creep.dismantle(target); return; }
    goWar(creep, target.pos, 1);
}

module.exports = { run, boostRetry, lootAttackTarget, escortReady, escortLeaderFor, escortHealerFor, dismantleTargetLoot, runDismantlerLoot };
