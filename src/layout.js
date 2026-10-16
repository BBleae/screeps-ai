'use strict';
/** 房间布局：规划只来自轮子（vendor/wheels/layout-2.1.0，经 wheel_layout.generate 在游戏内跑一次），
 *  本模块按 RCL 配额逐步放置工地。规划结果缓存在 Memory.rooms[name].plan（wheel: true）。 */
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

// 源顺序的每房每 tick 缓存。同一 tick 里 resolveSources 被调很多遍：每只矿工一次（roles/harvester）、spawn 四处、
// links、layout，每次都是 find(FIND_SOURCES) + 排序 + Set 构造，外加 needsHarvesterRemap 把本房 creep 与 spawn 扫一遍；
// 源的位置一辈子不变。函数的副作用（remapHarvesterSources、写回 mem.sources / plan.sourceIds）在 tick 内是幂等的——
// 第一次跑完 sameIds 就成立，后面的调用本来也什么都不做，所以缓存不改变行为。
// 命中要求同一个 room / mem / plan 对象：wheel 规划试算候选方案、或 mem.plan 当 tick 被换掉时照常重算
// （单测会在同一 Game.time 里重建房间，对象身份也挡住了串用）。
const sourceOrderCache = { tick: -1, rooms: {} };
// 进程内累计 [调用, 命中]：main.sampleStats 按窗口取差值写进 Memory.stats.cache.srcOrder
const sourceOrderCounters = { calls: 0, hits: 0 };

/** 将 sourceIdx 固定到持久化 ID：plan.sourceIds 优先，旧布局由 mem.sources 迁移生成。
 *  无效/缺失 ID 会被可见源按稳定坐标顺序补齐，并同步回两处内存。 */
function resolveSources(room, mem, plan) {
    mem = mem || (Memory.rooms && Memory.rooms[room.name]) || {};
    plan = plan || mem.plan || null;
    sourceOrderCounters.calls++;
    // 只缓存"用本房自己方案"的调用；传别的 plan 进来时照常重算
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

/** 源顺序缓存的进程内累计计数（[调用, 命中] 的来源） */
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

/** 升级者的 storage 站位（向 Kalgen 学的：升级者静止在 storage 旁直接取能，不要控制器容器/控制器 link）：
 *  storage 已建成时，与 storage 相邻、控制器射程 3 内、不是墙也不是规划结构位、没有不可通行建筑的格；
 *  非道路格优先，其次贴规划 link 的、离控制器近的。没有这样的格（W34S7 的 storage 离控制器 5 格）返回 []，升级者退回容器/ctrl link 站位。 */
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
        // 已建成的 link 相邻（RCL5 的 ctrl link 由源 link 免费供能）：站在它旁边 storage 空着也能喝 link，优先级高于只是规划里有 link 的格
        const builtLinks = builtLinkSpots.filter((spot) => chebyshev(spot, { x, y }) <= 1).length;
        spots.push({ x, y, road, nearLinks, builtLinks, ctrlDist });
    }
    // 贴着已建成的 link 排第一（哪怕是道路格）：不贴 link 的站位只能喝 storage，ctrl link 喝不空整条 link 链就堵死，
    // 源头产出全靠 hauler 手搬（线上 W31S5/W31S8：选中的站位 0/55、2/48 采样贴着 ctrl link）；站在路上挡一格，移动库会绕开干活的 creep
    spots.sort((a, b) => (b.builtLinks - a.builtLinks) || (a.road - b.road) || (b.nearLinks - a.nearLinks) || (a.ctrlDist - b.ctrlDist) || (a.y - b.y) || (a.x - b.x));
    stationCache.rooms[cacheKey] = spots;
    return spots;
}

/** 升级者是否由 storage 供能（有 storage 站位）：为真时控制器容器不再喂、hauler 往返不再算控制器段 */
function controllerFedByStorage(room, plan) {
    return upgraderStorageStations(room, plan).length > 0;
}

/** 升级者站位——roles/upgrader 的走位与 movement 的工位判定共用这一份定义（两边各推一遍曾经分叉：交通解算把站在 storage 旁的升级者当闲人推开）。
 *  storage 建成且有相邻站位时以 storage 为锚（storageFed，spots 为站位列表）；否则首选站点是规划容器位（或工作位），能量锚点为已建成的
 *  ctrl link > 容器；容器/link 都没建时 anchor 为 null，升级者贴 controller 3 格内即可 */
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

/** 站在锚点 1 格内且 controller 3 格内即可工作：多个升级者共用一个锚点，不必抢同一格 */
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
    if (!site || typeof site.remove !== 'function') return false;
    const result = site.remove();
    return result == null || result === OK;
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
            if (canAdoptExistingContainer(duplicate) && removeDuplicateContainerSite(duplicate)) {
                spot = built;
            } else {
                // 已投入过半（或无法确认删除成功）的重复工地优先保留，避免丢弃进度。
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
    // ctrl link 放在 upgrader 站位（容器/工作位）旁：controller 常在墙洞里，其相邻格可能只有站位这一格
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
/** 各结构在当前 RCL 的配额（对齐 CONTROLLER_STRUCTURES 常量表） */
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

/** 沿规划路径放道路工地，每次最多 n 个 */
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
    // 轮子给的是整张路网（无序）：从核心向外铺，核心区的路先通
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

// place() 单轮上下文：本轮记录的冲突（拆迁调度 demolition.js 负责在合适时机清掉阻挡物）
let blockedThisRun = null;
const REPORT_BLOCKED_TYPES = new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL, STRUCTURE_CONTAINER]);

/** 规划点被别的结构占住：记录到 Memory.rooms.*.layoutBlocked，供拆迁调度与监控读取 */
function handleBlocked(room, spot, type, blockers) {
    if (REPORT_BLOCKED_TYPES.has(type)) return;
    const by = blockers.map((structure) => structure.structureType);
    if (blockedThisRun) blockedThisRun.push({ x: spot.x, y: spot.y, type, by: by.length === 1 ? by[0] : by.join('/') });
}

function trySite(room, spot, type) {
    if (!spot) return false;
    if (type !== STRUCTURE_EXTRACTOR && isWall(room, spot.x, spot.y)) return false;
    const structures = room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y);
    // 这个规划位上已经建成了它自己：这是"完成"，不是"被挡住"。放置循环会把 plan.ext 整个走一遍，
    // 所以每个建好的 extension 都会走到这里——过去它们全被记成 layoutBlocked，监控每轮报
    // 「方案位被旧建筑占住 20 处 extension@25,36<-extension」，其实一处冲突都没有。
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

/** 工地限流与漂移清理：容器在建 ≤ sitePace.containers（进度高的保留），道路只清漂移（在建数由放置端 sitePace.roads 限制，
 *  删规划内的道路工地只会丢进度），重规划后不在规划点上的移除。
 *  必须在计算 budget 之前执行——否则工地满时直接 return，清理永远轮不到，名额被死锁。 */
function sitePace() {
    return Object.assign({ roads: 8, ramparts: 6, walls: 2, containers: 2 }, config.sitePace || {});
}

function trimSites(room, plan) {
    const planned = {};
    const containerSpots = Object.assign({}, plan.containers || {});
    if (room.controller.level < 6) delete containerSpots.mineral;   // RCL6 前矿容器不算规划内，已有工地一并清掉
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
            // 已投入过半的规划工地例外保留，即使当前在建数超过上限，避免丢失建设进度。
            if (planned[type].has(key) && highProgress) continue;
            if (keep < keepMax && planned[type].has(key)) { keep++; continue; }
            if (typeof s.remove === 'function') s.remove();
        }
    }
    // 外环推迟期间（RCL < rampartRingMinRcl）：零进度的裸地 rampart 工地清掉，把名额还给 extension/storage 和外矿/新房；
    // 盖在核心建筑上的保留，已有进度的保留（RCL 降级时不丢进度）
    if (!ringAllowed(room, plan)) {
        const core = new Set(coreRampartSpots(room).map((p) => p.x + '.' + p.y));
        for (const s of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
            if (s.structureType !== STRUCTURE_RAMPART || (Number(s.progress) || 0) > 0) continue;
            if (core.has(s.pos.x + '.' + s.pos.y)) continue;
            if (typeof s.remove === 'function') s.remove();
        }
    }
    // 路要等 config.roadsMinRcl：门槛只挡新放的不够，存量也要还回去——3503001 上线后 W33S3/W31S5 仍各挂 24 条零进度的路，
    // 全账号停在 98。有进度的保留（RCL 降级时不丢进度）。遥测 Memory.rooms[房].roadsTrimmed
    if (room.controller.level < Math.max(1, Number(config.roadsMinRcl) || 1)) {
        let trimmed = 0;
        for (const s of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
            if (s.structureType !== STRUCTURE_ROAD || (Number(s.progress) || 0) > 0) continue;
            if (typeof s.remove === 'function' && s.remove() === OK) trimmed++;
        }
        if (trimmed) {
            const mem = roomMem(room);
            mem.roadsTrimmed = (Number(mem.roadsTrimmed) || 0) + trimmed;
            mem.roadsTrimmedAt = Game.time;
        }
    }
}

/** 工地上限是每个玩家 100（所有房间 + 外矿 + 扩张共用）：母房只用到 100 − globalSiteReserve，
 *  给外矿容器/道路（remote.js 在 ≥100 时停放）和新房 spawn 工地（expansion.js 不检查 ERR_FULL）留名额 */
function globalSiteBudget() {
    const limit = typeof MAX_CONSTRUCTION_SITES === 'number' ? MAX_CONSTRUCTION_SITES : 100;
    const reserve = Math.max(0, Number(config.globalSiteReserve) || 0);
    const count = Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
    return Math.max(0, limit - reserve - count);
}

/** 扣掉留给外矿容器工地的 remoteContainerSiteReserve 后全局还剩几个名额：每房保底也只能放到这条线——remote.js 撤路腾出的名额
 *  下一轮 infraTick 才用得上，这 11 tick 里保底房会把它抢走（线上 2026-09-06 W32S8 撤了 5 条路仍放不出容器） */
function globalSiteHeadroom() {
    const limit = typeof MAX_CONSTRUCTION_SITES === 'number' ? MAX_CONSTRUCTION_SITES : 100;
    const reserve = Math.max(0, Number(config.remoteContainerSiteReserve) || 0);
    const count = Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
    return Math.max(0, limit - reserve - count);
}

/** rampart 建成只花 1 能量，但从 1 血开始衰减、全靠塔维修到 rampartTargetHits：没有塔或塔能量不足时不放新 rampart 工地（防线等塔） */
function rampartsAllowed(room) {
    const minEnergy = Math.max(0, Number(config.rampartTowerEnergy) || 0);
    const towers = room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
    return towers.some((t) => t.store && Number(t.store[RESOURCE_ENERGY] || 0) >= minEnergy);
}

/** 房养不养得起 min-cut 外环：每格 rampart 每 tick 衰减 RAMPART_DECAY_AMOUNT/RAMPART_DECAY_TIME = 3 血，
 *  84 格 = 252 血/tick；塔在射程 20 外只有 20 血/能量 ⇒ 12.6 能量/tick（builder 100 血/能量只要 2.5，
 *  但外环刚建成时比值 0.001%，塔按"离目标比例最低"选目标，会一直填它）。收入够不到
 *  config.rampartRingMinIncome 就先不铺——半圈 rampart 挡不住人却要付全额维护，而铺满外环的"填血"成本
 *  （84 格 × 目标血量 ÷ 100 血/能量）也要从同一份收入里出（线上 2026-09-09 W33S7 收入 8–30/tick，
 *  外环目标 30 万/格 = 25M 血 ≈ 25 万能量）。收入样本不足（新房）时视为不允许。 */
function rampartRingAffordable(room, mem) {
    const need = Math.max(0, Number(config.rampartRingMinIncome) || 0);
    if (!(need > 0)) return true;
    const track = mem && mem.spawnIncome;
    const samples = Math.max(1, Number((config.spawnQueue || {}).incomeSamples) || 200);
    return !!track && Number(track.n) >= samples && Number(track.ema || 0) >= need;
}

/** min-cut 外环（plan.ramparts，全是裸地）只在 RCL ≥ config.rampartRingMinRcl 且收入养得起时放；
 *  之前只给核心建筑盖 rampart（见 config 注释里的依据） */
function ringAllowed(room, plan) {
    const minRcl = Math.max(1, Number(config.rampartRingMinRcl) || 1);
    if (!(plan && Array.isArray(plan.ramparts) && plan.ramparts.length && room.controller.level >= minRcl)) return false;
    return rampartRingAffordable(room, roomMem(room));
}

/** 核心建筑（spawn/塔/storage/terminal）的位置：外环推迟期间 rampart 只盖这些 */
function coreRampartSpots(room) {
    return room.find(FIND_MY_SPAWNS).map((s) => s.pos)
        .concat(room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL }).map((s) => s.pos));
}

/** 房里还有没有能建工地的 creep（builder/pioneer，含孵化中、不含退役中）：没有的话工地只会挂着占全局名额 */
function hasBuilder(room) {
    for (const creep of creepsHome(room.name)) {
        const memory = creep.memory;
        if (memory.role !== 'builder' && memory.role !== 'pioneer') continue;
        if (memory.retired || memory.bodyUpgradeRetiring) continue;
        return true;
    }
    return false;
}

/** 死房判定：房里有工地却连续 config.deadRoom.afterTicks 没有 builder/pioneer。builderSeenAt 首次见到房间时从现在起算（部署/重生后不误判）；
 *  没有工地的房不计时——没工地就不会有 builder 目标，否则新 RCL 解锁后永远放不出第一个工地 */
function deadRoom(room, mem) {
    const settings = config.deadRoom || {};
    const after = Math.max(0, Number(settings.afterTicks) || 0);
    if (!after) return false;
    if (hasBuilder(room) || mem.builderSeenAt == null || room.find(FIND_MY_CONSTRUCTION_SITES).length === 0) mem.builderSeenAt = Game.time;
    return Game.time - mem.builderSeenAt >= after;
}

/** 死房只留 keep 个进度最高的工地（spawn 工地永远保留：新房/重生靠它；源/控制器容器工地也保留：
 *  静态矿工没 CARRY 建不了容器，恢复完全靠 builder 建这些工地。88fe9e7 两个死房各 27–30 个工地占满全局名额，
 *  裁掉路/extension 是对的，但把容器工地一起裁掉就再也采不起来）。 */
function trimDeadRoomSites(room) {
    const keep = Math.max(0, Number((config.deadRoom || {}).keep) || 0);
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES).filter((s) => s.structureType !== STRUCTURE_SPAWN &&
        s.structureType !== STRUCTURE_CONTAINER)
        .sort((a, b) => (Number(b.progress) || 0) - (Number(a.progress) || 0));
    let removed = 0;
    for (const site of sites.slice(keep)) {
        if (typeof site.remove === 'function' && site.remove() === OK) removed++;
    }
    return removed;
}

/** 死房仍补缺失的核心容器工地：place() 在 deadRoom 时直接 return，否则容器被裁掉后永远放不回来。 */
function placeCoreContainerSites(room, mem) {
    const plan = mem && mem.plan;
    if (!plan || !plan.containers) return 0;
    let placed = 0;
    for (const key of ['src0', 'src1', 'ctrl']) {
        if (plan.containers[key] && trySite(room, plan.containers[key], STRUCTURE_CONTAINER)) placed++;
    }
    return placed;
}

/** 房里一个我们的 spawn 都没有（新占的房、或刚拆掉占配额的敌方 spawn）：spawn 工地排在一切之前、死房也放。
 *  否则按常规顺序它排在容器/道路/extension 之后，名额被前面吃光就永远轮不到，房间只能靠外援 pioneer 吊着。 */
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
        // 工地名额满时本轮没有尝试放置，冲突记录保留上一轮的结果，不要误删
        if (fullPass) {
            if (blockedThisRun.length) mem.layoutBlocked = blockedThisRun;
            else delete mem.layoutBlocked;
        }
        blockedThisRun = null;
    }
}

/** 高优先结构（extension/塔/storage/spawn/link/terminal/lab）配额未满且有方案位可放，但名额被零进度的路/rampart/墙工地占满：
 *  让出最多 2 个零进度低优先工地（迁移期拆掉 extension 后替代工地才放得出来）。 */
/** 高优先结构（extension/塔/storage/terminal/lab/spawn）配额未满且方案位空着、可放的数量 */
function highPriorityNeeds(room, plan, allow) {
    const highTypes = [
        ['extension', STRUCTURE_EXTENSION, plan.ext || []],
        ['tower', STRUCTURE_TOWER, plan.towers || []],
        ['storage', STRUCTURE_STORAGE, plan.storage ? [plan.storage] : []],
        ['terminal', STRUCTURE_TERMINAL, plan.terminal ? [plan.terminal] : []],
        ['lab', STRUCTURE_LAB, plan.labs || []],
        ['spawn', STRUCTURE_SPAWN, plan.spawns || []],
        // link 位（src 是 src0 的别名，去重）：名额被零进度的路/rampart 占满时 link 也该让位放出
        ['link', STRUCTURE_LINK, ['ctrl', 'src0', 'src1', 'store', 'aux0', 'aux1'].map((key) => linkSpot(plan, key)).filter(Boolean)],
    ];
    let needs = 0;
    for (const [key, type, spots] of highTypes) {
        const remaining = (allow[key] || 0) - countType(room, type);
        if (remaining <= 0) continue;
        const free = spots.filter((spot) => spot && !structureAt(room, spot.x, spot.y, type) && !siteAt(room, spot.x, spot.y, type) &&
            !room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y).some((s) => !structuresCanShare(s.structureType, type))).length;
        needs += Math.min(remaining, free);
    }
    return needs;
}

function yieldLowPrioritySites(room, plan, allow) {
    if (highPriorityNeeds(room, plan, allow) <= 0) return false;
    const lowTypes = new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL]);
    let freed = 0;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
        if (freed >= 2) break;
        if (!lowTypes.has(site.structureType) || (site.progress || 0) > 0 || typeof site.remove !== 'function') continue;
        if (site.remove() === OK) freed++;
    }
    return freed > 0;
}

/** 方案里还没建成、也没在建的道路格数（含外矿路段的母房段）：道路是唯一会因为衰减而永久消失的规划结构 */
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

/** 工地名额满、方案里却有路没建成：让出最多 2 个零进度的 rampart/wall 工地给路。
 *  rampart 工地只有 1 点进度（建成就 1 血，之后全靠塔维修，是维修负担不是建造负担），而一条衰减到 0 的路要 300–1500 能量重建；
 *  工地名额是每玩家 100 的全局资源，名额被几十个零进度外环 rampart 占满时路永远补不回来。
 *  线上 2026-09-09 W33S7：40/40 名额 = terminal + 3 lab + 36 外环 rampart，方案里 89 格路只剩 61 格、34 格消失后无法重建。
 *  让出后下一次 layout.run 会按既有顺序（容器 → link → 道路）把路工地放出来，外环等名额富余时再回来。 */
function yieldRampartSitesForRoads(room, plan) {
    if (missingRoadTiles(room, plan) <= 0) return false;
    // 核心建筑（spawn/塔/storage/terminal）上的 rampart 工地保留：那是真正的防护，不是外环占位
    const core = new Set(coreRampartSpots(room).map((p) => p.x + '.' + p.y));
    let freed = 0;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
        if (freed >= 2) break;
        if (site.structureType !== STRUCTURE_RAMPART && site.structureType !== STRUCTURE_WALL) continue;
        if ((site.progress || 0) > 0 || typeof site.remove !== 'function') continue;
        if (core.has(site.pos.x + '.' + site.pos.y)) continue;
        if (site.remove() === OK) freed++;
    }
    return freed > 0;
}

function placeSites(room, mem, plan) {
    normalizeLinkPlan(room, plan);
    const allow = allowance(room);
    trimSites(room, plan);
    const own = room.find(FIND_MY_CONSTRUCTION_SITES).length;
    // 每房保底 siteFloorPerRoom：全局名额被外矿路/别的房占满时本房仍可放到保底数（引擎 100 上限放不下就 ERR_FULL，trySite 返回 false）
    const floor = Math.max(0, Number(config.siteFloorPerRoom) || 0);
    // 保底不吃外矿容器的保留名额（globalSiteHeadroom）
    let budget = Math.min(config.maxSites - own, Math.max(globalSiteBudget(), Math.min(floor - own, globalSiteHeadroom())));
    // site.remove() 下一 tick 才生效：让出名额后本轮不再放置，否则按"虚"名额又放一批路/rampart（线上曾堆到 21 个 rampart 工地）
    if (budget <= 0 && yieldLowPrioritySites(room, plan, allow)) { mem.layoutYield = Game.time; return false; }
    // 高优先结构不缺、但方案里的路没建成：把零进度的 rampart/wall 工地让给路（见 yieldRampartSitesForRoads）
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

    // 优先级：源容器 → link → storage → terminal → 道路 → extension → 塔 → 提取器 → lab → 额外 spawn → RCL7/8 杂项 → rampart
    // （storage/terminal 提前见下方 oneOffBeforeRoads；关掉时退回旧顺序：塔之后才放）
    // 道路垫底：路网数十格且配额近乎无限，排在前面会占满 maxSites 并在每次空位释放时抢先补位，
    // 高价值结构永远排不上（RCL2 放不出 extension 工地的根因）。容器/道路在建各限 2 个。
    let cPending = pending(room, STRUCTURE_CONTAINER);
    // 矿容器要等 extractor（RCL6）：提前放只会花 5000 能量建一个没人用的容器
    const containerKeys = ['src0', 'src1', 'ctrl']; // Mineral miners carry their own output.
    for (const key of containerKeys) {
        if (need('container') <= 0 || budget <= 0) break;
        // 在建配额只限控制器/矿容器：源容器是收入的根（线上 W33S7 容器衰减后 src0 的工地被 src1 + ctrl 两个在建挡住放不出来）
        if (key !== 'src0' && key !== 'src1' && cPending >= sitePace().containers) break; // 给 extension 等高优先结构留名额
        if (plan.containers[key] && trySite(room, plan.containers[key], STRUCTURE_CONTAINER)) { budget--; cPending++; }
    }
    // link 先于道路与 extension：RCL5+ 一座 link（5000）把一个源或控制器的运输整段交给 link，顶得上几只 hauler；配额只有 2–6 个占不了多少名额。
    // 基准 W34S7（d03395d 分叉）：RCL6 全程 20k tick 房内 10 个名额全是 extension 工地，link 工地到分叉后 24k tick 才放出。
    // RCL5 ctrl+src0，RCL6 加 src1，RCL7 再补 storage。legacy src 仅作为 src0 兼容别名。
    if (need('link') > 0 && budget > 0) {
        // extension 还缺时至少给它留 1 个名额：让位机制一次只腾 2 个，link 与 ext 各得 1，否则 ext 永远排不上
        let linkBudget = need('extension') > 0 ? budget - 1 : budget;
        for (const key of ['ctrl', 'src0', 'src1', 'store', 'aux0', 'aux1']) {
            if (need('link') <= 0 || linkBudget <= 0) break;
            const spot = linkSpot(plan, key);
            if (trySite(room, spot, STRUCTURE_LINK)) { budget--; linkBudget--; }
        }
    }
    // 一次性的 storage / terminal 排在道路与 extension **之前**（config.construction.oneOffBeforeRoads）。
    // 依据（overmind-absorb 55183d1 + 924a8c8；docs/benchmarks/2026-09-07-layout-order-ab-round10.md）：0→RCL8 基准 t=1.16M、
    // 六个房已 RCL7 时全账号 terminal 0 座。terminal 正好在 RCL6 解锁，而同一刻 extension 上限 30→40 多出 10 个名额，
    // 两个窗口完全重合：道路 + 新 extension 把这一轮的名额吃光，terminal 要等 extension 全部建完才排得上（晚几万 tick）。
    // 1 个名额换一整条子系统（storage：物流与升级供给；terminal：industry.canSpend 与跨房能量的前提），与 link 提前同理。
    // 只提前 storage/terminal：lab/factory/nuker 仍走下面的奢侈门槛（utils.luxuryAllowed），提取器仍等大脑的矿物方案。
    // 提前放不会把 builder 从 extension 上拉走：builder.sitePriority 里 terminal 与 extension 同为默认档 10、
    // 同档按剩余进度从小到大（extension 3000 先于 terminal 10 万）；无 storage 时 storage 本来就排在道路前（storageBeforeRoads）。
    // extension 还缺时至少给它留 1 个名额（与 link 同一套让位规则）：拆迁/让位腾出的名额必须放得出替代 extension
    const oneOffFirst = (config.construction || {}).oneOffBeforeRoads !== false;
    // 本 tick 早轮已放出的一次性建筑：room.find / lookForAt 与 createConstructionSite 的运行时检查都只看 tick 开头的对象，
    // 兜底轮按旧快照 need() 仍缺、同格再放也拿到 OK（处理器才丢掉重复）——白花一个名额，还写一条假的 oneOffLeftover（2026-10-14 复审）
    const oneOffPlaced = new Set();
    const placeOneOffs = (early) => {
        let oneOffBudget = early && need('extension') > 0 ? budget - 1 : budget;
        for (const [key, type] of [['storage', STRUCTURE_STORAGE], ['terminal', STRUCTURE_TERMINAL]]) {
            if (need(key) <= 0 || oneOffBudget <= 0 || !plan[key]) continue;
            if (key === 'terminal') {
                const min = Number((config.construction || {}).terminalMinStorage) || 0;
                const st = room.storage && room.storage.my !== false && room.storage.store
                    ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
                if (min > 0 && st < min) continue;
            }
            if (oneOffPlaced.has(key)) {
                // 遥测：兜底轮还有名额、旧快照里仍缺，旧代码会在这里同格重放（生效断言 layout.oneOffSameTickDedupe）
                mem.oneOffDeduped = { at: Game.time, type: key, budget: oneOffBudget };
                continue;
            }
            if (!trySite(room, plan[key], type)) continue;
            oneOffPlaced.add(key);
            budget--; oneOffBudget--;
            // 遥测：提前放出时 extension 还缺几个（生效断言 layout.oneOffBeforeRoads 看 extNeed > 0 时 terminal 照样放出）
            if (early) mem.oneOffAhead = { at: Game.time, type: key, extNeed: need('extension'), level: room.controller.level };
            // 遥测：提前开着、却是兜底轮放出的（留给 extension 的名额没人用；生效断言 layout.oneOffLeftover）
            else if (oneOffFirst) mem.oneOffLeftover = { at: Game.time, type: key, extNeed: need('extension'), level: room.controller.level };
        }
    };
    if (oneOffFirst) placeOneOffs(true);
    // 道路优先：路网决定 hauler 的运力（有路 MOVE 减半），先于 extension 放（每轮/在建数受 sitePace.roads 限制）；
    // 但 RCL < config.roadsMinRcl 的新房建不动路（只有 pioneer/builder 在建 spawn 与 extension），放了也是零进度占死全账号名额
    if (budget > 0 && room.controller.level >= Math.max(1, Number(config.roadsMinRcl) || 1)) {
        const rPendingFirst = pending(room, STRUCTURE_ROAD);
        let roadBudget = Math.min(budget, sitePace().roads - rPendingFirst);
        // 上一轮刚让出名额：这轮留给配额未满的高优先结构，路网不得抢先补位（旧代码只是靠名额富余才碰巧放得出替代 extension）
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
    // 10-16 战略：RCL8 建造顺序 extension → 第 3 spawn → lab→10 → tower→6；更低 RCL 仍塔优先（防御）
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
    // 兜底轮（提前开着也要跑）：提前那一轮给 extension 留的 1 个名额，若 extension 方案位放不出（被挡等拆迁 / 方案位不够）、
    // 塔也不缺，就在这里给 storage/terminal——旧顺序本来就把塔之后剩下的名额给它们，提前只该更早、不能更晚（2026-10-13 复审）
    placeOneOffs(false);
    // 奢侈建筑（lab/factory/nuker/powerSpawn；terminal 不设门槛）等 storage 过了经济门槛再放（utils.luxuryAllowed）
    const luxuryOk = utils.luxuryAllowed(room);
    if (!luxuryOk && need('lab') > 0) {
        // 遥测：奢侈建筑因 storage 没过门槛而没放工地
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
    // 完整 min-cut 防线分批落地（有塔且塔能量充足才放，见 rampartsAllowed；RCL ≥ rampartRingMinRcl 才放外环，见 ringAllowed）；
    // 外环推迟期间或旧计划没有 perimeter 时只保护核心建筑。
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

/** 没有轮子方案的房：bucket 够且不在重试冷却期时跑一次轮子。旧的 d1 蓝图/过渡布局一律作废——轮子是唯一规划来源。 */
function maybeGenerateWheelPlan(room, mem) {
    if (!wheelLayout.shouldGenerate(mem)) return false;
    return wheelLayout.generate(room, mem).ok;
}

/** 前三个 lab 必须能真的反应。
 *  runReaction 要求两个输入 lab 都在输出 lab 的切比雪夫 2 以内（引擎
 *  processor/intents/labs/run-reaction.js：|dx| > 2 || |dy| > 2 直接拒绝；docs/game/resources.md
 *  同样写着 "within the range of 2 squares"）。RCL6 只给 3 个 lab 名额，而轮子给的 lab 列表是任意顺序：
 *  用我们自己的三个固定件验算，W34S7 的前三个两两距离 3/4/1（没有合法输出 lab）、样例房同样失败，
 *  三个方案里却都存在可用三连——纯排序问题，不是规划器能力问题。
 *  已经可用就不动（保持稳定，不打乱已建成的顺序）。 */
function normalizeLabPlan(plan) {
    const labs = plan && plan.labs;
    if (!Array.isArray(labs) || labs.length < 3) return;
    const cheb = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const reactable = (list) => list.some((out, i) => list.every((other, k) => k === i || cheb(out, other) <= 2));
    if (reactable(labs.slice(0, 3))) return;
    // 选"两格内邻居最多"的那个当输出 lab：后续 RCL7/8 加 lab 时它还能继续当输出
    let best = null;
    for (const out of labs) {
        const near = labs.filter((other) => other !== out && cheb(out, other) <= 2);
        if (near.length >= 2 && (!best || near.length > best.near.length)) best = { out, near };
    }
    if (!best) return;   // 方案里根本没有合法三连：保持原样，别把顺序搅乱
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
    mem.layoutAt = Game.time;   // 本房最近一次布局的 tick；错峰是否真的错开，看各房这个值 % layoutInterval
    try { place(room, mem); } catch (e) { logErr('layout.place ' + room.name, e); }
}

module.exports = { run, roomMem, structureAt, allowance, linkSpot, resolveSources, sourceOrderStats, remapHarvesterSources, normalizeLinkPlan, normalizeLabPlan, maybeGenerateWheelPlan,
    upgraderStorageStations, controllerFedByStorage, upgraderStation, atUpgraderStation };
