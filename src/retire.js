'use strict';
/** 退役回收：走到全账号最近的 spawn 旁让它 recycleCreep，而不是原地 suicide。
 *  引擎（processor/intents/creeps/_die.js）：suicide 只退 CREEP_CORPSE_RATE = 20% × 剩余寿命比例 × 造价；
 *  spawn.recycleCreep 退 100% × 剩余寿命比例 × 造价（每部件上限 125），落进脚下容器或 tombstone，母房 task broker 当 collect 收走。
 *  线上 2026-09-05：defender（780 造价）打完回家还剩约 1150 寿命，suicide 退 120、回收退 600。
 *  - 最近 = Game.map.findRoute 房数最少（没有 findRoute 时按房名线性距离），同房再按格距；不限母房，谁近去谁那。
 *    选定后缓存在 creep.memory.retireSpawn（id），spawn 没了就重选。
 *  - 值不值得走：走 t tick 后回收得 (ttl − t)/寿命 × 造价，原地 suicide 得 0.2 × ttl/寿命 × 造价，
 *    t < (1 − 0.2) × ttl 才划算（config.retire.walkShare）；估不出路、没有 spawn、寿命不够都退回 suicide。
 *  - 走的途中每 recheckTicks 复核一次（估计只是平地下限：沼泽 / 绕开危险房会更久），剩余寿命不够走完就原地 suicide 保住 20%；
 *    寻路失败（ERR_NO_PATH）同样 suicide，别站着耗寿命。
 *  - 同一 spawn 同一 tick 只发一条 recycleCreep 意图（driver runtime 的 intents.set 按对象覆盖同名意图，第二条会吞掉第一条），
 *    后来的原地等下一 tick。
 *  调用方：defender（memory.retired）、spawn.retireReplaced（memory.bodyUpgradeRetiring）、外矿角色在外矿停用时；
 *  前两者是黏性的，spawn.js 的编制计数用 utils.isRetiring 把它们排除，别为正在走向回收的旧 creep 再出替补预留。 */
const config = require('config');
const utils = require('utils');
const movement = require('movement');

const state = { tick: -1, claimed: new Set() };

function settings() {
    return Object.assign({ walkShare: 0.8, tilesPerRoom: 50, recheckTicks: 10, crippledGrace: 10 }, config.retire || {});
}

function claimedThisTick() {
    if (state.tick !== Game.time) { state.tick = Game.time; state.claimed = new Set(); }
    return state.claimed;
}

/** 全账号的 spawn（己方房总有视野）。不走每 tick 缓存：退役决定一只 creep 只做一次，且同 tick 被拆的 spawn 不该再被选中 */
function mySpawns() {
    const out = [];
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || typeof room.find !== 'function') continue;
        for (const spawn of room.find(FIND_MY_SPAWNS) || []) out.push(spawn);
    }
    return out;
}

/** 房间跳数：同房 0；findRoute 的段数；不通（ERR_NO_PATH）null；没有 findRoute 时按房名线性距离（房名非法 Infinity） */
function roomHops(from, to) {
    if (from === to) return 0;
    const map = typeof Game !== 'undefined' && Game.map;
    if (map && typeof map.findRoute === 'function') {
        const route = map.findRoute(from, to);
        if (!Array.isArray(route)) return null;
        if (route.length) return route.length;
    }
    return utils.roomDistance(from, to);
}

function rangeTo(pos, other) {
    return Math.max(Math.abs(pos.x - other.x), Math.abs(pos.y - other.y));
}

/** 走到 spawn 旁的估计 tick：格数 × 身体每格 tick（跨房每房算 tilesPerRoom 格，出房 + 进房到 spawn 再算半房） */
function travelTicks(creep, spawn, hops) {
    const tilesPerRoom = Number(settings().tilesPerRoom) || 50;
    const tiles = hops === 0 ? rangeTo(creep.pos, spawn.pos) : hops * tilesPerRoom + tilesPerRoom / 2;
    const perTile = utils.bodyTicksPerTile(creep.body);
    return perTile === Infinity ? Infinity : tiles * perTile;
}

function pickSpawn(creep) {
    let best = null;
    for (const spawn of mySpawns()) {
        if (!spawn || !spawn.pos) continue;
        const hops = roomHops(creep.pos.roomName, spawn.pos.roomName);
        if (!Number.isFinite(hops)) continue;
        const range = hops === 0 ? rangeTo(creep.pos, spawn.pos) : 0;
        if (!best || hops < best.hops || (hops === best.hops && range < best.range)) best = { spawn, hops, range };
    }
    return best;
}

function giveUp(creep) {
    delete creep.memory.retireSpawn;
    delete creep.memory.retireCheckAt;
    if (typeof creep.suicide === 'function') creep.suicide();
    return 'suicide';
}

/** 剩余寿命够不够走到这个 spawn（walkShare 的盈亏平衡：走 t tick 回收得 ttl − t，原地得 0.2 × ttl） */
function worthWalking(creep, spawn, hops) {
    const ttl = creep.ticksToLive == null ? Infinity : Number(creep.ticksToLive);
    return travelTicks(creep, spawn, hops) < settings().walkShare * ttl;
}

/** 每 tick 调一次直到 creep 消失。返回 'walk' | 'recycle' | 'wait' | 'suicide'（便于调用方与测试观察） */
function retireAtSpawn(creep) {
    if (!creep || !creep.memory || !creep.pos) return 'wait';
    if (creep.spawning) return 'wait';
    let spawn = creep.memory.retireSpawn ? Game.getObjectById(creep.memory.retireSpawn) : null;
    if (!spawn || !spawn.pos) {
        delete creep.memory.retireSpawn;
        const pick = pickSpawn(creep);
        if (!pick || !worthWalking(creep, pick.spawn, pick.hops)) return giveUp(creep);
        spawn = pick.spawn;
        creep.memory.retireSpawn = spawn.id;
        creep.memory.retireCheckAt = Game.time;
    } else if (Game.time - Number(creep.memory.retireCheckAt || 0) >= settings().recheckTicks) {
        // 途中复核：从当前位置重新估路（可能换了房、被绕路），寿命不够就别再走
        const hops = roomHops(creep.pos.roomName, spawn.pos.roomName);
        if (!Number.isFinite(hops) || !worthWalking(creep, spawn, hops)) return giveUp(creep);
        creep.memory.retireCheckAt = Game.time;
    }
    if (creep.pos.roomName === spawn.pos.roomName && creep.pos.isNearTo(spawn.pos)) {
        const claimed = claimedThisTick();
        if (claimed.has(spawn.id)) return 'wait';
        const ret = typeof spawn.recycleCreep === 'function' ? spawn.recycleCreep(creep) : ERR_INVALID_TARGET;
        if (ret !== OK) return giveUp(creep);   // RCL 不够用这个 spawn 之类：别站着耗寿命
        claimed.add(spawn.id);
        return 'recycle';
    }
    const moved = movement.go(creep, spawn.pos, { range: 1, reusePath: 30 });
    if (moved === ERR_NO_PATH) return giveUp(creep);
    return 'walk';
}

/** 残废日志：母房 Memory.rooms[home].crippledLog 最近 20 条（名字/角色/所在房/阵亡的部件种类/剩余寿命/tick），运维核对用 */
function noteCrippled(creep, lost) {
    const home = creep.memory.home;
    if (!home || typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const log = Array.isArray(mem.crippledLog) ? mem.crippledLog : (mem.crippledLog = []);
    log.push({ name: creep.name, role: creep.memory.role, room: creep.pos.roomName, lost, ttl: creep.ticksToLive == null ? null : creep.ticksToLive, at: Game.time });
    while (log.length > 20) log.shift();
}

/** 残废退役（main.js 每 tick 派活前调）：必需部件全阵亡（utils.crippledParts）的 creep 先观察 crippledGrace tick——本房有塔、没敌人时塔会把部件治回来——
 *  仍残废就标记 crippled（编制计数 utils.isRetiring 立刻排除它 → 替补马上出）并走向最近的 spawn 回收；宽限内或途中治好了就撤标记回岗。
 *  返回 true 表示本 tick 已接管这只 creep（调用方不要再派活） */
function retireCrippled(creep) {
    if (!creep || !creep.memory || creep.spawning) return false;
    const memory = creep.memory;
    const lost = utils.crippledParts(creep);
    if (!lost) {
        if (memory.crippled) { delete memory.retireSpawn; delete memory.retireCheckAt; }
        if (memory.crippled || memory.crippledSince != null) { delete memory.crippled; delete memory.crippledSince; }
        return false;
    }
    if (!memory.crippled) {
        if (memory.crippledSince == null) { memory.crippledSince = Game.time; return false; }
        if (Game.time - memory.crippledSince < settings().crippledGrace) return false;
        memory.crippled = Game.time;
        delete memory.crippledSince;
        noteCrippled(creep, lost);
    }
    retireAtSpawn(creep);
    return true;
}

/** 困在出生口袋里的 creep（spawn_exit.markPocketTrapped 打的 memory.pocketTrapped）：它一步都走不出去，让贴着的那只 spawn 当场回收
 *  （同 spawn 同 tick 只发一条 recycleCreep，后来的等下一 tick）；回收被拒（RCL 不够用这只 spawn 之类）就 suicide，别占着编制站到老死。
 *  已经不在那格（口袋被拆开、自己走出去了）或 spawn 没了：撤标记交还角色。遥测 Memory.rooms[房].spawnStallLog.trapped.recycled/code。
 *  返回 true 表示本 tick 已接管这只 creep（调用方不要再派活） */
function retirePocketTrapped(creep) {
    const trapped = creep && creep.memory && creep.memory.pocketTrapped;
    if (!trapped || creep.spawning) return false;
    const spawn = Game.getObjectById(trapped.spawn);
    if (!spawn || !spawn.pos || !creep.pos || creep.pos.roomName !== spawn.pos.roomName || creep.pos.x !== trapped.x || creep.pos.y !== trapped.y ||
        Math.max(Math.abs(creep.pos.x - spawn.pos.x), Math.abs(creep.pos.y - spawn.pos.y)) > 1) {
        delete creep.memory.pocketTrapped;
        return false;
    }
    const claimed = claimedThisTick();
    if (claimed.has(spawn.id)) return true;
    const ret = typeof spawn.recycleCreep === 'function' ? spawn.recycleCreep(creep) : ERR_INVALID_TARGET;
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[spawn.pos.roomName];
    const log = mem && mem.spawnStallLog && mem.spawnStallLog.trapped;
    if (log) { log.code = ret; log.codeAt = Game.time; }
    if (ret !== OK) { giveUp(creep); return true; }
    claimed.add(spawn.id);
    if (log) log.recycled = (Number(log.recycled) || 0) + 1;
    return true;
}

module.exports = { retireAtSpawn, retireCrippled, retirePocketTrapped };
