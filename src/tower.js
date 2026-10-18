'use strict';
const { findCached, needsRepair, repairTargetHits, compareRepairTargets, armedHostiles, wallFloorHits } = require('utils');
const config = require('config');
const brain = require('brain');

function safeModeSettings() {
    return Object.assign({ decisionTtl: 600, fallbackCoreShare: 0.5, lastResortCoreShare: 0.3 }, config.safeMode || {});
}

function safeModeDecision(room) {
    const decision = brain.get(room.name, 'safeMode', null);
    if (!decision || typeof decision !== 'object' || !decision.action) return null;
    const ttl = Math.max(1, Number(safeModeSettings().decisionTtl) || 600);
    if (decision.atTick != null && Game.time - Number(decision.atTick) > ttl) return null;
    return decision;
}

function coreHurt(room, share) {
    const core = room.find(FIND_MY_STRUCTURES, { filter: (s) =>
        s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_STORAGE });
    return core.some((s) => s.hitsMax && s.hits < s.hitsMax * share);
}

function bodySummary(creep) {
    const counts = {};
    for (const part of creep.body || []) {
        if (part.hits === 0) continue;
        const key = (part.type || part)[0].toUpperCase();
        counts[key] = (counts[key] || 0) + 1;
    }
    return Object.keys(counts).sort().map((key) => counts[key] + key).join('');
}

function noteSafeModeError(room, code, why) {
    const mem = Memory.rooms && (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
    if (!mem) return;
    const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
    log.safeModeError = { at: Game.time, code, by: why };
}

function noteSafeMode(room, hostiles, why) {
    if (typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
    log.safeMode = { at: Game.time, by: why, hostiles: hostiles.slice(0, 6).map((h) => [h.owner && h.owner.username, bodySummary(h), h.hits]) };
    console.log('[tower] ' + room.name + ' safe mode (' + why + '): ' + JSON.stringify(log.safeMode.hostiles));
}

function run(room) {
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const dangerous = hostiles.some((hostile) =>
        hostile.getActiveBodyparts(ATTACK) > 0 ||
        hostile.getActiveBodyparts(RANGED_ATTACK) > 0 ||
        hostile.getActiveBodyparts(HEAL) > 0 ||
        hostile.getActiveBodyparts(WORK) > 0 ||
        hostile.getActiveBodyparts(CLAIM) > 0
    );
    const towers = room.controller.level >= 3
        ? findCached(room, FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER })
        : [];
    if (dangerous && !room.controller.safeMode && room.controller.safeModeAvailable > 0) {
        const decision = safeModeDecision(room);
        const settings = safeModeSettings();
        let why = null;
        if (decision && decision.action === 'activate') why = 'brain:' + (decision.reason || 'activate');
        else if (coreHurt(room, decision ? settings.lastResortCoreShare : settings.fallbackCoreShare)) why = (decision ? 'lastResort' : 'fallback') + ':core-hurt';
        if (why) {
            const ret = room.controller.activateSafeMode();
            if (ret === OK) noteSafeMode(room, hostiles, why);
            else noteSafeModeError(room, ret, why);
        }
    }
    if (!towers.length) return;

    let injured;
    let repairList;
    for (const t of towers) {
        if (t.store[RESOURCE_ENERGY] <= 0) continue;
        if (hostiles.length) {
            const target = hostiles.find((h) => h.owner.username !== 'Source Keeper' && h.owner.username !== 'Invader' && h.getActiveBodyparts('heal') > 0) ||
                hostiles.sort((a, b) => a.hits - b.hits)[0];
            t.attack(target);
            continue;
        }
        const towerReserve = Number(config.towerRepairReserve) || 500;
        const actionCost = typeof TOWER_ENERGY_COST !== 'undefined' ? TOWER_ENERGY_COST : 10;
        if (t.store[RESOURCE_ENERGY] - actionCost < towerReserve) continue;
        if (injured === undefined) injured = creepInjured(room);
        if (injured) { t.heal(injured); continue; }
        if (repairList === undefined) repairList = repairCandidates(room, armedHostiles(room));
        if (!repairList.length) continue;
        const reach = typeof TOWER_FALLOFF_RANGE === 'number' ? TOWER_FALLOFF_RANGE : 20;
        const broken = repairList.find((s) => Math.max(Math.abs(s.pos.x - t.pos.x), Math.abs(s.pos.y - t.pos.y)) <= reach) || repairList[0];
        if (broken) t.repair(broken);
    }
}

const REPAIR_SCAN_TTL = 10;
const repairCache = {};
function repairCandidates(room, armed) {
    let entry = repairCache[room.name];
    if (!entry || Game.time - entry.at >= REPAIR_SCAN_TTL || Game.time < entry.at) {
        const found = room.find(FIND_STRUCTURES, { filter: (s) => needsRepair(room, s) })
            .sort((a, b) => compareRepairTargets(room, a, b));
        entry = repairCache[room.name] = {
            at: Game.time,
            items: found.map((s) => {
                const wall = s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL;
                return { id: s.id, wall, goal: s.structureType === STRUCTURE_RAMPART ? repairTargetHits(room, s) : s.hitsMax * config.towerRepairBelow };
            }),
        };
    }
    const floor = wallFloorHits();
    const out = [];
    for (const item of entry.items) {
        const s = Game.getObjectById(item.id);
        if (!s) continue;
        const goal = item.wall && !armed && floor > 0 ? Math.min(item.goal, floor) : item.goal;
        if (s.hits < goal) out.push(s);
    }
    return out;
}

function towerDamageAt(tower, target) {
    const range = Math.max(Math.abs(tower.pos.x - target.pos.x), Math.abs(tower.pos.y - target.pos.y));
    if (range <= 5) return 600;
    if (range >= 20) return 150;
    return Math.floor(600 * (1 - 0.75 * (range - 5) / 15));
}

function towersCanHold(room, towers, hostiles) {
    const armed = towers.filter((t) => t.store[RESOURCE_ENERGY] >= 10);
    if (!armed.length) return false;
    const core = room.find(FIND_MY_STRUCTURES, { filter: (s) =>
        s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_STORAGE });
    if (core.some((s) => s.hitsMax && s.hits < s.hitsMax * 0.5)) return false;
    let heal = 0;
    for (const hostile of hostiles) heal += hostile.getActiveBodyparts(HEAL) * 12;
    if (!heal) return true;
    const focus = hostiles.slice().sort((a, b) => b.getActiveBodyparts(HEAL) - a.getActiveBodyparts(HEAL))[0];
    let damage = 0;
    for (const tower of armed) damage += towerDamageAt(tower, focus);
    return heal < damage * 0.9;
}

function creepInjured(room) {
    return room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax }).sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0] || null;
}

function resetCache() { for (const k of Object.keys(repairCache)) delete repairCache[k]; }

module.exports = { run, resetCache, towersCanHold, towerDamageAt, safeModeDecision, coreHurt };
