'use strict';
/** 搬运工：源容器 → spawn/ext → 塔 → upgrader 容器 → storage 的能量调度。
 *
 *  每 tick 先规划、再执行：引擎允许同一 tick 各做一次 transfer / withdraw / pickup 外加一次移动（互不冲突，射程按 tick 开始时的位置算，
 *  移动在所有动作之后结算），而 store 要到下一 tick 才变。所以：
 *    - 投递 / 取货成功的那一 tick 就按"动作后的预计载货"挑下一站并起步，不停一拍（以前每次停靠 1.42 tick，线下模拟补满 extension 慢 17–21%）；
 *    - 路过的掉落顺手 pickup、载货路过没满的 spawn/ext 顺手 transfer，都不占这一 tick；
 *    - 取货按"到达时能拿到多少"判断值不值得跑（容量越大、路越远要求越高），不够就在进账的源容器旁边等满，而不是揣着 100 能量来回跑。
 *  目标竞价、按量预留与同 tick 扣减在 task_broker（availableFor / consume / setProjected）。 */
const layout = require('layout');
const config = require('config');
const movement = require('movement');
const taskBroker = require('task_broker');
const links = require('links');
const haulStats = require('haul_stats');
const { findCached, logErr, storageRichState, towerUrgent, spawnWaitingFor } = require('utils');

function energyIn(store) {
    return store ? Number(store[RESOURCE_ENERGY] || 0) : 0;
}

function freeIn(target) {
    const store = target && target.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return 0;
    return Math.max(0, Number(store.getFreeCapacity(RESOURCE_ENERGY)) || 0);
}

function amountAt(target) {
    if (!target) return 0;
    return target.amount != null ? Number(target.amount) || 0 : energyIn(target.store);
}

function posOf(target) {
    return target && target.pos ? target.pos : target;
}

function distance(creep, target) {
    const pos = posOf(target);
    if (!pos || !creep.pos || (pos.roomName && pos.roomName !== creep.pos.roomName)) return 50;
    return Math.max(Math.abs(creep.pos.x - pos.x), Math.abs(creep.pos.y - pos.y));
}

function near(creep, target) {
    return distance(creep, target) <= 1;
}

function hauling() {
    return config.hauling || {};
}

function ctrlContainer(room) {
    if (taskBroker.controllerFeedMode(room) === 'link') return null;
    const plan = (Memory.rooms[room.name] || {}).plan;
    if (!plan || !plan.containers || !plan.containers.ctrl) return null;
    if (layout.controllerFedByStorage(room, plan)) return null;   // 升级者由 storage 供能：容器不再喂
    return layout.structureAt(room, plan.containers.ctrl.x, plan.containers.ctrl.y, STRUCTURE_CONTAINER);
}

const consumerReserveBudget = { tick: -1, rooms: {} };
const roomContexts = { tick: -1, rooms: {} };

/** 每房每 tick 一份：hub 模式、消费者需求、是否急需能量（所有 hauler 共用，不必每只重建一遍 roomTasks） */
function contextFor(room) {
    if (roomContexts.tick !== Game.time) { roomContexts.tick = Game.time; roomContexts.rooms = {}; }
    let ctx = roomContexts.rooms[room.name];
    if (ctx) return ctx;
    const plan = (Memory.rooms[room.name] || {}).plan;
    ctx = { plan, hubFed: links.hubHaulMode(room, plan), demand: null, urgent: null };
    roomContexts.rooms[room.name] = ctx;
    return ctx;
}

/** 非 storage、非源容器、hauler 能送的投递缺口（消费者需求） */
function consumerTasks(room) {
    return taskBroker.pooledTasks(room).filter((task) => task.kind === 'deliver' && task.target &&
        task.target.store && task.target.structureType !== STRUCTURE_STORAGE &&
        !(task.target.structureType === STRUCTURE_CONTAINER && srcIsPlanned(room, task.target)) &&
        (!task.roles || task.roles.includes('hauler')) && task.backlog > 0);
}

/** 消费者还没人认领的缺口：扣掉已经揣着能量在路上的 hauler 承诺的量（以前按 backlog 算，同一个缺口会被重复从 storage 取，
 *  多出来的又被 storage 货锁揣着），再扣掉揣着 storage 货在等缺口的 hauler 手上的货。
 *  本 tick 缓存；有 hauler 租下消费者投递时作废（pickDeliver），后跑的 hauler 看得到这份认领 */
function consumerDemand(room, ctx) {
    if (ctx.demand == null) {
        const open = consumerTasks(room).reduce((sum, task) => sum + Math.max(0, taskBroker.availableFor(task, null)), 0);
        ctx.demand = Math.max(0, open - idleStorageCargo(room, ctx));
    }
    return ctx.demand;
}

/** 揣着 storage 货、手上没有租约的 hauler（消费者刚被别人认领完，在 storage 边等下一个缺口）的货量：下一个缺口它就送去，
 *  不该再从 storage 另取一份（有租约的已经在认领里扣过） */
function idleStorageCargo(room, ctx) {
    if (ctx.idleCargo != null) return ctx.idleCargo;
    let sum = 0;
    for (const other of findCached(room, FIND_MY_CREEPS) || []) {
        const memory = other && other.memory;
        if (!memory || memory.role !== 'hauler' || memory.home !== room.name || !memory.hubCargo) continue;
        if (memory.brokerTask && memory.brokerTask.until >= Game.time) continue;
        sum += energyIn(other.store);
    }
    ctx.idleCargo = sum;
    return sum;
}

/** 房间急需能量：spawn 在等买不起的 creep、spawn/ext 见底、塔紧急 / 危急维修 / 控制器见底（broker 里权重 ≥ 11 的投递）。
 *  急的时候取货门槛降到 50——宁可小车快送，也不让 spawn 干等一只 hauler 攒满 */
function isUrgent(room, ctx) {
    if (ctx.urgent != null) return ctx.urgent;
    const share = Number(hauling().urgentSpawnShare);
    let urgent = spawnWaitingFor(room) ||
        room.energyAvailable < room.energyCapacityAvailable * (Number.isFinite(share) ? share : 0.3);
    if (!urgent) urgent = taskBroker.pooledTasks(room).some((task) => task.kind === 'deliver' && task.tier === 1 && task.weight >= 11 && task.backlog > 0);
    ctx.urgent = urgent;
    return urgent;
}

/** 从 storage 取出的货不再回 storage（以前只有 hub 模式有这条保护：线上 W33S3 从 storage 取 850、750 又放回 storage）。
 *  兜底：揣着 storage 的货超过 storageCargoRelease tick 还送不出去（消费者消失），允许放回，别一直揣着 */
function storageCargoLocked(creep) {
    if (!creep.memory.hubCargo) return false;
    const since = Number(creep.memory.hubCargoAt);
    const release = Number(hauling().storageCargoRelease) || 100;
    return !(since > 0 && Game.time - since > release);
}

function markStorageCargo(creep) {
    creep.memory.hubCargo = true;
    creep.memory.hubCargoAt = Game.time;
}

/** 揣着的 storage 货只剩零头（< max(50, topUpShare × 容量)）又没有消费者可送：解锁。零头放回 storage / 顺路补满都不算来回倒，
 *  锁着它 hauler 就在 storage 边上干等到 storageCargoRelease（审查 EC1：5 能量的零头停了 50 tick） */
function releaseStorageResidual(creep, load, capacity) {
    if (!storageCargoLocked(creep)) return false;
    if (load >= Math.max(50, capacity * (Number(hauling().topUpShare) || 0.25))) return false;
    delete creep.memory.hubCargo;
    delete creep.memory.hubCargoAt;
    noteCounter(creep.room || Game.rooms[creep.memory.home], 'haulCargoRelease');
    return true;
}

/** 累计计数型遥测（私服生效断言用）：Memory.rooms[房][key] = {n, at} */
function noteCounter(room, key) {
    if (!room || !room.name) return;
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem[key] || (mem[key] = { n: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.at = Game.time;
}

// ---- 投递目标 ----

/** 投递竞价的轮次：第 1 层先问 spawn/ext 与压过它们的（紧急塔 11、控制器见底 20），再问第 1 层的其余（storage 富余时的
 *  控制器容器 / ctrl link 9）——否则 9 × 1600 的容器缺口按收益压过 10 × 100 的 extension，spawn 有缺口时满载送去控制器 */
const DELIVER_PASSES = [
    (task) => task.tier === 1 && task.weight >= 10,
    (task) => task.tier === 1,
    (task) => task.tier === 2,
    (task) => task.tier === 3,
    (task) => task.tier === 4,
];

function deliverFilter(creep, room, exclude) {
    const locked = storageCargoLocked(creep);
    return (candidate) => candidate.kind === 'deliver' && candidate.target && candidate.target.store &&
        !(exclude && exclude.has(candidate.target.id)) &&
        !(locked && candidate.target.structureType === STRUCTURE_STORAGE) &&
        !(candidate.target.structureType === STRUCTURE_CONTAINER && srcIsPlanned(room, candidate.target));
}

/** 目标在池子里有投递任务时，别人承诺的量还没把它填满（按目标 id 建一次本 tick 的索引，不必每个候选扫整个池子） */
function openTarget(creep, room, target) {
    const ctx = contextFor(room);
    if (!ctx.deliverIndex) {
        ctx.deliverIndex = {};
        for (const task of taskBroker.pooledTasks(room)) {
            if (task.kind !== 'deliver' || !task.target || !task.target.id) continue;
            (ctx.deliverIndex[task.target.id] || (ctx.deliverIndex[task.target.id] = [])).push(task);
        }
    }
    const tasks = ctx.deliverIndex[target.id];
    if (!tasks || !tasks.length) return true;
    return tasks.some((task) => taskBroker.availableFor(task, creep) > 0);
}

/** 返回 { target, task }：逐轮竞价；竞价抛错时走旧的兜底链，平时只为"被卡住检测屏蔽的塔 / spawn / ext"兜底（不抢别人已预留的） */
function pickDeliver(creep, room, exclude) {
    const base = deliverFilter(creep, room, exclude);
    let threw = false;
    try {
        for (const pass of DELIVER_PASSES) {
            const task = taskBroker.pickTask(creep, room, (candidate) => pass(candidate) && base(candidate), true);
            if (!task || !task.target) continue;
            if (task.target.structureType !== STRUCTURE_STORAGE) {
                // 刚租下一个消费者缺口：本 tick 缓存的"没人认领的需求"作废，后跑的 hauler 不再为它从 storage 取
                const ctx = contextFor(room);
                ctx.demand = null;
                ctx.idleCargo = null;
            }
            return { target: task.target, task };
        }
    } catch (error) { threw = true; logErr('hauler.auctionTarget ' + creep.name, error); }
    const target = fallbackDeliver(creep, room, exclude, threw);
    return target ? { target, task: null } : null;
}

function fallbackDeliver(creep, room, exclude, threw) {
    const open = (structure) => !(exclude && exclude.has(structure.id)) && (threw || openTarget(creep, room, structure));
    const linkFeed = taskBroker.controllerFeedLink(room);
    if (threw && linkFeed && linkFeed.starved && open(linkFeed.target)) return linkFeed.target;
    // 塔的大缺口（有敌人或储备被动用，utils.towerUrgent 锁存到补到不缺）先于 spawn/ext：spawn 持续孵化时 spawn/ext 永远有缺口，
    // 塔会几百 tick 没人补（与 broker 分层一致）
    const towerRefillAt = Number(config.towerRefillAt) || 300;
    const towerFilter = (s) => s.structureType === STRUCTURE_TOWER && freeIn(s) >= towerRefillAt && open(s);
    const hostile = room.find(FIND_HOSTILE_CREEPS).length > 0;
    let target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: (s) => towerFilter(s) && towerUrgent(room, s, hostile) });
    if (target) return target;
    // spawn / extension 保证孵化
    target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && freeIn(s) > 0 && open(s),
    });
    if (target || !threw) return target || null;
    // 以下只在竞价不可用时：upgrader 供能容器（或 storage 供能时低于地板线的 storage）→ 和平期塔 → storage
    if (linkFeed && open(linkFeed.target)) return linkFeed.target;
    const uc = ctrlContainer(room);
    if (uc && freeIn(uc) > 0 && energyIn(uc.store) < uc.store.getCapacity(RESOURCE_ENERGY) * config.upgraderFillBelow && open(uc)) return uc;
    if (!uc) {
        const feed = taskBroker.controllerFeedStorage(room);
        if (feed && !storageCargoLocked(creep) && open(feed.target)) return feed.target;
    }
    target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: towerFilter });
    if (target) return target;
    const st = room.storage;
    if (st && st.my && !storageCargoLocked(creep) && freeIn(st) > 0 && !(exclude && exclude.has(st.id))) return st;
    return null;
}

/** 载货路过的 spawn/ext（相邻、有空位、没被别人预留）：本 tick 顺手 transfer，不停步。主目标是紧急任务（塔 / 控制器见底）时不分货 */
function driveByTarget(creep, room, main, mainTask, exclude) {
    if (mainTask && mainTask.weight >= 11) return null;
    const found = creep.pos.findInRange(FIND_MY_STRUCTURES, 1, {
        filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && freeIn(s) > 0,
    }) || [];
    for (const structure of found) {
        if (!structure || structure.id === (main && main.id) || distance(creep, structure) > 1) continue;
        if (exclude && exclude.has(structure.id)) continue;
        if (openTarget(creep, room, structure)) return structure;
    }
    return null;
}

// ---- 取货目标 ----

/** 值得专程跑一趟的最少取货量：急的时候 50；否则随路程涨（每格 pickupPerTile），封顶空位的 pickupShare，至少 pickupMin。
 *  以前是固定 100：1500 容量的 hauler 跑 25 格去拿 150（到达时约 400），一趟只运 25%（基准容器房在途装载率 0.34–0.6） */
function pickupBar(creep, target, free, urgent) {
    if (urgent) return Math.min(free, 50);
    const settings = hauling();
    const minimum = Number(settings.pickupMin) || 100;
    const share = Number(settings.pickupShare) || 0.5;
    const perTile = Number(settings.pickupPerTile) || 25;
    const travel = Math.max(0, distance(creep, target) - 1);
    return Math.min(free, Math.max(minimum, Math.min(free * share, minimum + perTile * travel)));
}

/** hub 模式只为真实消费者从 storage 取（不做 storage → storage） */
function hubNeedsEnergy(room, ctx) {
    return !ctx.hubFed || consumerTasks(room).length > 0;
}

function collectFilter(creep, room, ctx, free, exclude, allowStorage, loaded) {
    const urgent = isUrgent(room, ctx);
    const hubNeeds = hubNeedsEnergy(room, ctx);
    const plan = ctx.plan;
    return (candidate) => {
        if (candidate.kind !== 'collect' || !candidate.target) return false;
        const target = candidate.target;
        if (exclude && exclude.has(target.id)) return false;
        const available = taskBroker.availableFor(candidate, creep);
        if (candidate.tombstone) {
            // tombstone / ruin：近处的 50 就值得顺手拿（几十 tick 后散成掉落物），远处按普通门槛
            const bar = distance(creep, target) <= 5 ? Math.min(free, 50) : pickupBar(creep, target, free, urgent);
            return available >= bar;
        }
        if (available < pickupBar(creep, target, free, urgent)) return false;
        if (target.amount != null) return target.resourceType === RESOURCE_ENERGY;   // 掉落（只收能量：矿物捡了卸不掉）
        // storage 只在 broker 标了 rich（storage 富余且控制器容器/link 不满）或 hub 模式时才是取货来源，否则搬出来又搬回去；
        // 容器供能房里只是兜底（权重 6）：先竞价源容器/掉落/tombstone，都没得取再取 storage——storage 压过源容器会把 hauler 抽走、
        // 矿工溢出到地上衰减（2026-09-06 A/B 总 CP −5%）；link 供能房 storage 权重 8，第一轮就放行（有源在溢出时 broker 降回 6）
        // 身上已有货（补满 / 送完零头）的不去 storage 补：storage 取货只为没人认领的消费者缺口，这只 hauler 没挑到投递才来补，
        // 补上的货还会把整车锁成 storage 货；在源容器补满的会被 storage 拉走、揣着源头的货来回跑（审查 perf-2）
        if (target.structureType === STRUCTURE_STORAGE) {
            if (loaded) { noteCounter(room, 'haulLoadedStorageSkip'); return false; }
            return hubNeeds && (candidate.rich || candidate.hub) && (allowStorage || candidate.weight >= 8 || candidate.hub) &&
                storageWithdrawBudget(creep, room, ctx, free) >= Math.min(50, free);
        }
        // terminal：只有 broker 标了 terminalDrain（storage 不富余时取终端网络送来的能量）才是取货来源
        if (target.structureType === STRUCTURE_TERMINAL) return !!candidate.terminalDrain;
        return target.structureType === STRUCTURE_CONTAINER && srcIsPlanned(room, target) &&
            !links.skipSourceContainer(room, plan, target);
    };
}

/** 返回 { target, task }；第一轮不放行 storage 兜底，第二轮放行；loaded = 身上已有货（不从 storage 补） */
function pickCollect(creep, room, ctx, free, exclude, loaded) {
    try {
        const task = taskBroker.pickTask(creep, room, collectFilter(creep, room, ctx, free, exclude, false, loaded), true) ||
            taskBroker.pickTask(creep, room, collectFilter(creep, room, ctx, free, exclude, true, loaded), true);
        return task && task.target ? { target: task.target, task } : null;
    } catch (error) {
        logErr('hauler.auctionSource ' + creep.name, error);
        const target = fallbackCollect(creep, room, ctx);
        return target ? { target, task: null } : null;
    }
}

/** 竞价不可用时的兜底顺序与 broker 一致：hub storage → 源容器 → 掉落 → storage（富余）→ tombstone */
function fallbackCollect(creep, room, ctx) {
    const plan = ctx.plan;
    const hubNeeds = hubNeedsEnergy(room, ctx);
    const st = room.storage;
    if (ctx.hubFed && hubNeeds && st && st.my && energyIn(st.store) >= 50) return st;
    const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: (s) => s.structureType === STRUCTURE_CONTAINER && energyIn(s.store) >= 100 &&
            plan && srcIsPlanned(room, s) && !links.skipSourceContainer(room, plan, s),
    });
    if (container) return container;
    const drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 80 && !links.skipLinkedDrop(room, plan, r),
    });
    if (drop) return drop;
    if (st && st.my && hubNeeds && (ctx.hubFed || storageRichState(room, Memory.rooms[room.name], config.upgrading || {}))) return st;
    return creep.pos.findClosestByPath(FIND_TOMBSTONES, { filter: (t) => energyIn(t.store) >= 50 }) ||
        (typeof FIND_RUINS !== 'undefined' ? creep.pos.findClosestByPath(FIND_RUINS, { filter: (t) => energyIn(t.store) >= 50 }) : null);
}

/** 从 storage 取多少：只取还没人认领的消费者缺口，同 tick 各 hauler 共用一份预算——以前富余房按满载取，ctrl link 只缺 800 却两只
 *  850 容量的 hauler 各取一车，多出来的又回 storage（线上 W33S3）；hub 房同样（塔只缺 300 却取 800，揣满 100 tick 再退回 500）。
 *  非 hub 房只动升级者底线（upgrading.reserve）以上的部分；hub 房 storage 是 spawn/ext 唯一的来源，不留底线 */
function storageWithdrawBudget(creep, room, ctx, free) {
    if (!room.storage || !room.storage.my) return 0;
    if (consumerReserveBudget.tick !== Game.time) { consumerReserveBudget.tick = Game.time; consumerReserveBudget.rooms = {}; }
    const reserved = consumerReserveBudget.rooms[room.name] || 0;
    const reserve = ctx.hubFed ? 0 : Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const available = Math.max(0, energyIn(room.storage.store) - reserve - reserved);
    const unreserved = Math.max(0, consumerDemand(room, ctx) - reserved);
    return Math.min(available, unreserved, free);
}

/** 没有值得跑的取货时去哪等：有进账（矿工在采、link 不收）且还没被别人等着的源容器（取空了也算）。
 *  评分 = 存量 + 进账 × max(路程, WAIT_HORIZON) − 别人的预留：只按"到达时"算的话，站在容器旁的那个（路程 0）永远比远处的
 *  （进账 × 路程）低，hauler 在两个等候点之间来回跑；已经在某个等候点补满的就留在那里（只要它还有进账） */
const WAIT_HORIZON = 30;
function waitTarget(creep, room, ctx, exclude) {
    let best = null;
    let bestAmount = 0;
    const spots = taskBroker.waitSpots(room).filter((task) => task.target && !(exclude && exclude.has(task.target.id)) &&
        srcIsPlanned(room, task.target) && !links.skipSourceContainer(room, ctx.plan, task.target));
    const sticky = creep.memory.fill && spots.find((task) => task.target.id === creep.memory.fill);
    if (sticky && taskBroker.availableFor(sticky, creep) + sticky.inflow * WAIT_HORIZON > 0) return sticky;
    for (const task of spots) {
        const travel = Math.max(0, distance(creep, task.target) - 1);
        const score = taskBroker.availableFor(task, creep) + task.inflow * Math.max(0, WAIT_HORIZON - travel);
        if (score > bestAmount) { best = task; bestAmount = score; }
    }
    return best;
}

// ---- 执行 ----

/** 每 tick 的计划：每类动作最多一次、移动最多一次；exclude 是本 tick 已经服务过的目标；fillKept = 这一 tick 还在补满容器上 */
function newPlan() {
    return { move: null, moveRange: 1, pickup: false, withdraw: false, transfer: false, gained: 0, exclude: new Set(), fillKept: false };
}

function roundTripEstimate(creep, room) {
    const anchor = room.storage || room.find(FIND_MY_SPAWNS)[0];
    return anchor ? 2 * distance(creep, anchor) + 10 : 40;
}

/** 顺手：相邻的能量掉落（pickup）；投递模式下还顺手 withdraw 相邻 tombstone/ruin（withdraw 这一 tick 没别的用处）。都不占这一 tick */
function opportunistic(creep, room, plan, free, delivering) {
    if (free <= 0) return;
    const drops = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, { filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount > 0 }) || [];
    let drop = null;
    for (const item of drops) if (distance(creep, item) <= 1 && (!drop || item.amount > drop.amount)) drop = item;
    // 数量要在调用前取：真引擎里 store/amount 下一 tick 才变，mock 是立即变。
    // 引擎按 transfer → withdraw → pickup 的顺序结算：同 tick 再 withdraw 会先占掉空位，所以后面的 withdraw 只取 pickup 之后剩下的空位
    const dropAmount = drop ? Number(drop.amount) || 0 : 0;
    if (drop && creep.pickup(drop) === OK) {
        const got = Math.min(free, dropAmount);
        plan.pickup = true;
        plan.gained += got;
        plan.exclude.add(drop.id);
        taskBroker.consume(creep, room, drop, got, 'collect');
    }
    const left = free - plan.gained;
    if (!delivering || left < 10) return;
    const kinds = [FIND_TOMBSTONES];
    if (typeof FIND_RUINS !== 'undefined') kinds.push(FIND_RUINS);
    for (const kind of kinds) {
        const found = creep.pos.findInRange(kind, 1, { filter: (t) => t.store && energyIn(t.store) > 0 }) || [];
        const tomb = found.find((t) => distance(creep, t) <= 1);
        const have = tomb ? energyIn(tomb.store) : 0;
        if (tomb && creep.withdraw(tomb, RESOURCE_ENERGY, Math.min(left, have)) === OK) {
            const got = Math.min(left, have);
            plan.withdraw = true;
            plan.gained += got;
            plan.exclude.add(tomb.id);
            taskBroker.consume(creep, room, tomb, got, 'collect');
            return;
        }
    }
}

/** 投递成功后的下一站：还有货就下一个投递目标（排除刚服务的），空了就下一个取货点；都没有就原地等下一 tick 重新评估 */
function planAfterDelivery(creep, room, ctx, plan, left, capacity) {
    if (left > 0) {
        const next = pickDeliver(creep, room, plan.exclude);
        if (next) { if (!near(creep, next.target)) plan.move = next.target; return; }
        releaseStorageResidual(creep, left, capacity);
        if (storageCargoLocked(creep) || capacity - left < capacity * (Number(hauling().topUpShare) || 0.25)) return;
    }
    const free = capacity - left;
    const source = pickCollect(creep, room, ctx, free, plan.exclude, left > 0);
    if (source) { if (!near(creep, source.target)) plan.move = source.target; return; }
    if (left > 0) return;
    const wait = waitTarget(creep, room, ctx, plan.exclude);
    if (wait && !near(creep, wait.target)) plan.move = wait.target;
}

function deliver(creep, room, ctx, plan, energy, capacity) {
    const load = energy + plan.gained;
    const choice = pickDeliver(creep, room, plan.exclude);
    if (!choice) {
        // 没有投递目标：零头不揣着发呆，先去补满（storage 的货不行，那是给消费者的；只剩零头的 storage 货解锁后可以）
        releaseStorageResidual(creep, load, capacity);
        if (!storageCargoLocked(creep) && capacity - load >= capacity * (Number(hauling().topUpShare) || 0.25) &&
            collect(creep, room, ctx, plan, load, capacity)) return;
        haulStats.note(creep, 'full');
        park(creep, room, plan);
        return;
    }
    const target = choice.target;
    if (near(creep, target)) {
        const sent = Math.min(energy, freeIn(target));   // 调用前取（真引擎 store 下一 tick 才变，mock 是立即变）；显式数量与引擎默认值相同
        if (sent > 0 && creep.transfer(target, RESOURCE_ENERGY, sent) === OK) {
            plan.transfer = true;
            taskBroker.consume(creep, room, target, sent, 'deliver');
            plan.exclude.add(target.id);
            const left = Math.max(0, load - sent);
            taskBroker.setProjected(creep, left);
            planAfterDelivery(creep, room, ctx, plan, left, capacity);
        }
        return;
    }
    // 在路上：顺手灌路过的 spawn/ext，灌完就空的话直接转去取货
    const drive = driveByTarget(creep, room, target, choice.task, plan.exclude);
    if (drive) {
        const sent = Math.min(energy, freeIn(drive));
        if (sent > 0 && creep.transfer(drive, RESOURCE_ENERGY, sent) === OK) {
            plan.transfer = true;
            taskBroker.consume(creep, room, drive, sent, 'deliver');
            plan.exclude.add(drive.id);
            const left = Math.max(0, load - sent);
            taskBroker.setProjected(creep, left);
            if (left <= 0) { planAfterDelivery(creep, room, ctx, plan, 0, capacity); return; }
        }
    }
    plan.move = target;
}

/** 取货后走不走：装到 leaveShare 就走；急用就走；源没有进账（掉落 / tombstone / storage）就走；
 *  否则比较"等进账"与"现在走"的效率——进账 × 往返 > 现有载货时等更划算（等 w tick 多拿 inflow×w，吞吐 (L+iw)/(T+w) > L/T ⇔ iT > L） */
function shouldLeave(creep, room, ctx, load, capacity, task) {
    if (load >= capacity * (Number(hauling().leaveShare) || 0.9)) return true;
    if (isUrgent(room, ctx)) return true;
    const inflow = task && task.inflow > 0 ? task.inflow : 0;
    if (!inflow) return true;
    return inflow * roundTripEstimate(creep, room) <= load;
}

/** 取货（空载，或补满零头）。返回是否有事可做 */
function collect(creep, room, ctx, plan, carried, capacity) {
    const free = Math.max(0, capacity - carried);
    if (free <= 0) return false;
    const pick = pickCollect(creep, room, ctx, free, plan.exclude, carried > 0);
    if (pick) {
        const target = pick.target;
        if (target.id === creep.memory.fill) plan.fillKept = true;
        if (!near(creep, target)) { plan.move = target; return true; }
        const got = takeFrom(creep, room, ctx, plan, target, free, pick.task);
        if (got > 0) leaveOrFill(creep, room, ctx, plan, target, pick.task, carried + got, capacity);
        return true;
    }
    if (carried <= 0 && consumerFallback(creep, room, ctx, plan, free)) return true;
    // 没有值得跑的：去有进账的源容器旁边等（租下它，别的 hauler 就不会也来等；源旁装满再走），而不是回 spawn 发呆
    const wait = waitTarget(creep, room, ctx, plan.exclude);
    if (!wait) return false;
    // 补满中的那口源停了进账（源采空等再生 / 源 link 开始收货）：带着货去送，不揣着货换到另一个等候点再等（审查 F1 两格来回跳）
    if (carried > 0 && creep.memory.fill && wait.target.id !== creep.memory.fill) {
        dropFill(creep, room);
        return false;
    }
    haulStats.note(creep, 'wait');
    taskBroker.leaseSpot(creep, wait);
    if (wait.target.id === creep.memory.fill) plan.fillKept = true;
    if (!near(creep, wait.target)) { plan.move = wait.target; return true; }
    if (creep.memory.fill !== wait.target.id) noteFill(room, 'start', carried / Math.max(1, capacity));
    creep.memory.fill = wait.target.id;
    plan.fillKept = true;
    // 攒够一口（FILL_CHUNK 或能装满）才取：每 tick 取 10 能量要多花一次动作的 CPU，能量留在容器里与在身上等价
    const stock = amountAt(wait.target);
    if (stock >= Math.min(free, FILL_CHUNK) && !plan.withdraw) {
        const got = takeFrom(creep, room, ctx, plan, wait.target, free, wait);
        if (got > 0) leaveOrFill(creep, room, ctx, plan, wait.target, wait, carried + got, capacity);
    }
    return true;
}
const FILL_CHUNK = 100;

/** 取到货以后：该走就挑投递目标同 tick 起步，否则记下补满目标，下一 tick 接着取 */
function leaveOrFill(creep, room, ctx, plan, target, task, load, capacity) {
    taskBroker.setProjected(creep, load);
    if (shouldLeave(creep, room, ctx, load, capacity, task)) {
        if (creep.memory.fill) noteFill(room, 'left', load / Math.max(1, capacity));
        delete creep.memory.fill;
        const next = pickDeliver(creep, room, plan.exclude);
        if (next && !near(creep, next.target)) plan.move = next.target;
        return;
    }
    if (creep.memory.fill !== target.id) noteFill(room, 'start', load / Math.max(1, capacity));
    creep.memory.fill = target.id;
    plan.fillKept = true;
    taskBroker.holdClaim(creep, target.id + ':collect');   // 留下来接着等：consume 刚释放的认领记回去
}

/** 遥测（私服生效断言 hauler.fillAtFedContainer）：进入补满的次数，与补满后离开时的平均装载率；drop = 没补满就放弃（进账停了、被别的目标拉走） */
function noteFill(room, kind, share) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem.haulFill || (mem.haulFill = { start: 0, left: 0, share: 0 });
    rec[kind] = (Number(rec[kind]) || 0) + 1;
    if (kind === 'left') rec.share = Math.round(((Number(rec.share) || 0) * (rec.left - 1) + share) / rec.left * 100) / 100;
    rec.at = Game.time;
}

/** 放弃补满：这一 tick 没有在补满容器取货 / 等候 / 往回走（进账停了、被别的取货 / 投递 / storage 兜底拉走）。
 *  以前 fill 一直留着，下一 tick 又把 hauler 拽回补满容器，在两格之间来回跳（审查 F1 / EC4） */
function dropFill(creep, room) {
    if (!creep.memory.fill) return;
    noteFill(room, 'drop');
    delete creep.memory.fill;
}

/** withdraw / pickup 一次，返回预计拿到的量（按 tick 开始时的数值算；同 tick 先跑的 creep 已扣掉的量按池子里的 backlog 算——
 *  withdraw 带显式数量，引擎在目标不够时整笔失败，不能按 tick 开始时的存量去要） */
function takeFrom(creep, room, ctx, plan, target, free, task) {
    const before = task && task.target && task.target.id === target.id ? Math.min(amountAt(target), Math.max(0, Number(task.backlog) || 0)) : amountAt(target);
    if (target.amount != null) {
        if (plan.pickup) return 0;
        if (creep.pickup(target) !== OK) return 0;
        plan.pickup = true;
        const got = Math.min(free, before);
        plan.exclude.add(target.id);
        taskBroker.consume(creep, room, target, got, 'collect');
        return got;
    }
    if (plan.withdraw) return 0;
    const isStorage = target.structureType === STRUCTURE_STORAGE;
    let amount = Math.min(free, before);
    if (isStorage) amount = Math.min(amount, storageWithdrawBudget(creep, room, ctx, free));
    if (amount <= 0 || (isStorage && amount < 50 && amount < free)) return 0;
    if (creep.withdraw(target, RESOURCE_ENERGY, amount) !== OK) return 0;
    plan.withdraw = true;
    plan.exclude.add(target.id);
    taskBroker.consume(creep, room, target, amount, 'collect');
    if (target.structureType === STRUCTURE_TERMINAL) {
        // 遥测（私服生效断言 hauler.terminalDrain）：从 terminal 取出终端网络送来的能量
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const rec = mem.terminalDrain || (mem.terminalDrain = { n: 0, amount: 0 });
        rec.n = (Number(rec.n) || 0) + 1;
        rec.amount = (Number(rec.amount) || 0) + amount;
        rec.at = Game.time;
        // storage 富余但低于 terminalDrainStorageBelow 时取回的量（broker 给 terminal 留 feeReserve；生效断言 broker.terminalDrainLow）
        if (task && Number(task.drainKeep) > 0) rec.low = (Number(rec.low) || 0) + amount;
    }
    if (isStorage) {
        markStorageCargo(creep);
        consumerReserveBudget.rooms[room.name] = (consumerReserveBudget.rooms[room.name] || 0) + amount;
        if (ctx.hubFed) {
            // 遥测（私服生效断言 hauler.hubBudgetedWithdraw）：hub 房按缺口取的次数与取量
            const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
            const rec = mem.hubBudgetedWithdraw || (mem.hubBudgetedWithdraw = { n: 0, amount: 0 });
            rec.n = (Number(rec.n) || 0) + 1;
            rec.amount = (Number(rec.amount) || 0) + amount;
            rec.at = Game.time;
        }
    }
    return amount;
}

/** 闲置储备只为实际消费者兜底；控制器 link 也可消费，不抢源侧物流或回库。 */
function consumerFallback(creep, room, ctx, plan, free) {
    if (ctx.hubFed || !room.storage || !room.storage.my || plan.withdraw) return false;
    const amount = storageWithdrawBudget(creep, room, ctx, free);
    if (amount < 50) return false;
    if (!near(creep, room.storage)) { plan.move = room.storage; return true; }
    const ret = creep.withdraw(room.storage, RESOURCE_ENERGY, amount);
    if (ret !== OK) return true;
    plan.withdraw = true;
    consumerReserveBudget.rooms[room.name] = (consumerReserveBudget.rooms[room.name] || 0) + amount;
    markStorageCargo(creep); // 已有投递保护：消费者消失也不能倒回 storage。
    const memory = Memory.rooms[room.name];
    memory.storageConsumerFallback = (memory.storageConsumerFallback || 0) + amount;
    taskBroker.consume(creep, room, room.storage, amount, 'collect');
    taskBroker.setProjected(creep, amount);
    const next = pickDeliver(creep, room, plan.exclude);
    if (next && !near(creep, next.target)) plan.move = next.target;
    return true;
}

/** 没活干 / 满载无处投：在 storage（没有就 spawn）3 格内等，已在范围内不动 */
function park(creep, room, plan) {
    const anchor = room.storage || room.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) { plan.move = anchor; plan.moveRange = 3; }
}

// ---- 打捞：非能量资源（入侵者阵亡掉的 boost 化合物、ruin 里的矿物）----

/** store 里的非能量总量。真引擎的 Store 用 getUsedCapacity 的差值最稳（键的枚举语义不保证），
 *  没有这个方法时退回按键求和 */
function nonEnergyIn(store) {
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') {
        return Math.max(0, (Number(store.getUsedCapacity()) || 0) - (Number(store.getUsedCapacity(RESOURCE_ENERGY)) || 0));
    }
    let sum = 0;
    for (const key of Object.keys(store)) {
        if (key === RESOURCE_ENERGY || typeof store[key] !== 'number') continue;
        sum += Math.max(0, store[key]);
    }
    return sum;
}

function firstNonEnergyType(store) {
    if (!store) return null;
    for (const key of Object.keys(store)) {
        if (key === RESOURCE_ENERGY || typeof store[key] !== 'number' || store[key] <= 0) continue;
        return key;
    }
    return null;
}

/** 打捞的卸货口：terminal 优先（矿物的正经去处，还能挂市场单），其次 storage。都放不下就别去捡——捡了也只能扔 */
function salvageSink(room, type) {
    return [room.terminal, room.storage].find((s) => s && s.my && s.store &&
        typeof s.store.getFreeCapacity === 'function' &&
        Number(s.store.getFreeCapacity(type == null ? undefined : type)) > 0) || null;
}

/** 房里值得打捞的非能量资源，按格聚合成"堆"：tombstone 衰减后散成同一格的几堆掉落（线上 2026-09-12 W35S7 的入侵者
 *  tombstone 是 GO 95 / KO 17 / ZH 23 / UH 11 四堆挤在 (12,5)），分开算每堆都够不着门槛，合起来才值得跑一趟。
 *  三次 find 都走 findCached（本 tick 已经取过），聚合本身只在真有非能量资源时才有成本——绝大多数 tick 是三个空数组 */
function salvageTargets(room) {
    const piles = {};
    const add = (pos, amount, item) => {
        if (!pos || !(amount > 0)) return;
        const key = pos.x + ',' + pos.y;
        const pile = piles[key] || (piles[key] = { pos, amount: 0, items: [] });
        pile.amount += amount;
        pile.items.push(item);
    };
    for (const kind of [FIND_TOMBSTONES, typeof FIND_RUINS !== 'undefined' ? FIND_RUINS : null]) {
        if (kind == null) continue;
        for (const item of findCached(room, kind) || []) add(item.pos, nonEnergyIn(item.store), item);
    }
    for (const drop of findCached(room, FIND_DROPPED_RESOURCES) || []) {
        if (!drop.resourceType || drop.resourceType === RESOURCE_ENERGY) continue;
        add(drop.pos, Number(drop.amount) || 0, drop);
    }
    return Object.keys(piles).map((key) => piles[key]);
}

/** 别的 hauler 已经认领的格子：一堆只派一只，第二只跑到时东西已经在别人身上了 */
function salvageClaimed(room, self) {
    const claimed = new Set();
    for (const other of findCached(room, FIND_MY_CREEPS) || []) {
        const claim = other && other.memory && other.memory.salvage;
        if (!claim || (self && other.name === self.name)) continue;
        claimed.add(claim.x + ',' + claim.y);
    }
    return claimed;
}

/** 配置项取数：不能用 `Number(x) || 默认`——那会把合法的 0 吞掉（minAmount: 0 = 什么都捡、timeout: 0 = 每 tick 重挑） */
function salvageNum(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

/** 挑一堆去捡：门槛随路程涨（minAmount + perTile × 路程），近处密集的优先（量 ÷ 路程） */
function pickSalvage(creep, room, targets) {
    const settings = config.salvage || {};
    const minAmount = salvageNum(settings.minAmount, 30);
    const perTile = salvageNum(settings.perTile, 0);
    const maxRange = salvageNum(settings.maxRange, 40);
    const claimed = salvageClaimed(room, creep);
    let best = null;
    let bestScore = 0;
    for (const pile of targets) {
        if (claimed.has(pile.pos.x + ',' + pile.pos.y)) continue;
        const travel = distance(creep, pile);
        if (travel > maxRange || pile.amount < minAmount + perTile * travel) continue;
        const score = pile.amount / (travel + 1);
        if (score > bestScore) { best = pile; bestScore = score; }
    }
    return best;
}

/** 主动打捞：掉落每 tick 衰减 ceil(amount/1000)、tombstone 按身体部件数 × 5 tick 就散成掉落，没人专程去捡就全丢光
 *  （线上 2026-09-12 W35S7：入侵者掉的 146 单位 T1 化合物在 250 tick 的 tombstone 寿命里没有任何 creep 认领）。
 *  认领按格记在 creep.memory.salvage，卸货走已有的 salvageCargo。返回 true = 这一 tick 就干这个 */
function salvagePickup(creep, room) {
    const settings = config.salvage || {};
    const abandon = () => { delete creep.memory.salvage; return false; };
    if (settings.enabled === false) return abandon();
    const targets = salvageTargets(room);
    if (!targets.length) return abandon();                  // 绝大多数 tick 走到这里就结束
    if (!salvageSink(room)) return abandon();               // terminal / storage 都放不下：捡了只能扔（salvageCargo 的兜底）
    const store = creep.store;
    if (!store || typeof store.getFreeCapacity !== 'function') return abandon();
    let free = Number(store.getFreeCapacity()) || 0;
    if (free <= 0) return false;                            // 装满了：留着认领，先交给 salvageCargo 去卸
    const claim = creep.memory.salvage;
    const stale = claim && Game.time - (Number(claim.at) || 0) > salvageNum(settings.timeout, 200);
    let pos = claim && claim.room === room.name && !stale ? claim : null;
    if (claim && !pos) delete creep.memory.salvage;         // 认领过期 / 换了房：放掉，这一 tick 还能重新挑
    const empty = !(Number(store.getUsedCapacity()) > 0);
    if (!pos) {
        // 只有完全空载的 hauler 才接新单：揣着能量的正在送货，别为几十单位矿物把整车锁在打捞上
        if (!empty) return false;
        const pile = pickSalvage(creep, room, targets);
        // spawn 在等能量 / spawn·ext 见底：先顾经济。必须在写 claim 之前判——否则"接单 → dropFill → 又放手"
        // 每 tick 空转一次，把源容器旁的补满粘性也一起清掉（isUrgent 不便宜，所以放在确实挑到了堆之后）
        if (!pile || isUrgent(room, contextFor(room))) return false;
        creep.memory.salvage = { x: pile.pos.x, y: pile.pos.y, room: room.name, at: Game.time };
        // 明确退出补满模式：遥测要记下这次放弃（否则 haulFill 的 start 永远等不到 left/drop），
        // 等候点的粘性也不该跨过这趟打捞——回来时那口源可能早就没进账了
        dropFill(creep, room);
        leaveBroker(creep);
        pos = creep.memory.salvage;
    } else if (empty && isUrgent(room, contextFor(room))) {
        return abandon();   // 半路上房间变急：空车放手回去运能量（装了货的把这趟跑完，半途而废等于白走）
    }
    const key = pos.x + ',' + pos.y;
    const pile = targets.find((item) => item.pos.x + ',' + item.pos.y === key);
    if (!pile) return abandon();                            // 这一堆捡光了 / 衰减光了 / 被别人收走（房里别的堆下一 tick 再挑）
    if (distance(creep, pile) > 1) { movement.go(creep, pile.items[0], { range: 1, reusePath: 20 }); return true; }
    // 到了。引擎按 transfer → withdraw → pickup 结算，withdraw 先占空位：先显式限量 withdraw，剩下的空位再 pickup，
    // 两条管线同 tick 各一次，四堆资源不用四趟
    let took = 0;
    const container = pile.items.find((item) => item.store && nonEnergyIn(item.store) > 0);
    const type = container ? firstNonEnergyType(container.store) : null;
    if (type) {
        const amount = Math.min(free, Number(container.store[type]) || 0);
        if (amount > 0 && creep.withdraw(container, type, amount) === OK) { took += amount; free -= amount; }
    }
    if (free > 0) {
        const loose = pile.items.find((item) => item.amount != null && item.resourceType !== RESOURCE_ENERGY && Number(item.amount) > 0);
        if (loose && creep.pickup(loose) === OK) took += Math.min(free, Number(loose.amount) || 0);
    }
    if (took > 0) noteSalvage(room, took);
    return true;
}

/** 退出 broker：打捞走独立路径，从 run() 最前面就 return，一路不碰 broker。残留的租约会被卡住检测当成"目标不可达"
 *  ——它按"位置和**能量**都没变"判定（task_broker.js energyOf 只看能量，打捞搬的是矿物；站在堆上取货也不移动），
 *  6 tick 就把租约那个目标屏蔽 150 tick，而且是对全房 hauler 生效。同一格 ≥6 种资源（被拆的 lab/factory 的 ruin）
 *  或路上被挡 6 tick 就会踩到。releaseClaim 连本 tick 的认领一起放掉，别人立刻看得到这个缺口没人管了 */
function leaveBroker(creep) {
    const lease = creep.memory && creep.memory.brokerTask;
    if (!lease) return;
    if (lease.id) taskBroker.releaseClaim(lease.id, creep);
    delete creep.memory.brokerTask;
}

/** 遥测（私服生效断言 hauler.salvagePickup）：主动打捞的次数与总量 */
function noteSalvage(room, amount) {
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const rec = mem.salvaged || (mem.salvaged = { n: 0, amount: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.amount = (Number(rec.amount) || 0) + amount;
    rec.at = Game.time;
}

/** 身上有非能量货（打捞回来的、别的途径塞进来的）：先卸进 terminal / storage，都放不下就扔掉——否则它永远占着容量，
 *  装满了的 hauler 一辈子停在 storage 边，编制里却还算一只（审查 EC6）。返回 true = 这一 tick 就干这个 */
function salvageCargo(creep, room) {
    const store = creep.store;
    if (!store || typeof store.getUsedCapacity !== 'function') return false;
    if (!(Number(store.getUsedCapacity()) > energyIn(store))) return false;
    const type = Object.keys(store).find((key) => key !== RESOURCE_ENERGY && Number(store[key]) > 0);
    if (!type) return false;
    const st = stashCfg(room);
    const sink = (st && type === st.resource && room.storage && room.storage.my && room.storage.store.getFreeCapacity(type) > 0)
        ? room.storage : salvageSink(room, type);
    if (!sink) { creep.drop(type); noteCounter(room, 'haulSalvage'); return false; }
    // 与 salvagePickup 同样的理由：这条路径也从 run() 早早 return、一路不碰 broker，而且每 tick 只 transfer 一种资源、
    // 站在 sink 旁不动、energyOf 不变——六种以上的货就会踩到卡住检测，把租约目标屏蔽 150 tick
    leaveBroker(creep);
    if (near(creep, sink)) { creep.transfer(sink, type); noteCounter(room, 'haulSalvage'); }
    else movement.go(creep, sink, { range: 1, reusePath: 20 });
    return true;
}

/** 低优先级囤货（config.hauling.stash[房] = {resource, keep, storageFree}）：空闲 hauler 把 terminal 里超过 keep 的该资源搬进 storage。
 *  只在本来要 park 的时候做、房间不急，卸货走 salvageCargo（该资源的 sink 改成 storage） */
function stashCfg(room) {
    const all = hauling().stash;
    return all && room && all[room.name] ? all[room.name] : null;
}
function stashPull(creep, room, ctx, plan) {
    const st = stashCfg(room);
    if (!st || plan.withdraw || !room.terminal || !room.storage || !room.storage.my) return false;
    const res = st.resource;
    const over = Number(room.terminal.store[res] || 0) - Number(st.keep || 0);
    if (!(over > 0)) return false;
    if (Number(room.storage.store.getFreeCapacity(res)) <= Number(st.storageFree || 50000)) return false;
    if (isUrgent(room, ctx)) return false;
    const free = Number(creep.store.getFreeCapacity()) || 0;
    if (free <= 0) return false;
    if (!near(creep, room.terminal)) { plan.move = room.terminal; plan.moveRange = 1; return true; }
    const amount = Math.min(free, over);
    if (creep.withdraw(room.terminal, res, amount) === OK) {
        plan.withdraw = true;
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const rec = mem.stashed || (mem.stashed = { amount: 0 });
        rec.amount = (Number(rec.amount) || 0) + amount; rec.at = Game.time;
    }
    return true;
}

/** 反向囤货（config.hauling.unstash[房] = {resource, target, terminalFree}）：空闲 hauler 把 storage 里的该资源搬进 terminal，
 *  直到 terminal 有 target；只在本来要 park 的时候做、房间不急。卸货走 salvageCargo（salvageSink 先 terminal） */
function unstashCfg(room) {
    const all = hauling().unstash;
    return all && room && all[room.name] ? all[room.name] : null;
}
function unstashPull(creep, room, ctx, plan) {
    const st = unstashCfg(room);
    if (!st || plan.withdraw || !room.terminal || !room.terminal.my || !room.storage) return false;
    const res = st.resource;
    const short = Number(st.target || 0) - Number(room.terminal.store[res] || 0);
    const have = Number(room.storage.store[res] || 0);
    if (!(short > 0) || !(have > 0)) return false;
    if (Number(room.terminal.store.getFreeCapacity(res)) <= Number(st.terminalFree || 20000)) return false;
    if (isUrgent(room, ctx)) return false;
    const free = Number(creep.store.getFreeCapacity()) || 0;
    if (free <= 0) return false;
    if (!near(creep, room.storage)) { plan.move = room.storage; plan.moveRange = 1; return true; }
    const amount = Math.min(free, short, have);
    if (creep.withdraw(room.storage, res, amount) === OK) {
        plan.withdraw = true;
        const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
        const rec = mem.unstashed || (mem.unstashed = { amount: 0 });
        rec.amount = (Number(rec.amount) || 0) + amount; rec.at = Game.time;
    }
    return true;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home), { reusePath: 20 }); return; }
    // 打捞先于卸货：到了堆上要把同一格的几种资源都收完再走，否则捡起第一种就被 salvageCargo 拽去 storage，来回跑四趟
    if (salvagePickup(creep, room)) return;
    if (salvageCargo(creep, room)) return;
    const energy = energyIn(creep.store);
    const free = freeIn(creep);
    const capacity = energy + free;
    if (!energy) { delete creep.memory.hubCargo; delete creep.memory.hubCargoAt; }
    const ctx = contextFor(room);
    const plan = newPlan();
    let fill = creep.memory.fill ? Game.getObjectById(creep.memory.fill) : null;
    if (creep.memory.fill && (!fill || (fill.pos && fill.pos.roomName !== room.name))) { delete creep.memory.fill; fill = null; }
    // 补满模式（在源容器旁等进账）：没急事、没装到 leaveShare 就继续取；否则投递
    let collecting = energy <= 0;
    if (!collecting && fill && !isUrgent(room, ctx) && energy < capacity * (Number(hauling().leaveShare) || 0.9)) collecting = true;
    if (!collecting && creep.memory.fill) {
        noteFill(room, 'left', energy / Math.max(1, capacity));   // 装到 leaveShare 或急用：带着补到的货走
        delete creep.memory.fill;
    }
    try {
        opportunistic(creep, room, plan, free, !collecting);
        if (collecting) {
            if (!collect(creep, room, ctx, plan, energy + plan.gained, capacity)) {
                if (energy + plan.gained > 0) deliver(creep, room, ctx, plan, energy, capacity);
                else if (!stashPull(creep, room, ctx, plan) && !unstashPull(creep, room, ctx, plan)) { haulStats.note(creep, 'park'); park(creep, room, plan); }
            }
        } else {
            deliver(creep, room, ctx, plan, energy, capacity);
        }
    } finally {
        if (creep.memory.fill && !plan.fillKept) dropFill(creep, room);
        if (plan.move) movement.go(creep, plan.move, { range: plan.moveRange, reusePath: 20 });
    }
}

/** 该容器是否为本房间规划中的源容器（避免把 controller 容器当源容器来回倒）。
 *  方案的控制器容器即使贴着源（源与控制器挨着的地形）也是消费者，不能按"源旁 1 格"的兜底认成源容器：
 *  否则 consumerTasks/deliverFilter 把它滤掉、storage 兜底取货的预算为 0，hauler 一直 park，升级者一点能量都拿不到；
 *  collect/waitTarget 反而把它当取货点从升级者那里往回搬（validation-52vHk6 W41N40：控制器容器 (42,31) 贴着源 (43,30)） */
function srcIsPlanned(room, s) {
    const plan = (Memory.rooms[room.name] || {}).plan;
    const containers = plan && plan.containers;
    if (containers) {
        for (const key of ['src0', 'src1']) {
            const c = containers[key];
            if (c && c.x === s.pos.x && c.y === s.pos.y) return true;
        }
        const ctrl = containers.ctrl;
        if (ctrl && ctrl.x === s.pos.x && ctrl.y === s.pos.y) return false;
    }
    const sources = findCached(room, FIND_SOURCES) || [];
    return sources.some((source) => Math.max(
        Math.abs(source.pos.x - s.pos.x),
        Math.abs(source.pos.y - s.pos.y),
    ) <= 1);
}

module.exports = { run, srcIsPlanned, unstashPull };
