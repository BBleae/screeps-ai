'use strict';
/** spawn 出生口（config.spawnPocket）：出生口袋几何、孵好却生不出来时的处理、困在口袋里的 creep 回收。
 *
 *  引擎语义（engine/processor/intents/spawns/tick.js + _born-creep.js）：
 *  - gameTime ≥ spawnTime − 1 的那个 tick 末尾尝试出生：按 spawning.directions（没给就是 1..8）的顺序取第一个空格，
 *    格上有障碍物（含 creep，用的是 roomObjects 里这一刻的位置）或本 tick 有 creep 要走进来（movement.isTileBusy）都算占用；
 *    给定方向全占就失败、不回退到别的方向，spawnTime 推到下一 tick——玩家代码里看到 remainingTime ≤ 0 = 孵好了没生出来。
 *  - 堵口的 creep 在 tick N 走开：spawn 与 creep 的处理顺序不定，出生落在 N 或 N+1 的 tick 末；
 *    所以让路的 creep 要一直离开到出生完成（hold），否则 N+1 又走回来（isTileBusy）照样堵死。
 *
 *  线上 2026-10-08 W34S7：Spawn21 (27,34) 允许的出口只剩 RIGHT (28,34)、BOTTOM (27,35)，(27,35) 是 operator 的枢纽站位（永久停着），
 *  (28,34) 停着一只 builder；旧的兜底（releaseStalledSpawns 放开全部 8 个方向）放开了 TOP_LEFT (26,33)——真口袋——
 *  替补源矿工孵进去被困死（手动 console 回收）。W31S4 的 Spawn9 同样发生 5 次、W34S7 3 次。
 *  现在：出口全被己方 creep 占住时让它们让路（vacate）；兜底只放开"不是口袋"的排除方向；困在口袋里的 creep 就地回收。 */
const config = require('config');
const utils = require('utils');
const movement = require('movement');

const SPAWN_DIR_OFFSETS = [null, [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
const ALL_DIRECTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

function settings() {
    return Object.assign({ minTiles: 10, stallTicks: 5, vacateAt: 1, vacateHoldTicks: 10, vacateSearch: 3, trappedScanInterval: 20 },
        config.spawnPocket || {});
}

function spawnBlocksMovement(structure) {
    const type = structure && structure.structureType;
    if (!type || type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER) return false;
    if (type === STRUCTURE_RAMPART) return structure.my === false && !structure.isPublic;
    return true;
}

/** 房间可走性：非地形墙（墙上有路也算）且没有障碍建筑/障碍工地（工地按建成后算，提前避开）、不是源/矿；creep 不算障碍（会走开）。
 *  opts.sites === false：工地不算障碍——"现在走不走得出去"的判定（困住回收、出生是否落进口袋）用这个：creep 能踩着工地走，
 *  只因为 extension/塔还是工地才围成的"口袋"现在并没有困住谁（引擎 _born-creep 把障碍工地当占用，所以出生方向仍按建成后算） */
function walkability(room, opts) {
    const withSites = !(opts && opts.sites === false);
    const blocked = new Set();
    const roads = new Set();
    for (const s of utils.findCached(room, FIND_STRUCTURES) || []) {
        if (!s || !s.pos) continue;
        if (s.structureType === STRUCTURE_ROAD) roads.add(s.pos.x * 50 + s.pos.y);
        else if (spawnBlocksMovement(s)) blocked.add(s.pos.x * 50 + s.pos.y);
    }
    for (const site of withSites ? room.find(FIND_MY_CONSTRUCTION_SITES) || [] : []) {
        if (site && site.pos && spawnBlocksMovement({ structureType: site.structureType, my: true })) blocked.add(site.pos.x * 50 + site.pos.y);
    }
    // 源和矿也是障碍（OBSTACLE_OBJECT_TYPES）：过去当可走格，口袋经由源/矿"连通"到外面就被误判成开口
    for (const kind of [FIND_SOURCES, FIND_MINERALS]) {
        for (const o of room.find(kind) || []) if (o && o.pos) blocked.add(o.pos.x * 50 + o.pos.y);
    }
    const terrain = room.getTerrain();
    return (x, y) => x >= 0 && x <= 49 && y >= 0 && y <= 49 && !blocked.has(x * 50 + y) &&
        (!(terrain.get(x, y) & TERRAIN_MASK_WALL) || roads.has(x * 50 + y));
}

function dirTile(spawn, dir) {
    return { x: spawn.pos.x + SPAWN_DIR_OFFSETS[dir][0], y: spawn.pos.y + SPAWN_DIR_OFFSETS[dir][1] };
}

function dirOf(spawn, pos) {
    for (let dir = 1; dir <= 8; dir++) {
        const t = dirTile(spawn, dir);
        if (t.x === pos.x && t.y === pos.y) return dir;
    }
    return null;
}

/** 出生口袋：从每个出生格出发在可走格上做有界 BFS，连通不到 minTiles 格的算口袋（open / pockets 都是方向号，不可走的方向两边都不列） */
function computeSpawnDirections(room, spawn, walk) {
    const minTiles = Math.max(2, Number(settings().minTiles) || 10);
    const walkable = walk || walkability(room);
    const regionReaches = (sx, sy) => {
        const seen = new Set([sx * 50 + sy]);
        const queue = [[sx, sy]];
        while (queue.length && seen.size < minTiles) {
            const [x, y] = queue.shift();
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                const key = nx * 50 + ny;
                if (seen.has(key) || !walkable(nx, ny)) continue;
                seen.add(key);
                queue.push([nx, ny]);
            }
        }
        return seen.size >= minTiles;
    };
    const open = [];
    const pockets = [];
    for (let dir = 1; dir <= 8; dir++) {
        const { x, y } = dirTile(spawn, dir);
        if (!walkable(x, y)) continue;
        if (regionReaches(x, y)) open.push(dir);
        else pockets.push(dir);
    }
    return { open, pockets };
}

function stallLog(mem) {
    return mem.spawnStallLog || (mem.spawnStallLog = { n: 0 });
}

function roomMem(roomName) {
    if (typeof Memory === 'undefined' || !Memory.rooms || !roomName) return null;
    return Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
}

function hasActive(creep, type) {
    return (creep.body || []).some((part) => part.type === type && part.hits !== 0);
}

/** 出生口被己方 creep 堵住时让路（spawn 侧）：spawning 快好了（remainingTime ≤ vacateAt）且给定方向里每个可走格都站着 creep、
 *  至少一只是自己的，就给其中一只能动的打 memory.vacate {spawn, name, x, y, until}（main.js 的 creep 循环里 runVacate 接管它）。
 *  优先没有疲劳的；只有疲劳的也打（疲劳清零就走）；全是没 MOVE 的记 cannotVacate（每只 spawning 记一次），等兜底。
 *  返回被打标记的 creep 名（这一 tick 新打或已有有效标记），没有就 null */
function requestVacate(room, mem, spawn, sp, walk) {
    const dirs = Array.isArray(sp.directions) && sp.directions.length ? sp.directions : ALL_DIRECTIONS;
    const own = [];
    for (const dir of dirs) {
        const t = dirTile(spawn, dir);
        if (t.x < 1 || t.x > 48 || t.y < 1 || t.y > 48 || !walk(t.x, t.y)) continue;
        const creeps = typeof room.lookForAt === 'function' ? room.lookForAt(LOOK_CREEPS, t.x, t.y) || [] : [];
        if (!creeps.length) return null;   // 有空格：不是被 creep 堵住（走进来的、敌人踩生等交给引擎/兜底）
        for (const creep of creeps) if (creep && creep.my !== false && creep.memory) own.push({ creep, x: t.x, y: t.y });
    }
    if (!own.length) return null;
    const active = own.find((b) => b.creep.memory.vacate && b.creep.memory.vacate.name === sp.name && Number(b.creep.memory.vacate.until) >= Game.time);
    if (active) return active.creep.name;
    const log = stallLog(mem);
    const key = spawn.name || spawn.id;
    const movable = own.filter((b) => hasActive(b.creep, MOVE));
    if (!movable.length) {
        const prev = log.cannotVacate;
        if (!prev || prev.name !== sp.name || prev.spawn !== key) {
            log.cannotVacate = { n: (Number(prev && prev.n) || 0) + 1, at: Game.time, spawn: key, name: sp.name,
                blockers: own.map((b) => b.creep.name).slice(0, 4), reason: 'noMove' };
        }
        return null;
    }
    const pick = movable.find((b) => !(b.creep.fatigue > 0)) || movable[0];
    const s = settings();
    pick.creep.memory.vacate = { spawn: spawn.id, name: sp.name, x: pick.x, y: pick.y, until: Game.time + Math.max(2, Number(s.vacateHoldTicks) || 10) };
    const prev = log.vacate || {};
    log.vacate = { n: (Number(prev.n) || 0) + 1, at: Game.time, spawn: key, name: sp.name, blocker: pick.creep.name,
        role: pick.creep.memory.role || null, x: pick.x, y: pick.y, fatigue: pick.creep.fatigue || 0, moved: Number(prev.moved) || 0,
        failed: Number(prev.failed) || 0 };
    return pick.creep.name;
}

/** 出生后记一笔：生在哪格、等了几 tick、是不是让路/放开方向换来的、那格是不是口袋（应当永远不是） */
function noteBorn(room, mem, spawn, rec) {
    const creep = Game.creeps && Game.creeps[rec.name];
    if (!creep || creep.spawning || !creep.pos || creep.pos.roomName !== spawn.pos.roomName) return;
    const dir = dirOf(spawn, creep.pos);
    // 只看建成的障碍：只因工地围成的格不算落进口袋（creep 踩着工地走得出去），不报假警
    const pocket = dir != null && computeSpawnDirections(room, spawn, walkability(room, { sites: false })).pockets.includes(dir);
    const log = stallLog(mem);
    log.born = { at: Game.time, spawn: spawn.name || spawn.id, name: rec.name, x: creep.pos.x, y: creep.pos.y, dir,
        waited: rec.since != null ? Game.time - rec.since : 0, vacate: rec.vacate || null, released: !!rec.done, pocket };
    if (pocket) log.bornPocket = (Number(log.bornPocket) || 0) + 1;
    // 最近 10 次卡过的出生（born 只留最后一次，同房后面的出生会盖掉；私服生效断言按名字找）
    const history = Array.isArray(log.bornHistory) ? log.bornHistory : (log.bornHistory = []);
    history.push({ at: Game.time, spawn: log.born.spawn, name: rec.name, x: creep.pos.x, y: creep.pos.y, pocket, vacate: rec.vacate || null });
    while (history.length > 10) history.shift();
}

/** 孵好却生不出来（每 tick 由 spawn.run 调）：
 *  1. remainingTime ≤ vacateAt 且出口全被己方 creep 占住 → requestVacate 让一只让路（不等它卡住：省掉一次失败的出生）；
 *  2. 连续 stallTicks tick 孵好却生不出来（remainingTime ≤ 0）→ 兜底 Spawning.setDirections 加上"现在可走、不是口袋"的方向
 *     （原方向排前面，引擎按顺序取第一个空格）；口袋方向永远不放（旧代码放开全部 8 个，creep 孵进口袋被困死）。
 *     没有可加的方向记 noRelease，继续等让路；本来就是全方向还生不出来记 surrounded。每只 spawning 只兜底一次。
 *  遥测 Memory.rooms[房].spawnStallLog：n/at/spawn/name/waited/from/to/code（兜底放开）、vacate、cannotVacate、born、bornPocket、trapped */
function releaseStalledSpawns(room, mem, spawns) {
    const s = settings();
    const stallTicks = Math.max(1, Number(s.stallTicks) || 5);
    const vacateAt = Number.isFinite(Number(s.vacateAt)) ? Number(s.vacateAt) : 1;
    let stall = mem.spawnStall;
    let walk = null;
    for (const spawn of spawns || []) {
        const sp = spawn && spawn.spawning;
        const key = spawn && (spawn.name || spawn.id);
        let rec = stall && stall[key];
        if (rec && (!sp || sp.name !== rec.name || !(Number(sp.remainingTime) <= vacateAt))) {
            if (!sp || sp.name !== rec.name) {
                try { noteBorn(room, mem, spawn, rec); } catch (error) { utils.logErr('spawnExit.noteBorn ' + room.name, error); }
            }
            delete stall[key];
            rec = null;
        }
        if (!sp) continue;
        const remaining = Number(sp.remainingTime);
        if (!(remaining <= vacateAt)) continue;
        const stalled = remaining <= 0;
        if (!walk) walk = walkability(room);
        const vacate = requestVacate(room, mem, spawn, sp, walk);
        if (!rec && (stalled || vacate)) {
            stall = stall || (mem.spawnStall = {});
            rec = stall[key] = { name: sp.name, since: stalled ? Game.time : null };
        }
        if (!rec) continue;
        if (vacate) rec.vacate = vacate;
        if (stalled && rec.since == null) rec.since = Game.time;
        if (!stalled || rec.done || Game.time - rec.since < stallTicks) continue;
        rec.done = Game.time;
        const log = stallLog(mem);
        const dirs = Array.isArray(sp.directions) && sp.directions.length ? sp.directions.slice() : null;
        if (!dirs || ALL_DIRECTIONS.every((d) => dirs.includes(d))) {
            log.surrounded = { at: Game.time, spawn: key, name: sp.name, waited: Game.time - rec.since };
            continue;
        }
        const extra = computeSpawnDirections(room, spawn, walk).open.filter((d) => !dirs.includes(d));
        if (!extra.length) {
            log.noRelease = { at: Game.time, spawn: key, name: sp.name, waited: Game.time - rec.since, from: dirs };
            continue;
        }
        const to = dirs.concat(extra);
        const code = typeof sp.setDirections === 'function' ? sp.setDirections(to) : null;
        log.n = (Number(log.n) || 0) + 1;
        log.at = Game.time;
        log.spawn = key;
        log.name = sp.name;
        log.waited = Game.time - rec.since;
        log.from = dirs;
        log.to = to;
        log.code = code;
    }
    if (stall && !Object.keys(stall).length) delete mem.spawnStall;
}

/** 让路的去处：从 creep 出发在可走格上 BFS（≤ vacateSearch 步），取最近的一格：没有 creep、不贴着任何己方 spawn（不堵别的出口、
 *  不进口袋——口袋格都贴着 spawn）、不在房间边上 */
function vacateTarget(creep, room) {
    const walk = walkability(room);
    const spawns = room.find(FIND_MY_SPAWNS) || [];
    const nearSpawn = (x, y) => spawns.some((sp) => sp && sp.pos && Math.max(Math.abs(sp.pos.x - x), Math.abs(sp.pos.y - y)) <= 1);
    const occupied = (x, y) => typeof room.lookForAt === 'function' && (room.lookForAt(LOOK_CREEPS, x, y) || []).length > 0;
    const limit = Math.max(1, Number(settings().vacateSearch) || 3);
    const start = creep.pos;
    const seen = new Set([start.x * 50 + start.y]);
    let frontier = [[start.x, start.y]];
    for (let depth = 1; depth <= limit && frontier.length; depth++) {
        const next = [];
        for (const [x, y] of frontier) {
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                const key = nx * 50 + ny;
                if (seen.has(key) || nx < 1 || nx > 48 || ny < 1 || ny > 48 || !walk(nx, ny)) continue;
                seen.add(key);
                if (!nearSpawn(nx, ny) && !occupied(nx, ny)) return { x: nx, y: ny };
                next.push([nx, ny]);
            }
        }
        frontier = next;
    }
    return null;
}

function vacateLog(roomName) {
    const mem = roomMem(roomName);
    if (!mem) return {};
    const log = stallLog(mem);
    return log.vacate || (log.vacate = { n: 0, moved: 0, failed: 0 });
}

/** 让路（creep 侧，main.js 每只 creep 派活前调）：带 memory.vacate 的 creep 只要还贴着那只 spawn 就走到 vacateTarget；
 *  离开以后原地等到出生完成（spawn 不再孵这只 / 换了一只）或 until 到期，不跑角色——operator/feeder 的站位就是出口时，
 *  角色逻辑会立刻走回去（出生在走开后的 N 或 N+1 tick 末才发生，走回来那一 tick 引擎按 isTileBusy 照样判占用）。
 *  没有 MOVE、找不到去处：撤标记、记 failed，交还角色（spawn 侧兜底）。疲劳中：等（本 tick 走不了）。返回 true = 本 tick 已接管 */
function runVacate(creep) {
    const v = creep && creep.memory && creep.memory.vacate;
    if (!v) return false;
    const spawn = Game.getObjectById(v.spawn);
    const sp = spawn && spawn.spawning;
    if (!spawn || !spawn.pos || !sp || sp.name !== v.name || !(Number(v.until) >= Game.time)) {
        delete creep.memory.vacate;
        return false;
    }
    if (creep.spawning) return false;
    if (creep.pos.roomName !== spawn.pos.roomName ||
        Math.max(Math.abs(creep.pos.x - spawn.pos.x), Math.abs(creep.pos.y - spawn.pos.y)) > 1) return true;   // 已离开：等出生
    const log = vacateLog(spawn.pos.roomName);
    if (!hasActive(creep, MOVE)) {
        delete creep.memory.vacate;
        log.failed = (Number(log.failed) || 0) + 1;
        log.failedWhy = { at: Game.time, name: creep.name, why: 'noMove' };
        return false;
    }
    if (creep.fatigue > 0) return true;
    const room = spawn.room || (Game.rooms && Game.rooms[spawn.pos.roomName]);
    const target = room && vacateTarget(creep, room);
    if (!target) {
        delete creep.memory.vacate;
        log.failed = (Number(log.failed) || 0) + 1;
        log.failedWhy = { at: Game.time, name: creep.name, why: 'noTile' };
        return false;
    }
    movement.go(creep, new RoomPosition(target.x, target.y, spawn.pos.roomName), { range: 0, priority: 2, reusePath: 0 });
    if (v.moved == null) {
        v.moved = Game.time;
        log.moved = (Number(log.moved) || 0) + 1;
        log.last = { at: Game.time, name: creep.name, from: { x: creep.pos.x, y: creep.pos.y }, to: target };
    }
    return true;
}

/** 困在口袋里的 creep（旧兜底孵进去的）：每 trappedScanInterval tick（按房名错峰）看一遍每只 spawn 的口袋格，
 *  口袋只按建成的障碍算（walkability sites:false）——工地 creep 踩得过去，只因 extension/塔工地围成的格里站着的 builder 并没有困住；
 *  连续两次扫描都站在同一口袋格（第一次记 memory.pocketSeen {x, y, at}，下一次扫描位置没变）才打 memory.pocketTrapped {spawn, x, y, at}
 *  ——它一步都走不出去，由 retire.retirePocketTrapped 让贴着的 spawn 回收（utils.isRetiring 立刻把它排除出编制，替补马上出）。
 *  遥测 spawnStallLog.trapped */
function markPocketTrapped(room, mem, spawns) {
    const interval = Math.max(1, Number(settings().trappedScanInterval) || 20);
    if (!(spawns && spawns.length) || !utils.isRoomPhaseTick(room.name, interval) || typeof room.lookForAt !== 'function') return 0;
    let walk = null;
    let marked = 0;
    for (const spawn of spawns) {
        if (!spawn || !spawn.pos) continue;
        if (!walk) walk = walkability(room, { sites: false });
        const { pockets } = computeSpawnDirections(room, spawn, walk);
        for (const dir of pockets) {
            const t = dirTile(spawn, dir);
            for (const creep of room.lookForAt(LOOK_CREEPS, t.x, t.y) || []) {
                if (!creep || creep.my === false || !creep.memory || creep.spawning || creep.memory.pocketTrapped) continue;
                const seen = creep.memory.pocketSeen;
                if (seen && Number(seen.at) === Game.time) continue;   // 同一格贴着两只 spawn：这一轮已经记过
                // 上一次扫描（interval tick 前）就站在这格才算困住；否则只记一笔，等下一次扫描确认
                if (!seen || seen.x !== t.x || seen.y !== t.y || !(Game.time - Number(seen.at) <= interval)) {
                    creep.memory.pocketSeen = { x: t.x, y: t.y, at: Game.time };
                    continue;
                }
                delete creep.memory.pocketSeen;
                creep.memory.pocketTrapped = { spawn: spawn.id, x: t.x, y: t.y, at: Game.time };
                const log = stallLog(mem);
                const prev = log.trapped || {};
                log.trapped = { n: (Number(prev.n) || 0) + 1, at: Game.time, spawn: spawn.name || spawn.id, name: creep.name,
                    role: creep.memory.role || null, x: t.x, y: t.y, recycled: Number(prev.recycled) || 0 };
                marked++;
            }
        }
    }
    return marked;
}

module.exports = { SPAWN_DIR_OFFSETS, ALL_DIRECTIONS, walkability, computeSpawnDirections, releaseStalledSpawns, requestVacate, runVacate,
    vacateTarget, markPocketTrapped, settings };
