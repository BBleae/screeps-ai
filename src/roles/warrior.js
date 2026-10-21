'use strict';
const config = require('config');
const movement = require('movement');
const boost = require('boost');
const retireMod = require('retire');
const war = require('war');

function wcfg() {
    return config.war || {};
}

function avoidSet() {
    const list = (wcfg().avoid || ['W37S3', 'W37S2', 'W37S1', 'W39S1', 'W39S2', 'W39S3']);
    return new Set(list);
}

function goWar(creep, pos, range) {
    movement.go(creep, pos, { range: range == null ? 1 : range, reusePath: 10, avoidRooms: avoidSet() });
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

function staging(creep) {
    const st = wcfg().staging || 'W38S3';
    if (creep.room.name !== st) { goWar(creep, new RoomPosition(25, 25, st), 22); return; }
    const edge = wcfg().stagingTile;
    if (edge) goWar(creep, new RoomPosition(edge.x, edge.y, st), 0);
}

function targetRoomPos(xy) {
    return new RoomPosition(xy.x, xy.y, war.target());
}

function enemyTowers(room) {
    return (room.find(FIND_HOSTILE_STRUCTURES) || []).filter((s) => s.structureType === STRUCTURE_TOWER);
}

function upgradeBlockedOn(room) {
    const ctrl = room && room.controller;
    return ctrl ? Number(ctrl.upgradeBlocked) || 0 : 0;
}


function lowestSquad(creep) {
    let best = null;
    let bestDeficit = -1;
    const mates = war.liveWar();
    for (const c of mates) {
        if (!c || c.spawning || !c.room || c.room.name !== creep.room.name) continue;
        const deficit = c.hitsMax - c.hits;
        let score = deficit;
        if (c.memory.warRole === 'claimer' && deficit > 0) score += 100000;
        if (score > bestDeficit) { bestDeficit = score; best = c; }
    }
    return best;
}

function runAttacker(creep, w, room) {
    const assault = w.phase === 'assault' || w.phase === 'won';
    if (!assault) { staging(creep); return; }
    const spawnXy = wcfg().spawnPos || { x: 30, y: 22 };
    if (creep.room.name !== war.target()) { goWar(creep, targetRoomPos(spawnXy), 1); return; }
    const blocked = upgradeBlockedOn(room) > 0;
    const target = pickAttackTarget(creep, room);
    if (!blocked) {
        const anchor = targetRoomPos(spawnXy);
        if (!creep.pos.inRangeTo(anchor, 1)) goWar(creep, anchor, 1);
        return;
    }
    if (!target) { goWar(creep, targetRoomPos(spawnXy), 1); return; }
    if (creep.pos.isNearTo(target.pos)) creep.attack(target);
    else { goWar(creep, target.pos, 1); creep.attack(target); }
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

function runHealer(creep, w) {
    const assault = w.phase === 'assault' || w.phase === 'won';
    if (!assault) { staging(creep); healAround(creep); return; }
    const attacker = war.liveWar('attacker')[0];
    const low = lowestSquad(creep);
    if (low && !creep.pos.inRangeTo(low.pos, 1) && creep.pos.inRangeTo(low.pos, 3)) {
        creep.rangedHeal(low);
    } else if (low && creep.pos.isNearTo(low.pos)) {
        creep.heal(low);
    } else {
        healAround(creep);
    }
    const follow = low || attacker;
    if (follow && !creep.pos.inRangeTo(follow.pos, 1)) goWar(creep, follow.pos, 1);
}

function healAround(creep) {
    if (creep.hits < creep.hitsMax) { creep.heal(creep); return; }
    const near = creep.pos.findClosestByRange(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax && c.id !== creep.id });
    if (!near) return;
    if (creep.pos.isNearTo(near.pos)) creep.heal(near);
    else if (creep.pos.inRangeTo(near.pos, 3)) creep.rangedHeal(near);
}

function claimerWaypoint(creep) {
    const st = wcfg().staging || 'W38S3';
    if (creep.room.name === st) {
        return new RoomPosition(22, 0, st);
    }
    if (creep.room.name === war.target()) {
        const mid = wcfg().claimerApproach || { x: 22, y: 5 };
        if (creep.pos.y > 12) return targetRoomPos(mid);
        return targetRoomPos(wcfg().controllerPos || { x: 22, y: 20 });
    }
    return new RoomPosition(22, 0, st);
}

function runClaimer(creep, w, room) {
    if (w.phase === 'safemode') { retreatHome(creep); return; }
    if (w.phase === 'staging' && creep.room.name !== war.target()) { staging(creep); return; }
    const ctrlXy = wcfg().controllerPos || { x: 22, y: 20 };
    if (creep.room.name !== war.target()) {
        creep.memory.edgeHold = true;
        goWar(creep, claimerWaypoint(creep), 0);
        return;
    }
    if (creep.memory.edgeHold) {
        const dist = Math.min(creep.pos.x, creep.pos.y, 49 - creep.pos.x, 49 - creep.pos.y);
        if (dist <= 3 && !creep.memory.edgeHoldDone) {
            creep.memory.edgeHoldDone = true;
            delete creep.memory.edgeHold;
        } else if (!creep.memory.edgeHoldDone) {
            goWar(creep, new RoomPosition(creep.pos.x, Math.min(creep.pos.y + 2, 46), war.target()), 0);
            return;
        }
    }
    const ctrl = room.controller;
    if (!ctrl) return;
    if (!creep.pos.isNearTo(ctrl.pos)) {
        const approach = claimerWaypoint(creep);
        if (creep.pos.y > 12 && !creep.pos.isEqualTo(approach)) goWar(creep, approach, 0);
        else goWar(creep, ctrl.pos, 1);
        creep.attackController(ctrl);
        return;
    }
    creep.attackController(ctrl);
}

function run(creep) {
    if (creep.memory.retired) { retireMod.retireAtSpawn(creep); return; }
    if (boost.run(creep)) return;
    const w = war.state();
    if (!w) { retreatHome(creep); return; }
    const room = Game.rooms[war.target()];

    if (w.phase === 'safemode') { retreatHome(creep); if (creep.memory.warRole === 'healer') healAround(creep); return; }

    if (creep.memory.warRole !== 'claimer' && (w.phase === 'assault' || w.phase === 'won')) {
        const attacker = war.liveWar('attacker')[0];
        const healer = war.liveWar('healer')[0];
        const line = Number(wcfg().retreatBelow) || 0.5;
        const hurt = (attacker && attacker.hits < attacker.hitsMax * line) ||
            (healer && healer.hits < healer.hitsMax * line) ||
            (creep.hits < creep.hitsMax * line);
        const healerDead = !healer;
        if (hurt || healerDead) {
            staging(creep);
            if (creep.memory.warRole === 'healer') healAround(creep);
            war.logEvent('retreat', { reason: healerDead ? 'healerDead' : 'hurt', who: creep.memory.warRole });
            return;
        }
    }

    if (creep.memory.warRole === 'attacker') runAttacker(creep, w, room);
    else if (creep.memory.warRole === 'healer') runHealer(creep, w);
    else if (creep.memory.warRole === 'claimer') runClaimer(creep, w, room);
}

module.exports = { run };
