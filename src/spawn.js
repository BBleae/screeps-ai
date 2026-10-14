'use strict';
/** spawn 管理：以 RCL 底线为保障，并按 source 吞吐、物流距离、建设 backlog 和 TTL 弹性补员。 */
const config = require('config');
const utils = require('utils');
const { creepsHome, creepsHomeRole } = utils;
const layout = require('layout');
const links = require('links');
const retire = require('retire');
const remote = require('remote');
const brain = require('brain');
const expansion = require('expansion');
const aid = require('aid');
const defense = require('defense');
const conquest = require('conquest');
const queue = require('spawn_queue');
const spawnExit = require('spawn_exit');
const { makeBody, bodyCost, bodyPartCount, carryCapacity, packedPathLength, pathLength, repeat, logErr, needsRepair, creepName, bodyTicksPerTile, isRetiring } = utils;

const PRIORITY = ['harvester', 'hauler', 'operator', 'upgrader', 'builder', 'feeder', 'mineralMiner', 'labTech', 'scout'];

// ---- 阶段级 CPU 计时（Memory.stats.cpuSpawn）----
// cpuBy 里 spawn 长期是前两大的模块（线上 2026-10-03 均值 42.6 / 总 131），但只有总数，不知道花在 pre / counts / demands /
// backlog / targets / write / requests / schedule / exec 的哪一段——忙/安静两条降频分支就是这么猜出来的。按阶段累计，
// 只在 config.cpuProfile.sampleEvery 的抽样 tick 量（与角色计时同一节奏），值是「抽样 tick 里全部房合计的每 tick 均值」，
// 各阶段之和对得上 cpuBy.spawn。开销：抽样 tick 每房 ≤ 10 次 getUsed（13 房 ≈ 0.1 CPU，摊到每 tick ≈ 0.02）。
const cpuPhases = { tick: -1, ticks: 0, ms: {} };
let phaseOn = false;
let phaseMark = 0;
function phaseBegin() {
    const every = Math.max(1, Math.floor(Number((config.cpuProfile || {}).sampleEvery) || 5));
    phaseOn = Game.time % every === 0 && !!Game.cpu && typeof Game.cpu.getUsed === 'function';
    if (!phaseOn) return;
    if (cpuPhases.tick !== Game.time) { cpuPhases.tick = Game.time; cpuPhases.ticks++; }
    phaseMark = Game.cpu.getUsed();
}
function lap(name) {
    if (!phaseOn) return;
    const now = Game.cpu.getUsed();
    cpuPhases.ms[name] = (cpuPhases.ms[name] || 0) + (now - phaseMark);
    phaseMark = now;
}
/** 抽样 tick 的每 tick 均值（全部房合计），三位小数、只留 > 0 的阶段；取完清零（main.sampleStats 每 30 tick 取一次） */
function cpuDigest() {
    const out = {};
    if (cpuPhases.ticks > 0) {
        for (const key of Object.keys(cpuPhases.ms)) {
            const value = Math.round(cpuPhases.ms[key] / cpuPhases.ticks * 1000) / 1000;
            if (value > 0) out[key] = value;
        }
    }
    cpuPhases.ticks = 0;
    cpuPhases.ms = {};
    return out;
}
const MIN_HARVESTER_COST = 200; // work + carry + move
const BODY_UPGRADE_ROLES = ['harvester', 'hauler', 'upgrader', 'builder'];
const BODY_UPGRADE_COOLDOWN = 150;

function hasBodyPart(creep, type) {
    return (creep.body || []).some((part) => part.type === type && part.hits !== 0);
}

/** 出生口袋（config.spawnPocket，几何在 spawn_exit.computeSpawnDirections）：引擎按方向 1..8 取第一个空格出生（TOP 最先），
 *  spawn 旁被建筑/墙围死的格孵进去就再也走不出来（线上 2026-10-08 W31S4 的 (25,15)：上面三格是墙、左右 extension、下面两只 spawn）。
 *  spawnCreep 的 directions 只给非口袋方向；全是口袋或一个口袋都没有时返回 null（不限制，行为同引擎默认） */
function spawnDirections(spawn) {
    if (!spawn || !spawn.pos) return null;
    const room = (Game.rooms && Game.rooms[spawn.pos.roomName]) || spawn.room;
    if (!room || typeof room.getTerrain !== 'function') return null;
    // 不缓存：只在真正 spawnCreep 时调用（每房几十 tick 一次），一次是一遍建筑表 + 8 个 ≤ minTiles 格的 BFS
    const { open, pockets } = spawnExit.computeSpawnDirections(room, spawn);
    const dirs = pockets.length && open.length ? open : null;
    if (pockets.length && Memory.rooms) {
        // 遥测（私服生效断言 spawn.pocketDirections）：哪只 spawn 的哪些出生方向是口袋、现在只往哪些方向出生
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const log = mem.spawnPocket || (mem.spawnPocket = {});
        log[spawn.name || spawn.id] = { at: Game.time, pockets, dirs: dirs || null };
    }
    return dirs;
}
/** 孵好却生不出来：先让堵口的己方 creep 让路，stallTicks 后兜底只放开非口袋方向（spawn_exit.releaseStalledSpawns） */
const releaseStalledSpawns = spawnExit.releaseStalledSpawns;

/** spawnCreep 的选项：memory + 避开出生口袋的 directions */
function spawnOptions(spawn, memory) {
    const opts = { memory };
    const dirs = spawnDirections(spawn);
    if (dirs) opts.directions = dirs;
    return opts;
}

// Travel paths are shared by identical bodies, not recalculated for every upgrader.
// Roads/obstacles are refreshed within 100 ticks; station/RCL/plan changes invalidate immediately.
const upgraderLegCache = {};
function controllerTravelTicks(roomName, body) {
    let moves = 0, heavy = 0;
    for (const part of body || []) {
        const type = part.type || part;
        if (type === 'move') moves++;
        else heavy++; // May refill beside spawn/on the way; budget a full CARRY load.
    }
    const road = Math.max(1, Math.ceil(heavy / (2 * Math.max(1, moves))));
    const plain = Math.max(1, Math.ceil(heavy / Math.max(1, moves)));
    const swamp = Math.max(1, Math.ceil(heavy * 5 / Math.max(1, moves)));
    const mem = Memory.rooms && Memory.rooms[roomName];
    const room = Game.rooms && Game.rooms[roomName];
    const cache = upgraderLegCache[roomName] || (upgraderLegCache[roomName] = {});
    const bodyKey = (moves ? "mobile:" : "immobile:") + road + "," + plain + "," + swamp + ":" + (body || []).length;
    const previous = cache[bodyKey];
    if (!room || !room.controller) {
        if (mem) mem.upgraderLeg = { at: Game.time, ticks: null, complete: false, reason: 'noVision' };
        return null;
    }
    const plan = mem && mem.plan || {};
    const station = layout.upgraderStation(room, plan);
    const anchor = station && (station.anchor ? station.anchor.pos : station.pos);
    const spawns = room.find(FIND_MY_SPAWNS).slice(0, 3);
    const key = JSON.stringify([road, plain, swamp, room.controller.level, room.controller.pos.x, room.controller.pos.y,
        anchor && anchor.x, anchor && anchor.y, station && station.pos, station && station.spots, plan.version, plan.roads && plan.roads.ctrl,
        spawns.map(s => [s.pos.x, s.pos.y])]);
    if (previous && previous.key === key && Game.time >= previous.at && Game.time - previous.at < 100) return previous.ticks;
    let ticks = 0, complete = false, goals = [], searches = 0, ops = 0;
    const terrain = room.getTerrain ? room.getTerrain() : Game.map && Game.map.getRoomTerrain && Game.map.getRoomTerrain(roomName);
    if (moves && terrain && spawns.length && typeof PathFinder !== 'undefined' && typeof PathFinder.search === 'function') {
        const matrix = new PathFinder.CostMatrix();
        const roads = new Set();
        const blocked = new Set();
        for (const s of room.find(FIND_STRUCTURES)) {
            const tile = s.pos.x + ',' + s.pos.y;
            if (s.structureType === STRUCTURE_ROAD) roads.add(tile);
            else if (s.structureType !== STRUCTURE_CONTAINER &&
                !(s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic))) blocked.add(tile);
        }
        // Match wheel movement: obstacle construction sites in owned/safe-mode rooms are avoided.
        if (room.controller.my || room.controller.safeMode) {
            const obstacles = new Set(OBSTACLE_OBJECT_TYPES);
            for (const site of room.find(FIND_CONSTRUCTION_SITES)) {
                if (obstacles.has(site.structureType)) blocked.add(site.pos.x + ',' + site.pos.y);
            }
        }
        // Sources/minerals are natural obstacles, not FIND_STRUCTURES entries.
        for (const object of room.find(FIND_SOURCES).concat(room.find(FIND_MINERALS), [room.controller])) {
            blocked.add(object.pos.x + ',' + object.pos.y);
        }
        for (const tile of roads) { const [x, y] = tile.split(',').map(Number); matrix.set(x, y, 1); }
        for (const tile of blocked) { const [x, y] = tile.split(',').map(Number); matrix.set(x, y, 255); }
        const center = anchor || room.controller.pos;
        const range = anchor ? 1 : 3;
        for (let x = Math.max(1, center.x - range); x <= Math.min(48, center.x + range); x++) {
            for (let y = Math.max(1, center.y - range); y <= Math.min(48, center.y + range); y++) {
                const pos = new RoomPosition(x, y, roomName);
                if (!blocked.has(x + ',' + y) && !(terrain.get(x, y) & TERRAIN_MASK_WALL) &&
                    (!station || layout.atUpgraderStation(pos, station, room.controller))) goals.push({ pos, range: 0 });
            }
        }
        const passable = pos => pos && Number.isInteger(pos.x) && Number.isInteger(pos.y) &&
            pos.x > 0 && pos.y > 0 && pos.x < 49 && pos.y < 49 &&
            !blocked.has(pos.x + ',' + pos.y) && !(terrain.get(pos.x, pos.y) & TERRAIN_MASK_WALL);
        // goToStation tries each free preferred spot exactly before its all-occupied
        // anchor-neighbour fallback. An arbitrary nearest station tile can shortcut that route.
        const preferred = station ? Array.from(new Map((station.spots || [station.pos]).filter(passable)
            .map(pos => [pos.x + ',' + pos.y, pos])).values()) : [];
        const branches = preferred.slice(0, 9).map(pos => [{ pos: new RoomPosition(pos.x, pos.y, roomName), range: 0 }]);
        branches.push(goals);
        complete = goals.length > 0 && preferred.length <= 9;
        const valid = new Set(goals.map(goal => goal.pos.x + ',' + goal.pos.y));
        // At most 30 branches, with a shared 7500-op ceiling per 100 ticks/body class.
        if (complete) for (const spawn of spawns) for (const branch of branches) {
            if (ops >= 7500) { complete = false; break; }
            const maxOps = Math.min(2500, 7500 - ops);
            searches++;
            // Select the same route as wheel moveTo defaults; fatigue is accounted below.
            const result = PathFinder.search(spawn.pos, branch, { plainCost: 2, swampCost: 10,
                maxRooms: 1, maxOps, roomCallback: name => name === roomName ? matrix : false });
            ops += result && Number.isFinite(result.ops) ? Math.max(0, Math.min(maxOps, result.ops)) : maxOps;
            if (!result || result.incomplete || !Array.isArray(result.path)) { complete = false; continue; }
            let travel = 0, arrived = valid.has(spawn.pos.x + ',' + spawn.pos.y);
            for (const pos of result.path) {
                if (arrived) break;
                travel += roads.has(pos.x + ',' + pos.y) ? road :
                    (terrain.get(pos.x, pos.y) & TERRAIN_MASK_SWAMP) ? swamp : plain;
                arrived = valid.has(pos.x + ',' + pos.y);
            }
            if (!arrived) complete = false;
            ticks = Math.max(ticks, travel);
        }
    }
    const pathTicks = complete ? ticks : null;
    const baseLead = Math.max(config.spawnLead.upgrader || 0, (body || []).length * 3 + 12);
    const lifetime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    // A complete physical route may still be impossible to hand over within one
    // lifespan. Such a budget must not remove every newborn from planned counts.
    const reason = complete && ticks + baseLead >= lifetime ? 'lifetime' : undefined;
    if (reason) complete = false;
    // Unknown travel is observable but cannot justify removing a young creep from
    // the planned population. Keep only the base spawn lead until a complete route exists.
    if (!complete) ticks = null;
    for (const entry of Object.keys(cache)) {
        if (Game.time < cache[entry].at || Game.time - cache[entry].at >= 100) delete cache[entry];
    }
    if (!cache[bodyKey] && Object.keys(cache).length >= 8) {
        const oldest = Object.keys(cache).sort((a, b) => cache[a].at - cache[b].at)[0];
        delete cache[oldest];
    }
    cache[bodyKey] = { key, at: Game.time, ticks };
    if (mem) mem.upgraderLeg = { at: Game.time, ticks, complete, spawns: spawns.length, goals: goals.length, searches, ops, pathTicks, reason };
    return ticks;
}

function walkTicks(body, tiles) {
    // 空仓沿道路行走：每格疲劳 = 非 MOVE 非 CARRY 部件数，每 tick 每 MOVE 恢复 2
    if (!tiles) return 0;
    let moves = 0;
    let heavy = 0;
    for (const part of body || []) {
        const type = part.type || part;
        if (type === 'move') moves++;
        else if (type !== 'carry') heavy++;
    }
    const perTile = Math.max(1, Math.ceil(heavy / (2 * Math.max(1, moves))));
    return tiles * perTile;
}

/** spawn → 各源采集位的步行格数（缓存在 Memory.rooms[房].harvestLeg，每 harvestLegRefresh tick 重算）：
 *  路径算上不可通行的建筑——线上 W32S4 的 extension (24,15) 堵死了 spawn 西侧，src0 切比雪夫 13 格、实走 73 格 */
function harvestLegTiles(room, index) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!mem) return 0;
    const refresh = Math.max(100, Number((config.harvesting || {}).legRefreshTicks) || 1500);
    const track = mem.harvestLeg || (mem.harvestLeg = { at: -1e9, tiles: [] });
    if (Game.time - Number(track.at) >= refresh) {
        track.at = Game.time;
        track.tiles = [];
        const plan = mem.plan || {};
        const spawns = room.find(FIND_MY_SPAWNS);
        const sources = layout.resolveSources(room, mem, plan) || [];
        const matrix = new PathFinder.CostMatrix();
        for (const structure of room.find(FIND_STRUCTURES)) {
            if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
            else if (structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART) matrix.set(structure.pos.x, structure.pos.y, 255);
        }
        sources.forEach((source, i) => {
            const spot = (plan.workPositions && plan.workPositions['src' + i]) || (plan.containers && plan.containers['src' + i]);
            const goal = spot ? { pos: new RoomPosition(spot.x, spot.y, room.name), range: 0 } : (source && source.pos ? { pos: source.pos, range: 1 } : null);
            if (!goal) return;
            let best = null;
            for (const spawn of spawns) {
                const ret = PathFinder.search(spawn.pos, goal, { plainCost: 2, swampCost: 10, maxRooms: 1, roomCallback: () => matrix });
                if (ret && !ret.incomplete && ret.path) best = best == null ? ret.path.length : Math.min(best, ret.path.length);
            }
            track.tiles[i] = best == null ? 0 : best;
        });
    }
    return Number(track.tiles[index]) || 0;
}

/** 替补请求的提前量：roleLead（孵化时间）+ 矿工从 spawn 走到采集位的时间。只给"什么时候出替补请求"用——
 *  就绪判定（countReadyRole/countReadyWorkers、main.js 的 recovering）仍用 roleLead，否则交接期会更频繁地进 recovering。
 *  依据：5W1C1M 空载在路上 3 tick/格，替补请求在旧矿工只剩 roleLead（≈33）时才出，新矿工出生时旧的只剩 ≈12 tick，
 *  之后整段步行时间源都没人采（W31S8 src0 约 23 格、每代空采 60–90 tick；全账号约 4% 的母房源时间）；
 *  5 WORK 刚好 10/tick 等于源再生速率，没有追赶余量，空采的每 tick 永久损失 10 能量 */
function replaceLead(creep, role) {
    const lead = roleLead(creep, role);
    if (role !== 'harvester' || !creep.memory || creep.memory.dropMiner) return lead;
    const room = Game.rooms[creep.memory.home];
    if (!room) return lead;
    const index = Number.isInteger(creep.memory.sourceIdx) ? creep.memory.sourceIdx : 0;
    return lead + walkTicks(creep.body, harvestLegTiles(room, index));
}

function roleLead(creep, role) {
    const base = config.spawnLead[role] || 0;
    const body = creep.body || [];
    const spawnTime = body.length * 3;
    let lead = Math.max(base, spawnTime + 12);
    // upgrader 是 1 MOVE 的重身体，接班者从 spawn 走到 controller 要几十 tick：提前量把这段路算进去
    if (role === 'upgrader' && creep.memory && creep.memory.home) lead += controllerTravelTicks(creep.memory.home, body) || 0;
    return lead;
}

function countReadyRole(room, role) {
    let n = 0;
    for (const creep of creepsHomeRole(room.name, role)) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, role)) continue;
        n++;
    }
    return n;
}

function countPlannedRole(room, role) {
    let n = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, role)) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        seen.add(creep.name);
        if (creep.spawning) { n++; continue; }
        const ttl = creep.ticksToLive;
        const lead = replaceLead(creep, role);
        if (role === 'harvester' && ttl != null && ttl <= lead && ttl > roleLead(creep, role)) {
            // 遥测：只因为算上步行时间才提前出的矿工替补（旧提前量下它还"在编"）
            const mem = Memory.rooms[room.name];
            if (mem) mem.harvesterEarlyReplace = { at: Game.time, name: creep.name, ttl, lead: roleLead(creep, role), replaceLead: lead };
        }
        if (ttl != null && ttl <= lead) continue;
        n++;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        if (seen.has(spawn.spawning.name) || Game.creeps[spawn.spawning.name]) continue;
        const mem = Memory.creeps[spawn.spawning.name];
        if (mem.home === room.name && mem.role === role) n++;
    }
    return n;
}

function countReadyWorkers(room) {
    let n = 0;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (creep.spawning) continue;
        if (!creep.room || creep.room.name !== room.name) continue;
        if (!hasBodyPart(creep, 'work')) continue;
        const ttl = creep.ticksToLive;
        const lead = roleLead(creep, creep.memory.role || 'harvester');
        if (ttl != null && ttl <= lead) continue;
        n++;
    }
    return n;
}

function stableHarvesterTarget(room, mem, sources) {
    const sourceCount = Math.max(1, (sources && sources.length) || 1);
    return Math.min(sourceCount, config.recovery.stableHarvesters);
}

function coreHarvesterTarget(room, sources) {
    const survival = config.survival[room.controller.level] || {};
    const stable = stableHarvesterTarget(room, null, sources);
    return Math.max(1, Math.min(stable, Number(survival.harvester || 0) || stable));
}

function roomState(room, mem, sources) {
    if (mem.state && mem.state.at === Game.time) return mem.state;
    const stableHarvesters = stableHarvesterTarget(room, mem, sources);
    const readyHarvesters = countReadyRole(room, 'harvester');
    const plannedHarvesters = countPlannedRole(room, 'harvester');
    const state = {
        at: Game.time,
        stableHarvesters,
        readyHarvesters,
        plannedHarvesters,
        readyWorkers: countReadyWorkers(room),
        recovering: readyHarvesters < stableHarvesters,
    };
    mem.state = state;
    return state;
}

/** 塔射程内的维修由塔负责（塔 10 能量 = 800 血，比 builder 的 100 血/能量便宜 8 倍），射程外的只有 builder 够得着。
 *  返回射程外需要维修的非 rampart 结构的数量与维修债（血，算到维修线 hitsMax × towerRepairBelow）。
 *  rampart/wall 不算：它们的维修目标是按收支动态定的"够用即止"，不该拉着编制走。
 *  线上 2026-09-10 实测：W32S4 射程外 67 条路（债 16.8 万血）、W31S4 63 条（19.3 万）、W33S8 48 条 21.6%（47.9 万）
 *  而这三房的 builderTarget 都是 0、W32S4/W33S8 一只 builder 都没有——塔有能量 ⇒ "有塔就不孵 builder" 的守卫
 *  把射程外的活一起挡了，路一路烂到消失（重建 300–1500 能量/条）。 */
const towerReachCache = { time: -1, rooms: {} };
function outOfTowerRepair(room) {
    if (towerReachCache.time !== Game.time) { towerReachCache.time = Game.time; towerReachCache.rooms = {}; }
    if (towerReachCache.rooms[room.name]) return towerReachCache.rooms[room.name];
    const range = Math.max(1, Number(config.towerCriticalRange) || 20);
    const wallRatio = Math.max(0, Math.min(1, Number(config.towerRepairBelow) || 0.6));
    const towers = room.find(FIND_MY_STRUCTURES).filter((s) => s.structureType === STRUCTURE_TOWER);
    let count = 0;
    let debt = 0;
    let critical = 0;
    for (const structure of room.find(FIND_STRUCTURES)) {
        if (structure.structureType === STRUCTURE_RAMPART || structure.structureType === STRUCTURE_WALL) continue;
        if (!needsRepair(room, structure)) continue;
        const covered = towers.some((tower) => Math.max(Math.abs(tower.pos.x - structure.pos.x),
            Math.abs(tower.pos.y - structure.pos.y)) <= range);
        if (covered) continue;
        count++;
        debt += Math.max(0, (Number(structure.hitsMax) || 0) * wallRatio - (Number(structure.hits) || 0));
        if (utils.criticallyDamaged(room, structure)) critical++;
    }
    const info = { count, debt: Math.round(debt), critical };
    towerReachCache.rooms[room.name] = info;
    return info;
}

function hasBuilderWork(room) {
    // 有工地（没过经济门槛的奢侈工地不算，builder 不会去建），或存在真正值得修的结构（与 tower/builder 同一判据，rampart 按 RCL 目标封顶）
    if (room.find(FIND_MY_CONSTRUCTION_SITES).some((site) => utils.siteWanted(room, site))) return true;
    const structures = room.find(FIND_STRUCTURES);    // 危急水位越过塔的守卫：塔守卫管的是日常维修，管不了深坑——塔一次动作在 ≥20 格只回 200 血，
    // 只能花到 towerRepairReserve 以上，从 5.7% 爬回维修阈值要上万 tick，而容器归零就消失（重建 5000 能量 + 丢采矿位）。
    // 注意不能改用"塔的能量"当判据：塔停在储备线（500–509）恰恰说明它在满负荷维修
    // （线上 W34S7 死区占比 76% 的同时容器以 +20.8 血/tick 回升），按那个放行会在塔干得最欢的房里孵 builder
    const critical = structures.find((s) => needsRepair(room, s) && utils.criticallyDamaged(room, s));
    if (critical) {
        // 决策事件遥测（私服生效断言）：严格区分新旧的状态是"有危急结构 + 塔有能量 + 没有工地"——
        // 旧代码在这里返回 false（塔守卫拦住），新代码返回 true。有工地时新旧都返回 true，区分不了，所以记 noSites
        const mem = Memory.rooms && Memory.rooms[room.name];
        if (mem) {
            const armed = room.find(FIND_MY_STRUCTURES).some((s) => s.structureType === STRUCTURE_TOWER &&
                s.store && s.store[RESOURCE_ENERGY] >= 500);
            if (armed) {
                const noSites = room.find(FIND_MY_CONSTRUCTION_SITES).length === 0;
                const seen = mem.criticalRepair || {};
                mem.criticalRepair = { at: Game.time, hits: critical.hits, type: critical.structureType,
                    n: (Number(seen.n) || 0) + 1, noSites: !!seen.noSites || noSites };
            }
        }
        return true;
    }
    // 有能量的塔会修**射程内的**：只剩射程内日常维修活时不为此孵 builder（线上 W33S7 为一个掉血的容器花 1300 孵了整只 builder）；
    // 射程外的结构塔够不着，塔再有能量也没用——那些路/容器只能靠 builder（线上 2026-09-10 见 outOfTowerRepair 的注释）
    const armedTower = room.find(FIND_MY_STRUCTURES).some((s) => s.structureType === STRUCTURE_TOWER &&
        s.store && s.store[RESOURCE_ENERGY] >= 500);
    if (armedTower) {
        const outOfReach = outOfTowerRepair(room);
        // 债太小不值得常驻一只 builder：一只满容量 builder 摊销约 0.9 能量/tick，而几条刚跌破 60% 的路一共只差几十血
        // （线上 RCL5 房"维修债 0 血/射程外 0 处"的间隙里仍反复孵 builder，修过线就闲着）。真跌到危急线还有 criticalGap 的生存档兜底
        const minDebt = Math.max(0, Number((config.construction || {}).outOfReachMinDebt) || 0);
        if (outOfReach.count > 0 && outOfReach.debt < minDebt) {
            // 遥测：射程外有维修债、但低于下限而不孵 builder（旧规则这里返回 true）
            const mem = Memory.rooms && Memory.rooms[room.name];
            if (mem) mem.outOfReachBelowFloor = { at: Game.time, count: outOfReach.count, debt: outOfReach.debt };
        }
        if (outOfReach.count === 0 || outOfReach.debt < minDebt) return false;
        // 决策事件遥测（私服生效断言）：旧代码在"塔有能量 + 没有工地"时一律返回 false
        const mem = Memory.rooms && Memory.rooms[room.name];
        if (mem) {
            const seen = mem.outOfReachRepair || {};
            mem.outOfReachRepair = { at: Game.time, count: outOfReach.count, debt: outOfReach.debt,
                n: (Number(seen.n) || 0) + 1 };
        }
        return true;
    }
    return structures.some((s) => needsRepair(room, s));
}

function constructionBacklog(room) {
    const settings = config.construction || {};
    const weights = settings.weights || {};
    const byType = {};
    let raw = 0;
    let weighted = 0;
    // 没过经济门槛的奢侈工地不计：builder 不建它们，也就不该为它们孵 builder（线上 W33S7 的 terminal 9 万 backlog 把目标顶到 2）
    const sites = (room.find(FIND_MY_CONSTRUCTION_SITES) || []).filter((site) => utils.siteWanted(room, site));
    for (const site of sites) {
        const remaining = Math.max(0, Number(site.progressTotal || 0) - Number(site.progress || 0));
        if (!remaining) continue;
        const type = site.structureType || 'unknown';
        const normalizedType = String(type).indexOf('structure_') === 0 ? String(type).slice(10) : type;
        const configuredWeight = weights[type] == null ? weights[normalizedType] : weights[type];
        const numericWeight = Number(configuredWeight);
        const weight = configuredWeight == null || !Number.isFinite(numericWeight) ? 0.1 : Math.max(0, numericWeight);
        raw += remaining;
        weighted += remaining * weight;
        byType[type] = (byType[type] || 0) + remaining;
    }
    return {
        raw: Math.round(raw),
        weighted: Math.round(weighted),
        sites: sites.length,
        byType,
    };
}

function builderWorkEstimate(room) {
    const desired = bodyPlan(room, 'builder');
    const desiredWork = Math.max(1, bodyPartCount(desired, 'work'));
    let count = 0;
    let work = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'builder')) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (creep.ticksToLive != null && !creep.spawning && creep.ticksToLive <= roleLead(creep, 'builder')) continue;
        seen.add(creep.name);
        count++;
        const workParts = bodyPartCount(creep.body, 'work');
        work += workParts > 0 ? workParts : desiredWork;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || seen.has(spawn.spawning.name) || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        const pending = Memory.creeps[spawn.spawning.name];
        if (pending.home !== room.name || pending.role !== 'builder') continue;
        count++;
        work += desiredWork;
    }
    return { count, work, desiredWork };
}

/** 有矿工在岗的外矿源按 10 能量/tick × remoteIncomeFactor 计入收入（运输损耗与路上时间打折） */
function remoteIncome(room) {
    const mem = (Memory.rooms && Memory.rooms[room.name]) || {};
    const records = mem.remotes || {};
    const factor = Number((config.construction || {}).remoteIncomeFactor || 0.8);
    let income = 0;
    for (const name in records) {
        const record = records[name];
        if (!record || !record.enabled || record.suspendedUntil > Game.time) continue;
        for (const source of record.sources || []) {
            const mined = creepsHomeRole(room.name, 'remoteMiner').some((creep) =>
                creep.memory.remoteRoom === name && creep.memory.sourceId === source.id && !creep.spawning);
            if (mined) income += 10 * factor;
        }
    }
    return income;
}

function builderTarget(room, backlog) {
    if (!hasBuilderWork(room)) return 0;
    const roster = config.roster[room.controller.level] || {};
    const settings = config.construction || {};
    const horizon = Math.max(1, Number(settings.horizon || 300));
    const progressPerWork = Math.max(1, Number(settings.progressPerWork || 5));
    const utilization = Math.max(0.2, Math.min(1, Number(settings.utilization || 0.8)));
    const limits = settings.maxBuilders || {};
    // 无 storage 的房能量闲置（容器快满 / 地上成堆）时上限 +1：能量在等 WORK，多一只 builder 就是多 5/tick 的进度
    const surplusExtra = !room.storage && utils.energySurplus(room) ? Math.max(0, Number(config.energySurplus && config.energySurplus.extraBuilders) || 0) : 0;
    const max = Math.max(1, Number(limits[room.controller.level] || roster.builder || 1)) + surplusExtra;
    const estimate = builderWorkEstimate(room);
    // 建造每点进度花 1 能量：能分给建设的能量收入决定了有意义的 WORK 上限，超出的 builder 只会排队等能量
    const sourceCount = Math.max(1, (room.find(FIND_SOURCES) || []).length);
    const incomeShare = Math.max(0.1, Math.min(1, Number(settings.incomeShare || 0.6)));
    // builder 约一半时间在取能/往返，只有 buildDuty 的 tick 真正在建
    const buildDuty = Math.max(0.2, Math.min(1, Number(settings.buildDuty || 0.5)));
    // 需求侧 = 建造（backlog 在 horizon 内做完） + 维修（塔够不到的债在 horizon 内清完）。
    // 维修：builder 100 血/能量、只有 buildDuty 的 tick 在干活；rampart 的债不算（见 outOfTowerRepair）。
    // 线上 2026-09-10：W33S8 射程外 48 条路 21.6%（债 47.9 万血）而 builderTarget 是 0——维修债不进需求侧就是这个后果
    const outOfReach = outOfTowerRepair(room);
    const repairWork = Math.ceil(outOfReach.debt / (100 * buildDuty * horizon));
    const byHorizon = Math.ceil((backlog || constructionBacklog(room)).weighted /
        (progressPerWork * horizon * utilization)) + repairWork;
    // 外矿收入也算：RCL5 的 W33S7 三个外矿在岗、spawn 满能量、容器 1700，却只按本房两个源算出 1 只 builder 对着 79k 积压
    const income = sourceCount * 10 + remoteIncome(room);
    const incomeWork = Math.max(1, Math.ceil(income * incomeShare / (progressPerWork * buildDuty)));
    const requiredWork = Math.min(byHorizon, incomeWork);
    const additionalWork = Math.max(0, requiredWork - estimate.work);
    const additional = Math.ceil(additionalWork / Math.max(1, estimate.desiredWork));
    const baseline = Math.max(1, Number(roster.builder || 0));
    const byIncome = Math.max(baseline, Math.ceil(incomeWork / Math.max(1, estimate.desiredWork)));
    return Math.min(max, byIncome, Math.max(baseline, estimate.count + additional));
}

function structureAt(room, pos, type) {
    if (!pos) return null;
    return room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y).find((s) => s.structureType === type) || null;
}

function sourceContainer(room, mem, source, index) {
    const planned = mem.plan && mem.plan.containers && mem.plan.containers['src' + index];
    const atPlan = structureAt(room, planned, STRUCTURE_CONTAINER);
    if (atPlan && atPlan.my !== false) return atPlan;
    if (!source) return null;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === STRUCTURE_CONTAINER &&
        structure.my !== false &&
        Math.max(Math.abs(structure.pos.x - source.pos.x), Math.abs(structure.pos.y - source.pos.y)) <= 1) || null;
}

function sourceLinkAt(room, mem, source, index) {
    const links = mem.plan && mem.plan.links;
    const planned = links && (index === 0 ? (links.src0 || links.src) : links.src1);
    const atPlan = structureAt(room, planned, STRUCTURE_LINK);
    if (atPlan && atPlan.my !== false) return atPlan;
    if (!source) return null;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === STRUCTURE_LINK &&
        structure.my !== false &&
        Math.max(Math.abs(structure.pos.x - source.pos.x), Math.abs(structure.pos.y - source.pos.y)) <= 1) || null;
}

function harvesterSourceIndex(memory, sources) {
    if (memory && memory.sourceId && Array.isArray(sources)) {
        const mapped = sources.findIndex((source) => source && source.id === memory.sourceId);
        if (mapped >= 0) return mapped;
    }
    if (memory && Number.isInteger(memory.sourceIdx) && sources && sources.length) {
        return Math.max(0, Math.min(memory.sourceIdx, sources.length - 1));
    }
    return -1;
}

function sourceWorkRequirement(source) {
    const settings = config.harvesting || {};
    const capacity = Math.max(1, Number(source && source.energyCapacity) || Number(settings.defaultCapacity) || 3000);
    const regeneration = Math.max(1, Number(settings.regenerationTicks) || 300);
    const harvestPower = Math.max(1, Number(settings.harvestPower) || 2);
    const maximum = Math.max(1, Number(settings.maxWorkPerSource) || 15);
    return Math.max(1, Math.min(maximum, Math.ceil(capacity / (regeneration * harvestPower))));
}

function harvesterStaticReady(room, mem, sources, index) {
    const source = sources && sources[index];
    if (!source) return false;
    return !!sourceContainer(room, mem, source, index) && !sourceLinkAt(room, mem, source, index);
}

function harvesterBody(room, mem, sources, index, cap) {
    const budget = Math.max(200, Number(cap) || room.energyCapacityAvailable || 200);
    if (budget >= 150 && harvesterStaticReady(room, mem, sources, index)) {
        return makeBody('staticHarvester', budget);
    }
    return makeBody('harvester', budget);
}

function harvesterDemand(room, mem, sources) {
    const bySource = [];
    let targetWork = 0;
    let actualWork = 0;
    for (let index = 0; index < (sources || []).length; index++) {
        const desired = harvesterBody(room, mem, sources, index, room.energyCapacityAvailable);
        const bodyTarget = bodyPartCount(desired, 'work');
        const target = sourceWorkRequirement(sources[index]);
        const assigned = assignedHomeHarvesters(room, index, sources);
        const work = assigned.reduce((sum, creep) => sum + bodyPartCount(creep.body, 'work'), 0);
        targetWork += target;
        actualWork += work;
        bySource.push({
            index,
            id: sources[index] && sources[index].id,
            targetWork: target,
            bodyTargetWork: bodyTarget,
            actualWork: work,
            deficit: Math.max(0, target - work),
            assigned: assigned.length,
            staticReady: harvesterStaticReady(room, mem, sources, index),
        });
    }
    return { targetWork, actualWork, deficit: Math.max(0, targetWork - actualWork), bySource };
}

function staticHarvesterSources(room, mem, sources) {
    let total = 0;
    for (let index = 0; index < (sources || []).length; index++) {
        if (harvesterStaticReady(room, mem, sources, index)) total++;
    }
    return total;
}

function harvesterTarget(room, mem, sources) {
    const roster = config.roster[room.controller.level] || {};
    const demand = harvesterDemand(room, mem, sources);
    const assignments = harvesterAssignmentStats(room, sources);
    let desired = 0;
    for (const item of demand.bySource) {
        const bodyWork = Math.max(1, item.bodyTargetWork);
        const stat = assignments[item.index] || { count: 0, work: 0 };
        const count = Math.max(0, stat.count || 0);
        if (!count) {
            desired += Math.max(1, Math.ceil(item.targetWork / bodyWork));
            continue;
        }
        const residual = Math.max(0, item.targetWork - Math.max(0, Number(stat.work) || 0));
        desired += count + Math.ceil(residual / bodyWork);
    }
    return Math.max(Number(roster.harvester || 0), coreHarvesterTarget(room, sources), desired);
}

function harvesterAssignmentStats(room, sources) {
    const stats = (sources || []).map(() => ({ count: 0, work: 0, spawning: 0 }));
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        seen.add(creep.name);
        // 孵化中的矿工要算在它的源上（与 countPlannedRole 一致）：它已经在 seen 里，下面 spawn.spawning 的循环不会再数它。
        // 旧写法这里 continue 掉，孵化那几十 tick 源显得"没人覆盖"，uncoveredSources 把生存档抬高，另一只空闲 spawn 再孵一只同源矿工；
        // 两只 TTL 只差几 tick，之后每代一起老死、一起被替换，成对永续（线上 2026-10-08：26 源 47 只 5W 矿工）
        if (!creep.spawning && creep.ticksToLive != null && creep.ticksToLive <= replaceLead(creep, 'harvester')) continue;
        const index = harvesterSourceIndex(creep.memory, sources);
        if (index < 0 || !stats[index]) continue;
        stats[index].count++;
        if (creep.spawning) stats[index].spawning++;
        stats[index].work += bodyPartCount(creep.body, 'work');
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || seen.has(spawn.spawning.name) || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory.home !== room.name || memory.role !== 'harvester') continue;
        const index = harvesterSourceIndex(memory, sources);
        if (index < 0 || !stats[index]) continue;
        stats[index].count++;
        stats[index].spawning++;
        stats[index].work += bodyPartCount(harvesterBody(room, (Memory.rooms && Memory.rooms[room.name]) || {}, sources, index,
            room.energyCapacityAvailable), 'work');
    }
    return stats;
}

/** 落地采集的源：没有容器也没有己方源 link，但有静态身体（平地每格 > mobileTicksPerTile tick）的矿工在岗——
 *  它不会往返送 spawn（roles/harvester.js），能量落在源旁等 hauler 捡，所以和有容器的源一样算搬运来源 */
function dropMinedSource(room, mem, source, index, sources) {
    if (sourceContainer(room, mem, source, index)) return false;
    const link = sourceLinkAt(room, mem, source, index);
    if (link && link.my) return false;
    const limit = Number(config.harvesting && config.harvesting.mobileTicksPerTile) || 3;
    return assignedHomeHarvesters(room, index, sources).some((creep) => bodyTicksPerTile(creep.body) > limit);
}

function hasHomeHaulingSource(room, mem, sources) {
    // 源产出经 link 进 storage 后，hauler 仍要从 storage 补给 spawn/ext；容器空了不能把编制清成 0
    if (links.hubHaulMode(room, (mem && mem.plan) || {}, sources)) return true;
    for (let index = 0; index < (sources || []).length; index++) {
        const source = sources[index];
        if (sourceContainer(room, mem, source, index) && assignedHomeHarvesters(room, index, sources).length > 0) return true;
        if (dropMinedSource(room, mem, source, index, sources)) return true;
    }
    const drops = room.find(FIND_DROPPED_RESOURCES).some((resource) =>
        resource.resourceType === RESOURCE_ENERGY && resource.amount >= 80);
    if (drops) return true;
    const tombstones = room.find(FIND_TOMBSTONES).some((tombstone) => tombstone.store[RESOURCE_ENERGY] >= 50);
    if (tombstones) return true;
    return !!(room.storage && room.storage.my && room.storage.store[RESOURCE_ENERGY] > 20000);
}

function assignedHomeHarvesters(room, sourceIdx, sources) {
    const out = [];
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (harvesterSourceIndex(creep.memory, sources) !== sourceIdx || creep.memory.dropMiner) continue;
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, 'harvester')) continue;
        out.push(creep);
    }
    return out;
}

function plannedSourcePathLength(room, mem, idx, source) {
    const roadKey = 'src' + idx;
    const planned = mem.plan && mem.plan.roads && mem.plan.roads[roadKey];
    if (planned) return packedPathLength(planned);
    const anchor = (room.find(FIND_MY_SPAWNS)[0] || { pos: new RoomPosition(25, 25, room.name) }).pos;
    return pathLength(anchor, source.pos, { range: 1, maxRooms: 1 });
}

function controllerLegLength(room, mem) {
    // 只有 ctrl link 能把 controller 供给交给基地侧；storage 本身不会把能量送到 controller 容器（RCL4 无 link），
    // 所以 hauler 仍要把大部分能量送到 controller 容器，往返里要算上这一段
    const plan = (mem && mem.plan) || {};
    const ctrlContainer = plan.containers && plan.containers.ctrl;
    if (!ctrlContainer) return 0;
    const linkSpot = layout.linkSpot(plan, 'ctrl');
    const ctrlLink = linkSpot ? structureAt(room, linkSpot, STRUCTURE_LINK) : null;
    if (ctrlLink && ctrlLink.my) return 0;
    // 升级者站在 storage 旁直接取能：hauler 只送到 storage，没有控制器段
    if (layout.controllerFedByStorage(room, plan)) return 0;
    if (plan.roads && plan.roads.ctrl) return packedPathLength(plan.roads.ctrl);
    const anchor = (room.find(FIND_MY_SPAWNS)[0] || { pos: new RoomPosition(25, 25, room.name) }).pos;
    return pathLength(anchor, new RoomPosition(ctrlContainer.x, ctrlContainer.y, room.name), { range: 1, maxRooms: 1 });
}

function averageHaulerCarry(room) {
    let total = 0;
    let n = 0;
    for (const creep of creepsHomeRole(room.name, 'hauler')) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (creep.spawning) continue;
        const ttl = creep.ticksToLive;
        if (ttl != null && ttl <= roleLead(creep, 'hauler')) continue;
        total += carryCapacity(creep.body);
        n++;
    }
    if (n > 0) return Math.max(50, Math.floor(total / n));
    return Math.max(50, carryCapacity(makeBody('hauler', room.energyCapacityAvailable)));
}

const HAUL_CARRY_CAPACITY = typeof CARRY_CAPACITY === 'number' ? CARRY_CAPACITY : 50;

function extensionCapacity(level) {
    return (typeof EXTENSION_ENERGY_CAPACITY !== 'undefined' && EXTENSION_ENERGY_CAPACITY[level]) || (level >= 8 ? 200 : level >= 7 ? 100 : 50);
}

/** config.hauling.sizing（缺项按默认）：core hauler 按 CARRY 定编的旋钮 */
function coreSizing() {
    const s = (config.hauling || {}).sizing || {};
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
        mode: s.mode === 'model' || s.mode === 'legacy' ? s.mode : 'measured',
        u: Math.max(0.2, Math.min(1, num(s.u, 0.75))),
        window: Math.max(1, num(s.window, 1500)),
        fallbackShare: Math.max(0, Math.min(1, num(s.fallbackShare, 0.5))),
        minBodyCarry: s.minBodyCarry || {},
        refillTicks: Math.max(1, num(s.refillTicks, 300)),
        refillTicksRich: Math.max(1, num(s.refillTicksRich, 150)),
        baseDistance: Math.max(1, num(s.baseDistance, 5)),
        shrinkEvery: Math.max(0, num(s.shrinkEvery, 1500)),
        shrinkMin: Math.max(1, num(s.shrinkMin, 2)),
        residualShare: Math.max(0, num(s.residualShare, 0.25)),
        upgradeCarryStep: Math.max(0, num(s.upgradeCarryStep, 0.25)),
        tempWaitTicks: Math.max(0, num(s.tempWaitTicks, 100)),
    };
}

function minBodyCarryFor(level, sizing) {
    const table = (sizing || coreSizing()).minBodyCarry;
    const value = Number(table && table[level]);
    return Math.max(1, Number.isFinite(value) && value > 0 ? value : 4);
}

/** storage → 补给点的几何（每 tick 每房一次）：ext = 已建 extension 与 spawn 到 storage 的平均切比雪夫距离——一座 extension 都没建时用
 *  方案里的 plan.ext，方案也没有时只看 spawn，连 spawn 都没有按 sizing.baseDistance；towers = 已建的塔（塔告急的临时编制用）。
 *  没有 storage 时距离是 0（补给直接从源容器来，源那一段已在模型的往返里） */
const refillGeometryCache = { time: -1, rooms: {} };
function refillGeometry(room, mem) {
    if (refillGeometryCache.time !== Game.time) { refillGeometryCache.time = Game.time; refillGeometryCache.rooms = {}; }
    const cached = refillGeometryCache.rooms[room.name];
    if (cached) return cached;
    const anchor = room.storage && room.storage.my !== false && room.storage.pos;
    const out = { ext: 0, extFrom: 'none', towers: [] };
    const dist = (pos) => (anchor ? Math.max(Math.abs(pos.x - anchor.x), Math.abs(pos.y - anchor.y)) : 0);
    let extSum = 0;
    let extN = 0;
    let spawnSum = 0;
    let spawnN = 0;
    for (const structure of room.find(FIND_MY_STRUCTURES)) {
        if (!structure || !structure.pos) continue;
        if (structure.structureType === STRUCTURE_EXTENSION) { extSum += dist(structure.pos); extN++; }
        else if (structure.structureType === STRUCTURE_SPAWN) { spawnSum += dist(structure.pos); spawnN++; }
        else if (structure.structureType === STRUCTURE_TOWER) out.towers.push(structure);
    }
    if (anchor) {
        out.extFrom = extN ? 'built' : 'plan';
        if (!extN) {
            for (const spot of (mem && mem.plan && mem.plan.ext) || []) {
                if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) { extSum += dist(spot); extN++; }
            }
            if (!extN) out.extFrom = 'spawn';
        }
        const n = extN + spawnN;
        if (n) out.ext = (extSum + spawnSum) / n;
        else { out.ext = coreSizing().baseDistance; out.extFrom = 'default'; }
    }
    refillGeometryCache.rooms[room.name] = out;
    return out;
}

/** 实测需求（mem.haulCtl.meas）：Memory.haulStats 里本房 hauler 桶两次 flush 之间的差分——送出能量减倒腾（out − churn）/ tick，
 *  与每趟忙碌 tick（(t − idle) / 出发次数）——按 hauler-tick 衰减（窗口 sizing.window）累进；C_meas = 送出/tick × 每趟忙碌 tick ÷ (50 × u)。
 *  外矿 hauler 在卸货房直接灌 ext 的量在 remoteHauler 桶里，不进这里。基线（ctl.base）在 haulStats 版本 / since 变了、差分为负（计数被清）时
 *  只重新定基线、不混算两份计数；已累积的估计保留（遥测换版本不是房间变了——退回满配一半会让 bodyImproves 把在岗的全换一遍）。
 *  累计观察满 window 个 hauler-tick 前 valid = false */
function measuredCoreNeed(room, mem, sizing) {
    const ctl = mem.haulCtl || (mem.haulCtl = {});
    const meas = ctl.meas || (ctl.meas = { out: 0, ticks: 0, busy: 0, dep: 0, n: 0 });
    const stats = typeof Memory !== 'undefined' ? Memory.haulStats : null;
    const bucket = stats && Number(stats.v) >= 1 && stats.rooms && stats.rooms[room.name] && stats.rooms[room.name].hauler;
    const flushAt = stats ? Number(stats.t) : NaN;
    if (bucket && Number.isFinite(flushAt)) {
        const snap = { v: stats.v, since: stats.since, at: flushAt, t: Number(bucket.t) || 0, idle: Number(bucket.idle) || 0,
            out: Number(bucket.out) || 0, churn: Number(bucket.churn) || 0, dep: Number(bucket.dep) || 0 };
        const base = ctl.base;
        if (!base || base.v !== snap.v || base.since !== snap.since) ctl.base = snap;
        else if (snap.at > base.at) {
            const d = { t: snap.t - base.t, idle: snap.idle - base.idle, out: snap.out - base.out, churn: snap.churn - base.churn, dep: snap.dep - base.dep };
            const dTicks = snap.at - base.at;
            ctl.base = snap;
            if (Object.values(d).every((value) => value >= 0) && d.idle <= d.t && d.churn <= d.out) {
                const decay = Math.pow(1 - 1 / sizing.window, d.t);
                meas.out = meas.out * decay + (d.out - d.churn);
                meas.ticks = meas.ticks * decay + dTicks;
                meas.busy = meas.busy * decay + (d.t - d.idle);
                meas.dep = meas.dep * decay + d.dep;
                meas.n = (Number(meas.n) || 0) + d.t;
                meas.at = Game.time;
            } else ctl.resets = (Number(ctl.resets) || 0) + 1;
        }
    }
    const flow = meas.ticks > 0 ? meas.out / meas.ticks : 0;
    const trip = meas.dep > 0 ? meas.busy / meas.dep : 0;
    const valid = meas.n >= sizing.window && meas.ticks > 0;
    return { valid, flow, trip, carry: valid ? flow * trip / (HAUL_CARRY_CAPACITY * sizing.u) : 0, n: meas.n };
}

/** 在编 core hauler 的 CARRY 合计（countPlannedRole 的口径：不算退役中的、寿命 ≤ 提前量的；算孵化中的——还没进 Game.creeps 的按 perBody 计）。
 *  用于"编制只数够了、CARRY 却差一截"的补差头（core:hauler:x）。carryCapacity 不数 0 血的 CARRY */
function plannedHaulerCarry(room, perBody) {
    let carry = 0;
    let heads = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(room.name, 'hauler')) {
        if (isRetiring(creep.memory)) continue;
        seen.add(creep.name);
        if (!creep.spawning) {
            const ttl = creep.ticksToLive;
            if (ttl != null && ttl <= replaceLead(creep, 'hauler')) continue;
        }
        carry += carryCapacity(creep.body || []) / HAUL_CARRY_CAPACITY;
        heads++;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        if (seen.has(spawn.spawning.name) || Game.creeps[spawn.spawning.name]) continue;
        const memory = Memory.creeps[spawn.spawning.name];
        if (memory.home === room.name && memory.role === 'hauler') { carry += Math.max(0, Number(perBody) || 0); heads++; }
    }
    return { carry, heads };
}

/** 给定 n 只 hauler，最小的每只 CARRY c 使 n·c ≥ C*(c)：C*(c) = max((flowA + flowB·c)/u, measA, burstA + burstB·c)。
 *  flowA/burstA 是满载在途的 CARRY（与身体大小无关），flowB/burstB 是停靠占用的 hauler 只数（一车越大、停得越多，所以乘 c），
 *  measA 是实测需求（已按每趟实测 tick 折算，与身体无关）。分母 ≤ 0 = 这么多只怎么大都不够 → Infinity */
function coreCarryNeed(terms, n) {
    let need = 0;
    if (terms.flowA > 0) {
        const den = n - terms.flowB / terms.u;
        need = Math.max(need, den > 0 ? (terms.flowA / terms.u) / den : Infinity);
    }
    if (terms.measA > 0) need = Math.max(need, terms.measA / n);
    if (terms.burstA > 0) {
        const den = n - terms.burstB;
        need = Math.max(need, den > 0 ? terms.burstA / den : Infinity);
    }
    return need;
}

function coreCarryAt(terms, c) {
    return {
        flow: (terms.flowA + terms.flowB * c) / terms.u,
        base: (terms.baseA + terms.baseB * c) / terms.u,
        measured: terms.measA,
        burst: terms.burstA + terms.burstB * c,
    };
}

/** 只数：从底线起，第一只数 n 使每只需要的 CARRY ≤ 满配；到上限还不够就封顶在 ceil、满配 */
function sizeCoreFleet(terms, full, floorHeads, ceilHeads) {
    const start = Math.max(1, floorHeads);
    const stop = Math.max(start, ceilHeads);
    for (let n = start; n <= stop; n++) {
        const need = coreCarryNeed(terms, n);
        if (need <= full + 1e-9) return { heads: n, need, capped: false };
    }
    return { heads: stop, need: coreCarryNeed(terms, stop), capped: true };
}

/** 每只身体的滞回（mem.haulCtl.per）：变大立即生效；变小要离上次改动 ≥ sizing.shrinkEvery tick 且至少小 shrinkMin 个 CARRY；
 *  RCL、hub 模式或定编模式（满配一半的兜底 → 实测）变了就按新的重算。方案随孵化花费 EMA / 实测漂移一两个 CARRY 时不来回改，
 *  换代（bodyImproves）也就不会被锯齿触发。决策记在 haulCtl.decisions（最近 10 条，私服生效断言看它） */
function sizeHysteresis(mem, want, ctx) {
    const ctl = mem.haulCtl || (mem.haulCtl = {});
    const regime = ctx.level + ':' + (ctx.hub ? 'hub' : '-') + ':' + ctx.mode;
    const prev = Number(ctl.per);
    let reason = null;
    if (!(prev > 0)) reason = 'init';
    else if (ctl.regime !== regime) reason = 'regime';
    else if (want > prev) reason = 'grow';
    else if (want <= prev - ctx.shrinkMin && Game.time - Number(ctl.perAt || 0) >= ctx.shrinkEvery) reason = 'shrink';
    if (reason) {
        const log = ctl.decisions || (ctl.decisions = []);
        log.push({ at: Game.time, per: want, prev: prev > 0 ? prev : null, reason, mode: ctx.mode, full: ctx.full, cstar: ctx.cstar });
        if (log.length > 10) log.shift();
        ctl.per = want;
        ctl.perAt = Game.time;
        ctl.regime = regime;
    } else if (want < prev) ctl.held = { at: Game.time, want, per: prev, n: (Number(ctl.held && ctl.held.n) || 0) + 1 };
    return Math.max(ctx.cMin, Math.min(ctx.full, Number(ctl.per)));
}

/**
 * core hauler 编制与每只的 CARRY（Memory.rooms[房].haulModel），按 CARRY 算、与在岗身体大小无关：
 *   模型（flow）：源产出 × 往返（link 链搬不走的部分）+ storage 富余回流 + 投递停靠（进 spawn/ext 的能量 = min(产出, 孵化花费)），
 *     另加 storage 补给（base，房里有 storage 时）：孵化花费里源直送不够的部分 max(0, 花费 − 产出) 从 storage 补——往返 = 2 × storage 到
 *     extension/spawn 的平均距离 + turnBuffer，另加停靠。hub 房（RCL7 store link + operator 站位）产出 0，整份花费都走这条；按利用率折算；
 *   实测（measured，sizing.mode 'measured'）：haulStats 的送出/tick × 每趟忙碌 tick ÷ (50 × sizing.u)（measuredCoreNeed）；
 *   补给爆发（burst，有 storage 时）：spawn/ext 被抽空后 refillTicks（storage 富余时 refillTicksRich）内补满整个容量；
 *   C* = max(模型, 实测, 补给爆发)。只数 = 从 RCL 底线（link 下调后）起、每只需要的 CARRY 不超过满配的最少只数（不超过 ceil）；
 *   每只 = clamp(ceil(C* ÷ 只数), minBodyCarry[RCL], 满配)，再过滞回（sizeHysteresis）。
 *   实测不可用（haulStats 没满一个窗口、容量 < 援建线 aid.untilCapacity 的小房、mode 'legacy'）时每只不低于满配的 sizing.fallbackShare（旧规则的一半）。
 * 以前：只数 = ceil(在途运量 / 在岗平均载量 / 0.8)，身体 = max(满配一半, 需要/只数)——hub 房模型是 0，两只都是半个满配（RCL7 16C8M）、
 * 空闲 60–89%；在岗身体越小只数越多（"靠堆人头"）。
 * 临时编制（+1 只，每只大小不变——临时项进了身体会被换代锁死成大身体）：塔告急（有武装敌人、塔低于维修储备）、spawn 等能量超过
 * sizing.tempWaitTicks 而 storage 里够补、某口源的容器 ≥ spillShare 满（搬不过来，与 roles/hauler.js 的溢出同一口径）。
 */
function estimateHomeHaulerTarget(room, mem, sources) {
    const level = room.controller.level;
    const floors = config.hauling && config.hauling.floor || {};
    const ceils = config.hauling && config.hauling.ceil || {};
    const floor = floors[level] != null ? floors[level] : 0;
    const ceil = ceils[level] != null ? ceils[level] : floor;
    if (level < 2) return floor;

    const hauling = config.hauling || {};
    const sizing = coreSizing();
    const turnBuffer = Number.isFinite(Number(hauling.turnBuffer)) ? Math.max(0, Number(hauling.turnBuffer)) : 2;
    const minRoundTrip = (config.hauling && config.hauling.minRoundTrip) || 6;
    const legShare = Math.max(0, Math.min(1, Number(config.hauling && config.hauling.controllerLegShare) || 0));
    const utilization = Math.max(0.2, Math.min(1, Number(config.hauling && config.hauling.utilization) || 1));

    if (!hasHomeHaulingSource(room, mem, sources)) return 0;
    const controllerLeg = legShare > 0 ? controllerLegLength(room, mem) : 0;
    let production = 0;
    let travel = 0;   // Σ 产出 × 往返：满载在途的能量
    let linkFed = 0;
    let overflow = false;
    // link 链能搬走多少产出：RCL7 的 store link 贴着 storage、且有 operator 站位（links.hubHaulMode 的口径）时源 link 的能量最终进 storage，
    // 整源不用 hauler；只有一座 store link 而没人倒（不贴 storage / 站位被占）时它满了就堵住，源 link 跟着堵、矿工溢进源容器——
    // 不能按 Infinity 算成 0 运量。RCL<7 只有 ctrl link 收货，链的吞吐 = 升级者实际 WORK（每 WORK 1/tick），且升级限流（utils.upgraderWorkCap）
    // 期间只按上限算——限流的升级者吃不完，源 link 按兵不动、矿工溢进源容器（第 6 轮 A/B：W31S8 升级 4.6/tick、两源 20/tick 被整源记成 0，
    // hauler 3→2 后源容器 0.6k→1.1k、投递占比 64%、空闲 2%）。src1 的 link 要 RCL6 起才发货（links.senderLinks）
    const plan = mem.plan || {};
    const hubStore = level >= 7 && links.storeLinkReady(room, plan) && links.operatorStation(room, plan) ? links.getLink(room, plan, 'store') : null;
    let linkBudget = hubStore ? Infinity
        : (links.getLink(room, plan, 'ctrl') ? Math.min(upgraderWork(room), utils.upgraderWorkCap(room, mem)) : 0);
    let linkDrain = 0;
    // 源容器溢出（临时编制）：与 roles/hauler.js 的溢出优先同一口径（≥ spillShare 满，2000 的 90% = 1800）；1500（sourceLinkOverflow）是 hub 房
    // 故意留着不搬的线，1500–1800 之间 hub 房的 hauler 已经会去搬，不算搬不过来
    const spillShare = Math.max(0, Math.min(1, Number(hauling.spillShare) || 0.9));

    for (let idx = 0; idx < sources.length; idx++) {
        const source = sources[idx];
        const container = sourceContainer(room, mem, source, idx);
        if (container && container.store) {
            const capacity = typeof container.store.getCapacity === 'function' ? Number(container.store.getCapacity(RESOURCE_ENERGY)) || 2000 : 2000;
            if (Number(container.store[RESOURCE_ENERGY] || 0) >= capacity * spillShare) overflow = true;
        }
        const sourceLink = sourceLinkAt(room, mem, source, idx);
        const linked = !!(sourceLink && sourceLink.my) && (idx === 0 || level >= 6);
        const haulable = !!container || dropMinedSource(room, mem, source, idx, sources);
        if (!linked && !haulable) continue;

        let work = 0;
        for (const creep of assignedHomeHarvesters(room, idx, sources)) work += bodyPartCount(creep.body, 'work');
        if (work <= 0) continue;

        let energyPerTick = Math.min(10, work * 2);
        if (linked) {
            const carried = Math.min(energyPerTick, linkBudget);
            linkBudget -= carried;
            linkDrain += carried;
            energyPerTick -= carried;
            if (energyPerTick < 1) { linkFed++; continue; }
            if (!haulable) continue;   // 溢出的产出没地方堆（矿工会停手），不算运量
        }
        production += energyPerTick;
        const oneWay = plannedSourcePathLength(room, mem, idx, source) + legShare * controllerLeg;
        const roundTrip = Math.max(minRoundTrip, oneWay * 2 + turnBuffer);
        travel += energyPerTick * roundTrip;
    }

    // storage 富余（滞回状态）且控制器由容器供能：storage → 控制器容器的回流也是运量（storageFeedRate/tick × 往返）——
    // 有专职 feeder（feederTarget > 0，短途）时这段由它跑，hauler 编制不再算
    const upgrading = config.upgrading || {};
    const ctrlSpot = mem.plan && mem.plan.containers && mem.plan.containers.ctrl;
    const storageRich = utils.storageRichState(room, mem, upgrading);
    if (storageRich && ctrlSpot && !layout.controllerFedByStorage(room, mem.plan || {}) && feederTarget(room, mem) === 0) {
        const oneWay = Math.max(1, Math.abs(room.storage.pos.x - ctrlSpot.x), Math.abs(room.storage.pos.y - ctrlSpot.y));
        const roundTrip = Math.max(minRoundTrip, oneWay * 2 + turnBuffer);
        travel += (Number(upgrading.storageFeedRate) || 20) * roundTrip;
    }

    // 投递停靠：进 spawn/extension 的能量每一格 extension 容量停一次、每停 deliveryStopTicks。进 spawn/ext 的量 = 孵化花费（spawnSpend，不是只在
    // 补货时采样的 spawnIncome——那是到货速率，实际花费的 1.4–3.4 倍）；源直送的是 min(产出, 花费)，其余（有 storage 时）从 storage 补
    // （第 3 轮 A/B：W33S8 两源 23–37 格、3 只 hauler 58% 采样在投递、源容器常满——一车 800 能量分 16 格投进 extension 的停靠没算）
    const extCap = extensionCapacity(level);
    const stopTicks = Math.max(0, Number(hauling.deliveryStopTicks) || 0);
    const spend = spawnSpendRate(room, mem);
    const share = production > 0 ? Math.max(0, Math.min(1, spend / production)) : 0;
    const storageFed = !!(room.storage && room.storage.my !== false);
    const geometry = refillGeometry(room, mem);
    const baseTrip = storageFed ? 2 * geometry.ext + turnBuffer : 0;
    const baseFlow = storageFed ? Math.max(0, spend - production) : 0;
    const refill = storageRich ? sizing.refillTicksRich : sizing.refillTicks;
    const cap = room.energyCapacityAvailable;
    const aidCapacity = Number((config.aid || {}).untilCapacity) || 0;
    const measure = sizing.mode === 'measured' ? measuredCoreNeed(room, mem, sizing) : null;
    // 实测可用：mode 'measured'、haulStats 满一个窗口、容量不低于援建线（小房有援建 hauler 混在同一个桶里，身体受容量限制也省不了几个 CARRY）
    const measured = !!(measure && measure.valid && cap >= aidCapacity);
    const mode = sizing.mode === 'model' ? 'model' : measured ? 'measured' : 'fallback';
    const terms = {
        u: utilization,
        flowA: (travel + baseFlow * baseTrip) / HAUL_CARRY_CAPACITY,
        flowB: stopTicks * (production * share + baseFlow) / extCap,
        baseA: baseFlow * baseTrip / HAUL_CARRY_CAPACITY,
        baseB: stopTicks * baseFlow / extCap,
        measA: measured ? measure.carry : 0,
        burstA: storageFed ? cap * baseTrip / (HAUL_CARRY_CAPACITY * refill) : 0,
        burstB: storageFed ? stopTicks * cap / (extCap * refill) : 0,
    };
    // link 供能的源不用 hauler 搬：每个己方源 link 把 RCL 底线减 linkFloorDrop，不低于 linkFloorMin（第 5 轮 A/B：RCL6 link 房被底线 3 撑着，34–71% 采样空闲）
    const linkDrop = Math.max(0, Number(hauling.linkFloorDrop) || 0);
    const linkMin = Math.max(0, Number(hubStore ? hauling.linkFloorMinStore : hauling.linkFloorMin) || 0);
    const effectiveFloor = linkFed > 0 && linkDrop > 0 ? Math.max(Math.min(floor, linkMin), floor - linkFed * linkDrop) : floor;
    const full = bodyPartCount(makeBody('hauler', cap), 'carry');
    const cMin = Math.max(1, Math.min(minBodyCarryFor(level, sizing), full));
    if (!(production > 0 || linkFed > 0 || storageFed)) {
        // 没有任何运量信号（还没有源容器/源 link/storage）：不写模型，身体按满配（coreHaulerCarry 的 need: null）
        delete mem.haulModel;
        return floor;
    }
    const fleet = sizeCoreFleet(terms, full, effectiveFloor, ceil);
    let want = Math.max(cMin, Math.min(full, Math.ceil(fleet.need - 1e-9)));
    // 兜底：实测不可用时每只不低于满配的 fallbackShare（旧规则）——模型没算的 storage→塔/工地、builder 投递靠它兜住，直到有实测
    if (mode === 'fallback' || sizing.mode === 'legacy') want = Math.max(want, Math.min(full, Math.ceil(full * sizing.fallbackShare)));
    const at = coreCarryAt(terms, want);
    const cstar = Math.max(at.flow, at.measured, at.burst);
    const perBody = sizeHysteresis(mem, want, { level, hub: !!hubStore, mode, full, cMin, cstar: Math.round(cstar * 10) / 10,
        shrinkEvery: sizing.shrinkEvery, shrinkMin: sizing.shrinkMin });
    const demand = cstar > 0 ? sizeCoreFleet(terms, full, 1, ceil).heads : 0;
    // 临时编制：只加 1 只（每只大小不变），条件消失后这只到期不再替补
    const towerReserve = Number(config.towerRepairReserve) || 500;
    const latch = mem.towerUrgent || {};
    const towerStress = geometry.towers.some((tower) => (tower.store && Number(tower.store[RESOURCE_ENERGY] || 0) < towerReserve) || Number(latch[tower.id]) > 0);
    const combat = towerStress && defense.armedHostiles(room).length > 0;
    const waiting = mem.spawnWaiting;
    const storageEnergy = storageFed ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
    const refillLag = !!(waiting && utils.spawnWaitingFor(room) && Game.time - Number(waiting.since) >= sizing.tempWaitTicks &&
        storageEnergy >= Number(waiting.cost) - room.energyAvailable);
    const temp = combat ? 'combat' : refillLag ? 'refill' : overflow ? 'overflow' : null;
    const heads = temp ? Math.min(Math.max(fleet.heads, ceil), fleet.heads + 1) : fleet.heads;
    if (temp) {
        // 遥测（决策事件）：临时编制按原因计 tick 数（haulModel.temp 是瞬时值，条件一过就清掉；私服生效断言看这里）
        const seen = mem.haulTemp || (mem.haulTemp = {});
        if (seen.at !== Game.time) { seen.at = Game.time; seen.why = temp; seen[temp] = (Number(seen[temp]) || 0) + 1; }
    }
    // 遥测（监控 / 私服探针）：模型分解，便于核对编制为什么是这个数
    // maxDeliveryTicks：本房见过的最大停靠项——孵化花费在 spawn 长期空闲时衰减到 0，期末瞬时值看不出停靠项是否生效过（私服验证靠它）
    const round = (value, k) => Math.round(value * k) / k;
    const deliveryTicks = stopTicks * share * perBody * HAUL_CARRY_CAPACITY / extCap;   // 每车（按方案身体）的停靠 tick
    const previous = mem.haulModel || {};
    mem.haulModel = {
        production, spawnShare: round(share, 100), deliveryTicks: round(deliveryTicks, 10),
        maxDeliveryTicks: Math.max(Number(previous.maxDeliveryTicks) || 0, round(deliveryTicks, 10)),
        carry: averageHaulerCarry(room), spend: round(spend, 100),
        // load：模型运量折合几只方案身体（利用率折算前）；demand：不看底线时方案要几只
        load: round((terms.flowA + terms.flowB * perBody) / Math.max(1, perBody), 100), demand, floor: effectiveFloor, linkFed, linkDrain,
        flow: round(at.flow, 10), base: round(at.base, 10), measured: round(at.measured, 10), burst: round(at.burst, 10),
        cstar: round(cstar, 10), want, perBody, heads: fleet.heads, temp, full, min: cMin, capped: fleet.capped, mode,
        meas: measure ? { n: Math.round(measure.n), flow: round(measure.flow, 100), trip: round(measure.trip, 10) } : null,
        dBase: round(geometry.ext, 10), extFrom: geometry.extFrom, refill, at: Game.time,
    };
    return heads;
}

/** core hauler 每只的 CARRY：haulModel 按 CARRY 算好的方案身体（estimateHomeHaulerTarget 每 tick 刷新，已过滞回），夹在 [minBodyCarry, 满配] 之间。
 *  没有 haulModel（还没有源容器/源 link/storage）时满配。孵化请求、换代目标（bodyPlan）与替补预留的计价都用它，三处尺寸一致 */
function coreHaulerCarry(room, mem) {
    const cap = room.energyCapacityAvailable;
    const full = bodyPartCount(makeBody('hauler', cap), 'carry');
    const level = room.controller && room.controller.level || 1;
    const minCarry = Math.max(1, Math.min(full, minBodyCarryFor(level)));
    const model = mem && mem.haulModel;
    if (!model || !(Number(model.perBody) > 0)) return { parts: full, full, need: null, heads: null, min: minCarry };
    const parts = Math.max(minCarry, Math.min(full, Math.ceil(Number(model.perBody))));
    return { parts, full, need: model.cstar != null ? model.cstar : null, heads: model.heads != null ? model.heads : null, min: minCarry };
}

/** makeBody('hauler') 按预算出 CC M 成对的身体：要 parts 个 CARRY 就给这个预算（奇数多一对 CM） */
function haulerBudgetForCarry(parts) {
    return Math.max(200, Math.floor(parts / 2) * 150 + (parts % 2 ? 100 : 0));
}

function coreHaulerBody(room, mem, budget) {
    const size = coreHaulerCarry(room, mem);
    return makeBody('hauler', Math.min(room.energyCapacityAvailable, haulerBudgetForCarry(size.parts), Math.max(150, budget)));
}

/** 大脑给出目标数量；游戏内只核对即时开采条件。孵化仍排在 opportunistic。 */
function mineralMinerTarget(room, mem) {
    const miner = require('roles_mineralMiner');
    const plan = miner.directive(room);
    return plan && plan.count === 1 && miner.ready(room, plan) ? 1 : 0;
}

/** 实验室搬运工（roles/labTech，移植 overmind-absorb 7f4ab27）：industry 的储备闸开着（canSpend：storage ≥ storageReserve、
 *  terminal ≥ terminalReserve——不开 labs 也不反应，装了货也白装）、房里 ≥ 3 个 lab、取送计划里有活时 1 只。
 *  和矿物钻机同样排在 opportunistic：矿物链不参与能量经济，买得起才孵。 */
function labTechTarget(room, mem) {
    const settings = config.industry || {};
    const count = Math.max(0, Math.floor(Number(settings.labTechs) || 0));
    if (!count || room.controller.level < 6) return 0;
    const industry = require('industry');
    if (!industry.canSpend(room)) return 0;
    let plan = null;
    try { plan = industry.labPlan(room); } catch (error) { plan = null; }
    if (!plan) return 0;
    return (plan.wants && plan.wants.length) || (plan.drains && plan.drains.length) ? count : 0;
}

/** labTech 身体：CARRY 一趟装满一个输入 lab（labFill / 50），MOVE 一半（基地内有路）；预算不够就减 CARRY */
function labTechBody(cap) {
    const fill = Math.max(50, Number((config.industry || {}).labFill) || 1000);
    return makeBody('labTech', cap, { carry: Math.ceil(fill / 50) });
}

/** upgrader 目标：底线 + 按 controller 供能容器存量 EMA 判断的富余人数（供给持续大于消耗才加） */
function upgraderTarget(room, mem) {
    const roster = config.roster[room.controller.level] || {};
    const base = Math.max(0, Number(roster.upgrader || 0));
    if (!base) return 0;
    const settings = config.upgrading || {};
    // storage 富余（滞回状态）时上限用 maxUpgradersRich：攒着的能量要花在升级上——但数量只按控制器容器实际到货的 EMA 加，
    // 不按 storage 水位（2026-09-06 A/B：按水位配出 44–48 WORK 站在能量 66–82 的容器旁只升 3.6–6/tick，升级者孵化 9.6 → 11.6/tick 白花）
    const storageRich = utils.storageRichState(room, mem, settings);
    const limits = (storageRich && settings.maxUpgradersRich) || settings.maxUpgraders || {};
    const storageEnergy = room.storage && room.storage.my !== false && room.storage.store ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0;
    // 控制器由 link 供能（ctrl link 已建成）：容器不由 hauler 喂，供给信号是 storage 水位（hauler 把 storage 的能量送进 link，几格短途，线上 W33S7 10 → 16 CP/tick）
    const ctrlLink = links.getLink(room, mem.plan || {}, 'ctrl');
    const linkFed = !!ctrlLink;
    const max = Math.max(base, Number(limits[room.controller.level]) || base);
    const supply = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
    // 升级限流（utils.upgraderWorkCap）生效时，每只身体已按全房上限配 WORK（upgraderBody 的 maxWork），
    // 多一只只会把 duty 摊薄——全房 WORK-tick 不变，第 2 只的身体白花（线上 W32S4/W34S7/W35S7：两只 W12、duty 0.5、CP ≤ 12）。
    // 限流期间数量按 上限 ÷ 每只 WORK 封顶、不加员；link 有货在这时说明的是"限流"，不是"供给富余"
    // 可持续供给（utils.upgraderSupplyWork）同样按 上限 ÷ 每只 WORK 封顶，且不随限流开关变：限流放开时旧规则 capCount = Infinity
    const supplyWork = utils.upgraderSupplyWork(room, mem);
    const workCap = Math.min(utils.upgraderWorkCap(room, mem), supplyWork == null ? Infinity : supplyWork);
    let capCount = Infinity;
    if (Number.isFinite(workCap)) {
        const perBody = Math.max(1, bodyPartCount(upgraderBody(room, mem, room.energyCapacityAvailable), 'work'));
        capCount = Math.max(base, Math.ceil(workCap / perBody));
    }
    supply.capCount = Number.isFinite(capCount) ? capCount : null;   // 遥测：限流期间的升级者数量上限
    const planned = mem.plan && mem.plan.containers && mem.plan.containers.ctrl;
    const container = structureAt(room, planned, STRUCTURE_CONTAINER);
    // 升级者由 storage 供能时看 storage：能量 / storageFullAt 视为"供给比例"（30k 以上算富余）
    const fedByStorage = layout.controllerFedByStorage(room, mem.plan || {});
    // 供能来源一个都没有才放弃：link 供能的房不需要容器（升级者直接从 link 取），
    // 旧写法要求容器存在，于是「有 ctrl link、没有 ctrl 容器」的房被整个挡在供给逻辑之外，
    // supply.at 永远是 -1、extra 恒为 0，升级者只能停在 roster 底线（私服 links 场景就是这样）
    if (!fedByStorage && !linkFed && (!container || !container.store)) {
        supply.extra = 0;
        return base;
    }
    // storage 低档：不加员（EMA 照常更新，退出低档后按富余再加）
    if (fedByStorage && upgraderLowMode(room, mem)) {
        supply.extra = 0;
    }
    if (supply.at !== Game.time) {
        let ratio;
        let src;
        if (fedByStorage) {
            src = 'storage';
            const fullAt = Math.max(1, Number(settings.storageFullAt) || 30000);
            ratio = Math.max(0, Math.min(1, Number(room.storage.store[RESOURCE_ENERGY] || 0) / fullAt));
        } else {
            src = 'container';
            if (container && container.store) {
                const capacity = Math.max(1, Number(container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 0) || 2000);
                ratio = Math.max(0, Math.min(1, Number(container.store[RESOURCE_ENERGY] || 0) / capacity));
            } else {
                ratio = 0;   // link 供能且没有容器：容器这一路没有信号，下面看 link
            }
            // 容器供能房不再把 storage 水位当供给（A/B：配出的升级者没人喂）；link 供能房才看 storage
            if (linkFed) {
                // 控制器由 link 供能时，那个容器**根本没人用**（升级者直接从 link 取），拿它的存量当供给信号恒为 0。
                // 线上 W33S7：控制器容器 40/40 次采样都是 0、storage 8–12k ⇒ ratio ≤ 0.4，raiseAbove 0.7 在算术上不可达，
                // 于是 RCL5 的母房常年只有 1 只 16 WORK 的升级者、CP 卡在它的物理上限 96%，而 spawn 收入 EMA 是 56/tick。
                // 真正的供给是 link 自己：它有货就说明喂得上（同一批采样里 32/40 次非空，均值 409/800）。
                // 加员后若喂不动，link 空的比例上升、EMA 跌回 lowerBelow 以下会自动减员，滞回兜底。
                const linkEnergy = ctrlLink && ctrlLink.store ? Number(ctrlLink.store[RESOURCE_ENERGY] || 0) : 0;
                if (linkEnergy > 0) { ratio = 1; src = 'link'; }
                if (storageEnergy > 0) {
                    const fullAt = Math.max(1, Number(settings.storageFullAt) || 30000);
                    const fromStorage = Math.min(1, storageEnergy / fullAt);
                    if (fromStorage > ratio) { ratio = fromStorage; src = 'storage'; }
                }
            }
        }
        const alpha = Math.max(0.001, Math.min(1, Number(settings.alpha) || 0.02));
        supply.ema = supply.at < 0 ? ratio : supply.ema + alpha * (ratio - supply.ema);
        // 峰值：EMA 会随供给中断衰减回去，事后只看瞬时值分不出「从来没供上」和「供过又断了」
        supply.emaMax = Math.max(Number(supply.emaMax) || 0, supply.ema);
        supply.src = src;   // 驱动本次采样的信号来源：container / link / storage（遥测 + 生效断言的观察面）
        supply.at = Game.time;
        const interval = Math.max(0, Number(settings.changeInterval) || 0);
        const canChange = supply.changedAt < 0 || Game.time - supply.changedAt >= interval;
        const raiseAbove = Number(settings.raiseAbove) || 0.7;
        const lowerBelow = Number(settings.lowerBelow) || 0.15;
        if (canChange && supply.ema >= raiseAbove && room.energyAvailable >= room.energyCapacityAvailable && base + supply.extra < Math.min(max, capCount)) {
            supply.extra++;
            supply.changedAt = Game.time;
        } else if (canChange && supply.ema <= lowerBelow && supply.extra > 0) {
            supply.extra--;
            supply.changedAt = Game.time;
        }
    }
    return Math.min(max, capCount, base + Math.max(0, supply.extra));
}

/** storage 到控制器容器的格距（feeder 是否算"短途"、以及它的 CARRY 数都看它） */
function feederDistance(room, ctrlSpot) {
    return Math.max(1, Math.abs(room.storage.pos.x - ctrlSpot.x), Math.abs(room.storage.pos.y - ctrlSpot.y));
}

/** 专职短途搬运工（roles/feeder.js）：storage 富余（滞回状态开）、控制器由容器供能（容器已建成、没有 ctrl link、不是 storage 站位）、
 *  storage 到控制器容器 ≤ upgrading.feederMaxDistance 格 → upgrading.feeders 只；否则 0。
 *  第 2 轮 A/B：兜底取货修正后 W33S8 不再溢出但 storage 攒到 17 万花不掉——hauler 永远有源容器可取，6 格外的 storage → 控制器一次也轮不到 */
function feederTarget(room, mem) {
    const settings = config.upgrading || {};
    const count = Math.max(0, Math.floor(Number(settings.feeders) || 0));
    if (!count || !room.storage || room.storage.my === false || !room.storage.store) return 0;
    const plan = mem.plan || {};
    const ctrlSpot = plan.containers && plan.containers.ctrl;
    if (!ctrlSpot || layout.controllerFedByStorage(room, plan) || links.getLink(room, plan, 'ctrl')) return 0;
    if (!structureAt(room, ctrlSpot, STRUCTURE_CONTAINER)) return 0;
    if (feederDistance(room, ctrlSpot) > (Number(settings.feederMaxDistance) || 15)) return 0;
    return utils.storageRichState(room, mem, settings) ? count : 0;
}

/** 枢纽搬运工：RCL7、store link 贴着 storage、至少一口源已接入这条链 → hauling.operators 只。
 *  recovering 也要留着：store link 满了整条采集链停转。 */
function operatorTarget(room, mem) {
    const settings = config.hauling || {};
    const count = Math.max(0, Math.floor(Number(settings.operators) || 0));
    if (!count || !room.controller || room.controller.level < 7) return 0;
    const plan = (mem && mem.plan) || {};
    if (!links.storeLinkReady(room, plan)) return 0;
    const sources = layout.resolveSources(room, mem, plan);
    for (let index = 0; index < (sources || []).length; index++) {
        if (links.sourceFedToStore(room, plan, sources[index], index)) return count;
    }
    return 0;
}

/** 8C1M（450）；预算不够 operatorMinCarry 就不孵，避免缩成 2C 堵着编制 */
function operatorBody(room, mem, cap) {
    const settings = config.hauling || {};
    const carry = Math.max(1, Math.min(16, Number(settings.operatorCarry) || 8));
    const body = makeBody('operator', cap, { carry });
    const minCarry = Math.max(1, Number(settings.operatorMinCarry) || 4);
    return bodyPartCount(body, 'carry') >= minCarry && bodyCost(body) <= cap ? body : [];
}

/** feeder 身体：CARRY = feederRate × 往返格数 / 50（4–16），MOVE 一半（基地内有路） */
function feederBody(room, mem, cap) {
    const settings = config.upgrading || {};
    const ctrlSpot = mem.plan && mem.plan.containers && mem.plan.containers.ctrl;
    const distance = ctrlSpot && room.storage ? feederDistance(room, ctrlSpot) : 6;
    const carry = Math.max(4, Math.min(16, Math.ceil((Number(settings.feederRate) || 20) * (distance * 2 + 4) / 50)));
    const body = makeBody('feeder', cap, { carry });
    // 预算不够 feederMinCarry 个 CARRY：返回空身体让队列等（缩身孵出的 2C1M feeder 700 tick 只搬 900，占着编制不顶用）
    return bodyPartCount(body, 'carry') >= Math.max(1, Number(settings.feederMinCarry) || 4) && bodyCost(body) <= cap ? body : [];
}

function targetFor(room, role, mem, sources, backlog) {
    const state = roomState(room, mem, sources);
    const roster = config.roster[room.controller.level] || {};
    if (state.recovering && role !== 'harvester' && role !== 'hauler' && role !== 'operator') return 0;
    if (role === 'harvester') return harvesterTarget(room, mem, sources);
    if (role === 'hauler') return estimateHomeHaulerTarget(room, mem, sources);
    if (role === 'upgrader') return upgraderTarget(room, mem);
    if (role === 'builder') return builderTarget(room, backlog || constructionBacklog(room));
    if (role === 'feeder') return feederTarget(room, mem);
    if (role === 'operator') return operatorTarget(room, mem);
    if (role === 'mineralMiner') return mineralMinerTarget(room, mem);
    if (role === 'labTech') return labTechTarget(room, mem);
    if (role === 'scout') {
        if (room.controller.level < 4) return 0;
        // 外部大脑在位时情报由 HTTP API 提供，scout 默认退役；指令可用 scouts 字段显式保留
        const external = brain.directive(room.name);
        if (external) return Math.max(0, Number(external.scouts || 0));
    }
    return roster[role] || 0;
}

function recoverySpawnReserve(room) {
    const settings = config.recovery || {};
    const configured = settings.spawnReserve == null ? settings.emergencyHarvestBelow : settings.spawnReserve;
    const reserve = Number(configured);
    if (!Number.isFinite(reserve) || reserve <= 0) return 0;
    const capacity = Number(room && room.energyCapacityAvailable);
    return Number.isFinite(capacity) && capacity > 0 ? Math.min(reserve, capacity) : reserve;
}

function assignHarvesterSource(room, mem, assignedNow, sources) {
    const stats = harvesterAssignmentStats(room, sources);
    const demand = harvesterDemand(room, mem, sources).bySource;
    for (const idx in assignedNow || {}) {
        if (!stats[idx]) stats[idx] = { count: 0, work: 0 };
        stats[idx].count += assignedNow[idx];
        stats[idx].work += assignedNow[idx] * Math.max(1, bodyPartCount(harvesterBody(room, mem, sources, Number(idx), room.energyCapacityAvailable), 'work'));
    }
    const n = (sources && sources.length) || 1;
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
        const item = demand[i] || { targetWork: sourceWorkRequirement(sources[i]), bodyTargetWork: 1 };
        const stat = stats[i] || { count: 0, work: 0 };
        const requiredCount = Math.max(1, Math.ceil(item.targetWork / Math.max(1, item.bodyTargetWork)));
        const countDeficit = Math.max(0, requiredCount - stat.count);
        const workDeficit = Math.max(0, item.targetWork - stat.work);
        const score = countDeficit * 100000 + workDeficit * 100 - stat.count;
        if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
}

function matchesDemand(memory, item) {
    if (!memory || memory.home !== item.memory.home || memory.role !== item.role) return false;
    // 援建槽位只认 slotKey：弱房自己孵的小矿工绑着同一个源，不能算填了援建的位
    if (item.memory.aid) return memory.slotKey === item.slot;
    if (memory.slotKey) return memory.slotKey === item.slot;
    if (memory.remoteRoom !== item.memory.remoteRoom) return false;
    if (item.memory.sourceId && memory.sourceId !== item.memory.sourceId) return false;
    if (item.memory.haulSlot != null && memory.haulSlot !== item.memory.haulSlot) return false;
    return true;
}

function countPlannedDemand(room, item) {
    let count = 0;
    const seen = new Set();
    for (const creep of creepsHomeRole(item.memory.home, item.role)) {   // matchesDemand 要求 home+role 全等
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (!matchesDemand(creep.memory, item)) continue;
        seen.add(creep.name);
        if (creep.spawning) { count++; continue; }
        if (creep.ticksToLive != null && creep.ticksToLive <= item.lead) continue;
        count++;
    }
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning || !Memory.creeps || !Memory.creeps[spawn.spawning.name]) continue;
        if (seen.has(spawn.spawning.name) || Game.creeps[spawn.spawning.name]) continue;
        if (matchesDemand(Memory.creeps[spawn.spawning.name], item)) count++;
    }
    return count;
}

function bodyPlan(room, role, mem, source, sourceIdx) {
    if (!room || !room.energyCapacityAvailable) return [];
    // mem 不传就自己取：升级者的 storage 低档滞回、矿工的静态就绪都记在房间 Memory 里，拿空对象算出来的身体会和孵化请求那条路径打架
    mem = mem || layout.roomMem(room);
    if (role === 'harvester') {
        const sources = Array.isArray(source) ? source : source ? [source] : [];
        const index = Array.isArray(source) ? (sourceIdx || 0) : 0;
        return harvesterBody(room, mem, sources, index, room.energyCapacityAvailable);
    }
    if (role === 'upgrader') return upgraderBody(room, mem, room.energyCapacityAvailable);
    // hauler 的换代目标与孵化请求同一个尺寸（coreHaulerBody）：按满容量比会把按需孵的 hauler 当成小身体反复换掉
    if (role === 'hauler') return coreHaulerBody(room, mem, room.energyCapacityAvailable);
    return makeBody(role, room.energyCapacityAvailable);
}

/** 升级者是否处于 storage 低档（只对 storage 供能的房有意义）：< lowBelow 进入，≥ lowExitAbove 退出，状态记在 mem.upgradeSupply.low */
function upgraderLowMode(room, mem) {
    // 编制（数量）只在"升级者由 storage 供能"的房里按 storage 水位降档：link 供能的房供给信号不是 storage。
    // 升级者的**取能上限**用的是 utils.upgradeBudgetLow（对两种供能方式都生效），见 upgraderBody 的 maxWork。
    // 这里不动 mem.upgradeSupply.low：那份滞回状态由 utils.upgradeBudgetLow 独占，两边都写会把滞回抹掉。
    if (!layout.controllerFedByStorage(room, mem.plan || {})) return false;
    return utils.upgradeBudgetLow(room, mem);
}

/** 本房升级者当前的 WORK 总数：实现搬到 utils（升级限流也要用同一份），这里保留名字给本模块内部调用 */
function upgraderWork(room) {
    return utils.upgraderWork(room);
}

/** link 链送到控制器的供给需要多少 WORK 才吃得完：ctrl link 已建成且属于我方时，每个送能的源 link（links.senderLinks：RCL5 只有 src0，
 *  RCL6 起加 src1）按一个源的产出 capacity/regeneration（3000/300 = 10/tick，link 传输损耗 3% 忽略）计。每 tick 每房算一次 */
const linkFedWorkCache = { time: -1, rooms: {} };
function linkFedWork(room, mem) {
    if (linkFedWorkCache.time !== Game.time) { linkFedWorkCache.time = Game.time; linkFedWorkCache.rooms = {}; }
    if (linkFedWorkCache.rooms[room.name] != null) return linkFedWorkCache.rooms[room.name];
    const plan = mem && mem.plan;
    let work = 0;
    if (plan && links.getLink(room, plan, 'ctrl')) {
        const settings = config.harvesting || {};
        const perSource = Math.ceil((Number(settings.defaultCapacity) || 3000) / Math.max(1, Number(settings.regenerationTicks) || 300));
        work = links.senderLinks(room, plan).length * perSource;
    }
    linkFedWorkCache.rooms[room.name] = work;
    return work;
}

/** 升级者身体：storage 低档只花 lowBudget，但至少要吃得完 link 链的供给（linkFedWork × 100 + 2C1M）；RCL8 以下不封顶 15 WORK（引擎 15/tick 上限只在 RCL8）。
 *  孵化请求与换代判断都用它，避免两边不一致造成换代抖动 */
function upgraderBody(room, mem, budget) {
    const settings = config.upgrading || {};
    const cap = room.energyCapacityAvailable;
    let allowance = Math.min(cap, Math.max(200, Number(budget) || cap));
    if (upgraderLowMode(room, mem)) {
        // 低档预算下限：W4 的 550 吃不完 ctrl link 的 10/tick，src link 与 ctrl link 会一起堵在满仓，免费供给白白浪费（线上 2026-09-05 W33S7 升级 16 → 4/tick）
        allowance = Math.min(allowance, Math.max(200, Number(settings.lowBudget) || 550, utils.upgraderBudgetForWork(linkFedWork(room, mem))));
    }
    // 身体按可持续供给封顶（utils.upgraderSupplyWork：本地供给 + storage 富余摊到一只升级者的寿命），不按瞬时限流（utils.upgraderWorkCap）：
    // 限流有竞争需求时是 W12、一放开就是 Infinity，旧代码跟着它孵 W12 / W47 来回换代（线上 2026-10-08：放开就孵 W47C2M1 4850，
    // CP 却被 ctrl link 的 20/tick 卡死）。限流期间多出的 WORK 由 roles/upgrader.js 按 duty 降频，身体只多花 (20−12)×100/1500 ≈ 0.5/tick
    const rclMax = room.controller && room.controller.level >= 8 ? 15 : 50;
    const supplyWork = utils.upgraderSupplyWork(room, mem);
    const maxWork = supplyWork == null ? rclMax : Math.min(rclMax, supplyWork);
    if (supplyWork != null && mem && supplyWork < rclMax && Math.floor((allowance - 150) / 100) > supplyWork) {
        // 遥测（私服生效断言 spawn.upgraderSupplyCap）：容量本来能出更多 WORK、被供给封顶的那次（每 tick 至多记一次）
        const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
        const seen = track.sizeCap;
        if (!seen || seen.at !== Game.time) {
            track.sizeCap = { at: Game.time, cap: supplyWork, would: Math.min(rclMax, 47, Math.floor((allowance - 150) / 100)), n: (Number(seen && seen.n) || 0) + 1 };
        }
    }
    return makeBody('upgrader', allowance, { maxWork });
}

/** 在编升级者的 WORK（口径同 countPlannedRole：不算退役中的、不算已进替补提前量的，算孵化中的） */
function plannedUpgraderWork(room) {
    let work = 0;
    for (const creep of creepsHomeRole(room.name, 'upgrader')) {
        if (isRetiring(creep.memory)) continue;
        const ttl = creep.ticksToLive;
        if (!creep.spawning && ttl != null && ttl <= replaceLead(creep, 'upgrader')) continue;
        work += bodyPartCount(creep.body, 'work');
    }
    return work;
}

function bodyImproves(creep, desired, role) {
    const currentCost = bodyCost(creep.body || []);
    const desiredCost = bodyCost(desired || []);
    if (role === 'harvester') {
        // 采集位吞吐由 WORK 决定，且静态/移动模式切换必须立即执行（容器/link 就绪）
        if (bodyPartCount(desired, 'work') > bodyPartCount(creep.body, 'work')) return true;
        const desiredStatic = bodyPartCount(desired, 'carry') === 0;
        const currentStatic = bodyPartCount(creep.body, 'carry') === 0;
        return desiredStatic !== currentStatic;
    }
    if (role === 'hauler') {
        // 方案身体随孵化花费 EMA、storage 富余状态缓慢漂移（±1–2 CARRY）：差这点就换代只是把快到期的旧身体提前回收、多占一次 spawn。
        // 至少大 upgradeCarryStep（25%）且 ≥ 2 个 CARRY 才换；小于方案的零收入缩身 hauler（2C 对 4C 起）照常换
        const have = bodyPartCount(creep.body, 'carry');
        const step = Math.max(2, Math.ceil(have * coreSizing().upgradeCarryStep));
        if (bodyPartCount(desired, 'carry') < have + step) return false;
    }
    if (role === 'upgrader') {
        // 升级者：现有 WORK 不到方案身体的 upgradeWorkShare 才换（W12 → W20 等自然换代；W4 低档小身体 → W20 照常换）
        const share = Math.max(0, Math.min(1, Number((config.upgrading || {}).upgradeWorkShare) || 0.5));
        if (bodyPartCount(creep.body, 'work') >= bodyPartCount(desired, 'work') * share) return false;
    }
    if (desiredCost <= currentCost) return false;
    // 提前换代会白白丢掉旧身体剩余寿命对应的成本（suicide 不退款）：只有新身体的增量成本 ≥ 这份浪费才值得，
    // 否则等自然换代。这样 RCL1→2 的小身体会尽早换，而每 +50 容量就整队重造的抖动被挡住
    const lifeTime = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    const ttl = creep.ticksToLive == null ? lifeTime : creep.ticksToLive;
    const waste = currentCost * ttl / lifeTime;
    return desiredCost - currentCost >= waste;
}

function hasPendingBodyUpgrade(room, creep) {
    const memory = creep.memory || {};
    const replacement = memory.bodyUpgradePending;
    if (!replacement) return false;
    if (Game.creeps && Game.creeps[replacement]) return true;
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (spawn.spawning && spawn.spawning.name === replacement) return true;
    }
    if (Memory.creeps && Memory.creeps[replacement]) return true;
    const at = Number(memory.bodyUpgradeAt || 0);
    if (at && Game.time - at < BODY_UPGRADE_COOLDOWN) return true;
    delete memory.bodyUpgradePending;
    delete memory.bodyUpgradeAt;
    return false;
}

function upgradeRoleEnabled(room, state, role, mem, sources) {
    if (role === 'harvester') return true;
    if (role === 'upgrader') return !state.recovering && (config.roster[room.controller.level] || {}).upgrader > 0;
    if (role === 'builder') return hasBuilderWork(room);
    if (role === 'hauler') return estimateHomeHaulerTarget(room, mem, sources) > 0;
    return false;
}

/** 源上已由“当前理想身板”提供的 WORK（含孵化中的替换者）。源需求一旦被新身板覆盖，
 *  该源其余旧 creep 不再换代——它们的 WORK 已是多余的，换成大身板只是把能量烧在 spawn 上
 *  （线上 W34S7：5 只 2W 矿工在容量升到 550 后被逐只换成 4W，20 WORK 对着 10 WORK 的需求）。 */
function modernHarvesterWork(room, sources, sourceIdx, desired) {
    const desiredWork = bodyPartCount(desired, 'work');
    const desiredStatic = bodyPartCount(desired, 'carry') === 0;
    let work = 0;
    for (const creep of creepsHomeRole(room.name, 'harvester')) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        const memory = creep.memory;
        if (memory.dropMiner) continue;
        if (harvesterSourceIndex(memory, sources) !== sourceIdx) continue;
        const creepWork = bodyPartCount(creep.body, 'work');
        if (creepWork < desiredWork || (bodyPartCount(creep.body, 'carry') === 0) !== desiredStatic) continue;
        work += creepWork;
    }
    return work;
}

function bodyUpgradeCandidates(room, state, mem, sources) {
    if (state.recovering || state.readyWorkers <= 0) return [];
    const candidates = [];
    for (const creep of creepsHome(room.name)) {
        const role = creep.memory.role;
        if (!BODY_UPGRADE_ROLES.includes(role) || creep.spawning) continue;
        if (creep.memory.dropMiner || hasPendingBodyUpgrade(room, creep)) continue;
        if (!upgradeRoleEnabled(room, state, role, mem, sources)) continue;
        let sourceIdx = Number.isInteger(creep.memory.sourceIdx) ? creep.memory.sourceIdx : 0;
        if (role === 'harvester' && creep.memory.sourceId) {
            const mapped = sources.findIndex((source) => source && source.id === creep.memory.sourceId);
            if (mapped >= 0) sourceIdx = mapped;
        }
        // 升级者身体要带 mem：低档滞回状态在 mem.upgradeSupply.low 里，不带的话 storage 一过 lowBelow 就想换满身体，与孵化请求那条路径打架
        const desired = role === 'harvester' ? harvesterBody(room, mem, sources, sourceIdx, room.energyCapacityAvailable) :
            bodyPlan(room, role, mem);
        const desiredCost = bodyCost(desired);
        const currentCost = bodyCost(creep.body || []);
        if (!desired.length || !bodyImproves(creep, desired, role)) continue;
        if (role === 'harvester' && sources && sources[sourceIdx] &&
            modernHarvesterWork(room, sources, sourceIdx, desired) >= sourceWorkRequirement(sources[sourceIdx])) continue;
        const ttl = creep.ticksToLive == null ? 1500 : creep.ticksToLive;
        if (creep.ticksToLive != null && ttl <= roleLead(creep, role)) continue;
        const priority = role === 'harvester' ? 100 : role === 'hauler' ? 80 : role === 'upgrader' ? 60 : 40;
        const urgency = Math.max(0, 1500 - ttl) / 20;
        const deficit = Math.max(0, desiredCost - currentCost) / 10 +
            Math.max(0, bodyPartCount(desired, 'work') - bodyPartCount(creep.body, 'work')) * 2;
        candidates.push({ creep, role, desired, desiredCost, score: priority + urgency + deficit });
    }
    return candidates.sort((left, right) => right.score - left.score || left.creep.name.localeCompare(right.creep.name));
}

function tryBodyUpgrade(room, spawn, state, mem, sources, energyBudget) {
    const candidates = bodyUpgradeCandidates(room, state, mem, sources);
    for (const candidate of candidates) {
        if (candidate.desiredCost > energyBudget) continue;
        const name = creepName(candidate.role, 'upgrade');
        const memory = Object.assign({}, candidate.creep.memory, {
            home: room.name,
            role: candidate.role,
            bodyPlanCost: candidate.desiredCost,
            replaces: candidate.creep.name,
            bodyGeneration: Number(candidate.creep.memory.bodyGeneration || 0) + 1,
        });
        delete memory.dropMiner;
        delete memory.bodyUpgradePending;
        delete memory.bodyUpgradeAt;
        if (candidate.role === 'harvester' && bodyPartCount(candidate.desired, 'carry') === 0) memory.staticMiner = true;
        else delete memory.staticMiner;
        const ret = spawn.spawnCreep(candidate.desired, name, spawnOptions(spawn, memory));
        if (ret === OK) {
            recordSpawnSpend(room, mem, candidate.desiredCost);
            candidate.creep.memory.bodyUpgradePending = name;
            candidate.creep.memory.bodyUpgradeAt = Game.time;
            return { cost: candidate.desiredCost, name, replaces: candidate.creep.name };
        }
        if (ret !== ERR_BUSY && ret !== ERR_NOT_ENOUGH_ENERGY) {
            logErr('spawn.bodyUpgrade ' + room.name, new Error('spawnCreep ' + ret + ' ' + candidate.role));
        }
    }
    return null;
}

function retireReplaced(creep) {
    if (!creep || !creep.memory || creep.spawning) return false;
    // 退役中：每 tick 走向最近的 spawn 回收（retire.js），不再干活
    if (creep.memory.bodyUpgradeRetiring) { retire.retireAtSpawn(creep); return true; }
    const replacementName = creep.memory.bodyUpgradePending;
    if (!replacementName) return false;
    const replacement = Game.creeps && Game.creeps[replacementName];
    if (!replacement || replacement.spawning || replacement.hits === 0) return false;
    // 外矿 creep 的交接：替换者走到外矿房之前旧的继续干活（源少空几十 tick），最多等 upgradeHandover tick
    const remoteRoom = creep.memory.remoteRoom;
    if (remoteRoom && replacement.room && replacement.room.name !== remoteRoom) {
        const handover = Number(queueSettings().upgradeHandover) || 0;
        if (Game.time - Number(creep.memory.bodyUpgradeAt || 0) < handover) return false;
    }
    creep.memory.bodyUpgradeRetiring = true;
    retire.retireAtSpawn(creep);
    return true;
}

function writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets) {
    const backlog = builderBacklog || constructionBacklog(room);
    const sources = layout.resolveSources(room, mem, mem.plan);
    const harvest = harvesterDemand(room, mem, sources);
    const demand = mem.demand || {};
    demand.at = Game.time;
    demand.targets = Object.assign({}, targets);
    demand.planned = Object.assign({}, plannedCounts);
    demand.builderBacklog = backlog.weighted;
    demand.builderBacklogDetail = {
        raw: backlog.raw,
        weighted: backlog.weighted,
        sites: backlog.sites,
        byType: Object.assign({}, backlog.byType),
    };
    demand.harvesterWork = harvest.actualWork;
    demand.harvesterWorkTarget = harvest.targetWork;
    demand.harvesterWorkDeficit = harvest.deficit;
    demand.harvesterBySource = harvest.bySource;
    demand.harvesterWorkMax = harvest.targetWork;
    demand.harvesterStaticSources = staticHarvesterSources(room, mem, sources);
    demand.sourceCount = (sources || []).length;
    demand.haulerTarget = targets.hauler || 0;
    demand.upgradeSupply = mem.upgradeSupply ? {
        ema: Math.round(Number(mem.upgradeSupply.ema || 0) * 100) / 100,
        extra: Number(mem.upgradeSupply.extra || 0),
    } : null;
    demand.remote = (remoteDemands || []).length;
    mem.demand = demand;
    if (state) {
        state.builderTarget = targets.builder || 0;
        state.builderBacklog = backlog.weighted;
        // 塔够不到的维修债（血）与结构数：builder 编制的需求侧之一（线上排查"路在烂但没 builder"时看这个）
        const outOfReach = outOfTowerRepair(room);
        state.builderRepairDebt = outOfReach.debt;
        state.builderOutOfReach = outOfReach.count;
    }
}

function residualHarvesterBody(room, mem, sources, index, cap, workNeeded) {
    const budget = Math.max(0, Number(cap) || 0);
    if (budget < 150) return [];
    const desired = harvesterBody(room, mem, sources, index, Math.max(200, budget));
    const maxWork = Math.max(1, bodyPartCount(desired, 'work'));
    const requested = Math.max(1, Math.min(maxWork, Math.ceil(Number(workNeeded) || 1)));
    const staticMode = harvesterStaticReady(room, mem, sources, index);
    for (let work = requested; work >= 1; work--) {
        if (staticMode) {
            const minimum = work * 100 + 50;
            if (minimum > budget) continue;
            const move = Math.max(1, Math.min(Math.ceil(work / 2), Math.floor((budget - work * 100) / 50)));
            if (work * 100 + move * 50 <= budget) return repeat('work', work).concat(repeat('move', move));
            continue;
        }
        const minimum = work * 100 + 100;
        if (minimum > budget) continue;
        const move = Math.max(1, Math.min(work, Math.floor((budget - work * 100 - 50) / 50)));
        if (work * 100 + 50 + move * 50 <= budget) {
            return repeat('work', work).concat(['carry'], repeat('move', move));
        }
    }
    return [];
}

function queueSettings() {
    const settings = config.spawnQueue || {};
    return {
        classes: Object.assign({ defense: 0, survival: 1, expansion: 2, remoteMaintain: 3, development: 4, aid: 5, remote: 6, opportunistic: 7 }, settings.classes || {}),
        grace: Object.assign({ defense: 0, survival: 30, expansion: 300, remoteMaintain: 60, development: 150, aid: 300, remote: 300 }, settings.grace || {}),
        // spawn 全忙时编制推导的刷新间隔（只服务于遥测）：1 = 每 tick 全跑
        busyDemandInterval: settings.busyDemandInterval == null ? 7 : Number(settings.busyDemandInterval),
        // 安静房（spawn 有空闲且上轮无请求）的全量推导间隔：1 = 每 tick 全跑
        quietDemandInterval: settings.quietDemandInterval == null ? 5 : Number(settings.quietDemandInterval),
        minShare: settings.minShare == null ? 0.5 : Number(settings.minShare),
        minCostShare: settings.minCostShare == null ? 0.5 : Number(settings.minCostShare),
        upgradePayback: settings.upgradePayback == null ? 2 : Number(settings.upgradePayback),
        upgradeHandover: settings.upgradeHandover == null ? 200 : Number(settings.upgradeHandover),
        incomeAlpha: settings.incomeAlpha == null ? 0.05 : Number(settings.incomeAlpha),
        incomeSamples: settings.incomeSamples == null ? 10 : Number(settings.incomeSamples),
        fallbackIncomePerSource: settings.fallbackIncomePerSource == null ? 5 : Number(settings.fallbackIncomePerSource),
        reserveMargin: settings.reserveMargin == null ? 20 : Number(settings.reserveMargin),
        reserveMaxLead: settings.reserveMaxLead == null ? 150 : Number(settings.reserveMaxLead),
        minIncome: settings.minIncome == null ? 1 : Number(settings.minIncome),
        survivalShrinkAfter: settings.survivalShrinkAfter == null ? 300 : Number(settings.survivalShrinkAfter),
    };
}

/** 核心角色替补的能量预留：矿工/hauler 距离"到期提前量"只剩 ≤ 攒够理想身体所需 tick + reserveMargin 时，先把这笔能量留住并挡住外矿类请求；
 *  否则外矿 creep 把能量花光、替补攒不出来 → 矿工断档 → 整房 recovering（线上 W34S7 19:43：能量被花到 8/1300，矿工到期没接上）。
 *  真正的替补请求仍在 ttl ≤ 提前量时由计数产生（countPlannedRole 不再计入它）。 */
function replacementReserveRequests(room, mem, state, sources, settings, income) {
    const requests = [];
    // 收入为 0 时预留没有意义（攒不出来），而且会把 hauler 全灭这类紧急缩身请求挡在后面
    if (state.readyWorkers === 0 || !(income > 0)) return requests;
    const cap = room.energyCapacityAvailable;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        const memory = creep.memory;
        if (creep.spawning || memory.dropMiner || memory.aid) continue;
        if (memory.role !== 'harvester' && memory.role !== 'hauler' && memory.role !== 'operator') continue;
        if (creep.ticksToLive == null) continue;
        const remaining = creep.ticksToLive - replaceLead(creep, memory.role);
        if (remaining <= 0) continue;
        const ideal = memory.role === 'harvester'
            ? harvesterBody(room, mem, sources, Math.max(0, harvesterSourceIndex(memory, sources)), cap)
            : memory.role === 'operator' ? operatorBody(room, mem, cap) : coreHaulerBody(room, mem, cap);
        // 按替补实际会接受的身体计价：过了宽限它会缩到容量的 minShare（RCL6 hauler 2300 → 1150），线上 RCL6 房的 hauler 全是
        // 1150–1200——按满容量预留 2300 从头到尾不可达，vital 的预留却用 blockAll 冻住整条队列（基准中位 150–450 tick）
        const cost = Math.min(bodyCost(ideal), Math.ceil(cap * settings.minShare));
        if (!(cost > 0)) continue;
        // 窗口封顶：收入越低 eta 越大，没有上限时低收入房提前几百 tick 就开始冻结队列（外矿维护、发展全停）
        const eta = Math.min(queue.ticksToAfford(cost - room.energyAvailable, income), settings.reserveMaxLead);
        if (!(remaining <= eta + settings.reserveMargin)) continue;
        // 遥测：最近一次替补预留（成本应是替补实际会接受的身体，不是满容量理想身体）
        const reserveLog = mem.reserveLog && typeof mem.reserveLog === 'object' && !mem.reserveLog.role ? mem.reserveLog : (mem.reserveLog = {});
        reserveLog[memory.role] = { at: Game.time, cost, ideal: bodyCost(ideal), capacity: cap, remaining: Math.round(remaining) };
        requests.push({
            key: 'reserve:' + memory.role + ':' + creep.name,
            role: memory.role,
            // 排在生存档请求之后、发展档之前：不挡正在补的核心角色，只挡弹性 hauler/builder 与外矿类；vital：援建也不许绕过
            priority: settings.classes.survival + 0.5,
            grace: 0,
            reserve: cost,
            vital: true,
        });
    }
    return requests;
}

const SPAWN_SELF_REGEN_BELOW = typeof SPAWN_ENERGY_CAPACITY === 'number' ? SPAWN_ENERGY_CAPACITY : 300;

/** spawn 自产：能量 < 300 的 spawn 每 tick 自回 1，这不是经济收入。RCL 基准里 W31S8 丢光容器、hauler 全灭后，EMA 靠这个 1/tick
 *  停在 0.1–1 从不归零，缩身下限因此按"收入 > 0"取容量一半（900），而房里只有自产的 300–600，队头等了 12 万 tick、房间降级 */
function spawnSelfRegen(room) {
    return room.find(FIND_MY_SPAWNS).filter((spawn) => spawn.store && (spawn.store[RESOURCE_ENERGY] || 0) < SPAWN_SELF_REGEN_BELOW).length;
}

/** 每 tick 采样 spawn 能量的正增量（支出是负的不算；满仓看不到收入也不采样；扣掉 spawn 自产），EMA 是"多久能攒够"的依据。
 *  自产只在上一 tick 全房能量 < 300 时发生（引擎 processor/intents/spawns/tick.js：energyAvailable < SPAWN_ENERGY_CAPACITY
 *  且该 spawn < 300）。以前对每个 < 300 的 spawn 都扣 1：孵化先抽 spawn 再抽 extension，孵过一次 spawn 就停在 0，
 *  没有到货时 delta = −1 被当成支出丢掉——hauler 全灭这类最需要 EMA 归零的时刻它反而冻结在危机前的值
 *  （基准 61b4caf：6–7 万房·tick 的队头按冻结的收入估计等待，W34S9 的 core:hauler:1 最长等了 6576 tick） */
function updateSpawnIncome(room, mem, settings) {
    const track = mem.spawnIncome || (mem.spawnIncome = { ema: 0, n: 0, last: null, at: -1 });
    const energy = room.energyAvailable;
    if (track.at === Game.time - 1 && track.last != null && track.last < room.energyCapacityAvailable) {
        const regen = track.last < SPAWN_SELF_REGEN_BELOW ? spawnSelfRegen(room) : 0;
        // 遥测：spawn < 300 但全房 ≥ 300（引擎不自产）的采样数——旧代码在这些 tick 把 1 当自产扣掉、样本被丢弃
        if (!regen && track.last >= SPAWN_SELF_REGEN_BELOW && spawnSelfRegen(room) > 0) track.noRegen = (Number(track.noRegen) || 0) + 1;
        const delta = energy - track.last - regen;
        if (delta >= 0) {
            // 从 0 起按同一 alpha 收敛（以前首个样本直接当 EMA：一车 400 落在首样本就是 400/tick）；样本不足 incomeSamples 时 incomeEstimate 用每源 fallback
            track.ema = (Number(track.ema) || 0) + settings.incomeAlpha * (delta - (Number(track.ema) || 0));
            track.n++;
        }
    }
    track.last = energy;
    track.at = Game.time;
    return track;
}

/** spawn 实际花出去的能量（/tick）的慢 EMA（Memory.rooms[房].spawnSpend {ema, at, n}）：本房的 spawn 每开孵一只 creep（队列、换代、
 *  应急 drop miner）就把身体成本记进来，读数按经过的 tick 衰减（窗口 hauling.spawnSpendWindow）。hauler 编制的投递停靠份额与
 *  storage → spawn/ext 补给项用它，而不是 spawnIncome：spawnIncome 只在 spawn/ext 没满的 tick 采样正增量，是"补货时的到货速率"，
 *  不是长期花费——基准 550k–625k 队列收入中位 11.7–69.6/tick，同期实际孵化花费 5.5–29.1/tick（1.4–3.4 倍），停靠份额因此贴着 1。
 *  首次读取时用本房 creep 的维持费（Σ 身体成本 / 寿命）当初值：稳态下维持费就是花费的无偏估计，新部署/新房不必从 0 爬一代。
 *  援建 creep（memory.home = 弱房）是本房 spawn 孵的，记在本房——本房的 hauler 要把它花掉的能量补回 extension */
function spawnSpendAlpha() {
    return 1 / Math.max(1, Number((config.hauling || {}).spawnSpendWindow) || 1500);
}

function creepLifeTicks(body) {
    const life = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    const claimLife = typeof CREEP_CLAIM_LIFE_TIME === 'number' ? CREEP_CLAIM_LIFE_TIME : 600;
    return bodyPartCount(body, 'claim') > 0 ? claimLife : life;
}

function spawnUpkeep(room) {
    let total = 0;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;
        const body = creep.body || [];
        if (body.length) total += bodyCost(body) / creepLifeTicks(body);
    }
    return total;
}

function spawnSpendTrack(room, mem) {
    const track = mem.spawnSpend;
    if (track && typeof track === 'object' && Number.isFinite(Number(track.ema)) && Number.isFinite(Number(track.at))) return track;
    return (mem.spawnSpend = { ema: spawnUpkeep(room), at: Game.time, n: 0 });
}

/** 当前读数（/tick）：上次记账后的衰减 */
function spawnSpendRate(room, mem) {
    if (!mem) return 0;
    const track = spawnSpendTrack(room, mem);
    const dt = Math.max(0, Game.time - Number(track.at));
    return Math.max(0, Number(track.ema) || 0) * Math.pow(1 - spawnSpendAlpha(), dt);
}

function recordSpawnSpend(room, mem, cost) {
    if (!mem || !(cost > 0)) return;
    const track = spawnSpendTrack(room, mem);
    track.ema = spawnSpendRate(room, mem) + spawnSpendAlpha() * cost;
    track.at = Game.time;
    track.n = (Number(track.n) || 0) + 1;
}

/** 这只矿工会不会亲自把能量送到 spawn：机动身体、且它的源既没有容器也没有己方 link（bootstrap 期的往返模式）。
 *  有容器/link 的矿工只往容器/link 交货（roles/harvester.js 静态采掘分支），静态身体没有容器时原地落地——都不送 spawn。 */
function harvesterDelivers(room, mem, sources, creep) {
    if (!hasBodyPart(creep, 'carry')) return false;
    const limit = Number(config.harvesting && config.harvesting.mobileTicksPerTile) || 3;
    if (bodyTicksPerTile(creep.body) > limit) return false;
    const index = harvesterSourceIndex(creep.memory, sources);
    const source = index >= 0 && sources ? sources[index] : null;
    if (!source) return true;
    if (sourceContainer(room, mem, source, index)) return false;
    const link = sourceLinkAt(room, mem, source, index);
    return !(link && link.my);
}

/** 能到达 spawn 的能量收入估计（/tick）：没有在岗矿工 → 0；没有会送 spawn 的搬运者（hauler 或往返模式的矿工）→ 0；否则 EMA，样本不足按每源 fallback。
 *  以前把所有带 CARRY 的矿工都算搬运者：RCL5+ 每房至少一口 link 源，5W1C1M 只往 link 交货，最后一只 hauler 死后收入估计仍是旧 EMA，
 *  生存档 hauler 只能按容量一半（RCL7 是全价 2400）干等满 survivalShrinkAfter——线上 W33S7 2026-09-11 约 166 tick 一只 hauler 都没有 */
function incomeEstimate(room, mem, state, sources, settings) {
    const readyHarvesters = state && state.readyHarvesters != null ? state.readyHarvesters : countReadyRole(room, 'harvester');
    if (!readyHarvesters) return 0;
    let carriers = 0;
    let minersNotCarrying = 0;
    for (const creep of creepsHome(room.name)) {
        if (isRetiring(creep.memory)) continue;   // 走向 spawn 回收中的旧 creep（retire.js）
        if (creep.spawning) continue;
        if (creep.memory.role === 'hauler') carriers++;
        else if (creep.memory.role === 'harvester') {
            if (harvesterDelivers(room, mem, sources, creep)) carriers++;
            else if (hasBodyPart(creep, 'carry')) minersNotCarrying++;
        }
    }
    if (minersNotCarrying && mem && mem.spawnIncome) {
        // 遥测（决策事件）：带 CARRY、却只往 link/容器交货的矿工不算搬运者（旧代码把所有带 CARRY 的矿工都算）
        const seen = mem.spawnIncome.minerNotCarrier || {};
        if (seen.at !== Game.time) mem.spawnIncome.minerNotCarrier = { at: Game.time, n: (Number(seen.n) || 0) + 1, miners: minersNotCarrying };
    }
    if (!carriers) {
        // 往本房卸货的外矿运输工（remoteHauler.homeTarget 先送 spawn/ext）也是搬运者，包括别的母房派来、卸货房选了本房的
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (!creep || !creep.memory || creep.memory.role !== 'remoteHauler' || creep.spawning || isRetiring(creep.memory)) continue;
            const drop = creep.memory.dropRoom || remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
            if (drop === room.name) { carriers++; break; }
        }
    }
    if (!carriers && mem && mem.spawnIncome && creepsHome(room.name).some((creep) => creep.memory.role === 'harvester' && hasBodyPart(creep, 'carry') && !creep.spawning)) {
        // 遥测：带 CARRY 的矿工都只往 link/容器交货、又没有 hauler——旧代码把它们当搬运者，收入估计停在旧 EMA
        const seen = mem.spawnIncome.noCarrier || {};
        mem.spawnIncome.noCarrier = { at: Game.time, n: (Number(seen.n) || 0) + 1 };
    }
    if (!carriers) return 0;
    const track = mem.spawnIncome;
    if (track && track.n >= settings.incomeSamples) {
        const ema = Math.max(0, Number(track.ema) || 0);
        // 不到 minIncome/tick 当 0：EMA 指数衰减永远不会精确归零，而队列的缩身下限只看"收入 > 0"——零头收入就会让生存档按容量一半等死
        if (ema >= (Number(settings.minIncome) || 0)) return ema;
        // 遥测：有搬运工在岗却把收入当 0 的 tick 数——应接近 0（线上 W33S8 alpha 0.05 时每两车之间都会发生，缩身下限在 650 与 0 之间翻转）
        track.starved = (Number(track.starved) || 0) + 1;
        return 0;
    }
    return settings.fallbackIncomePerSource * Math.max(1, (sources || []).length);
}

/** 需求对象（defense/expansion/aid/remote 的 {role, slot, body, memory, lead}）→ 固定身体的请求 */
function demandRequest(room, item, cls, settings, flags) {
    const body = item.body || [];
    const cost = bodyCost(body);
    return Object.assign({
        key: cls + ':' + item.slot,
        role: item.role,
        item,
        priority: settings.classes[cls],
        grace: item.grace != null ? Number(item.grace) : (settings.grace[cls] || 0),
        neededBy: item.neededBy,
        ordered: true,
        // 生产者给了分档身体：缩身下限按理想身体成本的份额（650 的 1 CLAIM 是 1300 的一半，能过；1550 的 hauler 不会缩成 200），不套容量一半
        minCostShare: typeof item.bodyFor === 'function' ? settings.minCostShare : undefined,
        memory: Object.assign({}, item.memory, { home: item.memory.home || room.name, role: item.role, slotKey: item.slot }),
        body: (budget) => {
            if (body.length && cost <= budget) return body;
            // 生产者给了 bodyFor：宽限用完后按预算缩身（援建 builder 1350 在收入 3/tick 时要等 216 tick，缩到 800 立刻能走）
            if (typeof item.bodyFor !== 'function') return [];
            const scaled = item.bodyFor(Math.max(0, budget)) || [];
            return scaled.length && bodyCost(scaled) <= budget ? scaled : [];
        },
    }, flags || {});
}

/** 方案里有位置却没有建筑的核心容器数：源容器（没有源 link 顶替）+ 控制器容器（没有 ctrl link、升级者也不由 storage 供能时） */
function coreContainerGap(room, mem, sources) {
    const plan = mem && mem.plan;
    if (!plan || !plan.containers) return 0;
    let gap = 0;
    (sources || []).forEach((source, index) => {
        if (!plan.containers['src' + index]) return;
        if (sourceContainer(room, mem, source, index) || sourceLinkAt(room, mem, source, index)) return;
        // 规划位上已经有容器（测试里常是 my:false 的中立容器；线上也可能是还没 claimed 的遗留）
        // 就不算缺口——trySite 也放不上去，再孵 builder 只会占掉本该给 hauler/feeder 的 spawn
        if (structureAt(room, plan.containers['src' + index], STRUCTURE_CONTAINER)) return;
        gap++;
    });
    if (plan.containers.ctrl && !structureAt(room, plan.containers.ctrl, STRUCTURE_CONTAINER) &&
        !(plan.links && plan.links.ctrl && structureAt(room, plan.links.ctrl, STRUCTURE_LINK)) &&
        !layout.controllerFedByStorage(room, plan)) gap++;
    return gap;
}

/** 核心角色请求：矿工到生存底线（其余由弹性矿工按缺口补 WORK）、hauler/upgrader/builder 到目标，按生存/发展/富余分级 */
function coreRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, baseUpgraders, settings) {
    const requests = [];
    const cap = room.energyCapacityAvailable;
    const planned = Object.assign({}, plannedCounts);
    const assignPreview = {};
    for (let n = planned.harvester; n < survivalTargets.harvester; n++) {
        const sourceIdx = assignHarvesterSource(room, mem, assignPreview, sources);
        assignPreview[sourceIdx] = (assignPreview[sourceIdx] || 0) + 1;
        const memory = { home: room.name, role: 'harvester', sourceIdx };
        if (sources[sourceIdx]) memory.sourceId = sources[sourceIdx].id;
        requests.push({
            key: 'core:harvester:' + n,
            role: 'harvester',
            priority: settings.classes.survival,
            grace: settings.grace.survival,
            vital: true,
            memory,
            sourceIdx,
            body: (budget) => (budget < MIN_HARVESTER_COST ? [] : harvesterBody(room, mem, sources, sourceIdx, Math.min(cap, budget))),
            finalize: (body, creepMemory) => { if (bodyPartCount(body, 'carry') === 0) creepMemory.staticMiner = true; },
        });
    }
    if (state.readyWorkers === 0) return requests;
    const haulerPlan = coreHaulerCarry(room, mem);
    if (planned.hauler < targets.hauler) {
        // 遥测（决策事件）：这次 core hauler 请求按 CARRY 方案定的尺寸与方案分解（haulModel 每 tick 覆盖，这里只在真的要孵时记）
        const model = mem.haulModel || {};
        mem.haulerSize = { at: Game.time, parts: haulerPlan.parts, full: haulerPlan.full, need: haulerPlan.need, count: targets.hauler,
            heads: haulerPlan.heads, min: haulerPlan.min, mode: model.mode, temp: model.temp, production: model.production, flow: model.flow,
            base: model.base, measured: model.measured, burst: model.burst, spend: model.spend };
    }
    for (let n = planned.hauler; n < targets.hauler; n++) {
        const cls = n < survivalTargets.hauler ? 'survival' : 'development';
        requests.push({
            key: 'core:hauler:' + n,
            role: 'hauler',
            // 第 2 只 hauler 是"唯一一只死掉到替补孵出"那段空窗的保险（hauling.linkFloorMinStore 的依据）：发展档里排在 builder/升级者之前
            priority: cls === 'survival' ? settings.classes.survival : n < 2 ? settings.classes.development - 0.25 : settings.classes.development,
            grace: settings.grace[cls],
            vital: cls === 'survival',
            memory: { home: room.name, role: 'hauler' },
            body: (budget) => {
                const body = coreHaulerBody(room, mem, Math.min(cap, budget));
                return bodyCost(body) <= budget ? body : [];
            },
        });
    }
    // 补差头（core:hauler:x，同外矿的 remoteHauler:<房>:<源>:x）：只数够了、在编 CARRY 却比方案 C* 少一截（零收入时缩身孵出的 2C 生存档
    // hauler、容量涨了之后的旧小身体）。以前在岗平均载量变小会把只数顶上去（"靠堆人头"补），现在只数只看方案，小身体要么等换代（队列清空、
    // 能量满才轮到），要么靠这一只按缺口补上。缺口 ≥ max(2, C* × residualShare) 才出（方案随花费漂移的一两个 CARRY 不算），身体按缺口、
    // 不小于 minBodyCarry、不超过方案身体；补上后缺口消失，这只到期不再替补（只数回到方案）
    const cstar = Number(haulerPlan.need) || 0;
    if (planned.hauler >= targets.hauler && targets.hauler > 0 && cstar > 0) {
        const live = plannedHaulerCarry(room, haulerPlan.parts);
        const gap = cstar - live.carry;
        const minGap = Math.max(2, Math.ceil(cstar * coreSizing().residualShare));
        if (gap >= minGap) {
            const parts = Math.max(haulerPlan.min, Math.min(haulerPlan.parts, Math.ceil(gap)));
            mem.haulerResidual = { at: Game.time, live: Math.round(live.carry * 10) / 10, heads: live.heads, cstar, gap: Math.round(gap * 10) / 10, parts };
            requests.push({
                key: 'core:hauler:x',
                role: 'hauler',
                priority: settings.classes.development,
                grace: settings.grace.development,
                memory: { home: room.name, role: 'hauler' },
                body: (budget) => {
                    const body = makeBody('hauler', Math.min(cap, haulerBudgetForCarry(parts), Math.max(150, budget)));
                    return bodyCost(body) <= budget ? body : [];
                },
            });
        }
    }
    for (let n = planned.operator; n < (targets.operator || 0); n++) {
        requests.push({
            key: 'core:operator:' + n,
            role: 'operator',
            priority: settings.classes.survival + 0.25,
            grace: settings.grace.survival,
            vital: true,
            memory: { home: room.name, role: 'operator' },
            body: (budget) => {
                const body = operatorBody(room, mem, Math.min(cap, Math.max(200, budget)));
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    // storage 富到能量没有边际价值（remote.staffRemotes 的孵化时间上限同一滞回状态）：富余加的升级者是花掉 storage 的唯一出口，
    // 不能再是"立刻买得起、且前面没人占 spawn 才孵"的机会档——线上 W33S3 storage 34 万，目标 3 只、实际 1 只，
    // 单 spawn 的每个空闲 tick 队里总有外矿维护或发展档请求。提到发展档、jumpable（买不起不挡别人）
    const richUpgrade = !!mem.remoteSpawnCapped;
    // 在编 WORK 闸：在编升级者的 WORK 已够可持续供给（utils.upgraderSupplyWork）就不再出升级者请求。人头数只是代理——
    // 一只 W47 顶两只 W20 的名额还多（线上 W38S7：4 只 W47 = 188 WORK、供给 20/tick，旧口径按人头仍在补）
    const upWorkCap = planned.upgrader < targets.upgrader ? utils.upgraderSupplyWork(room, mem) : null;
    let upWork = upWorkCap == null ? 0 : plannedUpgraderWork(room);
    const upPerBody = upWorkCap == null ? 0 : bodyPartCount(upgraderBody(room, mem, cap), 'work');
    for (let n = planned.upgrader; n < targets.upgrader; n++) {
        if (upWorkCap != null && upWork >= upWorkCap) {
            const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
            track.workGate = { at: Game.time, cap: upWorkCap, planned: upWork, held: targets.upgrader - n };
            break;
        }
        upWork += upPerBody;
        const cls = n < survivalTargets.upgrader ? 'survival' : n < baseUpgraders ? 'development' : richUpgrade ? 'development' : 'opportunistic';
        // 底线 upgrader 的优先级按生存档排，但宽限用发展档：源没人挖才值得 30 tick 就缩身，升级晚几十 tick 没有损失
        requests.push({
            key: 'core:upgrader:' + n,
            role: 'upgrader',
            priority: settings.classes[cls],
            grace: cls === 'survival' ? settings.grace.development : (settings.grace[cls] || 0),
            opportunistic: cls === 'opportunistic',
            jumpable: richUpgrade && n >= baseUpgraders,
            memory: { home: room.name, role: 'upgrader' },
            body: (budget) => {
                const body = upgraderBody(room, mem, Math.min(cap, Math.max(200, budget)));
                return bodyCost(body) <= budget ? body : [];
            },
        });
    }
    // 核心容器（源容器 / 控制器容器）缺失时第 1 只 builder 是生存档：没人建容器就没有静态采集与升级供能。
    // 线上 W33S7 三个容器全部衰减（builder 727 tick 没排上——发展档永远排在外矿维护后面，缩身下限 900 攒不到），收入 17→12、升级 14→9
    const containerGap = planned.builder === 0 ? coreContainerGap(room, mem, sources) : 0;
    // 没有 builder 但房里有"会消失的"危急结构（容器/道路烂到 0 就没了）：把它提到生存档，
    // 否则发展档的 builder 永远排在外矿维护后面——线上 2026-09-09 W33S7：45 分钟没排上 builder，
    // 24 个道路工地 0 进度，塔射程外那 18 条 < 1000 血的路继续归零。只在"一只 builder 都没有"时生效（有界）。
    const criticalGap = planned.builder === 0 && containerGap === 0 && utils.hasCriticalStructure(room);
    if (criticalGap) {
        const seen = mem.criticalBuilder || {};
        mem.criticalBuilder = { at: Game.time, n: (Number(seen.n) || 0) + 1 };
    }
    for (let n = planned.builder; n < targets.builder; n++) {
        const vitalBuilder = n === 0 && (containerGap > 0 || criticalGap);
        // 生存档 builder 排在源矿工 / 第 1 只 hauler（1）和核心替补预留（1.5）之后、扩张（2）之前：同为生存档时按首次出现排序会让
        // 等了几百 tick 的 builder 挡住刚死的 hauler；vital：没有容器的房不该再给别人援建（上线后 W34S7 的 builder 等待仍被援建绕过）
        // 普通 builder 等能量时也挡住后面的非 strategic 请求（新外矿开路、弱房已能自转的援建、富余升级者）：以前不挡，
        // 线上 W33S7 的 builder 1/3 等了十几小时——能量一到 650–700 就被援建/外矿拿走，缩身到 900 也永远够不到，storage 工地停在 10834/30000
        requests.push({
            key: 'core:builder:' + n,
            role: 'builder',
            priority: vitalBuilder ? settings.classes.survival + 0.75 : settings.classes.development,
            grace: vitalBuilder ? settings.grace.survival : settings.grace.development,
            vital: vitalBuilder,
            memory: { home: room.name, role: 'builder' },
            body: (budget) => {
                const body = makeBody('builder', Math.min(cap, Math.max(200, budget)));
                return bodyCost(body) <= budget ? body : [];
            },
        });
    }
    // 专职短途搬运工：发展档（与弹性 hauler/upgrader 同级），storage 富余时才有目标（feederTarget）
    for (let n = planned.feeder; n < (targets.feeder || 0); n++) {
        requests.push({
            key: 'core:feeder:' + n,
            role: 'feeder',
            priority: settings.classes.development,
            grace: settings.grace.development,
            memory: { home: room.name, role: 'feeder' },
            body: (budget) => {
                const body = feederBody(room, mem, Math.min(cap, Math.max(200, budget)));
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    // 矿物钻机：opportunistic（买得起才孵，从不等待）。矿物完全不参与能量经济，
    // 但它是 labs / boost / 市场的唯一入口——我们过去把 extractor 和矿物容器都建了，然后一次也没挖过
    for (let n = planned.mineralMiner; n < (targets.mineralMiner || 0); n++) {
        requests.push({
            key: 'core:mineralMiner:' + n,
            role: 'mineralMiner',
            priority: settings.classes.opportunistic,
            grace: 0,
            opportunistic: true,
            memory: { home: room.name, role: 'mineralMiner' },
            body: (budget) => {
                const plan = require('roles_mineralMiner').directive(room);
                const body = plan && Array.isArray(plan.body) ? plan.body : [];
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    // 实验室搬运工：同样 opportunistic。矿物链不参与能量经济，但它是 boost 与市场收入的前置
    for (let n = planned.labTech; n < (targets.labTech || 0); n++) {
        requests.push({
            key: 'core:labTech:' + n,
            role: 'labTech',
            priority: settings.classes.opportunistic,
            grace: 0,
            opportunistic: true,
            memory: { home: room.name, role: 'labTech' },
            body: (budget) => {
                const body = labTechBody(Math.min(cap, Math.max(200, budget)));
                return body.length && bodyCost(body) <= budget ? body : [];
            },
        });
    }
    for (let n = planned.scout; n < targets.scout; n++) {
        const body = makeBody('scout', cap);
        requests.push({
            key: 'core:scout:' + n,
            role: 'scout',
            priority: settings.classes.opportunistic,
            grace: 0,
            opportunistic: true,
            memory: { home: room.name, role: 'scout' },
            body: (budget) => (bodyCost(body) <= budget ? body : []),
        });
    }
    return requests;
}

/** 弹性矿工请求：某个源的 WORK 还没到需求（容器就绪后 5 WORK 静态矿工替代小身板）时按缺口补一只残余身体的矿工。
 *  排在外矿需求之后（同级、按顺序），但 strategic：核心角色在等能量时它照样能孵——补 WORK 是在加收入，不是抢能量
 *  （线上 W34S7 源 1 只剩 3 WORK 时被"等 1300 hauler"压了几百 tick）；opportunistic：买不起就跳过，从不等待。
 *  能量满且该源有换代候选时不出请求：换代（换掉小身板）优于再加一只。 */
/** 矿工换代请求：容量涨了 / 容器就绪（静态）/ link 出现（带 CARRY）时，用理想身体替换小身板，旧 creep 在新身体就绪后退役。
 *  与弹性矿工同级、排在它前面（换掉小身板优于再加一只），strategic + opportunistic：买得起就孵，从不等待也不挡人。
 *  其他角色的换代仍在队列清空、能量满时由 tryBodyUpgrade 处理。 */
function harvesterUpgradeRequests(room, state, mem, sources, settings) {
    const requests = [];
    if (state.readyWorkers === 0) return requests;
    for (const candidate of bodyUpgradeCandidates(room, state, mem, sources)) {
        if (candidate.role !== 'harvester') continue;
        const memory = Object.assign({}, candidate.creep.memory, {
            home: room.name,
            role: 'harvester',
            bodyPlanCost: candidate.desiredCost,
            replaces: candidate.creep.name,
            bodyGeneration: Number(candidate.creep.memory.bodyGeneration || 0) + 1,
        });
        delete memory.dropMiner;
        delete memory.bodyUpgradePending;
        delete memory.bodyUpgradeAt;
        if (bodyPartCount(candidate.desired, 'carry') === 0) memory.staticMiner = true;
        else delete memory.staticMiner;
        requests.push({
            key: 'upgrade:harvester:' + candidate.creep.name,
            role: 'harvester',
            tag: 'upgrade',
            priority: settings.classes.remote,
            grace: 0,
            ordered: true,
            strategic: true,
            opportunistic: true,
            blocking: false,
            memory,
            sourceIdx: harvesterSourceIndex(candidate.creep.memory, sources),
            body: (budget) => (candidate.desiredCost <= budget ? candidate.desired : []),
            onSpawn: (creepMemory, name) => {
                candidate.creep.memory.bodyUpgradePending = name;
                candidate.creep.memory.bodyUpgradeAt = Game.time;
            },
        });
    }
    return requests;
}

/** 外矿槽位换代：槽位被缩身身体（宽限用完后按预算孵的 200 hauler、350 的 2W 矿工）占着时，理想身体买得起就孵一只替换它。
 *  值不值得换按吞吐算：需求自带 throughput(body)（矿工 = WORK×2、hauler = CARRY×50/往返，都封顶源产出），
 *  (理想吞吐 − 在岗吞吐) × 剩余可用 tick ≥ upgradePayback × 理想身体成本 才换——线上 W33S6 一只 1 CARRY 的 hauler
 *  占着 19 CARRY 的槽位 1285 tick，9.8/tick 的产出只运回不到 1。opportunistic + 非 strategic：买得起才孵，核心角色等能量时让路。
 *  旧 creep 记下替换租约，替换者进外矿房后由 retireReplaced 退役（handover）。 */
function demandUpgradeRequests(room, items, settings) {
    const requests = [];
    const payback = Number(settings.upgradePayback) || 0;
    if (!(payback > 0)) return requests;
    for (const item of items || []) {
        if (typeof item.throughput !== 'function' || !item.body || !item.body.length) continue;
        const idealCost = bodyCost(item.body);
        const idealRate = item.throughput(item.body);
        if (!(idealCost > 0) || !(idealRate > 0)) continue;
        let holder = null;
        let holderRate = -Infinity;
        let pending = false;
        for (const creep of creepsHomeRole(item.memory.home, item.role)) {   // matchesDemand 要求 home+role 全等
            if (!matchesDemand(creep.memory, item)) continue;
            // 替换者还在孵 / 交接中（被换的旧 creep 还活着）：这个槽位已经在换代
            if (creep.spawning || (creep.memory.replaces && Game.creeps[creep.memory.replaces])) { pending = true; break; }
            if (hasPendingBodyUpgrade(room, creep)) { pending = true; break; }
            const rate = item.throughput(creep.body || []);
            if (rate > holderRate) { holder = creep; holderRate = rate; }
        }
        if (pending || !holder) continue;
        const ttl = holder.ticksToLive == null ? 1500 : holder.ticksToLive;
        const remaining = ttl - (item.lead || 0);
        if (remaining <= 0) continue;   // 快到期的由常规替补接手
        const gain = (idealRate - holderRate) * remaining;
        if (!(gain >= payback * idealCost)) continue;
        // 在岗矿工吞吐不到理想的一半（2 WORK 的缩身矿工对着 10/tick 的源）：换代提到外矿维护档，等能量但不挡人（blocking:false）——
        // 机会档排在所有发展/外矿请求之后，穷房几代都轮不到（线上 W33S7 的 W32S7 连续四代 W2C1M2，按 10/tick 算每代少采约 9000）
        const urgent = item.role === 'remoteMiner' && holderRate < idealRate * 0.5;
        if (urgent) {
            const homeMem = Memory.rooms && Memory.rooms[item.memory.home || room.name];
            if (homeMem) {
                const event = { at: Game.time, slot: item.slot, rate: holderRate, ideal: idealRate };
                homeMem.minerUpgradeUrgent = event;
                // 同一个母房有两条外矿时，单条记录会被后来的那条覆盖（私服 audit 场景里就是这样丢掉证据）：按槽位留最近 6 条
                const log = homeMem.minerUpgradeLog = (homeMem.minerUpgradeLog || []).filter((entry) => entry && entry.slot !== item.slot);
                log.push(event);
                if (log.length > 6) log.splice(0, log.length - 6);
            }
        }
        const memory = Object.assign({}, item.memory, {
            home: item.memory.home || room.name,
            role: item.role,
            slotKey: item.slot,
            replaces: holder.name,
            bodyGeneration: Number(holder.memory.bodyGeneration || 0) + 1,
        });
        requests.push({
            key: 'upgrade:' + item.slot,
            role: item.role,
            tag: 'upgrade',
            item,
            priority: urgent ? settings.classes.remoteMaintain : settings.classes.remote,
            grace: 0,
            ordered: true,
            opportunistic: !urgent,
            blocking: false,
            memory,
            body: (budget) => (idealCost <= budget ? item.body : []),
            onSpawn: (creepMemory, name) => {
                holder.memory.bodyUpgradePending = name;
                holder.memory.bodyUpgradeAt = Game.time;
            },
        });
    }
    return requests;
}

function elasticHarvesterRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, settings, upgrading) {
    const requests = [];
    if (state.readyWorkers === 0) return requests;
    // 生存档矿工（没人挖的源）还没补齐时不出弹性请求：那条请求会覆盖同一个源，弹性的 1 WORK 只会抢它的能量
    if (plannedCounts.harvester < survivalTargets.harvester) return requests;
    const cap = room.energyCapacityAvailable;
    const demandBySource = harvesterDemand(room, mem, sources).bySource;
    const stats = harvesterAssignmentStats(room, sources);
    let keep = Math.max(0, recoverySpawnReserve(room));
    if (cap - keep < MIN_HARVESTER_COST) keep = 0;   // 容量 300 的新房保留 200 后连最小矿工都放不下
    const assignPreview = {};
    for (let n = Math.max(plannedCounts.harvester, survivalTargets.harvester); n < targets.harvester; n++) {
        const sourceIdx = assignHarvesterSource(room, mem, assignPreview, sources);
        const item = demandBySource[sourceIdx] || {};
        const stat = stats[sourceIdx] || { work: 0 };
        const previewWork = (assignPreview[sourceIdx] || 0) * Math.max(1, Number(item.bodyTargetWork) || 1);
        const workNeeded = Math.max(0, Number(item.targetWork || 0) - Number(stat.work || 0) - previewWork);
        if (workNeeded <= 0 || upgrading.has(sourceIdx)) break;
        assignPreview[sourceIdx] = (assignPreview[sourceIdx] || 0) + 1;
        const memory = { home: room.name, role: 'harvester', sourceIdx };
        if (sources[sourceIdx]) memory.sourceId = sources[sourceIdx].id;
        requests.push({
            key: 'core:harvester:elastic:' + sourceIdx,
            role: 'harvester',
            tag: 'elastic',
            priority: settings.classes.remote,
            grace: 0,
            ordered: true,
            strategic: true,
            opportunistic: true,
            blocking: false,
            memory,
            sourceIdx,
            body: (budget) => {
                const available = Math.max(0, Math.min(cap, budget) - keep);
                const body = residualHarvesterBody(room, mem, sources, sourceIdx, available, workNeeded);
                return body.length && bodyCost(body) + keep <= budget ? body : [];
            },
            finalize: (body, creepMemory) => { if (bodyPartCount(body, 'carry') === 0) creepMemory.staticMiner = true; },
        });
    }
    return requests;
}

/** Protect an affordable handoff before committing a non-preemptible spawn action. */
function scheduleHandoffs(room, requests, remoteDemands, allSpawns, settings, context) {
    const initial = queue.schedule(requests, context);
    // If any spawn stays free, the next tick can still admit the replacement.
    if (initial.actions.length < context.spawnsFree || !initial.actions.length) return initial;
    const releases = initial.actions.map((action) => action.body.length * 3);
    for (const spawn of allSpawns) if (spawn.spawning) releases.push(spawn.spawning.remainingTime);
    const blockingTicks = Math.min(...releases);
    const handoffs = remote.reserverHandoffs(room, remoteDemands, blockingTicks);
    const additions = [];
    for (const item of handoffs) {
        if (requests.some((request) => request.item && request.item.slot === item.slot)) continue;
        if (bodyCost(item.body) > context.energy) continue;
        const request = demandRequest(room, item, 'remoteMaintain', settings, { opportunistic: true, jumpable: true });
        request.handoffBlockingTicks = blockingTicks;
        request.handoffCandidate = initial.actions.map((action) => ({ role: action.request.role, parts: action.body.length, cost: action.cost }));
        additions.push(request);
    }
    if (!additions.length) return initial;
    // Defense/survival keep their higher class. An unaffordable forecast never reserves energy.
    return queue.schedule(additions.concat(requests), context);
}

function run(room) {
    phaseBegin();
    try {
        runQueue(room);
    } finally {
        // 最后一次打点之后的那一段：执行孵化 + 换代（提前返回的分支在返回前已打点，这里只剩残渣）
        lap('exec');
        phaseOn = false;
    }
}

function runQueue(room) {
    const mem = Memory.rooms[room.name] || {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = mem;
    const sources = layout.resolveSources(room, mem, mem.plan);
    const state = roomState(room, mem, sources);
    const settings = queueSettings();
    updateSpawnIncome(room, mem, settings);
    const allSpawns = room.find(FIND_MY_SPAWNS);
    // 每 tick 都要看（下面忙/安静的分支会提前返回）：孵好却生不出来的 spawn 放开出生方向
    try { releaseStalledSpawns(room, mem, allSpawns); } catch (error) { logErr('spawn.releaseStalledSpawns ' + room.name, error); }
    // 困在出生口袋里的 creep（旧兜底孵进去的）打标记，由 retire.retirePocketTrapped 让贴着的 spawn 回收（按房错峰，每 trappedScanInterval tick 一次）
    try { spawnExit.markPocketTrapped(room, mem, allSpawns); } catch (error) { logErr('spawnExit.markPocketTrapped ' + room.name, error); }
    const idle = allSpawns.filter((s) => !s.spawning);
    lap('pre');
    // 所有 spawn 都在忙时，下面整套编制推导（plannedCounts / targets / 建造 backlog / 矿工统计）只服务于遥测：
    // mem.demand 除了监控与私服探针没有别的消费方，忙的这一 tick 也不可能孵任何东西。
    // 上线后的按模块 CPU 实测 spawn 单项 30.4 CPU/tick（10 个房各跑一遍），这是其中的主体。
    // 忙的时候按房错峰每 busyDemandInterval tick 刷一次遥测，其余 tick 直接返回。
    if (!idle.length) {
        const interval = Math.max(1, Math.floor(Number(queueSettings().busyDemandInterval) || 1));
        if (interval > 1 && !utils.isRoomPhaseTick(room.name, interval)) {
            // upgraderTarget 有每 tick 的副作用：采样供给 EMA、并按「EMA ≥ raiseAbove 且本 tick 能量满仓」加员。
            // 降频会把 EMA 的采样频率降到 1/interval（alpha 是按次不是按 tick，收敛慢 7 倍），加员还要撞上
            // 「刚好满仓」的巧合——私服 upgrade.storageRich 断言因此挂了：storage 富余却只有 1 只升级者。
            // 所以这一个照常每 tick 调用，只是丢掉返回值；真正贵的 6 个 target、7 次编制计数、
            // 建造 backlog 与 writeDemand 仍然跳过。
            try { upgraderTarget(room, mem); } catch (error) { logErr('spawn.upgraderTarget ' + room.name, error); }
            mem.spawnQueue = { at: Game.time, busy: true };
            if (mem.demand) mem.demand.skipped = (mem.demand.skipped || 0) + 1;
            lap('busy');
            return;
        }
    }
    // spawn 有空闲但上一次全量推导什么请求都没有（requests=0、没孵、没换代）：本房安静。
    // 线上 2026-10-03：13 个房里 10 个是这个形态，每 tick 各把整套推导（6 个 target、7 次编制计数、四类 getDemands、
    // backlog、writeDemand）重跑一遍，spawn 单项均值 42.6 / 总 131 CPU。安静期内按房错峰每 quietDemandInterval tick 才重算；
    // 重算之间的 tick 仍须守住：恢复期/没有在岗工人/房里有敌人（要让 defense 需求当 tick 出现）一律照常全跑。
    const quietInterval = Math.max(1, Math.floor(Number(queueSettings().quietDemandInterval) || 1));
    const quiet = mem.spawnQuiet;
    if (idle.length && quietInterval > 1 && quiet && Number(quiet.at) <= Game.time && Game.time - Number(quiet.at) < quietInterval &&
        !utils.isRoomPhaseTick(room.name, quietInterval) && !state.recovering && state.readyWorkers > 0 &&
        !(room.find(FIND_HOSTILE_CREEPS) || []).length) {
        // 同 busy 分支：upgraderTarget 的供给 EMA 采样与满仓加员是每 tick 副作用，不能降频
        try { upgraderTarget(room, mem); } catch (error) { logErr('spawn.upgraderTarget ' + room.name, error); }
        mem.spawnQueue = Object.assign({}, mem.spawnQueue, { at: Game.time, idle: idle.length, quiet: true });
        if (mem.demand) mem.demand.quietSkipped = (mem.demand.quietSkipped || 0) + 1;
        lap('quiet');
        return;
    }
    // 等能量：上一轮全量推导的队头买不起（mem.spawnWaiting）、能量仍不够它、上一轮也没孵任何东西——
    // 重算多半得出同一个结论。线上 2026-10-14 W31S8 等一只 1300 的 reserver，每 tick 全量推导一遍。
    // 按房错峰每 waitingDemandInterval tick 重算一次；能量一够、有敌人、恢复期、没有在岗工人都照常全跑
    const waitInterval = Math.max(1, Math.floor(Number(queueSettings().waitingDemandInterval) || 1));
    const waitingHead = mem.spawnWaiting;
    const lastQueue = mem.spawnQueue || {};
    if (idle.length && waitInterval > 1 && waitingHead && Number(waitingHead.at) <= Game.time &&
        Game.time - Number(waitingHead.at) < waitInterval && room.energyAvailable < Number(waitingHead.cost) &&
        !(lastQueue.spawned && lastQueue.spawned.length) &&
        !utils.isRoomPhaseTick(room.name, waitInterval) && !state.recovering && state.readyWorkers > 0 &&
        !(room.find(FIND_HOSTILE_CREEPS) || []).length) {
        try { upgraderTarget(room, mem); } catch (error) { logErr('spawn.upgraderTarget ' + room.name, error); }
        if (mem.demand) mem.demand.waitSkipped = (mem.demand.waitSkipped || 0) + 1;
        lap('quiet');
        return;
    }
    mem.spawnQuiet = null;
    const survival = config.survival[room.controller.level] || {};
    const sourceHarvesters = coreHarvesterTarget(room, sources);
    const plannedCounts = {};
    for (const role of PRIORITY) plannedCounts[role] = countPlannedRole(room, role);
    lap('counts');
    // 防御 > 扩张 > 援建 > 外矿：防御需求即便在恢复期也要产出（塔压不住时没有别的办法）；spawn 全忙时不算需求（省 CPU）
    const defenseDemands = idle.length ? defense.getDemands(room) : [];
    const expansionDemands = idle.length && !state.recovering ? expansion.getDemands(room) : [];
    const aidDemands = idle.length && !state.recovering ? aid.getDemands(room) : [];
    const remoteOnly = idle.length && !state.recovering ? remote.getDemands(room) : [];
    const conquestDemands = idle.length && !state.recovering ? conquest.getDemands(room) : [];
    const remoteDemands = defenseDemands.concat(expansionDemands, aidDemands, remoteOnly, conquestDemands);
    lap('demands');
    const builderBacklog = constructionBacklog(room);
    lap('backlog');
    const targets = {
        harvester: targetFor(room, 'harvester', mem, sources),
        hauler: targetFor(room, 'hauler', mem, sources),
        upgrader: targetFor(room, 'upgrader', mem, sources),
        builder: targetFor(room, 'builder', mem, sources, builderBacklog),
        feeder: targetFor(room, 'feeder', mem, sources),
        operator: targetFor(room, 'operator', mem, sources),
        mineralMiner: targetFor(room, 'mineralMiner', mem, sources),
        labTech: targetFor(room, 'labTech', mem, sources),
        scout: targetFor(room, 'scout', mem, sources),
    };
    lap('targets');
    const baseUpgraders = Math.max(0, Number((config.roster[room.controller.level] || {}).upgrader || 0));
    // 核心容器（源容器/控制器容器）缺失时底线 upgrader 不进生存档：它没有供能来源，1250–1750 的身体卡在队头会挡住负责重建容器的
    // vital builder（私服整账号基准 88fe9e7：W33S8 三个容器同时衰减后 40k tick 收入 0–2/tick、27 个工地没人建、RCL4 降到 3）
    const containersMissing = coreContainerGap(room, mem, sources) > 0;
    // recovering 把 builder 目标清零、hasBuilderWork 在"没工地也没容器"时也是 false：核心容器缺口的 vital builder
    // 根本进不了队。静态矿工没有 CARRY，自建容器代码走不到，只能落地。88fe9e7 RCL6 己方源利用 83%→69%
    // 就是 W33S8/W35S7/W31S8 这条链，不是健康房的采集公式变了。
    if (containersMissing) {
        targets.builder = Math.max(1, Number(targets.builder) || 0);
        const seen = mem.containerGapBuilder || {};
        mem.containerGapBuilder = { at: Game.time, recovering: !!state.recovering, n: (Number(seen.n) || 0) + 1 };
    }
    const survivalTargets = {
        harvester: Math.min(survival.harvester || 0, sourceHarvesters) || sourceHarvesters,
        hauler: Math.min(survival.hauler || 0, targets.hauler),
        upgrader: (state.recovering || containersMissing) ? 0 : Math.min(survival.upgrader || 0, targets.upgrader),
    };
    // 生存档按源覆盖：某个源一只在岗矿工都没有（即将到期的不算）时，目标至少 = 在编数 + 未覆盖源数，
    // 否则总数达标就跳过矿工去孵 upgrader/builder，那口源一直空着（线上 W34S7：两只矿工都在源 0，源 1 空了 100+ tick）
    const assignStats = harvesterAssignmentStats(room, sources);
    const uncoveredSources = assignStats.filter((stat) => !stat.count).length;
    // 遥测（私服生效断言 spawn.harvesterSpawningCovers）：某源的覆盖只来自孵化中的矿工、同时还有空闲 spawn——
    // 旧口径在这一 tick 会把源当成没人覆盖，让空闲 spawn 再孵一只同源矿工
    const coverIdx = idle.length ? assignStats.findIndex((stat) => stat.count > 0 && stat.spawning === stat.count) : -1;
    if (coverIdx >= 0) {
        const seenCover = mem.harvesterSpawnCover || {};
        mem.harvesterSpawnCover = { at: Game.time, src: coverIdx, idle: idle.length, n: (Number(seenCover.n) || 0) + 1 };
    }
    if (uncoveredSources > 0 && !state.recovering) {
        survivalTargets.harvester = Math.max(survivalTargets.harvester, plannedCounts.harvester + uncoveredSources);
    }
    writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);
    lap('write');
    if (!idle.length) {
        mem.spawnQueue = { at: Game.time, busy: true };
        return;
    }

    const assignedHarvesterSources = {};
    let energyBudget = room.energyAvailable;
    if (state.readyWorkers === 0 &&
        plannedCounts.hauler > 0 &&
        energyBudget >= config.recovery.emergencyDropMinerAt &&
        energyBudget < config.recovery.emergencyHarvestBelow) {
        const body = ['work', 'move'];
        const name = creepName('harvester', 'drop');
        const sourceIdx = assignHarvesterSource(room, mem, assignedHarvesterSources, sources);
        const memory = { home: room.name, role: 'harvester', sourceIdx, dropMiner: true };
        if (sources[sourceIdx]) memory.sourceId = sources[sourceIdx].id;
        if (idle[0].spawnCreep(body, name, spawnOptions(idle[0], memory)) === OK) {
            recordSpawnSpend(room, mem, bodyCost(body));
            plannedCounts.harvester++;
            writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);
            return;
        }
    }

    // ---- 组请求 ----
    const requests = [];
    const slotCounts = {};
    const unmet = (item) => {
        if (slotCounts[item.slot] == null) slotCounts[item.slot] = countPlannedDemand(room, item);
        return slotCounts[item.slot] < 1 && item.body && item.body.length;
    };
    for (const item of defenseDemands) {
        if (!unmet(item)) continue;
        // 己方房的防御是 defense 档（最前）；外矿防御归 remoteMaintain 档且可被同级跳过：不抢母房生存的能量
        const cls = item.cls === 'remoteMaintain' ? 'remoteMaintain' : 'defense';
        requests.push(demandRequest(room, item, cls, settings, {
            strategic: cls === 'defense',
            jumpable: cls !== 'defense',
            blocking: false,
            onSpawn: () => {
                // 防御遥测：defender 清场后会退役，事后只能从这里知道曾经出过兵
                const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
                log.spawned += 1;
                log.lastAt = Game.time;
                log.lastSlot = item.slot;
            },
        }));
    }
    for (const request of coreRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, baseUpgraders, settings)) {
        request.onSpawn = () => {
            plannedCounts[request.role]++;
            if (request.role === 'harvester') {
                assignedHarvesterSources[request.sourceIdx] = (assignedHarvesterSources[request.sourceIdx] || 0) + 1;
            }
        };
        requests.push(request);
    }
    const income = incomeEstimate(room, mem, state, sources, settings);
    for (const request of replacementReserveRequests(room, mem, state, sources, settings, income)) requests.push(request);
    if (state.readyWorkers !== 0) {
        // 一次性的战略需求（占领 / 援建）不被等能量的核心角色挡；外矿需求买不起时跳到后面买得起的一条（jumpable），
        // 但核心角色等能量时它们不插队（线上 W33S7：hauler 目标 3 在岗 1 时反复孵 remoteHauler，spawn 能量一直贴地）
        for (const item of expansionDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'expansion', settings, { strategic: true }));
        // 援建只在弱房经济还没起来时是 strategic（aid.js shortHanded）；弱房能自转后排在母房自己的 builder/hauler 之后
        for (const item of aidDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'aid', settings, { strategic: item.strategic !== false }));
        // 容器已建成的外矿的替补（remote.js 标 maintain）是在维持收入，排在发展档与援建之前；新外矿的开路仍在最后
        for (const item of remoteOnly) if (unmet(item)) requests.push(demandRequest(room, item, item.maintain ? 'remoteMaintain' : 'remote', settings, { jumpable: true }));
        // 攻占需求（破防 dismantler / 围降 downgrader / 占领 claimer）：一次性战略操作。jumpable 不挡同级；
        // blocking:false 关键——攻占档位（2）在生存之上、经济之下，若买不起的攻城身体还 blocking 就会把 blockBelow 压到 2、
        // 冻住优先级 >2 的全部经济（reserver=remoteMaintain 4 首当其冲），线上实测把 reserver 打到 0/8。攻城仍靠优先级先拿能量，
        // 只是买不起时不再冻结经济（reserver 是突发性的，多数 tick 无需孵化，母房能量照常累积到攒够攻城身体）。
        for (const item of conquestDemands) if (unmet(item)) requests.push(demandRequest(room, item, 'conquest', settings, { jumpable: true, blocking: false }));
    }
    const upgrading = new Set();
    for (const request of harvesterUpgradeRequests(room, state, mem, sources, settings)) {
        upgrading.add(request.sourceIdx);
        requests.push(request);
    }
    for (const request of elasticHarvesterRequests(room, mem, state, sources, targets, survivalTargets, plannedCounts, settings, upgrading)) {
        request.onSpawn = () => {
            plannedCounts.harvester++;
            assignedHarvesterSources[request.sourceIdx] = (assignedHarvesterSources[request.sourceIdx] || 0) + 1;
        };
        requests.push(request);
    }
    // 外矿槽位换代：排在所有补位之后（同级、opportunistic），只换已被缩身身体占住的槽位
    if (state.readyWorkers !== 0 && !state.recovering) {
        for (const request of demandUpgradeRequests(room, remoteOnly.filter((item) => !unmet(item)), settings)) requests.push(request);
    }
    for (const request of requests) {
        if (request.item) {
            const item = request.item;
            const previous = request.onSpawn;
            request.onSpawn = (...args) => {
                slotCounts[item.slot] = (slotCounts[item.slot] || 0) + 1;
                if (previous) previous(...args);
            };
        }
    }
    // 首次出现的 tick：截止时间从这里起算（成本涨了、能量被抽都不重置——那正是要防的"永远差一口"）
    const previousSince = mem.spawnSince || {};
    const since = {};
    for (const request of requests) since[request.key] = previousSince[request.key] != null ? previousSince[request.key] : Game.time;
    mem.spawnSince = since;
    lap('requests');
    const result = scheduleHandoffs(room, requests, remoteOnly, allSpawns, settings, {
        now: Game.time,
        energy: energyBudget,
        capacity: room.energyCapacityAvailable,
        income,
        spawnsFree: idle.length,
        busySpawnTimes: allSpawns.filter((spawn) => spawn.spawning).map((spawn) => spawn.spawning.remainingTime),
        since,
        minShare: settings.minShare,
        survivalShrinkAfter: settings.survivalShrinkAfter,
    });

    lap('schedule');
    // 遥测：收入为 0 时非 vital 的队头守着正常缩身下限等待（旧规则按现有能量缩成最小身体占槽 1500 tick）
    if (!(income > 0) && result.waiting && energyBudget >= 200) {
        const head = requests.find((request) => request.key === result.waiting.key);
        if (head && !head.vital && !(head.reserve > 0)) {
            const seen = mem.zeroIncomeHeld || {};
            mem.zeroIncomeHeld = { at: Game.time, key: head.key, energy: energyBudget, n: (Number(seen.n) || 0) + 1 };
        }
    }

    // ---- 执行 ----
    const usedSpawns = new Set();
    const spawnedKeys = [];
    const freeSpawns = idle.slice();
    for (const action of result.actions) {
        const spawn = freeSpawns.shift();
        if (!spawn) break;
        const request = action.request;
        const memory = Object.assign({}, request.memory);
        if (request.finalize) request.finalize(action.body, memory);
        const name = creepName(request.role, request.tag);
        const ret = spawn.spawnCreep(action.body, name, spawnOptions(spawn, memory));
        if (ret === OK) {
            energyBudget -= action.cost;
            recordSpawnSpend(room, mem, action.cost);
            usedSpawns.add(spawn);
            spawnedKeys.push(request.key);
            // 最近 10 次孵化（key / 成本 / 是否缩身）：诊断"队列先孵了谁"（私服生效断言 spawn.vitalFirst 看它）
            const spawnLog = mem.spawnLog || (mem.spawnLog = []);
            spawnLog.push({ t: Game.time, key: request.key, cost: action.cost, scaled: !!action.scaled });
            if (spawnLog.length > 10) spawnLog.shift();
            if (!mem.spawnFirst) mem.spawnFirst = spawnLog[spawnLog.length - 1];   // 这个房记录以来的第一次孵化（环形日志会被顶掉）
            if (request.handoffBlockingTicks) mem.reserveHandoff = {
                at: Game.time, name, remoteRoom: request.memory.remoteRoom,
                blockedTicks: request.handoffBlockingTicks, lead: request.item.lead, candidates: request.handoffCandidate,
            };
            if (request.onSpawn) request.onSpawn(memory, name);
            continue;
        }
        if (ret !== ERR_BUSY && ret !== ERR_NOT_ENOUGH_ENERGY) {
            logErr('spawn.queue ' + room.name, new Error('spawnCreep ' + ret + ' ' + request.key));
        }
    }
    const waiting = result.waiting;
    mem.spawnWaiting = waiting ? {
        cost: waiting.cost,
        at: Game.time,
        since: waiting.since,
        eta: waiting.eta,
        key: waiting.key,
        role: waiting.role,
    } : null;
    mem.spawnQueue = {
        at: Game.time,
        idle: idle.length,
        requests: requests.length,
        income: Math.round(income * 10) / 10,
        spawned: spawnedKeys,
        reserved: result.reserved,
        blocked: result.blocked.length,
        waiting: waiting ? { key: waiting.key, cost: waiting.cost, eta: waiting.eta, waited: Game.time - waiting.since } : null,
    };
    writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);

    const pending = requests.some((request) => !request.opportunistic && !request.reserve && !spawnedKeys.includes(request.key));
    if (pending) return;
    // 队列清空且能量满时才轮到换代替换
    let bodyUpgraded = false;
    if (room.energyAvailable >= room.energyCapacityAvailable) {
        for (const spawn of idle) {
            if (usedSpawns.has(spawn)) continue;
            const upgrade = tryBodyUpgrade(room, spawn, state, mem, sources, energyBudget);
            if (upgrade) {
                energyBudget -= upgrade.cost;
                usedSpawns.add(spawn);
                bodyUpgraded = true;
            }
        }
        writeDemand(room, mem, state, plannedCounts, remoteDemands, builderBacklog, targets);
    }
    // 这一轮什么都没有：进入安静期（下一轮全量推导在 quietDemandInterval 之内不重复，见 run 开头）
    if (!requests.length && !spawnedKeys.length && !bodyUpgraded) mem.spawnQuiet = { at: Game.time };
}

module.exports = { run, cpuDigest, retireReplaced, spawnDirections, releaseStalledSpawns, constructionBacklog, builderTarget, roleLead, upgraderBody, upgraderTarget, upgraderLowMode, countReadyRole, averageHaulerCarry, countPlannedDemand, feederTarget, feederBody, operatorTarget, operatorBody, labTechTarget, labTechBody, updateSpawnIncome, coreHaulerCarry, spawnSpendRate, bodyImproves };
