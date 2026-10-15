'use strict';
/**
 * 终端网络：把能量从富裕的己方房瞬时送到饥饿的己方房（移植 overmind-absorb 2214dcc，Overmind 的 TerminalNetwork.equalize）。
 *
 * 为什么需要它：跨房搬能量原本只有 courier —— 一只 creep 走过去、卸货、走回来，距离一远就几乎不产出。
 * terminal 之间是瞬时传送，代价是按距离折算的能量（Game.market.calcTransactionCost），远比走路便宜。
 *
 * 保守规则（宁可不发，也不把发送方掏空）：
 *   - 每 interval tick 只做一笔：找"最富的发送方"与"最饿的接收方"
 *   - 发送方：storageRich 滞回开着、storage+terminal ≥ sendAbove，发出后自己仍 ≥ keep；terminal 里留 feeReserve 给市场传送费
 *   - 接收方：storage+terminal ≤ receiveBelow，且 terminal 有空位
 *   - 传送本身要烧能量，低于 minSend 的小单不发
 * 接收方 terminal 里的能量由 hauler 取出（task_broker 的 terminal 取货：只在 storage 不富余时，与补能互斥）。
 * CPU：bucket 降载（cpu_shed）中、或 bucket < minBucket 时整轮跳过；本 tick 已被市场用过的 terminal 不再发。
 *
 * 矿物调剂（移植 overmind-absorb 019c5b1）：一个房只有一种矿脉，而任何反应都要两种输入——没有调剂，industry 的反应链
 * 对绝大多数房永远卡在「缺基础矿」那一支。能量这一轮没有要发的才轮到它，一轮仍只做一笔：某房 terminal 里某种基础矿
 * 超过 mineralKeep + mineralWant 是余量，有 lab（≥ mineralLabs 个）的房这种矿不足 mineralWant 是缺口。
 * 只调基础矿（H/O/Z/K/U/L/X）——化合物跟着做它的房走。遥测 Memory.terminalNetwork.mineral {last, sent, amount}。
 * 全部阈值在 config.terminalNetwork。
 */
const config = require('config');
const utils = require('utils');

const RESOURCE = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';

// 本 tick 已经发过意图的 terminal（同一 terminal 一 tick 只能 send/deal 一次，引擎会让后一个失败）
const usedTick = { time: -1, rooms: {} };
function markUsed(roomName) {
    if (usedTick.time !== Game.time) { usedTick.time = Game.time; usedTick.rooms = {}; }
    usedTick.rooms[roomName] = true;
}
function usedThisTick(roomName) {
    return usedTick.time === Game.time && !!usedTick.rooms[roomName];
}

function settings() {
    return Object.assign({
        enabled: true,
        interval: 10,
        sendAbove: 100000,
        receiveBelow: 20000,
        keep: 60000,
        minSend: 5000,
        maxSend: 50000,
        feeReserve: 2000,
        minBucket: 3000,
        minerals: ['H', 'O', 'Z', 'K', 'U', 'L', 'X'],
        mineralKeep: 3000,
        mineralWant: 1000,
        mineralMaxSend: 2000,
        mineralLabs: 3,
    }, config.terminalNetwork || {});
}

function energyOf(store) {
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') return Number(store.getUsedCapacity(RESOURCE) || 0);
    return Number(store[RESOURCE] || 0);
}

function freeOf(store) {
    if (!store) return 0;
    if (typeof store.getFreeCapacity === 'function') return Math.max(0, Number(store.getFreeCapacity(RESOURCE) || 0));
    return 0;
}

/** 房间的能量家底：storage + terminal（两者都算，决定谁富谁饿） */
function roomEnergy(room) {
    return energyOf(room.storage && room.storage.my !== false && room.storage.store) +
        energyOf(room.terminal && room.terminal.my !== false && room.terminal.store);
}

/** 有己方 terminal 的己方房 */
function terminalRooms() {
    const out = [];
    for (const name of Object.keys(Game.rooms)) {
        const room = Game.rooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        const terminal = room.terminal;
        if (!terminal || terminal.my === false || !terminal.store) continue;
        out.push(room);
    }
    return out;
}

function transactionCost(amount, from, to) {
    const market = typeof Game !== 'undefined' && Game.market;
    if (!market || typeof market.calcTransactionCost !== 'function') return Math.ceil(amount * 0.1);   // 单测缺 market 时的保守估计
    return market.calcTransactionCost(amount, from, to);
}

/** bucket 降载中、硬停过、或 bucket 太低：不做（跨房均衡不急，一轮都不值得冒险） */
function cpuAllows(cfg, shed) {
    if (shed && (shed.active || shed.stopped)) return false;
    const bucket = typeof Game !== 'undefined' && Game.cpu ? Game.cpu.bucket : undefined;
    return !(typeof bucket === 'number' && bucket < Number(cfg.minBucket || 0));
}

/** 这一轮该做的那笔转账；没有合适的组合返回 null（纯函数，便于单测）。isRich(room) = 发送方的 storageRich 滞回状态 */
/** 救急：priorityReceivers 里能量（storage+terminal）< starvingBelow 的房按名单顺序先救；发送方门槛降到 starveSendAbove、
 *  发完自己留 starveKeep（2026-10-14：全账号没有一个房够 sendAbove 10 万，W31S8 等房 storage 归零、外矿 hauler 孵不出来） */
function feeReserveOf(room) {
    const map = (config.terminalNetwork || {}).terminalFeeReserve;
    return Math.max(0, Number(map && map[room.name]) || 0);
}

function planStarving(rooms, cfg, rich) {
    const order = Array.isArray(cfg.priorityReceivers) ? cfg.priorityReceivers : [];
    const below = Number(cfg.starvingBelow) || 0;
    if (!order.length || below <= 0) return null;
    const byName = {};
    for (const room of rooms) byName[room.name] = room;
    const feeReserve = Math.max(0, Number(cfg.feeReserve) || 0);
    const sendAbove = Number(cfg.starveSendAbove) || cfg.sendAbove;
    const keep = Number(cfg.starveKeep) || cfg.keep;
    const senders = rooms.slice().sort((a, b) => roomEnergy(b) - roomEnergy(a)).filter((room) => roomEnergy(room) >= sendAbove &&
        !(room.terminal.cooldown > 0) && !usedThisTick(room.name) && energyOf(room.terminal.store) > feeReserve && rich(room) &&
        order.indexOf(room.name) < 0);
    for (const name of order) {
        const to = byName[name];
        const until = Math.max(below, Number(cfg.starvingUntil && cfg.starvingUntil[name]) || 0);
        if (!to || roomEnergy(to) >= until || freeOf(to.terminal.store) <= 0) continue;
        for (const from of senders) {
            const spare = roomEnergy(from) - keep - feeReserveOf(from);
            const budget = energyOf(from.terminal.store) - Math.max(feeReserve, feeReserveOf(from));
            let amount = Math.min(spare, Number(cfg.starveMaxSend) || cfg.maxSend, freeOf(to.terminal.store), budget);
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && amount + cost > budget) {
                amount = Math.floor((budget - cost) * 0.98);
                if (amount <= 0) break;
                cost = transactionCost(amount, from.name, to.name);
            }
            // 10-16 战略猫：starvingUntil 里的房救急期间单笔下限降到 starveMinSend（2000）；回到门槛以上就不走这条，自动恢复 minSend
            const minSend = until > below ? Math.min(cfg.minSend, Number(cfg.starveMinSend) || cfg.minSend) : cfg.minSend;
            if (amount < minSend) continue;
            return { from, to, amount, cost, starving: true };
        }
    }
    return null;
}

function feeReserve(room, cfg) {
    const map = cfg.terminalFeeReserve;
    return Math.max(0, Number(map && map[room.name]) || 0);
}

/** 传送费储备房（排在救急之后）：terminal 能量 < 储备一半、且 storage 自己补不上（≤ feeReserveStorageFloor + 缺口）时，按救急的发送方规则送到储备线 */
function planFeeReserve(rooms, cfg, rich) {
    const map = cfg.terminalFeeReserve;
    if (!map) return null;
    const floor = Math.max(0, Number(cfg.feeReserveStorageFloor) || 0);
    const sendAbove = Number(cfg.starveSendAbove) || cfg.sendAbove;
    const keep = Number(cfg.starveKeep) || cfg.keep;
    const feeKeep = Math.max(0, Number(cfg.feeReserve) || 0);
    for (const to of rooms) {
        const fee = feeReserve(to, cfg);
        if (!fee) continue;
        const have = energyOf(to.terminal.store);
        if (have >= fee / 2) continue;
        const storageE = to.storage && to.storage.store ? energyOf(to.storage.store) : 0;
        if (storageE > floor + (fee - have)) continue;   // 本房 hauler 补得上
        for (const from of rooms) {
            if (from.name === to.name || roomEnergy(from) < sendAbove || from.terminal.cooldown > 0 || usedThisTick(from.name) || !rich(from)) continue;
            const budget = energyOf(from.terminal.store) - Math.max(feeKeep, feeReserve(from, cfg));
            let amount = Math.min(fee - have, roomEnergy(from) - keep - feeReserve(from, cfg), budget, freeOf(to.terminal.store));
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && amount + cost > budget) { amount = Math.floor((budget - cost) * 0.98); if (amount <= 0) break; cost = transactionCost(amount, from.name, to.name); }
            if (amount < cfg.minSend) continue;
            return { from, to, amount, cost, feeReserve: true };
        }
    }
    return null;
}

function planTransfer(rooms, cfg, isRich) {
    const rich = typeof isRich === 'function' ? isRich : () => true;
    const urgent = planStarving(rooms, cfg, rich);
    if (urgent) return urgent;
    const fee = planFeeReserve(rooms, cfg, rich);
    if (fee) return fee;
    const ranked = rooms.slice().sort((a, b) => roomEnergy(b) - roomEnergy(a));
    const feeReserve = Math.max(0, Number(cfg.feeReserve) || 0);
    const senders = ranked.filter((room) => roomEnergy(room) >= cfg.sendAbove && !(room.terminal.cooldown > 0) &&
        !usedThisTick(room.name) && energyOf(room.terminal.store) > feeReserve && rich(room));
    const receivers = ranked.slice().reverse().filter((room) => roomEnergy(room) <= cfg.receiveBelow && freeOf(room.terminal.store) > 0);
    for (const from of senders) {
        for (const to of receivers) {
            if (to.name === from.name) continue;
            const spare = roomEnergy(from) - cfg.keep - feeReserveOf(from);
            if (spare <= 0) continue;
            // 传送的能量与传送费都从 terminal 里出，且留 feeReserve 给市场（有传送费储备的房留储备）
            const budget = energyOf(from.terminal.store) - Math.max(feeReserve, feeReserveOf(from));
            let amount = Math.min(spare, cfg.maxSend, freeOf(to.terminal.store), budget);
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && amount + cost > budget) {
                amount = Math.floor((budget - cost) * 0.98);
                if (amount <= 0) break;
                cost = transactionCost(amount, from.name, to.name);
            }
            if (amount < cfg.minSend) continue;
            return { from, to, amount, cost };
        }
    }
    return null;
}

function labsOf(room) {
    if (typeof room.find !== 'function') return [];
    const kind = typeof FIND_MY_STRUCTURES !== 'undefined' ? FIND_MY_STRUCTURES : 'structures';
    const lab = typeof STRUCTURE_LAB !== 'undefined' ? STRUCTURE_LAB : 'lab';
    return room.find(kind, { filter: (s) => s.structureType === lab }) || [];
}

/** 某房某种矿的家底：terminal + storage + lab 里装着的（装进 lab 的还没用掉，不算缺口） */
function mineralHave(room, labs, mineral) {
    let sum = 0;
    for (const holder of [room.terminal, room.storage]) {
        if (holder && holder.my !== false && holder.store) sum += Number(holder.store[mineral] || 0);
    }
    for (const lab of labs) sum += Number((lab.store || {})[mineral] || 0);
    return sum;
}

/** 缺口房：有 lab（≥ mineralLabs 个）才消费矿物；没 lab 的房调过去也只是躺着 */
function mineralShort(rooms, cfg) {
    const want = Math.max(1, Number(cfg.mineralWant) || 1000);
    const minLabs = Math.max(1, Number(cfg.mineralLabs) || 3);
    const out = {};
    for (const room of rooms) {
        const labs = labsOf(room);
        if (labs.length < minLabs) continue;
        // 配了 labRooms 时只往这些房调基础矿（反应只在那里跑）
        const labRooms = config.industry && config.industry.labRooms;
        if (Array.isArray(labRooms) && labRooms.indexOf(room.name) < 0) continue;
        for (const mineral of cfg.minerals || []) {
            const have = mineralHave(room, labs, mineral);
            if (have < want) (out[mineral] || (out[mineral] = [])).push({ room, have });
        }
    }
    return out;
}

/** 这一轮该做的那笔矿物调剂；没有返回 null（纯函数，便于单测） */
function planMineralTransfer(rooms, cfg) {
    const keep = Math.max(0, Number(cfg.mineralKeep) || 0);
    const want = Math.max(1, Number(cfg.mineralWant) || 1000);
    const maxSend = Math.max(1, Number(cfg.mineralMaxSend) || 2000);
    const short = mineralShort(rooms, cfg);
    for (const mineral of cfg.minerals || []) {
        const needy = (short[mineral] || []).filter((entry) => freeOf(entry.room.terminal.store) > 0).sort((a, b) => a.have - b.have);
        if (!needy.length) continue;
        const donors = rooms.filter((room) => !(room.terminal.cooldown > 0) && !usedThisTick(room.name) &&
            Number(room.terminal.store[mineral] || 0) > keep + want)
            .sort((a, b) => Number(b.terminal.store[mineral] || 0) - Number(a.terminal.store[mineral] || 0));
        for (const from of donors) {
            for (const entry of needy) {
                const to = entry.room;
                if (to.name === from.name) continue;
                const amount = Math.min(Number(from.terminal.store[mineral] || 0) - keep, maxSend, freeOf(to.terminal.store));
                if (amount < want) continue;
                // 传送费从发送方 terminal 的能量里出
                const cost = transactionCost(amount, from.name, to.name);
                if (cost > energyOf(from.terminal.store)) continue;
                return { from, to, amount, cost, resource: mineral };
            }
        }
    }
    return null;
}

/** 有 lab 的己方房缺着的基础矿（市场不卖它们：卖掉的正是别的房反应要调剂的那份） */
function mineralHolds(rooms, cfg) {
    return new Set(Object.keys(mineralShort(rooms || terminalRooms(), cfg || settings())));
}

function run(shed) {
    const cfg = settings();
    if (!cfg.enabled || !(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    if (!cpuAllows(cfg, shed)) return null;
    const rooms = terminalRooms();
    if (rooms.length < 2) return null;
    const isRich = (room) => utils.storageRichState(room, Memory.rooms && Memory.rooms[room.name], config.upgrading || {});
    const plan = planTransfer(rooms, cfg, isRich);
    if (!plan) return runMineral(rooms, cfg);
    const ret = plan.from.terminal.send(RESOURCE, plan.amount, plan.to.name, 'balance');
    markUsed(plan.from.name);
    const record = { at: Game.time, from: plan.from.name, to: plan.to.name, amount: plan.amount, cost: plan.cost, result: ret };
    const mem = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    mem.last = record;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        mem.sent = (Number(mem.sent) || 0) + 1;
        mem.amount = (Number(mem.amount) || 0) + plan.amount;
    }
    return record;
}

/** 能量没有要发的：看矿物（反应要两种输入，一个房只产一种矿） */
function runMineral(rooms, cfg) {
    let plan = null;
    try { plan = planMineralTransfer(rooms, cfg); } catch (error) { utils.logErr('terminal.planMineral', error); return null; }
    if (!plan) return null;
    const ret = plan.from.terminal.send(plan.resource, plan.amount, plan.to.name, 'minerals');
    markUsed(plan.from.name);
    const record = { at: Game.time, from: plan.from.name, to: plan.to.name, resource: plan.resource, amount: plan.amount, cost: plan.cost, result: ret };
    const net = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    const mem = net.mineral || (net.mineral = {});
    mem.last = record;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        mem.sent = (Number(mem.sent) || 0) + 1;
        mem.amount = (Number(mem.amount) || 0) + plan.amount;
    }
    return record;
}

module.exports = { run, planTransfer, planMineralTransfer, mineralHolds, terminalRooms, roomEnergy, settings, cpuAllows, markUsed, usedThisTick };
