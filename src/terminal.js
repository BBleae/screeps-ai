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

function priorityList(cfg) {
    const c = cfg || config.terminalNetwork || {};
    return (Array.isArray(c.priorityReceivers) ? c.priorityReceivers : []).filter((n) => !utils.lootHeldRoom(n) && !utils.rcl8Room(n));
}

function noEnergyIn(room) {
    const list = (config.terminalNetwork || {}).noEnergyIn;
    return !!(room && Array.isArray(list) && list.indexOf(room.name) >= 0);
}

function receiveOnly(room) {
    if (!room) return false;
    const list = (config.terminalNetwork || {}).receiveOnly;
    if (Array.isArray(list) && list.indexOf(room.name) >= 0) return true;
    const below = Number(((config.terminalNetwork || {}).receiveOnlyBelow || {})[room.name]) || 0;
    if (below > 0 && roomEnergy(room) < below) return true;
    const head = sendHeadroom(room);
    if (head === Infinity) return false;
    return head < Math.max(1, Number((config.terminalNetwork || {}).minSend) || 5000) * 1.5;
}

function keepAfterSend(room) {
    const net = config.terminalNetwork || {};
    let floor = Number((net.keepAfterSend || {})[room.name]) || 0;
    const hold = ((config.upgrading || {}).hold || {})[room.name];
    if (hold && Number(hold.resumeAt) > 0) floor = Math.max(floor, Number(hold.resumeAt));
    return floor;
}

function sendHeadroom(room) {
    const floor = keepAfterSend(room);
    if (!(floor > 0)) return Infinity;
    const st = room.storage && room.storage.my !== false && room.storage.store;
    return energyOf(st) - floor;
}

function energySendOk(room, amount, cost) {
    return (Number(amount) || 0) + (Number(cost) || 0) <= sendHeadroom(room);
}

function fitHeadroom(plan) {
    const head = sendHeadroom(plan.from);
    if (energySendOk(plan.from, plan.amount, plan.cost)) return true;
    const ratio = plan.amount > 0 ? (Number(plan.cost) || 0) / plan.amount : 0.1;
    let amount = Math.floor(head / (1 + ratio)) - 1;
    let cost = amount > 0 ? transactionCost(amount, plan.from.name, plan.to.name) : 0;
    while (amount > 0 && amount + cost > head) { amount -= 100; cost = transactionCost(amount, plan.from.name, plan.to.name); }
    if (amount < Math.max(1, Number((config.terminalNetwork || {}).minSend) || 5000)) return false;
    plan.amount = amount;
    plan.cost = cost;
    plan.fitted = true;
    return true;
}

function noteBlocked(room, path) {
    const net = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    const b = net.receiveOnlyBlocked || (net.receiveOnlyBlocked = {});
    const r = b[room.name] || (b[room.name] = { n: 0 });
    r.n++;
    r.at = Game.time;
    r.path = path;
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

function storageSpare(room) {
    const keep = Number(((config.terminalNetwork || {}).storageKeepByRoom || {})[room.name]) || 0;
    if (!(keep > 0)) return Infinity;
    return committedSpare(room, keep);
}

function committedSpare(room, keep) {
    const target = Math.max(0, Number((config.industry || {}).terminalTarget) || 0);
    return energyOf(room.storage && room.storage.my !== false && room.storage.store) + energyOf(room.terminal && room.terminal.store) - keep - Math.max(target, feeReserveOf(room));
}

function dayKey() {
    return Math.floor((Date.now() + 9 * 3600000) / 86400000);
}

function senderLog(name) {
    const net = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    const all = net.senders || (net.senders = {});
    const day = dayKey();
    const rec = all[name] && all[name].day === day ? all[name] : (all[name] = { day, sent: 0, cost: 0, n: 0 });
    return rec;
}

function planSenders(rooms, cfg) {
    const rules = cfg.senders || {};
    const byName = {};
    for (const room of rooms) byName[room.name] = room;
    const feeKeep = Math.max(0, Number(cfg.feeReserve) || 0);
    for (const name of Object.keys(rules)) {
        const rule = rules[name] || {};
        const from = byName[name];
        if (!from || from.terminal.cooldown > 0 || usedThisTick(from.name)) continue;
        if (receiveOnly(from)) continue;
        const keep = Math.max(0, Number(rule.keep) || 0);
        const spare = committedSpare(from, keep);
        const minSend = Math.max(1, Number(rule.minSend) || cfg.minSend || 5000);
        if (spare < minSend) continue;
        const rec = senderLog(name);
        const left = (Number(rule.dailyMax) || Infinity) - rec.sent - rec.cost;
        if (left < minSend) continue;
        const budget = energyOf(from.terminal.store) - Math.max(feeKeep, feeReserveOf(from));
        const below = Number(rule.receiverBelow) || Infinity;
        const targets = (rule.to || []).map((n) => byName[n]).filter((to) => to && to.name !== name && !noEnergyIn(to) && !(to.controller && to.controller.level >= 8) && freeOf(to.terminal.store) > 0 && roomEnergy(to) < below)
            .sort((a, b) => (burnRoom(cfg, b) - burnRoom(cfg, a)) || (roomEnergy(a) - roomEnergy(b)));
        for (const to of targets) {
            let amount = Math.min(spare, Number(rule.maxSend) || cfg.maxSend, freeOf(to.terminal.store), budget, left);
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && (amount + cost > budget || amount + cost > left)) {
                amount = Math.floor((Math.min(budget, left) - cost) * 0.98);
                if (amount <= 0) break;
                cost = transactionCost(amount, from.name, to.name);
            }
            if (amount < minSend) continue;
            return { from, to, amount, cost, sender: true };
        }
    }
    return null;
}

function burnRoom(cfg, room) {
    const list = Array.isArray(cfg.burnRooms) ? cfg.burnRooms : [];
    return room && list.indexOf(room.name) >= 0 && !(room.controller && room.controller.level >= 8) && !utils.lootHeldRoom(room.name) ? 1 : 0;
}

function planStarving(rooms, cfg, rich) {
    const order = priorityList(cfg);
    const below = Number(cfg.starvingBelow) || 0;
    if (!order.length || below <= 0) return null;
    const byName = {};
    for (const room of rooms) byName[room.name] = room;
    const feeReserve = Math.max(0, Number(cfg.feeReserve) || 0);
    const sendAbove = Number(cfg.starveSendAbove) || cfg.sendAbove;
    const keep = Number(cfg.starveKeep) || cfg.keep;
    const peerMin = Number(cfg.starvePeerMin) || 0;
    const peerKeep = Number(cfg.starvePeerKeep) || 0;
    const isPeer = (room) => order.indexOf(room.name) >= 0;
    const senders = rooms.slice().sort((a, b) => roomEnergy(b) - roomEnergy(a)).filter((room) =>
        !(room.terminal.cooldown > 0) && !usedThisTick(room.name) && energyOf(room.terminal.store) > feeReserve &&
        !receiveOnly(room) && storageSpare(room) > 0 && (isPeer(room) ? peerMin > 0 && roomEnergy(room) >= peerMin : roomEnergy(room) >= sendAbove && rich(room)));
    const urgentFirst = order.filter((name) => byName[name] && roomEnergy(byName[name]) < below);
    const queue = urgentFirst.concat(order.filter((name) => urgentFirst.indexOf(name) < 0));
    for (const name of queue) {
        const to = byName[name];
        const until = Math.max(below, Number(cfg.starvingUntil && cfg.starvingUntil[name]) || 0);
        if (!to || noEnergyIn(to) || (to.controller && to.controller.level >= 8) || roomEnergy(to) >= until || freeOf(to.terminal.store) <= 0) continue;
        const burn = burnRoom(cfg, to) && roomEnergy(to) >= below;
        for (const from of senders) {
            if (from.name === to.name) continue;
            const peer = isPeer(from);
            if (burn && (peer || roomEnergy(from) < cfg.sendAbove)) continue;
            const spare = Math.min(roomEnergy(from) - (burn ? cfg.keep : peer ? peerKeep : keep) - feeReserveOf(from), storageSpare(from));
            const terminalBudget = energyOf(from.terminal.store) - Math.max(feeReserve, feeReserveOf(from));
            const budget = peer ? Math.min(terminalBudget, spare) : terminalBudget;
            let amount = Math.min(spare, Number(cfg.starveMaxSend) || cfg.maxSend, freeOf(to.terminal.store), budget);
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && amount + cost > budget) {
                amount = Math.floor((budget - cost) * 0.98);
                if (amount <= 0) break;
                cost = transactionCost(amount, from.name, to.name);
            }
            const minSend = until > below ? Math.min(cfg.minSend, Number(cfg.starveMinSend) || cfg.minSend) : cfg.minSend;
            if (amount < minSend) continue;
            return { from, to, amount, cost, starving: true, peer, burn: !!burn };
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
        if (!fee || noEnergyIn(to)) continue;
        const have = energyOf(to.terminal.store);
        if (have >= fee / 2) continue;
        const storageE = to.storage && to.storage.store ? energyOf(to.storage.store) : 0;
        if (storageE > floor + (fee - have)) continue;
        for (const from of rooms) {
            if (from.name === to.name || roomEnergy(from) < sendAbove || from.terminal.cooldown > 0 || usedThisTick(from.name) || !rich(from) || receiveOnly(from)) continue;
            const budget = energyOf(from.terminal.store) - Math.max(feeKeep, feeReserve(from, cfg));
            let amount = Math.min(fee - have, roomEnergy(from) - keep - feeReserve(from, cfg), storageSpare(from), budget, freeOf(to.terminal.store));
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
    const order = priorityList(cfg);
    if (!names.length || !order.length) return null;
    const sendAbove = Number(hf.sendAbove) || 40000;
    const keep = Number(hf.keep) || 20000;
    const maxSend = Number(hf.maxSend) || Number(cfg.starveMaxSend) || cfg.maxSend;
    const feeReserve = Math.max(0, Number(cfg.feeReserve) || 0);
    const byName = {};
    for (const room of rooms) byName[room.name] = room;
    const senders = names.map((n) => byName[n]).filter((room) => room && room.terminal && room.terminal.my !== false &&
        roomEnergy(room) >= sendAbove && !receiveOnly(room) &&
        !(room.terminal.cooldown > 0) && !usedThisTick(room.name) &&
        energyOf(room.terminal.store) > feeReserve && rich(room));
    if (!senders.length) return null;
    const want = [];
    for (const name of order) {
        const to = byName[name];
        if (!to || noEnergyIn(to) || freeOf(to.terminal.store) <= 0) continue;
        if (to.controller && to.controller.level >= 8) continue;
        want.push(to);
    }
    for (const to of rooms) {
        if (want.indexOf(to) >= 0 || noEnergyIn(to)) continue;
        if (roomEnergy(to) <= (Number(cfg.receiveBelow) || 0) && freeOf(to.terminal.store) > 0) want.push(to);
    }
    for (const from of senders) {
        for (const to of want) {
            if (to.name === from.name) continue;
            const spare = Math.min(roomEnergy(from) - keep - feeReserveOf(from), storageSpare(from), sendHeadroom(from));
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

function planFeed(rooms, cfg) {
    const rules = cfg.feedTo || {};
    const byName = {};
    for (const room of rooms) byName[room.name] = room;
    const feeKeep = Math.max(0, Number(cfg.feeReserve) || 0);
    for (const name of Object.keys(rules)) {
        const rule = rules[name] || {};
        const to = byName[name];
        if (!to || noEnergyIn(to) || roomEnergy(to) >= (Number(rule.until) || 0) || freeOf(to.terminal.store) <= 0) continue;
        const fromAbove = Number(rule.fromAbove) || cfg.sendAbove;
        const keep = Number(rule.keep) || fromAbove;
        const senders = rooms.filter((room) => room.name !== name && !receiveOnly(room) && !(room.terminal.cooldown > 0) && !usedThisTick(room.name) &&
            roomEnergy(room) >= fromAbove && (!Array.isArray(rule.from) || rule.from.indexOf(room.name) >= 0))
            .sort((a, b) => roomEnergy(b) - roomEnergy(a));
        for (const from of senders) {
            const spare = Math.min(roomEnergy(from) - keep - feeReserveOf(from), storageSpare(from));
            const budget = energyOf(from.terminal.store) - Math.max(feeKeep, feeReserveOf(from));
            let amount = Math.min(spare, Number(rule.maxSend) || cfg.maxSend, freeOf(to.terminal.store), budget, (Number(rule.until) || 0) - roomEnergy(to));
            let cost = transactionCost(amount, from.name, to.name);
            while (amount > 0 && amount + cost > budget) {
                amount = Math.floor((budget - cost) * 0.98);
                if (amount <= 0) break;
                cost = transactionCost(amount, from.name, to.name);
            }
            if (amount < (Number(rule.minSend) || cfg.minSend)) continue;
            return { from, to, amount, cost, feed: true };
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
    const feed = planFeed(rooms, cfg);
    if (feed) return feed;
    const sender = planSenders(rooms, cfg);
    if (sender) return sender;
    const hoard = planHoardFlush(rooms, cfg, rich);
    if (hoard) return hoard;
    const ranked = rooms.slice().sort((a, b) => roomEnergy(b) - roomEnergy(a));
    const feeReserve = Math.max(0, Number(cfg.feeReserve) || 0);
    const senders = ranked.filter((room) => roomEnergy(room) >= cfg.sendAbove && !receiveOnly(room) && !(room.terminal.cooldown > 0) &&
        !usedThisTick(room.name) && energyOf(room.terminal.store) > feeReserve && rich(room));
    const receivers = ranked.slice().reverse().filter((room) => !noEnergyIn(room) && roomEnergy(room) <= cfg.receiveBelow && freeOf(room.terminal.store) > 0);
    for (const from of senders) {
        for (const to of receivers) {
            if (to.name === from.name) continue;
            const spare = Math.min(roomEnergy(from) - cfg.keep - feeReserveOf(from), storageSpare(from));
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

function mineralWantFor(cfg, mineral, roomName) {
    const room = roomName && cfg.mineralWantByRoom && cfg.mineralWantByRoom[roomName];
    if (room && Object.prototype.hasOwnProperty.call(room, mineral)) return Math.max(0, Number(room[mineral]) || 0);
    const by = cfg.mineralWantByResource;
    const v = by && Number(by[mineral]);
    return v > 0 ? v : Math.max(1, Number(cfg.mineralWant) || 1000);
}

function mineralKeepFor(cfg, roomName, mineral) {
    const byResource = cfg.mineralKeepByResource;
    if (mineral && byResource && Object.prototype.hasOwnProperty.call(byResource, mineral)) return Math.max(0, Number(byResource[mineral]) || 0);
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
        const makeRoom = !!(config.industry && config.industry.boostRoomMake && config.industry.boostRoomMake[room.name]);
        if (Array.isArray(labRooms) && labRooms.indexOf(room.name) < 0 && !makeRoom) continue;
        for (const mineral of cfg.minerals || []) {
            const want = mineralWantFor(cfg, mineral, room.name);
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
            Number(room.terminal.store[mineral] || 0) > mineralKeepFor(cfg, room.name, mineral) + want)
            .sort((a, b) => Number(b.terminal.store[mineral] || 0) - Number(a.terminal.store[mineral] || 0));
        for (const from of donors) {
            const keep = mineralKeepFor(cfg, from.name, mineral);
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
    if (!utils.rcl8Ready(rule.whenRcl8)) return null;
    const res = rule.resource;
    if (res === RESOURCE && (receiveOnly(from) || noEnergyIn(to))) return null;
    const toHave = Number(to.terminal.store[res] || 0) + (rule.countStorage && to.storage && to.storage.store ? Number(to.storage.store[res] || 0) : 0);
    const fromFull = rule.fromFreeBelow > 0 && from.storage && from.storage.store && typeof from.storage.store.getFreeCapacity === 'function' && from.storage.store.getFreeCapacity() < rule.fromFreeBelow;
    if (toHave >= (Number(rule.toBelow) || Infinity) && !fromFull) return null;
    const fromHave = Number(from.terminal.store[res] || 0);
    const fromAll = fromHave + (rule.keep && from.storage && from.storage.store ? Number(from.storage.store[res] || 0) : 0);
    let amount = Math.min(fromHave, fromAll - (Number(rule.keep) || 0), Number(rule.batch) || 5000, freeOf(to.terminal.store));
    if (amount < (Number(rule.minBatch) || 1000)) return null;
    const floor = Math.max(0, Number(rule.energyFloor) || 0);
    const energy = energyOf(from.terminal.store);
    let cost = transactionCost(amount, from.name, to.name);
    while (amount > 0 && energy - cost < floor) {
        amount = Math.floor(amount / 2);
        cost = transactionCost(amount, from.name, to.name);
        if (amount < (Number(rule.minBatch) || 1000)) return { from, to, res, amount: 0, cost, blocked: 'energy' };
    }
    if (res === RESOURCE && !energySendOk(from, amount, cost)) return { from, to, res, amount: 0, cost, blocked: 'keepAfter' };
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

function storeUsedShare(structure) {
    const st = structure && structure.store;
    if (!st || typeof st.getCapacity !== 'function') return 0;
    const cap = Number(st.getCapacity()) || 0;
    return cap > 0 ? (Number(st.getUsedCapacity()) || 0) / cap : 0;
}

function exportKind(res) {
    if (res === 'battery') return 'battery';
    return /^X[A-Z0-9]+$/.test(res) ? 'T3' : null;
}

function lootExportRule(room) {
    const all = settings().lootExport;
    const rule = all && room && all[room.name];
    if (!rule || !room.storage || room.storage.my === false || !room.terminal || room.terminal.my === false) return null;
    if (storeUsedShare(room.storage) < Number(rule.storageAbove || 0.7)) return null;
    return rule;
}

function exportDests(kind, rule, fromName) {
    let names = [];
    if (kind === 'battery') {
        if (Array.isArray(rule.batteryTo)) names = rule.batteryTo;
        else { try { names = require('facts').factoryRooms(); } catch (e) { names = []; } }
    } else names = Array.isArray(rule.t3To) ? rule.t3To : [];
    return names.filter((n) => n !== fromName);
}

function planLootExport(cfg) {
    const all = cfg.lootExport || {};
    for (const name of Object.keys(all)) {
        const from = Game.rooms[name];
        if (!from || !from.controller || !from.controller.my) continue;
        const rule = lootExportRule(from);
        if (!rule || from.terminal.cooldown > 0 || usedThisTick(name)) continue;
        const keep = Number(rule.energyKeep != null ? rule.energyKeep : 150000);
        const batch = Number(rule.batch) || 5000;
        const minBatch = Number(rule.minBatch) || 1000;
        const recvTerminalFree = Number(rule.receiverTerminalFree != null ? rule.receiverTerminalFree : 20000);
        const recvStorageFree = Number(rule.receiverStorageFree != null ? rule.receiverStorageFree : 50000);
        const tStore = from.terminal.store;
        const items = Object.keys(tStore).filter((k) => exportKind(k) && Number(tStore[k]) >= minBatch).sort((a, b) => Number(tStore[b]) - Number(tStore[a]));
        const tEnergy = energyOf(tStore);
        const total = roomEnergy(from);
        for (const res of items) {
            const kind = exportKind(res);
            for (const toName of exportDests(kind, rule, name)) {
                const to = Game.rooms[toName];
                if (!to || !to.controller || !to.controller.my || !to.terminal || to.terminal.my === false || !to.storage || to.storage.my === false) continue;
                const tFree = Number(to.terminal.store.getFreeCapacity()) || 0;
                const sFree = Number(to.storage.store.getFreeCapacity()) || 0;
                if (tFree - recvTerminalFree < minBatch || sFree < recvStorageFree) continue;
                let amount = Math.min(Number(tStore[res]), batch, tFree - recvTerminalFree);
                let cost = transactionCost(amount, name, toName);
                while (amount >= minBatch && (cost > tEnergy || total - cost < keep)) {
                    amount = Math.floor(amount / 2);
                    cost = transactionCost(amount, name, toName);
                }
                if (amount < minBatch) return { from, to, res, amount: 0, cost, blocked: 'energy' };
                return { from, to, res, amount, cost, kind };
            }
        }
    }
    return null;
}

function runLootExport(cfg) {
    const plan = planLootExport(cfg);
    if (!plan) return null;
    const net = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    const mem = net.lootExport || (net.lootExport = { sent: {}, n: 0 });
    if (!plan.amount) { mem.blocked = { at: Game.time, from: plan.from.name, res: plan.res, why: plan.blocked }; return null; }
    const ret = plan.from.terminal.send(plan.res, plan.amount, plan.to.name, 'lootExport');
    markUsed(plan.from.name);
    const record = { at: Game.time, from: plan.from.name, to: plan.to.name, resource: plan.res, amount: plan.amount, cost: plan.cost, result: ret };
    mem.last = record;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        mem.n = (Number(mem.n) || 0) + 1;
        mem.sent[plan.res] = (Number(mem.sent[plan.res]) || 0) + plan.amount;
        mem.cost = (Number(mem.cost) || 0) + plan.cost;
    }
    return record;
}

function run(shed) {
    const cfg = settings();
    if (!cfg.enabled || !(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    if (!cpuAllows(cfg, shed)) return null;
    const rooms = terminalRooms();
    if (rooms.length < 2) return null;
    const ex = runLootExport(cfg);
    if (ex) return ex;
    const fwd = runForward(cfg);
    if (fwd) return fwd;
    const isRich = (room) => utils.storageRichState(room, Memory.rooms && Memory.rooms[room.name], config.upgrading || {});
    const plan = planTransfer(rooms, cfg, isRich);
    if (!plan) return runMineral(rooms, cfg);
    if (plan.burn) {
        const mineral = runMineral(rooms, cfg);
        if (mineral) return mineral;
    }
    if (receiveOnly(plan.from)) { noteBlocked(plan.from, 'balance'); return null; }
    if (!fitHeadroom(plan)) { noteBlocked(plan.from, plan.feed ? 'keepAfterFeed' : 'keepAfter'); return null; }
    const ret = plan.from.terminal.send(RESOURCE, plan.amount, plan.to.name, 'balance');
    markUsed(plan.from.name);
    const record = { at: Game.time, from: plan.from.name, to: plan.to.name, amount: plan.amount, cost: plan.cost, result: ret };
    const mem = Memory.terminalNetwork || (Memory.terminalNetwork = {});
    mem.last = record;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        mem.sent = (Number(mem.sent) || 0) + 1;
        mem.amount = (Number(mem.amount) || 0) + plan.amount;
        if (plan.sender) {
            const rec = senderLog(plan.from.name);
            rec.sent += plan.amount;
            rec.cost += plan.cost;
            rec.n++;
            rec.last = record;
        }
        if (plan.feed) {
            const fd = mem.feed || (mem.feed = {});
            const fr = fd[plan.to.name] || (fd[plan.to.name] = { n: 0, amount: 0, from: {} });
            fr.n++;
            fr.amount += plan.amount;
            fr.from[plan.from.name] = (Number(fr.from[plan.from.name]) || 0) + plan.amount;
            fr.last = record;
        }
        if (plan.peer) {
            const peer = mem.peer || (mem.peer = { n: 0, amount: 0 });
            peer.n++;
            peer.amount += plan.amount;
            peer.last = record;
        }
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

module.exports = { lootExportRule, exportKind, planLootExport, runLootExport, priorityList, noEnergyIn, receiveOnly, keepAfterSend, sendHeadroom, energySendOk, planFeed, burnRoom, planStarving, planSenders, storageSpare, planForward, runForward, run, planTransfer, planHoardFlush, planMineralTransfer, mineralHolds, terminalRooms, roomEnergy, settings, cpuAllows, markUsed, usedThisTick };
