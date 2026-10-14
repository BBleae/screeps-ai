'use strict';

const config = require('config');
const brain = require('brain');
const wheelLayout = require('wheel_layout');
const defense = require('defense');
const movement = require('movement');
const { logErr, bodyCost, bodyPartCount, roomCoords, roomDistance, isRetiring, roomPhase, creepsHomeRole } = require('utils');

function positiveSetting(name, fallback) {
    const value = config.remote && config.remote[name];
    return typeof value === 'number' && value > 0 ? value : fallback;
}

const HOSTILE_COOLDOWN = positiveSetting('hostileSuspend', 150);
const RESERVATION_BUFFER = positiveSetting('reservationBuffer', 25);
const DEMAND_BUFFER = 100;
const SPAWN_TICKS_PER_PART = typeof CREEP_SPAWN_TIME === 'number' ? CREEP_SPAWN_TIME : 3;
// 外矿同时在建的工地数：维护型 remoteHauler 回程会停下把范围内的路修完，一次放多段才能一趟修好几格
const MAX_REMOTE_SITES = 6;
const MIN_RESIDUAL_CARRY = 4;
const INFRA_INTERVAL = positiveSetting('roadSiteInterval', 11);
const INFRA_REFRESH = 25;
const MEMORY_VERSION = 1;
const DISTANCE_VERSION = 3;

const ATTACK_PART = typeof ATTACK === 'undefined' ? 'attack' : ATTACK;
const RANGED_ATTACK_PART = typeof RANGED_ATTACK === 'undefined' ? 'ranged_attack' : RANGED_ATTACK;
const HEAL_PART = typeof HEAL === 'undefined' ? 'heal' : HEAL;
const WORK_PART = typeof WORK === 'undefined' ? 'work' : WORK;
const CLAIM_PART = typeof CLAIM === 'undefined' ? 'claim' : CLAIM;
const INVADER_CORE = typeof STRUCTURE_INVADER_CORE === 'undefined' ? 'invaderCore' : STRUCTURE_INVADER_CORE;
// 编制摊销用的寿命：普通 creep 1500、带 CLAIM 的 reserver 600（引擎常量）
const CREEP_LIFE = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
const CLAIM_LIFE = typeof CREEP_CLAIM_LIFE_TIME === 'number' ? CREEP_CLAIM_LIFE_TIME : 600;

function sourceRecord(raw) {
    const pos = raw && raw.pos || {};
    const spot = raw && raw.spot || null;
    return {
        id: raw && raw.id || null,
        pos: { x: pos.x || 0, y: pos.y || 0 },
        spot: spot ? { x: spot.x, y: spot.y } : null,
        distance: raw && raw.distance || 0,
        distanceVersion: raw && raw.distanceVersion || 0,
        distanceIncomplete: !!(raw && raw.distanceIncomplete),
        distanceAt: raw && raw.distanceAt || 0,
        energyCapacity: raw && raw.energyCapacity || 0,
        containerId: raw && raw.containerId || null,
        road: raw && raw.road || '',
        routePlanAt: raw && raw.routePlanAt || 0,
        roadComplete: !!(raw && raw.roadComplete),
    };
}

function remoteRecord(roomName, raw) {
    raw = raw || {};
    let sources = [];
    if (Array.isArray(raw.sources)) sources = raw.sources.map(sourceRecord);
    else if (raw.sources && typeof raw.sources === 'object') sources = Object.values(raw.sources).map(sourceRecord);
    const reservation = raw.reservation || {};
    return {
        room: roomName,
        enabled: raw.enabled !== false,
        sourceCount: raw.sourceCount || (typeof raw.sources === 'number' ? raw.sources : sources.length),
        lastSeen: raw.lastSeen || 0,
        suspendedUntil: raw.suspendedUntil || 0,
        suspendReason: raw.suspendReason || null,
        clearReservation: raw.clearReservation === true,
        // 不可达退避：连续标记次数（有 creep 看到该房后清零）与最后一次标记的 tick（getDemands 的试探式恢复看它）
        unreachableCount: raw.unreachableCount || 0,
        unreachableAt: raw.unreachableAt || 0,
        controllerId: raw.controllerId || null,
        controllerPos: raw.controllerPos || null,
        controllerDistance: raw.controllerDistance || 0,
        controllerDistanceVersion: raw.controllerDistanceVersion || 0,
        controllerDistanceIncomplete: !!raw.controllerDistanceIncomplete,
        controllerDistanceAt: raw.controllerDistanceAt || 0,
        reservation: {
            username: reservation.username || null,
            ticksToEnd: reservation.ticksToEnd || 0,
            seenAt: reservation.seenAt || 0,
        },
        sources,
        infrastructureComplete: !!raw.infrastructureComplete,
        drop: raw.drop || null,
        // Source Keeper 房（config.sk）：多一只常驻的 skReaper 杀守卫，没有 controller 所以不派 reserver
        sk: !!raw.sk,
        // keeper lair 数（静态地物，看到一次就记住；refreshVisible 据此判断是不是 keeper 房）
        lairs: raw.lairs == null ? null : Number(raw.lairs),
    };
}

// ---- Source Keeper 采矿（config.sk，默认关） ----
const KEEPER_OWNER = 'Source Keeper';

function skSettings() {
    return Object.assign({ enabled: false, minRcl: 7, maxRoomsPerHome: 1, reaperUnits: 12, reaperMinUnits: 9,
        keeperSafeRange: 4, reaperStandoff: 3, lairWarnTicks: 10, minerWork: 7,
        maxReaperLosses: 2, lossWindow: 3000, lossCooldown: 5000 }, config.sk || {});
}

/** 开关：大脑指令 rooms[母房].skMining（布尔）优先，否则 config.sk.enabled */
function skEnabled(homeName) {
    const order = brain.get(homeName, 'skMining', undefined);
    if (typeof order === 'boolean') return order;
    return skSettings().enabled === true;
}

/** 这个母房现在能不能开 SK 矿：开关打开 + RCL ≥ minRcl */
function skAllowed(home) {
    if (!home || !home.controller || !skEnabled(home.name)) return false;
    return (home.controller.level || 0) >= Math.max(1, Number(skSettings().minRcl) || 7);
}

/** 大脑外矿白名单里有这个房。SK 房只在大脑点名时才收：自治模式（没有白名单）永远不碰 keeper 房 */
function skWhitelisted(homeName, roomName) {
    const whitelist = remoteWhitelist(homeName);
    return Array.isArray(whitelist) && whitelist.includes(roomName);
}

function isKeeper(creep) {
    return !!(creep && creep.owner && creep.owner.username === KEEPER_OWNER);
}

/** 净回血的 reaper 身体：n RANGED + 2n MOVE + n HEAL（HEAL 放最后——引擎从前往后掉部件，最该保住的是治疗）。
 *  组数 < reaperMinUnits（自愈压不住 keeper 的 100/tick）返回 []：不缩身、也不派 */
function skReaperBody(capacity) {
    const cfg = skSettings();
    const units = Math.min(Math.max(1, Number(cfg.reaperUnits) || 12), 12, Math.floor((capacity || 0) / 500));
    if (units < Math.max(1, Number(cfg.reaperMinUnits) || 9)) return [];
    return repeat('ranged_attack', units).concat(repeat('move', units * 2), repeat('heal', units));
}

/** SK 矿工：minerWork 个 WORK（7 = 14/tick 盖住 4000/300）+ 1 CARRY（自建/自修容器）；路铺好前 MOVE 与非 MOVE 1:1，之后一半 */
function skMinerBody(capacity, roadComplete) {
    const cap = capacity || 0;
    const halfMove = roadComplete !== false;
    const maxWork = Math.max(1, Number(skSettings().minerWork) || 7);
    for (let work = maxWork; work >= 2; work--) {
        const move = halfMove ? Math.ceil((work + 1) / 2) : work + 1;
        if (work * 100 + 50 + move * 50 <= cap) return repeat('work', work).concat(['carry'], repeat('move', move));
    }
    return [];
}

/** 这个 SK 房里已经有在岗的 reaper（已进房、未退役）：没有它就不为这个房派矿工/运输工——不把人往枪口上送 */
function reaperOnStation(homeName, roomName) {
    return creepsHomeRole(homeName, 'skReaper').some((creep) => !creep.spawning && !isRetiring(creep.memory) &&
        creep.memory.remoteRoom === roomName && creep.room && creep.room.name === roomName);
}

/** 距 center 恰好 range 格（切比雪夫）、离 from 最近的可走格；没有返回 null。只在需要换位时算，一圈最多 8 × range 格 */
function ringTile(room, center, range, from) {
    if (!room || !center) return null;
    const terrain = typeof room.getTerrain === 'function' ? room.getTerrain() : null;
    const wall = typeof TERRAIN_MASK_WALL === 'number' ? TERRAIN_MASK_WALL : 1;
    let best = null;
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== range) continue;
            const x = center.x + dx;
            const y = center.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (terrain && (terrain.get(x, y) & wall)) continue;
            if (room.lookForAt(LOOK_STRUCTURES, x, y).some((structure) => structure.structureType !== STRUCTURE_ROAD &&
                structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART)) continue;
            const distance = from ? Math.max(Math.abs(from.x - x), Math.abs(from.y - y)) : 0;
            if (!best || distance < best.distance) best = { x, y, distance };
        }
    }
    return best ? new RoomPosition(best.x, best.y, room.name) : null;
}

/** SK 外矿里这只 creep 现在要躲的东西（null = 安全）：keeperSafeRange 内活着的 keeper，或 lairWarnTicks 内就要孵出 keeper 的 lair
 *  （keeper 生在 lair 格上）。返回 { pos, kind }，取最近的。只对 record.sk 的外矿生效：普通外矿压根不该进 keeper 房 */
function keeperThreatFor(creep) {
    if (!creep || !creep.room || !creep.pos || creep.room.name !== creep.memory.remoteRoom) return null;
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (!record || !record.sk) return null;
    const cfg = skSettings();
    const range = Math.max(1, Number(cfg.keeperSafeRange) || 4);
    const warn = Math.max(0, Number(cfg.lairWarnTicks) || 0);
    let closest = null;
    const consider = (pos, kind) => {
        const distance = Math.max(Math.abs(creep.pos.x - pos.x), Math.abs(creep.pos.y - pos.y));
        if (distance > range) return;
        if (!closest || distance < closest.distance) closest = { pos, kind, distance };
    };
    for (const hostile of creep.room.find(FIND_HOSTILE_CREEPS)) if (isKeeper(hostile) && hostile.pos) consider(hostile.pos, 'keeper');
    if (warn > 0) {
        for (const structure of creep.room.find(FIND_STRUCTURES)) {
            if (structure.structureType !== STRUCTURE_KEEPER_LAIR || structure.ticksToSpawn == null) continue;
            if (structure.ticksToSpawn <= warn) consider(structure.pos, 'lair');
        }
    }
    return closest;
}

/** SK 外矿的矿工/运输工：受 keeper 威胁就退到 keeperSafeRange 外（射程 3 外再留 1 格），这一 tick 不干别的；返回是否在退。
 *  不用 keeperAvoidCallback：带 costCallback 的移动每 tick 重算路径，只给一次性长途的 claimer/pioneer 用（movement.js 注释） */
function keeperRetreat(creep) {
    const threat = keeperThreatFor(creep);
    if (!threat) return false;
    const safe = Math.max(1, Number(skSettings().keeperSafeRange) || 4) + 1;
    const spot = ringTile(creep.room, threat.pos, safe, creep.pos);
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (record) record.skRetreat = { at: Game.time, kind: threat.kind, n: (Number(record.skRetreat && record.skRetreat.n) || 0) + 1 };
    if (spot) movement.go(creep, spot, { range: 0, reusePath: 3 });
    return true;
}

/** SK 外矿的开采遥测（roles/remoteMiner 每次 harvest 返回 OK 时调）：record.skHarvest {first, at, n}——私服断言看矿工真的在 keeper 房里采到了 */
function noteSkHarvest(creep, result) {
    if (result !== OK || !creep || !creep.memory) return;
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (!record || !record.sk) return;
    const log = record.skHarvest || (record.skHarvest = { first: Game.time, n: 0 });
    log.n = (Number(log.n) || 0) + 1;
    log.at = Game.time;
}

/** reaper 被打死（main.js 清理死亡 creep 内存时调用；寿终的不算——reaper 每 tick 记 lastTtl）：lossWindow 内达到 maxReaperLosses 次
 *  就把这个 SK 房停 lossCooldown tick（skReaperLost），别每 300 tick 送一只 6000 能量的 reaper */
function noteReaperLoss(name, memory) {
    if (!memory || memory.role !== 'skReaper' || isRetiring(memory)) return false;
    if (!(Number(memory.lastTtl) > 5)) return false;
    const record = getRemote(memory.home, memory.remoteRoom);
    // 只记正在开采的 SK 外矿：已退回 keeperRoom（永久停用、sk=false）或别的原因停用的房，reaper 死了也不再记账——
    // 否则 skReaperLost 会盖掉永久停用的理由，syncKeeperRooms 只认 keeperRoom，这个房再也升级不回 SK 外矿
    if (!record || !record.sk || record.enabled === false || Number(record.suspendedUntil) === Number.MAX_SAFE_INTEGER) return false;
    const cfg = skSettings();
    const log = record.skLosses && Game.time - Number(record.skLosses.at || 0) <= Number(cfg.lossWindow || 3000)
        ? record.skLosses : { n: 0 };
    log.n = (Number(log.n) || 0) + 1;
    log.at = Game.time;
    log.last = name;
    record.skLosses = log;
    if (log.n >= Math.max(1, Number(cfg.maxReaperLosses) || 2)) {
        record.suspendedUntil = Math.max(Number(record.suspendedUntil) || 0, Game.time + Math.max(1, Number(cfg.lossCooldown) || 5000));
        record.suspendReason = 'skReaperLost';
        log.n = 0;
        log.suspendedAt = Game.time;
    }
    return true;
}

/** keeper 房的记录跟着开关走（run() 每 tick 调，白名单处理之后、收新外矿之前）：
 *  - SK 外矿但现在不许开（开关关了 / RCL 掉了 / 不在白名单）：退回永久停用的 keeperRoom，远程 creep 会退役；
 *  - 早先被永久停用的 keeper 房（suspendReason keeperRoom）现在许开、在白名单里、名额没满：升级成 SK 外矿并**完整**撤销那条停用
 *    （否则它永远留在 remotes 里、admitCandidates 又跳过已存在的记录，SK 采矿这辈子开不了工）。别的停用理由一个字都不动 */
function syncKeeperRooms(home, remotes) {
    const allowed = skAllowed(home);
    const limit = Math.max(0, Number(skSettings().maxRoomsPerHome) || 0);
    let count = 0;
    for (const roomName in remotes) {
        const record = remotes[roomName];
        if (!record || !record.sk) continue;
        if (allowed && skWhitelisted(home.name, roomName) && count < limit) { count++; continue; }
        record.sk = false;
        record.enabled = false;
        record.suspendReason = 'keeperRoom';
        record.suspendedUntil = Number.MAX_SAFE_INTEGER;
    }
    if (!allowed) return;
    for (const roomName in remotes) {
        if (count >= limit) break;
        const record = remotes[roomName];
        if (!record || record.sk || !(record.lairs > 0) || record.suspendReason !== 'keeperRoom') continue;
        if (!skWhitelisted(home.name, roomName) || !withinDistance(home.name, roomName)) continue;
        record.sk = true;
        record.enabled = true;
        record.suspendedUntil = 0;
        record.suspendReason = null;
        count++;
    }
}

function homeMemory(homeName) {
    Memory.rooms = Memory.rooms || {};
    const mem = Memory.rooms[homeName] || (Memory.rooms[homeName] = {});
    const raw = mem.remotes;
    if (Array.isArray(raw)) {
        const migrated = {};
        for (const item of raw) {
            const roomName = typeof item === 'string' ? item : item && item.room;
            if (roomName) migrated[roomName] = remoteRecord(roomName, item);
        }
        mem.remotes = migrated;
    } else if (!raw || typeof raw !== 'object') {
        mem.remotes = {};
    } else if (mem.remoteMemoryVersion !== MEMORY_VERSION) {
        for (const roomName in raw) raw[roomName] = remoteRecord(roomName, raw[roomName]);
    }
    mem.remoteMemoryVersion = MEMORY_VERSION;
    return mem;
}

function homeNameOf(home) {
    return typeof home === 'string' ? home : home && home.name;
}

function getRemote(home, remoteRoom) {
    const homeName = homeNameOf(home);
    if (!homeName || !Memory.rooms || !Memory.rooms[homeName]) return null;
    const remotes = homeMemory(homeName).remotes;
    return remotes[remoteRoom] || null;
}

function getSource(home, remoteRoom, sourceId, sourceIdx) {
    const record = getRemote(home, remoteRoom);
    if (!record) return null;
    if (sourceId) {
        const exact = record.sources.find((source) => source.id === sourceId);
        if (exact) return exact;
    }
    if (sourceIdx != null && record.sources[sourceIdx]) return record.sources[sourceIdx];
    return record.sources[0] || null;
}

function myUsername(home) {
    return home && home.controller && home.controller.owner && home.controller.owner.username || null;
}

function activeParts(creep, type) {
    if (creep.getActiveBodyparts) return creep.getActiveBodyparts(type);
    let count = 0;
    for (const part of creep.body || []) {
        if ((part.type || part) === type && (part.hits == null || part.hits > 0)) count++;
    }
    return count;
}

/** ignoreKeepers：SK 外矿里的 keeper 是常驻 NPC、由 skReaper 处理，不能把这条外矿判成有敌情（那样永远开不了工）；别的敌人照常算 */
function threatReason(room, ignoreKeepers) {
    // 玩家 creep 只按战斗部件（ATTACK/RANGED/HEAL）算敌情，与 defense.isArmed 的外房 strict 规则一致：
    // 邻居的矿工/预定者（WORK/CLAIM）不会打我们，过去把它们当 hostileCreep 会让外矿反复停 150 tick、把房让给对方（2026-10-14 W36S7 vs Alepoldar）。
    // NPC（Invader）的 WORK/CLAIM 仍算：invader 的 dismantler/预定者是来拆/占的
    const dangerous = room.find(FIND_HOSTILE_CREEPS).some((creep) => {
        if (ignoreKeepers && isKeeper(creep)) return false;
        if (activeParts(creep, ATTACK_PART) > 0 || activeParts(creep, RANGED_ATTACK_PART) > 0 || activeParts(creep, HEAL_PART) > 0) return true;
        const owner = creep.owner && creep.owner.username;
        const npc = owner === 'Invader' || owner === 'Source Keeper';
        return npc && (activeParts(creep, WORK_PART) > 0 || activeParts(creep, CLAIM_PART) > 0);
    });
    if (dangerous) return 'hostileCreep';
    const core = room.find(FIND_STRUCTURES).some((structure) => structure.structureType === INVADER_CORE);
    return core ? 'invaderCore' : null;
}

/** roomName 已是自己的房：claimer 占下后 controller.my 立刻为真，自家房总有视野 */
function ownedByMe(roomName) {
    const room = Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my);
}

/** 某个母房正把这个房当开荒目标（Memory.rooms[*].expansion.target）：不再收成外矿。大脑在线时它自己会把占领目标排除出白名单，
 *  掉线时自治的"相邻房全探明就收"不知道这件事——会把 expansion 自治兜底正在占的房收成外矿，兜底随即因"在采的外矿不碰"放弃它、在途 claimer 退役 */
function expansionTarget(roomName) {
    for (const name in Memory.rooms || {}) {
        const expansion = Memory.rooms[name] && Memory.rooms[name].expansion;
        if (expansion && expansion.target === roomName) return true;
    }
    return false;
}

// 房间出口是静态的（地图不会变），但 withinDistance / isAdjacent 会在每个母房的每个外矿上再问一次：
// 5 个母房 × 7 个外矿 = 每 tick 几十次 Game.map.describeExits。永久缓存在 global 上，global reset 后自然重建。
const exitCache = (typeof global !== 'undefined' ? global : {}).__remoteExitCache ||
    ((typeof global !== 'undefined' ? global : {}).__remoteExitCache = {});

function directExits(homeName) {
    let exits = exitCache[homeName];
    if (!exits) {
        exits = Game.map.describeExits(homeName) || {};
        exitCache[homeName] = exits;
    }
    return exits;
}

/** 外矿白名单：游戏内 config.remote.assign[母房] 优先（数组即生效，[] = 这房不做外矿），否则用外部大脑的 rooms[母房].remotes。
 *  2026-10-14 大脑已停：指令 ~10/21 过期 + 6h 宽限后会退回"只做相邻房"的自治，把二跳外矿全判 tooFar；把分配搬进 config 才能活过过期 */
function remoteWhitelist(homeName) {
    const assign = config.remote && config.remote.assign;
    if (assign && Array.isArray(assign[homeName])) return assign[homeName];
    return brain.get(homeName, 'remotes', null);
}

/** config.remote.assign 明确把这个房分给了这个母房 */
function assignedRoom(homeName, roomName) {
    const assign = config.remote && config.remote.assign;
    return !!(assign && Array.isArray(assign[homeName]) && assign[homeName].includes(roomName));
}

/** reserver 可以进房削 Invader 残余预定（核心已不在，见 observe 的 clearReservation）。房里有敌情时不去 */
function canClearReservation(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !!(record && record.clearReservation && record.enabled !== false &&
        (record.suspendReason || '').indexOf('foreignReservation:') === 0);
}

function isAdjacent(homeName, roomName) {
    return Object.values(directExits(homeName)).includes(roomName);
}

/** 外矿允许的最远房间距离：只有外部大脑白名单里的房才放宽到 maxRange；自治模式仍只做相邻房 */
function withinRange(homeName, roomName) {
    if (isAdjacent(homeName, roomName)) return true;
    const maxRange = Math.max(1, Number(config.remote && config.remote.maxRange) || 1);
    const whitelist = remoteWhitelist(homeName);
    return Array.isArray(whitelist) && whitelist.includes(roomName) && roomDistance(homeName, roomName) <= maxRange;
}

/** 已纳入的外矿是否仍在允许距离内：只看距离（出口相邻或坐标 ≤ maxRange）。
 *  与 withinRange 的区别：不看白名单——指令过期/缺失时不能把大脑早先纳入的外矿判成 tooFar（那会让远程 creep 全部退役） */
function withinDistance(homeName, roomName) {
    if (isAdjacent(homeName, roomName)) return true;
    const maxRange = Math.max(1, Number(config.remote && config.remote.maxRange) || 1);
    return roomDistance(homeName, roomName) <= maxRange;
}

function edgePosition(direction) {
    if (+direction === 1) return { x: 25, y: 49 };
    if (+direction === 3) return { x: 0, y: 25 };
    if (+direction === 5) return { x: 25, y: 0 };
    if (+direction === 7) return { x: 49, y: 25 };
    return null;
}

/** 本房朝 direction 出口的那条边（findRoute 从本房出发给的 exit）：TOP → y=0。与 edgePosition 相反——那个是"母房往这边出口，
 *  邻房里朝母房的边"（母房 TOP 出口的邻房在北边，朝母房的是它的 y=49） */
function exitEdgePosition(direction) {
    if (+direction === 1) return { x: 25, y: 0 };
    if (+direction === 3) return { x: 49, y: 25 };
    if (+direction === 5) return { x: 25, y: 49 };
    if (+direction === 7) return { x: 0, y: 25 };
    return null;
}

/** 外矿房内"朝母房的入口"：相邻房按母房的出口方向取边中点；二跳房按 findRoute(外矿, 母房) 的第一步出口——那是外矿房自己的出口，
 *  要用 exitEdgePosition。以前套了 edgePosition 翻到对边：寻路失败回退的 planRoad 从背向母房的边斜着铺 6 个工地，之后路线寻路
 *  成功就成了孤儿（线上 W31S1 (24,1)…(19,6)、W31S2 (26,1)…(31,6) 各 6 个 0 进度，路线 0/22、0/21 一格未建） */
function entryPosition(homeName, roomName) {
    const exits = directExits(homeName);
    for (const direction in exits) {
        if (exits[direction] !== roomName) continue;
        const edge = edgePosition(direction);
        if (edge) return edge;
    }
    if (Game.map && typeof Game.map.findRoute === 'function') {
        const route = Game.map.findRoute(roomName, homeName);
        if (Array.isArray(route) && route.length && route[0].exit != null) {
            const edge = exitEdgePosition(route[0].exit);
            if (edge) return edge;
        }
    }
    return { x: 25, y: 25 };
}

function walkableSpot(room, sourcePos, entry, taken) {
    let best = null;
    let bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = sourcePos.x + dx;
        const y = sourcePos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) continue;
        if (taken.has(x + '.' + y)) continue;
        const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
        if (structures.some((structure) => structure.structureType !== STRUCTURE_ROAD &&
            structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART)) continue;
        const score = Math.max(Math.abs(x - entry.x), Math.abs(y - entry.y));
        if (score < bestScore) {
            bestScore = score;
            best = { x, y };
        }
    }
    return best;
}

function anchorFor(home) {
    return home.storage || home.find(FIND_MY_SPAWNS)[0] || { pos: new RoomPosition(25, 25, home.name) };
}

/** 房间路程（跳数）：Game.map.findRoute 的段数；同房 0，无路 Infinity */
function routeHops(from, to) {
    if (from === to) return 0;
    const route = Game.map && typeof Game.map.findRoute === 'function' ? Game.map.findRoute(from, to) : null;
    return Array.isArray(route) ? route.length : Infinity;
}

function storedEnergy(room) {
    const store = room && room.storage && room.storage.my !== false && room.storage.store;
    return store ? Number(store[RESOURCE_ENERGY] || 0) : 0;
}

/** 卸货房：全账号路程最短的己方房（有 spawn 或 storage），同跳数归母房。运输工满载后往这里送，hauler 编制也按到这里的距离算
 *  （线上 W31S8 → W33S7 要穿 3 个房，→ W33S8 只要 2 个）。每 config.remote.dropRefreshTicks 重算一次；record.drop = {room, hops, distance, at}
 *  比母房富得多（storage 多出 dropRicherMargin）的房不当卸货房：能量送过去只会躺在它的 storage 里，母房却出全套 creep——
 *  线上 2026-09-11 W32S4（storage 0、升级被限流到一半）的 W32S3/W32S2 两个 3000 源一直往 storage 34 万的 W33S3 送 */
function refreshDropRoom(home, record) {
    const spotSource = (record.sources || []).find((source) => source.spot);
    const target = spotSource ? new RoomPosition(spotSource.spot.x, spotSource.spot.y, record.room) : null;
    const homeHops = routeHops(record.room, home.name);
    // 跳数只用来筛候选（不比母房远），真正比的是 PathFinder 的路径长度：线上 W32S5 到 W33S7 只有 2 跳却要走 71 格，回 3 跳的母房 W34S7 是 67 格
    const candidates = [{ room: home.name, hops: homeHops }];
    const richerMargin = positiveSetting('dropRicherMargin', 50000);
    const homeStored = storedEnergy(home);
    const skippedRicher = [];
    for (const candidate of Object.values(Game.rooms || {})) {
        if (!candidate.controller || !candidate.controller.my || candidate.name === home.name) continue;
        if (!candidate.storage && !candidate.find(FIND_MY_SPAWNS).length) continue;
        if (storedEnergy(candidate) - homeStored >= richerMargin) { skippedRicher.push(candidate.name); continue; }
        const hops = routeHops(record.room, candidate.name);
        if (hops <= homeHops) candidates.push({ room: candidate.name, hops });
    }
    let best = candidates[0];
    for (const candidate of candidates) {
        const room = Game.rooms[candidate.room];
        const estimate = {};
        candidate.distance = room && target ? routeLength(anchorFor(room).pos, target, candidate.hops + 1, 0, estimate) : null;
        candidate.incomplete = estimate.incomplete;
        if (candidate === best) continue;
        if (candidate.distance != null && (best.distance == null || (best.incomplete && !candidate.incomplete) ||
            (!!best.incomplete === !!candidate.incomplete && candidate.distance < best.distance))) best = candidate;   // 同路程归母房（母房排第一）
    }
    record.drop = { room: best.room, hops: best.hops, distance: best.room !== home.name ? (best.distance || null) : null, at: Game.time, distanceVersion: DISTANCE_VERSION };
    if (skippedRicher.length) record.drop.skippedRicher = skippedRicher;   // 遥测：比母房富得多、被跳过的候选
}

// Stagger old drop caches across 25 ticks during search-budget migration.
function dropNeedsRefresh(home, record) {
    if (!record.drop) return true;
    if (record.drop.distanceVersion !== DISTANCE_VERSION) {
        return Game.time % INFRA_REFRESH === (roomPhase(home.name, INFRA_REFRESH) +
            roomPhase(record.room, INFRA_REFRESH)) % INFRA_REFRESH;
    }
    return Game.time - Number(record.drop.at || 0) >= positiveSetting('dropRefreshTicks', 500);
}

/** 外矿运输工该去哪个房卸货（没算过就是母房） */
function dropRoom(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return (record && record.drop && record.drop.room) || homeNameOf(home);
}

function geometricDistance(from, to, range) {
    const a = roomCoords(from.roomName);
    const b = roomCoords(to.roomName);
    if (!a || !b) return 0;
    return Math.max(0, Math.max(Math.abs((b.x - a.x) * 50 + to.x - from.x),
        Math.abs((b.y - a.y) * 50 + to.y - from.y)) - (range || 0));
}

// maxRooms limits explored rooms, not just the rooms on the winning route.
// Live four-exit routes require up to 16 explored rooms; maxOps still bounds CPU.
function searchRoomBudget(routeRooms) {
    return Number.isFinite(routeRooms) ? Math.min(64, Math.max(16, routeRooms)) : 16;
}

function routeLength(from, to, maxRooms, range, estimate) {
    const result = PathFinder.search(from, { pos: to, range: range || 0 }, {
        plainCost: 2,
        swampCost: 8,
        maxRooms: searchRoomBudget(maxRooms),
        maxOps: 10000,
    });
    if (estimate) estimate.incomplete = !!result.incomplete;
    if (!result.incomplete && result.path) return result.path.length;
    // 不完整的路径不等于一房距离；全局坐标保底，且卸货候选优先有完整路径的房。
    return Math.max(geometricDistance(from, to, range),
        50 + Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)));
}

/** 母房核心 → 外矿工位的整条路径（跨房），按房间拆成打包的路段：外矿段成为 source.road，母房段写进母房 plan.roads。
 *  母房内按轮子方案避开规划的建筑位、沿规划的路走（代价 1）。 */
function planRoute(home, room, spot) {
    const anchor = anchorFor(home);
    const target = new RoomPosition(spot.x, spot.y, room.name);
    const plan = Memory.rooms && Memory.rooms[home.name] && Memory.rooms[home.name].plan;
    const result = PathFinder.search(anchor.pos, { pos: target, range: 1 }, {
        plainCost: 2,
        swampCost: 8,
        maxRooms: searchRoomBudget(routeHops(home.name, room.name) + 1),
        maxOps: 10000,
        roomCallback: (roomName) => {
            const matrix = new PathFinder.CostMatrix();
            if (roomName === home.name && plan && plan.wheel) {
                for (const entry of wheelLayout.plannedEntries(plan)) {
                    if (entry.type === STRUCTURE_ROAD) matrix.set(entry.pos.x, entry.pos.y, 1);
                    else if (entry.type !== STRUCTURE_RAMPART && entry.type !== STRUCTURE_CONTAINER) matrix.set(entry.pos.x, entry.pos.y, 255);
                }
            }
            const visible = Game.rooms[roomName];
            if (visible) {
                for (const structure of visible.find(FIND_STRUCTURES)) {
                    if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
                }
            }
            return matrix;
        },
    });
    if (result.incomplete || !result.path || !result.path.length) return null;
    const byRoom = {};
    for (const pos of result.path) {
        if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) continue;
        if (pos.roomName === room.name && pos.x === spot.x && pos.y === spot.y) continue;
        (byRoom[pos.roomName] || (byRoom[pos.roomName] = [])).push(pos.x + '.' + pos.y);
    }
    const packedByRoom = {};
    for (const name in byRoom) packedByRoom[name] = byRoom[name].join(';');
    return packedByRoom;
}

function planRoad(room, entry, spot) {
    const start = new RoomPosition(entry.x, entry.y, room.name);
    const target = new RoomPosition(spot.x, spot.y, room.name);
    const result = PathFinder.search(start, { pos: target, range: 0 }, {
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
    });
    if (result.incomplete || !result.path) return '';
    return result.path
        .filter((pos) => pos.roomName === room.name && pos.x > 0 && pos.x < 49 && pos.y > 0 && pos.y < 49 &&
            (pos.x !== spot.x || pos.y !== spot.y))
        .map((pos) => pos.x + '.' + pos.y)
        .join(';');
}

function unpackRoad(packed) {
    if (!packed) return [];
    return packed.split(';').filter(Boolean).map((item) => {
        const parts = item.split('.');
        return { x: +parts[0], y: +parts[1] };
    });
}

function at(room, look, pos, type) {
    if (!pos) return null;
    return room.lookForAt(look, pos.x, pos.y).find((item) => item.structureType === type) || null;
}

function refreshInfrastructure(room, record) {
    let complete = record.sources.length > 0;
    for (const source of record.sources) {
        const container = at(room, LOOK_STRUCTURES, source.spot, STRUCTURE_CONTAINER);
        // 容器丢失（上次还在、这次没了）：记下时间，运输槽 0 继续出（getDemands），建回来再清
        if (container) delete source.containerLostAt;
        else if (source.containerId) source.containerLostAt = Game.time;
        source.containerId = container ? container.id : null;
        const route = source.routeRoads;
        // 空串/半条路线不证明已铺路；必须验证整条跨房路线，缺视野也不能当作已铺好。
        let roadComplete = !!route && Object.values(route).some((packed) => unpackRoad(packed).length > 0);
        if (roadComplete) {
            for (const name in route) {
                const visible = name === room.name ? room : Game.rooms[name];
                if (!visible) { roadComplete = false; break; }
                if (unpackRoad(route[name]).some((pos) => !at(visible, LOOK_STRUCTURES, pos, STRUCTURE_ROAD))) {
                    roadComplete = false;
                    break;
                }
            }
        }
        if (source.roadComplete && !roadComplete && !record.roadCoverageRepair) {
            record.roadCoverageRepair = { at: Game.time, source: source.id, reason: 'incompleteRoadCoverage' };
        }
        source.roadComplete = roadComplete;
        if (!container || !roadComplete) complete = false;
    }
    record.infrastructureComplete = complete;
}

function refreshVisible(home, record, room) {
    const now = Game.time;
    const username = myUsername(home);
    record.lastSeen = now;
    if (record.unreachableCount) record.unreachableCount = 0;   // 有 creep 真正看到这个房：不可达的退避计数清零（退避见 noteTravel）
    const controller = room.controller;
    record.controllerId = controller && controller.id || null;
    record.controllerPos = controller ? { x: controller.pos.x, y: controller.pos.y } : null;

    if (controller && controller.owner && (!username || controller.owner.username !== username)) {
        record.enabled = false;
        record.suspendReason = 'foreignOwner:' + controller.owner.username;
        record.suspendedUntil = Number.MAX_SAFE_INTEGER;
    }

    const reservation = controller && controller.reservation;
    record.reservation = {
        username: reservation && reservation.username || null,
        ticksToEnd: reservation && reservation.ticksToEnd || 0,
        seenAt: now,
    };
    // 核心没了、只剩 Invader 的残余预定（最长 ~5000 tick）：外矿整体照停（被别人预定的房 harvest 返回 ERR_NOT_OWNER），
    // 但标 clearReservation，reserver 进去 attackController 把它削掉（每 CLAIM 每 tick −1，叠加自然衰减），比干等快几倍，也先于邻居站上控制器
    record.clearReservation = false;
    if (reservation && (!username || reservation.username !== username)) {
        record.suspendedUntil = Math.max(record.suspendedUntil, now + reservation.ticksToEnd + RESERVATION_BUFFER);
        record.suspendReason = 'foreignReservation:' + reservation.username;
        if (reservation.username === 'Invader' && !room.find(FIND_STRUCTURES).some((s) => s.structureType === INVADER_CORE)) {
            record.clearReservation = true;
        }
    } else if (String(record.suspendReason || '').indexOf('foreignReservation:') === 0) {
        // 别人的预定没了（被我们削掉 / 提前到期）：立刻解除，别等当初按 ticksToEnd 算的到期——邻居就在旁边等着抢预定
        record.suspendedUntil = 0;
        record.suspendReason = null;
    }

    // keeper lair 是永不变的静态地物：过去每 tick 对每个可见外矿做一次全量 FIND_STRUCTURES 扫描只为数它。
    // 看到一次就记下来（record.lairs），之后不再扫。
    if (record.lairs == null) {
        record.lairs = room.find(FIND_STRUCTURES)
            .filter((structure) => structure.structureType === STRUCTURE_KEEPER_LAIR).length;
    }
    const keeperLairs = record.lairs;
    if (keeperLairs > 0) {
        // 只有明确标成 SK 外矿（syncKeeperRooms / admitCandidates 按 config.sk 纳入）的才继续开采，否则永久停用——普通外矿误进 keeper 房是白送 creep。
        // SK 外矿只撤销「keeperRoom」这一条（完整撤销：理由、到期、enabled 一起恢复），别的模块的停用理由不碰：
        // 源分支第一版无条件清 suspendReason 却不恢复 enabled，留下没有理由的 enabled:false（私服 validation-7PbiPA）
        if (record.sk) {
            if (record.suspendReason === 'keeperRoom') {
                record.suspendReason = null;
                record.suspendedUntil = 0;
                record.enabled = true;
            }
        } else {
            record.enabled = false;
            record.suspendReason = 'keeperRoom';
            record.suspendedUntil = Number.MAX_SAFE_INTEGER;
        }
    }

    const threat = threatReason(room, record.sk);
    if (threat) {
        record.suspendedUntil = Math.max(record.suspendedUntil, now + HOSTILE_COOLDOWN);
        record.suspendReason = threat;
        // 敌情画像（血量/伤害/治疗/风筝型/到期）：defense.getDemands 据此算打不打得过，房间不可见时也能用（SK 外矿不把 keeper 算进去）
        defense.recordThreat(record, defense.armedHostiles(room).filter((creep) => !(record.sk && isKeeper(creep))));
    } else if (record.enabled && (record.suspendedUntil <= now ||
        record.suspendReason === 'hostileCreep' || record.suspendReason === 'invaderCore')) {
        // 看到房间已清场就立刻解除敌情停用：defender 清场后远程 creep 不必再等 150 tick 冷却（打不过时停到入侵者到期的也一样）
        record.suspendedUntil = 0;
        record.suspendReason = null;
        record.threat = null;
    }

    const previous = {};
    for (const source of record.sources) if (source.id) previous[source.id] = source;
    const taken = new Set(record.sources.filter((source) => source.spot).map((source) => source.spot.x + '.' + source.spot.y));
    const entry = entryPosition(home.name, room.name);
    record.entry = { x: entry.x, y: entry.y };   // 遥测：朝母房的入口（新源选矿位、寻路失败回退铺路都从这里起）
    const anchor = anchorFor(home);
    const visibleSources = room.find(FIND_SOURCES).slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const minSources = Math.max(1, Number(config.remote && config.remote.minSources) || 1);
    if (visibleSources.length < minSources) {
        record.enabled = false;
        record.suspendReason = 'sourceCount:' + visibleSources.length;
        record.suspendedUntil = Number.MAX_SAFE_INTEGER;
    }
    const next = [];
    for (const source of visibleSources) {
        const old = previous[source.id] || {};
        let spot = old.spot;
        if (!spot) spot = walkableSpot(room, source.pos, entry, taken);
        if (!spot) continue;
        taken.add(spot.x + '.' + spot.y);
        const target = new RoomPosition(spot.x, spot.y, room.name);
        const invalidDistance = old.distance && old.distance < geometricDistance(anchor.pos, target, 0);
        const needsDistance = invalidDistance || old.distanceVersion !== DISTANCE_VERSION || !old.distance ||
            (old.distanceIncomplete && now - (old.distanceAt || 0) >= INFRA_REFRESH);
        const estimate = {};
        const distance = !needsDistance && old.distance || routeLength(anchor.pos, target, routeHops(home.name, room.name) + 1, 0, estimate);
        if (needsDistance && old.distance && !record.distanceRepair) record.distanceRepair = { at: now, source: source.id, before: old.distance, after: distance };
        let routeRoads = old.routeRoads || null;
        const attemptRoute = !routeRoads && (!old.routePlanAt || now - old.routePlanAt >= INFRA_REFRESH);
        if (attemptRoute) routeRoads = planRoute(home, room, spot);
        const road = (routeRoads && routeRoads[room.name]) || old.road || (attemptRoute ? planRoad(room, entry, spot) : '');
        const nextSource = sourceRecord({
            id: source.id,
            pos: { x: source.pos.x, y: source.pos.y },
            spot,
            distance,
            distanceVersion: DISTANCE_VERSION,
            distanceIncomplete: needsDistance ? !!estimate.incomplete : !!old.distanceIncomplete,
            distanceAt: needsDistance ? now : old.distanceAt,
            energyCapacity: source.energyCapacity,
            containerId: old.containerId,
            road,
            routePlanAt: attemptRoute ? now : old.routePlanAt,
            roadComplete: old.roadComplete,
        });
        if (routeRoads) nextSource.routeRoads = routeRoads;
        // sourceRecord 是字段白名单：遥测/状态字段要手动带过去，否则外矿有视野时每 tick 重建都会丢
        // （私服 validation-Wmg3Hx：结束时外矿有视野，haulNeed 没了，生效断言 audit.remoteHaulNeedAndResidual 判失败）
        if (old.haulNeed != null) nextSource.haulNeed = old.haulNeed;
        if (old.haulStops != null) nextSource.haulStops = old.haulStops;
        if (old.containerLostAt) nextSource.containerLostAt = old.containerLostAt;
        if (old.legs) nextSource.legs = old.legs;   // 外矿 hauler 的实测腿长（roles/remoteHauler 寿命的最后一趟用）
        if (old.roadMismatch) nextSource.roadMismatch = old.roadMismatch;   // 走线与规划路连续对不上的趟数（noteRoadTrail）
        if (old.roadAdoptedAt) nextSource.roadAdoptedAt = old.roadAdoptedAt;   // 上次按走线改规划的 tick（冷却，noteRoadTrail）
        if (old.roadReplan) nextSource.roadReplan = old.roadReplan;   // 按走线改规划的遥测：首次那条 + 次数（noteRoadTrail）
        next.push(nextSource);
    }
    record.sources = next;
    record.sourceCount = next.length;

    if (controller && record.controllerPos) {
        const target = new RoomPosition(record.controllerPos.x, record.controllerPos.y, room.name);
        if (record.controllerDistanceVersion !== DISTANCE_VERSION || !record.controllerDistance || record.controllerDistance < geometricDistance(anchor.pos, target, 1) ||
            (record.controllerDistanceIncomplete && now - (record.controllerDistanceAt || 0) >= INFRA_REFRESH)) {
            const estimate = {};
            record.controllerDistance = routeLength(anchor.pos, target, routeHops(home.name, room.name) + 1, 1, estimate);
            record.controllerDistanceVersion = DISTANCE_VERSION;
            record.controllerDistanceIncomplete = !!estimate.incomplete;
            record.controllerDistanceAt = now;
        }
    }
    if (now % INFRA_REFRESH === roomPhase(room.name, INFRA_REFRESH) || !record.infrastructureComplete) {
        refreshInfrastructure(room, record);
    }
    return record;
}

function globalSiteCount() {
    return Game.constructionSites ? Object.keys(Game.constructionSites).length : 0;
}

/** 母房**自己在跑的**外矿里的路工地数（Game.constructionSites 是全局的，不需要视野）。
 *  必须只算 `.enabled`：大脑去重后同一外矿只归一个母房，别的母房的记录停在 notWhitelisted（enabled=false），
 *  而那些房里的工地属于人家、由人家建。只判房名在不在 remotes 里的话，别人的活工地会吃满我的配额，
 *  而 usedByAnotherHome 又（正确地）不让我清它们——既建不了也清不掉的死结：线上 2026-09-12 W32S4 名下
 *  13/12 已超上限，其中 8 个属于别的母房（W32S2 的 6 个归 W33S3、W32S6 的 2 个归 W33S7），
 *  它自己的两条启用外矿再也放不出工地，且全程无遥测。停用的房是我自己的残留时由 trimRemoteSites 清。 */
function homeRemoteRoadSites(remotes) {
    let n = 0;
    for (const site of Object.values(Game.constructionSites || {})) {
        const record = site.structureType === STRUCTURE_ROAD && remotes && remotes[site.pos.roomName];
        if (record && record.enabled) n++;
    }
    return n;
}

/** 房名在本房 remotes 里、但本房没启用的房里的路工地数：要么是别的母房在跑的（不该算我的配额），
 *  要么是我自己停用后还没清掉的残留。只作遥测，让"配额被谁占着"可见 */
function foreignRemoteRoadSites(remotes) {
    let n = 0;
    for (const site of Object.values(Game.constructionSites || {})) {
        const record = site.structureType === STRUCTURE_ROAD && remotes && remotes[site.pos.roomName];
        if (record && !record.enabled) n++;
    }
    return n;
}

/** 别的母房是否还在用这个外矿（记录启用）：大脑去重后同一外矿只归一个母房，其他母房的记录停在 notWhitelisted，不能替人家清工地 */
function usedByAnotherHome(homeName, roomName) {
    for (const otherName in Memory.rooms || {}) {
        if (otherName === homeName) continue;
        const record = Memory.rooms[otherName] && Memory.rooms[otherName].remotes && Memory.rooms[otherName].remotes[roomName];
        if (record && record.enabled) return true;
    }
    return false;
}

/** 停用的外矿（改派/太远/被占/不可达）里我方的工地清掉：没人去建，只会占着全局 100 个名额（基准里采集为 0 的外矿各挂 6 条路）。
 *  spawn 工地不动（扩张的新房），别的母房仍启用的外矿不动 */
function trimRemoteSites(homeName, roomName) {
    if (usedByAnotherHome(homeName, roomName)) return 0;
    let removed = 0;
    for (const site of Object.values(Game.constructionSites || {})) {
        if (!site.pos || site.pos.roomName !== roomName || site.structureType === STRUCTURE_SPAWN) continue;
        if (typeof site.remove === 'function' && site.remove() === OK) removed++;
    }
    return removed;
}

/** 本母房外矿里零进度的路工地撤一个（先本外矿的）：容器工地放不下时腾名额。撤除下一 tick 才生效，下一轮 infraTick 再放容器 */
function yieldRoadSite(roomName, remotes) {
    const candidates = Object.values(Game.constructionSites || {}).filter((site) => site.structureType === STRUCTURE_ROAD && site.pos &&
        remotes && remotes[site.pos.roomName] && !(site.progress > 0));
    candidates.sort((left, right) => (left.pos.roomName === roomName ? 0 : 1) - (right.pos.roomName === roomName ? 0 : 1));
    for (const site of candidates) {
        if (typeof site.remove === 'function' && site.remove() === OK) return true;
    }
    return false;
}

/** 本母房是否还有启用的外矿缺容器（建成才算，refreshInfrastructure 写 containerId）：有就先不放路——容器解锁 hauler 与维护档，路只省几 tick */
function containerGap(remotes) {
    return Object.values(remotes || {}).some((record) => record && record.enabled && !(record.suspendedUntil > Game.time) &&
        (record.sources || []).some((source) => !source.containerId));
}

/** 外矿房里我方不在任何启用记录路线上的路工地：寻路失败时回退的旧路线（两跳外矿曾从背向母房的边铺，见 entryPosition）、
 *  换了主人的外矿留下的旧路、按走线改规划后被弃用的旧走廊（noteRoadTrail）。名额满时才清（placeInfrastructure）：
 *  它们占着每外矿 MAX_REMOTE_SITES 与母房 roadSitesPerHome 的名额，路线上的新工地放不出来
 *  （线上 W32S4 名下 12/12 被 W32S2/W32S5 的孤儿占满，W32S3 路线停在 4/38）。
 *  **修了一半的也清**——止的不是"永远修不完的窟窿"，而是"把剩余预算投进一条建成后也没用的路"：
 *  `nearbyInfrastructureWork` 的 findInRange 不看工地在不在路线上，所以贴着走廊的旧工地照样会被路过的 hauler 建完
 *  （线上 2026-09-12 两种归宿各出现一次：W32S6 (20,43) 距路线 38 格、进度停在 10 被清掉，W32S5 (20,4) 距路线 1 格、
 *  进度 145→175 最后被建成了路）。一条路 300，已投的是沉没（工地没有拆回能量这回事），剩余成本恒 > 0 而建成后
 *  creep 不走它、价值 ≈ 0，所以清掉在任何进度值下都划算。"别轻易丢弃已投入的能量"这个用意由**调用时机**保住：
 *  名额没满时压根不会调用本函数，半成品安稳留着；只有名额满、启用路线上的新工地放不出来时才做这个交换。
 *  遥测 record.orphanRoadSites 记条数与一起丢掉的进度。 */
function pruneOrphanRoadSites(room, record) {
    const wanted = new Set();
    for (const homeName in Memory.rooms || {}) {
        const remotes = (Memory.rooms[homeName] || {}).remotes || {};
        for (const name in remotes) {
            const other = remotes[name];
            if (!other || !other.enabled) continue;
            for (const source of other.sources || []) {
                if (name === room.name) for (const pos of unpackRoad(source.road)) wanted.add(pos.x + '.' + pos.y);
                for (const pos of unpackRoad(source.routeRoads && source.routeRoads[room.name])) wanted.add(pos.x + '.' + pos.y);
            }
        }
    }
    let removed = 0;
    let lost = 0;
    for (const site of room.find(FIND_MY_CONSTRUCTION_SITES).slice()) {
        if (site.structureType !== STRUCTURE_ROAD || wanted.has(site.pos.x + '.' + site.pos.y)) continue;
        const progress = Number(site.progress) || 0;
        if (typeof site.remove === 'function' && site.remove() === OK) { removed++; lost += progress; }
    }
    if (removed) {
        const log = record.orphanRoadSites || (record.orphanRoadSites = { n: 0, lost: 0 });
        log.at = Game.time;
        log.n = (Number(log.n) || 0) + removed;
        log.lost = (Number(log.lost) || 0) + lost;
    }
    return removed;
}

/** 满载腿的真实走线（roles/remoteHauler 逐格记、离开外矿房时汇总一趟）：与规划的房内路线比对，连续对不上就改规划。
 *  路工地按规划路放（planRoute 从母房锚点搜、range 1），而顺手修路只发生在满载 hauler 的 3 格射程内
 *  （roles/remoteHauler.nearbyInfrastructureWork）；creep 自己的寻路目标是卸货房房心 range 20，在代价并列的房里
 *  会挑另一条走廊——工地放在没人走的那条上就永远建不起来。线上 W31S9：规划走北走廊（房内 34 格、出口 (49,5)），
 *  满载腿走中走廊（房内 15 格、出口 (49,25)），6 个工地 (48,5)…(45,10) 零进度挂了 1.45 万 tick、离满载腿最近 16–18 格，
 *  母房的 remoteRoadBudget 从未建立；W31S7 0/19、W32S6 0/68、W31S1 0/22 同病，而两条线重合的 1 跳外矿路都铺满了。
 *  采纳走线后旧工地变成"不在任何启用路线上"的孤儿，由 pruneOrphanRoadSites 清掉，新工地下一轮 infraTick 放到有人走的走廊上。 */
function noteRoadTrail(home, remoteRoom, sourceId, sourceIdx, packed) {
    const record = getRemote(home, remoteRoom);
    const source = record && getSource(home, remoteRoom, sourceId, sourceIdx);
    if (!source) return;
    const trail = unpackRoad(packed);
    const planned = unpackRoad(source.road);
    if (trail.length < 3 || !planned.length) return;
    // 不连续的走线（creep 被 CPU 跳过、跨房采样混进来）整趟丢弃：它不代表一条可铺的路
    for (let i = 1; i < trail.length; i++) {
        if (Math.max(Math.abs(trail[i].x - trail[i - 1].x), Math.abs(trail[i].y - trail[i - 1].y)) > 1) return;
    }
    const onPlan = new Set(planned.map((pos) => pos.x + '.' + pos.y));
    const matched = trail.filter((pos) => onPlan.has(pos.x + '.' + pos.y)).length;
    if (matched / trail.length >= positiveSetting('roadTrailMatchShare', 0.5)) {
        delete source.roadMismatch;   // 沿路让位常偏 1–2 格，对得上就不算失配
        return;
    }
    source.roadMismatch = (Number(source.roadMismatch) || 0) + 1;
    if (source.roadMismatch < positiveSetting('roadTrailLegs', 3)) return;
    delete source.roadMismatch;
    // 改过一次就进冷却：路还没铺起来时各趟走线本来就差几格，连着改只是把工地在相邻走廊之间搬来搬去，
    // 而修了一半又被弃用的工地不会被 pruneOrphanRoadSites 清掉（它只清零进度的），会永久占着名额
    // 注意区分"从未改过"与"刚改过"：写成 `Number(x) || 0` 会把两者压成同一个语义，条件退化成 Game.time < 1500，
    // 在 tick 从 0 起算的私服里把**首次**重规划也挡死（线上 Game.time 是全服累计的 7300 万，看不出来；
    // 2026-09-12 私服验证里 remote.roadTrailReplan 因此假阴性，整轮 tick 都 < 1500）
    const adoptedAt = Number(source.roadAdoptedAt);
    if (Number.isFinite(adoptedAt) && Game.time - adoptedAt < positiveSetting('roadTrailCooldown', 1500)) return;
    // 翻转成"入口端在前"（placeInfrastructure 从串头开始放工地，与 planRoute 的顺序一致）；
    // 去重、去掉矿位格（矿工/容器占着）与房间边缘格（引擎不允许在边缘放工地）
    const spot = source.spot || {};
    const seen = new Set();
    const adopted = [];
    for (let i = trail.length - 1; i >= 0; i--) {
        const pos = trail[i];
        const tag = pos.x + '.' + pos.y;
        if (seen.has(tag)) continue;
        seen.add(tag);
        if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) continue;
        if (pos.x === spot.x && pos.y === spot.y) continue;
        adopted.push(tag);
    }
    if (!adopted.length) return;
    // 遥测记在 **source** 上，与冷却（source.roadAdoptedAt）同粒度：记在 record 上的话，双源外矿两个源各改一次
    // 会被记成 n=2（读起来像同一条路改了两次），lastWas/lastTiles 还来自另一个源——n 的全部价值就在识别反复改，
    // 含混的 n 等于废掉它（2026-09-12 私服里就这样让断言拿 A 源的 lastTiles 去比 B 源的路）。
    // 保留**首次**那条：只有它能证明"从规划器给的那条路换到了走线"；后续只累计次数与最近一次（n > 1 = 这条源在反复改）
    if (source.roadReplan) {
        source.roadReplan.n = (Number(source.roadReplan.n) || 1) + 1;
        source.roadReplan.lastAt = Game.time;
        source.roadReplan.lastWas = planned.length;
        source.roadReplan.lastTiles = adopted.length;
    } else {
        source.roadReplan = { at: Game.time, was: planned.length, tiles: adopted.length, n: 1 };
    }
    source.roadAdoptedAt = Game.time;
    source.road = adopted.join(';');
    if (source.routeRoads) source.routeRoads[remoteRoom] = source.road;
    source.roadComplete = false;
}

function placeInfrastructure(room, record, remotes) {
    if (!record.enabled || record.suspendedUntil > Game.time) return;
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    // 容器工地优先：线上 2026-09-06 W32S8 容器烂掉后留下 6 条零进度路工地（= MAX_REMOTE_SITES）、全账号 95–100 个名额被新房的路占满，
    // 容器工地永远放不出来——没有容器就没有 hauler、外矿升不到维护档，母房一打嗝它最先被丢。名额被占时撤一条零进度的路（先本外矿的）
    for (const source of record.sources) {
        if (at(room, LOOK_STRUCTURES, source.spot, STRUCTURE_CONTAINER) ||
            at(room, LOOK_CONSTRUCTION_SITES, source.spot, STRUCTURE_CONTAINER)) continue;
        if (sites.length >= MAX_REMOTE_SITES || globalSiteCount() >= 100) {
            if (yieldRoadSite(room.name, remotes)) record.roadSitesYielded = (Number(record.roadSitesYielded) || 0) + 1;
            else record.containerBlockedAt = Game.time;
            return;
        }
        if (room.createConstructionSite(source.spot.x, source.spot.y, STRUCTURE_CONTAINER) === OK) record.containerSiteAt = Game.time;
        return;
    }
    // 路工地按母房限量：每个外矿最多 MAX_REMOTE_SITES 个在建，母房名下合计不超过 config.remote.roadSitesPerHome
    const homeCap = positiveSetting('roadSitesPerHome', 12);
    // 名额满了先清孤儿（不在任何启用路线上的路工地，含修了一半的），撤除下一 tick 才生效，路下一轮 infraTick 再放
    if ((sites.length >= MAX_REMOTE_SITES || homeRemoteRoadSites(remotes) >= homeCap) && pruneOrphanRoadSites(room, record) > 0) return;
    if (sites.length >= MAX_REMOTE_SITES) return;
    // 路只用保留线以上的名额：全局最后 remoteContainerSiteReserve 个只给容器工地（与 layout 的保底同一条线）
    if (globalSiteCount() >= 100 - Math.max(0, Number(config.remoteContainerSiteReserve) || 0)) { record.roadsHeldAt = Game.time; return; }
    if (containerGap(remotes)) return;
    // 配额构成遥测：以前"名额被占满 ⇒ budget=0 ⇒ 一个工地都不放"是完全静默的（roadsHeldAt/containerBlockedAt/
    // roadSitesYielded 三个都覆盖不到这一支），只能靠人逐房数才看得出来。others > 0 说明有房名归别人跑或是我的残留
    const mine = homeRemoteRoadSites(remotes);
    const others = foreignRemoteRoadSites(remotes);
    if (others > 0 || mine >= homeCap) record.roadQuota = { at: Game.time, mine, others, cap: homeCap };
    let budget = Math.min(MAX_REMOTE_SITES - sites.length, homeCap - mine);
    for (const source of record.sources) {
        for (const pos of unpackRoad(source.road)) {
            if (budget <= 0) return;
            if (at(room, LOOK_STRUCTURES, pos, STRUCTURE_ROAD) ||
                at(room, LOOK_CONSTRUCTION_SITES, pos, STRUCTURE_ROAD)) continue;
            const blocking = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y)
                .some((structure) => structure.structureType !== STRUCTURE_RAMPART);
            if (blocking) continue;
            if (room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD) === OK) budget--;
        }
    }
}

function candidatePool(home, neighbors) {
    // 外部大脑给了白名单：只在白名单里挑（批 0 仍限相邻房）；否则沿用自治规则——相邻房全部探明后再挑
    const whitelist = remoteWhitelist(home.name);
    if (Array.isArray(whitelist)) return whitelist.filter((roomName) => withinRange(home.name, roomName));
    if (!Memory.map || !neighbors.every((roomName) => Memory.map[roomName])) return [];
    return neighbors;
}

function admitCandidates(home, remotes) {
    const level = home.controller && home.controller.level || 0;
    const maxRooms = config.remote && config.remote.maxRooms && config.remote.maxRooms[level] || 0;
    if (maxRooms <= 0) return;
    const neighbors = Object.values(directExits(home.name));
    const pool = candidatePool(home, neighbors);
    if (!pool.length || !Memory.map) return;
    // 外部大脑给了白名单：数量上限由大脑决定（它已按 RCL 限制过）；自治模式沿用 config.remote.maxRooms
    const whitelisted = Array.isArray(remoteWhitelist(home.name));
    const limit = whitelisted ? Math.max(maxRooms, pool.length) : maxRooms;
    const selected = Object.values(remotes).filter((record) => record.enabled).length;
    if (selected >= limit) return;
    const username = myUsername(home);
    // keeper 房单独一条闸（config.sk）：开关打开、RCL 够、大脑白名单点了名、名额没满才收
    const skOk = skAllowed(home);
    const skLimit = Math.max(0, Number(skSettings().maxRoomsPerHome) || 0);
    let skCount = Object.values(remotes).filter((record) => record.sk && record.enabled).length;
    const candidates = pool
        .filter((roomName) => !remotes[roomName] && !ownedByMe(roomName) && !expansionTarget(roomName))
        .map((roomName) => ({ roomName, info: Memory.map[roomName] }))
        .filter((entry) => {
            const info = entry.info;
            const minSources = Math.max(1, Number(config.remote && config.remote.minSources) || 1);
            if (!info || !(info.sources >= minSources) || info.unreachable || info.owner) return false;
            const keeperRoom = info.lairs > 0;
            if (keeperRoom && !(skOk && skWhitelisted(home.name, entry.roomName))) return false;
            // 别人预定的房不收；例外：config.remote.assign 点名的房被 Invader 预定（核心到期后残余预定会被 reserver 削掉，
            // 而大脑停了以后 Memory.map 不再刷新，旧情报里的 Invader 预定会让它永远进不了门）
            if (info.reservation && info.reservation.username && info.reservation.username !== username &&
                !(info.reservation.username === 'Invader' && assignedRoom(home.name, entry.roomName))) return false;
            // keeper 房里 scout 数的 armedHostiles/threat 就是 keeper 本身（scout 不分主人），只看 invader core（stronghold）
            const recentThreat = Game.time - (info.at || 0) <= HOSTILE_COOLDOWN &&
                (keeperRoom ? info.invaderCore : (info.armedHostiles > 0 || info.invaderCore || info.threat));
            return !recentThreat;
        })
        .sort((a, b) => b.info.sources - a.info.sources || a.roomName.localeCompare(b.roomName));
    let count = selected;
    for (const candidate of candidates) {
        if (count >= limit) break;
        const info = candidate.info;
        const keeperRoom = info.lairs > 0;
        if (keeperRoom && skCount >= skLimit) continue;
        if (keeperRoom) skCount++;
        remotes[candidate.roomName] = remoteRecord(candidate.roomName, {
            sk: keeperRoom,
            lairs: info.lairs == null ? null : info.lairs,
            sourceCount: info.sources,
            controllerId: info.controllerId,
            controllerPos: info.controllerPos,
            reservation: info.reservation ? {
                username: info.reservation.username,
                ticksToEnd: info.reservation.ticksToEnd,
                seenAt: info.at,
            } : null,
            sources: (info.sourceData || []).map((source) => ({
                id: source.id,
                pos: { x: source.x, y: source.y },
                energyCapacity: source.energyCapacity,
            })),
        });
        count++;
    }
}

/** 外矿路径的母房段（以及途经的己方房段）写进对应房的 plan.roads['remote:外矿:源']，随 layout 放工地/维修；外矿停用即移除 */
function syncHomeRoads(home, mem) {
    const plan = Memory.rooms && Memory.rooms[home.name] && Memory.rooms[home.name].plan;
    if (!plan || !plan.wheel) return;
    plan.roads = plan.roads || {};
    const wanted = {};
    for (const roomName in mem.remotes) {
        const record = mem.remotes[roomName];
        if (!record || !record.enabled) continue;
        for (const source of record.sources || []) {
            const segment = source.routeRoads && source.routeRoads[home.name];
            if (segment) wanted['remote:' + roomName + ':' + source.id] = segment;
        }
    }
    for (const key of Object.keys(plan.roads)) {
        if (key.startsWith('remote:') && !wanted[key]) delete plan.roads[key];
    }
    for (const key in wanted) plan.roads[key] = wanted[key];
}

function run(home) {
    if (!home || !home.controller || !home.controller.my) return {};
    const mem = homeMemory(home.name);
    if (home.controller.level < config.remote.minRcl) return mem.remotes;
    // 外矿被自己占领后这条记录没有未来：删掉。留着的话每 tick 还在刷新它，占领后到大脑下一轮之间过期白名单会把它重新启用、
    // 给自家房孵 remoteMiner/reserver，防御/监控也把自家房当外矿看（线上 W33S7/W34S7 的 remotes 挂着 W33S8/W35S7 两万 tick）
    for (const roomName in mem.remotes) if (ownedByMe(roomName)) delete mem.remotes[roomName];
    // 遗留清理：按走线改规划的遥测 2026-09-12 从 record 级迁到了 source 级（与冷却 source.roadAdoptedAt 同粒度），
    // 迁移前写下的 record.roadReplan 再也不会被写或读，留着只会让以后读 Memory 的人以为它是活的
    for (const roomName in mem.remotes) {
        const stale = mem.remotes[roomName];
        if (stale && stale.roadReplan) delete stale.roadReplan;
    }
    // 大脑给了白名单就以它为准：不在名单里的外矿停用（远程 creep 会回家退役），重新出现在名单里时再启用
    const whitelist = remoteWhitelist(home.name);
    if (Array.isArray(whitelist)) {
        for (const roomName in mem.remotes) {
            const record = mem.remotes[roomName];
            if (!whitelist.includes(roomName) && record.enabled) {
                record.enabled = false;
                record.suspendReason = 'notWhitelisted';
            } else if (whitelist.includes(roomName) && !record.enabled &&
                record.suspendedUntil !== Number.MAX_SAFE_INTEGER && withinRange(home.name, roomName)) {
                // 白名单里的房只要不是永久性停用（被占/被别人预定/源数不够）就重新启用：
                // 停用原因可能已被临时敌情覆盖成 hostileCreep（线上 W33S6 因此永久停用、防御模块连孵 24 只 defender）
                record.enabled = true;
                if (record.suspendedUntil <= Game.time) {
                    record.suspendedUntil = 0;
                    record.suspendReason = null;
                }
            }
        }
    }
    syncKeeperRooms(home, mem.remotes);
    admitCandidates(home, mem.remotes);
    for (const roomName in mem.remotes) {
        const record = mem.remotes[roomName];
        if (!withinDistance(home.name, roomName)) {
            record.enabled = false;
            record.suspendReason = 'tooFar';
        }
        const infraTick = Game.time % INFRA_INTERVAL === roomPhase(roomName, INFRA_INTERVAL);
        // 停用的外矿：工地清掉（不需要视野），把名额还给母房和仍启用的外矿
        if (!record.enabled) {
            if (infraTick) trimRemoteSites(home.name, roomName);
            continue;
        }
        try {
            if (dropNeedsRefresh(home, record)) refreshDropRoom(home, record);
        } catch (error) {
            logErr('remote.drop ' + home.name + '->' + roomName, error);
        }
        const room = Game.rooms[roomName];
        if (!room) continue;
        try {
            refreshVisible(home, record, room);
            if (infraTick) placeInfrastructure(room, record, mem.remotes);
        } catch (error) {
            logErr('remote.run ' + home.name + '->' + roomName, error);
        }
    }
    syncHomeRoads(home, mem);
    // 编制预算：按本房收入决定哪几条外矿在编（getDemands 与各 role 都读 record.staffed）
    try { staffRemotes(home, mem); } catch (error) { logErr('remote.staff ' + home.name, error); }
    return mem.remotes;
}

function observe(home, room) {
    if (!home || !room) return null;
    const record = getRemote(home, room.name);
    if (!record || !withinDistance(home.name, room.name)) return record;
    if (record.lastSeen === Game.time) return record;
    return refreshVisible(home, record, room);
}

/** 外矿被永久/长期停用（不是敌情冷却那种暂停）：撤回家的远程 creep 应退役 */
/** 去程卡住检测：creep 连续 config.remote.stuckTicks tick 位置不变 ⇒ 该外矿不可达，停用并冷却。
 *  由 remoteHauler/remoteMiner/reserver 在"不在外矿房、正往外矿走"的分支里每 tick 调用。 */
function noteTravel(creep) {
    // 还在己方房里（刚出生、被母房的 hub 口袋或交通堵住）不算"去程卡住"：那不是外矿不可达。
    // 基准 61b4caf：W33S7 升 RCL7 后 spawn (33,27) 的新生 creep 落在 operator/升级者工位围出的口袋里，
    // 60 tick 不动就把整条外矿判成不可达、停 3000 tick 并回收在岗全员——10 万 tick 里 33 次
    const here = creep.room;
    if (here && here.controller && here.controller.my) {
        delete creep.memory._tp;
        delete creep.memory._ts;
        return false;
    }
    const posKey = creep.pos.roomName + ':' + creep.pos.x + ':' + creep.pos.y;
    if (creep.memory._tp === posKey) creep.memory._ts = (creep.memory._ts || 0) + 1;
    else { creep.memory._tp = posKey; creep.memory._ts = 0; }
    if (creep.memory._ts < config.remote.stuckTicks) return false;
    creep.memory._ts = 0;
    const record = getRemote(creep.memory.home, creep.memory.remoteRoom);
    if (!record) return false;
    record.enabled = false;
    record.suspendReason = 'unreachable';
    // 指数退避：第 n 次连续不可达冷却 unreachableTicks × 2^(n−1)，封顶 unreachableMaxTicks——固定 3000 tick 冷却到期就整套重试一轮，
    // creep 卡住 60 tick 全废（基准 a0d5f74 分叉：四个不可达房合计白花 3.7/tick）；有 creep 真正看到该房后计数清零（refreshVisible）
    record.unreachableCount = (record.unreachableCount || 0) + 1;
    record.unreachableAt = Game.time;
    const base = Math.max(1, Number(config.remote.unreachableTicks) || 3000);
    const cap = Math.max(base, Number(config.remote.unreachableMaxTicks) || base * 8);
    record.suspendedUntil = Game.time + Math.min(cap, base * Math.pow(2, record.unreachableCount - 1));
    console.log('[remote] ' + creep.memory.home + ' → ' + creep.memory.remoteRoom + ' unreachable ×' + record.unreachableCount + ': ' + creep.name + ' stuck at ' + posKey +
        '，冷却 ' + (record.suspendedUntil - Game.time));
    return true;
}

/** 大脑白名单会把停用的记录重新 enabled，但 unreachable 冷却仍在：期间 creep 不该在家等满 1500 tick */
function isUnreachable(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !!record && record.suspendReason === 'unreachable' && record.suspendedUntil > Game.time;
}

function isDisabled(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !record || record.enabled === false;
}

function isSuspended(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    return !record || !record.enabled || record.suspendedUntil > Game.time;
}

/** 停用还剩多少 tick（永久停用返回 Infinity；没停用 0） */
function suspensionLeft(home, remoteRoom) {
    const record = getRemote(home, remoteRoom);
    if (!record) return 0;
    if (record.suspendedUntil === Number.MAX_SAFE_INTEGER) return Infinity;
    return Math.max(0, Number(record.suspendedUntil || 0) - Game.time);
}

function effectiveReservation(record, username) {
    const reservation = record && record.reservation;
    if (!reservation || !reservation.username || reservation.username !== username) return 0;
    return Math.max(0, reservation.ticksToEnd - Math.max(0, Game.time - reservation.seenAt));
}

function repeat(part, count) {
    const result = [];
    for (let i = 0; i < count; i++) result.push(part);
    return result;
}

// 旧 controllerDistance 可能来自跨房寻路失败的单房回退值；出生点到控制器的几何下界不能被缓存压低。
// 这只是下界，不冒充真实绕路/沼泽耗时；多 spawn 按最远出生点保守覆盖。
function controllerTravelDistance(home, record) {
    let distance = record.controllerDistance || 50;
    const targetRoom = roomCoords(record.room);
    const target = record.controllerPos;
    if (!targetRoom || !target) return distance;
    const spawns = home.find(FIND_MY_SPAWNS);
    const origins = spawns.length ? spawns.map((spawn) => spawn.pos) : [anchorFor(home).pos];
    for (const origin of origins) {
        const sourceRoom = roomCoords(origin.roomName || home.name);
        if (!sourceRoom) continue;
        const dx = (targetRoom.x - sourceRoom.x) * 50 + target.x - origin.x;
        const dy = (targetRoom.y - sourceRoom.y) * 50 + target.y - origin.y;
        distance = Math.max(distance, Math.max(Math.abs(dx), Math.abs(dy)) - 1);
    }
    return distance;
}

function reserverBody(capacity) {
    if (capacity >= positiveSetting('reserverDoubleClaimCapacity', 1650)) return ['claim', 'claim', 'move', 'move'];
    if (capacity >= 650) return ['claim', 'move'];
    return [];
}

/** 外矿矿工身体。路线没铺完（roadComplete 为假）且容量 ≥ 800 时给 5W1C5M：5W1C3M 在平地要 2 tick/格（5 WORK 每格疲劳 10、3 MOVE 每 tick 回 6），
 *  而替补提前量按 1 tick/格算路程，每代都晚到、源断采（线上 W33S3 的远外矿 roadComplete=false，矿工覆盖率 76–83%）；
 *  多 2 MOVE 只多 100 能量/代（0.07/tick），提前量公式自然成立，每代少浪费一半路程 */
function remoteMinerBody(capacity, roadComplete) {
    if (capacity >= 800 && roadComplete === false) return repeat('work', 5).concat(['carry'], repeat('move', 5));
    if (capacity >= 700) return repeat('work', 5).concat(['carry'], repeat('move', 3));
    if (capacity >= 600) return repeat('work', 4).concat(['carry'], repeat('move', 3));
    if (capacity >= 350) return repeat('work', 2).concat(['carry'], repeat('move', 2));
    return [];
}

function remoteHaulerBody(capacity, roadReady, maintenance, maxCarry) {
    let best = [];
    const carryCap = Math.max(1, Math.min(32, Number(maxCarry) || 32));
    for (let carry = 1; carry <= carryCap; carry++) {
        const work = maintenance ? 1 : 0;
        const move = roadReady ? Math.ceil((carry + work) / 2) : carry + work;
        const cost = work * 100 + carry * 50 + move * 50;
        const length = work + carry + move;
        if (cost > capacity || length > 50) break;
        best = repeat('work', work).concat(repeat('carry', carry), repeat('move', move));
    }
    return best;
}

function carryParts(body) {
    return body.filter((part) => part === 'carry').length;
}

function hasReserver(homeName, roomName) {
    return creepsHomeRole(homeName, 'reserver').some((creep) => !isRetiring(creep.memory) && creep.memory.remoteRoom === roomName);
}

/** Latest safe single-CLAIM spawn start, using only controllers currently serviced by an incumbent. */
function reserverStartDeadline(home, record, username) {
    const controller = record.controllerPos;
    if (!controller) return null;
    const incumbents = creepsHomeRole(home.name, 'reserver').filter((creep) => {
        const pos = creep.pos;
        return !creep.spawning && !isRetiring(creep.memory) && creep.memory.remoteRoom === record.room &&
            pos && pos.roomName === record.room && Math.max(Math.abs(pos.x-controller.x), Math.abs(pos.y-controller.y)) <= 1 &&
            Number.isFinite(creep.ticksToLive) && (creep.body || []).some((part) => part.type === CLAIM_PART && part.hits !== 0);
    });
    if (!incumbents.length) return null;
    const coverage = Math.max(...incumbents.map((creep) => creep.ticksToLive)) + effectiveReservation(record, username);
    return Game.time + coverage - 2 * 3 - controllerTravelDistance(home, record) - 20;
}

/** 预定能让在岗矿工多采多少（能量/tick）：每源 min(2×WORK, 满档 10) − min(2×WORK, 未预定档 5)，按在岗（含孵化中、未退役）矿工算；
 *  unmanned 是没有在岗矿工的源数（它的接班矿工多半是理想身体，预定对它有用）。
 *  未预定的源 1500/300 = 5/tick，2 WORK 的缩身矿工只采 4——预定把源提到 3000 也没人采，reserver 的 650–1300 白花
 *  （线上 W33S7 的 W32S7 连续四代 W2C1M2 矿工配着 1 CLAIM reserver；W33S3 的 W33S2 一整代 2W 矿工配 2 CLAIM） */
function reserveGain(home, record, sources) {
    const work = {};
    for (const creep of creepsHomeRole(home.name, 'remoteMiner')) {
        if (isRetiring(creep.memory) || creep.memory.remoteRoom !== record.room) continue;
        work[creep.memory.sourceId] = (work[creep.memory.sourceId] || 0) + bodyPartCount(creep.body, 'work');
    }
    const regen = 300;
    const neutral = (typeof SOURCE_ENERGY_NEUTRAL_CAPACITY === 'number' ? SOURCE_ENERGY_NEUTRAL_CAPACITY : 1500) / regen;
    const reserved = (typeof SOURCE_ENERGY_CAPACITY === 'number' ? SOURCE_ENERGY_CAPACITY : 3000) / regen;
    const power = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
    let gain = 0;
    let unmanned = 0;
    let manned = 0;
    for (const source of sources || []) {
        if (!work[source.id]) { unmanned++; continue; }
        manned++;
        const rate = work[source.id] * power;
        gain += Math.min(rate, reserved) - Math.min(rate, neutral);
    }
    return { gain, unmanned, manned };
}

/** bodyFor(budget)：预算不足满配时按预算缩身的身体（spawn 队列在宽限用完后调用）；不给则只能等满配 */
function demand(role, slot, body, memory, lead, priority, bodyFor) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, bodyFor };
}

// ---- 外矿编制预算（房只养收入养得起的外矿） ----
/**
 * 一个源的运输槽位：每槽身体按"还差多少 CARRY 在途"定，而不是按房的最大容量顶格。
 * requiredCarry = 源产出 × 往返 tick / 50 就是这条线需要同时在途的 CARRY；槽 0 也按它封顶，
 * 多出来的 CARRY 只是白花能量与孵化时间（线上 W33S7 的 W33S6 距 37 格、只需 16 CARRY，
 * 却孵成 21 CARRY 的 2250 身体，多出 5 CARRY = 500 能量 + 15 tick 孵化，而房收入只有 11/tick）。
 */
/** 卸货房的投递停靠（tick/趟）：remoteHauler 卸空时记的实测 EMA（Memory.rooms[卸货房].remoteStop，进房后除去走到锚点的步数还花了多少 tick），
 *  样本够 remote.stopMinSamples 个就用它、夹在 [1, deliveryStopTicks]；没有数据按 deliveryStopTicks（10：旧模型"5 格 extension × 投 + 挪"
 *  的上限）。storage/控制器容器一次卸空的房实测 1–3，逐格灌 extension 的房仍是 6–10+（同 tick 投递 + 起步之后，停靠只剩格与格之间的步行） */
function deliveryStops(dropRoom) {
    const settings = config.remote || {};
    const fallback = Math.max(0, Number(settings.deliveryStopTicks) || 0);
    const record = dropRoom && Memory.rooms && Memory.rooms[dropRoom] && Memory.rooms[dropRoom].remoteStop;
    const minSamples = Math.max(1, Number(settings.stopMinSamples) || 3);
    if (!record || !(Number(record.n) >= minSamples) || !Number.isFinite(Number(record.ema))) return fallback;
    return Math.max(1, Math.min(fallback || 10, Number(record.ema)));
}

/** 一趟往返的 tick（编制与换代吞吐共用）：2 × 路程 + 两端周转 remote.turnTicks + 卸货房的投递停靠 */
function roundTripTicks(source, distance, dropRoom) {
    const turn = Math.max(0, Number((config.remote || {}).turnTicks));
    return distance * 2 + (Number.isFinite(turn) ? turn : 4) + deliveryStops(dropRoom);
}

/** 这条运输线需要同时在途的 CARRY：源产出 × 一趟往返的 tick / 50，并按 remote.haulUtilization 折算越野与让路损耗。
 *  往返 = roundTripTicks（投递停靠按卸货房实测）。以前零余量（只算 2 × 路程 + 4）：贴线的外矿容器常年满仓、矿工按规则停手，
 *  源产出白丢（线上 W31S3 h1/1 贴线约少运 2.2/tick）。槽位、补差槽、编制账、换代吞吐都走这一个函数 */
function requiredCarryFor(source, distance, dropRoom) {
    const rate = Math.max(5, (source.energyCapacity || 1500) / 300);
    const utilization = Math.max(0.5, Math.min(1, Number((config.remote || {}).haulUtilization) || 1));
    return Math.max(1, Math.ceil(rate * roundTripTicks(source, distance, dropRoom) / (50 * utilization)));
}

function haulerSlots(source, distance, capacity, dropRoom) {
    const requiredCarry = requiredCarryFor(source, distance, dropRoom);
    const slots = [];
    let plannedCarry = 0;
    let slotIndex = 0;
    while (plannedCarry < requiredCarry && slotIndex < 8) {
        const maintenance = slotIndex === 0;
        const need = Math.max(1, requiredCarry - plannedCarry);
        // 槽 0 按需求封顶；后续槽位补差额（下限 MIN_RESIDUAL_CARRY，否则差 1 CARRY 也会再来一只 hauler）
        const maxCarry = slotIndex === 0 ? need : Math.max(MIN_RESIDUAL_CARRY, need);
        const body = remoteHaulerBody(capacity, source.roadComplete, maintenance, maxCarry);
        const carry = carryParts(body);
        if (!carry) break;
        slots.push({ slotIndex, body, carry });
        plannedCarry += carry;
        slotIndex++;
    }
    return slots;
}

function staffingSettings() {
    const remote = config.remote || {};
    const queue = config.spawnQueue || {};
    return {
        share: remote.upkeepShare == null ? 0.5 : Math.max(0, Number(remote.upkeepShare)),
        slack: remote.upkeepSlack == null ? 1.3 : Math.max(1, Number(remote.upkeepSlack)),
        samples: queue.incomeSamples == null ? 200 : Number(queue.incomeSamples),
        minIncome: queue.minIncome == null ? 1 : Number(queue.minIncome),
    };
}

/** 本房能拿出来的收入估计（/tick）：spawn 能量正增量的 EMA（与 spawn.js 的 incomeEstimate 同口径）；
 *  样本不足（新房 / 刚重生）时返回 null = 收入未知。收入为 0 的房间不该背任何外矿编制。 */
function roomIncome(mem, settings) {
    const track = mem.spawnIncome;
    if (!track || Number(track.n) < settings.samples) return null;
    const ema = Math.max(0, Number(track.ema) || 0);
    return ema >= settings.minIncome ? ema : 0;
}

/** 一条外矿的编制账：摊销成本（能量/tick = 各身体造价 / 各自寿命）与产出（能量/tick，只算运回**本房**的）。
 *  卸货房是别的房时产出记 0——那笔能量记在卸货房的 spawn 收入里（record.drop），本房不该为它花自己的收入：
 *  线上 W33S7 的 W32S6/W33S5 两跳外矿把能量运给 W32S4，母房却替它们养 reserver/miner/hauler，
 *  一半收入花在别人身上，自己 storage 停在 197。 */
function recordPlan(record, capacity, homeName) {
    let upkeep = 0;
    let value = 0;
    // 孵化时间占用（spawn·tick / tick）：部件数 × 3 / 寿命。storage 富到能量没有边际价值时，外矿按它来限（staffRemotes）
    let spawnTime = 0;
    // 每个源一只矿工（以前只算了一只：双源外矿的摊销少算约 0.5/tick）
    for (const source of record.sources || []) {
        const miner = record.sk ? skMinerBody(capacity, source.roadComplete) : remoteMinerBody(capacity, source.roadComplete);
        if (!miner.length) continue;
        upkeep += bodyCost(miner) / CREEP_LIFE;
        spawnTime += miner.length * SPAWN_TICKS_PER_PART / CREEP_LIFE;
    }
    // SK 外矿：常驻一只 reaper（12 组 6000 能量 / 1500 tick = 4/tick），没有 reserver（keeper 房没有 controller）
    if (record.sk) {
        const reaper = skReaperBody(capacity);
        upkeep += bodyCost(reaper) / CREEP_LIFE;
        spawnTime += reaper.length * SPAWN_TICKS_PER_PART / CREEP_LIFE;
    }
    const reserver = record.sk ? [] : reserverBody(capacity);
    if (reserver.length) {
        // 2 CLAIM 的 reserver 造价翻倍、覆盖的预定也翻倍（每 CLAIM 每 tick +1），摊销仍是 造价 / (寿命 × CLAIM 数)
        const claims = Math.max(1, reserver.filter((part) => part === CLAIM_PART).length);
        upkeep += bodyCost(reserver) / (CLAIM_LIFE * claims);
        spawnTime += reserver.length * SPAWN_TICKS_PER_PART / (CLAIM_LIFE * claims);
    }
    const self = !record.drop || record.drop.room === homeName;
    const dropDistance = !self && record.drop && record.drop.distance > 0 ? record.drop.distance : null;
    const dropName = (record.drop && record.drop.room) || homeName;
    for (const source of record.sources || []) {
        if (self) value += Math.max(5, (source.energyCapacity || 1500) / 300);
        if (!source.containerId) continue;
        const distance = dropDistance || source.distance || 50;
        for (const slot of haulerSlots(source, distance, capacity, dropName)) {
            upkeep += bodyCost(slot.body) / CREEP_LIFE;
            spawnTime += slot.body.length * SPAWN_TICKS_PER_PART / CREEP_LIFE;
        }
    }
    return { upkeep, value, spawnTime };
}

/** 外矿孵化时间上限（spawn·tick / tick）：母房 storage 富到能量没有边际价值（≥ spawnCapStorageAbove，滞回到 spawnCapStorageBelow 退出）时，
 *  外矿 creep 最多占 spawn 数 × richSpawnShare 的孵化时间，把剩下的留给升级者/hauler。
 *  线上 2026-09-11 W33S3：storage 34 万、单 spawn 被 12 只 remoteHauler + 矿工 + reserver 占掉 80% 的孵化时间，
 *  storage 富余加的升级者（目标 3）一只也排不上，控制器只有 1 只 16 WORK；外矿运回的能量只是继续堆进 storage。 */
function remoteSpawnCap(home, mem) {
    const above = positiveSetting('spawnCapStorageAbove', 100000);
    const below = Math.min(above, positiveSetting('spawnCapStorageBelow', 60000));
    const storage = home.storage && home.storage.my !== false && home.storage.store;
    const stored = storage ? Number(storage[RESOURCE_ENERGY] || 0) : 0;
    const was = !!mem.remoteSpawnCapped;
    const on = stored >= above || (was && stored >= below);
    if (on !== was) mem.remoteSpawnCapped = on;
    if (!on) return Infinity;
    const spawns = typeof home.find === 'function' ? home.find(FIND_MY_SPAWNS).length : 1;
    return Math.max(1, spawns) * positiveSetting('richSpawnShare', 0.5);
}

/** 每 tick 给每条启用中的外矿打编制标记：按 价值 − 成本 从高到低累加，累计摊销成本 ≤ 收入 × upkeepShare 的才在编。
 *  已在编的外矿用 upkeepSlack 放宽（收入抖动时不来回停启）。不在编的外矿不再补员，存量 creep 自然到期退役。 */
function staffRemotes(home, mem) {
    const settings = staffingSettings();
    const capacity = home.energyCapacityAvailable || 0;
    const income = roomIncome(mem, settings);
    // 收入未知（样本不足）：不做编制预算——按收入裁编制是**破坏性**的（不在编的外矿不再补员、存量 creep 退役），
    // 而在没有数据时裁掉可能只是把好外矿白扔；反过来多养 200 tick 是自限的（队列的宽限/缩身会处理）。
    const budget = income == null ? Infinity : income * settings.share;
    const spawnCap = remoteSpawnCap(home, mem);
    const entries = [];
    for (const roomName in mem.remotes) {
        const record = mem.remotes[roomName];
        if (!record.enabled) { delete record.staffed; continue; }
        const plan = recordPlan(record, capacity, home.name);
        entries.push({ record, upkeep: plan.upkeep, value: plan.value, spawnTime: plan.spawnTime });
    }
    entries.sort((a, b) => (b.value - b.upkeep) - (a.value - a.upkeep) || a.record.room.localeCompare(b.record.room));
    let used = 0;
    let spawnUsed = 0;
    const staffed = [];
    const dropped = [];
    const selfFundedRooms = [];
    const spawnCapped = [];
    const overBudget = [];
    const cost = {};
    for (const entry of entries) {
        cost[entry.record.room] = Math.round(entry.upkeep * 100) / 100;
        const limit = budget * (entry.record.staffed ? settings.slack : 1);
        // 运回本房且产出 > 摊销的外矿自负盈亏：它的 creep 由它自己运回来的能量支付，不受收入预算约束。
        // 收入（spawn 能量正增量 EMA）里本来就含它的交付——拿收入去卡它是循环论证：一条外矿掉员 → 收入降 →
        // 预算降 → 再裁下一条。线上 2026-09-11 W33S7 两小时内在编外矿 2 → 0（EMA 7.5 → 0.04），四个源停采、预定断档。
        // 预算只仲裁"替别的房养"的外矿（卸货房不是本房，value 0）；自负盈亏的摊销仍计入 used，先从预算里扣。
        const selfFunded = entry.value > entry.upkeep;
        if (selfFunded) selfFundedRooms.push(entry.record.room);
        // 孵化时间上限（只在母房 storage 富到能量没有边际价值时生效）：已在编的放宽 10% 防抖
        const spawnLimit = spawnCap * (entry.record.staffed ? 1.1 : 1);
        const spawnOk = spawnUsed + entry.spawnTime <= spawnLimit;
        if (!spawnOk && (selfFunded || used + entry.upkeep <= limit)) spawnCapped.push(entry.record.room);
        if (spawnOk && (selfFunded || used + entry.upkeep <= limit)) {
            if (used + entry.upkeep > limit) overBudget.push(entry.record.room);   // 自负盈亏、超出收入预算仍在编（旧规则会裁掉）
            entry.record.staffed = true;
            used += entry.upkeep;
            spawnUsed += entry.spawnTime;
            staffed.push(entry.record.room);
        } else {
            entry.record.staffed = false;
            dropped.push(entry.record.room);
        }
    }
    // 持久的决策事件（remoteStaff 每 tick 覆盖，收入回升后就看不到了）：自负盈亏超预算仍在编 / 超孵化时间上限不在编
    if (overBudget.length) mem.remoteOverBudgetSeen = { at: Game.time, rooms: overBudget, budget: Math.round(budget * 10) / 10 };
    if (spawnCapped.length) mem.remoteSpawnCappedSeen = { at: Game.time, rooms: spawnCapped, cap: spawnCap, used: Math.round(spawnUsed * 1000) / 1000 };
    mem.remoteStaff = {
        at: Game.time,
        income: income == null ? null : Math.round(income * 10) / 10,
        budget: income == null ? null : Math.round(budget * 10) / 10,
        used: Math.round(used * 10) / 10,
        staffed,
        dropped,
        selfFunded: selfFundedRooms,   // 运回本房、产出 > 摊销：不受预算约束（私服断言据此区分两类外矿）
        spawnCap: Number.isFinite(spawnCap) ? spawnCap : null,   // 外矿孵化时间上限（storage 富时才有）
        spawnUsed: Math.round(spawnUsed * 1000) / 1000,
        spawnCapped,   // 能量上养得起、但超出孵化时间上限而不在编的外矿
        overBudget,    // 自负盈亏、超出收入预算仍在编的外矿（旧规则会裁掉）
        cost,   // 每条外矿的摊销成本（能量/tick）：预算决策的依据，监控/私服断言都读它
    };
    return mem.remoteStaff;
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my || home.controller.level < config.remote.minRcl) return [];
    const remotes = homeMemory(home.name).remotes;
    const username = myUsername(home);
    const capacity = home.energyCapacityAvailable;
    const demands = [];
    let priority = 0;
    // 先补大脑白名单里排在前面的外矿（评分高），白名单外/无指令时按房名
    const directive = brain.directive(home.name);
    const rank = {};
    ((directive && directive.remotes) || []).forEach((name, index) => { rank[name] = index; });
    const rankOf = (record) => (record.room in rank ? rank[record.room] : 1000);
    // 容器已建成的外矿先补（矿工到岗立刻有收入），其余按白名单顺序：W34S7 的 W34S8 有容器却排在刚纳入、还没开矿的 W32S8 后面
    const ready = (record) => ((record.sources || []).some((source) => source.containerId) ? 0 : 1);
    const records = Object.values(remotes).sort((a, b) => (ready(a) - ready(b)) || (rankOf(a) - rankOf(b)) || a.room.localeCompare(b.room));
    for (const record of records) {
        // 削 Invader 残余预定期间（clearReservation）：外矿整体停着，只出一只 reserver 去 attackController
        if (record.enabled && record.clearReservation && record.suspendedUntil > Game.time && !record.sk &&
            withinDistance(home.name, record.room) && !hasReserver(home.name, record.room)) {
            const clearBody = reserverBody(capacity);
            if (clearBody.length) {
                demands.push(demand('reserver', 'reserver:' + record.room, clearBody, { home: home.name, remoteRoom: record.room },
                    clearBody.length * 3 + controllerTravelDistance(home, record) + 20, priority++));
            }
            continue;
        }
        if (!record.enabled || record.suspendedUntil > Game.time || !withinDistance(home.name, record.room)) continue;
        // 编制预算外（staffRemotes 每 tick 按收入算）：不补员，存量 creep 自然到期退役——房不再替养不起的外矿花钱
        if (record.staffed === false) continue;
        // maintain：这个外矿已有容器在产出，它的矿工/reserver/hauler 替补是在维持收入（spawn 队列给更高的优先级）
        const maintain = ready(record) === 0;
        // 同一外矿内：miner → reserver → hauler。miner 一到就有收入（源 1500 档也是 5/tick），reserver 只是把源提到 3000 档；
        // 线上 W33S7 容量到 1300 后，排在前面的 1300 reserver 买不起，把 700 的 miner 一起卡了上千 tick
        const sources = record.sources.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
        // 试探式恢复：曾不可达且此后没有 creep 看到该房（lastSeen 不晚于最后一次标记）时只出第一只矿工——它到了 refreshVisible 才放开
        // 其余源的矿工、reserver 与 hauler；否则冷却到期整套 creep 重试一轮，再卡住就全废
        const probing = record.unreachableAt > 0 && !(record.lastSeen > record.unreachableAt);
        // SK 外矿：先有 reaper 才有别人。keeper 每 300 tick 复活一次，没有常驻 reaper 就是把矿工往枪口上送。
        // reaper 需求一直挂着（spawn 按寿命提前量换代），不给 bodyFor = 不缩身；它不在岗（还没进房）这一轮不为这个房出别的需求
        if (record.sk) {
            if (!skAllowed(home)) continue;
            const reaperBody = skReaperBody(capacity);
            if (!reaperBody.length) { record.skHeld = { at: Game.time, capacity }; continue; }
            const travel = sources.reduce((best, source) => Math.min(best, source.distance || 50), 50);
            const reaperDemand = demand('skReaper', 'skReaper:' + record.room, reaperBody,
                { home: home.name, remoteRoom: record.room }, reaperBody.length * 3 + travel + 20, priority++);
            reaperDemand.maintain = maintain;
            demands.push(reaperDemand);
            if (!reaperOnStation(home.name, record.room)) { record.skWaitReaper = Game.time; continue; }
            // 遥测：reaper 在岗（first = 第一次放开矿工/运输工的 tick；私服断言据此核对"矿工只在 reaper 到岗后才开采"）
            if (!record.skStation) record.skStation = { first: Game.time };
            record.skStation.at = Game.time;
        }
        const minerBodyFor = (budget, roadComplete) => (record.sk ? skMinerBody(budget, roadComplete) : remoteMinerBody(budget, roadComplete));
        for (const source of sources) {
            const minerBody = minerBodyFor(capacity, source.roadComplete);
            if (!minerBody.length) continue;
            const slot = 'remoteMiner:' + record.room + ':' + source.id;
            const lead = minerBody.length * 3 + (source.distance || 50) + 20;
            const minerDemand = demand('remoteMiner', slot, minerBody,
                { home: home.name, remoteRoom: record.room, sourceId: source.id }, lead, priority++,
                (budget) => minerBodyFor(budget, source.roadComplete));
            minerDemand.maintain = maintain && !!source.containerId;
            // 这具身体在这个槽位每 tick 能采多少：spawn 用它判断缩身矿工值不值得换代（2 WORK 的 350 档对着 10/tick 的源）
            const sourceRate = Math.max(5, (source.energyCapacity || 1500) / 300);
            minerDemand.throughput = (body) => Math.min(sourceRate, bodyPartCount(body, 'work') * 2);
            demands.push(minerDemand);
            if (probing) break;
        }
        if (probing) continue;

        // keeper 房没有 controller：不派 reserver
        const reserveBody = record.sk ? [] : reserverBody(capacity);
        const reserveGrace = positiveSetting('reserverGrace', 60);
        // 请求要先等能量，再孵化和赶路；单 CLAIM 在岗没有预定缓冲，不能等到旧寿命只够孵化+路程才入队。
        const reserveLead = reserveGrace + reserveBody.length * 3 + controllerTravelDistance(home, record) + 20;
        // 只按预定余量补（config.remote.reservationKeep）：以前"有 reserver 活着"本身就是触发条件，在岗者 TTL ≤ lead 就孵下一只，
        // 链条永不中断，预定顶到 5000 上限后新 reserver 的 reserve 全被引擎拒绝
        const reserveKeep = positiveSetting('reservationKeep', 1000);
        const reservationLeft = effectiveReservation(record, username);
        if (reserveBody.length && reservationLeft > reserveLead + DEMAND_BUFFER + reserveKeep && hasReserver(home.name, record.room)) {
            // 遥测：预定充足、在岗 reserver 到期也不续派（旧规则只要有 reserver 活着就出需求）
            record.reserverSkip = { at: Game.time, reservation: reservationLeft };
        }
        // 每口源都有在岗矿工、却都采不动预定多出来的那一半时不出 reserver（reserveGain）：矿工换代成 ≥3 WORK 之后再预定，
        // 断档的代价只是一次再生。有源没人采时照旧（接班的多半是理想身体）
        const reserveDue = reserveBody.length && reservationLeft <= reserveLead + DEMAND_BUFFER + reserveKeep;
        const usable = reserveDue ? reserveGain(home, record, sources) : null;
        if (usable && usable.manned > 0 && usable.unmanned === 0 && usable.gain < positiveSetting('reserveMinGain', 1)) {
            // 遥测：预定该续了，但矿工太弱、预定多出的产量没人采（旧规则照样派 reserver）
            record.reserverWeakMiner = { at: Game.time, gain: usable.gain, n: (Number(record.reserverWeakMiner && record.reserverWeakMiner.n) || 0) + 1 };
        } else if (reserveDue) {
            const slot = 'reserver:' + record.room;
            // Prefer two CLAIM for reserve growth, but a single CLAIM can bridge an expiring incumbent.
            // The queue must see the absolute safe-start deadline as well as the normal refill grace.
            const doubleClaim = positiveSetting('reserverDoubleClaimCapacity', 1650);
            const replacing = hasReserver(home.name, record.room);
            const startDeadline = replacing ? reserverStartDeadline(home, record, username) : null;
            const criticalHandoff = startDeadline != null && startDeadline <= Game.time + reserveGrace;
            const reserveDemand = demand('reserver', slot, reserveBody,
                { home: home.name, remoteRoom: record.room }, reserveLead, priority++,
                capacity >= doubleClaim && replacing
                    // 拒绝缩身时记一笔：这是"为什么这条外矿迟迟没有新 reserver"的答案（遥测 + 私服生效断言）
                    ? (budget) => { if (budget >= doubleClaim || criticalHandoff) return reserverBody(budget); record.reserverHeld = Game.time; return []; }
                    : (budget) => reserverBody(budget));
            reserveDemand.grace = reserveGrace;
            if (startDeadline != null) reserveDemand.neededBy = startDeadline;
            reserveDemand.maintain = maintain;
            demands.push(reserveDemand);
        }

        // 运输工往路程最短的己方房卸货（record.drop）：往返距离按卸货房算，否则按母房距离编制会多出几只 hauler
        const dropDistance = record.drop && record.drop.room !== home.name && record.drop.distance > 0 ? record.drop.distance : null;
        const dropName = (record.drop && record.drop.room) || home.name;
        for (const source of sources) {
            const distance = dropDistance || source.distance || 50;
            // 容器建成前不出 hauler：矿工独自建 5000 的容器要 600+ tick，提前孵的 hauler 只会在矿位空等（soak：3 只等了 700 tick）。
            // 容器丢了（烂掉/被拆，containerLostAt）不一样：地上堆着容器倒出来的存货和矿工的溢出，槽 0 的维护 hauler 带 WORK，
            // 会捡掉落、用自己的货把容器工地建起来（线上 W32S7 容器消失后 h0/0，地上 1969 能量烂光，外矿零交付约 2500 tick）
            const lost = !source.containerId && Number(source.containerLostAt) > 0;
            if (!source.containerId && !lost) continue;
            const rate = Math.max(5, (source.energyCapacity || 1500) / 300);
            const planned = haulerSlots(source, distance, capacity, dropName);
            const slots = lost ? planned.filter((plan) => plan.slotIndex === 0) : planned;
            if (lost) record.containerLostHaul = { at: Game.time, source: source.id, lostAt: source.containerLostAt };
            source.haulNeed = requiredCarryFor(source, distance, dropName);   // 遥测：这条运输线需要同时在途的 CARRY
            source.haulStops = deliveryStops(dropName);                        // 遥测：编制按的投递停靠（实测或回退值）
            for (const plan of slots) {
                const { slotIndex, body, carry: bodyCarry } = plan;
                const slot = 'remoteHauler:' + record.room + ':' + source.id + ':' + slotIndex;
                const lead = body.length * 3 + distance + 20;
                const haulDemand = demand('remoteHauler', slot, body, {
                    home: home.name,
                    remoteRoom: record.room,
                    sourceId: source.id,
                    haulSlot: slotIndex,
                    state: 'collect',
                }, lead, priority++, (budget) => remoteHaulerBody(budget, source.roadComplete, slotIndex === 0, bodyCarry));
                haulDemand.maintain = true;   // 有容器才会出 hauler 需求
                // 这具身体每 tick 能运回多少（CARRY×50 / 往返），封顶源产出：spawn 用它判断缩身 hauler 值不值得换代
                haulDemand.throughput = (body) => Math.min(rate, carryParts(body.map((part) => (part && part.type) || part)) * 50 / roundTripTicks(source, distance, dropName));
                demands.push(haulDemand);
            }
            const residual = lost ? null : residualHaulerDemand(home, record, source, slots, distance, capacity, priority, dropName);
            if (residual) { demands.push(residual); priority++; }
        }
    }
    return demands;
}

/** 补差槽：槽位按理想身体规划、按人头计数，缩身出来的 hauler（remoteMaintain 过了宽限按理想成本一半缩身、收入为 0 时更小）
 *  占住槽位后既不补差额、换代又要一次买得起理想身体（opportunistic，穷房很少触发），源容器常年满仓、矿工停手。
 *  线上 2026-09-11：W34S8 需要 38 CARRY、在途 17–22，源只采到 4.3/10；全账号快照里没人运的外矿产出约 20–23/tick。
 *  计划槽位都有人（未退役、寿命高于提前量或孵化中）而在途 CARRY 仍比需求少 MIN_RESIDUAL_CARRY 以上时，
 *  发一个 remoteHauler:<房>:<源>:x 槽，身体按缺口封顶；补上后缺口消失，这只到期不再替补 */
function residualHaulerDemand(home, record, source, slots, distance, capacity, priority, dropName) {
    if (!slots.length) return null;
    // 买得起理想身体时让换代（spawn.demandUpgradeRequests）把缩身的换掉；补差只给攒不出理想身体的穷房
    if ((home.energyAvailable || 0) >= bodyCost(slots[0].body)) return null;
    const required = requiredCarryFor(source, distance, dropName);
    const prefix = 'remoteHauler:' + record.room + ':' + source.id + ':';
    const lead = slots[0].body.length * 3 + distance + 20;
    const live = creepsHomeRole(home.name, 'remoteHauler').filter((creep) => !isRetiring(creep.memory) &&
        creep.memory.remoteRoom === record.room && creep.memory.sourceId === source.id &&
        (creep.spawning || creep.ticksToLive == null || creep.ticksToLive > lead));
    const filled = slots.every((slot) => live.some((creep) => creep.memory.slotKey === prefix + slot.slotIndex));
    if (!filled) return null;
    const liveCarry = live.reduce((sum, creep) => sum + carryParts((creep.body || []).map((part) => (part && part.type) || part)), 0);
    const gap = required - liveCarry;
    if (gap < MIN_RESIDUAL_CARRY) return null;
    const body = remoteHaulerBody(capacity, source.roadComplete, false, gap);
    if (!carryParts(body)) return null;
    const item = demand('remoteHauler', prefix + 'x', body, {
        home: home.name, remoteRoom: record.room, sourceId: source.id, haulSlot: 'x', state: 'collect',
    }, body.length * 3 + distance + 20, priority, (budget) => remoteHaulerBody(budget, source.roadComplete, false, gap));
    item.maintain = true;
    item.residual = { required, live: liveCarry, gap };
    record.residualSeen = { at: Game.time, source: source.id, required, live: liveCarry, gap };   // 遥测：出过补差槽
    return item;
}

/** Replacements whose normal request window would open during the next occupied spawn slot. */
function reserverHandoffs(home, demands, blockingTicks) {
    if (!(blockingTicks > 0)) return [];
    return (demands || []).filter((item) => {
        if (item.role !== 'reserver') return false;
        const assigned = creepsHomeRole(home.name, 'reserver').filter((creep) =>
            !isRetiring(creep.memory) && creep.memory.remoteRoom === item.memory.remoteRoom);
        if (!assigned.length || assigned.some((creep) => creep.spawning || creep.ticksToLive == null ||
            creep.ticksToLive > item.lead + blockingTicks)) return false;
        // Already-due requests use the regular queue, including its bounded energy wait.
        return assigned.some((creep) => creep.ticksToLive > item.lead);
    });
}

module.exports = {
    dropRoom,
    remoteWhitelist,
    canClearReservation,
    noteTravel,
    isUnreachable,
    run,
    observe,
    getDemands,
    reserverHandoffs,
    getRemote,
    getSource,
    isSuspended,
    suspensionLeft,
    threatReason,
    effectiveReservation,
    reserverBody,
    remoteMinerBody,
    remoteHaulerBody,
    haulerSlots,
    requiredCarryFor,
    deliveryStops,
    staffRemotes,
    entryPosition,
    noteRoadTrail,
    pruneOrphanRoadSites,
    isDisabled,
    skSettings,
    skAllowed,
    skReaperBody,
    skMinerBody,
    reaperOnStation,
    ringTile,
    isKeeper,
    keeperThreatFor,
    keeperRetreat,
    noteSkHarvest,
    noteReaperLoss };
