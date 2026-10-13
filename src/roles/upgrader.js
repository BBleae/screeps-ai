'use strict';
/** 升级工：常驻 controller 旁，从脚下容器/相邻 link/storage 取能量持续升级。
 *  升级速率硬上限 15 能量/tick（CONTROLLER_MAX_UPGRADE_PER_TICK）。 */
const config = require('config');
const layout = require('layout');
const movement = require('movement');
const retire = require('retire');
const taskBroker = require('task_broker');
const utils = require('utils');
const { findCached, creepsHomeRole } = utils;

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const fallbackBudgetState = runtimeGlobal.__roleEnergyFallbackBudget ||
    (runtimeGlobal.__roleEnergyFallbackBudget = { tick: -1, rooms: {} });

function ctrlLink(room, plan) {
    const spot = layout.linkSpot(plan, 'ctrl');
    if (!spot) return null;
    const link = layout.structureAt(room, spot.x, spot.y, STRUCTURE_LINK);
    return link && link.my ? link : null;
}

function energySourceAt(room, creep, plan) {
    // 脚下/相邻容器 > 相邻 link > 相邻 storage，返回可抽取的来源
    const under = layout.structureAt(room, creep.pos.x, creep.pos.y, STRUCTURE_CONTAINER);
    if (under && under.store[RESOURCE_ENERGY] > 0) return under;
    const adjacent = findCached(room, FIND_STRUCTURES).find((s) => s.structureType === STRUCTURE_CONTAINER &&
        s.store[RESOURCE_ENERGY] > 0 &&
        Math.max(Math.abs(s.pos.x - creep.pos.x), Math.abs(s.pos.y - creep.pos.y)) <= 1);
    if (adjacent) return adjacent;
    // 相邻 link 先于 storage：以前一次 find 取"link 或 storage"里 find 顺序靠前的那个，贴着两者的升级者可能一直喝 storage，
    // ctrl link 永远满着 → links.run 不再发货 → 源 link 堆满 → 矿工溢出进源容器，hauler 被迫手搬本该 link 瞬移的 10/tick
    // （线上 2026-09-12 W31S6：升级者 42/48 采样贴着 ctrl link，link 从未被喝空；W31S5/W31S8 同形态，hauler 0–1% 空闲全在干 link 的活）
    const structures = findCached(room, FIND_STRUCTURES);
    const adjacentTo = (s) => Math.max(Math.abs(s.pos.x - creep.pos.x), Math.abs(s.pos.y - creep.pos.y)) <= 1;
    const link = structures.find((s) => s.my !== false && s.store && s.structureType === STRUCTURE_LINK &&
        s.store[RESOURCE_ENERGY] > 0 && adjacentTo(s));
    // storage 只取到 reserve 以上：缓冲留给 spawn 爆发补员和建造（config.upgrading.reserve）。相邻判定用显式距离（不依赖 findInRange）
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    const near = structures.find((s) => s.my !== false && s.store && s.structureType === STRUCTURE_STORAGE &&
        s.store[RESOURCE_ENERGY] > reserve && adjacentTo(s));
    if (link) {
        // 遥测（私服生效断言 upgrader.linkBeforeStorage）：两者都取得到时选了 link 的次数——旧代码在这里按 find 顺序可能选 storage
        if (near && typeof Memory !== 'undefined' && Memory.rooms) {
            const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
            const rec = mem.upgraderDrink || (mem.upgraderDrink = { linkOverStorage: 0 });
            rec.linkOverStorage = (Number(rec.linkOverStorage) || 0) + 1;
            rec.at = Game.time;
        }
        return link;
    }
    return near || null;
}

/** 从这个来源最多能取多少：storage 要给 reserve 留底，其它全部 */
function withdrawable(structure) {
    const energy = structure.store[RESOURCE_ENERGY] || 0;
    if (structure.structureType !== STRUCTURE_STORAGE) return energy;
    const reserve = Math.max(0, Number((config.upgrading || {}).reserve) || 0);
    return Math.max(0, energy - reserve);
}

/** 升级站位：定义在 layout.upgraderStation（与 movement 的工位判定共用），这里只把首选站点包成 RoomPosition */
/** 站位容器低于这个血量比例时升级者顺手修一 tick（config.upgraderRepairStationBelow，0 = 关闭） */
function repairStationBelow() {
    const value = Number(config.upgraderRepairStationBelow);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function ctrlStation(room, plan) {
    const station = layout.upgraderStation(room, plan);
    if (!station) return null;
    return Object.assign({}, station, { pos: new RoomPosition(station.pos.x, station.pos.y, room.name) });
}

function stationAnchorPos(station) {
    return station.anchor ? station.anchor.pos : station.pos;
}

function atStation(creep, station, ctrl) {
    return layout.atUpgraderStation(creep.pos, station, ctrl);
}

function goToStation(creep, station, ctrl) {
    const near = stationAnchorPos(station);
    // 已在锚点 1 格内但离 controller 太远（异常布局）：再向 controller 靠
    if (creep.pos.inRangeTo(near, 1)) { movement.go(creep, ctrl, { range: 3, reusePath: 30 }); return; }
    // 首选站点空闲则精确站上去（容器格/工作位/storage 站位按优先级取第一个没人的），否则任意锚点相邻格即可
    const spots = station.spots || [station.pos];
    for (const spot of spots) {
        const taken = (creep.room.lookForAt(LOOK_CREEPS, spot.x, spot.y) || [])
            .some((other) => other && other.name !== creep.name);
        if (taken) continue;
        movement.go(creep, new RoomPosition(spot.x, spot.y, creep.room.name), { range: 0, reusePath: 30 });
        return;
    }
    movement.go(creep, near, { range: 1, reusePath: 30 });
}

/** 站位格旁边现在能喝到的能量：storage（reserve 以上）+ 相邻 link/容器 */
function energyAroundSpot(room, spot) {
    let total = 0;
    const structures = findCached(room, FIND_STRUCTURES).filter((s) => s.store &&
        Math.max(Math.abs(s.pos.x - spot.x), Math.abs(s.pos.y - spot.y)) <= 1);
    for (const s of structures) {
        if (s.structureType === STRUCTURE_STORAGE) total += withdrawable(s);
        else if (s.structureType === STRUCTURE_LINK || s.structureType === STRUCTURE_CONTAINER) total += s.store[RESOURCE_ENERGY] || 0;
    }
    return total;
}

/** storage 站位里第一个"旁边有能量且没人站"的格（线上 2026-09-05 W33S7：storage 刚建成 1258 < reserve 2000，升级者站在 (31,27) 干等，
 *  而 (31,25) 同时贴着 storage 和 799 能量的 ctrl link） */
function spotWithEnergy(room, station, creep) {
    for (const spot of station.spots || []) {
        if (creep.pos.x === spot.x && creep.pos.y === spot.y) {
            if (energyAroundSpot(room, spot) > 0) return spot;
            continue;
        }
        const taken = (room.lookForAt(LOOK_CREEPS, spot.x, spot.y) || []).some((other) => other && other.name !== creep.name);
        if (taken) continue;
        if (energyAroundSpot(room, spot) > 0) return spot;
    }
    return null;
}

function hasActiveHauler(room) {
    return creepsHomeRole(room.name, 'hauler').some((creep) => !creep.spawning);
}

function reserveFor(room) {
    return Math.min(room.energyCapacityAvailable,
        config.recovery && config.recovery.emergencyHarvestBelow || 200);
}

function surplusEnergy(room) {
    if (fallbackBudgetState.tick !== Game.time) {
        fallbackBudgetState.tick = Game.time;
        fallbackBudgetState.rooms = {};
    }
    if (fallbackBudgetState.rooms[room.name] == null) {
        fallbackBudgetState.rooms[room.name] = Math.max(0, room.energyAvailable - reserveFor(room));
    }
    return fallbackBudgetState.rooms[room.name];
}

function takeSurplusEnergy(room, amount) {
    const available = surplusEnergy(room);
    const taken = Math.max(0, Math.min(available, amount));
    fallbackBudgetState.rooms[room.name] = available - taken;
    return taken;
}

/** storage 站位的补充：ctrl link 旁、控制器 3 格内的格子也能干活。站位格（贴 storage）里常常只有一格贴 link，
 *  被别人占着或 storage 取不出能量时，升级者就守着空站位干等——线上 2026-09-11 W33S7：builder 占着 (31,25)，
 *  升级者在 (32,26) 空手等 hauler（storage 0，永远等不到），2 格外的 ctrl link 有 749–798 能量，控制器少了约 3 成产出 */
function atLinkSide(room, plan, pos, ctrl) {
    const link = ctrlLink(room, plan);
    return !!link && Math.max(Math.abs(link.pos.x - pos.x), Math.abs(link.pos.y - pos.y)) <= 1 &&
        Math.max(Math.abs(ctrl.pos.x - pos.x), Math.abs(ctrl.pos.y - pos.y)) <= 3;
}

function linkSideSpot(room, plan, creep, ctrl) {
    const link = ctrlLink(room, plan);
    if (!link || !(Number(link.store[RESOURCE_ENERGY]) > 0)) return null;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const x = link.pos.x + dx;
            const y = link.pos.y + dy;
            if ((!dx && !dy) || x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (Math.max(Math.abs(ctrl.pos.x - x), Math.abs(ctrl.pos.y - y)) > 3) continue;
            if (utils.isWall(room, x, y) || utils.occupied(room, x, y)) continue;
            if ((room.lookForAt(LOOK_CREEPS, x, y) || []).some((other) => other && other.name !== creep.name)) continue;
            return { x, y };
        }
    }
    return null;
}

/** storage 站位全都不贴 ctrl link、而 ctrl link 堵在 linkKeepAt 以上（没人喝，源 link 按持有规则停发，源头产出只能靠 hauler 手搬——
 *  线上 W31S5/W31S8 的站位 0/55、2/48 采样贴着 ctrl link，W31S8 的 hauler 有 27–34% 的活是在搬 link 本该瞬移的 10/tick）：
 *  指定一只升级者（名字最小、在岗）空手时去 link 旁喝；link 喝空后它照常回 storage 站位（spotWithEnergy），link 再堵满再来 */
function linkReliefSpot(room, plan, station, creep, ctrl, mem) {
    const link = ctrlLink(room, plan);
    const keep = Math.max(0, Number(config.linkKeepAt) || 400);
    if (!link || !(Number(link.store[RESOURCE_ENERGY]) >= keep)) return null;
    const spots = station.spots || [station.pos];
    if (spots.some((spot) => Math.max(Math.abs(spot.x - link.pos.x), Math.abs(spot.y - link.pos.y)) <= 1)) return null;
    const crew = creepsHomeRole(room.name, 'upgrader').filter((other) => !other.spawning && !utils.isRetiring(other.memory))
        .map((other) => other.name).sort();
    if (crew[0] !== creep.name) return null;
    // 已经站在 link 旁：不再派位，交给下面的常规补能就地取。energySourceAt 里容器先于 link，
    // 走到这里说明身边能取的是容器——旧代码照样 movement.go 去 link 旁的空格（常常就是脚下这格），
    // 原地"移动"、从不 withdraw；它贴着控制器，卡住看门狗也抓不到，于是空手站到死（wip 768f2a1）
    if (atLinkSide(room, plan, creep.pos, ctrl)) {
        // 遥测（私服生效断言 upgrader.linkReliefInPlace）：旧代码在这里会继续派位
        if (mem) {
            const prev = mem.linkReliefInPlace || {};
            mem.linkReliefInPlace = { at: Game.time, first: prev.first != null ? prev.first : Game.time,
                n: (Number(prev.n) || 0) + 1, drank: Number(prev.drank) || 0 };
        }
        return null;
    }
    return linkSideSpot(room, plan, creep, ctrl);
}

function refillTarget(room, creep, plan, state) {
    // 容器（脚下或规划位）> link > spawn/ext
    if (plan.containers && plan.containers.ctrl) {
        const c = layout.structureAt(room, plan.containers.ctrl.x, plan.containers.ctrl.y, STRUCTURE_CONTAINER);
        if (c && c.store[RESOURCE_ENERGY] > 0) return { pos: new RoomPosition(c.pos.x, c.pos.y, room.name), target: c };
    }
    const l = ctrlLink(room, plan);
    if (l && l.store[RESOURCE_ENERGY] > 0) return { pos: new RoomPosition(l.pos.x, l.pos.y, room.name), target: l };
    if (state && state.recovering) return null;
    // spawn 在为队头攒能量时不从 spawn/ext 抽余量（与 builder.withdrawRoomSurplus 同一判据）
    if (utils.spawnWaitingFor(room)) return null;
    const any = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s) => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
            s.store[RESOURCE_ENERGY] > 0,
    });
    if (!any) return null;
    const amount = takeSurplusEnergy(room, Math.min(
        creep.store.getFreeCapacity(RESOURCE_ENERGY), any.store[RESOURCE_ENERGY]));
    return amount > 0 ? { pos: any.pos, target: any, amount } : null;
}

/** 升级限流：房间能量吃紧时控制器只吃本地供给的 incomeShare（utils.upgraderWorkCap），
 *  其余留给搬运/维修/建造。按**房间**总 WORK 算份额，多只升级者各分一份，用确定的相位错开（避免同 tick 一起停）。
 *  依据（线上 W33S7 2026-09-10，link 供能、2 源 = 20/tick）：W20C2M1 的升级者把本地收入 100% 吃光——storage 13、
 *  源容器 0/10/0、两只 hauler 空手挂机、builder 走 13 格刮 56 能量、24 个路工地 0 进度。 */
const DUTY_PERIOD = 10;
const dutyCache = { time: -1, rooms: {} };
function upgradeDuty(room, mem) {
    if (dutyCache.time !== Game.time) { dutyCache.time = Game.time; dutyCache.rooms = {}; }
    if (dutyCache.rooms[room.name] != null) return dutyCache.rooms[room.name];
    const cap = utils.upgraderWorkCap(room, mem);
    const work = utils.upgraderWork(room);
    const duty = (!isFinite(cap) || work <= 0 || work <= cap) ? 1 : Math.max(0, Math.min(1, cap / work));
    dutyCache.rooms[room.name] = duty;
    return duty;
}

/** 本 tick 是否轮到这只升级者干活：duty ≥ 1 恒真；否则按周期内的相位错开 */
function dutyActive(creep, room, mem) {
    const duty = upgradeDuty(room, mem);
    if (duty >= 1) return true;
    const active = Math.max(1, Math.round(duty * DUTY_PERIOD));
    if (active >= DUTY_PERIOD) return true;
    const name = String(creep.name || '');
    let phase = 0;
    for (let i = 0; i < name.length; i++) phase += name.charCodeAt(i);
    return (Game.time + phase) % DUTY_PERIOD < active;
}

/** 遥测（每 30 tick 一次）：本房升级预算与限流比例，线上排查"控制器吃光房间"时看这个 */
function reportBudget(room, mem, duty) {
    const track = mem.upgradeBudget || (mem.upgradeBudget = {});
    if (track.at && Game.time - track.at < 30) return;
    track.at = Game.time;
    track.supply = Math.round(utils.sourceSupply(room) * 100) / 100;
    track.work = utils.upgraderWork(room);
    const cap = utils.upgraderWorkCap(room, mem);
    track.cap = isFinite(cap) ? cap : null;
    track.duty = Math.round(duty * 1000) / 1000;
    track.storage = room.storage ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : null;
    track.low = !!utils.upgradeBudgetLow(room, mem);
    // 最近一次限流生效时的样本：竞争需求消失后限流会放开（utils.upgradeCompeting），末态看不到当时的份额
    if (track.cap != null) track.lastHeld = { at: Game.time, cap: track.cap, work: track.work, duty: track.duty };
}

/** 卡死看门狗（config.upgrading.stuckRepathTicks / stuckRetireTicks）：在母房、离控制器 > 3 格、没有疲劳却原地不动的升级者——
 *  先让移动库重算它自己的路径一次（只这一只，不动全房缓存），仍不动就退役（memory.stuckRetiring：编制计数 utils.isRetiring 立刻排除它、替补马上出），
 *  退役途中仍原地不动再等 stuckRetireTicks 就 suicide。线上 2026-10-08 W31S4：慧音甲 困在出生口袋 (25,15) 空手站了 600+ tick，
 *  占着唯一的升级者名额，控制器 0 进度。计时记在 creep.memory.upStuck {x, y, t}，动了 / 有疲劳 / 进了射程就清掉。
 *  遥测 Memory.rooms[母房].upgraderStuck：最近一次动作（repath / retire / suicide）与各自累计次数；连续退役无进度的退避
 *  （streak / mark / backoffUntil / backoffs / held，config.upgrading.stuckBackoffAfter/stuckBackoffTicks）。返回 true 表示本 tick 已接管 */
function noteStuck(mem, creep, action, range) {
    const log = mem.upgraderStuck || (mem.upgraderStuck = {});
    log.at = Game.time;
    log.name = creep.name;
    log.x = creep.pos.x;
    log.y = creep.pos.y;
    log.range = range;
    log.action = action;
    log[action] = (Number(log[action]) || 0) + 1;
}

/** 控制器进度标记：等级 + progress；RCL8 的 progress 恒为 0，另记绝对降级时间（升级会把它往后推，不升级时不变） */
function controllerMark(ctrl) {
    if (!ctrl) return null;
    const mark = { l: Number(ctrl.level) || 0, p: Number(ctrl.progress) || 0 };
    if (typeof ctrl.ticksToDowngrade === 'number') mark.d = Game.time + ctrl.ticksToDowngrade;
    return mark;
}

/** 退役时记连续"没进度"的次数：和上一次退役时的标记比，控制器有任何进度就从 1 重新数；够 stuckBackoffAfter 次进入退避 */
function noteRetireStreak(log, ctrl, settings) {
    const mark = controllerMark(ctrl);
    const prev = log.mark;
    const progressed = !prev || !mark || prev.l !== mark.l || prev.p !== mark.p ||
        (typeof prev.d === 'number' && typeof mark.d === 'number' && mark.d > prev.d + 1);
    log.streak = progressed ? 1 : (Number(log.streak) || 0) + 1;
    log.mark = mark;
    const after = Math.max(2, Number(settings.stuckBackoffAfter) || 3);
    if (log.streak >= after) {
        log.backoffUntil = Game.time + Math.max(1, Number(settings.stuckBackoffTicks) || 1500);
        log.backoffs = (Number(log.backoffs) || 0) + 1;
        log.backoffAt = Game.time;
    }
}

function stuckWatchdog(creep, room, mem) {
    const memory = creep.memory;
    const settings = config.upgrading || {};
    const repathTicks = Math.max(1, Number(settings.stuckRepathTicks) || 50);
    const retireTicks = Math.max(repathTicks + 1, Number(settings.stuckRetireTicks) || 300);
    const ctrl = room.controller;
    const range = ctrl && ctrl.pos && creep.pos.roomName === room.name
        ? Math.max(Math.abs(creep.pos.x - ctrl.pos.x), Math.abs(creep.pos.y - ctrl.pos.y)) : null;
    const track = memory.upStuck;
    const moved = !track || track.x !== creep.pos.x || track.y !== creep.pos.y;
    if (memory.stuckRetiring) {
        // 退役中：走向最近的 spawn 回收（贴着 spawn 当场回收）；退役后仍原地不动 stuckRetireTicks 就别再耗着
        if (moved || creep.fatigue > 0) memory.upStuck = { x: creep.pos.x, y: creep.pos.y, t: Game.time };
        else if (Game.time - Math.max(Number(track.t) || 0, Number(memory.stuckRetiring) || 0) >= retireTicks) {
            noteStuck(mem, creep, 'suicide', range);
            creep.suicide();
            return true;
        }
        retire.retireAtSpawn(creep);
        return true;
    }
    if (range == null || range <= 3 || creep.fatigue > 0) {
        if (track) delete memory.upStuck;
        return false;
    }
    if (moved) { memory.upStuck = { x: creep.pos.x, y: creep.pos.y, t: Game.time }; return false; }
    const stalled = Game.time - (Number(track.t) || Game.time);
    if (stalled >= retireTicks) {
        const log = mem.upgraderStuck || (mem.upgraderStuck = {});
        if (Number(log.backoffUntil) > Game.time) {
            // 退避中：控制器连续几次都够不着，退役只会换一只同样卡住的；留着它（继续按常规逻辑尝试），每只只记一次
            if (!track.held) {
                track.held = Game.time;
                log.held = (Number(log.held) || 0) + 1;
                log.heldAt = Game.time;
            }
            return false;
        }
        memory.stuckRetiring = Game.time;
        noteStuck(mem, creep, 'retire', range);
        noteRetireStreak(log, ctrl, settings);
        retire.retireAtSpawn(creep);
        return true;
    }
    if (stalled >= repathTicks && !track.repath) {
        // 先给一次机会：缓存路径过期（新建筑挡路）时重算就能走出来。只重置这一只的路径——过去调 invalidateRoom，
        // 全房缓存路径作废、当场重建 costMatrix，绕过 refreshRoomNetworks 的限频（同房 200 tick 一次、bucket < 1000 顺延）；
        // matrix 本身的新鲜度由路网签名那条路负责
        track.repath = Game.time;
        noteStuck(mem, creep, 'repath', range);
        movement.resetCreepPath(creep);
        mem.upgraderStuck.reset = (Number(mem.upgraderStuck.reset) || 0) + 1;
    }
    return false;
}

function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room) { movement.go(creep, new RoomPosition(25, 25, creep.memory.home)); return; }
    const plan = (Memory.rooms[room.name] || {}).plan || {};
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    if (stuckWatchdog(creep, room, mem)) return;
    const state = mem.state || {};
    const ctrl = room.controller;
    reportBudget(room, mem, upgradeDuty(room, mem));

    const station = ctrlStation(room, plan);
    if (creep.store[RESOURCE_ENERGY] > 0) {
        // 常驻站位：站在供能容器/工作位 1 格内即可（多个 upgrader 共用一个容器，不必抢同一格）；storage 站位时 ctrl link 旁也算
        if (station && !atStation(creep, station, ctrl) && !(station.storageFed && atLinkSide(room, plan, creep.pos, ctrl))) {
            goToStation(creep, station, ctrl);
            return;
        }
        // 注意：不要在 link 尚未建成时就往规划的 link 位挪。站位由 ctrlStation 按"已建成的 link > 容器"决定，
        // 规划位在 RCL5 之前只是一个坐标，追着它走会让容器旁的 upgrader 整场不升级
        // 同 tick 补能：withdraw 与 upgradeController 属不同管线，可同 tick 执行；仓内不足两轮 WORK 时就地补满，
        // 避免"用空→取能→再升级"每 100 能量丢 1 tick。取能量按开 tick 时的空余容量算（升级消耗在同 tick 结算）
        const work = creep.getActiveBodyparts(WORK);
        if (creep.store[RESOURCE_ENERGY] < work * 2) {
            const near = energySourceAt(room, creep, plan);
            const free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
            if (near && free > 0) creep.withdraw(near, RESOURCE_ENERGY, Math.min(free, withdrawable(near)));
        }
        // 站位容器顺手维修：升级者本来就站在它旁边、手里有能量，修 100 血只要 1 能量，而容器每 tick 衰减 10 血——
        // 每 110 tick 花 1 tick 就能保住它（约 1% 吞吐）。没有它就得为维修多养一只 builder，或者等容器烂掉重建（5000 能量 + 站位丢失）
        const stationContainer = station && !station.storageFed && station.container ? station.container : null;
        if (stationContainer && stationContainer.hits != null && stationContainer.hitsMax &&
            stationContainer.hits < stationContainer.hitsMax * repairStationBelow() &&
            creep.pos.inRangeTo(stationContainer, 3) && creep.repair(stationContainer) === OK) return;
        if (!dutyActive(creep, room, mem)) return;   // 能量吃紧：这 tick 不升级，把能量留给搬运/维修/建造
        const ret = creep.upgradeController(ctrl);
        if (ret === ERR_NOT_IN_RANGE) movement.go(creep, ctrl, { reusePath: 30 });
        return;
    }

    // 空载：就近补能（storage 只取到 reserve 以上）
    const near = energySourceAt(room, creep, plan);
    const relief = station && station.storageFed && !(near && near.structureType === STRUCTURE_LINK) ? linkReliefSpot(room, plan, station, creep, ctrl, mem) : null;
    if (relief) {
        // 遥测（私服生效断言 upgrader.linkRelief）：storage 站位够不着的 ctrl link 堵满时派去 link 旁喝
        mem.linkRelief = { at: Game.time, n: (Number(mem.linkRelief && mem.linkRelief.n) || 0) + 1, x: relief.x, y: relief.y };
        movement.go(creep, new RoomPosition(relief.x, relief.y, room.name), { range: 0, reusePath: 30 });
        return;
    }
    if (near) {
        const amount = Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), withdrawable(near));
        const ret = creep.withdraw(near, RESOURCE_ENERGY, amount);
        // 遥测（生效断言 upgrader.linkReliefInPlace 的结果面，2026-10-13 复审）：这一 tick 刚判了"已在 link 旁、不再派位"，就地真的取到了多少
        const inPlace = mem && mem.linkReliefInPlace;
        if (ret === OK && inPlace && inPlace.at === Game.time) inPlace.drank = (Number(inPlace.drank) || 0) + amount;
        return;
    }
    if (station && station.storageFed) {
        // storage 还在 reserve 以下（刚建成 / 被掏空）：换到旁边有能量（ctrl link / 容器）的站位格去喝，别守着空 storage 干等
        const spot = spotWithEnergy(room, station, creep);
        if (spot && !(creep.pos.x === spot.x && creep.pos.y === spot.y)) {
            movement.go(creep, new RoomPosition(spot.x, spot.y, room.name), { range: 0, reusePath: 30 });
            return;
        }
        // 站位格都喝不到（贴 link 的那格被占、storage 在 reserve 以下）：去 ctrl link 旁的空格
        const side = !spot && linkSideSpot(room, plan, creep, ctrl);
        if (side) {
            // 遥测：storage 站位喝不到时改去 ctrl link 旁（旧代码在这里守着空站位等 hauler）
            mem.upgraderLinkSide = { at: Game.time, n: (Number(mem.upgraderLinkSide && mem.upgraderLinkSide.n) || 0) + 1, x: side.x, y: side.y };
            movement.go(creep, new RoomPosition(side.x, side.y, room.name), { range: 0, reusePath: 30 });
            return;
        }
    }
    if (station && (station.container || station.storageFed) && hasActiveHauler(room)) {
        // 供能容器/storage 暂空但 hauler 在岗：原地等待。1 MOVE 的升级工徒步去 spawn 取 100 能量要往返上百 tick，远不如等下一趟运输
        if (!atStation(creep, station, ctrl)) goToStation(creep, station, ctrl);
        return;
    }
    const refill = refillTarget(room, creep, plan, state);
    if (refill) {
        if (creep.pos.isNearTo(refill.pos)) {
            if (refill.amount == null) creep.withdraw(refill.target, RESOURCE_ENERGY);
            else creep.withdraw(refill.target, RESOURCE_ENERGY, refill.amount);
        } else {
            movement.go(creep, refill.pos, { reusePath: 25 });
        }
        return;
    }
    if (taskBroker.runFallback(creep, room)) return;
    // 彻底没能量：贴着 controller 等
    if (!creep.pos.inRangeTo(ctrl, 2)) movement.go(creep, ctrl, { range: 2, reusePath: 30 });
}

module.exports = { run };
