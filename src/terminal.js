'use strict';
const config = require('config');
const utils = require('utils');

const RESOURCE = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';

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

function roomEnergy(room) {
    return energyOf(room.storage && room.storage.my !== false && room.storage.store) +
        energyOf(room.terminal && room.terminal.my !== false && room.terminal.store);
}

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
    if (!market || typeof market.calcTransactionCost !== 'function') return Math.ceil(amount * 0.1);
    return market.calcTransactionCost(amount, from, to);
}

function cpuAllows(cfg, shed) {
    if (shed && (shed.active || shed.stopped)) return false;
    const bucket = typeof Game !== 'undefined' && Game.cpu ? Game.cpu.bucket : undefined;
    return !(typeof bucket === 'number' && bucket < Number(cfg.minBucket || 0));
}

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
        if (!to || (to.controller && to.controller.level >= 8) || roomEnergy(to) >= until || freeOf(to.terminal.store) <= 0) continue;
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
        if (storageE > floor + (fee - have)) continue;
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

function planHoardFlush(rooms, cfg, rich) {
    const hf = cfg.hoardFlush || {};
    const names = Array.isArray(hf.rooms) ? hf.rooms : [];
    const order = Array.isArray(cfg.priorityReceivers) ? cfg.priorityReceivers : [];
    if (!names.length || !order.length) return null;
    const sendAbove = Number(hf.sendAbove) || 40000;
    const keep = Number(hf.keep) || 20000;
    const maxSend = Number(hf.maxSend) || Number(cfg.starveMaxSend) || cfg.maxSend;
    const feeReserve = Math.max(0, Number(cfg.feeReserve) || 0);
    const byName = {};
    for (const room of rooms) byName[room.name] = room;
    const senders = names.map((n) => byName[n]).filter((room) => room && room.terminal && room.terminal.my !== false &&
        roomEnergy(room) >= sendAbove &&
        !(room.terminal.cooldown > 0) && !usedThisTick(room.name) &&
        energyOf(room.terminal.store) > feeReserve && rich(room));
    if (!senders.length) return null;
    const want = [];
    for (const name of order) {
        const to = byName[name];
        if (!to || freeOf(to.terminal.store) <= 0) continue;
        if (to.controller && to.controller.level >= 8) continue;
        want.push(to);
    }
    for (const to of rooms) {
        if (want.indexOf(to) >= 0) continue;
        if (roomEnergy(to) <= (Number(cfg.receiveBelow) || 0) && freeOf(to.terminal.store) > 0) want.push(to);
    }
    for (const from of senders) {
        for (const to of want) {
            if (to.name === from.name) continue;
            const spare = roomEnergy(from) - keep - feeReserveOf(from);
            if (spare <= 0) continue;
            const budget = energyOf(from.terminal.store) - Math.max(feeReserve, feeReserveOf(from));
            let amount = Math.min(spare, maxSend, freeOf(to.terminal.store), budget);
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && amount + cost > budget) {
                amount = Math.floor((budget - cost) * 0.98);
                if (amount <= 0) break;
                cost = transactionCost(amount, from.name, to.name);
            }
            if (amount < (Number(cfg.minSend) || 5000)) continue;
            return { from, to, amount, cost, hoard: true };
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
    const hoard = planHoardFlush(rooms, cfg, rich);
    if (hoard) return hoard;
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

function mineralHave(room, labs, mineral) {
    let sum = 0;
    for (const holder of [room.terminal, room.storage]) {
        if (holder && holder.my !== false && holder.store) sum += Number(holder.store[mineral] || 0);
    }
    for (const lab of labs) sum += Number((lab.store || {})[mineral] || 0);
    return sum;
}

function mineralWantFor(cfg, mineral) {
    const by = cfg.mineralWantByResource;
    const v = by && Number(by[mineral]);
    return v > 0 ? v : Math.max(1, Number(cfg.mineralWant) || 1000);
}

function mineralKeepFor(cfg, roomName) {
    const by = cfg.mineralKeepByRoom;
    if (by && Object.prototype.hasOwnProperty.call(by, roomName)) {
        const v = Number(by[roomName]);
        if (v >= 0) return v;
    }
    return Math.max(0, Number(cfg.mineralKeep) || 0);
}

function mineralShort(rooms, cfg) {
    const minLabs = Math.max(1, Number(cfg.mineralLabs) || 3);
    const out = {};
    for (const room of rooms) {
        const labs = labsOf(room);
        if (labs.length < minLabs) continue;
        const labRooms = config.industry && config.industry.labRooms;
        if (Array.isArray(labRooms) && labRooms.indexOf(room.name) < 0) continue;
        for (const mineral of cfg.minerals || []) {
            const want = mineralWantFor(cfg, mineral);
            const have = mineralHave(room, labs, mineral);
            if (have < want) (out[mineral] || (out[mineral] = [])).push({ room, have });
        }
    }
    return out;
}

function planMineralTransfer(rooms, cfg) {
    const maxSend = Math.max(1, Number(cfg.mineralMaxSend) || 2000);
    const short = mineralShort(rooms, cfg);
    for (const mineral of cfg.minerals || []) {
        const want = mineralWantFor(cfg, mineral);
        const needy = (short[mineral] || []).filter((entry) => freeOf(entry.room.terminal.store) > 0).sort((a, b) => a.have - b.have);
        if (!needy.length) continue;
        const donors = rooms.filter((room) => !(room.terminal.cooldown > 0) && !usedThisTick(room.name) &&
            Number(room.terminal.store[mineral] || 0) > mineralKeepFor(cfg, room.name) + want)
            .sort((a, b) => Number(b.terminal.store[mineral] || 0) - Number(a.terminal.store[mineral] || 0));
        for (const from of donors) {
            const keep = mineralKeepFor(cfg, from.name);
            for (const entry of needy) {
                const to = entry.room;
                if (to.name === from.name) continue;
                const amount = Math.min(Number(from.terminal.store[mineral] || 0) - keep, maxSend, freeOf(to.terminal.store));
                if (amount < Math.min(want, maxSend)) continue;
                const cost = transactionCost(amount, from.name, to.name);
                if (cost > energyOf(from.terminal.store)) continue;
                return { from, to, amount, cost, resource: mineral };
            }
        }
    }
    return null;
}

function mineralHolds(rooms, cfg) {
    return new Set(Object.keys(mineralShort(rooms || terminalRooms(), cfg || settings())));
}

function planForward(rule) {
    const from = Game.rooms[rule.from];
    const to = Game.rooms[rule.to];
    if (!from || !to || !from.terminal || !to.terminal || from.terminal.my === false || to.terminal.my === false) return null;
    if (from.terminal.cooldown > 0 || usedThisTick(from.name)) return null;
    const res = rule.resource;
    if (Number(to.terminal.store[res] || 0) >= (Number(rule.toBelow) || Infinity)) return null;
    let amount = Math.min(Number(from.terminal.store[res] || 0), Number(rule.batch) || 5000, freeOf(to.terminal.store));
    if (amount < (Number(rule.minBatch) || 1000)) return null;
    const floor = Math.max(0, Number(rule.energyFloor) || 0);
    const energy = energyOf(from.terminal.store);
    let cost = transactionCost(amount, from.name, to.name);
    while (amount > 0 && energy - cost < floor) {
        amount = Math.floor(amount / 2);
        cost = transactionCost(amount, from.name, to.name);
        if (amount < (Number(rule.minBatch) || 1000)) return { from, to, res, amount: 0, cost, blocked: 'energy' };
    }
    return { from, to, res, amount, cost };
}

function runForward(cfg) {
    const mem = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    for (const rule of cfg.forward || []) {
        const plan = planForward(rule);
        if (!plan) continue;
        const log = mem.forward || (mem.forward = {});
        const key = rule.from + '>' + rule.to + ':' + rule.resource;
        const rec = log[key] || (log[key] = { sent: 0, cost: 0, n: 0 });
        if (!plan.amount) { rec.blocked = { at: Game.time, why: plan.blocked }; continue; }
        const ret = plan.from.terminal.send(plan.res, plan.amount, plan.to.name, 'forward');
        markUsed(plan.from.name);
        rec.last = { at: Game.time, amount: plan.amount, cost: plan.cost, result: ret };
        if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
            rec.sent += plan.amount;
            rec.cost += plan.cost;
            rec.n++;
        }
        return rec.last;
    }
    return null;
}

function run(shed) {
    const cfg = settings();
    if (!cfg.enabled || !(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    if (!cpuAllows(cfg, shed)) return null;
    const rooms = terminalRooms();
    if (rooms.length < 2) return null;
    const fwd = runForward(cfg);
    if (fwd) return fwd;
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

module.exports = { planForward, runForward, run, planTransfer, planHoardFlush, planMineralTransfer, mineralHolds, terminalRooms, roomEnergy, settings, cpuAllows, markUsed, usedThisTick };
