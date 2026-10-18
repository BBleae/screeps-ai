'use strict';
const config = require('config');
const layout = require('layout');
const wheelLayout = require('wheel_layout');
const { logErr, rampartProtectsCore, isRoomPhaseTick } = require('utils');

function settings() {
    return Object.assign({ interval: 25, minEnergy: 300, logSize: 20, batch: 4, keepStoredBelow: 0 }, config.demolition || {});
}

function constant(name, fallback) {
    return typeof global[name] !== 'undefined' ? global[name] : fallback;
}

function typeKey(structureType) {
    const keys = {
        [constant('STRUCTURE_SPAWN', 'spawn')]: 'spawn', [constant('STRUCTURE_EXTENSION', 'extension')]: 'extension',
        [constant('STRUCTURE_TOWER', 'tower')]: 'tower', [constant('STRUCTURE_STORAGE', 'storage')]: 'storage',
        [constant('STRUCTURE_LINK', 'link')]: 'link', [constant('STRUCTURE_TERMINAL', 'terminal')]: 'terminal',
        [constant('STRUCTURE_LAB', 'lab')]: 'lab', [constant('STRUCTURE_EXTRACTOR', 'extractor')]: 'extractor',
        [constant('STRUCTURE_OBSERVER', 'observer')]: 'observer', [constant('STRUCTURE_POWER_SPAWN', 'powerSpawn')]: 'powerSpawn',
        [constant('STRUCTURE_NUKER', 'nuker')]: 'nuker', [constant('STRUCTURE_FACTORY', 'factory')]: 'factory',
    };
    return keys[structureType] || null;
}

const NEVER_TYPES = new Set(['STRUCTURE_CONTROLLER', 'STRUCTURE_RAMPART', 'STRUCTURE_KEEPER_LAIR', 'STRUCTURE_PORTAL', 'STRUCTURE_POWER_BANK', 'STRUCTURE_INVADER_CORE']
    .map((name) => constant(name, name.slice(10).toLowerCase())));

function posKey(pos) {
    return pos.x + '.' + pos.y;
}

function planIndex(plan) {
    const at = new Map();
    const byType = new Map();
    for (const entry of wheelLayout.plannedEntries(plan)) {
        const key = posKey(entry.pos);
        if (!at.has(key)) at.set(key, []);
        at.get(key).push(entry.type);
        if (!byType.has(entry.type)) byType.set(entry.type, []);
        byType.get(entry.type).push(entry.pos);
    }
    return { at, byType };
}

function plannedHere(index, structureType, pos) {
    const types = index.at.get(posKey(pos)) || [];
    return types.includes(structureType);
}

function blocksPlan(index, structureType, pos) {
    const types = index.at.get(posKey(pos)) || [];
    return types.some((planned) => planned !== structureType && !wheelLayout.canOverlap(structureType, planned));
}

function holdReason(room, mem, cfg) {
    if (room.find(FIND_HOSTILE_CREEPS).length) return 'hostiles';
    if (mem.state && mem.state.recovering) return 'recovering';
    if (room.energyAvailable < cfg.minEnergy) return 'energy';
    return null;
}

function removeOffPlanSites(room, index, log) {
    let removed = 0;
    const rampartType = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
        if (plannedHere(index, site.structureType, site.pos)) continue;
        if (site.structureType === rampartType && rampartProtectsCore(room, site.pos.x, site.pos.y)) continue;
        if (typeof site.remove === 'function' && site.remove() === OK) {
            removed++;
            log({ type: site.structureType, x: site.pos.x, y: site.pos.y, reason: 'site-off-plan' });
        }
    }
    return removed;
}

function cappedReplaceable(room, index, structureType, allow) {
    const key = typeKey(structureType);
    if (!key || !(allow[key] > 0)) return false;
    const structures = room.find(FIND_STRUCTURES).filter((s) => s.structureType === structureType);
    const allSites = room.find(FIND_MY_CONSTRUCTION_SITES);
    const sites = allSites.filter((s) => s.structureType === structureType);
    if (sites.length >= settings().batch) return false;
    if (freeSlots(room) <= 0) return false;
    if (structures.length + sites.length < allow[key]) return false;
    const planned = index.byType.get(structureType) || [];
    const unbuilt = planned.filter((pos) => !layout.structureAt(room, pos.x, pos.y, structureType) &&
        !room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).some((s) => s.structureType === structureType));
    return unbuilt.length > 0;
}

function freeSlots(room) {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    const lowTypes = new Set([constant('STRUCTURE_ROAD', 'road'), constant('STRUCTURE_RAMPART', 'rampart'), constant('STRUCTURE_WALL', 'constructedWall')]);
    const yieldable = sites.filter((s) => lowTypes.has(s.structureType) && !(s.progress > 0)).length;
    return (Number(config.maxSites) || 6) - sites.length + Math.min(2, yieldable);
}

function plannedUnbuiltCount(room, index, structureType) {
    return (index.byType.get(structureType) || []).filter((pos) => !layout.structureAt(room, pos.x, pos.y, structureType) &&
        !room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y).some((s) => s.structureType === structureType)).length;
}

function plannedContainersBuilt(room, index) {
    const plan = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].plan;
    if (!plan || !plan.containers) return false;
    const keys = Object.keys(plan.containers).filter((key) => key !== 'mineral');
    if (!keys.length) return false;
    return keys.every((key) => {
        const pos = plan.containers[key];
        return pos && layout.structureAt(room, pos.x, pos.y, STRUCTURE_CONTAINER);
    });
}

function plannedBuiltCount(room, index, structureType) {
    return (index.byType.get(structureType) || []).filter((pos) => layout.structureAt(room, pos.x, pos.y, structureType)).length;
}

function pickTarget(room, index) {
    const allow = layout.allowance(room);
    const candidates = [];
    for (const structure of room.find(FIND_STRUCTURES)) {
        const type = structure.structureType;
        if (structure.my === false && (type === STRUCTURE_RAMPART || type === STRUCTURE_WALL) &&
            typeof structure.destroy === 'function' && (index.at.get(posKey(structure.pos)) || []).length > 0) {
            candidates.push({ structure, priority: 0, reason: 'hostile-blocking' });
            continue;
        }
        if (NEVER_TYPES.has(type)) continue;
        if (structure.my === false) continue;
        if ((type === STRUCTURE_STORAGE || type === STRUCTURE_TERMINAL) &&
            structure.store && structure.store.getUsedCapacity() > (settings().keepStoredBelow || 0)) continue;
        if (typeof structure.destroy !== 'function') continue;
        if (plannedHere(index, type, structure.pos)) continue;
        if (type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER || type === STRUCTURE_WALL) {
            if (blocksPlan(index, type, structure.pos)) candidates.push({ structure, priority: 0, reason: 'blocking' });
            else if (type === STRUCTURE_CONTAINER && plannedContainersBuilt(room, index)) candidates.push({ structure, priority: 3, reason: 'container-redundant' });
            continue;
        }
        if (type === STRUCTURE_SPAWN) {
            if (plannedBuiltCount(room, index, STRUCTURE_SPAWN) >= 1) candidates.push({ structure, priority: 1, reason: 'spawn-replaced' });
            continue;
        }
        if (type === STRUCTURE_TOWER) {
            if (plannedBuiltCount(room, index, STRUCTURE_TOWER) >= 1) candidates.push({ structure, priority: 1, reason: 'tower-replaced' });
            else if (room.controller.safeModeAvailable > 0 && !room.controller.safeMode && plannedUnbuiltCount(room, index, STRUCTURE_TOWER) > 0 &&
                freeSlots(room) > 0) candidates.push({ structure, priority: 2, reason: 'tower-replace-safemode' });
            continue;
        }
        if (cappedReplaceable(room, index, type, allow)) candidates.push({ structure, priority: 2, reason: 'cap-replace' });
    }
    candidates.sort((a, b) => a.priority - b.priority || a.structure.id.localeCompare(b.structure.id));
    return candidates[0] || null;
}

function hostileQuotaTarget(room) {
    const allow = layout.allowance(room);
    const total = {};
    const mine = {};
    const foreign = [];
    for (const structure of room.find(FIND_STRUCTURES)) {
        const key = typeKey(structure.structureType);
        if (!key) continue;
        total[key] = (total[key] || 0) + 1;
        if (structure.my === false) foreign.push(structure);
        else mine[key] = (mine[key] || 0) + 1;
    }
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
        const key = typeKey(site.structureType);
        if (!key) continue;
        total[key] = (total[key] || 0) + 1;
        mine[key] = (mine[key] || 0) + 1;
    }
    const spawnType = constant('STRUCTURE_SPAWN', 'spawn');
    const keepBelow = settings().keepStoredBelow || 0;
    const blocking = foreign.filter((structure) => {
        const key = typeKey(structure.structureType);
        const cap = allow[key] || 0;
        if (typeof structure.destroy !== 'function' || (total[key] || 0) < cap || (mine[key] || 0) >= cap) return false;
        const stored = structure.store && typeof structure.store.getUsedCapacity === 'function' ? structure.store.getUsedCapacity() : 0;
        const smallStore = key === 'spawn' || key === 'extension' || key === 'tower' || key === 'link';
        return smallStore || stored <= keepBelow;
    });
    blocking.sort((a, b) => (a.structureType === spawnType ? 0 : 1) - (b.structureType === spawnType ? 0 : 1) || a.id.localeCompare(b.id));
    return blocking[0] || null;
}

function run(room) {
    if (!room || !room.controller || !room.controller.my) return;
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!mem) return;
    const cfg = settings();
    if (!isRoomPhaseTick(room.name, cfg.interval)) return;
    const entries = mem.demolition || (mem.demolition = []);
    const log = (entry) => {
        entries.unshift(Object.assign({ t: Game.time }, entry));
        entries.length = Math.min(entries.length, cfg.logSize);
    };
    if (!room.find(FIND_HOSTILE_CREEPS).length) {
        try {
            const foreign = hostileQuotaTarget(room);
            if (foreign && foreign.destroy() === OK) {
                log({ type: foreign.structureType, x: foreign.pos.x, y: foreign.pos.y, reason: 'hostile-quota' });
                console.log('[demolition] ' + room.name + ' 拆除敌方遗留 ' + foreign.structureType + '@' + foreign.pos.x + ',' + foreign.pos.y + '（占满本房配额）');
                return;
            }
        } catch (error) {
            logErr('demolition hostile-quota ' + room.name, error);
        }
    }
    const plan = mem.plan;
    if (!plan || !plan.wheel) return;
    const hold = holdReason(room, mem, cfg);
    if (hold) return;
    let index;
    try {
        index = planIndex(plan);
        removeOffPlanSites(room, index, log);
        const target = pickTarget(room, index);
        if (!target) return;
        const ret = target.structure.destroy();
        if (ret === OK) {
            log({ type: target.structure.structureType, x: target.structure.pos.x, y: target.structure.pos.y, reason: target.reason });
            console.log('[demolition] ' + room.name + ' 拆除 ' + target.structure.structureType + '@' + target.structure.pos.x + ',' + target.structure.pos.y + ' (' + target.reason + ')');
        }
    } catch (error) {
        logErr('demolition ' + room.name, error);
    }
}

function offPlanRampart(room, structure) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    const plan = mem && mem.plan;
    if (!plan || !plan.wheel || !Array.isArray(plan.ramparts)) return false;
    if (rampartProtectsCore(room, structure.pos.x, structure.pos.y)) return false;
    return !plan.ramparts.some((pos) => pos.x === structure.pos.x && pos.y === structure.pos.y);
}

module.exports = { run, settings, planIndex, pickTarget, offPlanRampart };
