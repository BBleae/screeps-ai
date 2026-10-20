'use strict';
const movement = require('movement');
const retire = require('retire');
const conquest = require('conquest');
const boost = require('boost');

function fastDismantle(creep, target) {
    const m = creep.memory;
    if (!m.tgt || creep.room.name !== target || !m.salvageLoot) return false;
    if (Game.time % 10 === 0 && conquest.retreatFor(target)) { delete m.tgt; return false; }
    if (Game.time - (m.tgtAt || 0) > 100) { delete m.tgt; return false; }
    const obj = Game.getObjectById(m.tgt);
    if (!obj) { delete m.tgt; return false; }
    const rc = creep.dismantle(obj);
    if (rc === OK) return true;
    if (rc === ERR_NOT_IN_RANGE) { movement.go(creep, obj, { range: 1, reusePath: 50 }); return true; }
    delete m.tgt;
    return false;
}

function hitTarget(creep, obj) {
    creep.memory.tgt = obj.id;
    creep.memory.tgtAt = Game.time;
    if (creep.dismantle(obj) === ERR_NOT_IN_RANGE) movement.go(creep, obj, { range: 1, reusePath: 50 });
}

const mateCache = { tick: -1, by: {} };
function squadMates(creep) {
    if (mateCache.tick !== Game.time) { mateCache.tick = Game.time; mateCache.by = {}; }
    const key = creep.memory.targetRoom;
    if (mateCache.by[key]) return mateCache.by[key];
    const out = [];
    for (const name in Game.creeps) {
        const other = Game.creeps[name];
        if (!other.memory) continue;
        const role = other.memory.role;
        if (role !== 'siegeDismantler' && role !== 'siegeGuard') continue;
        if (other.memory.targetRoom !== key) continue;
        if (other.spawning) continue;
        out.push(other);
    }
    mateCache.by[key] = out;
    return out;
}

function hostileStructures(room, type) {
    return room.find(FIND_STRUCTURES).filter((s) => s.structureType === type && s.owner && !s.my && !require('utils').isAlly(s));
}

function towerEnergy(t) {
    if (t.store && typeof t.store.getUsedCapacity === 'function') return t.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (typeof t.energy === 'number') return t.energy;
    return 0;
}
const TOWER_MIN_FIRE = (typeof TOWER_ENERGY_COST !== 'undefined') ? TOWER_ENERGY_COST : 10;

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
    const set = new Set(movement.civilianDangerRooms());
    set.add(target);
    const extra = creep.memory.avoid;
    if (Array.isArray(extra)) for (const r of extra) set.add(r);
    return set;
}


function lootHoldRun(creep) {
    if (typeof Memory === 'undefined') return false;
    const m = creep.memory;
    if (m.retired) return false;
    const lr = require('config').lootRoutes || {};
    const list = lr[m.targetRoom];
    const back = lr.reentry && lr.reentry[creep.room.name];
    if (back && Array.isArray(list) && list.indexOf(creep.room.name) < 0) {
        movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 50, avoidRooms: new Set(lr.hardAvoid || []) });
        return true;
    }
    const h = Memory.lootHold;
    if (!h || !(h === true || h[m.targetRoom])) return false;
    const home = m.home;
    if (!home) return false;
    if (creep.room.name !== home) { movement.go(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 }); return true; }
    const p = creep.pos;
    if (p.x <= 2 || p.x >= 47 || p.y <= 2 || p.y >= 47) movement.go(creep, new RoomPosition(25, 25, home), { range: 15, reusePath: 50 });
    return true;
}

function run(creep) {
    if (lootHoldRun(creep)) return;
    const target = creep.memory.targetRoom;
    if (!target) return;
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
    if (fastDismantle(creep, target)) return;
    if (!(creep.memory._rtAt > Game.time - 10)) { creep.memory._rtAt = Game.time; conquest.recordHostileTowers(creep.room, creep); }
    if (creep.memory.strongholdLoot && conquest.retreatFor(target)) {
        const back = creep.memory.staging || creep.memory.home || target;
        if (creep.room.name !== back) movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 15 });
        return;
    }
    const staging = creep.memory.staging || target;
    const squad = Math.max(1, Number(creep.memory.squad) || 1);

    if (creep.room.name !== target) {
        if (boost.run(creep)) return;
        const avoid = avoidSet(creep, target);
        if (creep.memory.strongholdLoot && conquest.boostGateHold(target)) {
            if (creep.room.name !== (creep.memory.home || target)) movement.go(creep, new RoomPosition(25, 25, creep.memory.home || target), { range: 20, reusePath: 15 });
            return;
        }
        if (squad > 1 && creep.room.name === staging && !creep.memory.launched) {
            if (creep.memory.stagedAt == null) creep.memory.stagedAt = Game.time;
            const here = squadMates(creep).filter((m) => m.room && m.room.name === staging).length;
            const stageWait = conquest.settings().stageWait;
            if (here < squad && Game.time - creep.memory.stagedAt < (stageWait == null ? 200 : stageWait)) {
                const spot = conquest.holdTile(stagePos(staging, target), creep.name, 0);
                if (!creep.pos.inRangeTo(spot, 0)) movement.go(creep, spot, { range: 0, reusePath: 20, avoidRooms: avoid });
                return;
            }
            creep.memory.launched = true;
        }
        if (squad <= 1 || creep.memory.launched || staging === target) {
            const laneW = conquest.settings().entryLaneWidth;
            const avoidTowers = creep.memory.salvageLoot ? undefined : conquest.towerAvoidCallback(target, creep.memory.avoidTowers);
            if (laneW > 0) {
                const entry = stagePos(target, staging);
                movement.go(creep, conquest.laneTile(entry, creep.name, laneW, entry.x === 25), { range: 5, reusePath: 20, costCallback: avoidTowers });
            } else {
                movement.go(creep, new RoomPosition(25, 25, target), { range: 20, reusePath: 40, costCallback: avoidTowers });
            }
        } else {
            movement.go(creep, stagePos(staging, target), { range: 3, reusePath: 40, avoidRooms: avoid, costCallback: creep.memory.salvageLoot ? undefined : conquest.towerAvoidCallback(target, creep.memory.avoidTowers) });
        }
        return;
    }

    const ctrl = creep.room.controller;
    if (ctrl && ctrl.safeMode && ctrl.safeMode > 0) {
        creep.memory.launched = false;
        delete creep.memory.pushed;
        delete creep.memory.enteredAt;
        movement.go(creep, new RoomPosition(25, 25, staging), { range: 20, reusePath: 15 });
        return;
    }
    if (creep.pos.x <= 0 || creep.pos.x >= 49 || creep.pos.y <= 0 || creep.pos.y >= 49) {
        movement.go(creep, new RoomPosition(25, 25, creep.room.name), { range: 20, reusePath: 10 });
        return;
    }
    if (!creep.memory.pushed) {
        if (creep.memory.enteredAt == null) creep.memory.enteredAt = Game.time;
        const cfg = conquest.settings();
        const inRoom = Math.max(1, squadMates(creep).filter((m) => m.room && m.room.name === target).length);
        const need = Math.min(squad, Math.max(1, Math.ceil(squad * (cfg.reformShare == null ? 0.7 : cfg.reformShare))));
        const waited = Game.time - creep.memory.enteredAt;
        if (inRoom < need && waited < (cfg.reformWait == null ? 60 : cfg.reformWait)) {
            const rally = conquest.holdTile(stagePos(target, staging), creep.name, 0);
            if (!creep.pos.inRangeTo(rally, 0)) movement.go(creep, rally, { range: 0, reusePath: 10 });
            return;
        }
        creep.memory.pushed = true;
    }
    if (creep.memory.lootTiles || creep.memory.salvageLoot) {
        if (creep.memory.salvageLoot && conquest.retreatFor(target)) {
            const back = creep.memory.staging || creep.memory.home || target;
            if (creep.room.name !== back) movement.go(creep, new RoomPosition(25, 25, back), { range: 20, reusePath: 15 });
            return;
        }
        let dir = null;
        for (const x of (Array.isArray(Memory.conquest) ? Memory.conquest : [])) if (x && x.target === target && !x.completed) { dir = x; break; }
        const focus = dir && Array.isArray(dir.focusTiles) && dir.focusTiles.length ? dir.focusTiles : null;
        const tiles = focus || creep.memory.lootTiles || [];
        let rr = tiles.length ? conquest.lootRampartTargets(creep.room, tiles) : [];
        if (rr.length) {
            if (creep.memory.salvageLoot && tiles.length) {
                const order = new Map(tiles.map((p, i) => [p[0] + ',' + p[1], i]));
                rr = rr.slice().sort((a, b) => (order.get(a.pos.x + ',' + a.pos.y) || 99) - (order.get(b.pos.x + ',' + b.pos.y) || 99) || a.hits - b.hits);
            } else {
                rr = [rr.reduce((low, t) => (t.hits < low.hits ? t : low), rr[0])];
            }
            hitTarget(creep, rr[0]);
            return;
        }
        if (focus && creep.memory.salvageLoot) { creep.memory.idleFocus = Game.time; return; }
        if (creep.memory.salvageLoot) {
            let directive = null;
            const raw = Memory.conquest;
            const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            for (const x of list) if (x && x.target === target && !x.completed) { directive = x; break; }
            const structs = conquest.salvageStructures(creep.room, directive || { lootOpen: true, structures: ['storage', 'terminal', 'factory'], skipTypes: ['nuker'] });
            if (structs.length) {
                hitTarget(creep, structs[0]);
                return;
            }
            if (directive && directive.openWall) {
                const here = creep.room.lookForAt(LOOK_STRUCTURES, directive.openWall.x, directive.openWall.y) || [];
                const wall = here.find((s) => s.structureType === STRUCTURE_WALL || s.structureType === 'constructedWall');
                if (wall) {
                    hitTarget(creep, wall);
                    return;
                }
            }
            creep.memory.retired = true; retire.retireAtSpawn(creep); return;
        }
        creep.memory.retired = true; retire.retireAtSpawn(creep); return;
    }
    const towers = hostileStructures(creep.room, STRUCTURE_TOWER);
    let targets = towers.filter((t) => towerEnergy(t) >= TOWER_MIN_FIRE);
    if (!targets.length) targets = hostileStructures(creep.room, STRUCTURE_SPAWN);
    if (!targets.length) targets = towers;
    if (!targets.length) targets = hostileStructures(creep.room, STRUCTURE_EXTENSION);
    if (!targets.length) { creep.memory.retired = true; retire.retireAtSpawn(creep); return; }
    delete creep.memory.idle;
    const tgt = targets.reduce((low, t) => (t.hits < low.hits ? t : low), targets[0]);
    if (creep.dismantle(tgt) === ERR_NOT_IN_RANGE) movement.go(creep, tgt, { range: 1, reusePath: 5 });
}

module.exports = { run, squadMates };
