'use strict';
const config = require('config');
const utils = require('utils');
const { creepsHome, creepsHomeRole } = utils;
const wheelLayout = require('wheel_layout');
const brain = require('brain');
const { planPath, unpackPath, isWall, occupied, bestAdjacent, logErr } = utils;

function addTaken(taken, spot) {
    if (spot && spot.x != null && spot.y != null) taken.add(spot.x + '.' + spot.y);
}

function sameIds(left, right) {
    if (!Array.isArray(left) || left.length !== right.length) return false;
    for (let i = 0; i < right.length; i++) if (left[i] !== right[i]) return false;
    return true;
}

function sourceAnchor(room, plan) {
    if (plan && plan.anchor) return plan.anchor;
    const spawn = room.find(FIND_MY_SPAWNS).slice()
        .sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y || String(a.id).localeCompare(String(b.id)))[0];
    return spawn ? spawn.pos : { x: 25, y: 25 };
}

function sourcesByAnchor(room, anchor) {
    return room.find(FIND_SOURCES).slice().sort((a, b) => {
        const aDistance = (a.pos.x - anchor.x) ** 2 + (a.pos.y - anchor.y) ** 2;
        const bDistance = (b.pos.x - anchor.x) ** 2 + (b.pos.y - anchor.y) ** 2;
        return aDistance - bDistance || String(a.id).localeCompare(String(b.id)) || a.pos.x - b.pos.x || a.pos.y - b.pos.y;
    });
}

function remapHarvesterSources(room, previousIds, nextIds) {
    if (!nextIds.length) return;
    const memories = [];
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        memories.push(creep.memory);
        seen.add(creep.name);
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || seen.has(spawn.spawning.name) || !Memory.creeps) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory && memory.home === room.name && memory.role === 'harvester') memories.push(memory);
    }
    const records = memories.map((memory) => {
        let nextIdx = -1;
        if (memory.sourceId) nextIdx = nextIds.indexOf(memory.sourceId);
        if (nextIdx < 0 && memory.sourceId && previousIds && previousIds.length) {
            const previousIdx = previousIds.indexOf(memory.sourceId);
            if (previousIdx >= 0) nextIdx = nextIds.indexOf(previousIds[previousIdx]);
        }
        if (nextIdx < 0 && Number.isInteger(memory.sourceIdx)) {
            const previousId = previousIds && previousIds[memory.sourceIdx];
            nextIdx = previousId ? nextIds.indexOf(previousId) : memory.sourceIdx;
            if (nextIdx >= nextIds.length) nextIdx = -1;
        }
        return { memory, nextIdx };
    });
    const coverage = Array(nextIds.length).fill(0);
    for (const record of records) if (record.nextIdx >= 0) coverage[record.nextIdx]++;
    const leastCovered = () => {
        let best = 0;
        for (let index = 1; index < coverage.length; index++) {
            if (coverage[index] < coverage[best]) best = index;
        }
        coverage[best]++;
        return best;
    };
    for (const record of records) {
        const memory = record.memory;
        const nextIdx = record.nextIdx >= 0 ? record.nextIdx : leastCovered();
        const sourceId = nextIds[nextIdx];
        if (memory.sourceId !== sourceId) memory.sourceId = sourceId;
        if (memory.sourceIdx !== nextIdx) memory.sourceIdx = nextIdx;
    }
}

function harvesterIdentityNeedsRemap(memory, nextIds) {
    if (!memory || memory.role !== 'harvester') return false;
    const sourceId = memory.sourceId;
    const sourceIdx = Number.isInteger(memory.sourceIdx) ? memory.sourceIdx : -1;
    return !sourceId || nextIds.indexOf(sourceId) < 0 || sourceIdx < 0 || nextIds[sourceIdx] !== sourceId;
}

function needsHarvesterRemap(room, nextIds) {
    if (!nextIds.length) return false;
    for (const creep of creepsHome(room.name)) {
        if (harvesterIdentityNeedsRemap(creep.memory, nextIds)) return true;
    }
    const seen = new Set(Object.keys(Game.creeps || {}));
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || seen.has(spawn.spawning.name) || !Memory.creeps) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory && memory.home === room.name && harvesterIdentityNeedsRemap(memory, nextIds)) return true;
    }
    return false;
}

const sourceOrderCache = { tick: -1, rooms: {} };
const sourceOrderCounters = { calls: 0, hits: 0 };

function resolveSources(room, mem, plan) {
    mem = mem || (Memory.rooms && Memory.rooms[room.name]) || {};
    plan = plan || mem.plan || null;
    sourceOrderCounters.calls++;
    const cacheable = !plan || plan === mem.plan;
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    if (sourceOrderCache.tick !== now) { sourceOrderCache.tick = now; sourceOrderCache.rooms = {}; }
    const cached = cacheable ? sourceOrderCache.rooms[room.name] : null;
    if (cached && cached.room === room && cached.mem === mem && cached.plan === plan) {
        sourceOrderCounters.hits++;
        return cached.ordered;
    }
    const fallback = sourcesByAnchor(room, sourceAnchor(room, plan));
    const visible = {};
    for (const source of fallback) visible[source.id] = source;

    const memoryIds = Array.isArray(mem.sources) ? mem.sources : [];
    const planIds = plan && Array.isArray(plan.sourceIds) ? plan.sourceIds : [];
    const preferred = planIds.length ? [planIds, memoryIds] : [memoryIds];
    const ordered = [];
    const seen = new Set();
    const addIds = (ids) => {
        for (const id of ids) {
            if (seen.has(id) || !visible[id]) continue;
            seen.add(id);
            ordered.push(visible[id]);
        }
    };
    for (const ids of preferred) addIds(ids);
    for (const source of fallback) {
        if (seen.has(source.id)) continue;
        seen.add(source.id);
        ordered.push(source);
    }

    if (ordered.length) {
        const ids = ordered.map((source) => source.id);
        const sourceOrderChanged = !sameIds(mem.sources, ids);
        if (sourceOrderChanged || needsHarvesterRemap(room, ids)) {
            remapHarvesterSources(room, memoryIds.length ? memoryIds : ids, ids);
            mem.sources = ids.slice();
        }
        if (plan && !sameIds(plan.sourceIds, ids)) plan.sourceIds = ids.slice();
    }
    if (cacheable) sourceOrderCache.rooms[room.name] = { room, mem, plan, ordered };
    return ordered;
}

function sourceOrderStats() {
    return { calls: sourceOrderCounters.calls, hits: sourceOrderCounters.hits };
}

function collectPlannedTaken(plan, includeContainers = true) {
    const taken = new Set();
    if (includeContainers) Object.values(plan.containers || {}).forEach((spot) => addTaken(taken, spot));
    ['storage', 'terminal'].forEach((key) => addTaken(taken, plan[key]));
    ['towers', 'spawn2', 'spawn3', 'labs', 'misc', 'ext'].forEach((key) => {
        for (const spot of plan[key] || []) addTaken(taken, spot);
    });
    for (const spot of plan.spawns || []) addTaken(taken, spot);
    Object.values(plan.structures || {}).forEach((spot) => addTaken(taken, spot));
    Object.values(plan.links || {}).forEach((spot) => addTaken(taken, spot));
    return taken;
}

function linkSpot(plan, key) {
    if (!plan || !plan.links) return null;
    if (key === 'src0') return plan.links.src0 || plan.links.src || null;
    return plan.links[key] || null;
}

function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

const stationCache = { time: -1, rooms: {} };

function upgraderStorageStations(room, plan) {
    const storage = room && room.storage;
    const controller = room && room.controller;
    if (!storage || storage.my === false || !storage.pos || !controller || !controller.pos) return [];
    if (stationCache.time !== Game.time) { stationCache.time = Game.time; stationCache.rooms = {}; }
    const cacheKey = room.name + '|' + (storage.id || '');
    if (stationCache.rooms[cacheKey]) return stationCache.rooms[cacheKey];
    plan = plan || {};
    const blocked = new Set();
    const mark = (spot) => { if (spot && spot.x != null && spot.y != null) blocked.add(spot.x + '.' + spot.y); };
    for (const key of ['ext', 'spawns', 'spawn2', 'spawn3', 'towers', 'labs', 'misc', 'structures']) {
        const list = Array.isArray(plan[key]) ? plan[key] : (plan[key] ? [plan[key]] : []);
        for (const spot of list) mark(spot);
    }
    mark(plan.storage);
    mark(plan.terminal);
    for (const spot of Object.values(plan.links || {})) mark(spot);
    for (const spot of Object.values(plan.containers || {})) mark(spot);
    const roads = new Set();
    for (const packed of Object.values(plan.roads || {})) {
        if (typeof packed === 'string' && packed) for (const p of unpackPath(packed)) roads.add(p.x + '.' + p.y);
    }
    const linkSpots = Object.values(plan.links || {}).filter((spot) => spot && spot.x != null);
    const builtLinkSpots = linkSpots.filter((spot) => {
        const link = structureAt(room, spot.x, spot.y, STRUCTURE_LINK);
        return link && link.my !== false;
    });
    const walkable = new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_CONTAINER]);
    const spots = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = storage.pos.x + dx;
        const y = storage.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        const ctrlDist = chebyshev({ x, y }, controller.pos);
        if (ctrlDist > 3) continue;
        if (isWall(room, x, y)) continue;
        const key = x + '.' + y;
        if (blocked.has(key)) continue;
        const here = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
        if (here.some((s) => !walkable.has(s.structureType))) continue;
        const road = roads.has(key) || here.some((s) => s.structureType === STRUCTURE_ROAD);
        const nearLinks = linkSpots.filter((spot) => chebyshev(spot, { x, y }) <= 1).length;
        const builtLinks = builtLinkSpots.filter((spot) => chebyshev(spot, { x, y }) <= 1).length;
        spots.push({ x, y, road, nearLinks, builtLinks, ctrlDist });
    }
    spots.sort((a, b) => (b.builtLinks - a.builtLinks) || (a.road - b.road) || (b.nearLinks - a.nearLinks) || (a.ctrlDist - b.ctrlDist) || (a.y - b.y) || (a.x - b.x));
    stationCache.rooms[cacheKey] = spots;
    return spots;
}

function controllerFedByStorage(room, plan) {
    return upgraderStorageStations(room, plan).length > 0;
}

function upgraderStation(room, plan) {
    plan = plan || {};
    const storageSpots = upgraderStorageStations(room, plan);
    if (storageSpots.length) {
        return { pos: { x: storageSpots[0].x, y: storageSpots[0].y }, container: null, anchor: room.storage, spots: storageSpots, storageFed: true };
    }
    const c = plan.containers && plan.containers.ctrl;
    const spot = c || (plan.workPositions && plan.workPositions.ctrl);
    if (!spot) return null;
    const container = c ? structureAt(room, c.x, c.y, STRUCTURE_CONTAINER) : null;
    const linkPos = linkSpot(plan, 'ctrl');
    const link = linkPos ? structureAt(room, linkPos.x, linkPos.y, STRUCTURE_LINK) : null;
    return { pos: { x: spot.x, y: spot.y }, container, anchor: (link && link.my) ? link : container || null, spots: null, storageFed: false };
}

function atUpgraderStation(pos, station, controller) {
    const anchor = station.anchor ? station.anchor.pos : station.pos;
    return chebyshev(pos, anchor) <= 1 && chebyshev(pos, controller.pos) <= 3;
}

function compatibleSourceLink(room, source, container, anchor, taken, current) {
    if (!source) return current || null;
    const fixed = current && (structureAt(room, current.x, current.y, STRUCTURE_LINK) ||
        siteAt(room, current.x, current.y, STRUCTURE_LINK));
    if (current && (!container || chebyshev(current, container) <= 1 || fixed)) return current;
    if (current) taken.delete(current.x + '.' + current.y);
    const candidates = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = source.pos.x + dx;
        const y = source.pos.y + dy;
        const key = x + '.' + y;
        if (x < 1 || x > 48 || y < 1 || y > 48 || isWall(room, x, y)) continue;
        if (container && chebyshev({ x, y }, container) > 1) continue;
        if (taken.has(key) || occupied(room, x, y)) continue;
        candidates.push({ x, y, d: (x - anchor.x) ** 2 + (y - anchor.y) ** 2 });
    }
    candidates.sort((a, b) => a.d - b.d);
    return candidates.length ? { x: candidates[0].x, y: candidates[0].y } : current || null;
}

function adjacentContainer(room, target, anchor, taken) {
    if (!target) return null;
    const candidates = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = target.x + dx;
        const y = target.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        const key = x + '.' + y;
        if (taken && taken.has(key)) continue;
        if (!structureAt(room, x, y, STRUCTURE_CONTAINER) && !siteAt(room, x, y, STRUCTURE_CONTAINER)) continue;
        candidates.push({ x, y, d: anchor ? (x - anchor.x) ** 2 + (y - anchor.y) ** 2 : 0 });
    }
    candidates.sort((left, right) => left.d - right.d || left.y - right.y || left.x - right.x);
    return candidates.length ? { x: candidates[0].x, y: candidates[0].y } : null;
}

function existingContainer(room, target, preferred, anchor, taken) {
    if (!target || typeof room.find !== 'function') return null;
    const preferredKey = preferred && preferred.x != null && preferred.y != null ?
        preferred.x + '.' + preferred.y : null;
    const candidates = room.find(FIND_STRUCTURES).filter((structure) => {
        if (structure.structureType !== STRUCTURE_CONTAINER) return false;
        if (structure.my === false || !structure.pos) return false;
        if (structure.pos.x < 1 || structure.pos.x > 48 || structure.pos.y < 1 || structure.pos.y > 48) return false;
        if (chebyshev(structure.pos, target) > 1) return false;
        const key = structure.pos.x + '.' + structure.pos.y;
        return !taken || !taken.has(key);
    });
    candidates.sort((left, right) => {
        const leftKey = left.pos.x + '.' + left.pos.y;
        const rightKey = right.pos.x + '.' + right.pos.y;
        const leftPreferred = leftKey === preferredKey ? 0 : 1;
        const rightPreferred = rightKey === preferredKey ? 0 : 1;
        if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
        const leftTarget = chebyshev(left.pos, target);
        const rightTarget = chebyshev(right.pos, target);
        if (leftTarget !== rightTarget) return leftTarget - rightTarget;
        const leftAnchor = anchor ? Math.abs(left.pos.x - anchor.x) + Math.abs(left.pos.y - anchor.y) : 0;
        const rightAnchor = anchor ? Math.abs(right.pos.x - anchor.x) + Math.abs(right.pos.y - anchor.y) : 0;
        return leftAnchor - rightAnchor || left.pos.y - right.pos.y || left.pos.x - right.pos.x;
    });
    return candidates.length ? { x: candidates[0].pos.x, y: candidates[0].pos.y } : null;
}

function duplicateContainerSite(room, target, previous, adopted) {
    if (!target || typeof room.find !== 'function') return null;
    const preferredKey = previous && previous.x != null && previous.y != null ?
        previous.x + '.' + previous.y : null;
    const adoptedKey = adopted && adopted.x != null && adopted.y != null ?
        adopted.x + '.' + adopted.y : null;
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES).filter((site) => {
        if (site.structureType !== STRUCTURE_CONTAINER || !site.pos) return false;
        if (chebyshev(site.pos, target) > 1) return false;
        const key = site.pos.x + '.' + site.pos.y;
        return key !== adoptedKey;
    });
    sites.sort((left, right) => {
        const leftKey = left.pos.x + '.' + left.pos.y;
        const rightKey = right.pos.x + '.' + right.pos.y;
        const leftTotal = Math.max(0, Number(left.progressTotal) || 0);
        const rightTotal = Math.max(0, Number(right.progressTotal) || 0);
        const leftRatio = leftTotal ? (Math.max(0, Number(left.progress) || 0) / leftTotal) : 0;
        const rightRatio = rightTotal ? (Math.max(0, Number(right.progress) || 0) / rightTotal) : 0;
        const leftPreferred = leftKey === preferredKey ? 0 : 1;
        const rightPreferred = rightKey === preferredKey ? 0 : 1;
        return rightRatio - leftRatio || (Number(right.progress) || 0) - (Number(left.progress) || 0) ||
            leftPreferred - rightPreferred;
    });
    return sites.length ? sites[0] : null;
}

function canAdoptExistingContainer(site) {
    if (!site) return true;
    const progress = Math.max(0, Number(site.progress) || 0);
    const total = Math.max(0, Number(site.progressTotal) || 0);
    if (!total) return true;
    return progress <= total - progress;
}

function removeDuplicateContainerSite(site) {
    return utils.removeSite(site, 'dupContainer');
}

function compatibleWorkSpot(spot, target, container) {
    if (!spot || spot.x == null || spot.y == null || !target || target.x == null || target.y == null ||
        chebyshev(spot, target) > 1) return false;
    return !container || chebyshev(spot, container) <= 1;
}

function validContainerSpot(room, target, spot, taken) {
    if (!target || !spot || spot.x == null || spot.y == null || chebyshev(target, spot) > 1) return false;
    if (spot.x < 1 || spot.x > 48 || spot.y < 1 || spot.y > 48 || isWall(room, spot.x, spot.y)) return false;
    if (taken && taken.has(spot.x + '.' + spot.y)) return false;
    if (structureAt(room, spot.x, spot.y, STRUCTURE_CONTAINER) ||
        siteAt(room, spot.x, spot.y, STRUCTURE_CONTAINER)) return true;
    return !occupied(room, spot.x, spot.y);
}

function normalizeContainers(room, plan, sources, anchor) {
    const previous = plan.containers || {};
    if (!plan.workPositions || typeof plan.workPositions !== 'object' || Array.isArray(plan.workPositions)) {
        plan.workPositions = {};
    }
    const workPositions = plan.workPositions;
    const taken = collectPlannedTaken(plan);
    const otherTaken = collectPlannedTaken(plan, false);
    for (const spot of Object.values(previous)) {
        if (spot && !otherTaken.has(spot.x + '.' + spot.y)) taken.delete(spot.x + '.' + spot.y);
    }

    const targets = [];
    for (let index = 0; index < sources.length; index++) {
        targets.push(['src' + index, sources[index] && sources[index].pos]);
    }
    targets.push(['ctrl', room.controller && room.controller.pos]);

    const normalized = Object.assign({}, previous);
    for (const [key, target] of targets) {
        if (!target) continue;
        let spot = previous[key];
        const built = existingContainer(room, target, spot, anchor, taken);
        const duplicate = duplicateContainerSite(room, target, spot, built);
        if (built && duplicate) {
            if (canAdoptExistingContainer(duplicate)) {
                removeDuplicateContainerSite(duplicate);
                spot = built;
            } else {
                spot = { x: duplicate.pos.x, y: duplicate.pos.y };
            }
        } else if (built) {
            spot = built;
        } else if (!validContainerSpot(room, target, spot, taken)) {
            spot = adjacentContainer(room, target, anchor, taken) || bestAdjacent(target, room, anchor, taken);
        }
        if (spot) {
            normalized[key] = spot;
            if (!compatibleWorkSpot(workPositions[key], target, spot)) {
                workPositions[key] = { x: spot.x, y: spot.y };
            }
            addTaken(taken, spot);
        } else {
            delete normalized[key];
            delete workPositions[key];
        }
    }
    plan.containers = normalized;
    return taken;
}

function normalizeLinkPlan(room, plan) {
    if (!plan) return null;
    if (plan.wheel) {
        plan.links = plan.links || {};
        if (!plan.links.src0 && plan.links.src) plan.links.src0 = plan.links.src;
        if (plan.links.src0 && !plan.links.src) plan.links.src = plan.links.src0;
        return plan.links;
    }
    const spawn0 = room.find(FIND_MY_SPAWNS)[0];
    const anchor = plan.anchor || (spawn0 && spawn0.pos) || { x: 25, y: 25 };
    const sources = resolveSources(room, roomMem(room), plan);
    plan.links = plan.links || {};
    if (!plan.links.src0 && plan.links.src) plan.links.src0 = plan.links.src;
    const taken = normalizeContainers(room, plan, sources, anchor);
    const ensure = (key, targetPos) => {
        if (!targetPos) return;
        if (plan.links[key]) {
            addTaken(taken, plan.links[key]);
            return;
        }
        const spot = bestAdjacent(targetPos, room, anchor, taken);
        if (!spot) return;
        plan.links[key] = spot;
        addTaken(taken, spot);
    };
    const ctrlStation = (plan.containers && plan.containers.ctrl) || (plan.workPositions && plan.workPositions.ctrl) ||
        (room.controller && room.controller.pos);
    ensure('ctrl', ctrlStation);
    if (sources[0]) {
        const sourceSpot = plan.workPositions && plan.workPositions.src0 || plan.containers && plan.containers.src0;
        plan.links.src0 = compatibleSourceLink(room, sources[0], sourceSpot,
            anchor, taken, plan.links.src0);
        addTaken(taken, plan.links.src0);
        plan.links.src = plan.links.src0;
    }
    if (sources[1]) {
        const sourceSpot = plan.workPositions && plan.workPositions.src1 || plan.containers && plan.containers.src1;
        plan.links.src1 = compatibleSourceLink(room, sources[1], sourceSpot,
            anchor, taken, plan.links.src1);
        addTaken(taken, plan.links.src1);
    }
    ensure('store', room.storage ? room.storage.pos : plan.storage);
    return plan.links;
}

function roomMem(room) {
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    return Memory.rooms[room.name];
}
function structureAt(room, x, y, type) {
    return room.lookForAt(LOOK_STRUCTURES, x, y).find((s) => s.structureType === type) || null;
}
function siteAt(room, x, y, type) {
    return room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).find((s) => s.structureType === type) || null;
}
function countType(room, type) {
    return room.find(FIND_STRUCTURES).filter((s) => s.structureType === type).length +
        room.find(FIND_MY_CONSTRUCTION_SITES).filter((s) => s.structureType === type).length;
}
function allowance(room) {
    const L = room.controller.level;
    const seq = (arr) => arr[Math.min(L, arr.length - 1)];
    return {
        spawn: seq([0, 1, 1, 1, 1, 1, 1, 2, 3]),
        extension: seq([0, 0, 5, 10, 20, 30, 40, 50, 60]),
        tower: seq([0, 0, 0, 1, 1, 2, 2, 3, 6]),
        storage: L >= 4 ? 1 : 0,
        link: seq([0, 0, 0, 0, 0, 2, 3, 4, 6]),
        terminal: L >= 6 ? 1 : 0,
        lab: seq([0, 0, 0, 0, 0, 0, 3, 6, 10]),
        extractor: L >= 6 ? 1 : 0,
        observer: L >= 8 ? 1 : 0,
        powerSpawn: (L >= 8 && !(config.construction || {}).deferPowerSpawn) ? 1 : 0,
        nuker: (L >= 8 && !(config.construction || {}).deferNuker) ? 1 : 0,
        factory: L >= 7 ? 1 : 0,
        container: 5,
        road: 2500,
        rampart: L >= 2 ? 2500 : 0,
    };
}

function placeRoads(room, plan, budget) {
    let placed = 0;
    const seen = new Set();
    const anchor = plan.anchor || { x: 25, y: 25 };
    const tiles = [];
    for (const str of Object.values(plan.roads || {})) {
        if (!str) continue;
        for (const p of unpackPath(str)) {
            const posKey = p.x + '.' + p.y;
            if (seen.has(posKey)) continue;
            seen.add(posKey);
            tiles.push(p);
        }
    }
    tiles.sort((a, b) => chebyshev(a, anchor) - chebyshev(b, anchor));
    for (const p of tiles) {
        if (structureAt(room, p.x, p.y, STRUCTURE_ROAD) || siteAt(room, p.x, p.y, STRUCTURE_ROAD)) continue;
        if (trySite(room, p, STRUCTURE_ROAD)) placed++;
        if (placed >= budget) return placed;
    }
    return placed;
}

function structuresCanShare(existingType, plannedType) {
    if (existingType === plannedType) return false;
    if (plannedType === STRUCTURE_RAMPART) return existingType !== STRUCTURE_WALL;
    if (existingType === STRUCTURE_RAMPART) return plannedType !== STRUCTURE_WALL;
    return (existingType === STRUCTURE_ROAD && plannedType === STRUCTURE_CONTAINER) ||
        (existingType === STRUCTURE_CONTAINER && plannedType === STRUCTURE_ROAD);
}

let blockedThisRun = null;
const REPORT_BLOCKED_TYPES = new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL, STRUCTURE_CONTAINER]);

function handleBlocked(room, spot, type, blockers) {
    if (REPORT_BLOCKED_TYPES.has(type)) return;
    const by = blockers.map((structure) => structure.structureType);
    if (blockedThisRun) blockedThisRun.push({ x: spot.x, y: spot.y, type, by: by.length === 1 ? by[0] : by.join('/') });
}

function trySite(room, spot, type) {
    if (!spot) return false;
    if (type !== STRUCTURE_EXTRACTOR && isWall(room, spot.x, spot.y)) return false;
    const structures = room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y);
    if (structures.some((structure) => structure.structureType === type)) return false;
    const blockers = structures.filter((structure) => !structuresCanShare(structure.structureType, type));
    if (blockers.length) {
        handleBlocked(room, spot, type, blockers);
        return false;
    }
    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, spot.x, spot.y).length > 0) return false;
    return room.createConstructionSite(spot.x, spot.y, type) === OK;
}

function pending(room, type) {
    return room.find(FIND_MY_CONSTRUCTION_SITES).filter((s) => s.structureType === type).length;
}

function sitePace() {
    return Object.assign({ roads: 8, ramparts: 6, walls: 2, containers: 2 }, config.sitePace || {});
}

function trimSites(room, plan) {
    const planned = {};
    const containerSpots = Object.assign({}, plan.containers || {});
    if (room.controller.level < 6) delete containerSpots.mineral;
    planned[STRUCTURE_CONTAINER] = new Set(Object.values(containerSpots).filter(Boolean).map((p) => p.x + '.' + p.y));
    const roadSet = new Set();
    for (const key of Object.keys(plan.roads || {})) {
        const str = plan.roads && plan.roads[key];
        if (str) for (const p of unpackPath(str)) roadSet.add(p.x + '.' + p.y);
    }
    planned[STRUCTURE_ROAD] = roadSet;
    for (const type of [STRUCTURE_CONTAINER, STRUCTURE_ROAD]) {
        const sites = room.find(FIND_MY_CONSTRUCTION_SITES).filter((s) => s.structureType === type)
            .sort((a, b) => b.progress - a.progress);
        let keep = 0;
        const keepMax = type === STRUCTURE_ROAD ? Infinity : sitePace().containers;
        for (const s of sites) {
            const key = s.pos.x + '.' + s.pos.y;
            const progress = Math.max(0, Number(s.progress) || 0);
            const total = Math.max(0, Number(s.progressTotal) || 0);
            const highProgress = total > 0 && progress > total - progress;
            if (planned[type].has(key) && highProgress) continue;
            if (keep < keepMax && planned[type].has(key)) { keep++; continue; }
            utils.removeSite(s, 'trim' + type);
        }
    }
    if (!ringKeep(room, plan)) {
        const core = new Set(coreRampartSpots(room).map((p) => p.x + '.' + p.y));
        let trimmed = 0;
        for (const s of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
            if (s.structureType !== STRUCTURE_RAMPART || (Number(s.progress) || 0) > 0) continue;
            if (core.has(s.pos.x + '.' + s.pos.y)) continue;
            if (utils.removeSite(s, 'ringTrim')) trimmed++;
        }
        if (trimmed) roomMem(room).ringTrimAt = Game.time;
    }
    if (room.controller.level < Math.max(1, Number(config.roadsMinRcl) || 1)) {
        let trimmed = 0;
        for (const s of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
            if (s.structureType !== STRUCTURE_ROAD || (Number(s.progress) || 0) > 0) continue;
            if (utils.removeSite(s, 'roadsMinRcl')) trimmed++;
        }
        if (trimmed) {
            const mem = roomMem(room);
            mem.roadsTrimmed = (Number(mem.roadsTrimmed) || 0) + trimmed;
            mem.roadsTrimmedAt = Game.time;
        }
    }
}

function globalSiteBudget() {
    const limit = typeof MAX_CONSTRUCTION_SITES === 'number' ? MAX_CONSTRUCTION_SITES : 100;
    const reserve = Math.max(0, Number(config.globalSiteReserve) || 0);
    const count = Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
    return Math.max(0, limit - reserve - count);
}

function globalSiteHeadroom() {
    const limit = typeof MAX_CONSTRUCTION_SITES === 'number' ? MAX_CONSTRUCTION_SITES : 100;
    const reserve = Math.max(0, Number(config.remoteContainerSiteReserve) || 0);
    const count = Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
    return Math.max(0, limit - reserve - count);
}

function rampartsAllowed(room) {
    const minEnergy = Math.max(0, Number(config.rampartTowerEnergy) || 0);
    const towers = room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
    return towers.some((t) => t.store && Number(t.store[RESOURCE_ENERGY] || 0) >= minEnergy);
}

function rampartRingAffordable(room, mem, share) {
    const need = Math.max(0, Number(config.rampartRingMinIncome) || 0) * (share == null ? 1 : share);
    if (!(need > 0)) return true;
    const track = mem && mem.spawnIncome;
    const samples = Math.max(1, Number((config.spawnQueue || {}).incomeSamples) || 200);
    return !!track && Number(track.n) >= samples && Number(track.ema || 0) >= need;
}

function ringPlanned(room, plan) {
    const minRcl = Math.max(1, Number(config.rampartRingMinRcl) || 1);
    return !!(plan && Array.isArray(plan.ramparts) && plan.ramparts.length && room.controller.level >= minRcl);
}

function ringAllowed(room, plan) {
    if (!ringPlanned(room, plan)) return false;
    const mem = roomMem(room);
    const retry = Math.max(0, Number(config.rampartRingRetryTicks) || 0);
    if (mem.ringTrimAt != null && Game.time - Number(mem.ringTrimAt) < retry) return false;
    return rampartRingAffordable(room, mem);
}

function ringKeep(room, plan) {
    if (!ringPlanned(room, plan)) return false;
    return rampartRingAffordable(room, roomMem(room), Number(config.rampartRingKeepShare) || 1);
}

function coreRampartSpots(room) {
    return room.find(FIND_MY_SPAWNS).map((s) => s.pos)
        .concat(room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL }).map((s) => s.pos));
}

function hasBuilder(room) {
    for (const creep of creepsHome(room.name)) {
        const memory = creep.memory;
        if (memory.role !== 'builder' && memory.role !== 'pioneer') continue;
        if (memory.retired || memory.bodyUpgradeRetiring) continue;
        return true;
    }
    return false;
}

function deadRoom(room, mem) {
    const settings = config.deadRoom || {};
    const after = Math.max(0, Number(settings.afterTicks) || 0);
    if (!after) return false;
    const wanted = room.find(FIND_MY_CONSTRUCTION_SITES).filter((site) => utils.siteWanted(room, site));
    if (hasBuilder(room) || mem.builderSeenAt == null || wanted.length === 0) mem.builderSeenAt = Game.time;
    return Game.time - mem.builderSeenAt >= after;
}

function trimDeadRoomSites(room) {
    const keep = Math.max(0, Number((config.deadRoom || {}).keep) || 0);
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES).filter((s) => s.structureType !== STRUCTURE_SPAWN &&
        s.structureType !== STRUCTURE_CONTAINER)
        .sort((a, b) => (Number(b.progress) || 0) - (Number(a.progress) || 0));
    let removed = 0;
    for (const site of sites.slice(keep)) {
        if (utils.removeSite(site, 'deadRoom')) removed++;
    }
    return removed;
}

function placeCoreContainerSites(room, mem) {
    const plan = mem && mem.plan;
    if (!plan || !plan.containers) return 0;
    let placed = 0;
    for (const key of ['src0', 'src1', 'ctrl']) {
        if (plan.containers[key] && trySite(room, plan.containers[key], STRUCTURE_CONTAINER)) placed++;
    }
    return placed;
}

function placeFirstSpawn(room, plan) {
    if (!plan || !Array.isArray(plan.spawns) || !plan.spawns.length) return false;
    if (room.find(FIND_MY_SPAWNS).length || pending(room, STRUCTURE_SPAWN) > 0) return false;
    if ((allowance(room).spawn || 0) - countType(room, STRUCTURE_SPAWN) <= 0) return false;
    for (const spot of plan.spawns) {
        if (trySite(room, spot, STRUCTURE_SPAWN)) return true;
    }
    return false;
}

function place(room, mem) {
    const plan = mem.plan;
    if (!plan) return;
    if (placeFirstSpawn(room, plan)) mem.layoutFirstSpawn = Game.time;
    if (deadRoom(room, mem)) {
        const removed = trimDeadRoomSites(room);
        const containers = placeCoreContainerSites(room, mem);
        if (removed || containers) mem.layoutDeadTrim = { at: Game.time, removed, containers };
        return;
    }
    blockedThisRun = [];
    let fullPass = false;
    try {
        fullPass = placeSites(room, mem, plan) !== false;
    } finally {
        if (fullPass) {
            if (blockedThisRun.length) mem.layoutBlocked = blockedThisRun;
            else delete mem.layoutBlocked;
        }
        blockedThisRun = null;
    }
}

function highPriorityNeeds(room, plan, allow) {
    const luxuryOk = utils.luxuryAllowed(room);
    const terminalMin = utils.terminalMinStorageFor(room);
    const storageEnergy = room.storage ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
    const highTypes = [
        ['extension', STRUCTURE_EXTENSION, plan.ext || []],
        ['tower', STRUCTURE_TOWER, plan.towers || []],
        ['storage', STRUCTURE_STORAGE, plan.storage ? [plan.storage] : []],
        ['terminal', STRUCTURE_TERMINAL, plan.terminal && !(terminalMin > 0 && storageEnergy < terminalMin) ? [plan.terminal] : []],
        ['lab', STRUCTURE_LAB, luxuryOk ? plan.labs || [] : []],
        ['spawn', STRUCTURE_SPAWN, plan.spawns || []],
        ['link', STRUCTURE_LINK, ['ctrl', 'src0', 'src1', 'store', 'aux0', 'aux1'].map((key) => linkSpot(plan, key)).filter(Boolean)],
    ];
    let needs = 0;
    for (const [key, type, spots] of highTypes) {
        const remaining = (allow[key] || 0) - countType(room, type);
        if (remaining <= 0) continue;
        const free = spots.filter((spot) => spot && !structureAt(room, spot.x, spot.y, type) && !siteAt(room, spot.x, spot.y, type) &&
            !(room.lookForAt(LOOK_CONSTRUCTION_SITES, spot.x, spot.y) || []).length &&
            !room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).some((s) => !structuresCanShare(s.structureType, type))).length;
        needs += Math.min(remaining, free);
    }
    return needs;
}

function yieldStalled(mem, kind, need) {
    const last = mem.layoutYieldBy && mem.layoutYieldBy[kind];
    const cooldown = Math.max(0, Number(config.layoutYieldCooldown) || 0);
    return !!last && Game.time - Number(last.at) < cooldown && need >= Number(last.need);
}

function noteYield(mem, kind, need) {
    const by = mem.layoutYieldBy || (mem.layoutYieldBy = {});
    by[kind] = { at: Game.time, need };
}

function yieldLowPrioritySites(room, plan, allow) {
    const need = highPriorityNeeds(room, plan, allow);
    if (need <= 0) return false;
    const mem = roomMem(room);
    if (yieldStalled(mem, 'high', need)) return false;
    const lowTypes = new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL]);
    let freed = 0;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
        if (freed >= 2) break;
        if (!lowTypes.has(site.structureType) || (site.progress || 0) > 0) continue;
        if (utils.removeSite(site, 'yieldHigh')) freed++;
    }
    if (freed) noteYield(mem, 'high', need);
    return freed > 0;
}

function missingRoadTiles(room, plan) {
    if (!plan || !plan.roads) return 0;
    const seen = new Set();
    let missing = 0;
    for (const str of Object.values(plan.roads)) {
        if (!str) continue;
        for (const p of unpackPath(str)) {
            const key = p.x + '.' + p.y;
            if (seen.has(key)) continue;
            seen.add(key);
            if (structureAt(room, p.x, p.y, STRUCTURE_ROAD) || siteAt(room, p.x, p.y, STRUCTURE_ROAD)) continue;
            missing++;
        }
    }
    return missing;
}

function yieldRampartSitesForRoads(room, plan) {
    const need = missingRoadTiles(room, plan);
    if (need <= 0) return false;
    const mem = roomMem(room);
    if (yieldStalled(mem, 'road', need)) return false;
    const core = new Set(coreRampartSpots(room).map((p) => p.x + '.' + p.y));
    let freed = 0;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
        if (freed >= 2) break;
        if (site.structureType !== STRUCTURE_RAMPART && site.structureType !== STRUCTURE_WALL) continue;
        if ((site.progress || 0) > 0) continue;
        if (core.has(site.pos.x + '.' + site.pos.y)) continue;
        if (utils.removeSite(site, 'yieldRoad')) freed++;
    }
    if (freed) noteYield(mem, 'road', need);
    return freed > 0;
}

function placeSites(room, mem, plan) {
    normalizeLinkPlan(room, plan);
    const allow = allowance(room);
    trimSites(room, plan);
    const own = room.find(FIND_MY_CONSTRUCTION_SITES).length;
    const floor = Math.max(0, Number(config.siteFloorPerRoom) || 0);
    let budget = Math.min(config.maxSites - own, Math.max(globalSiteBudget(), Math.min(floor - own, globalSiteHeadroom())));
    if (budget <= 0 && yieldLowPrioritySites(room, plan, allow)) { mem.layoutYield = Game.time; return false; }
    if (budget <= 0 && yieldRampartSitesForRoads(room, plan)) { mem.layoutYield = Game.time; return false; }
    if (budget <= 0) return false;
    const types = {
        spawn: STRUCTURE_SPAWN,
        extension: STRUCTURE_EXTENSION,
        tower: STRUCTURE_TOWER,
        storage: STRUCTURE_STORAGE,
        link: STRUCTURE_LINK,
        terminal: STRUCTURE_TERMINAL,
        lab: STRUCTURE_LAB,
        extractor: STRUCTURE_EXTRACTOR,
        observer: STRUCTURE_OBSERVER,
        powerSpawn: STRUCTURE_POWER_SPAWN,
        nuker: STRUCTURE_NUKER,
        factory: STRUCTURE_FACTORY,
        container: STRUCTURE_CONTAINER,
        road: STRUCTURE_ROAD,
        rampart: STRUCTURE_RAMPART,
        wall: STRUCTURE_WALL,
    };
    const keys = {};
    for (const key in types) keys[types[key]] = key;
    const need = (value) => {
        const key = allow[value] != null ? value : keys[value];
        if (!key || allow[key] == null) return 0;
        return Math.max(0, allow[key] - countType(room, types[key]));
    };

    let cPending = pending(room, STRUCTURE_CONTAINER);
    const containerKeys = ['src0', 'src1', 'ctrl'];
    for (const key of containerKeys) {
        if (need('container') <= 0 || budget <= 0) break;
        if (key !== 'src0' && key !== 'src1' && cPending >= sitePace().containers) break;
        if (plan.containers[key] && trySite(room, plan.containers[key], STRUCTURE_CONTAINER)) { budget--; cPending++; }
    }
    if (need('link') > 0 && budget > 0) {
        let linkBudget = need('extension') > 0 ? budget - 1 : budget;
        for (const key of ['ctrl', 'src0', 'src1', 'store', 'aux0', 'aux1']) {
            if (need('link') <= 0 || linkBudget <= 0) break;
            const spot = linkSpot(plan, key);
            if (trySite(room, spot, STRUCTURE_LINK)) { budget--; linkBudget--; }
        }
    }
    const oneOffFirst = (config.construction || {}).oneOffBeforeRoads !== false;
    const oneOffPlaced = new Set();
    const placeOneOffs = (early) => {
        let oneOffBudget = early && need('extension') > 0 ? budget - 1 : budget;
        for (const [key, type] of [['storage', STRUCTURE_STORAGE], ['terminal', STRUCTURE_TERMINAL]]) {
            if (need(key) <= 0 || oneOffBudget <= 0 || !plan[key]) continue;
            if (key === 'terminal') {
                const min = utils.terminalMinStorageFor(room);
                const st = room.storage && room.storage.my !== false && room.storage.store
                    ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
                if (min > 0 && st < min) continue;
            }
            if (oneOffPlaced.has(key)) {
                mem.oneOffDeduped = { at: Game.time, type: key, budget: oneOffBudget };
                continue;
            }
            if (!trySite(room, plan[key], type)) continue;
            oneOffPlaced.add(key);
            budget--; oneOffBudget--;
            if (early) mem.oneOffAhead = { at: Game.time, type: key, extNeed: need('extension'), level: room.controller.level };
            else if (oneOffFirst) mem.oneOffLeftover = { at: Game.time, type: key, extNeed: need('extension'), level: room.controller.level };
        }
    };
    if (oneOffFirst) placeOneOffs(true);
    if (budget > 0 && room.controller.level >= Math.max(1, Number(config.roadsMinRcl) || 1)) {
        const rPendingFirst = pending(room, STRUCTURE_ROAD);
        let roadBudget = Math.min(budget, sitePace().roads - rPendingFirst);
        if (mem.layoutYield != null && Game.time - mem.layoutYield <= config.layoutInterval * 3) {
            roadBudget = Math.min(roadBudget, budget - Math.min(budget, highPriorityNeeds(room, plan, allow)));
        }
        if (roadBudget > 0) budget -= placeRoads(room, plan, roadBudget);
    }
    delete mem.layoutYield;
    if (need('extension') > 0 && budget > 0) {
        let missing = need('extension');
        for (const spot of plan.ext || []) {
            if (missing <= 0 || budget <= 0) break;
            if (trySite(room, spot, STRUCTURE_EXTENSION)) { missing--; budget--; }
        }
    }
    const rcl8Order = room.controller.level >= 8 && (config.construction || {}).rcl8BuildOrder !== false;
    const placeSpawns = () => {
        if (!(need('spawn') > 0 && budget > 0)) return;
        const first = (plan.wheel || !room.find(FIND_MY_SPAWNS).length) && plan.spawns ? plan.spawns : [];
        const spawnPositions = first.concat(plan.spawn2 || [], plan.spawn3 || []);
        for (const spot of spawnPositions) {
            if (need('spawn') <= 0 || budget <= 0) break;
            if (trySite(room, spot, STRUCTURE_SPAWN)) budget--;
        }
    };
    const placeTowers = () => {
        if (!(need('tower') > 0 && budget > 0)) return;
        let missing = need('tower');
        for (const spot of plan.towers || []) {
            if (missing <= 0 || budget <= 0) break;
            if (trySite(room, spot, STRUCTURE_TOWER)) { missing--; budget--; }
        }
    };
    if (rcl8Order) placeSpawns();
    else placeTowers();
    placeOneOffs(false);
    const luxuryOk = utils.luxuryAllowed(room);
    if (!luxuryOk && need('lab') > 0) {
        mem.luxuryHeld = { at: Game.time, storage: room.storage ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0 };
    }
    if (need('extractor') > 0 && budget > 0) {
        const mineralPlan = brain.get(room.name, 'mineral', null);
        if (mineralPlan && mineralPlan.build && mineralPlan.pos &&
            trySite(room, mineralPlan.pos, STRUCTURE_EXTRACTOR)) budget--;
    }
    if (luxuryOk && need('lab') > 0 && budget > 0) {
        let missing = need('lab');
        for (const spot of plan.labs || []) {
            if (missing <= 0 || budget <= 0) break;
            if (trySite(room, spot, STRUCTURE_LAB)) { missing--; budget--; }
        }
    }
    if (rcl8Order) placeTowers();
    else placeSpawns();
    if (room.controller.level >= 7 && budget > 0) {
        const miscTypes = [STRUCTURE_FACTORY, STRUCTURE_OBSERVER, STRUCTURE_NUKER, STRUCTURE_POWER_SPAWN];
        const structureKeys = {};
        structureKeys[STRUCTURE_FACTORY] = 'factory';
        structureKeys[STRUCTURE_OBSERVER] = 'observer';
        structureKeys[STRUCTURE_NUKER] = 'nuker';
        structureKeys[STRUCTURE_POWER_SPAWN] = 'powerSpawn';
        for (const t of miscTypes) {
            if (need(t) <= 0 || budget <= 0) continue;
            if (utils.luxuryStructure(t) && !luxuryOk) continue;
            const planned = plan.structures && plan.structures[structureKeys[t]];
            if (planned && trySite(room, planned, t)) { budget--; continue; }
            for (const spot of plan.misc || []) {
                if (need(t) <= 0 || budget <= 0) break;
                if (trySite(room, spot, t)) budget--;
            }
        }
    }
    if (room.controller.level >= 2 && budget > 0 && rampartsAllowed(room)) {
        if (ringAllowed(room, plan)) {
            let placed = 0;
            for (const spot of plan.ramparts) {
                if (placed >= sitePace().ramparts || budget <= 0) break;
                if (structureAt(room, spot.x, spot.y, STRUCTURE_RAMPART) || siteAt(room, spot.x, spot.y, STRUCTURE_RAMPART)) continue;
                if (trySite(room, spot, STRUCTURE_RAMPART)) { placed++; budget--; }
            }
        } else if (room.controller.level >= 3) {
            const cores = coreRampartSpots(room);
            let n = 0;
            for (const pos of cores) {
                if (n >= 2 || budget <= 0) break;
                if (structureAt(room, pos.x, pos.y, STRUCTURE_RAMPART) || siteAt(room, pos.x, pos.y, STRUCTURE_RAMPART)) continue;
                if (room.createConstructionSite(pos.x, pos.y, STRUCTURE_RAMPART) === OK) { n++; budget--; }
            }
        }
    }
    if (room.controller.level >= 2 && budget > 0 && plan.walls && plan.walls.length) {
        let placed = 0;
        for (const spot of plan.walls) {
            if (placed >= sitePace().walls || budget <= 0) break;
            if (structureAt(room, spot.x, spot.y, STRUCTURE_WALL) || siteAt(room, spot.x, spot.y, STRUCTURE_WALL)) continue;
            if (trySite(room, spot, STRUCTURE_WALL)) { placed++; budget--; }
        }
    }
}

function maybeGenerateWheelPlan(room, mem) {
    if (!wheelLayout.shouldGenerate(mem)) return false;
    return wheelLayout.generate(room, mem).ok;
}

function normalizeLabPlan(plan) {
    const labs = plan && plan.labs;
    if (!Array.isArray(labs) || labs.length < 3) return;
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const reactable = (list) => list.some((out, i) => list.every((other, k) => k === i || cheb(out, other) <= 2));
    if (reactable(labs.slice(0, 3))) return;
    let best = null;
    for (const out of labs) {
        const near = labs.filter((other) => other !== out && cheb(out, other) <= 2);
        if (near.length >= 2 && (!best || near.length > best.near.length)) best = { out, near };
    }
    if (!best) return;
    const head = [best.out, best.near[0], best.near[1]];
    plan.labs = head.concat(labs.filter((lab) => head.indexOf(lab) < 0));
}

function run(room) {
    const mem = roomMem(room);
    if (!mem.plan || !mem.plan.wheel) {
        maybeGenerateWheelPlan(room, mem);
        if (!mem.plan || !mem.plan.wheel) return;
    }
    normalizeLinkPlan(room, mem.plan);
    normalizeLabPlan(mem.plan);
    mem.layoutAt = Game.time;
    try { place(room, mem); } catch (e) { logErr('layout.place ' + room.name, e); }
}

module.exports = { run, roomMem, structureAt, allowance, linkSpot, resolveSources, sourceOrderStats, remapHarvesterSources, normalizeLinkPlan, normalizeLabPlan, maybeGenerateWheelPlan,
    upgraderStorageStations, controllerFedByStorage, upgraderStation, atUpgraderStation, ringAllowed, ringKeep, highPriorityNeeds, yieldLowPrioritySites };
