'use strict';
/** 建造工：建工地 → 修破损 → 无事时升级（storage 富余才升，避免抢升级工的能量） */
const config = require('config');
const layout = require('layout');
const movement = require('movement');
const taskBroker = require('task_broker');
const { findCached, logErr, needsRepair, criticallyDamaged, energySurplus, creepsHomeRole, compareRepairTargets, isRetiring, spawnWaitingFor, siteWanted, conserving } = require('utils');

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const fallbackBudgetState = runtimeGlobal.__roleEnergyFallbackBudget ||
    (runtimeGlobal.__roleEnergyFallbackBudget = { tick: -1, rooms: {} });

function damagedStructure(room) {
    // 只修真正值得修的（rampart 按 RCL 目标封顶），按相对目标的血量比例从低到高
    const usable = findCached(room, FIND_STRUCTURES).filter((s) => needsRepair(room, s));
    return usable.length ? usable.sort((a, b) => compareRepairTargets(room, a, b))[0] : null;
}

/** 危急结构（utils.criticallyDamaged：容器/道路烂到 0 就消失，重建 300–5000 能量）：每 tick 每房只扫一次。
 *  有工地在建时 builder 永远在建造，普通维修轮不到它——只有"会消失的"才插队到建造之前。
 *  线上 2026-09-09 W33S7：60 条路全在衰减（16 条 < 500 血）、40 个工地没完，塔停在储备线上一次也修不动，
 *  于是道路只能靠衰减到 0 再从工地重建（300–1500 能量），而维修 100 血只要 1 能量。 */
const criticalCache = { time: -1, rooms: {} };
function criticalList(room) {
    if (criticalCache.time !== Game.time) { criticalCache.time = Game.time; criticalCache.rooms = {}; }
    if (criticalCache.rooms[room.name] !== undefined) return criticalCache.rooms[room.name];
    const list = findCached(room, FIND_STRUCTURES).filter((s) => criticallyDamaged(room, s));
    criticalCache.rooms[room.name] = list;
    return list;
}

/** 控制器/仓库 link 能借给 builder 的余量：低于 linkKeepAt + 这个数就不动它（那是升级者的缓冲）。
 *  一车 250 能量 = 升级者 25 tick 的量，留 250 的余量意味着借完还有 25 tick 缓冲，源 link 会在这期间补上。 */
function linkDrawMargin() {
    return Math.max(100, Number(config.linkDrawMargin) || 250);
}

/** builder 的取能点（按路径距离取**最近**的一个）。旧写法是"先容器、容器都没有才 storage、再 spawn/ext"——
 *  顺序与距离无关：线上 W33S7 的 builder 走 20 格去源容器取 170 能量，而身边的 storage 有 276、控制器 link 有 799。
 *  时间才是 builder 的瓶颈（6 WORK 建 30 进度/tick，一车 176 能量只要 6 tick 就建完，来回 40 格白扔 40 tick）。
 *  候选：
 *   - 非控制器容器 ≥50（控制器容器要 ≥ ctrlShare 满，缓冲留给升级者）
 *   - storage ≥50（reserve 只约束升级者，builder 拿的是仓里闲置的部分）
 *   - 控制器 link / 仓库 link ≥ linkKeepAt + linkDrawMargin：RCL6 没有 store link 时升级者吃不满的源收入
 *     全堵在 link 里（线上 W33S7 三座 link 常年 800/800），那部分能量只有升级者能用，而升级者只要 10/tick */
/** spawn 队头正在攒能量、而现有能量不够（utils.spawnWaitingFor）：这时 builder 不跟 spawn 抢能量。
 *  线上 2026-09-11 W33S7：队头 core:builder:1（1350）等了 400–670 tick、挡住 hauler 与外矿换代，
 *  同一时间 builder 从 ctrl link、源容器和 spawn/ext 余量取能去建 terminal——spawn 攒不起来，ETA 永远兑现不了。
 *  饥饿时 builder 只拿 storage 里 spawn 缺口以外的部分、已经溢出的源容器，以及 hauler 投递。 */
function spawnHungry(room) {
    const hungry = spawnWaitingFor(room);
    if (hungry) {
        // 遥测：builder 为 spawn 让路的 tick 数（每 tick 每房记一次）
        const mem = Memory.rooms[room.name];
        if (mem && (!mem.builderHunger || mem.builderHunger.at !== Game.time)) {
            mem.builderHunger = { at: Game.time, n: (Number(mem.builderHunger && mem.builderHunger.n) || 0) + 1 };
        }
    }
    return hungry;
}

function spawnShortfall(room) {
    const waiting = (Memory.rooms[room.name] || {}).spawnWaiting;
    return waiting && waiting.cost > 0 ? Math.max(0, waiting.cost - room.energyAvailable) : 0;
}

function energySourceFor(creep, room, ctrlShare) {
    const linkKeep = Math.max(0, Number(config.linkKeepAt) || 0) + linkDrawMargin();
    const hungry = spawnHungry(room);
    const shortfall = hungry ? spawnShortfall(room) : 0;
    // 源容器"溢出"线：hauler 跟不上时容器会涨过它，那部分 builder 拿走不影响 spawn 的补给
    const overflowAt = Math.max(0, Number((config.hauling || {}).sourceLinkOverflow) || 1500);
    const candidates = findCached(room, FIND_STRUCTURES).filter((s) => {
        if (!s || !s.store || s.my === false) return false;
        const energy = Number(s.store[RESOURCE_ENERGY] || 0);
        if (energy < 50) return false;
        if (s.structureType === STRUCTURE_CONTAINER) {
            if (isControllerContainer(room, s)) return energy >= s.store.getCapacity(RESOURCE_ENERGY) * ctrlShare;
            return !hungry || energy >= overflowAt;
        }
        if (s.structureType === STRUCTURE_STORAGE) return !hungry || energy - shortfall >= 50;
        if (s.structureType === STRUCTURE_LINK) {
            if (hungry) return false;
            // 只借收货端的 link（ctrl / store），不动源 link——那是链路的发送端，抽它等于掐断升级者的供给
            const plan = (Memory.rooms[room.name] || {}).plan;
            if (!plan || !plan.links) return false;
            const spot = layout.linkSpot(plan, 'ctrl') || {};
            const storeSpot = layout.linkSpot(plan, 'store') || {};
            const isReceiver = (s.pos.x === spot.x && s.pos.y === spot.y) || (s.pos.x === storeSpot.x && s.pos.y === storeSpot.y);
            return isReceiver && energy >= linkKeep;
        }
        return false;
    });
    return creep.pos.findClosestByPath(candidates) || null;
}

/** controller 供能容器（规划位；无规划时以贴近 controller 且不贴 source 判断）——builder 不得抽取 */
function isControllerContainer(room, structure) {
    if (!structure || structure.structureType !== STRUCTURE_CONTAINER) return false;
    const plan = (Memory.rooms[room.name] || {}).plan;
    const planned = plan && plan.containers && plan.containers.ctrl;
    if (planned) return structure.pos.x === planned.x && structure.pos.y === planned.y;
    if (!room.controller || !structure.pos.inRangeTo(room.controller.pos, 2)) return false;
    return !findCached(room, FIND_SOURCES).some((source) =>
        Math.max(Math.abs(source.pos.x - structure.pos.x), Math.abs(source.pos.y - structure.pos.y)) <= 1);
}

/** 危急结构里挑这只 builder 该去修的：**先修伸手就够得着的**，再去全局最危急的那一个。
 *  只看全局比例会让两只都在危急线附近的结构把 builder 来回拽——一次维修只花 1–2 tick、走开再回来要 20+ tick，
 *  而修一 tick 后排名就翻转（线上 W33S7 2026-09-10：swamp 路 (31,25) 19.6% 与矿物容器 (19,40) 19.0% 相距 20 格，
 *  builder 一直在路上）。自我收敛：修到危急线以上它就不再是危急结构，下一 tick 自然重新评估，
 *  所以"就近先修"不会把更危急的远处目标永久饿死。 */
function criticalNear(creep, room) {
    const list = criticalList(room);
    if (!list.length) return null;
    let here = null;
    for (const structure of list) {
        if (!creep.pos.inRangeTo(structure.pos, 3)) continue;
        if (!here || compareRepairTargets(room, structure, here) < 0) here = structure;
    }
    if (here) return here;
    return list.slice().sort((a, b) => compareRepairTargets(room, a, b))[0];
}

/** 危急结构开修之后接着修（滞回）：修到普通维修线 towerRepairBelow（或手里能量用完）才回去建造。
 *  以前修到危急线（criticalRepairShare 20%）以上一点就走，衰减几百 tick 又跌回来——线上 W33S7 方案内道路 54/89 条停在 20–30%
 *  （9 条贴着 20–21.6%）、W33S8 49/80 条，builder 在工地和同一批路之间来回拉扯，每次只修 1–2 tick、往返 20+ tick。
 *  目标记在 creep.memory.repairId；遥测 Memory.rooms[房].builderRepairHold（危急线以上仍接着修的 tick 数） */
function repairHold(creep, room) {
    const id = creep.memory.repairId;
    if (!id) return null;
    const target = Game.getObjectById(id);
    const line = Number(config.towerRepairBelow) || 0.6;
    if (!target || !target.pos || target.pos.roomName !== room.name || target.structureType === STRUCTURE_RAMPART ||
        target.structureType === STRUCTURE_WALL || !(target.hits < target.hitsMax * line)) {
        delete creep.memory.repairId;
        return null;
    }
    if (!criticallyDamaged(room, target)) {
        const mem = Memory.rooms[room.name];
        if (mem && (!mem.builderRepairHold || mem.builderRepairHold.at !== Game.time)) {
            mem.builderRepairHold = { at: Game.time, n: (Number(mem.builderRepairHold && mem.builderRepairHold.n) || 0) + 1, id: target.id };
        }
    }
    return target;
}

function samePosition(left, right) {
    return !!left && !!right && left.x === right.x && left.y === right.y;
}

/** 工地优先级（与 task_broker 的建造权重一致）：塔（替换旧塔后的无塔窗口要短）> 源/控制器容器 > 无 storage 时的 storage 工地
 *  > 道路（路网决定运力，用户要求道路优先）> 其它结构（extension…按剩余进度小的先）> rampart/墙 */
function sitePriority(room, site) {
    const plan = (Memory.rooms[room.name] || {}).plan || {};
    const containers = plan.containers || {};
    // spawn 永远最先：没有 spawn 什么都孵不出来（2026-09-06 用户指令；线上新房 W31S6/W31S8 的 builder 在修 24 条路，spawn 工地排在默认档）
    if (site.structureType === STRUCTURE_SPAWN) return -1;
    // 容量还小（<550，RCL3 没建够 extension）时 5000 的塔会把所有 extension 卡在后面：先扩容再建塔
    if (site.structureType === STRUCTURE_TOWER) return room.energyCapacityAvailable >= 550 ? 0 : 10;
    if (site.structureType === STRUCTURE_CONTAINER) {
        if (samePosition(site.pos, containers.src0) || samePosition(site.pos, containers.src1)) return 1;
        if (samePosition(site.pos, containers.ctrl)) return 2;
        return 3;
    }
    // link 排在源容器之后、控制器容器/道路/extension 之前：基准 W34S7 的四个 link 工地放出后 0/5000 躺了 5k tick，builder 一直在做有进度的 ext
    if (site.structureType === STRUCTURE_LINK) return 1.5;
    // 容量 <550（RCL2 的 5 个 extension 还没建）时 extension 排在道路前：容量翻倍所有身体才翻倍，
    // 线上 W35S7 两只 1 WORK 的 builder 在远角修路，5 个 extension 工地 0 进度 4000 tick
    if (site.structureType === STRUCTURE_EXTENSION && room.energyCapacityAvailable < 550) return 4;
    // 没有 storage 的房：storage 工地排在道路前（config.construction.storageBeforeRoads）
    if (site.structureType === STRUCTURE_STORAGE && !room.storage && (config.construction || {}).storageBeforeRoads !== false) return 4.5;
    if (site.structureType === STRUCTURE_ROAD) return 5;
    if (site.structureType === STRUCTURE_RAMPART || site.structureType === STRUCTURE_WALL) return 20;
    return 10;
}

function nextSite(room) {
    // 没过经济门槛的奢侈工地（terminal/lab…，utils.siteWanted）不建：能量先攒进 storage
    return findCached(room, FIND_MY_CONSTRUCTION_SITES).filter((site) => siteWanted(room, site)).sort((left, right) => {
        const priority = sitePriority(room, left) - sitePriority(room, right);
        if (priority !== 0) return priority;
        return (left.progressTotal - left.progress) - (right.progressTotal - right.progress);
    })[0];
}

function withdrawRoomSurplus(creep, room, state) {
    if (state.recovering) return false;
    // spawn 在为队头攒能量：余量正是它要攒的那笔，不能拿走（见 spawnHungry）
    if (spawnHungry(room)) return false;
    if (fallbackBudgetState.tick !== Game.time) {
        fallbackBudgetState.tick = Game.time;
        fallbackBudgetState.rooms = {};
    }
    if (fallbackBudgetState.rooms[room.name] == null) {
        const reserve = Math.min(room.energyCapacityAvailable,
            config.recovery && config.recovery.emergencyHarvestBelow || 200);
        fallbackBudgetState.rooms[room.name] = Math.max(0, room.energyAvailable - reserve);
    }
    const amount = Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), fallbackBudgetState.rooms[room.name]);
    if (amount <= 0) return false;
    const source = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (structure) => (structure.structureType === STRUCTURE_SPAWN ||
            structure.structureType === STRUCTURE_EXTENSION) && structure.store[RESOURCE_ENERGY] > 0,
    });
    if (!source) return false;
    const withdrawal = Math.min(amount, source.store[RESOURCE_ENERGY]);
    fallbackBudgetState.rooms[room.name] -= withdrawal;
    const result = creep.withdraw(source, RESOURCE_ENERGY,
        withdrawal);
    if (result === ERR_NOT_IN_RANGE) movement.go(creep, source, { reusePath: 15 });
    return result === OK || result === ERR_NOT_IN_RANGE;
}

function harvestForSite(creep, room, site) {
    if (!site || !creep.body.some((part) => part.type === WORK && part.hits !== 0)) return false;
    const sources = room.find(FIND_SOURCES).slice().sort((left, right) => {
        const leftFromCreep = Math.max(Math.abs(left.pos.x - creep.pos.x), Math.abs(left.pos.y - creep.pos.y));
        const rightFromCreep = Math.max(Math.abs(right.pos.x - creep.pos.x), Math.abs(right.pos.y - creep.pos.y));
        if (leftFromCreep !== rightFromCreep) return leftFromCreep - rightFromCreep;
        const leftFromSite = Math.max(Math.abs(left.pos.x - site.pos.x), Math.abs(left.pos.y - site.pos.y));
        const rightFromSite = Math.max(Math.abs(right.pos.x - site.pos.x), Math.abs(right.pos.y - site.pos.y));
        return leftFromSite - rightFromSite;
    });
    const source = sources.find((candidate) => candidate.energy > 0) || sources[0];
    if (!source) return false;
    if (creep.pos.isNearTo(source.pos)) creep.harvest(source);
    else movement.go(creep, source, { reusePath: 15 });
    return true;
}

function hasHauler(room) {
    return creepsHomeRole(room.name, 'hauler').length > 0;
}

/** 遥测：本房 builder 的取能节奏。wait = 在工地原地等投递的 tick；self = "本来会等"的条件全成立、
 *  但没有任何 hauler 会来的 tick（旧代码在这些 tick 白等）。线上 W33S7 2026-09-10：两只 hauler 都空着手，
 *  builder 空等 30 tick 再走 13 格去源容器刮 56 能量。 */
function noteFeed(room, key) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    if (!mem) return;
    const track = mem.builderFeed || (mem.builderFeed = { at: 0, wait: 0, self: 0 });
    track.at = Game.time;
    track[key] = (Number(track[key]) || 0) + 1;
}

/** 会不会真有人来投递：光"房里有 hauler"不够——空着手的 hauler 只会让 builder 白等。
 *  线上 W33S7 2026-09-10：两只 hauler 都是 0 能量、没有任务，builder 在工地空等 30 tick（feedAt 到期才走），
 *  然后自己走 13 格去源容器刮 56 能量再走回来。判据：已经有 hauler 认领了"送我这单"（brokerTask.id = builder.id），
 *  或者房里有装着能量、手上没别的活的 hauler（broker 的工地补能是第 2 层，压过回库第 4 层，下一 tick 就会派给它）。 */
function haulerIncoming(creep, room) {
    for (const hauler of creepsHomeRole(room.name, 'hauler')) {
        if (hauler.spawning) continue;
        if (isRetiring(hauler.memory)) continue;   // 走向 spawn 回收中的旧 hauler 不会来投递
        const lease = hauler.memory && hauler.memory.brokerTask;
        if (lease && lease.kind === 'deliver' && lease.id === creep.id) return true;
        if (lease) continue;
        if (hauler.store && Number(hauler.store[RESOURCE_ENERGY] || 0) > 0) return true;
    }
    return false;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home)); return; }
    const state = (Memory.rooms[room.name] || {}).state || {};
    // 10-16 节能模式：不建（含 lab 工地）不修；手里的能量先补 spawn/extension，再交回 storage，然后在 storage 旁待命
    if (conserving(room)) {
        if (creep.store[RESOURCE_ENERGY] > 0) {
            const fill = room.energyAvailable < room.energyCapacityAvailable
                ? creep.pos.findClosestByRange(findCached(room, FIND_MY_STRUCTURES).filter((s) =>
                    (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0))
                : null;
            const dest = fill || room.storage;
            if (dest && creep.transfer(dest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) movement.go(creep, dest, { reusePath: 15 });
        } else if (room.storage && !creep.pos.inRangeTo(room.storage, 3)) {
            movement.go(creep, room.storage, { range: 3, reusePath: 30 });
        }
        return;
    }

    const hasLoad = creep.store[RESOURCE_ENERGY] > 0;
    if (hasLoad && creep.memory.waitSince) delete creep.memory.waitSince;
    const site = nextSite(room);

    // 危急结构（会消失的容器/道路）优先于建造：一次维修 100 血/能量，重建一条路要 300–1500 能量；开修后修到普通维修线（repairHold）
    if (hasLoad) {
        const critical = repairHold(creep, room) || criticalNear(creep, room);
        if (critical) {
            creep.memory.repairId = critical.id;
            if (creep.repair(critical) === ERR_NOT_IN_RANGE) movement.go(creep, critical, { reusePath: 15 });
            return;
        }
    } else if (creep.memory.repairId) {
        delete creep.memory.repairId;   // 能量用完：这一轮到此为止，下一车重新挑（修到 20% 以上的就不再插队）
    }

    if (hasLoad && site) {
        const ret = creep.build(site);
        if (ret === ERR_NOT_IN_RANGE) movement.go(creep, site, { reusePath: 15 });
        else {
            // 在工地上干活：登记位置，hauler 会把能量直接送到手上（远离容器的工地靠自己往返效率只有 1–2 能量/tick）
            creep.memory.feedAt = Game.time;
            creep.memory.siteId = site.id;
        }
        return;
    }
    // 刚在工地上用完能量：房里有 hauler 就原地等投递，不要空着跑回容器（总等待有上限，hauler 一直被 spawn/ext 占着时不能永远等）
    const waitedTooLong = Game.time - Number(creep.memory.waitSince || Game.time) > (config.builderFeedMaxWait || 50);
    // 房里有闲置能量（容器快满 / 地上成堆）时不等投递：自己去取比让 11 个 WORK 干等划算
    const surplus = !room.storage && energySurplus(room);
    // 取能点就在几格内时也不等：等 50 tick 投递，不如自己走 5 格去取（线上 W33S7 的 builder 在工地上空等 50 tick，
    // 而 5 格外的 storage / 控制器 link 里有能量；等投递只在"取能要走十几格"时才划算）
    const ctrlShare = Number(config.energySurplus && config.energySurplus.ctrlShare) || 0.75;
    const nearSource = hasLoad ? null : energySourceFor(creep, room, ctrlShare);
    const selfFetch = !!nearSource && Math.max(
        Math.abs(nearSource.pos.x - creep.pos.x), Math.abs(nearSource.pos.y - creep.pos.y)) <= (config.builderSelfFetchRange || 8);
    if (!hasLoad && site && !waitedTooLong && !surplus && !selfFetch &&
        Game.time - (creep.memory.feedAt || -1e9) <= (config.builderFeedWait || 30) &&
        creep.pos.inRangeTo(site.pos, 3)) {
        if (haulerIncoming(creep, room)) {
            if (!creep.memory.waitSince) creep.memory.waitSince = Game.time;
            noteFeed(room, 'wait');
            return;
        }
        // 会等的条件全成立，只是没有任何 hauler 会来：记一笔（旧代码在这里白等 30 tick），下面自己去取
        noteFeed(room, 'self');
    }
    if (hasLoad && !site) {
        const broken = damagedStructure(room);
        if (broken) {
            if (creep.repair(broken) === ERR_NOT_IN_RANGE) movement.go(creep, broken, { reusePath: 15 });
            return;
        }
        // 没工地没破损：storage 富余才帮忙升级
        const st = room.storage;
        if (st && st.my && st.store[RESOURCE_ENERGY] > config.builderUpgradeAbove) {
            if (creep.upgradeController(room.controller) === ERR_NOT_IN_RANGE) movement.go(creep, room.controller, { reusePath: 20 });
            return;
        }
    }
    // 补能
    if (!hasLoad || (site && creep.store.getFreeCapacity() > 0 && !room.storage)) {
        // 没 storage 的房 spawn/ext 还没满且有 hauler 在岗：builder 不去源容器抢 hauler 要运给 spawn 的能量
        // （W34S7 RCL3：3 个 builder 把源容器掏空，hauler 全空、spawn 停在 300/400 孵不出 harvester）；去工地等 hauler 投递
        // spawn/ext 未满时让路等投递（W34S7 RCL3 曾被 3 只 builder 掏空源容器）；房里有闲置能量时不等，builder 自己去取
        // （线上 W33S8 spawn 350/400、远处源容器 1952/2000 时 builder 干等 146 tick）
        const spawnFirst = !room.storage && room.energyCapacityAvailable < (config.builderSpawnFirstBelow || 800) &&
            room.energyAvailable < room.energyCapacityAvailable && hasHauler(room) && !waitedTooLong && !surplus;
        // 可取的来源：energySourceFor 按路径距离取最近的一个（容器/storage/收货 link），没得取才用 spawn/ext 余量
        const pile = spawnFirst ? null : creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
            filter: (r) => r.resourceType === RESOURCE_ENERGY && r.amount >= 100,
        });
        const src = spawnFirst ? null : nearSource;
        const range = (target) => Math.max(Math.abs(target.pos.x - creep.pos.x), Math.abs(target.pos.y - creep.pos.y));
        if (pile && (!src || range(pile) <= range(src))) {
            if (creep.pickup(pile) === ERR_NOT_IN_RANGE) movement.go(creep, pile, { reusePath: 15 });
            return;
        }
        if (src) {
            // 遥测：本房 builder 最近的取能点（类型+位置）+ 最近 4 次的历史。诊断"路为什么建得慢"时要看它是不是在跑远路。
            // 只在取能点**变了**的时候记一笔：走向取能点的路上每 tick 都会走到这里，每次都记会让环形缓冲只剩同一条
            // （私服维护房有两只 builder 时，远处那只一次往返就把近处那只的 storage 记录冲掉了）
            const roomMemory = Memory.rooms && (Memory.rooms[room.name] || (Memory.rooms[room.name] = {}));
            if (roomMemory) {
                const entry = { at: Game.time, type: src.structureType, x: src.pos.x, y: src.pos.y };
                const log = roomMemory.builderSourceLog || (roomMemory.builderSourceLog = []);
                const last = log[log.length - 1];
                if (!last || last.type !== entry.type || last.x !== entry.x || last.y !== entry.y) {
                    log.push(entry);
                    if (log.length > 4) log.shift();
                }
                roomMemory.builderSource = entry;
                // 本房 builder 的**第一个**取能点：诊断"取能点规则选错"时最直接的证据
                // （环形历史会被后来的取能点顶掉，长跑之后看不到开局那一次）
                if (!roomMemory.builderSourceFirst) roomMemory.builderSourceFirst = entry;
            }
            const ret = creep.withdraw(src, RESOURCE_ENERGY);
            if (ret === ERR_NOT_IN_RANGE) movement.go(creep, src, { reusePath: 15 });
            return;
        }
        if (spawnFirst && site) {
            if (!creep.memory.waitSince) creep.memory.waitSince = Game.time;
            if (!creep.pos.inRangeTo(site.pos, 3)) movement.go(creep, site, { reusePath: 15 });
            else creep.memory.feedAt = Game.time;
            creep.memory.siteId = site.id;
            return;
        }
        if (!spawnFirst && withdrawRoomSurplus(creep, room, state)) return;
        if (harvestForSite(creep, room, site)) return;
    }
    if (site && hasLoad) {
        if (creep.build(site) === ERR_NOT_IN_RANGE) movement.go(creep, site, { reusePath: 15 });
        return;
    }
    if (taskBroker.runFallback(creep, room)) return;
    // 闲时靠 storage/spawn
    const anchor = room.storage || room.find(FIND_MY_SPAWNS)[0];
    if (anchor && !creep.pos.inRangeTo(anchor.pos, 3)) movement.go(creep, anchor.pos, { range: 3, reusePath: 20 });
}

module.exports = { run, nextSite };
