'use strict';
const movement = require('movement');
const conquest = require('conquest');
const boost = require('boost');
const actions = require('actions');

function squadMates(creep) {
    const out = [];
    for (const name in Game.creeps) {
        const other = Game.creeps[name];
        if (!other.memory) continue;
        const role = other.memory.role;
        if (role !== 'siegeDismantler' && role !== 'siegeGuard') continue;
        if (other.memory.targetRoom !== creep.memory.targetRoom) continue;
        if (other.spawning) continue;
        out.push(other);
    }
    return out;
}

const STAGE_OFFSET = 8;
function stagePos(staging, target) {
    const map = (typeof Game !== 'undefined' && Game.map && Game.map.findExit) ? Game.map : null;
    const dir = map ? map.findExit(staging, target) : null;
    const o = STAGE_OFFSET;
    const L = typeof FIND_EXIT_LEFT === 'undefined' ? 7 : FIND_EXIT_LEFT;
    const R = typeof FIND_EXIT_RIGHT === 'undefined' ? 3 : FIND_EXIT_RIGHT;
    const T = typeof FIND_EXIT_TOP === 'undefined' ? 1 : FIND_EXIT_TOP;
    const B = typeof FIND_EXIT_BOTTOM === 'undefined' ? 5 : FIND_EXIT_BOTTOM;
    if (dir === L) return new RoomPosition(o, 25, staging);
    if (dir === R) return new RoomPosition(49 - o, 25, staging);
    if (dir === T) return new RoomPosition(25, o, staging);
    if (dir === B) return new RoomPosition(25, 49 - o, staging);
    return new RoomPosition(25, 25, staging);
}

function avoidSet(creep, target) {
    const set = new Set([target]);
    const extra = creep.memory.avoid;
    if (Array.isArray(extra)) for (const r of extra) set.add(r);
    return set;
}

function hasHeal(creep) { return (creep.body || []).some((p) => p.type === HEAL && (p.hits === undefined || p.hits > 0)); }
function canAttack(creep) {
    return (creep.body || []).some((p) => (p.type === ATTACK || p.type === RANGED_ATTACK) && (p.hits === undefined || p.hits > 0));
}
function threatScore(creep) {
    let s = 0;
    for (const p of (creep.body || [])) {
        if (p.hits !== undefined && p.hits <= 0) continue;
        if (p.type === HEAL) s += 3;
        else if (p.type === RANGED_ATTACK) s += 2;
        else if (p.type === ATTACK) s += 2;
    }
    return s;
}
function hasLiveMelee(creep) {
    return (creep.body || []).some((p) => p.type === ATTACK && (p.hits === undefined || p.hits > 0));
}
function fleeFrom(creep, enemy) {
    const ex = (enemy.pos && enemy.pos.x !== undefined) ? enemy.pos.x : creep.pos.x;
    const ey = (enemy.pos && enemy.pos.y !== undefined) ? enemy.pos.y : creep.pos.y;
    const sx = creep.pos.x >= ex ? 1 : -1;
    const sy = creep.pos.y >= ey ? 1 : -1;
    const tx = Math.max(3, Math.min(46, creep.pos.x + sx * 3));
    const ty = Math.max(3, Math.min(46, creep.pos.y + sy * 3));
    movement.go(creep, new RoomPosition(tx, ty, creep.room.name), { range: 0, reusePath: 1 });
}

function healSupport(creep) {
    if (!hasHeal(creep)) return;
    const cand = creep.pos.findInRange(FIND_MY_CREEPS, 3) || [];
    const deficitOf = (c) => (c.hitsMax || 0) - (c.hits || 0);
    let best = null;
    let bestDeficit = 0;
    for (const c of cand) {
        const deficit = deficitOf(c);
        if (deficit > bestDeficit) { bestDeficit = deficit; best = c; }
    }
    if (bestDeficit <= 0) return;
    if (creep.pos.getRangeTo(best) <= 1) { creep.heal(best); actions.note(creep, 'heal'); return; }
    if (actions.wouldVoid(creep, 'rangedHeal')) {
        actions.skipped('rangedHeal');
        let near = null;
        let nearDeficit = 0;
        for (const c of cand) {
            if (creep.pos.getRangeTo(c) > 1) continue;
            const deficit = deficitOf(c);
            if (deficit > nearDeficit) { nearDeficit = deficit; near = c; }
        }
        if (near) { creep.heal(near); actions.note(creep, 'heal'); }
        return;
    }
    creep.rangedHeal(best);
    actions.note(creep, 'rangedHeal');
}

function run(creep) {
    const target = creep.memory.targetRoom;
    if (require('pvp').fleeHighThreat(creep)) return;
    if (!target) return;
    conquest.recordHostileTowers(creep.room, creep);
    const staging = creep.memory.staging || target;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);

    if (creep.room.name !== target) {
        if (boost.run(creep)) return;
        if (conquest.boostGateHold(target)) {
            if (creep.room.name !== (creep.memory.home || target)) movement.go(creep, new RoomPosition(25, 25, creep.memory.home || target), { range: 20, reusePath: 15 });
            healSupport(creep);
            return;
        }
        const avoid = avoidSet(creep, target);
        if (squad > 1 && creep.room.name === staging && !creep.memory.launched) {
            if (creep.memory.stagedAt == null) creep.memory.stagedAt = Game.time;
            const here = squadMates(creep).filter((m) => m.room && m.room.name === staging).length;
            const stageWait = conquest.settings().stageWait;
            if (here < squad && Game.time - creep.memory.stagedAt < (stageWait == null ? 200 : stageWait)) {
                const spot = conquest.holdTile(stagePos(staging, target), creep.name, 0);
                if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 20, avoidRooms: avoid });
                healSupport(creep);
                return;
            }
            creep.memory.launched = true;
        }
        if (squad <= 1 || creep.memory.launched || staging === target) {
            const laneW = conquest.settings().entryLaneWidth;
            const avoidTowers = conquest.towerAvoidCallback(target, creep.memory.avoidTowers);
            if (laneW > 0) {
                const entry = stagePos(target, staging);
                movement.go(creep, conquest.laneTile(entry, creep.name, laneW, entry.x === 25), { range: 5, reusePath: 20, costCallback: avoidTowers });
            } else {
                movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40, costCallback: avoidTowers });
            }
        } else {
            movement.go(creep, stagePos(staging, target), { range: 3, reusePath: 40, avoidRooms: avoid, costCallback: conquest.towerAvoidCallback(target, creep.memory.avoidTowers) });
        }
        healSupport(creep);
        return;
    }

    const ctrl = creep.room.controller;
    if (ctrl && ctrl.safeMode && ctrl.safeMode > 0) {
        creep.memory.launched = false;
        delete creep.memory.pushed;
        delete creep.memory.enteredAt;
        movement.go(creep, new RoomPosition(25, 25, staging), { range: 20, reusePath: 15 });
        healSupport(creep);
        return;
    }
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        healSupport(creep);
        return;
    }

    let reforming = false;
    if (!creep.memory.pushed) {
        if (creep.memory.enteredAt == null) creep.memory.enteredAt = Game.time;
        const cfg = conquest.settings();
        const inRoom = Math.max(1, squadMates(creep).filter((m) => m.room && m.room.name === target).length);
        const need = Math.min(squad, Math.max(1, Math.ceil(squad * (cfg.reformShare == null ? 0.7 : cfg.reformShare))));
        if (inRoom < need && Game.time - creep.memory.enteredAt < (cfg.reformWait == null ? 60 : cfg.reformWait)) reforming = true;
        else creep.memory.pushed = true;
    }
    const rallySpot = () => conquest.holdTile(stagePos(target, staging), creep.name, 0);

    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS) || [];
    const threats = hostiles.filter(canAttack).sort((a, b) => threatScore(b) - threatScore(a));
    if (threats.length) {
        const topScore = threatScore(threats[0]);
        const top = threats.filter((c) => threatScore(c) === topScore);
        const tgt = creep.pos.findClosestByRange(top) || top[0];
        const range = creep.pos.getRangeTo(tgt);
        const adj = hostiles.filter((h) => creep.pos.getRangeTo(h) <= 1).length;
        if (range <= 3) {
            if (adj >= 2) { creep.rangedMassAttack(); actions.note(creep, 'rangedMassAttack'); }
            else { creep.rangedAttack(tgt); actions.note(creep, 'rangedAttack'); }
        }
        const melee = hostiles.filter(hasLiveMelee);
        const nearMelee = melee.length ? creep.pos.findClosestByRange(melee) : null;
        if (nearMelee && creep.pos.getRangeTo(nearMelee) <= 3) {
            fleeFrom(creep, nearMelee);
        } else if (reforming) {
            const rally = rallySpot();
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
        } else if (range > 3) {
            movement.go(creep, tgt, { range: 3, reusePath: 2 });
        }
    } else {
        const wounded = (creep.pos.findInRange(FIND_MY_CREEPS, 3) || []).some((c) => (c.hitsMax || 0) > (c.hits || 0));
        if (creep.memory.suppress && hostiles.length && !wounded && !reforming) {
            const tgt = creep.pos.findClosestByRange(hostiles) || hostiles[0];
            const range = creep.pos.getRangeTo(tgt);
            if (range <= 3) { creep.rangedAttack(tgt); actions.note(creep, 'rangedAttack'); }
            if (range > 1) movement.go(creep, tgt.pos || tgt, { range: 1, reusePath: 2 });
        } else if (reforming) {
            const rally = rallySpot();
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
        } else if (!wounded && ctrl) {
            const spot = conquest.holdTile(ctrl.pos, creep.name, 2);
            if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 10 });
        }
        const near = creep.pos.findClosestByRange(hostiles);
        if (near && creep.pos.getRangeTo(near) <= 3) { creep.rangedAttack(near); actions.note(creep, 'rangedAttack'); }
    }
    healSupport(creep);
}

module.exports = { run, squadMates, threatScore };
