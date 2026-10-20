'use strict';
const movement = require('movement');
const retire = require('retire');
const conquest = require('conquest');
const boost = require('boost');

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
    const set = new Set([target]);
    const extra = creep.memory.avoid;
    if (Array.isArray(extra)) for (const r of extra) set.add(r);
    return set;
}

function run(creep) {
    const target = creep.memory.targetRoom;
    if (!target) return;
    conquest.recordHostileTowers(creep.room, creep);
    if (creep.memory.retired) { retire.retireAtSpawn(creep); return; }
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
        if (squad <= 1 || creep.memory.launched) {
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
        const tiles = creep.memory.lootTiles || [];
        let rr = tiles.length ? conquest.lootRampartTargets(creep.room, tiles) : [];
        if (rr.length) {
            if (creep.memory.salvageLoot && tiles.length) {
                const order = new Map(tiles.map((p, i) => [p[0] + ',' + p[1], i]));
                rr = rr.slice().sort((a, b) => (order.get(a.pos.x + ',' + a.pos.y) || 99) - (order.get(b.pos.x + ',' + b.pos.y) || 99) || a.hits - b.hits);
            } else {
                rr = [rr.reduce((low, t) => (t.hits < low.hits ? t : low), rr[0])];
            }
            const lt = rr[0];
            if (creep.dismantle(lt) === ERR_NOT_IN_RANGE) movement.go(creep, lt, { range: 1, reusePath: 5 });
            return;
        }
        if (creep.memory.salvageLoot) {
            const d = (Memory.conquest || []).find ? null : null;
            let directive = null;
            const raw = Memory.conquest;
            const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
            for (const x of list) if (x && x.target === target && !x.completed) { directive = x; break; }
            const structs = conquest.salvageStructures(creep.room, directive || { lootOpen: true, structures: ['storage', 'terminal', 'factory'], skipTypes: ['nuker'] });
            if (structs.length) {
                const pick = structs[0];
                if (creep.dismantle(pick) === ERR_NOT_IN_RANGE) movement.go(creep, pick, { range: 1, reusePath: 5 });
                return;
            }
            if (directive && directive.openWall) {
                const here = creep.room.lookForAt(LOOK_STRUCTURES, directive.openWall.x, directive.openWall.y) || [];
                const wall = here.find((s) => s.structureType === STRUCTURE_WALL || s.structureType === 'constructedWall');
                if (wall) {
                    if (creep.dismantle(wall) === ERR_NOT_IN_RANGE) movement.go(creep, wall, { range: 1, reusePath: 5 });
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
