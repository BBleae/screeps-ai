'use strict';
/**
 * 市场：把用不掉的矿物卖成 credit（移植 overmind-absorb 2133dc2 + 6112d42，Overmind 的 TraderJoe）。
 *
 * 只做「吃掉别人挂的买单」（Game.market.deal），不自己挂单：
 *   - 挂单要付 5% 手续费并占用 credit，收益要等别人来吃；直接成交是即时的、无手续费
 *   - 我们的矿物是副产品（矿脉挖出来、打捞收回来），labs 用不掉的部分换成 credit 就是净赚；有 lab 的房缺着的基础矿不卖（terminal.mineralHolds）
 *
 * 三道闸，避免贱卖和白烧能量：
 *   1. 价格底线：Game.market.getHistory(资源) 最近 historyDays 天的均价 × priceFloorShare，买单价低于它就不卖
 *      （Overmind 用的是 2018 年硬编码价格表，今天早已失真）；没有成交史 = 没有底线 = 不卖
 *   2. 有效价格：买单价要扣掉每单位的传送能量成本（calcTransactionCost / amount × energyPrice）
 *   3. terminal 要付得起传送能量，每种矿物留 keep；房间 storage 不富余（storageRich 滞回关）时不卖——传送费是从 terminal 的能量里出的
 *
 * CPU：getAllOrders 是 CPU 3 档的重操作。每 interval tick 才考虑一次、一轮只做一笔、最多 maxScans 次 getAllOrders
 * （同一资源一轮只查一次）；getHistory 的均价按资源缓存 cacheTicks。bucket 降载（cpu_shed）中、硬停过、bucket < minBucket 时整轮跳过。
 */
const config = require('config');
const utils = require('utils');
const terminalNet = require('terminal');

const ENERGY = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
const POWER = typeof RESOURCE_POWER !== 'undefined' ? RESOURCE_POWER : 'power';
const BUY = () => (typeof ORDER_BUY !== 'undefined' ? ORDER_BUY : 'buy');

function settings() {
    return Object.assign({
        enabled: true,
        interval: 100,
        cacheTicks: 500,
        keep: 3000,
        minDeal: 500,
        maxDeal: 5000,
        priceFloorShare: 0.7,
        historyDays: 5,
        energyPrice: 0.02,
        minBucket: 5000,
        maxScans: 3,
    }, config.market || {});
}

function marketApi() {
    return (typeof Game !== 'undefined' && Game.market) || null;
}

/** 近期均价（getHistory 是 CPU 1 档，按资源缓存在 Memory.market.avg[资源]）；没有成交史返回 null */
function recentAvgPrice(resource, cfg) {
    const market = marketApi();
    if (!market || typeof market.getHistory !== 'function') return null;
    const mem = Memory.market || (Memory.market = {});
    const cache = mem.avg || (mem.avg = {});
    const entry = cache[resource];
    if (entry && Game.time - Number(entry.at || 0) < cfg.cacheTicks) return typeof entry.avg === 'number' ? entry.avg : null;
    let rows;
    try { rows = market.getHistory(resource); } catch (error) { return null; }
    // 没有成交史时引擎返回的是空对象而不是空数组（engine game/market.js：history[资源] || {}），直接 .slice 会抛 TypeError
    let avg = null;
    if (Array.isArray(rows)) {
        const priced = rows.slice(-Math.max(1, cfg.historyDays)).filter((row) => row && typeof row.avgPrice === 'number' && row.avgPrice > 0);
        if (priced.length) avg = priced.reduce((sum, row) => sum + row.avgPrice, 0) / priced.length;
    }
    // 没有均价也缓存（avg: null）：从没成交过的资源不必每轮都问一次
    cache[resource] = { at: Game.time, avg };
    return avg;
}

/** terminal 里可卖的资源（超过 keep 的部分，不含能量与 power——power 是 powerSpawn 的料），按可卖量降序。
 *  hold：有 lab 的己方房正缺着的基础矿（terminal.mineralHolds）——卖掉的正是终端调剂要送去反应的那份，不卖 */
function sellable(room, cfg, hold) {
    const terminal = room && room.terminal;
    const store = terminal && terminal.my !== false && terminal.store;
    if (!store) return [];
    const out = [];
    for (const key of Object.keys(store)) {
        if (key === ENERGY || key === POWER) continue;
        if (hold && hold.has(key)) continue;
        const amount = store[key];
        if (typeof amount !== 'number' || amount <= cfg.keep) continue;
        out.push({ resource: key, amount: amount - cfg.keep });
    }
    return out.sort((a, b) => b.amount - a.amount);
}

/** 给定资源，挑一张最划算的买单；不合算返回 null（纯函数，orders 由调用方传入，便于单测） */
function pickBuyOrder(orders, room, entry, cfg, floorPrice) {
    const market = marketApi();
    const terminalEnergy = Number((room.terminal.store || {})[ENERGY] || 0);
    let best = null;
    for (const order of orders || []) {
        if (!order || order.type !== BUY() || order.resourceType !== entry.resource) continue;
        if (!(order.amount > 0) || !(order.price > 0) || !order.roomName) continue;
        const amount = Math.min(entry.amount, order.amount, cfg.maxDeal);
        if (amount < cfg.minDeal) continue;
        const cost = market && typeof market.calcTransactionCost === 'function'
            ? market.calcTransactionCost(amount, room.name, order.roomName)
            : Math.ceil(amount * 0.1);
        // 有效价格：买单价扣掉每单位烧掉的能量折价
        const effective = order.price - (cost / amount) * cfg.energyPrice;
        if (effective < floorPrice) continue;
        if (cost > terminalEnergy) continue;
        if (!best || effective > best.effective) best = { order, amount, cost, effective };
    }
    return best;
}

/** 能卖货的房：己方 terminal、不在冷却、本 tick 没被终端网络用过、storage 富余（storageRich 滞回开） */
function sellerRooms() {
    const out = [];
    for (const name of Object.keys(Game.rooms)) {
        const room = Game.rooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        const terminal = room.terminal;
        if (!terminal || terminal.my === false || !terminal.store || terminal.cooldown > 0) continue;
        if (terminalNet.usedThisTick(room.name)) continue;
        if (!utils.storageRichState(room, Memory.rooms && Memory.rooms[room.name], config.upgrading || {})) continue;
        out.push(room);
    }
    return out;
}

function run(shed) {
    const cfg = settings();
    if (!cfg.enabled || !(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    if (!terminalNet.cpuAllows(cfg, shed)) return null;
    const market = marketApi();
    if (!market || typeof market.deal !== 'function' || typeof market.getAllOrders !== 'function') return null;
    const ordersBy = {};   // 一轮之内同一资源只查一次
    let scans = 0;
    let hold = null;
    try { hold = terminalNet.mineralHolds(); } catch (error) { utils.logErr('market.mineralHolds', error); hold = null; }
    for (const room of sellerRooms()) {
        for (const entry of sellable(room, cfg, hold)) {
            const avg = recentAvgPrice(entry.resource, cfg);
            if (avg == null) continue;
            if (!ordersBy[entry.resource]) {
                if (scans >= cfg.maxScans) continue;
                scans++;
                try { ordersBy[entry.resource] = market.getAllOrders({ type: BUY(), resourceType: entry.resource }) || []; }
                catch (error) { utils.logErr('market.getAllOrders', error); ordersBy[entry.resource] = []; }
            }
            const pick = pickBuyOrder(ordersBy[entry.resource], room, entry, cfg, avg * cfg.priceFloorShare);
            if (!pick) continue;
            const ret = market.deal(pick.order.id, pick.amount, room.name);
            terminalNet.markUsed(room.name);
            const record = { at: Game.time, room: room.name, resource: entry.resource, amount: pick.amount, cost: pick.cost,
                price: pick.order.price, effective: Math.round(pick.effective * 1000) / 1000, floor: Math.round(avg * cfg.priceFloorShare * 1000) / 1000, result: ret };
            const mem = Memory.market || (Memory.market = {});
            mem.last = record;
            if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
                mem.deals = (Number(mem.deals) || 0) + 1;
                mem.sold = (Number(mem.sold) || 0) + pick.amount;
            }
            return record;   // 一轮只做一笔
        }
    }
    return null;
}

module.exports = { run, settings, sellable, pickBuyOrder, recentAvgPrice, sellerRooms };
