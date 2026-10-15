'use strict';
/** 外矿运输工：外矿源容器 ⇄ 卸货房（remote.dropRoom：全账号路程最短的己方房，出发时定下来不中途换）。
 *
 *  每 tick 先算、再动（与 roles/hauler 同一套引擎规则，docs/game/simultaneous-actions.md）：transfer / withdraw / pickup 与 move
 *  同 tick 互不冲突，射程按 tick 开始时的位置算，store 下一 tick 才变；同一 creep 的意图按 drop → transfer → withdraw → pickup 结算，
 *  withdraw / pickup 按结算时的空位截断。所以：
 *    - 外矿：掉落 + 容器同 tick 取（withdraw 显式只取掉落装不下的部分，会衰减的掉落全拿）；取满的那一 tick 就起步回家（以前取满那一 tick 站着）。
 *      同 tick 按容器记账：两只 hauler 贴着同一个容器时，后跑的那只按剩下的量算，不会以为自己也取满了提前走。
 *      等货时不站在矿位上（矿工的容器格）：站上去就挪到相邻空格（取货与让开同 tick）；等货点是贴着矿位、不是矿位本身。
 *      取不满时比较"等"与"走"：进账 × 一趟往返 ≤ 载货就带着现有的货走（hauler 比这条线一趟的产出还大时，干等不如先送）。
 *    - 卸货房：每次投递同 tick 挑下一站起步（排除刚投过的那格——tick 开始时它还显示有空位）；只挑没被本房 hauler 预留满的 spawn/ext；
 *      朝不相邻的主目标走时顺手灌一格相邻、没人预留的 spawn/ext；投递后 broker 同 tick 扣减（本房 hauler 后跑时看得到那格已经满了）；
 *      卸空当 tick 转回取货并朝外矿起步（外矿停用 / 不可达时不往外走）。
 *    - 寿命的最后一趟：卸空时寿命不够 去程 + 回程 + 余量（实测腿长 EMA，没有就按路程）且替补已在计划里 / 外矿容器放得下这段空档，
 *      就去 spawn 回收（退剩余寿命比例的造价）；在矿位寿命只够回程就带着现有的货走，连回程都不够就把货倒回容器。
 *      外矿停用比寿命还长（或太久）同样回收，不在家挂机到死。
 *    - 回程在外矿房里顺手修路：build 与 move 是不同管线，修路同 tick 照走；只有容器工地（容器丢了的恢复）才站着建。
 *  遥测：Memory.rooms[母房].remoteHaulAct {ac, acm}——结束一次停靠的动作 tick（取满/提前出发、投空、投完这格下一站不在旁边、路过顺手投）
 *  与其中同 tick 发出移动的 tick（旧代码这类 tick 从不移动）；
 *  Memory.rooms[母房].remoteHaul（其余决策事件计数）。私服生效断言按这些事件看。 */
const movement = require('movement');
const remote = require('remote');
const layout = require('layout');
const retireMod = require('retire');
const config = require('config');
const utils = require('utils');
const taskBroker = require('task_broker');
const haulStats = require('haul_stats');

// 常量在单测桩里可能缺：typeof 取，缺了用引擎的字面值
const ENERGY = typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY;
const STORAGE = typeof STRUCTURE_STORAGE === 'undefined' ? 'storage' : STRUCTURE_STORAGE;
const SPAWN = typeof STRUCTURE_SPAWN === 'undefined' ? 'spawn' : STRUCTURE_SPAWN;
const EXTENSION = typeof STRUCTURE_EXTENSION === 'undefined' ? 'extension' : STRUCTURE_EXTENSION;
const CONTAINER = typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER;
const ROAD = typeof STRUCTURE_ROAD === 'undefined' ? 'road' : STRUCTURE_ROAD;
const RAMPART = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
const WALL_MASK = typeof TERRAIN_MASK_WALL === 'undefined' ? 1 : TERRAIN_MASK_WALL;
const RC_OK = typeof OK === 'undefined' ? 0 : OK;
const RC_NOT_IN_RANGE = typeof ERR_NOT_IN_RANGE === 'undefined' ? -9 : ERR_NOT_IN_RANGE;

function settings() {
    return config.remote || {};
}

function setting(name, fallback) {
    const value = Number(settings()[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function activeWork(creep) {
    if (creep.getActiveBodyparts) return creep.getActiveBodyparts(typeof WORK === 'undefined' ? 'work' : WORK) > 0;
    return (creep.body || []).some((part) => (part.type || part) === 'work' && (part.hits == null || part.hits > 0));
}

function energyOf(target) {
    const store = target && target.store;
    return store ? Math.max(0, Number(store[ENERGY]) || 0) : 0;
}

/** 空位；store 没有 getFreeCapacity（单测桩）时按 Infinity，交给引擎的返回码判断 */
function freeOf(target) {
    const store = target && target.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return Infinity;
    return Math.max(0, Number(store.getFreeCapacity(ENERGY)) || 0);
}

function posOf(target) {
    return target && target.pos ? target.pos : target;
}

/** 切比雪夫距离；位置不全（单测桩）返回 null = 未知，调用方按引擎返回码处理；不同房 Infinity */
function rangeTo(creep, target) {
    const a = creep && creep.pos;
    const b = posOf(target);
    if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return null;
    if (a.roomName && b.roomName && a.roomName !== b.roomName) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function isNear(creep, target) {
    const range = rangeTo(creep, target);
    return range != null && range <= 1;
}

function note(creep, why) {
    if (haulStats && typeof haulStats.note === 'function') haulStats.note(creep, why);
}

function homeMem(creep) {
    if (typeof Memory === 'undefined' || !Memory.rooms || !creep || !creep.memory || !creep.memory.home) return null;
    return Memory.rooms[creep.memory.home] || (Memory.rooms[creep.memory.home] = {});
}

/** 决策事件计数：Memory.rooms[母房].remoteHaul[key]（私服生效断言按事件看，不看期末快照） */
function noteHaul(creep, key, amount) {
    const mem = homeMem(creep);
    if (!mem) return;
    const record = mem.remoteHaul || (mem.remoteHaul = {});
    record[key] = (Number(record[key]) || 0) + (amount == null ? 1 : amount);
    record.at = Game.time;
}

/** 卸货房的投递停靠实测：进房那一 tick 记起点和到锚点（storage，没有就 spawn——外矿路程就是量到它的）的格数，卸空时
 *  停靠 = 进房到卸空的 tick − 到锚点的格数（夹在 [0, 30]，卡在"没有投递目标"的等待不让它冲天），EMA 0.2 记进 Memory.rooms[卸货房].remoteStop。
 *  remote.requiredCarryFor 按它定编制：一次卸进 storage / 控制器容器的房约 1–3 tick，逐格灌 extension 的房更多 */
function startStopClock(creep, room) {
    if (creep.memory.stopAt != null) return;
    const anchor = room.storage || (typeof FIND_MY_SPAWNS !== 'undefined' ? (room.find(FIND_MY_SPAWNS) || [])[0] : null);
    const range = anchor ? rangeTo(creep, anchor) : null;
    if (range == null || !Number.isFinite(range)) return;
    creep.memory.stopAt = Game.time;
    creep.memory.stopDist = range;
}

function recordStop(creep, roomName) {
    const started = Number(creep.memory.stopAt);
    const dist = Number(creep.memory.stopDist) || 0;
    delete creep.memory.stopAt;
    delete creep.memory.stopDist;
    if (!(started > 0) || typeof Memory === 'undefined' || !Memory.rooms || !roomName) return;
    const stops = Math.max(0, Math.min(30, Game.time - started - dist));
    const mem = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    const record = mem.remoteStop || (mem.remoteStop = { ema: stops, n: 0 });
    record.ema = record.n > 0 ? Math.round((record.ema * 0.8 + stops * 0.2) * 100) / 100 : stops;
    record.n = (Number(record.n) || 0) + 1;
    record.last = stops;
    record.at = Game.time;
}

// ---- 每 tick 的计划：一类动作最多一次、移动最多一次 ----

/** acted：本 tick 有 transfer / withdraw / pickup 成功发出。
 *  stopEnd：本 tick 的动作结束了一次停靠、这一 tick 本该同时起步——取满（或提前）出发、投空、投完这一格后下一站不在旁边、路过顺手投；
 *  在容器旁涓流装货、投完这格下一站就贴着（下一 tick 接着投，本来就不用动）的 tick 不算 */
function newPlan() {
    return { acted: false, stopEnd: false, moved: false, built: false, exclude: new Set() };
}

/** 真正发出移动意图才记 moved（已在范围内时 movement.go 什么也不做） */
function go(creep, plan, target, opts) {
    const range = rangeTo(creep, target);
    const want = opts && opts.range != null ? opts.range : 1;
    if (plan && (range == null || range > want)) plan.moved = true;
    return movement.go(creep, target, opts);
}

/** 同一 tick 里别的 creep 已经从同一目标取走的量（引擎按执行顺序结算、取光为止，第一只把涓流全拿走）：两只 hauler 贴着同一个容器时，
 *  后跑的那只按剩下的量算，不会以为自己也能取满、提前起步空着走 */
const tickLedger = { tick: -1, taken: {} };
function takenThisTick(id) {
    if (tickLedger.tick !== Game.time) { tickLedger.tick = Game.time; tickLedger.taken = {}; }
    return tickLedger.taken[id] || 0;
}
function recordTaken(id, amount) {
    if (!id) return;
    takenThisTick(id);
    tickLedger.taken[id] = (tickLedger.taken[id] || 0) + amount;
}

function retireNow(creep) {
    if (retireMod && typeof retireMod.retireAtSpawn === 'function') return retireMod.retireAtSpawn(creep);
    return null;
}

/** 寿命相关的决策事件：Memory.rooms[母房].remoteTtl {retire, keep, depart, dump, at, last} */
function noteTtl(creep, key, detail) {
    const mem = homeMem(creep);
    if (!mem) return;
    const record = mem.remoteTtl || (mem.remoteTtl = {});
    record[key] = (Number(record[key]) || 0) + 1;
    record.at = Game.time;
    if (detail) record.last = Object.assign({ kind: key, at: Game.time }, detail);
}

function nearMySpawn(creep) {
    if (!creep.room || typeof FIND_MY_SPAWNS === 'undefined') return false;
    return (creep.room.find(FIND_MY_SPAWNS) || []).some((spawn) => isNear(creep, spawn));
}

/** 空载退役：标 retired（utils.isRetiring 立刻把槽位让给替补；spawn.retireReplaced / retire.retireCrippled 调的也是同一个
 *  retire.retireAtSpawn，哪条先标都只是走向同一个 spawn 回收，main.js 每 tick 只让其中一条接管），走向最近的 spawn 回收。
 *  本 tick 刚投递、又贴着 spawn 时这一 tick 先不回收（回收意图可能先于 transfer 结算，货会进 tombstone），下一 tick 空手再回收 */
function retireEmpty(creep, plan) {
    creep.memory.retired = true;
    note(creep, 'retire');
    if (plan && plan.acted && nearMySpawn(creep)) return;
    if (retireNow(creep) === 'walk' && plan) plan.moved = true;   // 朝 spawn 起步也是"同 tick 走"
}

// ---- 卸货房的投递目标 ----

/** controller 供能容器（中立建筑，不在 FIND_MY_STRUCTURES 里）：低于补给阈值才作为投递目标 */
function ctrlFeedContainer(room) {
    if (taskBroker.controllerFeedMode(room) === 'link') return null;
    const plan = (Memory.rooms && Memory.rooms[room.name] || {}).plan;
    if (!plan || !plan.containers || !plan.containers.ctrl) return null;
    if (layout.controllerFedByStorage(room, plan)) return null;   // 升级者由 storage 供能：容器不再喂
    const container = layout.structureAt(room, plan.containers.ctrl.x, plan.containers.ctrl.y, STRUCTURE_CONTAINER);
    if (!container || !container.store || container.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
    const fillBelow = Number(config.upgraderFillBelow) || 0.8;
    if (container.store[RESOURCE_ENERGY] >= container.store.getCapacity(RESOURCE_ENERGY) * fillBelow) return null;
    return container;
}

/** 按距离挑最近的（自己算切比雪夫：与引擎 findClosestByRange 同义；位置未知时退回 API） */
function closestOf(creep, list) {
    if (!list || !list.length) return null;
    let best = null;
    let bestRange = Infinity;
    for (const item of list) {
        const range = rangeTo(creep, item);
        if (range == null) {
            const found = creep && creep.pos && typeof creep.pos.findClosestByRange === 'function' ? creep.pos.findClosestByRange(list) : null;
            return found || list[0];
        }
        if (range < bestRange) { best = item; bestRange = range; }
    }
    return best || list[0];
}

/** 目标在 broker 池子里有投递任务时，别的 hauler 承诺的量还没把它填满（没有任务 = 重建间隔内新出现的缺口，照样可投） */
function openFor(creep, room, structure) {
    if (typeof taskBroker.pooledTasks !== 'function' || typeof taskBroker.availableFor !== 'function') return true;
    const tasks = deliverTasksByTarget(taskBroker.pooledTasks(room)).get(structure.id);
    if (!tasks || !tasks.length) return true;
    return tasks.some((task) => taskBroker.availableFor(task, creep) > 0);
}

/** 池子里的投递任务按目标 id 建索引：每只外矿 hauler 每 tick 要对几十格 extension 问"有没有被预留满"，逐格扫整个池子是 O(格 × 任务)。
 *  按池子数组本身缓存（broker 每 tick 刷新 / 每 3 tick 重建都会换一个新数组；同 tick 内 consume 只改任务里的 backlog，引用不变） */
const poolIndex = new WeakMap();
function deliverTasksByTarget(pool) {
    if (!pool || typeof pool !== 'object') return new Map();
    let index = poolIndex.get(pool);
    if (index) return index;
    index = new Map();
    for (const task of pool) {
        if (!task || task.kind !== 'deliver' || !task.target || task.target.id == null) continue;
        const list = index.get(task.target.id);
        if (list) list.push(task); else index.set(task.target.id, [task]);
    }
    poolIndex.set(pool, index);
    return index;
}

/**
 * 投递层级（与 hauler 一致）：见底的控制器供能（link / 容器 / storage）→ 紧急塔 → spawn/ext → ctrl link → 控制器容器 → 塔 → storage。
 * opts.exclude：本 tick 已经投过的目标 id（store 下一 tick 才变，tick 开始时它还显示有空位）；
 * opts.info：出参 { urgent }（主目标是见底供能 / 紧急塔时不顺路分货）。
 * spawn/ext 只挑没被别的 hauler 预留满的（全被预留就交给它们，这车往下一层送）；courier 也用这一份（不传 opts 即旧行为 + 预留过滤）。
 * 基地满能量时外矿能量必须有去处，否则 remoteHauler 满载在基地发呆，外矿收入归零。
 */
function homeTarget(room, creep, opts) {
    const options = opts || {};
    const exclude = options.exclude;
    const info = options.info || {};
    const allowed = (structure) => !!structure && !(exclude && structure.id != null && exclude.has(structure.id));
    const linkFeed = taskBroker.controllerFeedLink(room);
    if (linkFeed && linkFeed.starved && allowed(linkFeed.target)) { info.urgent = true; return linkFeed.target; }
    // 与 hauler 一致的公平供给：控制器容器见底且 spawn 能量 ≥ 一半时先送控制器
    const feedFirst = ctrlFeedContainer(room);
    if (feedFirst && allowed(feedFirst) && feedFirst.store[RESOURCE_ENERGY] < feedFirst.store.getCapacity(RESOURCE_ENERGY) * (Number(config.controllerFeedStarvedBelow) || 0.1) &&
        room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
        !utils.spawnWaitingFor(room)) { info.urgent = true; return feedFirst; }
    // 升级者由 storage 供能：storage 见底时同样先送 storage（公平规则在 controllerFeedStorage 里）
    const storageFeed = taskBroker.controllerFeedStorage(room);
    if (storageFeed && storageFeed.starved && allowed(storageFeed.target)) { info.urgent = true; return storageFeed.target; }
    const refillAt = Number(config.towerRefillAt) || 300;
    const hostile = room.find(FIND_HOSTILE_CREEPS).length > 0;
    const towers = room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => structure.structureType === STRUCTURE_TOWER && allowed(structure) &&
            structure.store && (structure.store.getFreeCapacity(RESOURCE_ENERGY) >= refillAt || hostile),
    });
    // 与 broker 一致：塔的大缺口（有敌人或储备被动用，utils.towerUrgent 锁存到补到不缺）先于 spawn/ext（spawn 持续孵化时 spawn/ext
    // 永远有缺口，塔会没人补）；和平期的维修消耗排在控制器之后、storage 之前
    const urgentTowers = towers.filter((structure) => utils.towerUrgent(room, structure, hostile));
    if (urgentTowers.length) { info.urgent = true; return closestOf(creep, urgentTowers); }
    const spawnOrExt = room.find(FIND_MY_STRUCTURES, {
        filter: (structure) => (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
            allowed(structure) && structure.store && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
    });
    if (spawnOrExt.length) {
        // 从近到远挑第一个没被别的 hauler 预留满的（位置未知时退回"可投的里最近的"）
        if (rangeTo(creep, spawnOrExt[0]) == null) {
            const open = spawnOrExt.filter((structure) => openFor(creep, room, structure));
            if (open.length) return closestOf(creep, open);
        } else {
            const sorted = spawnOrExt.slice().sort((a, b) => rangeTo(creep, a) - rangeTo(creep, b));
            for (const structure of sorted) if (openFor(creep, room, structure)) return structure;
        }
    }
    if (linkFeed && allowed(linkFeed.target)) return linkFeed.target;
    const feed = ctrlFeedContainer(room);
    if (feed && allowed(feed)) return feed;
    if (towers.length) return closestOf(creep, towers);
    if (room.storage && room.storage.my && allowed(room.storage) && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
    return null;
}

/** 载货路过的 spawn/ext（相邻、有空位、没被别人预留、不是主目标、本 tick 没投过）：顺手 transfer，不停步 */
function driveByTarget(creep, room, main, exclude) {
    if (typeof FIND_MY_STRUCTURES === 'undefined' || !creep.pos || typeof creep.pos.findInRange !== 'function') return null;
    const found = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
        filter: (s) => (s.structureType === SPAWN || s.structureType === EXTENSION) && s.store && freeOf(s) > 0,
    }) || [];
    for (const structure of found) {
        if (!structure || structure.id === (main && main.id)) continue;
        if (exclude && exclude.has(structure.id)) continue;
        const range = rangeTo(creep, structure);
        if (range == null || range > 1) continue;
        if (openFor(creep, room, structure)) return structure;
    }
    return null;
}

// ---- 家 ----

function idleHome(creep) {
    // 外矿已停用（改派/不可达/被占）且空载：去全账号最近的 spawn 回收退役（retire.js 自己跨房走，不必先回母房），不再占编制发呆
    if (creep.store[RESOURCE_ENERGY] <= 0 && (remote.isDisabled(creep.memory.home, creep.memory.remoteRoom) || remote.isUnreachable(creep.memory.home, creep.memory.remoteRoom))) {
        note(creep, 'retire');
        retireNow(creep);
        return;
    }
    // 停用比寿命还长（或超过 suspendRetireAfter）且空载：同 reserver.js，回收退役，不在家挂机到死
    if (creep.store[RESOURCE_ENERGY] <= 0 && suspendedTooLong(creep)) {
        noteHaul(creep, 'suspendRetire');
        retireEmpty(creep, null);
        return;
    }
    note(creep, creep.store[RESOURCE_ENERGY] > 0 ? 'full' : 'park');
    const home = Game.rooms[creep.memory.home];
    if (!home || creep.room.name !== home.name) {
        movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 30 });
        return;
    }
    const anchor = home.storage || home.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 4)) movement.go(creep, anchor, { range: 4, reusePath: 25 });
}

/** 一次 transfer 成功之后：broker 同 tick 扣减（本房 hauler 后跑时就看得到这格已经满了）、预计载货、遥测 */
function afterTransfer(creep, room, target, sent, before, plan, kind) {
    plan.acted = true;
    plan.exclude.add(target.id);
    if (typeof taskBroker.consume === 'function') taskBroker.consume(creep, room, target, sent, 'deliver');
    if (typeof taskBroker.setProjected === 'function') taskBroker.setProjected(creep, Math.max(0, before - sent));
    if (creep.room.name !== creep.memory.remoteRoom) creep.memory.remoteRoadDelivery = { at: Game.time, before };
    if (kind === 'driveBy') noteHaul(creep, 'driveBy');
    if (target.structureType === STORAGE) noteHaul(creep, 'storageDrops');
    else if (target.structureType === SPAWN || target.structureType === EXTENSION) noteHaul(creep, 'extStops');
}

/** 这一 tick 的投递会把车卸空：转回取货、清掉卸货房，外矿没停用 / 可达时同 tick 朝外矿起步。
 *  万一 transfer 在结算时落空（别的 creep 同 tick 先把那格灌满，引擎把量夹成 0），下一 tick run() 看到"取货状态却在己方房里揣着货"
 *  会转回投递——按真实 store 重新决策，不假设自己已经空了 */
function afterEmpty(creep, room, plan) {
    plan.stopEnd = true;
    noteHaul(creep, 'trips');
    recordStop(creep, room.name);
    creep.memory.state = 'collect';
    delete creep.memory.dropRoom;
    const home = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (remote.isSuspended(home, remoteRoom)) return;   // 含停用（!enabled）/ 不可达冷却：下一 tick run() 转 retreat
    if (ttlRetire(creep, plan, room.name)) return;       // 寿命不够下一趟：去 spawn 回收，不再出发
    creep.memory.leg = 'out';
    creep.memory.legAt = Game.time;
    creep.memory.legRoom = room.name;
    go(creep, plan, new RoomPosition(25, 25, remoteRoom), { range: 20, reusePath: 40 });
}

function deliver(creep, plan) {
    // 卸货房：全账号路程最短的己方房（remote.dropRoom），出发时定下来不中途换；放不下（没 storage/塔/容器可收）再退回母房
    if (!creep.memory.dropRoom) creep.memory.dropRoom = remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    const dropName = creep.memory.dropRoom;
    const room = Game.rooms[dropName];
    if (!room || creep.room.name !== dropName) {
        go(creep, plan, new RoomPosition(25, 25, dropName), { range: 20, reusePath: 35 });
        return;
    }
    if (creep.memory.leg === 'back') recordLeg(creep, 'back', dropName);   // 实测回程：离开外矿容器 → 进卸货房
    const energy = energyOf(creep);
    if (energy > 0) startStopClock(creep, room);
    if (energy <= 0) {
        creep.memory.state = 'collect';
        delete creep.memory.dropRoom;
        ttlRetire(creep, plan, dropName);
        return;
    }
    const info = {};
    const target = homeTarget(room, creep, { exclude: plan.exclude, info });
    if (!target) {
        if (dropName !== creep.memory.home) {
            creep.memory.dropRoom = creep.memory.home;
            delete creep.memory.stopAt;   // 换房卸：停靠从母房进房重新计
            delete creep.memory.stopDist;
            go(creep, plan, new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: 35 });
            return;
        }
        idleHome(creep);
        return;
    }
    const reach = rangeTo(creep, target);
    if (reach != null && reach > 1) {
        // 在路上：顺手灌相邻、没人预留的 spawn/ext（本 tick 唯一的 transfer）；主目标是见底供能 / 紧急塔时不分货
        const drive = info.urgent ? null : driveByTarget(creep, room, target, plan.exclude);
        if (drive) {
            const sent = Math.min(energy, freeOf(drive));   // 调用前取（真引擎 store 下一 tick 才变，mock 是立即变）
            if (sent > 0 && creep.transfer(drive, RESOURCE_ENERGY, sent) === RC_OK) {
                afterTransfer(creep, room, drive, sent, energy, plan, 'driveBy');
                plan.stopEnd = true;   // 路过顺手投：投的同一 tick 照走
                if (energy - sent <= 0) { afterEmpty(creep, room, plan); return; }
            }
        }
        go(creep, plan, target, { range: 1, reusePath: 20 });
        return;
    }
    // 显式数量 = tick 开始时的 min(身上的, 目标空位)，与引擎默认值相同（引擎对 amount + 存量 > 容量 直接 ERR_FULL）
    const free = freeOf(target);
    const sent = Number.isFinite(free) ? Math.min(energy, free) : energy;
    const transferred = sent > 0 ? creep.transfer(target, RESOURCE_ENERGY, sent) : RC_NOT_IN_RANGE;
    if (transferred === RC_NOT_IN_RANGE) {
        go(creep, plan, target, { range: 1, reusePath: 20 });
        return;
    }
    if (transferred !== RC_OK) {
        // ERR_FULL 之类：tick 开始时的数据已经过期，下一 tick 重新挑
        plan.exclude.add(target.id);
        return;
    }
    afterTransfer(creep, room, target, sent, energy, plan, 'main');
    const left = Math.max(0, energy - sent);
    if (left <= 0) { afterEmpty(creep, room, plan); return; }
    // 还有货：同 tick 挑下一站（排除刚投过的）并起步；下一站就在旁边时下一 tick 直接投（这一 tick 不用动，不算结束停靠）
    const next = homeTarget(room, creep, { exclude: plan.exclude, info: {} });
    if (next && isNear(creep, next)) return;
    plan.stopEnd = true;
    if (next) go(creep, plan, next, { range: 1, reusePath: 20 });
}

// ---- 外矿道路 ----

function roadBuildCost(creep, site) {
    const work = creep.getActiveBodyparts ? creep.getActiveBodyparts(typeof WORK === 'undefined' ? 'work' : WORK) :
        (creep.body || []).filter((part) => (part.type || part) === 'work' && (part.hits == null || part.hits > 0)).length;
    const remaining = site.progressTotal == null ? Infinity : Math.max(0, site.progressTotal - (site.progress || 0));
    return Math.min(work * (typeof BUILD_POWER === 'undefined' ? 5 : BUILD_POWER), remaining, creep.store[RESOURCE_ENERGY]);
}

function settleRoadBudget(creep) {
    const pending = creep.memory.remoteRoadPending;
    if (pending && pending.at < Game.time) {
        // 错过紧邻采样时无法区分后续取货，保守预约该意图上限，不能把预算当作未花。
        const spent = pending.at === Game.time - 1 ?
            Math.min(pending.max, Math.max(0, pending.before - creep.store[RESOURCE_ENERGY])) : pending.max;
        creep.memory.remoteRoadSpent = (creep.memory.remoteRoadSpent || 0) + spent;
        const home = Memory.rooms && Memory.rooms[creep.memory.home];
        if (home && spent > 0 && pending.at === Game.time - 1) {
            const record = home.remoteRoadBudget || (home.remoteRoadBudget = { spent: 0, deliveredTrips: 0 });
            record.spent += spent;
        }
        delete creep.memory.remoteRoadPending;
    }
    const delivered = creep.memory.remoteRoadDelivery;
    if (delivered && delivered.at < Game.time) {
        if (delivered.at === Game.time - 1 && creep.store[RESOURCE_ENERGY] < delivered.before) {
            const home = Memory.rooms && Memory.rooms[creep.memory.home];
            if (home && creep.memory.remoteRoadSpent > 0) {
                const record = home.remoteRoadBudget || (home.remoteRoadBudget = { spent: 0, deliveredTrips: 0 });
                record.deliveredTrips++;
                record.maxTripSpent = Math.max(record.maxTripSpent || 0, creep.memory.remoteRoadSpent);
                record.delivered = (record.delivered || 0) + delivered.before - creep.store[RESOURCE_ENERGY];
                record.at = Game.time;
            }
            delete creep.memory.remoteRoadSpent;
        }
        delete creep.memory.remoteRoadDelivery;
    }
}

// 一条满载腿在外矿房里的走线上限：超过就说明这趟不正常（绕了远路 / 被堵住兜圈），整趟丢弃不拿去改规划
const TRAIL_MAX = 60;

/** 满载腿在外矿房内逐格记下真实走线。只记满载腿：空车去程的寻路目标是外矿房心，与规划器同侧、走的恰好是规划路，
 *  记了会把失配洗成"对得上"；而且空车身上 0 能量，第 486 行就返回，本来也修不了路。 */
function traceRoadTile(creep) {
    const trail = creep.memory.roadTrail || (creep.memory.roadTrail = []);
    if (trail.length >= TRAIL_MAX) return;
    const tag = creep.pos.x + '.' + creep.pos.y;
    if (trail[trail.length - 1] !== tag) trail.push(tag);
}

/** 离开外矿房：把这一趟的走线交给 remote.noteRoadTrail 判定是否与规划路失配（连续几趟失配就改规划）。
 *  太短（没走几格就出房）和被 TRAIL_MAX 截断的都丢弃，它们代表不了整条腿。 */
function flushRoadTrail(creep) {
    const trail = creep.memory.roadTrail;
    if (!trail) return;
    delete creep.memory.roadTrail;
    if (!Array.isArray(trail) || trail.length < 3 || trail.length >= TRAIL_MAX) return;
    if (typeof remote.noteRoadTrail !== 'function') return;
    remote.noteRoadTrail(creep.memory.home, creep.memory.remoteRoom, creep.memory.sourceId, creep.memory.srcIdx, trail.join(';'));
}

/** 范围 3 内的外矿基建：容器工地（不限预算、站着建——容器丢了的恢复）返回 'container'；路工地（每趟 50 能量预算）返回 'road'；
 *  维修（半血以下的路/容器）返回 'repair'；没活 false。build 与 move 是不同管线（引擎 intents.js 的 build 只与 repair/dismantle/
 *  attackController/heal 冲突），射程按 tick 开始时的位置算：路工地修完照走，由调用方负责移动 */
function nearbyInfrastructureWork(creep) {
    if (!activeWork(creep) || creep.store[RESOURCE_ENERGY] <= 0) return false;
    const inReach = (item) => { const range = rangeTo(creep, item); return range == null || range <= 3; };
    const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, {
        filter: (item) => inReach(item) && (item.structureType === STRUCTURE_CONTAINER ||
            (item.structureType === STRUCTURE_ROAD && roadBuildCost(creep, item) <= Math.max(0, 50 - (creep.memory.remoteRoadSpent || 0)))),
    })[0];
    if (site) {
        const before = creep.store[RESOURCE_ENERGY];
        if (creep.build(site) === RC_OK) {
            if (site.structureType !== STRUCTURE_ROAD) return 'container';
            creep.memory.remoteRoadPending = { at: Game.time, before, max: roadBuildCost(creep, site) };
            return 'road';
        }
    }
    const damaged = creep.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: (item) => inReach(item) && (item.structureType === STRUCTURE_ROAD || item.structureType === STRUCTURE_CONTAINER) &&
            item.hits < item.hitsMax * 0.5,
    })[0];
    if (damaged) {
        creep.repair(damaged);
        return 'repair';
    }
    return false;
}

// ---- 路程、进账与"等还是走" ----

/** 外矿 ↔ 卸货房的路程（格）：卸货房是别的房时用 record.drop.distance（从卸货房锚点量）；卸货房是母房时 drop.distance 是 null，
 *  用 source.distance（从母房锚点量）——source.distance 永远是从母房量的，卸货房不是母房时不能用它 */
function routeDistance(creep, sourceMemory) {
    const home = creep.memory.home;
    const record = typeof remote.getRemote === 'function' ? remote.getRemote(home, creep.memory.remoteRoom) : null;
    const drop = record && record.drop;
    const dropName = creep.memory.dropRoom || (drop && drop.room) || home;
    if (drop && drop.room === dropName && dropName !== home && Number(drop.distance) > 0) return Number(drop.distance);
    return Math.max(1, Number(sourceMemory && sourceMemory.distance) || 50);
}

/** 满载每格 tick：路线铺完（roadComplete）按路上 1 tick/格（2:1 身体只在铺完时才给）；没铺完按身体在平地的 ceil(非 MOVE / MOVE)
 *  （1:1 身体 = 1；路后来烂出缺口还顶着 2:1 身体时是 2，偏保守）。沼泽、让路、跨房出口格留给余量 */
function ladenPerTile(creep, sourceMemory) {
    if (sourceMemory && sourceMemory.roadComplete) return 1;
    const perTile = typeof utils.bodyTicksPerTile === 'function' ? utils.bodyTicksPerTile(creep.body) : 1;
    return Number.isFinite(perTile) ? Math.max(1, perTile) : 1;
}

/** 一趟往返（"等还是走"用）：空载去程 1 tick/格 + 满载回程 + 卸货房的投递停靠（与编制同一个 remote.deliveryStops）+ 两端周转 */
function tripTicks(creep, sourceMemory) {
    const distance = routeDistance(creep, sourceMemory);
    const dropRoom = creep.memory.dropRoom || remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    const stops = typeof remote.deliveryStops === 'function' ? remote.deliveryStops(dropRoom) : setting('deliveryStopTicks', 10);
    return distance + distance * ladenPerTile(creep, sourceMemory) + stops + setting('turnTicks', 2);
}

function sourceRate(sourceMemory) {
    const regen = typeof ENERGY_REGEN_TIME === 'number' ? ENERGY_REGEN_TIME : 300;
    return Math.max(1, Number(sourceMemory && sourceMemory.energyCapacity) || 1500) / regen;
}

/** 源容器每 tick 的进账：矿位旁在采的外矿矿工 WORK × 2，封顶源产出（没有矿工 = 0：进账要等替补，干等也白等） */
function sourceInflow(creep, sourceMemory) {
    if (!sourceMemory || !sourceMemory.spot) return 0;
    const spot = sourceMemory.spot;
    const list = typeof utils.creepsHomeRole === 'function' ? utils.creepsHomeRole(creep.memory.home, 'remoteMiner') : [];
    const power = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
    let work = 0;
    for (const miner of list) {
        if (!miner || miner.spawning || !miner.memory || miner.memory.sourceId !== sourceMemory.id || !miner.pos) continue;
        if (miner.pos.roomName !== creep.memory.remoteRoom || Math.max(Math.abs(miner.pos.x - spot.x), Math.abs(miner.pos.y - spot.y)) > 1) continue;
        work += typeof miner.getActiveBodyparts === 'function' ? miner.getActiveBodyparts(typeof WORK === 'undefined' ? 'work' : WORK)
            : (typeof utils.bodyPartCount === 'function' ? utils.bodyPartCount(miner.body, 'work') : 0);
    }
    return Math.min(sourceRate(sourceMemory), work * power);
}

/** 取不满时要不要带着现有的货先走：装到 departMinShare 以上，且进账 × 一趟往返 ≤ 载货——
 *  等 w tick 多拿 i·w，吞吐 (L + i·w)/(T + w) > L/T ⇔ i·T > L；反之现在走更划算（hauler 比这条线一趟的产出还大：
 *  预定掉线源掉回 1500 档、缩身矿工、换代出来的大身体）。只在容器还在时用：容器丢了是维护 hauler 在救掉落、建容器，装满再走 */
function leaveEarly(creep, sourceMemory, load, capacity) {
    if (!(load > 0) || load < capacity * setting('departMinShare', 0.25)) return false;
    return sourceInflow(creep, sourceMemory) * tripTicks(creep, sourceMemory) <= load;
}

// ---- 寿命的最后一趟 ----

function ttlMargin() {
    return setting('ttlMargin', 20);
}

/** 实测腿长：back = 离开外矿容器 → 进卸货房，out = 卸空 → 贴到矿位。挂在外矿记录的源上（source.legs），按卸货房分开（卸货房换了就重来），
 *  EMA 0.3；离谱的样本（外矿停用在家挂过、被 CPU 跳过）超过 4 × 路程 + 100 就丢掉 */
function recordLeg(creep, kind, dropRoom) {
    const started = Number(creep.memory.legAt);
    delete creep.memory.leg;
    delete creep.memory.legAt;
    delete creep.memory.legRoom;
    if (!(started > 0) || !dropRoom) return;
    const ticks = Game.time - started;
    const sourceMemory = remote.getSource(creep.memory.home, creep.memory.remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory || !(ticks > 0) || ticks > 4 * routeDistance(creep, sourceMemory) + 100) return;
    if (!sourceMemory.legs || sourceMemory.legs.room !== dropRoom) sourceMemory.legs = { room: dropRoom };
    const legs = sourceMemory.legs;
    legs[kind] = legs[kind] > 0 ? Math.round((legs[kind] * 0.7 + ticks * 0.3) * 10) / 10 : ticks;
    legs[kind + 'N'] = (Number(legs[kind + 'N']) || 0) + 1;
}

function legOf(sourceMemory, kind, dropRoom) {
    const legs = sourceMemory && sourceMemory.legs;
    return legs && legs.room === dropRoom && legs[kind] > 0 ? Number(legs[kind]) : null;
}

/** 满载回程（tick）：本线实测腿长，没有就按 路程 × 满载每格 tick */
function backTicks(creep, sourceMemory, dropRoom) {
    const room = dropRoom || creep.memory.dropRoom || remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    return legOf(sourceMemory, 'back', room) || routeDistance(creep, sourceMemory) * ladenPerTile(creep, sourceMemory);
}

/** 空载去程（tick）：实测腿长，没有就按路程（空载 1 tick/格） */
function outTicks(creep, sourceMemory, dropRoom) {
    return legOf(sourceMemory, 'out', dropRoom) || routeDistance(creep, sourceMemory);
}

/** 替补已在计划里：同槽位已有接班（不在退役），或寿命已进孵化提前量（身体 × 3 + 路程 + 20，与 remote.getDemands 同式）——
 *  spawn.countPlannedDemand 不再算它，这个槽位已经在补 */
function replacementPlanned(creep, sourceMemory) {
    const slot = creep.memory.slotKey;
    if (!slot) return false;
    const retiring = typeof utils.isRetiring === 'function' ? utils.isRetiring : () => false;
    const list = typeof utils.creepsHomeRole === 'function' ? utils.creepsHomeRole(creep.memory.home, 'remoteHauler') : [];
    if (list.some((other) => other && other !== creep && other.memory && other.memory.slotKey === slot && !retiring(other.memory))) return true;
    const lead = (creep.body || []).length * 3 + routeDistance(creep, sourceMemory) + 20;
    return creep.ticksToLive != null && creep.ticksToLive <= lead;
}

/** 外矿容器放得下这段空档的进账：(cycle − ttl) × 在采的进账。容器看不见（外矿房没有自己的 creep）就没有矿工在采、不会溢出 */
function containerAbsorbs(creep, sourceMemory, gap) {
    const container = sourceMemory && sourceMemory.containerId && typeof Game.getObjectById === 'function' ?
        Game.getObjectById(sourceMemory.containerId) : null;
    if (!container || !container.store) return true;
    const free = freeOf(container);
    return !Number.isFinite(free) || free >= gap * sourceInflow(creep, sourceMemory);
}

/** 卸空后寿命够不够再跑一趟：cycle = 去程 + 回程 + ttlMargin（出口格、沼泽、让路）。不够就退役回收（spawn.recycleCreep 退剩余寿命比例的造价，
 *  老死只退 0；带货老死在路上的 tombstone 没人捡）——但只在替补已在计划里、或外矿容器放得下这段空档时；否则最后一趟照跑
 *  （到了矿位按"寿命只够回程"带着现有的货走），别让单 hauler 的线容器溢出。返回是否已退役 */
function ttlRetire(creep, plan, dropRoom) {
    if (creep.ticksToLive == null) return false;
    const sourceMemory = remote.getSource(creep.memory.home, creep.memory.remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory) return false;
    const cycle = Math.round(outTicks(creep, sourceMemory, dropRoom) + backTicks(creep, sourceMemory, dropRoom) + ttlMargin());
    if (creep.ticksToLive >= cycle) return false;
    const detail = { ttl: creep.ticksToLive, cycle, slot: creep.memory.slotKey || null };
    if (!replacementPlanned(creep, sourceMemory) && !containerAbsorbs(creep, sourceMemory, cycle - creep.ticksToLive)) {
        noteTtl(creep, 'keep', detail);
        return false;
    }
    noteTtl(creep, 'retire', detail);
    retireEmpty(creep, plan);
    return true;
}

/** 外矿停用比寿命还长（剩余停用 + 一段路程 ≥ 寿命，重开也跑不完一趟），或超过 suspendRetireAfter tick：回收退役（同 reserver.js）。
 *  有视野时敌情冷却每 tick 重置为 150（defender 在打），不会触发；打不过要等入侵者到期、别人预定（ticksToEnd + 100）这类长停用才会 */
function suspendedTooLong(creep) {
    const home = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!remote.isSuspended(home, remoteRoom) || typeof remote.suspensionLeft !== 'function') return false;
    const left = remote.suspensionLeft(home, remoteRoom);
    if (left > setting('suspendRetireAfter', 300)) return true;
    if (creep.ticksToLive == null) return false;
    const sourceMemory = remote.getSource(home, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    return left + routeDistance(creep, sourceMemory) >= creep.ticksToLive;
}

// ---- 外矿取货 ----

/** 矿位 3 格内的能量掉落（矿工溢出、容器倒出来的存货） */
function droppedNear(creep, sourceMemory) {
    return creep.room.find(FIND_DROPPED_RESOURCES, {
        filter: (resource) => resource.resourceType === RESOURCE_ENERGY && resource.amount > 0 &&
            (!sourceMemory || !sourceMemory.spot || Math.max(Math.abs(resource.pos.x - sourceMemory.spot.x),
                Math.abs(resource.pos.y - sourceMemory.spot.y)) <= 3),
    });
}

/** 站在矿位（矿工的容器格）上：挪到相邻的空格（优先仍贴着矿位的格，取货不断）；周围没空格就原地，下一 tick 再试。
 *  线上 W32S1：hauler 停在容器格上等货，矿工进不去（交通解算把 remoteHauler 当成在干活、不推开它），容器零进账，4 只 hauler 187 tick 零交付 */
function stepOffSpot(creep, plan, spot) {
    const room = creep.room;
    const terrain = room && typeof room.getTerrain === 'function' ? room.getTerrain() : null;
    const look = (kind, x, y) => (room && typeof room.lookForAt === 'function' && kind != null ? room.lookForAt(kind, x, y) || [] : []);
    const structuresKind = typeof LOOK_STRUCTURES === 'undefined' ? null : LOOK_STRUCTURES;
    const creepsKind = typeof LOOK_CREEPS === 'undefined' ? null : LOOK_CREEPS;
    // 源 / 矿 / 控制器是不可走的地物，但不在 LOOK_STRUCTURES 里（矿位就贴着源，源那一格必须排除）
    const blockers = [];
    for (const kind of [typeof FIND_SOURCES === 'undefined' ? null : FIND_SOURCES, typeof FIND_MINERALS === 'undefined' ? null : FIND_MINERALS]) {
        if (kind != null && room && typeof room.find === 'function') for (const item of room.find(kind) || []) if (item && item.pos) blockers.push(item.pos);
    }
    if (room && room.controller && room.controller.pos) blockers.push(room.controller.pos);
    let best = null;
    let bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = creep.pos.x + dx;
        const y = creep.pos.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48 || (x === spot.x && y === spot.y)) continue;
        if (terrain && terrain.get(x, y) === WALL_MASK) continue;
        if (blockers.some((pos) => pos.x === x && pos.y === y)) continue;
        if (look(structuresKind, x, y).some((s) => s.structureType !== ROAD && s.structureType !== CONTAINER &&
            !(s.structureType === RAMPART && s.my !== false))) continue;
        if (look(creepsKind, x, y).some((other) => other && other !== creep)) continue;
        const score = Math.max(Math.abs(x - spot.x), Math.abs(y - spot.y)) <= 1 ? 0 : 1;
        if (score < bestScore) { bestScore = score; best = { x, y }; }
    }
    if (!best) return false;
    creep.memory.spotYield = Game.time;
    noteHaul(creep, 'stepOff');
    go(creep, plan, new RoomPosition(best.x, best.y, room.name), { range: 0, reusePath: 5 });
    return true;
}

/** 装满了（或按规则提前走）：转投递，同 tick 朝卸货房起步 */
function depart(creep, plan, load) {
    creep.memory.state = 'deliver';
    if (!creep.memory.dropRoom) creep.memory.dropRoom = remote.dropRoom(creep.memory.home, creep.memory.remoteRoom);
    plan.stopEnd = true;
    creep.memory.leg = 'back';
    creep.memory.legAt = Game.time;
    if (creep.memory.spotYield) {
        // 遥测（私服 remoteHauler.spotYield）：让过矿位的 hauler 之后装上货出发——矿工进了矿位、容器有了进账
        noteHaul(creep, 'yieldDepart');
        const mem = homeMem(creep);
        if (mem && mem.remoteHaul) mem.remoteHaul.yieldLoad = Math.max(Number(mem.remoteHaul.yieldLoad) || 0, load || 0);
        delete creep.memory.spotYield;
    }
    go(creep, plan, new RoomPosition(25, 25, creep.memory.dropRoom), { range: 20, reusePath: 35 });
}

function collect(creep, plan) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (creep.room.name !== remoteRoom) {
        if (remote.noteTravel(creep)) return;
        go(creep, plan, new RoomPosition(25, 25, remoteRoom), { range: 20, reusePath: 40 });
        return;
    }

    const home = Game.rooms[homeName];
    if (home) remote.observe(home, creep.room);
    if (remote.isSuspended(homeName, remoteRoom)) {
        creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? 'deliver' : 'retreat';
        if (creep.memory.state === 'deliver') deliver(creep, plan);
        else idleHome(creep);
        return;
    }
    const sourceMemory = remote.getSource(homeName, remoteRoom, creep.memory.sourceId, creep.memory.srcIdx);
    if (!sourceMemory || !sourceMemory.spot) return;
    if (!creep.memory.sourceId && sourceMemory.id) creep.memory.sourceId = sourceMemory.id;
    const spot = sourceMemory.spot;
    const container = creep.room.lookForAt(LOOK_STRUCTURES, spot.x, spot.y)
        .find((structure) => structure.structureType === STRUCTURE_CONTAINER);
    const energy = energyOf(creep);
    const free = Math.max(0, Number(creep.store.getFreeCapacity(RESOURCE_ENERGY)) || 0);
    const capacity = energy + free;
    const onSpot = creep.pos.x === spot.x && creep.pos.y === spot.y;
    if (creep.memory.leg === 'out' && Math.max(Math.abs(creep.pos.x - spot.x), Math.abs(creep.pos.y - spot.y)) <= 1) {
        recordLeg(creep, 'out', creep.memory.legRoom);   // 实测去程：卸空 → 贴到矿位
    }
    const ttl = creep.ticksToLive;
    const back = ttl == null ? 0 : backTicks(creep, sourceMemory);
    // 寿命连回程都不够（任何己方房都到不了）还揣着货：倒进容器（或落在矿位旁，下一只 hauler 3 格内捡得到）——老死在路上的 tombstone 没人捡
    if (ttl != null && energy > 0 && ttl < back) {
        const sent = container && isNear(creep, container) ? Math.min(energy, freeOf(container)) : 0;
        if (sent > 0 ? creep.transfer(container, RESOURCE_ENERGY, sent) === RC_OK : creep.drop(RESOURCE_ENERGY) === RC_OK) {
            noteTtl(creep, 'dump', { ttl, back: Math.round(back), energy });
            creep.memory.retired = true;   // 下一 tick 空手回收
        }
        return;
    }

    // tick 开始时的量，减去同 tick 先跑的 creep 已经取走的：相邻最大的一堆掉落 + 相邻的容器
    const drops = droppedNear(creep, sourceMemory);
    let pile = null;
    for (const item of drops) if (isNear(creep, item) && (!pile || item.amount > pile.amount)) pile = item;
    const pileAvail = pile ? Math.max(0, Number(pile.amount) - takenThisTick(pile.id)) : 0;
    const containerNear = !!container && isNear(creep, container);
    const containerAvail = containerNear ? Math.max(0, energyOf(container) - takenThisTick(container.id)) : 0;
    let gained = 0;
    if (free > 0 && (pileAvail > 0 || containerAvail > 0)) {
        // 掉落（每 tick 衰减）全拿，容器补差：引擎先结算 withdraw、再结算 pickup，withdraw 必须显式只取掉落装不下的部分
        const pileTake = Math.min(free, pileAvail);
        const withdrawAmount = Math.min(containerAvail, free - pileTake);
        if (withdrawAmount > 0 && creep.withdraw(container, RESOURCE_ENERGY, withdrawAmount) === RC_OK) {
            gained += withdrawAmount;
            recordTaken(container.id, withdrawAmount);
            plan.acted = true;
        }
        if (pileTake > 0) {
            const before = energy + gained;
            if (creep.pickup(pile) === RC_OK) {
                gained += pileTake;
                recordTaken(pile.id, pileTake);
                plan.acted = true;
                creep.memory.remotePickupPending = { at: Game.time, before };   // 下一 tick 结算的只是掉落那部分
            }
        }
    }
    const load = energy + gained;
    if (capacity > 0 && load >= capacity) { depart(creep, plan, load); return; }
    // 寿命只够回程（+ ttlDepartMargin）：有货带着现有的走；空手回收（再等下去只会死在路上）
    if (ttl != null && ttl <= back + setting('ttlDepartMargin', 10)) {
        if (load > 0) {
            noteTtl(creep, 'depart', { ttl, back: Math.round(back), load });
            depart(creep, plan, load);
        } else {
            noteTtl(creep, 'retire', { ttl, back: Math.round(back), load: 0 });
            retireEmpty(creep, plan);
        }
        return;
    }
    if (container && leaveEarly(creep, sourceMemory, load, capacity)) {
        noteHaul(creep, 'partialDepart');
        depart(creep, plan, load);
        return;
    }
    if (container && !containerNear) {
        go(creep, plan, container, { range: 1, reusePath: 30 });   // 顺手捡了相邻的掉落也照走
        return;
    }
    if (gained > 0) {
        if (onSpot) stepOffSpot(creep, plan, spot);   // 取到了、没满：接着装，但别占着矿位（取货 + 让开同 tick）
        return;
    }
    // 容器空了 / 丢了：3 格内还有不相邻的掉落就去捡
    const far = closestOf(creep, drops.filter((item) => !isNear(creep, item)));
    if (far) {
        go(creep, plan, far, { range: 1, reusePath: 15 });
        return;
    }
    const worked = nearbyInfrastructureWork(creep);
    if (onSpot) { stepOffSpot(creep, plan, spot); return; }   // 修/建与移动不冲突：先让出矿位
    if (worked) return;
    note(creep, 'wait');
    // 等货点：贴着矿位（容器在就是贴着容器），但不站在矿位上
    const wait = new RoomPosition(spot.x, spot.y, remoteRoom);
    if (!creep.pos.inRangeTo(wait, 1)) go(creep, plan, wait, { range: 1, reusePath: 25 });
}

function run(creep) {
    const homeName = creep.memory.home;
    const remoteRoom = creep.memory.remoteRoom;
    if (!homeName || !remoteRoom) return;
    if (require('pvp').fleeHighThreat(creep)) return;   // 10-16：Jumpp/武装玩家 → 撤回母房
    settleRoadBudget(creep);
    // 走线汇总排在退役检查之前：卸空那一 tick 标的退役，这一趟的走线仍要结算
    if (creep.room && creep.room.name !== remoteRoom) flushRoadTrail(creep);
    const pending = creep.memory.remotePickupPending;
    if (pending && pending.at < Game.time) {
        const gained = creep.store[RESOURCE_ENERGY] - pending.before;
        const mem = Memory.rooms && Memory.rooms[homeName];
        if (mem && pending.at === Game.time - 1 && gained > 0) {
            const record = mem.remoteEnergySalvaged || (mem.remoteEnergySalvaged = { amount: 0, n: 0 });
            record.amount += gained;
            record.n++;
            record.at = Game.time;
        }
        delete creep.memory.remotePickupPending;
    }
    // 退役中（寿命不够下一趟 / 外矿停用太久 / 寿命将尽倒过货）：每 tick 走向最近的 spawn 回收（retire.js 途中复核，不够走就原地 suicide）。
    // 排在上面两笔结算之后：卸空那一 tick 标的退役，下一 tick 仍要把修路预算与救回掉落的账结掉
    if (creep.memory.retired) {
        note(creep, 'retire');
        retireNow(creep);
        return;
    }
    if (!creep.memory.state) creep.memory.state = creep.store[RESOURCE_ENERGY] > 0 ? 'deliver' : 'collect';
    // SK 外矿（config.sk）：keeper 复活/还活着时先退到射程外，等 reaper 清掉再回容器（只在外矿房里判，别的房 keeperThreatFor 直接返回 null）
    if (remote.keeperRetreat(creep)) { note(creep, 'keeperRetreat'); return; }
    const suspended = remote.isSuspended(homeName, remoteRoom);
    // 外矿一停用（敌情 150 tick、不可达退避）这趟去程的计时就作废：在家挂机的 tick 会被记成"腿长"，
    // 离群过滤（4 × 路程 + 100）在正常路程下拦不住它，寿命规划的往返周期跟着虚高，还能跑两趟的 hauler 被判退役
    if (suspended && creep.memory.leg) { delete creep.memory.leg; delete creep.memory.legAt; delete creep.memory.legRoom; }
    const here = creep.room;
    if (suspended && creep.store[RESOURCE_ENERGY] <= 0) creep.memory.state = 'retreat';
    else if (suspended || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.state = 'deliver';
    else if (creep.memory.state === 'deliver' && creep.store[RESOURCE_ENERGY] <= 0) {
        const dropName = creep.memory.dropRoom;
        creep.memory.state = 'collect';
        delete creep.memory.dropRoom;
        if (creep.memory.stopAt != null && here && here.name === dropName) recordStop(creep, dropName);
        else { delete creep.memory.stopAt; delete creep.memory.stopDist; }
        // 卸空的另一个入口（上一 tick 的投递没走 afterEmpty）：在卸货房里同样做寿命检查
        if (here && here.name !== remoteRoom && here.controller && here.controller.my && ttlRetire(creep, null, dropName || here.name)) return;
    }
    else if (creep.memory.state === 'collect' && creep.store[RESOURCE_ENERGY] > 0 && here && here.name !== remoteRoom) {
        // 上一 tick 的最后一次投递落空（引擎把量夹成 0）：不在外矿房、却揣着货——接着投，不把货带回外矿
        creep.memory.state = 'deliver';
    }
    else if (creep.memory.state === 'retreat') creep.memory.state = 'collect';

    const plan = newPlan();
    try {
        if (creep.memory.state === 'deliver') {
            // 回程每趟最多花 50 能量修路（预算按下一 tick 实际耗能结算，只有真实卸货才重置，不能靠 collect/deliver 切换刷新）。
            // 路工地边修边走：以前修路那几 tick 站着不动（每趟最多 10 tick，09563b0 时工地稀疏、走过去修不到几下；现在一次放 6 个、
            // 沿路连续，走过去照样花满预算）；容器工地仍站着建（容器丢了的恢复，不限预算）
            if (!suspended && creep.room.name === remoteRoom) {
                traceRoadTile(creep);
                const work = nearbyInfrastructureWork(creep);
                if (work === 'container') return;
                if (work === 'road') plan.built = true;
            }
            deliver(creep, plan);
        }
        else if (creep.memory.state === 'retreat') idleHome(creep);
        else collect(creep, plan);
    } finally {
        if (plan.built && plan.moved) noteHaul(creep, 'buildMove');   // 遥测：修路同 tick 照走（旧代码修路时站着）
        // 遥测：结束一次停靠的动作 tick（取满出发、每次投递）与其中同 tick 起步的——旧代码这类 tick 从不起步
        if (plan.stopEnd) {
            const mem = homeMem(creep);
            if (mem) {
                const act = mem.remoteHaulAct || (mem.remoteHaulAct = { ac: 0, acm: 0 });
                act.ac++;
                if (plan.moved) act.acm++;
                act.at = Game.time;
            }
        }
    }
}

module.exports = { run, homeTarget, driveByTarget, openFor, rangeTo };
