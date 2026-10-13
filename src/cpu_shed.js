'use strict';
/**
 * bucket 吃紧时的 creep 降载（main.js 的 creep 循环调用）。
 *
 * 旧护栏（bucket 健康时照旧使用）：creep 循环超过 limit − cpuReserve 后只跳 broker 分数 < 20 的单位，而 harvester/hauler/upgrader
 * 一律照跑、其余角色分数几乎都 ≥ 20——线上 2026-10-08 cpuBy 合计 145–166 > limit 150 时 skippedCpu 全房 0，bucket 一路掉向 0，
 * 也没有任何东西看 Game.cpu.bucket。归零后每个超 limit 的 tick 被引擎整个掐断（movement.endTick 都不跑）。
 *
 * 降载模式（bucket < config.cpuShed.lowBucket / criticalBucket，或 Memory.cpuShedForce 手动强制）：
 *  - creep 循环上限压到 limit − lowReserve / criticalReserve，整 tick 落在 limit 以内，bucket 回涨；
 *  - 超上限后只跳"跳一 tick 也安全"的单位，按价值从低到高：scout、预定富余的 reserver → 空闲的搬运/建造单位、operator、
 *    矿物矿工 → （仅紧急）空车外矿运输工、在路上的 reserver；
 *  - 永不跳：本房源矿工（harvester）、upgrader、remoteMiner、防御/攻城/占领单位、每个房最后一只能跑的 hauler；
 *  - 同一只 creep 最多连续跳 maxConsecutive tick。
 * 被跳的 creep 这一 tick 不发任何动作，和旧护栏的跳过同一条路（markSkipped 'cpu'），不丢已发出的意图。
 *
 * tickLimit 硬停（所有模式都生效）：上面的上限只看 limit，从不看 Game.cpu.tickLimit。bucket≈0 时 tickLimit == limit，
 * 永不跳的单位照跑也能把 tick 推过 tickLimit——引擎会把整个 tick 掐掉（所有已发出的意图一起作废，movement.endTick 也不跑）。
 * 所以 getUsed 一旦超过 tickLimit − endReserve（循环之后的 move.end + flush + Memory 序列化）就不再跑任何 creep（永不跳的也停），
 * 收尾照常。永不跳的单位排在队列前面，硬停只砍尾巴。离硬停线还远（> hardStopArm）时不逐只读 getUsed，健康 bucket 下零开销。
 */
const config = require('config');
const utils = require('utils');
const taskBroker = require('task_broker');

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__cpuShedRuntime || (runtimeGlobal.__cpuShedRuntime = {
    streak: {},
    win: null,
});

function settings() {
    return config.cpuShed || {};
}

function emptyWindow() {
    return { ticks: 0, low: 0, crit: 0, forced: 0, skip: 0, roles: {}, hard: 0, cut: 0, hardEnd: 0 };
}

/** 硬停线 = tickLimit − endReserve；Memory.cpuShedForce.stop 在 stopUntil 之前覆盖它（私服验证：私服的 tickLimit 是整个 bucket，碰不到）。
 *  没有 tickLimit（模拟器/老私服/单测）返回 null = 不硬停 */
function hardStopLine(cpu, force, time) {
    if (force && Number(force.stopUntil) > time && force.stop !== null && force.stop !== undefined && Number.isFinite(Number(force.stop))) return Number(force.stop);
    const tickLimit = cpu && cpu.tickLimit;
    if (typeof tickLimit !== 'number' || !Number.isFinite(tickLimit)) return null;
    return tickLimit - (Number(settings().endReserve) || 0);
}

/** 本 tick 的模式：normal / low / critical。Memory.cpuShedForce = {mode, cap?, until} 在 until 之前强制（控制台预先降载、私服验证） */
function modeFor(cpu, force, time) {
    const cfg = settings();
    if (force && Number(force.until) > time && (force.mode === 'low' || force.mode === 'critical')) return force.mode;
    const bucket = cpu && cpu.bucket;
    if (typeof bucket !== 'number') return 'normal';   // 模拟器/老私服没有 bucket
    if (bucket < Number(cfg.criticalBucket)) return 'critical';
    if (bucket < Number(cfg.lowBucket)) return 'low';
    return 'normal';
}

function creepCap(cpu, mode, force, time) {
    const cfg = settings();
    const limit = Number(cpu && cpu.limit) || 0;
    if (mode === 'normal') return limit - (Number(config.cpuReserve) || 0);
    if (force && Number(force.until) > time && Number.isFinite(Number(force.cap)) && force.cap !== null) return Number(force.cap);
    return limit - (Number(mode === 'critical' ? cfg.criticalReserve : cfg.lowReserve) || 0);
}

/** tick 开头调用：模式、creep 循环上限，降载时再备好每房可跑 hauler 的计数 */
function begin() {
    const cpu = typeof Game !== 'undefined' ? Game.cpu : null;
    const force = typeof Memory !== 'undefined' && Memory ? Memory.cpuShedForce : null;
    const forced = !!(force && Number(force.until) > Game.time);
    if (force && !forced && typeof Memory !== 'undefined') delete Memory.cpuShedForce;   // 过期即清
    const mode = modeFor(cpu, forced ? force : null, Game.time);
    const ctx = { mode, active: mode !== 'normal', cap: creepCap(cpu, mode, forced ? force : null, Game.time), rank: {}, haulers: {} };
    // 硬停：离线还远就不逐只读 getUsed（armed=false），bucket 见底时 tickLimit 收到 limit 才 armed
    ctx.hardStop = hardStopLine(cpu, forced ? force : null, Game.time);
    const used = cpu && typeof cpu.getUsed === 'function' ? Number(cpu.getUsed()) || 0 : 0;
    ctx.armed = ctx.hardStop !== null && ctx.hardStop - used < (Number(settings().hardStopArm) || 0);
    ctx.stopped = false;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.ticks++;
    if (mode === 'low') win.low++;
    if (mode === 'critical') win.crit++;
    if (forced) win.forced++;
    if (Game.time % 100 === 0) {
        for (const name of Object.keys(runtime.streak)) {
            if (!(runtime.streak[name].t >= Game.time - 5)) delete runtime.streak[name];
        }
    }
    return ctx;
}

function storeUsed(creep) {
    const store = creep && creep.store;
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') return Number(store.getUsedCapacity()) || 0;
    return Number(store[typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY]) || 0;
}

/** reserver 站在自己的外矿房里、预定是我方且还剩 ≥ reserverComfort：跳一 tick 只少一 tick 的增量 */
function reservationComfortable(creep) {
    const remoteRoom = creep.memory && creep.memory.remoteRoom;
    if (!remoteRoom || !creep.room || creep.room.name !== remoteRoom) return false;
    const reservation = creep.room.controller && creep.room.controller.reservation;
    if (!reservation) return false;
    if (creep.owner && creep.owner.username && reservation.username !== creep.owner.username) return false;
    return Number(reservation.ticksToEnd) >= Number(settings().reserverComfort);
}

/** 正在执行"外矿变占领目标"的 reserver（roles/reserver.js claimDuty）有占领窗口，不跳 */
function onClaimDuty(creep) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[creep.memory.home];
    const target = mem && mem.expansion && mem.expansion.target;
    return !!target && target === creep.memory.remoteRoom;
}

/** 可跳等级：数字越小越先跳；null = 不可跳 */
function shedRank(creep, mode) {
    const memory = creep && creep.memory;
    const role = memory && memory.role;
    if (!role) return null;
    const critical = mode === 'critical';
    switch (role) {
    case 'scout':
        return 0;
    case 'reserver':
        if (onClaimDuty(creep)) return null;
        if (reservationComfortable(creep)) return 0;
        // 紧急时在路上的 reserver 也可以晚一 tick 到
        return critical && creep.room && creep.room.name !== memory.remoteRoom ? 2 : null;
    case 'operator':
    case 'mineralMiner':
    case 'labTech':
        return 1;
    case 'remoteHauler':
        if (storeUsed(creep) > 0) return null;
        if (taskBroker.wasIdle(creep)) return 1;
        return critical ? 2 : null;
    case 'hauler':
    case 'builder':
    case 'courier':
    case 'feeder':
        return taskBroker.wasIdle(creep) ? 1 : null;
    default:
        return null;
    }
}

/** 降载时的执行顺序：不可跳的保持 broker 顺序先跑，可跳的按等级从高到低排在后面——上限一到，剩下的正好是最该跳的 */
function arrange(queue, ctx) {
    if (!ctx || !ctx.active) return queue;
    const keep = [];
    const tiers = [[], [], []];
    for (const creep of queue || []) {
        const memory = creep && creep.memory;
        if (memory && memory.role === 'hauler' && !creep.spawning && !utils.isRetiring(memory) && memory.home) {
            ctx.haulers[memory.home] = (ctx.haulers[memory.home] || 0) + 1;
        }
        const rank = creep && !creep.spawning ? shedRank(creep, ctx.mode) : null;
        if (rank == null) { keep.push(creep); continue; }
        ctx.rank[creep.name] = rank;
        tiers[rank].push(creep);
    }
    return keep.concat(tiers[2], tiers[1], tiers[0]);
}

/** 降载模式下这只 creep 能不能跳（还没看 CPU）：可跳等级、连续跳过次数、房里最后一只能跑的 hauler */
function mayShed(creep, ctx) {
    if (!ctx || !ctx.active || !creep || ctx.rank[creep.name] == null) return false;
    const streak = runtime.streak[creep.name];
    const max = Number(settings().maxConsecutive) || 0;
    if (streak && streak.t === Game.time - 1 && streak.n >= max) return false;
    const memory = creep.memory || {};
    if (memory.role === 'hauler' && !((ctx.haulers[memory.home] || 0) > 1)) return false;
    return true;
}

function noteSkip(creep, ctx) {
    const memory = creep.memory || {};
    const streak = runtime.streak[creep.name];
    runtime.streak[creep.name] = { n: streak && streak.t === Game.time - 1 ? streak.n + 1 : 1, t: Game.time };
    if (memory.role === 'hauler' && ctx && memory.home) ctx.haulers[memory.home] = (ctx.haulers[memory.home] || 0) - 1;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.skip++;
    win.roles[memory.role || '?'] = (win.roles[memory.role || '?'] || 0) + 1;
}

/** 循环里每只 creep 前问一次：越过硬停线就返回 true（调用方 break），记一次硬停 */
function hardStopNow(ctx) {
    if (!ctx || !ctx.armed || ctx.stopped) return !!(ctx && ctx.stopped);
    return Game.cpu.getUsed() > ctx.hardStop;
}

/** 记硬停：cut = 这一 tick 没跑的 creep 数。窗口遥测进 Memory.stats.shed（hard/cut），最近一次另记 Memory.cpuHardStop（运维直接看） */
function noteHardStop(ctx, cut) {
    if (!ctx) return;
    ctx.stopped = true;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.hard++;
    win.cut += cut;
    if (typeof Memory !== 'undefined' && Memory) {
        const log = Memory.cpuHardStop || (Memory.cpuHardStop = { n: 0 });
        log.n = (Number(log.n) || 0) + 1;
        log.at = Game.time;
        log.cut = cut;
        log.line = Math.round(ctx.hardStop * 10) / 10;
    }
}

/** 硬停的 tick 收尾（movement.endTick 之后）调用：hardEnd == hard 说明每次硬停之后收尾都跑完了 */
function noteHardStopEnd(ctx) {
    if (!ctx || !ctx.stopped) return;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.hardEnd++;
}

/** Memory.stats 采样（每 30 tick）：窗口内 low/critical/强制的 tick 数、跳过次数与按角色分布，然后清零 */
function digest() {
    const win = runtime.win || emptyWindow();
    runtime.win = emptyWindow();
    return { ticks: win.ticks, low: win.low, crit: win.crit, forced: win.forced, skip: win.skip, roles: win.roles,
        hard: win.hard, cut: win.cut, hardEnd: win.hardEnd };
}

module.exports = { begin, arrange, mayShed, noteSkip, digest, shedRank, modeFor, creepCap, hardStopLine, hardStopNow, noteHardStop, noteHardStopEnd };
