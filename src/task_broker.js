'use strict';

const movement = require('movement');
const config = require('config');
const utils = require('utils');
const layout = require('layout');
const links = require('links');
const { repairTargetHits } = require('utils');
const conquest = require('conquest');

const ROLE_WEIGHT = {
    harvester: 100,
    hauler: 80,
    upgrader: 70,
    builder: 55,
    remoteMiner: 75,
    // SK reaper：被 CPU 跳过的 tick 不自愈、白挨 keeper 的 100——分数要在旧护栏的 20 线以上（cpu_shed 的降载也不跳它）
    skReaper: 85,
    remoteHauler: 65,
    courier: 60,
    feeder: 62,
    operator: 90,
    reserver: 45,
    scout: 20,
};
const TASK_WEIGHT = {
    deliver: 8,
    harvest: 7,
    build: 5,
    repair: 4,
    upgrade: 3,
};
const TASK_VALUE = {
    deliver: 1,
    collect: 1,
    harvest: 1.1,
    build: 1.35,
    repair: 0.75,
    upgrade: 0.65,
};
const ACTION_RANGE = {
    deliver: 1,
    collect: 1,
    harvest: 1,
    build: 3,
    repair: 3,
    upgrade: 3,
};
const REPLAN_INTERVAL = 5;  // 10-16：削 broker.begin 单 tick 峰值（相位仍错开）
const LEASE_TICKS = 5;
// 卡住检测：持有租约却连续 STUCK_TICKS tick 位置与能量都没变化，视为目标不可达/无效，屏蔽该任务 BLOCK_TICKS
const STUCK_TICKS = 6;
const BLOCK_TICKS = 150;
// 投递分层：spawn/ext 孵化 > tower 大缺口 > controller 供能容器 > storage。hauler 逐层竞价，高层有任务时低层让位
const DELIVER_TIERS = [1, 2, 3, 4];
const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__taskBrokerRuntime || (runtimeGlobal.__taskBrokerRuntime = {
    tick: -1,
    plannedAt: -1,
    tasks: {},
    claimed: {},
    scores: {},
    metrics: {},
    cpuHeadroom: null,
    lastState: {},
});

function constant(name, fallback) {
    return typeof global[name] === 'undefined' ? fallback : global[name];
}

function activeParts(creep, type) {
    if (creep && typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(type);
    return (creep && creep.body || []).filter((part) => (part.type || part) === type && part.hits !== 0).length;
}

function positionOf(value) {
    return value && value.pos ? value.pos : value;
}

function distanceBetween(left, right) {
    const a = positionOf(left);
    const b = positionOf(right);
    if (!a || !b) return 50;
    if (a.roomName && b.roomName && a.roomName !== b.roomName) return 50;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function actionDistance(creep, task) {
    const raw = distanceBetween(creep, task && task.target);
    return Math.max(0, raw - (ACTION_RANGE[task && task.kind] || 1));
}

function energyOf(store) {
    return store && Number(store[constant('RESOURCE_ENERGY', 'energy')] || 0) || 0;
}

function freeEnergy(store) {
    if (!store) return 0;
    if (typeof store.getFreeCapacity === 'function') return Math.max(0, Number(store.getFreeCapacity(constant('RESOURCE_ENERGY', 'energy'))) || 0);
    return 0;
}

function addTask(tasks, task) {
    if (!task || !task.target || !task.id || task.backlog <= 0) return;
    task.weight = task.weight == null ? TASK_WEIGHT[task.kind] || 1 : task.weight;
    tasks.push(task);
}

/** 源容器每 tick 的进账（给取货任务的"到达时有多少"预估）：旁边有带 WORK 的矿工在采、源 link 没在收货时按 min(源产出, 2×WORK) 计。
 *  源 link 未满时矿工先喂 link（harvester.js），容器只接溢出，按 0 计——否则 hauler 会守在一个永远不涨的容器边等；
 *  源采空了（等再生）也按 0 计：多只小矿工（>5 WORK）每轮要干等几十上百 tick，按 WORK 算的"进账"会让 hauler 揣着货守在空容器边 */
function sourceContainerInflow(room, container, sources, miners) {
    if (!container || !container.pos) return 0;
    const source = (sources || []).find((item) => item && item.pos && distanceBetween(item, container) <= 1);
    if (!source) return 0;
    let work = 0;
    for (const miner of miners || []) {
        if (!miner.pos || distanceBetween(miner, container) > 1 || distanceBetween(miner, source) > 1) continue;
        work += activeParts(miner, constant('WORK', 'work'));
    }
    if (work <= 0) return 0;
    // 矿工在岗但源采空了（>5 WORK 的源每轮要干等几十上百 tick）：进账按 0，否则 hauler 守在一个永远不涨的容器边
    if (source.energy != null && !(Number(source.energy) > 0)) { noteRoomCounter(room, 'haulInflowDry'); return 0; }
    const linkType = constant('STRUCTURE_LINK', 'link');
    const structures = typeof room.find === 'function' ? room.find(constant('FIND_MY_STRUCTURES', 'myStructures')) || [] : [];
    const link = structures.find((s) => s.structureType === linkType && s.store && distanceBetween(s, source) <= 2);
    if (link && freeEnergy(link.store) >= 100) return 0;
    const rate = Number(source.energyCapacity || 3000) / (typeof ENERGY_REGEN_TIME === 'number' ? ENERGY_REGEN_TIME : 300);
    return Math.max(0, Math.min(rate, work * (typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2)));
}

/** 累计计数型遥测（私服生效断言用）：Memory.rooms[房][key] = {n, at} */
function noteRoomCounter(room, key) {
    const name = room && room.name;
    if (!name || typeof Memory === 'undefined' || !Memory.rooms) return;
    const mem = Memory.rooms[name] || (Memory.rooms[name] = {});
    const rec = mem[key] || (mem[key] = { n: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.at = Game.time;
}

/** 溢出取货最多几只 hauler 同时认领：房里 ≥ 3 只 hauler 放 2 只，否则 1 只 */
function spillSlots(creeps) {
    const haulers = (creeps || []).filter((creep) => creep.memory && creep.memory.role === 'hauler' && !creep.spawning).length;
    return haulers >= 3 ? 2 : 1;
}

/** 控制器由谁供能：'link'（ctrl link 已建成属我方）> 'storage'（storage 站位，升级者直接从 storage 取）> null（hauler 喂控制器容器）。
 *  broker 的容器投递与 monitor 探针的 ctrlFeed 共用这一判定 */
function controllerFeedMode(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = (mem && mem.plan) || null;
    if (!plan) return null;
    const linkSpot = typeof layout.linkSpot === 'function' ? layout.linkSpot(plan, 'ctrl') : null;
    const link = linkSpot ? layout.structureAt(room, linkSpot.x, linkSpot.y, constant('STRUCTURE_LINK', 'link')) : null;
    if (link && link.my) return 'link';
    if (typeof layout.controllerFedByStorage === 'function' && layout.controllerFedByStorage(room, plan)) return 'storage';
    return null;
}

function controllerFeedContainer(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = (mem && mem.plan) || null;
    if (!plan || !plan.containers || !plan.containers.ctrl) return null;
    const spot = plan.containers.ctrl;
    const container = layout.structureAt(room, spot.x, spot.y, constant('STRUCTURE_CONTAINER', 'container'));
    if (!container || !container.store) return null;
    if (controllerFeedMode(room)) return null;
    return container;
}

/** 升级者站在 storage 旁、storage 在取用底线 + 工作带以上：升级者自己就能直接喝 storage，hauler 再把 storage 的能量搬进 ctrl link
 *  纯属多搬一趟——而且把 ctrl link 顶在缓冲线上，源 link 按持有规则不再发货，矿工又溢出进源容器（afebad5 让升级者先喝 link 之后
 *  W31S6 这类房会进这个循环：44 个线上快照 41 个 storage 富余）。返回 true 时 ctrl link 的补给任务（富余回流 / 按需补给）都不发 */
function storageStationFeedsController(room, plan) {
    const storage = room && room.storage;
    if (!storage || storage.my === false || !storage.store || !plan) return false;
    if (typeof layout.controllerFedByStorage !== 'function' || !layout.controllerFedByStorage(room, plan)) return false;
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const band = Math.max(0, Number(config.controllerFeedStorageBand) || 0);
    return energyOf(storage.store) >= reserve + band;
}

function noteCtrlLinkSkip(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    if (!mem) return;
    const rec = mem.ctrlLinkFeedSkip || (mem.ctrlLinkFeedSkip = { n: 0 });
    rec.n = (Number(rec.n) || 0) + 1;
    rec.at = Game.time;
}

/** 没有仓库接收 link 时，按实际升级需求补控制器缓冲；不依赖仓库富余门槛。 */
function controllerFeedLink(room) {
    const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || {};
    const plan = mem.plan;
    if (!plan || links.storeLinkReady(room, plan)) return null;
    const target = links.getLink(room, plan, 'ctrl');
    if (!target || !target.store) return null;
    if (storageStationFeedsController(room, plan)) return null;
    const consumers = room.find(constant('FIND_MY_CREEPS', 'myCreeps')) || [];
    if (!consumers.some((creep) => !creep.spawning && creep.memory && creep.memory.role === 'upgrader')) return null;
    const energy = energyOf(target.store);
    const buffer = Math.max(0, Number(config.linkKeepAt) || 400);
    const backlog = Math.min(freeEnergy(target.store), buffer - energy);
    if (backlog <= 0) return null;
    const starved = energy < buffer * (Number(config.controllerFeedStarvedBelow) || 0.1) &&
        room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
        !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room);   // 10-16 塔优先（config.towerFirst）：塔没补够前控制器供能不插队
    return { target, backlog, starved };
}

/** 升级者由 storage 供能时 storage 就是"控制器供能仓"：能量低于 controllerFeedStorageFloor 时按第三层补；
 *  见底（controllerFeedStorageStarved）且 spawn 能量过半、spawn 没在等买不起的 creep 时先送——与容器的公平规则同义。
 *  返回 { target, backlog, starved } 或 null。hauler/remoteHauler 的兜底路径也用它。 */
function controllerFeedStorage(room) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name];
    const plan = (mem && mem.plan) || null;
    if (!plan || typeof layout.controllerFedByStorage !== 'function' || !layout.controllerFedByStorage(room, plan)) return null;
    const storage = room.storage;
    if (!storage || !storage.store) return null;
    // 补给地板必须高出升级者的取用底线一个工作带：升级者只取 upgrading.reserve 以上（roles/upgrader.withdrawable），
    // 补给又停在 controllerFeedStorageFloor —— 两者相等时 storage 收敛到底线上，可取量恒为 0，升级者按"hauler 在岗就等"
    // 无限期空等（线上 2026-09-07：storage 供能的 W31S6 storage 1188–1994 徘徊、升级 12–16 → 0.00 prog/tick，
    // W31S8 storage 2190–2657、6.58 → 1.62；同 RCL、storage 更低的容器供能房 W33S8 靠第三层容器投递稳在 13–21）
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const band = Math.max(0, Number(config.controllerFeedStorageBand) || 0);
    const floor = Math.max(Number(config.controllerFeedStorageFloor) || 2000, reserve + band);
    const energy = energyOf(storage.store);
    if (energy >= floor || freeEnergy(storage.store) <= 0) return null;
    const starved = energy < (Number(config.controllerFeedStorageStarved) || 500) &&
        room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
        !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room);   // 10-16 塔优先（config.towerFirst）：塔没补够前控制器供能不插队
    // 决策事件遥测：storage 已在取用底线之上却仍要补——这一段就是工作带，旧代码（地板 = reserve）结构上到不了这里。
    // 私服生效断言看的是这个计数，而不是期末的 storage/进度快照（末态会被"补给自然涨过底线"抹平）
    if (mem && energy >= reserve) {
        const seen = mem.ctrlFeedBand && mem.ctrlFeedBand.n || 0;
        mem.ctrlFeedBand = { at: Game.time, energy, floor, n: seen + 1 };
    }
    return { target: storage, backlog: floor - energy, starved };
}

/** 房里需要维修的建筑（每 tick 每房算一次）：塔的维修预算判定、维修任务池、危急结构判定共用一份扫描。
 *  必须是 FIND_STRUCTURES 而不是 FIND_MY_STRUCTURES——道路与容器是中立建筑，不在 FIND_MY_STRUCTURES 里，
 *  而它们恰恰是"烂到 0 就消失"的那一类（线上 2026-09-09 W33S7：60 条路全部需要维修，broker 的维修任务池里
 *  一条路都没有，只有 5 个己方 rampart）。needsRepair 自带方案过滤（方案外的旧路/旧容器不修）与 rampart 的 RCL 封顶 */
const needsRepairCache = { time: -1, rooms: {} };
function roomRepairTargets(room) {
    if (needsRepairCache.time !== Game.time) { needsRepairCache.time = Game.time; needsRepairCache.rooms = {}; }
    if (needsRepairCache.rooms[room.name]) return needsRepairCache.rooms[room.name];
    // findCached：全 tick 共用一份 room.find 结果（tower.js/builder.js 也在扫结构）
    const found = utils.findCached(room, constant('FIND_STRUCTURES', 'structures')).filter((s) => utils.needsRepair(room, s));
    needsRepairCache.rooms[room.name] = found;
    return found;
}
function roomNeedsRepair(room) {
    return roomRepairTargets(room).length > 0;
}

/** 会消失的危急结构（utils.criticallyDamaged）在塔的射程内：塔的维修预算是给它用的。
 *  塔的射程按 TOWER_FALLOFF_RANGE（20）算，射程外修不到——线上 W33S7 两座塔在 (6,40)/(7,41)，
 *  大多数道路在房间另一侧，给它们补能量也修不到，所以只有射程内有危急结构时才提优先级 */
const criticalCache = { time: -1, rooms: {} };
function roomCriticalStructures(room) {
    if (criticalCache.time !== Game.time) { criticalCache.time = Game.time; criticalCache.rooms = {}; }
    if (criticalCache.rooms[room.name]) return criticalCache.rooms[room.name];
    const found = utils.findCached(room, constant('FIND_STRUCTURES', 'structures')).filter((s) => utils.criticallyDamaged(room, s));
    criticalCache.rooms[room.name] = found;
    return found;
}
function criticalWithin(room, pos, range) {
    return roomCriticalStructures(room).some((s) => s.pos &&
        Math.max(Math.abs(s.pos.x - pos.x), Math.abs(s.pos.y - pos.y)) <= range);
}

/** terminal 还该从 storage 补多少能量（0 = 不补）：storage 富余（滞回开）且高于 industry.terminalFillStorageAbove 时，
 *  补到 industry.terminalTarget，且补完 storage 不低于门槛（只动门槛以上那部分） */
function feeReserveOf(roomName) {
    const map = (config.terminalNetwork || {}).terminalFeeReserve;
    return Math.max(0, Number(map && map[roomName]) || 0);
}

function terminalFillWant(room, terminal, storageRich) {
    const fee = feeReserveOf(room.name);
    if (fee > 0 && terminal && terminal.my !== false && terminal.store) {
        // 传送费储备：不看 storageRich，storage 里高于 feeReserveStorageFloor 的部分都可以补进来
        const st = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
        const floor = Math.max(0, Number((config.terminalNetwork || {}).feeReserveStorageFloor) || 0);
        const short = fee - energyOf(terminal.store);
        if (st && short > 0) {
            const give = Math.min(short, energyOf(st.store) - floor);
            if (give > 0) return Math.max(give, terminalFillWantBase(room, terminal, storageRich));
        }
    }
    return Math.max(terminalFillWantBase(room, terminal, storageRich), senderFillWant(room, terminal, storageRich), terminalFloorWant(room, terminal));
}

/** 10-16 战略：terminal 能量底线（config.terminal.energyFloor 1000）——storage ≥ energyFloorMinStorage（1 万）的房把 terminal 补到底线付传送费，
 *  补完 storage 不跌破门槛；穷房（storage < 门槛）不补。返回还要补多少 */
function terminalFloorParams(room) {
    const c = config.terminal || {};
    const floor = Math.max(0, Number(c.energyFloor) || 0);
    const min = Math.max(0, Number(c.energyFloorMinStorage) || 0);
    const st = room && room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!(floor > 0) || !st || energyOf(st.store) < min) return null;
    return { floor, min, storage: energyOf(st.store) };
}
function terminalFloorWant(room, terminal) {
    const p = terminalFloorParams(room);
    if (!p || !terminal || terminal.my === false || !terminal.store) return 0;
    return Math.max(0, Math.min(p.floor - energyOf(terminal.store), p.storage - p.min));
}

/** 能量发送房（10-16 战略猫）：满足救急发送方规则（storageRich、storage+terminal ≥ starveSendAbove）的房，
 *  terminal 补到 储备 + senderTerminalExtra（1 万），storage 不低于 senderStorageFloor（3 万 = terminalDrainStorageBelow，不会搬进又搬出） */
function senderFillWant(room, terminal, storageRich) {
    const net = config.terminalNetwork || {};
    const extra = Number(net.senderTerminalExtra) || 0;
    if (!storageRich || !(extra > 0) || !terminal || terminal.my === false || !terminal.store) return 0;
    const st = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!st) return 0;
    const se = energyOf(st.store), te = energyOf(terminal.store);
    if (se + te < (Number(net.starveSendAbove) || Number(net.sendAbove) || 0)) return 0;
    const reserve = Math.max(Number(net.feeReserve) || 0, feeReserveOf(room.name));
    return Math.max(0, Math.min(reserve + extra - te, se - (Number(net.senderStorageFloor) || 30000)));
}

function terminalFillWantBase(room, terminal, storageRich) {
    const cfg = config.industry || {};
    const target = Math.max(0, Number(cfg.terminalTarget) || 0);
    if (!storageRich || !(target > 0) || !terminal || terminal.my === false || !terminal.store) return 0;
    const storage = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!storage) return 0;
    const surplus = energyOf(storage.store) - Math.max(0, Number(cfg.terminalFillStorageAbove) || 0);
    return Math.max(0, Math.min(target - energyOf(terminal.store), surplus));
}

/** terminal 取货要在里面留多少能量（null = 不取）：storage 不富余（滞回关）时全取（终端网络送来的能量）；
 *  富余但 storage 低于 industry.terminalDrainStorageBelow 时取到只剩 terminalNetwork.feeReserve；其余时候不取——
 *  补能只在 storage ≥ terminalFillStorageAbove 时动门槛以上的部分，两条线之间隔着一段，不会搬进来又搬出去 */
function terminalDrainKeep(room, storageRich) {
    const fee = feeReserveOf(room.name);
    const keep = terminalDrainKeepBase(room, storageRich);
    // 底线房：取回时 terminal 至少留 energyFloor（不会补进去又取出来）
    const fp = terminalFloorParams(room);
    if (fp && keep != null && keep < fp.floor) return Math.max(fp.floor, fee > 0 ? fee : 0);
    if (fee > 0 && keep != null) return Math.max(keep, fee);   // 传送费储备不取回
    return keep;
}

function terminalDrainKeepBase(room, storageRich) {
    if (!storageRich) return 0;
    const below = Math.max(0, Number((config.industry || {}).terminalDrainStorageBelow) || 0);
    const storage = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!storage || !(below > 0) || energyOf(storage.store) >= below) return null;
    return Math.max(0, Number((config.terminalNetwork || {}).feeReserve) || 0);
}

/** boost lab 还该补多少能量（0 = 不补）：只给 industry 指定的 boost lab（industryState.labs.boostLab）——反应三连不耗能，
 *  给它们补只是把能量锁在 lab 里。闸与 terminal 补能相同：storage 富余（滞回开）且高于 terminalFillStorageAbove，补完不跌回门槛。
 *  强化开关（conquest.boostingEnabled）由调用方另判：这里只算"开着时该补多少"，关着时调用方记遥测不出任务 */
function labEnergyWant(room, lab, storageRich, roomMemory) {
    const cfg = config.industry || {};
    const target = Math.max(0, Number(cfg.labEnergyTarget) || 0);
    if (!storageRich || !(target > 0) || !lab || lab.my === false || !lab.store) return 0;
    const labsState = roomMemory && roomMemory.industryState && roomMemory.industryState.labs;
    if (!labsState || labsState.boostLab !== lab.id) return 0;
    const storage = room.storage && room.storage.my !== false && room.storage.store ? room.storage : null;
    if (!storage) return 0;
    const surplus = energyOf(storage.store) - Math.max(0, Number(cfg.terminalFillStorageAbove) || 0);
    return Math.max(0, Math.min(target - energyOf(lab.store), surplus));
}

function roomTasks(room) {
    const tasks = [];
    const ownedStructuresKind = constant('FIND_MY_STRUCTURES', constant('FIND_STRUCTURES', 'structures'));
    const allStructuresKind = constant('FIND_STRUCTURES', 'structures');
    const sitesKind = constant('FIND_MY_CONSTRUCTION_SITES', constant('FIND_CONSTRUCTION_SITES', 'constructionSites'));
    const sourcesKind = constant('FIND_SOURCES', 'sources');
    const spawnType = constant('STRUCTURE_SPAWN', 'spawn');
    const extensionType = constant('STRUCTURE_EXTENSION', 'extension');
    const towerType = constant('STRUCTURE_TOWER', 'tower');
    const containerType = constant('STRUCTURE_CONTAINER', 'container');
    const storageType = constant('STRUCTURE_STORAGE', 'storage');
    const terminalType = constant('STRUCTURE_TERMINAL', 'terminal');
    const labType = constant('STRUCTURE_LAB', 'lab');
    const tombstonesKind = constant('FIND_TOMBSTONES', 'tombstones');
    const dropsKind = constant('FIND_DROPPED_RESOURCES', 'droppedResources');
    const hostilesKind = constant('FIND_HOSTILE_CREEPS', 'hostileCreeps');
    const ownedStructures = typeof room.find === 'function' ? room.find(ownedStructuresKind) || [] : [];
    const structures = typeof room.find === 'function' ? room.find(allStructuresKind) || [] : [];
    const hostile = typeof room.find === 'function' && (room.find(hostilesKind) || []).length > 0;
    const towerRefillAt = Number(config.towerRefillAt) || 300;
    // storage 富余（utils.storageRichState 滞回）且控制器容器不满：把 storage 的能量搬去升级——控制器容器投递提到第 1 层；
    // 取货 storage 在容器供能房只是兜底（权重 6 < 源容器 7，见 config.upgrading 注释），link 供能房里是几格短途才压过源容器
    const ctrlFeed = controllerFeedContainer(room);
    const fillBelow = Number(config.upgraderFillBelow) || 0.8;
    const roomMemory = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const storageRich = utils.storageRichState(room, roomMemory, config.upgrading || {});
    let boostingCache = null;
    const boostingOn = () => (boostingCache == null ? (boostingCache = !!conquest.boostingEnabled()) : boostingCache);
    const ctrlCapacity = ctrlFeed && typeof ctrlFeed.store.getCapacity === 'function' ? ctrlFeed.store.getCapacity(constant('RESOURCE_ENERGY', 'energy')) : 2000;
    // 控制器由 link 供能的房（线上 W33S7）：富余时 hauler 直接把 storage 的能量送进控制器 link（RCL7 前没有 storage link，容器又不喂）
    const feedPlan = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].plan) || null;
    let ctrlLink = storageRich && feedPlan && controllerFeedMode(room) === 'link' ? links.getLink(room, feedPlan, 'ctrl') : null;
    if (ctrlLink && storageStationFeedsController(room, feedPlan)) {
        if (ctrlLink.store && freeEnergy(ctrlLink.store) >= 200) noteCtrlLinkSkip(room);
        ctrlLink = null;
    }
    const richLink = !!(ctrlLink && ctrlLink.store && freeEnergy(ctrlLink.store) >= 200);
    const hubFed = typeof links.hubHaulMode === 'function' && links.hubHaulMode(room, feedPlan);
    const richFeed = storageRich && ((!!ctrlFeed && freeEnergy(ctrlFeed.store) > 0 && energyOf(ctrlFeed.store) < ctrlCapacity * fillBelow) || richLink);
    if (richLink) {
        addTask(tasks, { kind: 'deliver', id: ctrlLink.id + ':ctrlFeed', target: ctrlLink, backlog: freeEnergy(ctrlLink.store), weight: 9, tier: 1, roles: ['hauler', 'remoteHauler'] });
    } else {
        const linkFeed = controllerFeedLink(room);
        if (linkFeed) addTask(tasks, { kind: 'deliver', id: linkFeed.target.id + ':ctrlFeed', target: linkFeed.target,
            backlog: linkFeed.backlog, level: Math.max(0, Number(config.linkKeepAt) || 400), weight: linkFeed.starved ? 20 : 4, tier: linkFeed.starved ? 1 : 3,
            roles: ['hauler', 'remoteHauler'] });
    }
    const spawnNeeds = ownedStructures.some((structure) => (structure.structureType === spawnType || structure.structureType === extensionType) &&
        structure.store && freeEnergy(structure.store) > 0);
    for (const structure of ownedStructures) {
        const free = freeEnergy(structure.store);
        // 塔的紧急锁存每次重建任务都要评估——包括已补满（free 0）的塔，否则锁存永不解除、塔一有缺口就又是第 1 层
        // 紧急 = 有敌人或储备被动用，且一旦动用就锁存到补到不缺（utils.towerUrgent：hauler 兜底 / remoteHauler.homeTarget 同一判定）
        const towerUrgentNow = structure.structureType === towerType ? utils.towerUrgent(room, structure, hostile) : false;
        if (free <= 0) continue;
        if (structure.structureType === spawnType || structure.structureType === extensionType) {
            addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: free, weight: 10, tier: 1 });
        } else if (structure.structureType === towerType) {
            // 塔的"大缺口"（有敌人或能量掉到维修储备以下）压过一切：第 1 层、权重 11 > spawn 10——spawn 持续孵化时 spawn/ext 永远有缺口，
            // 塔打完入侵者剩 11 能量会几百 tick 没人补（线上 2026-09-06 W34S7：4 只 hauler 在岗、spawn 113/1300 换代身体，塔 11/1000 半小时），
            // 没能量的塔下一波入侵就是裸奔；和平期高于储备的缺口只是维修消耗，排到控制器容器之后（第 4 层，与 storage 同层但权重更高）——
            // 否则塔停在 620–690 时 hauler 每趟的零头都先喂塔，升级者挨饿
            const urgent = towerUrgentNow;
            if (free >= towerRefillAt || hostile) {
                // 维修预算：塔停在储备线上时一次也修不动（tower.js 要求 energy − 10 ≥ towerRepairReserve），而第 4 层权重 2 在
                // "控制器容器见底 ⇒ 第 1 层权重 20" 的房里永远轮不到——基地就这么烂掉。房里确实有东西要修且塔缺维修预算时提到第 3 层。
                // 但第 3 层仍然输给第 1 层的 spawn/ext（spawn 持续孵化时那里永远有缺口），于是塔一辈子停在 500 一次也修不动：
                // 线上 2026-09-09 W33S7 两座塔 500/501、60 条路全部在衰减、16 条已低于 500 血。射程内有"会消失的"危急结构时
                // 提到第 1 层（权重 11 > spawn 的 10）：塔一次动作 800 血、10 能量，救下一条路省 300–1500 能量重建。
                // 有界：塔补到储备 + 预算（500+400）就降回第 4 层，维修消耗掉这 400 才会再提级。
                const needsBudget = energyOf(structure.store) < (Number(config.towerRepairReserve) || 500) + (Number(config.towerMaintenanceBudget) || 0);
                const towerRange = Number(config.towerCriticalRange) || (typeof TOWER_FALLOFF_RANGE !== 'undefined' ? TOWER_FALLOFF_RANGE : 20);
                const criticalNear = !urgent && needsBudget && structure.pos && criticalWithin(room, structure.pos, towerRange);
                const maintenance = !urgent && !criticalNear && needsBudget && roomNeedsRepair(room);
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: free,
                    weight: urgent || criticalNear ? 11 : maintenance ? (Number(config.towerMaintenanceWeight) || 5) : 2,
                    tier: urgent || criticalNear ? 1 : maintenance ? 3 : 4 });
                // 遥测（私服生效断言）：紧急塔第一次压过有缺口的 spawn/ext 的 tick
                if (urgent && spawnNeeds && roomMemory && !roomMemory.towerFirstAt) roomMemory.towerFirstAt = Game.time;
                // 遥测：危急结构把塔的维修预算提到第 1 层的 tick（射程内没有危急结构时不该出现）
                if (criticalNear && roomMemory) {
                    roomMemory.towerCritical = { at: Game.time, energy: energyOf(structure.store), x: structure.pos.x, y: structure.pos.y };
                }
            }
        } else if (structure.structureType === storageType) {
            // storage 只由 hauler 回库；builder/upgrader 手里的能量应去升级，而不是倒进仓库。backlog 封顶（config.storageDeliverBacklogCap）：
            // 100 万空位会把 backlog 遥测和 ln(backlog) 评分撑爆，压过同层的工地 builder 补能
            const storageCap = Math.max(1, Number(config.storageDeliverBacklogCap) || 10000);
            addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: Math.min(free, storageCap), cap: storageCap, weight: 1, tier: 4, roles: ['hauler'] });
        } else if (structure.structureType === terminalType) {
            // terminal 也要有人往里送能量（移植 overmind-absorb e4cae2f）：投递目标里原本没有 terminal，终端网络（src/terminal.js
            // 发送方要 terminal 里有能量）、市场（要付传送费）、industry.canSpend（terminal ≥ terminalReserve）三条线的前置条件永远不成立。
            // 只从 storage 的富余里补：storageRich 滞回开着、且 storage 高于 terminalFillStorageAbove；补到 terminalTarget 为止，
            // 每次最多补到 storage 跌回门槛——线上 10/14 个房 storage≈0，这些房一点都不会补。第 4 层、权重 0.5 < storage 的 1，绝不和经济成长抢
            const fill = terminalFillWant(room, structure, storageRich);
            if (fill > 0) {
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: Math.min(free, fill), weight: 0.5, tier: 4, roles: ['hauler'] });
                if (roomMemory) roomMemory.terminalFill = { at: Game.time, want: fill, terminal: energyOf(structure.store) };
            }
        } else if (structure.structureType === labType) {
            // boost lab 要能量（移植 overmind-absorb 019c5b1）：boostCreep 每部件 20 能量，lab 建成时是空的，而投递目标里没有 lab——
            // 强化永远做不成。与 terminal 同样处理：第 4 层、权重更低（0.4），只在 storage 富余且过门槛时补
            // 强化默认关闭（config.conquest.boosts 空、指令也没写 boosts）：没有任何 creep 会来这个 lab 强化，补进去的能量永远锁在里面（2026-10-14 复审）
            const want = labEnergyWant(room, structure, storageRich, roomMemory);
            if (want > 0 && boostingOn()) {
                addTask(tasks, { kind: 'deliver', id: structure.id, target: structure, backlog: Math.min(free, want), weight: 0.4, tier: 4, roles: ['hauler'] });
                if (roomMemory) roomMemory.labEnergy = { at: Game.time, want, lab: structure.id, energy: energyOf(structure.store) };
            } else if (want > 0 && roomMemory) {
                // 遥测：本该补、因为强化没打开而不补（生效断言 broker.labEnergyNeedsBoosts）
                roomMemory.labEnergyHeld = { at: Game.time, want, lab: structure.id, energy: energyOf(structure.store) };
            }
        }
    }
    // controller 供能容器是中立建筑，不在 FIND_MY_STRUCTURES 里：显式登记为 hauler 专属投递目标（有 ctrl link 时由 link 供给）
    if (ctrlFeed) {
        const capacity = ctrlCapacity;
        const free = freeEnergy(ctrlFeed.store);
        if (free > 0 && energyOf(ctrlFeed.store) < capacity * fillBelow) {
            // 公平供给：spawn 持续忙碌时 spawn/ext 永远有缺口，控制器容器会几百 tick 进不到能量；
            // 容器见底且 spawn 能量已有一半以上时，这一趟先送控制器
            // spawn 正在等能量孵买不起的 creep（外矿/援建）时不抢：否则 spawn 永远停在一半，外矿 creep 永远买不起
            const starved = energyOf(ctrlFeed.store) < capacity * (Number(config.controllerFeedStarvedBelow) || 0.1) &&
                room.energyAvailable >= room.energyCapacityAvailable * (Number(config.controllerFeedSpawnShare) || 0.5) &&
                !utils.spawnWaitingFor(room) && !utils.towerFloorHold(room);   // 10-16 塔优先（config.towerFirst）：塔没补够前控制器供能不插队
            // storage 富余时控制器容器与 spawn 同层（权重 9 < spawn 的 10：spawn 有缺口仍先补，补完这一车剩下的直接进容器）
            addTask(tasks, { kind: 'deliver', id: ctrlFeed.id, target: ctrlFeed, backlog: free, until: capacity * fillBelow,
                weight: starved ? 20 : richFeed ? 9 : 4, tier: starved || richFeed ? 1 : 3, roles: ['hauler', 'remoteHauler'] });
        }
    }
    // 升级者由 storage 供能：storage 低于地板线时与控制器容器同样的分层/公平规则（另一个 id，不影响 storage 的第四层回库任务）
    const storageFeed = controllerFeedStorage(room);
    if (storageFeed) {
        addTask(tasks, { kind: 'deliver', id: storageFeed.target.id + ':ctrlFeed', target: storageFeed.target, backlog: storageFeed.backlog,
            level: energyOf(storageFeed.target.store) + storageFeed.backlog,
            weight: storageFeed.starved ? 20 : 4, tier: storageFeed.starved ? 1 : 3, roles: ['hauler', 'remoteHauler'] });
    }
    // 工地上的 builder：能量低于一半时由 hauler 直接送（与塔同层，低于 spawn/ext）
    const feedBelow = Number(config.builderFeedBelow) || 0.5;
    const feedWait = Number(config.builderFeedWait) || 30;
    const creepsKind = constant('FIND_MY_CREEPS', 'myCreeps');
    const builders = typeof room.find === 'function' ? room.find(creepsKind) || [] : [];
    for (const builder of builders) {
        const memory = builder.memory || {};
        if (memory.role !== 'builder' || !(Game.time - Number(memory.feedAt || -1e9) <= feedWait)) continue;
        const capacity = typeof builder.store.getCapacity === 'function' ? builder.store.getCapacity(constant('RESOURCE_ENERGY', 'energy')) : 0;
        const free = freeEnergy(builder.store);
        if (!capacity || free < 50) continue;
        // 能量过半的 builder 也能补：放在第 4 层（与 storage 同层）——spawn/塔/控制器都满时 hauler 与其满载停在 spawn 旁，不如把能量送到工地
        // （线上 W35S7 三只 hauler 200/200 停着，builder 在工地上一格一格地用）
        const low = energyOf(builder.store) < capacity * feedBelow;
        addTask(tasks, { kind: 'deliver', id: builder.id, target: builder, backlog: free, weight: low ? 6 : 2, tier: low ? 2 : 4, roles: ['hauler'] });
    }
    const sourceList = typeof room.find === 'function' ? room.find(constant('FIND_SOURCES', 'sources')) || [] : [];
    const creepsHere = typeof room.find === 'function' ? room.find(constant('FIND_MY_CREEPS', 'myCreeps')) || [] : [];
    const miners = creepsHere.filter((creep) => creep.memory && (creep.memory.role === 'harvester' || creep.memory.role === 'remoteMiner'));
    const drops = typeof room.find === 'function' ? room.find(dropsKind) || [] : [];
    // 溢出（能量正在白丢）：源容器 ≥ spillShare 满、或源旁地上成堆（≥ spillDrop，每 tick 衰减 ceil(量/1000)）。溢出的源压过一切普通取货，
    // storage 的富余取货退回兜底——线上 2026-09-12 W33S3：storage 30 万、ctrl link 的 storage 回流（权重 8）场场赢，
    // 22 格外的源容器 57% 采样满仓、脚下一堆 3.4k–8.7k 在衰减（每 tick 丢 4–9），两只 hauler 187 tick 一次都没去过
    const hauling = config.hauling || {};
    const spillShare = Number(hauling.spillShare) || 0.9;
    const spillDrop = Number(hauling.spillDrop) || 500;
    const spillWeight = Number(hauling.spillWeight) || 10;
    const spillExitShare = Number(hauling.spillExitShare) || 0.6;
    const spillExitDrop = Number(hauling.spillExitDrop) || 200;
    const nearSource = (object) => sourceList.some((source) => source.pos && distanceBetween(source, object) <= 2);
    // 按源判定、带滞回：进入 = 源容器 ≥ spillShare 满或源旁地上 ≥ spillDrop；退出 = 容器 < spillExitShare 且地上 < spillExitDrop。
    // 以前是整房开关、取一车就退出，房间在"溢出 / 不溢出"之间来回切，storage 回流时有时无（W33S3）
    const energyType = constant('RESOURCE_ENERGY', 'energy');
    const spillState = roomMemory ? (roomMemory.spill || (roomMemory.spill = {})) : {};
    const spillBySource = {};
    // 源的容器：先认方案里的 srcN 位，再退回"源旁 1 格"——但方案的控制器容器即使贴着源也不是源容器（满着的控制器容器不是源在溢出）
    const planContainers = (feedPlan && feedPlan.containers) || {};
    const atSpot = (s, spot) => !!spot && s.pos && s.pos.x === spot.x && s.pos.y === spot.y;
    const sourceContainerOf = (source) => {
        const near = structures.filter((s) => s.structureType === containerType && s.store && distanceBetween(s, source) <= 1);
        return near.find((s) => atSpot(s, planContainers.src0) || atSpot(s, planContainers.src1)) ||
            near.find((s) => !atSpot(s, planContainers.ctrl)) || null;
    };
    for (const source of sourceList) {
        if (!source || !source.id || !source.pos) continue;
        const container = sourceContainerOf(source);
        const capacity = container && typeof container.store.getCapacity === 'function' ? Number(container.store.getCapacity(energyType)) || 2000 : 2000;
        const stored = container ? energyOf(container.store) : 0;
        const pile = drops.reduce((sum, drop) => sum + (drop.resourceType === energyType && distanceBetween(drop, source) <= 2 ? Number(drop.amount) || 0 : 0), 0);
        const was = !!spillState[source.id];
        const now = was ? (stored >= capacity * spillExitShare || pile >= spillExitDrop) : (stored >= capacity * spillShare || pile >= spillDrop);
        if (now !== was) {
            if (now) spillState[source.id] = Game.time; else delete spillState[source.id];
            if (roomMemory) roomMemory.spillFlips = (Number(roomMemory.spillFlips) || 0) + 1;
        }
        spillBySource[source.id] = now;
    }
    for (const id of Object.keys(spillState)) if (!(id in spillBySource)) delete spillState[id];
    const spillingSourceOf = (object) => sourceList.find((source) => source.pos && spillBySource[source.id] && distanceBetween(source, object) <= 2);
    const spilling = Object.values(spillBySource).some(Boolean);
    // 等候点：有进账的源容器（能量为 0 时不进任务池，但正是 hauler 该去等满的地方）
    const waits = [];
    runtime.waitSpots = runtime.waitSpots || {};
    runtime.waitSpots[room.name] = waits;
    for (const structure of structures) {
        if (structure.structureType !== containerType && structure.structureType !== storageType) continue;
        if (structure.structureType === storageType && structure.my === false) continue;
        if (structure.structureType === containerType && typeof links.skipSourceContainer === 'function' &&
            links.skipSourceContainer(room, feedPlan, structure)) continue;
        if (structure.structureType === containerType && nearSource(structure)) {
            const inflowHere = sourceContainerInflow(room, structure, sourceList, miners);
            if (inflowHere > 0) waits.push({ kind: 'collect', id: structure.id + ':collect', target: structure, backlog: energyOf(structure.store), inflow: inflowHere,
                inflowCap: sourceEnergyNear(structure, sourceList), wait: true });
        }
        const available = energyOf(structure.store);
        // storage 取货：富余 + link 供能 8（压过源容器 7）；富余 + 容器供能 6（兜底：源容器/掉落都没得取时才轮到，hauler 竞价按 rich 标记放行）；否则 2
        // hub 模式（每口源都进 store link）：storage 就是唯一正规取货点，权重 8，不看富余。
        // 房里有源在溢出时 storage 的富余取货一律降到兜底（6）：搬仓库里的能量不丢，源旁的能量在丢
        const isStorage = structure.structureType === storageType;
        const storageWeight = isStorage && (richFeed || hubFed) ? ((richLink && !spilling) || hubFed ? 8 : 6) : 2;
        let weight = structure.structureType === containerType ? 7 : storageWeight;
        let inflow = 0;
        // 溢出源的取货：权重提到 spillWeight，但只放一只 hauler 去（房里 ≥ 3 只才放两只）——按量认领时两只 hauler 会一起认领
        // 同一堆 7k，把基地这边的活整个撂下（W33S3 的升级者本来就欠供）
        let slots;
        let inflowCap;
        if (structure.structureType === containerType) {
            inflow = sourceContainerInflow(room, structure, sourceList, miners);
            if (inflow > 0) inflowCap = sourceEnergyNear(structure, sourceList);
            if (spillingSourceOf(structure)) { weight = spillWeight; slots = spillSlots(creepsHere); }
        }
        addTask(tasks, { kind: 'collect', id: structure.id + ':collect', target: structure, backlog: available,
            weight, inflow, inflowCap, slots, rich: isStorage && (richFeed || hubFed), hub: isStorage && hubFed });
    }
    // terminal 取货（终端网络的接收端，src/terminal.js）：别的房传送过来的能量落在 terminal 里，没人取就一直趴着。
    // 只在 storage 不富余（storageRich 滞回关）时取；补能要 storageRich 开且 storage ≥ terminalFillStorageAbove，两者互斥，不会搬进来又搬出去
    // storage 富余但已跌到 industry.terminalDrainStorageBelow 以下（2026-10-13 复审）：补能那时搬进去的能量此刻没有消费方
    // （终端网络发送要 storage+terminal ≥ sendAbove、canSpend 要 storage ≥ storageReserve），也要取回来给升级/孵化，只留 feeReserve 给市场传送费；
    // 否则 storage 从 5 万一路用到 storageFeedBelow 时最多 terminalTarget 的能量锁在 terminal 里（supply-floor-vs-draw-reserve 同类）
    const ownTerminal = room.terminal && room.terminal.my !== false && room.terminal.store ? room.terminal : null;
    const drainKeep = ownTerminal ? terminalDrainKeep(room, storageRich) : null;
    if (ownTerminal && drainKeep != null && energyOf(ownTerminal.store) > drainKeep) {
        addTask(tasks, { kind: 'collect', id: ownTerminal.id + ':collect', target: ownTerminal, backlog: energyOf(ownTerminal.store) - drainKeep,
            weight: 6, roles: ['hauler'], terminalDrain: true, drainKeep });
        if (drainKeep > 0 && roomMemory) roomMemory.terminalDrainLow = { at: Game.time, storage: energyOf(room.storage.store), terminal: energyOf(ownTerminal.store), keep: drainKeep };
    }
    for (const drop of drops) {
        // 取货任务只给 hauler / remoteHauler，两者都只会卸能量：矿物掉落进了池子只会被捡起来永远占着容量
        if (drop.resourceType != null && drop.resourceType !== energyType) continue;
        if (typeof links.skipLinkedDrop === 'function' && links.skipLinkedDrop(room, feedPlan, drop)) continue;
        const amount = Number(drop.amount || 0);
        const spill = drop.resourceType === energyType && amount >= spillExitDrop && !!spillingSourceOf(drop);
        addTask(tasks, { kind: 'collect', id: drop.id, target: drop, backlog: amount, weight: spill ? spillWeight - 1 : 6,
            slots: spill ? spillSlots(creepsHere) : undefined });
    }
    const tombstones = typeof room.find === 'function' ? room.find(tombstonesKind) || [] : [];
    for (const tombstone of tombstones) {
        addTask(tasks, { kind: 'collect', id: tombstone.id + ':collect', target: tombstone, backlog: energyOf(tombstone.store), weight: 5, tombstone: true });
    }
    // 拆迁留下的 ruin（extension 50、容器最多 2000）也当 tombstone 一样收，别让它随 ruin 衰减白丢
    const ruinsKind = constant('FIND_RUINS', 'ruins');
    const ruins = typeof room.find === 'function' ? room.find(ruinsKind) || [] : [];
    for (const ruin of ruins) {
        if (energyOf(ruin.store) <= 0) continue;
        addTask(tasks, { kind: 'collect', id: ruin.id + ':collect', target: ruin, backlog: energyOf(ruin.store), weight: 5, tombstone: true });
    }
    const sites = typeof room.find === 'function' ? room.find(sitesKind) || [] : [];
    for (const site of sites) {
        if (typeof utils.siteWanted === 'function' && !utils.siteWanted(room, site)) continue;   // 没过经济门槛的奢侈工地
        addTask(tasks, {
            kind: 'build', id: site.id, target: site,
            backlog: Math.max(0, (site.progressTotal || 0) - (site.progress || 0)),
            // spawn 最优先（没有 spawn 什么都孵不出来），塔其次（防御优先：替换旧塔后的无塔窗口要短），link 再次（一座 link 顶几只 hauler；
            // 基准 W34S7 的 link 工地放出后 0 进度 5k tick），无 storage 时 storage 工地再次（config.construction.storageBeforeRoads），
            // 再道路（路网决定运力），再源/控制器容器，其余按 backlog/距离竞价
            weight: site.structureType === spawnType ? 10 : site.structureType === towerType ? 9
                : site.structureType === constant('STRUCTURE_LINK', 'link') ? 8.7
                : (site.structureType === constant('STRUCTURE_STORAGE', 'storage') && !room.storage && (config.construction || {}).storageBeforeRoads !== false) ? 8.5
                : site.structureType === constant('STRUCTURE_ROAD', 'road') ? 8 : site.structureType === containerType ? 7 : 5,
        });
    }
    // 维修任务池：用 roomRepairTargets（FIND_STRUCTURES + needsRepair）而不是 ownedStructures——
    // 道路/容器是中立建筑，旧写法让它们在任务池里根本不存在，于是"会消失的"那类结构没有任何 builder 认领
    for (const structure of roomRepairTargets(room)) {
        // rampart 缺口按 RCL 维修目标计（否则百万级 hitsMax 会把 backlog 统计淹没）
        addTask(tasks, {
            kind: 'repair', id: structure.id, target: structure,
            backlog: Math.max(0, repairTargetHits(room, structure) - structure.hits),
            weight: structure.structureType === towerType || structure.structureType === spawnType ? 7 : 3,
        });
    }
    const sources = typeof room.find === 'function' ? room.find(sourcesKind) || [] : [];
    for (const source of sources) {
        addTask(tasks, {
            kind: 'harvest', id: source.id, target: source,
            backlog: Math.max(0, Number(source.energy || 0)),
            weight: 7,
        });
    }
    const controller = room.controller;
    if (controller && controller.my) {
        const downgradeUrgency = controller.ticksToDowngrade == null ? 0 :
            Math.max(0, 10000 - controller.ticksToDowngrade);
        addTask(tasks, {
            kind: 'upgrade', id: controller.id || room.name + ':controller', target: controller,
            backlog: Math.max(1, downgradeUrgency),
            weight: downgradeUrgency > 5000 ? 8 : 3,
        });
    }
    return tasks;
}

// 能接 broker 任务的角色（下面 compatibleParts 各 kind 名单的并集）：别的角色（remoteMiner/reserver/operator/scout/防御…）
// 对任何任务都不兼容，orderCreeps 不必拿它们去逐个任务算认领容量（线上 13 房 ~65 只，每 tick 白算一遍）
const TASK_ROLES = { harvester: true, hauler: true, upgrader: true, builder: true, remoteHauler: true };

/** creep 的角色与 WORK/CARRY 是否在岗：一次 bestTask 只扫一遍身体（以前每个任务扫两遍） */
function taskParts(creep) {
    return {
        role: creep.memory && creep.memory.role,
        work: activeParts(creep, constant('WORK', 'work')) > 0,
        carry: activeParts(creep, constant('CARRY', 'carry')) > 0,
    };
}

function compatibleParts(parts, task) {
    const { role, work, carry } = parts;
    if (Array.isArray(task.roles) && !task.roles.includes(role)) return false;
    if (task.kind === 'harvest') return work && ['harvester', 'builder', 'upgrader'].includes(role);
    if (task.kind === 'deliver') return carry && ['hauler', 'harvester', 'builder', 'upgrader', 'remoteHauler'].includes(role);
    if (task.kind === 'collect') return carry && ['hauler', 'remoteHauler'].includes(role);
    if (task.kind === 'upgrade') return work && carry && ['upgrader', 'builder'].includes(role);
    if (task.kind === 'build' || task.kind === 'repair') return work && carry && ['builder', 'upgrader', 'remoteHauler'].includes(role);
    return false;
}

function taskCompatible(creep, task) {
    return compatibleParts(taskParts(creep), task);
}

function cpuHeadroom() {
    if (runtime.cpuHeadroom != null) return runtime.cpuHeadroom;
    const cpu = typeof Game !== 'undefined' && Game.cpu;
    if (!cpu || typeof cpu.getUsed !== 'function') {
        runtime.cpuHeadroom = 1;
        return runtime.cpuHeadroom;
    }
    const limit = Number(cpu.tickLimit || cpu.limit) || 0;
    if (!limit) {
        runtime.cpuHeadroom = 1;
        return runtime.cpuHeadroom;
    }
    runtime.cpuHeadroom = Math.max(0.25, Math.min(1, 1 - Number(cpu.getUsed() || 0) / limit));
    return runtime.cpuHeadroom;
}

function ttlUrgency(creep, travel) {
    if (creep.ticksToLive == null || creep.spawning) return 1;
    const remaining = Math.max(0, creep.ticksToLive - Math.max(0, Number(travel) || 0) - 3);
    const viability = Math.max(0.25, Math.min(1, remaining / 150));
    const urgency = 1 + Math.min(1, Math.max(0, 300 - creep.ticksToLive) / 300) * 0.4;
    return viability * urgency;
}

// 按量预留（投递 / 取货）：同一目标上别的认领者已经承诺了多少。投递按认领者身上的能量（不超过目标缺口），取货按认领者的空位
// （不超过它到达时目标里会有的量）。以前按 ceil(backlog/200) 分槽、不看 hauler 容量：600 能量的容器能放进 3 只 1600 容量的 hauler，
// 后到的扑空再掉头（基准快照里 38 个取货租约有 8 个被 2–3 只 hauler 共用，例：288 能量的容器被两只空的 1500 hauler 同时租着）
const AMOUNT_KINDS = { deliver: true, collect: true };
const MAX_CLAIMANTS = 6;

/** 本 tick 的动作结算后预计的载货量（store 要下一 tick 才变）：角色代码在 transfer/withdraw/pickup 之后登记，按量预留与竞价都用它 */
function setProjected(creep, energy) {
    if (!creep || !creep.name) return;
    runtime.projected = runtime.projected || {};
    runtime.projected[creep.name] = { t: Game.time, e: Math.max(0, Number(energy) || 0) };
}

function projectedEnergy(creep) {
    const entry = runtime.projected && runtime.projected[creep.name];
    if (entry && entry.t === Game.time) return entry.e;
    return energyOf(creep.store);
}

function creepCapacity(creep) {
    const store = creep && creep.store;
    if (store && typeof store.getCapacity === 'function') {
        const capacity = Number(store.getCapacity(constant('RESOURCE_ENERGY', 'energy')));
        if (Number.isFinite(capacity) && capacity > 0) return capacity;
    }
    return activeParts(creep, constant('CARRY', 'carry')) * 50;
}

function projectedFree(creep) {
    const entry = runtime.projected && runtime.projected[creep.name];
    const store = creep && creep.store;
    if (!entry || entry.t !== Game.time) return freeEnergy(store);
    // 其他资源占的空间照旧扣掉（getUsedCapacity 与 energy 之差）
    const used = store && typeof store.getUsedCapacity === 'function' ? Number(store.getUsedCapacity()) || 0 : energyOf(store);
    const other = Math.max(0, used - energyOf(store));
    return Math.max(0, creepCapacity(creep) - other - entry.e);
}

/** 目标里到 creep 到达时会有多少（取货）：当前量 + 进账 × 路程（源容器才有进账，封顶源里还剩的能量——源采空前后不会凭空多出来） */
function arrivalAmount(task, creep) {
    const backlog = Math.max(0, Number(task.backlog) || 0);
    if (task.kind !== 'collect' || !(task.inflow > 0) || !creep || !creep.pos) return backlog;
    const gained = task.inflow * actionDistance(creep.pos, task);
    return backlog + (task.inflowCap != null ? Math.min(gained, Math.max(0, Number(task.inflowCap) || 0)) : gained);
}

/** 源容器旁那口源里还剩多少能量（arrivalAmount 的进账封顶）；拿不到 energy 字段时不封顶 */
function sourceEnergyNear(container, sources) {
    const source = (sources || []).find((item) => item && item.pos && distanceBetween(item, container) <= 1);
    return source && source.energy != null ? Math.max(0, Number(source.energy) || 0) : undefined;
}

function claimAmount(task, creep) {
    if (task.kind === 'deliver') return Math.min(projectedEnergy(creep), Math.max(0, Number(task.backlog) || 0));
    // 在源容器旁等进账 / 补满的 hauler 会把之后的进账全部吸走，按它的全部空位预留——否则第二只 hauler 看到"还有几十能量的进账"也跑来一起等
    const filling = task.wait || (creep.memory && task.target && creep.memory.fill === task.target.id);
    if (filling) return projectedFree(creep);
    return Math.min(projectedFree(creep), arrivalAmount(task, creep));
}

/** 别的认领者对这个任务承诺的量。creep 自己已在认领表里时只算排在它前面的（离目标更近、同距离先认领的）：
 *  否则两只同时租着一个小容器的 hauler 会互相把对方算进去、一起放弃，谁也不去。
 *  还在别的房间的认领者（援建 hauler 从母房一路走过来、外矿运输工在回程）不挡本房的：它的到达时间按 50 算、却按全额预留，
 *  本房 hauler 就得看着那格空着干等它走完全程；等它进了房、路程是真的了再参与排队（问的一方自己也不在房里时照旧都算） */
function reservedByOthers(task, creep) {
    const owners = claimants(task.id);
    const mine = creep ? owners.indexOf(creep.name) : -1;
    const myEta = mine >= 0 && creep.pos ? actionDistance(creep.pos, task) : 0;
    const home = task.target && task.target.pos && task.target.pos.roomName;
    const askerLocal = !creep || !creep.pos || !home || creep.pos.roomName === home;
    let sum = 0;
    for (let index = 0; index < owners.length; index++) {
        const name = owners[index];
        if (creep && name === creep.name) continue;
        const other = typeof Game !== 'undefined' && Game.creeps ? Game.creeps[name] : null;
        if (!other) continue;
        if (askerLocal && home && other.pos && other.pos.roomName && other.pos.roomName !== home) {
            noteRoomCounter(typeof Game !== 'undefined' && Game.rooms ? Game.rooms[home] : null, 'brokerFarClaims');
            continue;
        }
        if (mine >= 0 && other.pos) {
            const eta = actionDistance(other.pos, task);
            if (eta > myEta || (eta === myEta && index > mine)) continue;
        }
        sum += claimAmount(task, other);
    }
    return sum;
}

/** creep 还能从这个任务拿到（取货）/ 送进去（投递）多少；非按量任务返回 backlog */
function availableFor(task, creep) {
    if (!task) return 0;
    if (!AMOUNT_KINDS[task.kind]) return Math.max(0, Number(task.backlog) || 0);
    return arrivalAmount(task, creep) - reservedByOthers(task, creep);
}

function taskYield(creep, task) {
    if (!creep || !task) return 0;
    const work = activeParts(creep, constant('WORK', 'work'));
    const carry = activeParts(creep, constant('CARRY', 'carry'));
    const backlog = Math.max(0, Number(task.backlog) || 0);
    if (task.kind === 'harvest') return Math.min(backlog, Math.min(10, work * 2));
    if (task.kind === 'collect' || task.kind === 'deliver') return Math.max(0, Math.min(availableFor(task, creep), carry * 50));
    if (task.kind === 'build') return Math.min(backlog, work * 5, carry * 5);
    if (task.kind === 'repair') return Math.min(backlog, work * 100, carry * 100);
    if (task.kind === 'upgrade') return Math.min(backlog, work, carry * 50, 15);
    return 0;
}

function estimatedCpu(creep, task, travel) {
    const bodyLength = Math.max(1, (creep && creep.body && creep.body.length) || 1);
    const pathCost = Math.max(0, Number(travel) || 0) > 3 ? 1.5 : 0.5;
    const actionCost = ['build', 'repair', 'upgrade'].includes(task && task.kind) ? 0.35 : 0.2;
    return 0.5 + pathCost + actionCost + Math.min(1, bodyLength / 50);
}

function scoreTask(creep, task) {
    if (!taskCompatible(creep, task)) return -Infinity;
    return scoreCompatible(creep, task);
}

/** 已确认兼容之后的打分（bestTask 先筛兼容再查认领容量，不重复扫身体） */
function scoreCompatible(creep, task) {
    const yieldRate = taskYield(creep, task);
    if (yieldRate <= 0) return -Infinity;
    const roleWeight = ROLE_WEIGHT[creep.memory && creep.memory.role] || 10;
    const travel = actionDistance(creep.pos, task);
    const remaining = AMOUNT_KINDS[task.kind] ? availableFor(task, creep) : task.backlog;
    const backlog = Math.log1p(Math.max(0, remaining) / Math.max(1, yieldRate * (travel + 2))) + 1;
    const value = TASK_VALUE[task.kind] || 1;
    const cpuFactor = cpuHeadroom() / estimatedCpu(creep, task, travel);
    return roleWeight * task.weight * value * yieldRate * backlog * ttlUrgency(creep, travel) * cpuFactor /
        (travel + 1);
}

function taskSlots(task) {
    if (!task) return 1;
    if (Number(task.slots) > 0) return Math.max(1, Math.floor(task.slots));
    const backlog = Math.max(1, Number(task.backlog) || 1);
    const quantum = {
        harvest: 300,
        collect: 200,
        deliver: 200,
        build: 1000,
        repair: 1000,
        upgrade: 15,
    }[task.kind] || 200;
    const maximum = {
        harvest: 8,
        collect: 4,
        deliver: 4,
        build: 4,
        repair: 3,
        upgrade: 2,
    }[task.kind] || 1;
    return Math.max(1, Math.min(maximum, Math.ceil(backlog / quantum)));
}

function claimants(taskId) {
    const value = runtime.claimed[taskId];
    if (Array.isArray(value)) return value;
    if (value) return [value];
    return [];
}

function hasClaimCapacity(task, creep) {
    const owners = claimants(task.id);
    if (owners.includes(creep.name)) return true;
    // 投递/取货按量：别人承诺的量已经填满（或取空）这个目标就不再放人；显式 slots 的任务仍按只数
    if (AMOUNT_KINDS[task.kind] && !(Number(task.slots) > 0)) return owners.length < MAX_CLAIMANTS && availableFor(task, creep) > 0;
    return owners.length < taskSlots(task);
}

function claimTask(task, creep) {
    const owners = claimants(task.id);
    if (!owners.includes(creep.name)) owners.push(creep.name);
    runtime.claimed[task.id] = owners;
}

function releaseClaim(taskId, creep) {
    if (!taskId || !creep) return;
    const owners = claimants(taskId);
    const index = owners.indexOf(creep.name);
    if (index >= 0) owners.splice(index, 1);
}

function ensureTick() {
    if (runtime.tick === Game.time) return;
    runtime.tick = Game.time;
    runtime.claimed = {};
    runtime.scores = {};
    runtime.cpuHeadroom = null;
    runtime.projected = {};
    runtime.blocked = runtime.blocked || {};
    runtime.stuckTicks = runtime.stuckTicks || {};
    // 租约就是预留：tick 开头先把所有未过期的租约记成认领，否则认领表按 creep 执行顺序现建，排在后面的租约持有者会被先跑的 creep
    // 挤掉名额、半路掉头（基准 claims-not-reservations）
    for (const creep of Object.values((typeof Game !== 'undefined' && Game.creeps) || {})) {
        const lease = creep && creep.memory && creep.memory.brokerTask;
        if (!lease || !lease.id || !(lease.until >= Game.time)) continue;
        const owners = claimants(lease.id);
        if (!owners.includes(creep.name)) owners.push(creep.name);
        runtime.claimed[lease.id] = owners;
    }
}

/** 同 tick 结算：creep 刚对 target 做了 amount 的投递/取货（store 下一 tick 才变），把池子里同一目标的任务 backlog 先扣掉，
 *  并释放它在这些任务上的认领——后跑的 creep 这一 tick 就看得到"那格 extension 已经满了"，不会再把同一格当目标 */
function consume(creep, room, target, amount, kind) {
    if (!room || !target || !target.id) return;
    beginTick();
    const sent = Math.max(0, Number(amount) || 0);
    for (const task of runtime.tasks[room.name] || []) {
        if (!task.target || task.target.id !== target.id) continue;
        if (kind && task.kind !== kind) continue;
        if (!AMOUNT_KINDS[task.kind]) continue;
        task.backlog = Math.max(0, (Number(task.backlog) || 0) - sent);
        releaseClaim(task.id, creep);
    }
}

/** 取完这一口还要留下来接着等（补满模式）：把刚被 consume 释放的认领记回去——否则这一 tick 后跑的 hauler 看它是空的，跑来一起等 */
function holdClaim(creep, taskId) {
    if (!creep || !taskId) return;
    beginTick();
    claimTask({ id: taskId }, creep);
}

/** 有进账的源容器等候点（含能量为 0、不在任务池里的），backlog 用当前存量刷新 */
function waitSpots(room) {
    if (!room) return [];
    beginTick();
    const spots = (runtime.waitSpots && runtime.waitSpots[room.name]) || [];
    const live = [];
    for (const spot of spots) {
        const target = typeof Game !== 'undefined' && typeof Game.getObjectById === 'function' ? Game.getObjectById(spot.target.id) || null : spot.target;
        if (!target || !target.store) continue;
        spot.target = target;
        spot.backlog = energyOf(target.store);
        live.push(spot);
    }
    return live;
}

/** 直接租下一个不在池子里的任务（等候点）：记认领 + 租约，别的 hauler 这一 tick 与之后都看得到这份预留 */
function leaseSpot(creep, task) {
    if (!creep || !task || !task.id) return null;
    beginTick();
    return leaseTask(creep, { task });
}

/** 本 tick 的任务池（hub 模式判断"有没有消费者要能量"、storage 取货的需求预算用，不必每只 hauler 重建一遍 roomTasks） */
function pooledTasks(room) {
    if (!room) return [];
    beginTick();
    return runtime.tasks[room.name] || [];
}

function isBlocked(task) {
    const until = runtime.blocked && runtime.blocked[task.id];
    return until != null && until > Game.time;
}

function roomPhase(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h) % REPLAN_INTERVAL;
}

/** 单测用：下一次 beginTick 让所有房重建任务池（错峰前同一 tick 全房重建，测试依赖这一点） */
function forceReplan() { runtime.roomPlannedAt = {}; runtime.refreshedAt = -1; }

function beginTick() {
    ensureTick();
    // 任务池按房错峰重建（2026-10-14）：过去所有房在同一 tick 一起 roomTasks()，那一 tick broker.begin 30–76 CPU，
    // 是整 tick 尖峰（>150）最常见的一项；按房名 hash 分到 REPLAN_INTERVAL 个相位，均值不变、单 tick 峰值约降到 1/3。
    // 每房仍然最多 REPLAN_INTERVAL tick 重建一次，中间 tick 照旧 refreshTasks。
    const planned = runtime.roomPlannedAt || (runtime.roomPlannedAt = {});
    if (runtime.refreshedAt === Game.time) return;
    runtime.refreshedAt = Game.time;
    runtime.plannedAt = Game.time;
    if (Game.time % REPLAN_INTERVAL === 0) {
        // 清理已死亡 creep 的上一 tick 状态，避免 global 缓存无限增长。
        // stuckTicks 也必须一起清：名字按 role 复用后，前任死掉留下的卡住计数会被同名新生 creep 继承。
        runtime.lastState = runtime.lastState || {};
        runtime.stuckTicks = runtime.stuckTicks || {};
        for (const name of Object.keys(runtime.lastState)) {
            if (!Game.creeps || !Game.creeps[name]) delete runtime.lastState[name];
        }
        for (const name of Object.keys(runtime.stuckTicks)) {
            if (!Game.creeps || !Game.creeps[name]) delete runtime.stuckTicks[name];
        }
    }
    const owned = {};
    const replanBudget = 8;
    const replanT0 = Game.cpu.getUsed();
    let deferredReplan = 0;
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my) continue;
        owned[room.name] = true;
        const last = planned[room.name];
        const due = !(last >= 0) || !runtime.tasks[room.name] || Game.time - last >= REPLAN_INTERVAL ||
            Game.time < last || (Game.time + roomPhase(room.name)) % REPLAN_INTERVAL === 0;
        if (due && (Game.cpu.getUsed() - replanT0) < replanBudget) {
            planned[room.name] = Game.time;
            runtime.tasks[room.name] = roomTasks(room);
            const metric = runtime.metrics[room.name] || { assigned: 0, idle: 0, deferred: 0, skippedCpu: 0, expired: 0 };
            metric.backlog = runtime.tasks[room.name].reduce((sum, task) => sum + task.backlog, 0);
            runtime.metrics[room.name] = metric;
        } else {
            if (due) deferredReplan++;
            const tasks = runtime.tasks[room.name];
            runtime.tasks[room.name] = refreshTasks(tasks);
            if (!runtime.metrics[room.name]) {
                runtime.metrics[room.name] = { backlog: (tasks || []).reduce((sum, task) => sum + task.backlog, 0),
                    assigned: 0, idle: 0, deferred: 0, skippedCpu: 0, expired: 0 };
            }
        }
    }
    if (deferredReplan > 0) {
        const mem = Memory.cpuDiag || (Memory.cpuDiag = {});
        mem.brokerDefer = (Number(mem.brokerDefer) || 0) + deferredReplan;
        mem.brokerDeferAt = Game.time;
    }
    for (const name of Object.keys(runtime.tasks)) if (!owned[name]) { delete runtime.tasks[name]; delete planned[name]; }
}

function refreshTasks(tasks) {
    // 任务池每 REPLAN_INTERVAL tick 重算，中间几 tick 的 deliver/collect 目标用当前 tick 的对象刷新 backlog：
    // 已被填满/取空的目标立刻退出池子，hauler 不会对着满的 spawn 发 transfer 或多跑一趟
    if (typeof Game === 'undefined' || typeof Game.getObjectById !== 'function') return tasks;
    const kept = [];
    for (const task of tasks || []) {
        if (task.kind !== 'deliver' && task.kind !== 'collect') { kept.push(task); continue; }
        const live = Game.getObjectById(String(task.id).split(':')[0]);
        if (!live) continue;
        task.target = live;
        if (task.kind === 'deliver') {
            // 登记时的封顶与目标水位要一起沿用：storage 回库的 backlog 封顶、ctrl link / storage 的供能水位、控制器容器补到 fillBelow 就停——
            // 只按空位重算会让 storage 回库在 3 tick 里 2 tick 变成上百万、供能任务在条件消失后多活到下次重建（投递会冲过缓冲线）
            const energy = energyOf(live.store);
            let backlog = freeEnergy(live.store);
            if (task.until != null && energy >= task.until) backlog = 0;
            if (task.level != null) backlog = Math.min(backlog, task.level - energy);
            if (task.cap != null) backlog = Math.min(backlog, task.cap);
            task.backlog = backlog;
        } else {
            task.backlog = live.amount != null ? Number(live.amount || 0) : energyOf(live.store);
        }
        if (task.backlog > 0) kept.push(task);
    }
    return kept;
}

function tasksFor(creep) {
    const roomName = creep.memory && creep.memory.home || creep.room && creep.room.name;
    return runtime.tasks[roomName] || [];
}

function bestTask(creep, tasks, filter) {
    let best = null;
    let bestScore = -Infinity;
    let parts = null;
    for (const task of tasks || []) {
        if (filter && !filter(task)) continue;
        if (isBlocked(task)) continue;
        // 兼容性排在认领容量之前：不兼容的任务打分本来就是 -Infinity、永远选不中，结果不变；
        // 但 hasClaimCapacity 对投递/取货要走 availableFor → reservedByOthers（遍历认领者、查 Game.creeps），白算
        if (!compatibleParts(parts || (parts = taskParts(creep)), task)) continue;
        if (!hasClaimCapacity(task, creep)) continue;
        const score = scoreCompatible(creep, task);
        if (score > bestScore) { best = task; bestScore = score; }
    }
    return best ? { task: best, score: bestScore } : null;
}

function orderCreeps(creeps) {
    beginTick();
    const scored = (creeps || []).map((creep, index) => {
        // 不能接任务的角色直接落到角色权重 × 寿命紧迫度（与 bestTask 返回 null 时完全相同，只是不白跑一遍任务池）
        const role = creep.memory && creep.memory.role;
        const bid = TASK_ROLES[role] ? bestTask(creep, tasksFor(creep)) : null;
        const score = bid ? bid.score : (ROLE_WEIGHT[creep.memory && creep.memory.role] || 0) * ttlUrgency(creep, 0);
        runtime.scores[creep.name] = Math.round(score * 100) / 100;
        return { creep, score, index };
    });
    scored.sort((left, right) => right.score - left.score || left.index - right.index);
    return scored.map((entry) => entry.creep);
}

function pickTask(creep, room, filter, claim) {
    if (!creep || !room) return null;
    beginTick();
    const tasks = runtime.tasks[room.name] || [];
    if (claim) {
        const leased = leasedTask(creep, tasks, filter);
        if (leased) return leased;
    }
    const candidate = bestTask(creep, tasks, filter);
    if (!candidate) return null;
    return claim ? leaseTask(creep, candidate) : candidate.task;
}

function metricFor(creep) {
    const room = creep.room && creep.room.name || creep.memory && creep.memory.home;
    if (!runtime.metrics[room]) runtime.metrics[room] = { backlog: 0, assigned: 0, idle: 0, deferred: 0, skippedCpu: 0, acted: 0 };
    return runtime.metrics[room];
}

function markSkipped(creep, reason) {
    const metric = metricFor(creep);
    if (reason === 'cpu') metric.skippedCpu++;
    else metric.idle++;
}

function shouldRun(creep) {
    const score = runtime.scores[creep.name] || 0;
    const role = creep.memory && creep.memory.role;
    if (['harvester', 'hauler', 'upgrader'].includes(role)) return true;
    return score >= 20;
}

function startCreep(creep) {
    beginTick();
    let movementCalls = 0;
    try {
        const movementStats = movement.stats();
        movementCalls = Number(movementStats && movementStats.calls) || 0;
    } catch (error) {
        movementCalls = 0;
    }
    const state = {
        x: creep.pos && creep.pos.x,
        y: creep.pos && creep.pos.y,
        roomName: creep.pos && creep.pos.roomName,
        energy: energyOf(creep.store),
    };
    // Screeps 的 action 在下一 tick 才结算：与上一 tick 开始时的状态比较才能看出 creep 是否真的做了事
    runtime.lastState = runtime.lastState || {};
    const previous = runtime.lastState[creep.name];
    const changedSinceLastTick = !!previous && previous.tick < Game.time &&
        (previous.x !== state.x || previous.y !== state.y || previous.roomName !== state.roomName || previous.energy !== state.energy);
    runtime.lastState[creep.name] = Object.assign({ tick: Game.time }, state);
    return Object.assign(state, {
        movementCalls,
        brokerTask: creep.memory && creep.memory.brokerTask ? creep.memory.brokerTask.id : null,
        changedSinceLastTick,
    });
}

/** 上一次执行以来位置与能量都没变（那一 tick 的动作什么也没改变）：停着等货/挂机的单位。
 *  lastState 由 startCreep 在执行开头记下；global 重置后没有记录，一律当作不空闲 */
function wasIdle(creep) {
    const previous = runtime.lastState && creep && runtime.lastState[creep.name];
    if (!previous || !creep.pos || !(previous.tick < Game.time)) return false;
    return previous.x === creep.pos.x && previous.y === creep.pos.y && previous.roomName === creep.pos.roomName &&
        previous.energy === energyOf(creep.store);
}

function finishCreep(creep, before) {
    const metric = metricFor(creep);
    const moved = before && (before.x !== creep.pos.x || before.y !== creep.pos.y || before.roomName !== creep.pos.roomName);
    const energyChanged = before && before.energy !== energyOf(creep.store);
    if (moved || energyChanged) {
        metric.acted++;
        return;
    }
    if (before && before.changedSinceLastTick) metric.acted++;
    const lease = creep.memory && creep.memory.brokerTask;
    if (before && lease && before.brokerTask === lease.id) {
        runtime.stuckTicks = runtime.stuckTicks || {};
        runtime.blocked = runtime.blocked || {};
        // 疲劳（没修路的沼泽上满载 2C:1M 一格要停近 10 tick）不是"目标不可达"：以前照样累计，6 tick 就把 spawn/ext/控制器容器
        // 屏蔽 150 tick，对所有 hauler 生效（基准 W33S7 (30,24)、W31S6 (17,15)、W35S7 (41,19) 等 extension 旁的沼泽格）
        const tired = Number(creep.fatigue) > 0;
        // 已在租约目标的动作射程内（在源容器旁等进账、在 spawn 旁等空位）也不是"不可达"：以前原地等 6 tick 就把这个源容器的
        // 取货任务屏蔽 150 tick，对所有 hauler 生效
        const leasedTarget = typeof Game.getObjectById === 'function' ? Game.getObjectById(String(lease.id).split(':')[0]) : null;
        const atTarget = !!(leasedTarget && distanceBetween(creep, leasedTarget) <= (ACTION_RANGE[lease.kind] || 1));
        const stuck = before.changedSinceLastTick || tired || atTarget ? 0 : (runtime.stuckTicks[creep.name] || 0) + 1;
        runtime.stuckTicks[creep.name] = stuck;
        if (stuck >= STUCK_TICKS) {
            runtime.blocked[lease.id] = Game.time + BLOCK_TICKS;
            delete creep.memory.brokerTask;
            runtime.stuckTicks[creep.name] = 0;
            metric.stuck = (metric.stuck || 0) + 1;
        }
    } else if (runtime.stuckTicks) {
        runtime.stuckTicks[creep.name] = 0;
    }
    let movementCalls = 0;
    try {
        const movementStats = movement.stats();
        movementCalls = Number(movementStats && movementStats.calls) || 0;
    } catch (error) {
        movementCalls = 0;
    }
    const movementIntent = before && movementCalls > (before.movementCalls || 0);
    const brokerIntent = before && before.brokerTask && creep.memory && creep.memory.brokerTask &&
        creep.memory.brokerTask.id === before.brokerTask;
    const role = creep.memory && creep.memory.role;
    const workTileIntent = ['harvester', 'upgrader'].includes(role) && activeParts(creep, constant('WORK', 'work')) > 0 &&
        typeof movement.isWorkTile === 'function' && movement.isWorkTile(creep, creep.pos);
    if (movementIntent || brokerIntent || workTileIntent) metric.deferred++;
    else metric.idle++;
}

function leaseTask(creep, candidate) {
    if (!candidate) return null;
    const task = candidate.task;
    // 换租：旧租约在 tick 开头已记成认领，不释放的话这一 tick 别人还当它被占着
    const previous = creep.memory && creep.memory.brokerTask;
    if (previous && previous.id && previous.id !== task.id) releaseClaim(previous.id, creep);
    claimTask(task, creep);
    const metric = metricFor(creep);
    metric.assigned++;
    creep.memory.brokerTask = { kind: task.kind, id: task.id, until: Game.time + LEASE_TICKS };
    return task;
}

function leasedTask(creep, tasks, filter) {
    const lease = creep.memory && creep.memory.brokerTask;
    if (!lease) return null;
    const drop = () => { releaseClaim(lease.id, creep); delete creep.memory.brokerTask; return null; };
    if (lease.until < Game.time) return drop();
    const task = (tasks || []).find((item) => item.id === lease.id && item.kind === lease.kind);
    if (!task) return drop();
    if (isBlocked(task)) return drop();
    // 任务仍在但不符合本次筛选（如 hauler 逐层竞价时先问高层）：保留租约，交给后续筛选
    if (filter && !filter(task)) return null;
    // 按量任务：排在前面的认领者已经把它填满/取空（或目标本身已满/已空），租约作废，不再往一个没货/没空位的目标走
    if (AMOUNT_KINDS[task.kind] && availableFor(task, creep) <= 0) return drop();
    if (!hasClaimCapacity(task, creep)) return null;
    claimTask(task, creep);
    // 投递/取货租约一路续期：在路上的 creep 不因 5 tick 到期被同层的别的目标抢走（到期重竞价会在两个目标之间来回掉头）；
    // 更高层的任务照样通过逐层竞价插队
    if (AMOUNT_KINDS[task.kind]) lease.until = Game.time + LEASE_TICKS;
    return task;
}

function runFallback(creep, room) {
    if (!creep || !room || !creep.memory || !['builder', 'upgrader'].includes(creep.memory.role)) return false;
    const state = Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].state;
    if (state && (state.recovering || state.emergencyHarvest)) return false;
    beginTick();
    const tasks = tasksFor(creep);
    const carrying = energyOf(creep.store) > 0;
    const filter = carrying ? (task) => task.kind === 'deliver' ||
        (task.kind === 'upgrade' && (!room.storage || energyOf(room.storage.store) > 30000)) :
        (task) => task.kind === 'harvest';
    const candidate = leasedTask(creep, tasks, filter) || leaseTask(creep, bestTask(creep, tasks, filter));
    if (!candidate) return false;
    if (candidate.kind === 'harvest') {
        if (creep.pos.isNearTo(candidate.target.pos || candidate.target)) creep.harvest(candidate.target);
        else movement.go(creep, candidate.target, { reusePath: 15 });
        return true;
    }
    if (candidate.kind === 'deliver') {
        if (creep.transfer(candidate.target, constant('RESOURCE_ENERGY', 'energy')) === constant('ERR_NOT_IN_RANGE', -9)) {
            movement.go(creep, candidate.target, { reusePath: 15 });
        }
        return true;
    }
    if (candidate.kind === 'collect') {
        if (candidate.target.store && creep.withdraw) {
            if (creep.withdraw(candidate.target, constant('RESOURCE_ENERGY', 'energy')) === constant('ERR_NOT_IN_RANGE', -9)) {
                movement.go(creep, candidate.target, { reusePath: 15 });
            }
        } else if (creep.pickup) {
            if (creep.pickup(candidate.target) === constant('ERR_NOT_IN_RANGE', -9)) {
                movement.go(creep, candidate.target, { reusePath: 15 });
            }
        }
        return true;
    }
    if (candidate.kind === 'upgrade') {
        if (creep.upgradeController(room.controller) === constant('ERR_NOT_IN_RANGE', -9)) {
            movement.go(creep, room.controller, { reusePath: 20 });
        }
        return true;
    }
    return false;
}

function flush() {
    if (Game.time % 30 !== 0 || typeof Memory === 'undefined') return;
    const rooms = {};
    for (const [name, metric] of Object.entries(runtime.metrics)) {
        rooms[name] = {
            backlog: Math.round(metric.backlog),
            assigned: metric.assigned,
            acted: metric.acted,
            idle: metric.idle,
            deferred: metric.deferred,
            skippedCpu: metric.skippedCpu,
            stuck: metric.stuck || 0,
        };
    }
    Memory.taskBroker = {
        v: 1,
        t: Game.time,
        cpu: typeof Game !== 'undefined' && Game.cpu && typeof Game.cpu.getUsed === 'function' ?
            Math.round(Game.cpu.getUsed() * 10) / 10 : null,
        rooms,
    };
    for (const metric of Object.values(runtime.metrics)) {
        metric.assigned = 0;
        metric.acted = 0;
        metric.idle = 0;
        metric.deferred = 0;
        metric.skippedCpu = 0;
        metric.stuck = 0;
    }
}

module.exports = { terminalFloorWant,
    forceReplan,
    controllerFeedLink,
    controllerFeedMode,
    controllerFeedStorage,
    beginTick,
    orderCreeps,
    shouldRun,
    markSkipped,
    startCreep,
    finishCreep,
    wasIdle,
    runFallback,
    pickTask,
    scoreTask,
    taskYield,
    taskSlots,
    roomTasks,
    pooledTasks,
    waitSpots,
    leaseSpot,
    holdClaim,
    availableFor,
    arrivalAmount,
    consume,
    setProjected,
    releaseClaim,
    flush,
    DELIVER_TIERS,
};
