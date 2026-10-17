'use strict';

const ROLE_PRIORITIES = {
    hauler: 1,
    remoteHauler: 1,
    reserver: 1,
    scout: 1,
    attacker: 2,
    defender: 2,
    healer: 2,
};
const UNSUPPORTED_MOVE_OPTIONS = new Set([
    'ignoreCreeps',
    'reusePath',
    'serializeMemory',
    'noPathFinding',
    'ignore',
    'avoid',
    'serialize',
]);

const utils = require('utils');   // utils/layout 的依赖链（config、utils、wheel_layout）都不绕回 movement
const layout = require('layout');
const config = require('config');   // keeperAvoid 半径/权重；config 不绕回 movement（与 utils/layout 同链）

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const state = runtimeGlobal.__movementState || (runtimeGlobal.__movementState = {});
state.stats = state.stats || {};
for (const key of ['calls', 'engineCalls', 'nativeCalls', 'inRange', 'invalidTargets', 'invalidations', 'creepResets',
    'beginTicks', 'endTicks', 'engineLoadErrors', 'workTileErrors', 'workTileCalls', 'workTileComputes']) {
    if (typeof state.stats[key] !== 'number') state.stats[key] = 0;
}

let engine = null;
let engineDisabled = false;
let api = null;

function resultCode(name, fallback) {
    return runtimeGlobal[name] === undefined ? fallback : runtimeGlobal[name];
}

function constructorsReady() {
    return typeof Creep === 'function' && Creep.prototype &&
        typeof PowerCreep === 'function' && PowerCreep.prototype &&
        typeof RoomPosition === 'function' && RoomPosition.prototype &&
        typeof Game !== 'undefined' && typeof PathFinder !== 'undefined';
}

function exposeEngineExports(loaded) {
    if (!api) return;
    for (const name of Object.keys(loaded)) {
        if (name in api || typeof loaded[name] !== 'function') continue;
        api[name] = function () {
            return callEngine(name, arguments);
        };
    }
}

function loadEngine() {
    if (engine) return engine;
    if (engineDisabled || !constructorsReady()) return null;
    try {
        engine = require('wheel_movement_engine');
        exposeEngineExports(engine);
        return engine;
    } catch (error) {
        engineDisabled = true;
        state.stats.engineLoadErrors += 1;
        state.lastEngineError = error && error.message ? error.message : String(error);
        return null;
    }
}

function callEngine(name, args) {
    const loaded = loadEngine();
    if (!loaded || typeof loaded[name] !== 'function') return undefined;
    return loaded[name].apply(loaded, args);
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeRange(value) {
    if (!finiteNumber(value)) return 1;
    return Math.max(0, Math.floor(value));
}

function normalizePriority(creep, value) {
    let priority = value;
    if (!finiteNumber(priority)) priority = ROLE_PRIORITIES[creep && creep.memory && creep.memory.role] || 0;
    return Math.max(0, Math.min(2, Math.floor(priority)));
}

function normalizeOpts(creep, opts) {
    const normalized = {};
    for (const key in opts || {}) {
        if (key !== 'roomName') normalized[key] = opts[key];
    }
    normalized.range = normalizeRange(normalized.range);
    normalized.priority = normalizePriority(creep, normalized.priority);
    return normalized;
}

function toPos(creep, target, opts) {
    if (!target) return null;
    const candidate = target.pos || target;
    if (!finiteNumber(candidate.x) || !finiteNumber(candidate.y)) return null;
    const roomName = candidate.roomName || (opts && opts.roomName) || (creep && creep.pos && creep.pos.roomName);
    if (!roomName) return null;
    if (typeof RoomPosition === 'function') return new RoomPosition(candidate.x, candidate.y, roomName);
    return { x: candidate.x, y: candidate.y, roomName };
}

function sameRoom(left, right) {
    return !!left && !!right && left.roomName === right.roomName;
}

function rangeBetween(left, right) {
    if (!sameRoom(left, right)) return Infinity;
    return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

// ---- 跨房寻路的危险房规避 ----------------------------------------------------------------
// 轮子只在 findRoute（跨房）里用 avoidRooms 绕房，但会把它排序拼进路径缓存的 key：所以只在跨房移动时附带，且集合按 tick 全局一份、
// 与出发房无关，否则每跨一个房 key 就变、整条路径重算。线上 2026-09-05：W34S7 去 W33S5 的 hauler/矿工/reserver 全部直穿 SK 房 W34S6
// 挨 keeper 打。默认集合 = 所有己方房外扩 KEEPER_SCAN_RADIUS 圈内按房名算出的 SK 房（坐标各 mod 10 在 4–6、非中心 5,5）∪ Memory.map 里
// class=sk / 有 lair / 别人占领（有塔）的房。目的地永远不避（采 SK 矿 / 清 stronghold）；当前房不必排除——轮子的 routeCallback 只看
// "下一个房"。调用方显式传 avoidRooms（空 Set 即放行）时不干预。没用轮子自己的 addAvoidRooms：那份全局集合也会被 PathFinder 的
// roomCallback 读到，连目的地一起挡。
const KEEPER_SCAN_RADIUS = 4;
const keeperRoomCache = new Map();   // 区域 key → SK 房名数组（世界地理不变，只在己方房集合变化时重算）

function isKeeperRoom(name) {
    const coords = utils.roomCoords(name);
    if (!coords) return false;
    // SK 规则看房名里的数字（W34 → 4），不是连续坐标
    const dx = (coords.x < 0 ? -coords.x - 1 : coords.x) % 10;
    const dy = (coords.y < 0 ? -coords.y - 1 : coords.y) % 10;
    return dx >= 4 && dx <= 6 && dy >= 4 && dy <= 6 && !(dx === 5 && dy === 5);
}

/** 己方房外扩 KEEPER_SCAN_RADIUS 圈的方框内的 SK 房 */
function keeperRoomsNearHomes() {
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const name of Object.keys(gameRooms)) {
        const room = gameRooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        const coords = utils.roomCoords(name);
        if (!coords) continue;
        box.minX = Math.min(box.minX, coords.x - KEEPER_SCAN_RADIUS);
        box.maxX = Math.max(box.maxX, coords.x + KEEPER_SCAN_RADIUS);
        box.minY = Math.min(box.minY, coords.y - KEEPER_SCAN_RADIUS);
        box.maxY = Math.max(box.maxY, coords.y + KEEPER_SCAN_RADIUS);
    }
    if (box.minX === Infinity) return [];
    const key = [box.minX, box.maxX, box.minY, box.maxY].join(',');
    if (!keeperRoomCache.has(key)) {
        const rooms = [];
        for (let x = box.minX; x <= box.maxX; x++) {
            for (let y = box.minY; y <= box.maxY; y++) {
                const name = utils.roomNameAt(x, y);
                if (isKeeperRoom(name)) rooms.push(name);
            }
        }
        keeperRoomCache.set(key, rooms);
    }
    return keeperRoomCache.get(key);
}

/** 冻结大脑指令（Memory.brain.intel）里别人占着、有塔的房。按 issuedAt 缓存（指令冻结后永不变，等于只算一次） */
const frozenOwners = { key: null, rooms: [] };
function frozenOwnerRooms() {
    const directive = typeof Memory !== 'undefined' && Memory && Memory.brain;
    const intel = directive && directive.intel;
    if (!intel || typeof intel !== 'object') return [];
    const key = String(directive.issuedAt) + ':' + Object.keys(intel).length;
    if (frozenOwners.key === key) return frozenOwners.rooms;
    const spawn = typeof Game !== 'undefined' && Game.spawns ? Object.values(Game.spawns)[0] : null;
    const me = spawn && spawn.owner && spawn.owner.username || null;
    const rooms = [];
    for (const name of Object.keys(intel)) {
        const entry = intel[name];
        if (!entry || !entry.owner || entry.owner === me) continue;
        if (!(Number(entry.towers) > 0)) continue;   // 只回避塔房（KungFuDragon W29S4 这种 RCL1 无塔的不绕）
        rooms.push(name);
    }
    frozenOwners.key = key; frozenOwners.rooms = rooms;
    return rooms;
}

function dangerRooms() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.danger && state.danger.tick === tick) return state.danger.rooms;
    const rooms = new Set(keeperRoomsNearHomes());
    const map = typeof Memory !== 'undefined' && Memory && Memory.map;
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    for (const name of Object.keys(map && typeof map === 'object' ? map : {})) {
        const entry = map[name];
        if (!entry || typeof entry !== 'object') continue;
        const visible = gameRooms[name];
        if (visible && visible.controller && visible.controller.my) continue;   // 自家房（情报里 owner 是自己）
        if (entry.class === 'sk' || entry.lairs > 0 || entry.owner || isKeeperRoom(name)) rooms.add(name);
    }
    // 10-18：大脑停用后 Memory.map 已老化清空，他人塔房（tidusfox9 / Alepoldar…）掉出了回避集合（线上 74399424 W29S9 的 remoteHauler
    // 绕 S10 高速路误入 Alepoldar 的 W34S9 被塔打死）。改从冻结大脑指令 Memory.brain.intel 补：只在指令变化（issuedAt）时重算一次
    for (const name of frozenOwnerRooms()) if (!(gameRooms[name] && gameRooms[name].controller && gameRooms[name].controller.my)) rooms.add(name);
    // 10-16 战略猫：手动 dangerRooms + 近期出现玩家威胁的房（config.pvp）
    for (const name of (require('config').pvp || {}).dangerRooms || []) rooms.add(name);
    const pvp = typeof Memory !== 'undefined' && Memory && Memory.pvpThreat;
    for (const name of Object.keys(pvp || {})) if (pvp[name] && pvp[name].until > tick && !(gameRooms[name] && gameRooms[name].controller && gameRooms[name].controller.my)) rooms.add(name);
    state.danger = { tick, rooms };
    return rooms;
}

// ---- 10-16 战略：高速路上的玩家战斗部队对非战斗 creep 封路 -------------------------------------------
// 可见的高速路房（坐标 mod 10 == 0）里有非 NPC 玩家的 ATTACK/RANGED_ATTACK/HEAL creep → Memory.highwayBlock[房] = { at, until, n, user }。
// 可见且没有了 → 删；看不见的记录 until（at + highwayBlockTtl，默认 1500）过期删。每 tick 只扫一次（第一次有非战斗 creep 跨房移动时）。
// 非战斗 creep（身上没有 ATTACK/RANGED_ATTACK/HEAL）跨房寻路时把这些房并进 avoidRooms（集合按 tick 一份，路径缓存 key 稳定；
// 集合变了 key 就变，在途 creep 自动重算路线）。目的地被封或整条路都被封：原地等，不硬闯
const COMBAT_PARTS = ['attack', 'ranged_attack', 'heal'];
const NPC_OWNERS = (config.npcOwners && config.npcOwners.length) ? config.npcOwners : ['Invader', 'Source Keeper', 'Power Bank', 'Screeps'];   // 10-17：统一 owner 名单常量（含官方系统号 Screeps）
function isHighwayRoom(name) {
    const c = utils.roomCoords(name);
    if (!c) return false;
    const dx = c.x < 0 ? -c.x - 1 : c.x, dy = c.y < 0 ? -c.y - 1 : c.y;
    return dx % 10 === 0 || dy % 10 === 0;
}
function isCombatCreep(creep) {
    return !!(creep && (creep.body || []).some((p) => COMBAT_PARTS.indexOf(p.type || p) >= 0));
}
function highwayBlocks() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.hwBlock && state.hwBlock.tick === tick) return state.hwBlock.rooms;
    const mem = typeof Memory !== 'undefined' && Memory ? (Memory.highwayBlock || (Memory.highwayBlock = {})) : {};
    const ttl = Number((require('config').pvp || {}).highwayBlockTtl) || 1500;
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    const hostileKind = typeof FIND_HOSTILE_CREEPS === 'undefined' ? 'hostileCreeps' : FIND_HOSTILE_CREEPS;
    // 10-16 收窄：只封"有前科"的玩家——config.pvp.highThreat 名单（Jumpp）∪ Memory.pvpThreat 记录里出现过的玩家；其他玩家照常通行
    const pvpCfg = require('config').pvp || {};
    const hostileUsers = new Set(pvpCfg.highThreat || []);
    const pvpMem = typeof Memory !== 'undefined' && Memory && Memory.pvpThreat || {};
    for (const k of Object.keys(pvpMem)) if (pvpMem[k] && pvpMem[k].user) hostileUsers.add(pvpMem[k].user);
    // 第三个来源：打过我们的玩家（utils.noteAggressors，只认伤害 > 0）。只靠这个来源封的房，到期 = 他最后一次真动手 + ttl，
    // 光是在房里出现不续期
    const aggMem = typeof Memory !== 'undefined' && Memory && Memory.pvpAggressors || {};
    const aggressors = new Set(utils.pvpAggressors());
    // 10-16 战略：blockExclude 里的玩家只记攻击、不触发封路（查清前的临时豁免）
    for (const u of pvpCfg.blockExclude || []) { aggressors.delete(u); hostileUsers.delete(u); }
    const detect = pvpCfg.highwayBlockDetect !== false;
    for (const name of Object.keys(gameRooms)) {
        if (!detect || !isHighwayRoom(name)) continue;
        const room = gameRooms[name];
        if (!room || typeof room.find !== 'function') continue;
        const players = (room.find(hostileKind) || []).filter((c) => c.owner && NPC_OWNERS.indexOf(c.owner.username) < 0 && isCombatCreep(c));
        const armed = players.filter((c) => hostileUsers.has(c.owner.username));
        if (armed.length) { mem[name] = { at: tick, until: tick + ttl, n: armed.length, user: armed[0].owner.username }; continue; }
        const agg = players.filter((c) => aggressors.has(c.owner.username));
        const until = agg.reduce((m, c) => Math.max(m, Number(aggMem[c.owner.username] && aggMem[c.owner.username].last) + ttl), 0);
        if (agg.length && until > tick) mem[name] = { at: tick, until, n: agg.length, user: agg[0].owner.username, source: 'aggressor' };
        else if (mem[name]) delete mem[name];
    }
    const rooms = new Set();
    for (const name of Object.keys(mem)) {
        const rec = mem[name];
        if (!rec || !(Number(rec.until) > tick)) { delete mem[name]; continue; }
        rooms.add(name);
    }
    // 10-18 战略：临时回避名单（config.pvp.tempAvoid，到期自动解除）对非战斗 creep 同封路处理
    for (const name of utils.tempAvoidRooms()) rooms.add(name);
    state.hwBlock = { tick, rooms };
    return rooms;
}
/** 非战斗 creep 用的回避集合 = dangerRooms ∪ highwayBlocks（按 tick 一份） */
function civilianDangerRooms() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.civDanger && state.civDanger.tick === tick) return state.civDanger.rooms;
    const base = dangerRooms(), blocks = highwayBlocks();
    const rooms = blocks.size ? new Set([...base, ...blocks]) : base;
    state.civDanger = { tick, rooms, blocks };
    return rooms;
}
const civRoutes = new Map();
/** 非战斗 creep 从 from 到 to 是否有不穿封路房的路线（按 from>to + 封路签名缓存 100 tick） */
function civilianRouteOk(from, to) {
    const blocks = highwayBlocks();
    if (!blocks.size) return true;
    if (blocks.has(to)) return false;
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.findRoute !== 'function') return true;
    const danger = civilianDangerRooms();
    const sig = Array.from(blocks).sort().join(',');
    const key = from + '>' + to;
    const hit = civRoutes.get(key);
    if (hit && hit.sig === sig && Game.time - hit.at < 100) return hit.ok;
    let ok = true;
    try { ok = Array.isArray(map.findRoute(from, to, { routeCallback: (r) => (r !== to && danger.has(r) ? Infinity : 1) })); } catch (e) { ok = true; }
    civRoutes.set(key, { ok, at: Game.time, sig });
    return ok;
}

/** 10-16 战略：可见的非己方房里非 NPC 玩家带 RANGED_ATTACK 的 creep 坐标（按 tick 一份）→ { 房: [{x,y}] } */
function rangedThreats() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.rangedThreat && state.rangedThreat.tick === tick) return state.rangedThreat.rooms;
    const rooms = {};
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    const hostileKind = typeof FIND_HOSTILE_CREEPS === 'undefined' ? 'hostileCreeps' : FIND_HOSTILE_CREEPS;
    for (const name of Object.keys(gameRooms)) {
        const room = gameRooms[name];
        if (!room || typeof room.find !== 'function' || (room.controller && room.controller.my)) continue;
        const list = (room.find(hostileKind) || []).filter((c) => c.owner && NPC_OWNERS.indexOf(c.owner.username) < 0 &&
            (c.body || []).some((p) => (p.type || p) === 'ranged_attack'));
        if (list.length) rooms[name] = list.map((c) => ({ x: c.pos.x, y: c.pos.y }));
    }
    state.rangedThreat = { tick, rooms };
    return rooms;
}
/** 非战斗 creep 绕开玩家远程 creep 3 格：costCallback 只改有远程威胁的房（轮子带 costCallback 时每 tick 重算，所以只在出发房/目的房有威胁时挂上） */
function rangedAvoidCallback(threats) {
    return function (roomName, costMatrix) {
        const list = threats[roomName];
        if (!list || !costMatrix || typeof costMatrix.set !== 'function') return costMatrix;
        for (const t of list) {
            for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
                const x = t.x + dx, y = t.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                if (costMatrix.get(x, y) >= 255) continue;
                costMatrix.set(x, y, 250);
            }
        }
        return costMatrix;
    };
}
function applyRangedAvoidance(creep, pos, moveOpts) {
    if (moveOpts.costCallback !== undefined || isCombatCreep(creep)) return;
    const threats = rangedThreats();
    if (!threats[creep.pos.roomName] && !threats[pos.roomName]) return;
    moveOpts.costCallback = rangedAvoidCallback(threats);
}

function applyDangerAvoidance(creep, pos, moveOpts) {
    if (moveOpts.avoidRooms !== undefined || !creep.pos || pos.roomName === creep.pos.roomName) return;
    const base = isCombatCreep(creep) ? dangerRooms() : civilianDangerRooms();
    if (!base.size) return;
    if (!base.has(pos.roomName)) { moveOpts.avoidRooms = base; return; }
    const rooms = new Set(base);
    rooms.delete(pos.roomName);   // 目的地永远不避
    if (rooms.size) moveOpts.avoidRooms = rooms;
}

/** SK 房里已知的 keeper lair 坐标：房内视野 FIND keeperLair ∪ Memory.map[房].lairPos（intel 写入，无视野也能绕）。去重。 */
function knownLairs(roomName) {
    const out = [];
    const seen = new Set();
    const add = (x, y) => { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); out.push({ x, y }); } };
    const lairType = typeof STRUCTURE_KEEPER_LAIR !== 'undefined' ? STRUCTURE_KEEPER_LAIR : 'keeperLair';
    const room = typeof Game !== 'undefined' && Game.rooms ? Game.rooms[roomName] : null;
    if (room && typeof room.find === 'function') {
        for (const s of room.find(FIND_STRUCTURES)) if (s && s.structureType === lairType && s.pos) add(s.pos.x, s.pos.y);
    }
    const map = typeof Memory !== 'undefined' && Memory.map;
    const entry = map && map[roomName];
    if (entry && Array.isArray(entry.lairPos)) {
        for (const p of entry.lairPos) if (p && typeof p.x === 'number' && typeof p.y === 'number') add(p.x, p.y);
    }
    return out;
}

/** 遥测：creep 若在有 lair 的房，把它到最近 lair 的 Chebyshev 距离记进 Memory.keeperTransit[room]（取最小，反映本次过境贴得多近）。
 *  供私服生效断言验证 claimer/pioneer 穿 SK 房时确实保持了距离（对照 config.keeperAvoid.range）。claimer/pioneer 每 tick 跨房行进时调。 */
function noteKeeperTransit(creep) {
    if (!creep || !creep.pos || typeof Memory === 'undefined') return;
    const room = creep.pos.roomName;
    const lairs = knownLairs(room);
    if (!lairs.length) return;
    let min = Infinity;
    for (const l of lairs) {
        const d = Math.max(Math.abs(l.x - creep.pos.x), Math.abs(l.y - creep.pos.y));
        if (d < min) min = d;
    }
    if (!isFinite(min)) return;
    const store = Memory.keeperTransit || (Memory.keeperTransit = {});
    if (store[room] == null || min < store[room]) store[room] = min;
}

/** keeper lair 规避 costCallback：在有 lair 的房（SK 房）给每个 lair 周围 range 格加成本（(range-dist+1)*weight），
 *  逼寻路贴远缘绕开 keeper 杀伤圈；非 SK 房（无 lair）原样返回，墙(255)保留。供 claimer/pioneer 穿 SK 房时显式传给 go()。
 *  注意：轮子对带 costCallback 的移动每 tick 重算路径（pathOptionsKey 带 @Game.time），只给数量少、一次性长途的 claimer/pioneer 用，别给高频 creep。 */
function keeperAvoidCallback() {
    const cfg = (config && config.keeperAvoid) || {};
    const range = Math.max(1, Number(cfg.range) || 5);
    const weight = Math.max(1, Number(cfg.weight) || 40);
    return function (roomName, costMatrix) {
        if (!costMatrix || typeof costMatrix.set !== 'function' || typeof costMatrix.get !== 'function') return costMatrix;
        const lairs = knownLairs(roomName);
        if (!lairs.length) return costMatrix;
        for (const l of lairs) {
            for (let dx = -range; dx <= range; dx++) {
                for (let dy = -range; dy <= range; dy++) {
                    const x = l.x + dx;
                    const y = l.y + dy;
                    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (dist > range) continue;
                    const cur = costMatrix.get(x, y);
                    if (cur >= 255) continue;   // 墙/不可走保持不变
                    costMatrix.set(x, y, Math.min(254, cur + (range - dist + 1) * weight));
                }
            }
        }
        return costMatrix;
    };
}

/** 只避"他人占领（有塔）的房"、放行 SK 房（交给 keeperAvoidCallback 保持距离穿过）——claimer/pioneer 显式传给 go()，
 *  覆盖 applyDangerAvoidance 的默认「整房避 SK」。按 tick 缓存（avoidRooms 进路径缓存 key，要稳定、与出发房无关）。 */
function hostileTerritoryRooms() {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (state.hostileTerritory && state.hostileTerritory.tick === tick) return state.hostileTerritory.rooms;
    const rooms = new Set();
    const map = typeof Memory !== 'undefined' && Memory.map;
    const gameRooms = typeof Game !== 'undefined' && Game.rooms || {};
    for (const name of Object.keys(map && typeof map === 'object' ? map : {})) {
        const entry = map[name];
        if (!entry || typeof entry !== 'object') continue;
        const visible = gameRooms[name];
        if (visible && visible.controller && visible.controller.my) continue;   // 自家房
        if (entry.owner) rooms.add(name);   // 他人占领的房（塔火）；SK 房无 owner、不在此列，交给 lair 规避
    }
    state.hostileTerritory = { tick, rooms };
    return rooms;
}

/** 两房之间有没有不穿危险房（dangerRooms：SK 房、他人占领的房）的路线。默认移动（applyDangerAvoidance）跨房时整房避开这些房，
 *  没有这样的路线时 creep 只会原地寻路烧 CPU——"派 creep 长驻别房"的决策（援建）先用它挡掉必然到不了的派遣
 *  （线上 2026-09-15：W35S7 → W37S5 只能穿 SK 房，援建矿工在母房原地寻路 18 小时，还占着 W37S5 的矿工编制）。
 *  口径故意用 dangerRooms 而不是 hostileTerritoryRooms：只有 claimer/pioneer 显式放行 SK 房（keeperAvoidCallback 贴远缘穿过），
 *  援建的 harvester/hauler/builder/courier 走默认避让，SK 环外的房对它们就是到不了；哪天给它们放行 SK，这里要换成同一个集合。
 *  Game.map.findRoute 按房间出口算，目的地永远不避（与 applyDangerAvoidance 同）；结果按 (from, to) 缓存 cacheTicks，
 *  危险房集合变化（新占领/清掉的房）立即失效。地图 API 不可用时放行；findRoute 抛错照常抛给调用方、不缓存 */
const safeRoutes = new Map();   // 'from>to' → { ok, at, sig }；global 重置即清空
let safeRouteDanger = null;     // 上次算签名用的 dangerRooms 集合（按 tick 一份，同一 tick 不重算签名）
let safeRouteSig = '';
function safeRouteExists(from, to, cacheTicks) {
    if (!from || !to || from === to) return true;
    const map = typeof Game !== 'undefined' && Game.map;
    if (!map || typeof map.findRoute !== 'function') return true;
    const now = Game.time;
    const ttl = Number(cacheTicks) > 0 ? Number(cacheTicks) : 1000;
    const danger = dangerRooms();
    if (safeRouteDanger !== danger) {
        safeRouteDanger = danger;
        safeRouteSig = Array.from(danger).sort().join(',');
    }
    const key = from + '>' + to;
    const hit = safeRoutes.get(key);
    if (hit && hit.sig === safeRouteSig && now >= hit.at && now - hit.at < ttl) return hit.ok;
    const route = map.findRoute(from, to, { routeCallback: (roomName) => (roomName !== to && danger.has(roomName) ? Infinity : 1) });
    const ok = Array.isArray(route);
    safeRoutes.set(key, { ok, at: now, sig: safeRouteSig });
    return ok;
}

function resetSafeRoutes() {
    safeRoutes.clear();
    safeRouteDanger = null;
    safeRouteSig = '';
}

function go(creep, target, opts) {
    state.stats.calls += 1;
    const pos = toPos(creep, target, opts);
    if (!pos || !creep || !creep.pos || typeof creep.moveTo !== 'function') {
        state.stats.invalidTargets += 1;
        return resultCode('ERR_INVALID_TARGET', -7);
    }

    const moveOpts = normalizeOpts(creep, opts);
    if (rangeBetween(creep.pos, pos) <= moveOpts.range) {
        state.stats.inRange += 1;
        return resultCode('OK', 0);
    }
    // 10-16：非战斗 creep 跨房时目的地/整条路被高速路玩家部队封住 → 原地等
    if (pos.roomName !== creep.pos.roomName && moveOpts.avoidRooms === undefined && !isCombatCreep(creep) &&
        !civilianRouteOk(creep.pos.roomName, pos.roomName)) {
        state.stats.blockedWaits = (state.stats.blockedWaits || 0) + 1;
        if (creep.memory) creep.memory.blockedWait = Game.time;
        return resultCode('ERR_NO_PATH', -2);
    }
    applyDangerAvoidance(creep, pos, moveOpts);
    applyRangedAvoidance(creep, pos, moveOpts);

    const loaded = loadEngine();
    if (loaded) {
        for (const key of UNSUPPORTED_MOVE_OPTIONS) delete moveOpts[key];
        state.stats.engineCalls += 1;
    } else {
        state.stats.nativeCalls += 1;
    }
    return creep.moveTo(pos, moveOpts);
}

function memoryRoom(roomName) {
    if (!roomName || typeof Memory === 'undefined' || !Memory.rooms) return null;
    return Memory.rooms[roomName] || null;
}

function roomObject(roomName, creep) {
    if (typeof Game !== 'undefined' && Game.rooms && Game.rooms[roomName]) return Game.rooms[roomName];
    return creep && creep.room && creep.room.name === roomName ? creep.room : null;
}

function objectById(id) {
    if (!id || typeof Game === 'undefined' || typeof Game.getObjectById !== 'function') return null;
    return Game.getObjectById(id);
}

function activePart(creep, type) {
    const constant = runtimeGlobal[type.toUpperCase()] === undefined ? type : runtimeGlobal[type.toUpperCase()];
    if (creep && typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(constant) > 0;
    return !!(creep && creep.body || []).find((part) =>
        (part.type || part) === constant && (part.hits == null || part.hits > 0));
}

function energyKey() {
    return runtimeGlobal.RESOURCE_ENERGY === undefined ? 'energy' : runtimeGlobal.RESOURCE_ENERGY;
}

function storedEnergy(creep) {
    return creep && creep.store ? creep.store[energyKey()] || 0 : 0;
}

function freeCapacity(creep) {
    if (!creep || !creep.store || typeof creep.store.getFreeCapacity !== 'function') return null;
    return creep.store.getFreeCapacity(energyKey());
}

function structuresAt(room, spot) {
    if (!room || !spot || typeof room.lookForAt !== 'function') return [];
    const look = runtimeGlobal.LOOK_STRUCTURES === undefined ? 'structure' : runtimeGlobal.LOOK_STRUCTURES;
    const found = room.lookForAt(look, spot.x, spot.y);
    return Array.isArray(found) ? found : [];
}

function hasStructure(room, spot, typeName) {
    const type = runtimeGlobal[typeName] === undefined ? typeName.replace(/^STRUCTURE_/, '').toLowerCase() : runtimeGlobal[typeName];
    return structuresAt(room, spot).some((structure) => structure.structureType === type);
}

function sourceList(room) {
    const findSources = runtimeGlobal.FIND_SOURCES;
    if (!room || findSources === undefined || typeof room.find !== 'function') return [];
    const sources = room.find(findSources);
    return Array.isArray(sources) ? sources : [];
}

function harvesterSource(creep, room, roomMemory, plan) {
    const creepMemory = creep.memory || {};
    let source = objectById(creepMemory.sourceId);
    if (source) return source;
    const sources = sourceList(room);
    const ids = Array.isArray(plan && plan.sourceIds) ? plan.sourceIds :
        (Array.isArray(roomMemory && roomMemory.sources) ? roomMemory.sources : []);
    let index = Number.isInteger(creepMemory.sourceIdx) ? creepMemory.sourceIdx : 0;
    if (creepMemory.sourceId && ids.length) {
        const idIndex = ids.indexOf(creepMemory.sourceId);
        if (idIndex >= 0) index = idIndex;
    }
    if (ids[index]) source = sources.find((item) => item.id === ids[index]);
    return source || sources[index] || sources[0] || null;
}

function harvesterIndex(creep, roomMemory, plan) {
    const creepMemory = creep.memory || {};
    const ids = Array.isArray(plan && plan.sourceIds) ? plan.sourceIds :
        (Array.isArray(roomMemory && roomMemory.sources) ? roomMemory.sources : []);
    if (creepMemory.sourceId && ids.length) {
        const index = ids.indexOf(creepMemory.sourceId);
        if (index >= 0) return index;
    }
    return Number.isInteger(creepMemory.sourceIdx) ? creepMemory.sourceIdx : 0;
}

// ---- 工位判定（轮子 endTickResolve 的 isWorkTile）：每 creep 每 tick 只算一次贵的那一半 ----
// 轮子的堵车解算会为「挡路的 creep × 候选格」反复调 isWorkTile，task_broker.finishCreep 也为每只带 WORK 的矿工/升级者问一次；
// 而判定里真正贵的部分（找源、找工位、lookForAt 容器/link、算升级者锚点）与 pos 无关、tick 内不变。
// 拆成「spec（贵且 tick 内稳定，按 creep 缓存）+ 逐次判定（便宜、tick 内会变）」：
//   null              → 判定不适用，永远算工位（返回 true）
//   {exact}           → 必须正好站在这一格（静态矿工、远程矿工）
//   {near, range}     → 离目标 range 格内（往返/落地矿工、无锚点的升级者）
//   {station, ctrl}   → 升级者：锚点 1 格内且 controller 3 格内（layout.atUpgraderStation），storage 站位另认 ctrl link 旁
// 每 tick 会变的几项留给逐次判定：空载的升级者（idle 'empty'）、满仓/源枯竭的往返矿工（idle 'hauling'）、
// 外矿记录被停用（record，tick 中途可能被别的 creep 看到敌人停掉）。
// 缓存按 creep 对象身份命中（同一 tick 里 Game.creeps 的对象不变；单测同一 Game.time 重建的同名 creep 不会串用）。
// 遥测 workTileCalls / workTileComputes 的比值就是省下的倍数。
const workTileState = { tick: -1, byCreep: {} };

function harvesterWorkSpec(creep) {
    const home = creep.memory && creep.memory.home;
    if (!home || !creep.pos || creep.pos.roomName !== home) return null;
    const roomMemory = memoryRoom(home) || {};
    if (roomMemory.state && roomMemory.state.emergencyHarvest) return null;
    const room = roomObject(home, creep);
    const plan = roomMemory.plan || {};
    const source = harvesterSource(creep, room, roomMemory, plan);
    if (!source || !source.pos) return null;

    const index = harvesterIndex(creep, roomMemory, plan);
    const key = 'src' + index;
    const containerSpot = plan.containers && plan.containers[key];
    const workSpot = plan.workPositions && plan.workPositions[key] || containerSpot;
    const links = plan.links || {};
    const linkSpot = links[key] || (index === 0 ? links.src : null);
    const staticMode = workSpot && (hasStructure(room, containerSpot, 'STRUCTURE_CONTAINER') ||
        hasStructure(room, linkSpot, 'STRUCTURE_LINK'));
    if (staticMode) return { exact: { x: workSpot.x, y: workSpot.y, roomName: home } };

    if (creep.memory.dropMiner || !activePart(creep, 'carry')) return { near: source.pos, range: 1 };
    // 往返型矿工：满仓 / 源枯竭且手里有货时它不在"工作"，这两项 tick 内会变，留给逐次判定
    return { near: source.pos, range: 1, idle: 'hauling', source };
}

function upgraderWorkSpec(creep) {
    const home = creep.memory && creep.memory.home;
    // storedEnergy 不进 spec：空载的升级者不在工作（轮子约定返回 true），而它在 tick 内会变
    if (!home || !creep.pos || creep.pos.roomName !== home) return null;
    const roomMemory = memoryRoom(home) || {};
    if (roomMemory.state && roomMemory.state.emergencyHarvest) return null;
    const room = roomObject(home, creep);
    const controller = room && room.controller;
    if (!controller || !controller.pos) return null;
    // 与 roles/upgrader 共用 layout.upgraderStation/atUpgraderStation：锚点（storage / ctrl link / 容器）1 格内且 controller 3 格内即工位。
    // 只认容器那一格会把站在锚点旁的第二只升级者、或 storage 站位上的升级者当闲人推开（线上 2026-09-05 W33S7 乒乓）
    const station = layout.upgraderStation(room, roomMemory.plan || {});
    if (station && station.anchor) {
        // storage 站位的升级者也可能在 ctrl link 旁喝（站位格被占 / storage 取不出 / 站位够不着堵满的 link，roles/upgrader）：那格同样是工位
        const linkSpot = station.storageFed && typeof layout.linkSpot === 'function' ? layout.linkSpot(roomMemory.plan || {}, 'ctrl') : null;
        return { station, controller, linkSpot: linkSpot || null, idle: 'empty' };
    }
    return { near: controller.pos, range: 3, idle: 'empty' };
}

function remoteSourceRecord(creep, record) {
    const rawSources = record && record.sources;
    const sources = Array.isArray(rawSources) ? rawSources :
        (rawSources && typeof rawSources === 'object' ? Object.values(rawSources) : []);
    const sourceId = creep.memory && creep.memory.sourceId;
    if (sourceId) {
        const exact = sources.find((source) => source && source.id === sourceId);
        if (exact) return exact;
    }
    const index = Number.isInteger(creep.memory && creep.memory.srcIdx) ? creep.memory.srcIdx : 0;
    return sources[index] || sources[0] || null;
}

function remoteMinerWorkSpec(creep) {
    const creepMemory = creep.memory || {};
    const home = creepMemory.home;
    const remoteRoom = creepMemory.remoteRoom;
    if (!home || !remoteRoom || !creep.pos || creep.pos.roomName !== remoteRoom) return null;
    const homeMemory = memoryRoom(home);
    const record = homeMemory && homeMemory.remotes && homeMemory.remotes[remoteRoom];
    if (!record) return null;
    const source = remoteSourceRecord(creep, record);
    if (!source || !source.spot) return null;
    // 停用/暂停逐次判定（record 引用随 spec 走）：tick 中途被看到敌人停掉的外矿，矿工当场不算在工作
    return { exact: { x: source.spot.x, y: source.spot.y, roomName: remoteRoom }, record };
}

function workSpecFor(creep, now) {
    if (workTileState.tick !== now) { workTileState.tick = now; workTileState.byCreep = {}; }
    const name = creep.name;
    const cached = name ? workTileState.byCreep[name] : null;
    if (cached && cached.creep === creep) return cached.spec;
    state.stats.workTileComputes += 1;
    const role = creep.memory.role;
    let spec = null;
    if (role === 'harvester') spec = harvesterWorkSpec(creep);
    else if (role === 'upgrader') spec = upgraderWorkSpec(creep);
    else if (role === 'remoteMiner') spec = remoteMinerWorkSpec(creep);
    if (name) workTileState.byCreep[name] = { creep, spec };
    return spec;
}

function isWorkTile(creep, pos) {
    try {
        if (!creep || !creep.memory || !pos) return true;
        const role = creep.memory.role;
        if (role !== 'harvester' && role !== 'upgrader' && role !== 'remoteMiner') return true;
        state.stats.workTileCalls += 1;
        const now = typeof Game !== 'undefined' && typeof Game.time === 'number' ? Game.time : 0;
        const spec = workSpecFor(creep, now);
        if (!spec) return true;
        // tick 内会变的几项逐次判定（便宜），spec 里只放贵且稳定的部分
        if (spec.idle === 'empty' && storedEnergy(creep) <= 0) return true;
        if (spec.idle === 'hauling') {
            const free = freeCapacity(creep);
            if (free == null || free <= 0 || (spec.source.energy <= 0 && storedEnergy(creep) > 0)) return true;
        }
        if (spec.record && (spec.record.enabled === false || spec.record.suspendedUntil > now)) return true;
        if (spec.exact) return rangeBetween(pos, spec.exact) === 0;
        if (spec.station) {
            if (layout.atUpgraderStation(pos, spec.station, spec.controller)) return true;
            const spot = spec.linkSpot;
            return !!spot && rangeBetween(pos, { x: spot.x, y: spot.y, roomName: pos.roomName }) <= 1 && rangeBetween(pos, spec.controller.pos) <= 3;
        }
        return rangeBetween(pos, spec.near) <= spec.range;
    } catch (error) {
        state.stats.workTileErrors += 1;
        return true;
    }
}

// ---- 路网变了就让轮子重算这个房 ----------------------------------------------------------------
// 轮子只给"他人的房"和新手墙/部署中核心/中央传送门设 costMatrix 清理计时；己方房与外矿房的 costMatrix、以及同房缓存路径
// 在一个 global 里从不过期，之后修好的路 creep 看不见（满载 2C:1M 走平地每格 2 tick）、烂掉/拆掉的路还照走
// （线下 harness 用真轮子验证：新修 13 格路后新 creep 的路径 0 格走路；deletePathInRoom 之后 10 格走路；
// 私服分叉从同一快照起跑时 W31S6 hauler 11% 的 tick 卡在疲劳上）。每房按名错峰每 ROAD_SIG_INTERVAL tick 核一次
// 签名（道路数 : 障碍建筑数），变了就 invalidateRoom；同一房两次重算至少隔 ROAD_SIG_MIN_GAP tick——重算让经过该房的
// creep 各重新寻路一次（每只 0.5–2 CPU），又要扫一遍全部缓存路径，所以限频；间隔内的变化保留旧签名，下一次核对时再触发。
// 工地不进签名：挡路的新工地轮子自己会处理（撞上后停约 5 tick 自动换路），放工地又是成批的，算进来会频繁重算
const ROAD_SIG_INTERVAL = 50;
const ROAD_SIG_MIN_GAP = 200;
const FALLBACK_OBSTACLES = ['spawn', 'creep', 'powerCreep', 'source', 'mineral', 'deposit', 'controller', 'constructedWall', 'extension',
    'link', 'storage', 'tower', 'observer', 'powerSpawn', 'powerBank', 'lab', 'terminal', 'nuker', 'factory', 'invaderCore'];
let obstacleTypes = null;

function isObstacleType(type) {
    if (!obstacleTypes) {
        const list = typeof OBSTACLE_OBJECT_TYPES !== 'undefined' && Array.isArray(OBSTACLE_OBJECT_TYPES) ? OBSTACLE_OBJECT_TYPES : FALLBACK_OBSTACLES;
        obstacleTypes = new Set(list);
    }
    return obstacleTypes.has(type);
}

/** 单格坐标的 32 位混合（murmur3 fmix32）：直接求 Σ cell×K 是线性的，拆两格、修两格只要格号之和相等就抵消 */
function mixCell(cell, seed) {
    let h = (cell ^ seed) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}

/** 签名 = 道路坐标哈希 : 障碍坐标哈希（逐格混合后求和：与遍历顺序无关；"一条路烂掉、另一格新修"数量不变也会变） */
function roomNetworkSignature(room) {
    const structures = utils.findCached(room, typeof FIND_STRUCTURES !== 'undefined' ? FIND_STRUCTURES : 'structures') || [];
    const roadType = typeof STRUCTURE_ROAD !== 'undefined' ? STRUCTURE_ROAD : 'road';
    const rampartType = typeof STRUCTURE_RAMPART !== 'undefined' ? STRUCTURE_RAMPART : 'rampart';
    let roads = 0;
    let obstacles = 0;
    for (const structure of structures) {
        const type = structure && structure.structureType;
        const pos = structure && structure.pos;
        if (!pos) continue;
        const cell = pos.x * 50 + pos.y + 1;
        if (type === roadType) roads = (roads + mixCell(cell, 0x9e3779b9)) >>> 0;
        else if (isObstacleType(type) || (type === rampartType && structure.my === false && !structure.isPublic)) {
            obstacles = (obstacles + mixCell(cell, 0x7f4a7c15)) >>> 0;
        }
    }
    return roads.toString(36) + ':' + obstacles.toString(36);
}

function refreshRoomNetworks() {
    if (typeof Game === 'undefined' || !Game.rooms) return;
    state.networks = state.networks || {};
    for (const name of Object.keys(Game.rooms)) {
        if (!utils.isRoomPhaseTick(name, ROAD_SIG_INTERVAL)) continue;
        const sig = roomNetworkSignature(Game.rooms[name]);
        const entry = state.networks[name];
        if (!entry) { state.networks[name] = { sig, inv: -Infinity }; continue; }
        if (entry.sig === sig || Game.time - entry.inv < ROAD_SIG_MIN_GAP) continue;
        // bucket 见底时顺延（重算让经过该房的 creep 各重新寻路一次）
        if (Game.cpu && typeof Game.cpu.bucket === 'number' && Game.cpu.bucket < 1000) continue;
        invalidateRoom(name);
        entry.sig = sig;
        entry.inv = Game.time;
        state.stats.networkInvalidations = (Number(state.stats.networkInvalidations) || 0) + 1;
        // 遥测（私服生效断言 movement.pathRefreshOnRoads）：房间路网变化后重算的次数
        if (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[name]) {
            const rec = Memory.rooms[name].pathRefresh || (Memory.rooms[name].pathRefresh = { n: 0 });
            rec.n = (Number(rec.n) || 0) + 1;
            rec.at = Game.time;
            rec.sig = sig;
            if (Game.rooms[name]) rec.regen = (Number(rec.regen) || 0) + 1;   // 可见房：matrix 当场重建
        }
    }
}

function beginTick() {
    state.stats.beginTicks += 1;
    try { refreshRoomNetworks(); } catch (error) { state.lastNetworkError = error && error.message ? error.message : String(error); }
    return callEngine('preTickBetterMove', arguments);
}

function endTick(userIsWorkTile) {
    state.stats.endTicks += 1;
    return callEngine('endTickResolve', [typeof userIsWorkTile === 'function' ? userIsWorkTile : isWorkTile]);
}

function invalidateRoom(roomName) {
    if (!roomName) return resultCode('ERR_INVALID_ARGS', -10);
    state.stats.invalidations += 1;
    const loaded = loadEngine();
    if (!loaded) return undefined;
    // 项目补丁 refreshRoom：删缓存路径并当场重建可见房的 costMatrix（否则重建之前算出的跨房路径对这个房只看地形）
    if (typeof loaded.refreshRoom === 'function') return loaded.refreshRoom(roomName);
    const matrixResult = typeof loaded.deleteCostMatrix === 'function' ? loaded.deleteCostMatrix(roomName) : undefined;
    const pathResult = typeof loaded.deletePathInRoom === 'function' ? loaded.deletePathInRoom(roomName) : undefined;
    return pathResult === undefined ? matrixResult : pathResult;
}

/** 只让这一只 creep 重新寻路（项目补丁 resetCreepPath）：丢它的缓存路径与正在走的共享路径，不动 costMatrix、不扫全房。
 *  引擎没有这个补丁时什么也不做——不退回 invalidateRoom（那正是要避开的全房重算，绕过 refreshRoomNetworks 的限频） */
function resetCreepPath(creep) {
    const name = creep && typeof creep === 'object' ? creep.name : creep;
    if (!name) return resultCode('ERR_INVALID_ARGS', -10);
    state.stats.creepResets += 1;
    const loaded = loadEngine();
    if (!loaded || typeof loaded.resetCreepPath !== 'function') return undefined;
    return loaded.resetCreepPath(name);
}

function stats() {
    return {
        calls: state.stats.calls,
        engineCalls: state.stats.engineCalls,
        nativeCalls: state.stats.nativeCalls,
        inRange: state.stats.inRange,
        invalidTargets: state.stats.invalidTargets,
        invalidations: state.stats.invalidations,
        creepResets: state.stats.creepResets,
        beginTicks: state.stats.beginTicks,
        endTicks: state.stats.endTicks,
        engineLoadErrors: state.stats.engineLoadErrors,
        workTileErrors: state.stats.workTileErrors,
        workTileCalls: state.stats.workTileCalls,
        workTileComputes: state.stats.workTileComputes,
        avoidKeptPaths: engine && typeof engine.avoidKeptPaths === 'function' ? engine.avoidKeptPaths() : 0,
        engineAvailable: !!engine,
        lastEngineError: state.lastEngineError || null,
    };
}

function passthrough(name) {
    return function () {
        return callEngine(name, arguments);
    };
}

api = {
    go,
    dangerRooms,
    beginTick,
    endTick,
    isWorkTile,
    invalidateRoom,
    resetCreepPath,
    keeperAvoidCallback,
    hostileTerritoryRooms,
    safeRouteExists, frozenOwnerRooms, rangedThreats, rangedAvoidCallback, highwayBlocks, civilianDangerRooms, civilianRouteOk, isHighwayRoom, isCombatCreep,
    resetSafeRoutes,
    knownLairs,
    noteKeeperTransit,
    stats,
    preTickBetterMove: beginTick,
    endTickResolve: passthrough('endTickResolve'),
    squadMove: passthrough('squadMove'),
    squadMoveTo: passthrough('squadMoveTo'),
    getSquadCostMatrix: passthrough('getSquadCostMatrix'),
    setPathClearDelay: passthrough('setPathClearDelay'),
    setHostileCostMatrixClearDelay: passthrough('setHostileCostMatrixClearDelay'),
    deleteCostMatrix: passthrough('deleteCostMatrix'),
    deletePath: passthrough('deletePath'),
    deletePathInRoom: passthrough('deletePathInRoom'),
    addAvoidRooms: passthrough('addAvoidRooms'),
    deleteAvoidRooms: passthrough('deleteAvoidRooms'),
    addAvoidExits: passthrough('addAvoidExits'),
    deleteAvoidExits: passthrough('deleteAvoidExits'),
    print: passthrough('print'),
    clear: passthrough('clear'),
};

module.exports = api;
