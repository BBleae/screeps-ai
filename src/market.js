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
        tickCpuBudget: 5,         // 10-16：一轮 getAllOrders/挂单合计超过这么多 CPU 就停（单 tick 预算）
        priceBand: null,          // 设了就取代 priceFloorShare：卖 ≥ 均价×(1−band)、买 ≤ 均价×(1+band)
        keepBy: {},               // 按资源的保留量（覆盖 keep）；Infinity = 永不卖
        dailySellUnits: {},       // 按资源每日最多卖多少
        creditFloor: 0,           // credits 低于它只卖不买
        maxOrderCredits: Infinity,
        dailyBuyCredits: 0,
        buy: null,                // { resources: ['Z','X'], target: 3000, rooms: [...] }
        buyEnergy: null,
        ownOrders: null,
        dealBuyMinerals: true,
    }, config.market || {});
}

/** 当日账本（按 UTC 日切）：sold/bought 按资源计单位，soldCredits/buyCredits 计 credit；前一天留在 ledgerPrev */
function ledger() {
    const mem = Memory.market || (Memory.market = {});
    const day = Math.floor(Date.now() / 86400000);
    if (!mem.ledger || mem.ledger.day !== day) {
        if (mem.ledger) mem.ledgerPrev = mem.ledger;
        mem.ledger = { day, sold: {}, bought: {}, soldCredits: 0, buyCredits: 0, energyBuyCredits: 0, energyBuyByRoom: {}, deals: 0 };
    }
    return mem.ledger;
}

// 每种资源占当日买入额度的份额（cfg.buyShare：{ cap: {Z:0.4}, reserve: {O:0.2, X:0.2} }，2026-10-16）：
// cap = 该资源当日最多花 dailyBuyCredits × cap；reserve = 给该资源预留的份额，别的资源不得挤占它还没花掉的那部分
function buyShareOk(cfg, led, res, commit) {
    const sh = cfg.buyShare;
    if (!sh) return true;
    const by = led.buyBy || (led.buyBy = {});
    const total = cfg.dailyBuyCredits;
    const cap = sh.cap && sh.cap[res];
    if (cap != null && (by[res] || 0) + commit > total * cap) return false;
    let held = 0;
    for (const r in (sh.reserve || {})) if (r !== res) held += Math.max(0, total * sh.reserve[r] - (by[r] || 0));
    return led.buyCredits + commit + held <= total;
}
function noteBuyBy(led, res, credits) {
    const by = led.buyBy || (led.buyBy = {});
    by[res] = Math.max(0, Math.round((by[res] || 0) + credits));
}

function keepFor(resource, cfg) {
    const k = cfg.keepBy && cfg.keepBy[resource];
    return k != null ? Number(k) : cfg.keep;
}

function sellFloor(avg, cfg) {
    return cfg.priceBand != null ? avg * (1 - cfg.priceBand) : avg * cfg.priceFloorShare;
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
        const keep = keepFor(key, cfg);
        if (typeof amount !== 'number' || !(amount > keep)) continue;
        let can = amount - keep;
        const cap = cfg.dailySellUnits && cfg.dailySellUnits[key];
        if (cap != null) can = Math.min(can, Number(cap) - Number((ledger().sold || {})[key] || 0));
        if (can <= 0) continue;
        out.push({ resource: key, amount: can });
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
function sellerRooms(cfg) {
    cfg = cfg || settings();
    const out = [];
    for (const name of Object.keys(Game.rooms)) {
        const room = Game.rooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        const terminal = room.terminal;
        if (!terminal || terminal.my === false || !terminal.store || terminal.cooldown > 0) continue;
        if (terminalNet.usedThisTick(room.name)) continue;
        if (!cfg.anyRoom && !utils.storageRichState(room, Memory.rooms && Memory.rooms[room.name], config.upgrading || {})) {
            // storage 不富余的房也卖 deposit 产出（silicon/mist：不卖就只是堆着，factory 以后再说）；run() 里只卖这几种
            if (depositGoods(terminal.store).length) { room._depositOnly = true; out.push(room); }
            continue;
        }
        out.push(room);
    }
    return out;
}

function depositGoods(store) {
    const types = (config.deposit && config.deposit.enabled !== false && config.deposit.types) || [];
    return types.filter((t) => Number(store && store[t] || 0) > 0);
}

/** 买 labs 链缺的基础矿（cfg.buy.resources，默认只 Z/X）：credits ≥ creditFloor、当日买入 < dailyBuyCredits、
 *  单价 ≤ 均价×(1+priceBand)、单笔 ≤ maxOrderCredits；补到 target 为止。一轮最多一笔 */
function energyHave(room) {
    return Number(room.terminal.store[ENERGY] || 0) + Number((room.storage && room.storage.store[ENERGY]) || 0);
}

/** spawn 卡死：队头是经济 creep（矿工/hauler）且已等 ≥ emergencyWaitTicks */
function spawnStuckEconomy(room, waitTicks) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    const w = mem && mem.spawnWaiting;
    if (!w || !(w.cost > 0) || !w.since) return false;
    if (Game.time - Number(w.since) < waitTicks) return false;
    const role = String(w.role || '');
    return role === 'harvester' || role === 'hauler' || role === 'remoteHarvester' || role === 'remoteHauler';
}

/** 买能量：普通路径要求到手价 ≤ maxEffective（be.enabled）；救急路径只给 spawn 卡死房、按均价±priceBand、日量 emergencyDailyEnergy。一轮最多一笔 */
function tryBuyEnergy(cfg, market, countScan) {
    const be = cfg.buyEnergy;
    if (!be) return null;
    const emergencyOn = !!be.spawnStuckEmergency;
    if (!be.enabled && !emergencyOn) return null;
    if (!(Number(market.credits) >= cfg.creditFloor)) return null;
    const led = ledger();
    const left = cfg.dailyBuyCredits - led.buyCredits;
    // 10-16 战略：救急买能量（spawn 卡死）可以不占 dailyBuyCredits（be.emergencyOutsideDaily），只受 emergencyDailyEnergy 与 maxOrderCredits 约束，
    // 免得原料额度压低/花光后把救急路径一起误杀
    const emergOutside = !!be.emergencyOutsideDaily;
    if (!(left > 0) && !(emergencyOn && emergOutside)) return null;
    const waitTicks = Number(be.emergencyWaitTicks) || 200;
    const dailyEmerg = Number(be.emergencyDailyEnergy) || 10000;
    const emergBought = Number(led.boughtEnergyEmergency) || 0;
    const emergLeft = Math.max(0, dailyEmerg - emergBought);

    const candidates = [];
    if (be.enabled && left > 0) {
        const order = (config.terminalNetwork && config.terminalNetwork.priorityReceivers) || [];
        for (const n of order) {
            const r = Game.rooms[n];
            if (!r || !r.terminal || r.terminal.my === false || r.terminal.cooldown > 0) continue;
            if (terminalNet.usedThisTick(r.name)) continue;
            if (!(energyHave(r) < Number(be.belowEnergy || 10000))) continue;
            if (!(Number(r.terminal.store[ENERGY] || 0) > 0)) continue;
            candidates.push({ room: r, mode: 'normal' });
        }
    }
    if (emergencyOn && emergLeft >= (cfg.minDeal || 100) && (left > 0 || emergOutside)) {
        const names = Object.keys(Game.rooms || {});
        for (const n of names) {
            const r = Game.rooms[n];
            if (!r || !r.controller || !r.controller.my) continue;
            if (!r.terminal || r.terminal.my === false || r.terminal.cooldown > 0) continue;
            if (terminalNet.usedThisTick(r.name)) continue;
            if (!(Number(r.terminal.store[ENERGY] || 0) > 0)) continue;
            if (!spawnStuckEconomy(r, waitTicks)) continue;
            if (candidates.some((c) => c.room.name === r.name)) continue;
            candidates.push({ room: r, mode: 'emergency' });
        }
    }
    if (!candidates.length) return null;

    countScan();
    let orders = [];
    try { orders = market.getAllOrders({ type: typeof ORDER_SELL !== 'undefined' ? ORDER_SELL : 'sell', resourceType: ENERGY }) || []; }
    catch (error) { utils.logErr('market.getAllOrders', error); return null; }
    const costOf = (n, from, to) => (typeof market.calcTransactionCost === 'function' ? market.calcTransactionCost(n, from, to) : Math.ceil(n * 0.1));
    const avg = emergencyOn ? recentAvgPrice(ENERGY, cfg) : null;
    const emergCeil = avg != null && cfg.priceBand != null ? avg * (1 + cfg.priceBand) : null;

    let best = null;
    for (const cand of candidates) {
        const room = cand.room;
        const pay = Number(room.terminal.store[ENERGY] || 0);
        const maxAmt = cand.mode === 'emergency'
            ? Math.min(Number(be.maxAmount || 20000), emergLeft)
            : Number(be.maxAmount || 20000);
        for (const o of orders) {
            if (!o || o.resourceType !== ENERGY || !(o.amount > 0) || !(o.price > 0) || !o.roomName) continue;
            if (cand.mode === 'emergency') {
                if (emergCeil == null || o.price > emergCeil) continue;
            }
            const creditRoom = cand.mode === 'emergency' && emergOutside ? cfg.maxOrderCredits : Math.min(cfg.maxOrderCredits, left);
            let amount = Math.min(o.amount, maxAmt, Math.floor(creditRoom / o.price));
            while (amount >= cfg.minDeal && costOf(amount, o.roomName, room.name) > pay) amount = Math.floor(amount / 2);
            if (amount < cfg.minDeal) continue;
            const cost = costOf(amount, o.roomName, room.name);
            const net = amount - cost;
            if (net <= 0) continue;
            const eff = o.price * amount / net;
            if (cand.mode === 'normal' && eff > be.maxEffective) continue;
            if (!best || eff < best.eff) best = { room, o, amount, cost, eff, mode: cand.mode };
        }
        if (best && best.mode === 'normal') break;
    }
    if (!best) return null;
    const ret = market.deal(best.o.id, best.amount, best.room.name);
    terminalNet.markUsed(best.room.name);
    const rec = { at: Game.time, room: best.room.name, resource: ENERGY, amount: best.amount, cost: best.cost, price: best.o.price,
        effective: Math.round(best.eff * 100) / 100, buy: true, emergency: best.mode === 'emergency', result: ret };
    Memory.market.lastBuy = rec;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        led.bought[ENERGY] = (led.bought[ENERGY] || 0) + best.amount;
        if (!(best.mode === 'emergency' && emergOutside)) led.buyCredits = Math.round(led.buyCredits + best.amount * best.o.price);
        else led.emergencyCredits = Math.round((Number(led.emergencyCredits) || 0) + best.amount * best.o.price);
        if (best.mode === 'emergency') led.boughtEnergyEmergency = (Number(led.boughtEnergyEmergency) || 0) + best.amount;
        led.deals++;
    }
    return rec;
}

function tryBuy(cfg, market, countScan) {
    const e = tryBuyEnergy(cfg, market, countScan);
    if (e) return e;
    const b = cfg.buy;
    if (cfg.dealBuyMinerals === false) return null;
    if (!b || !Array.isArray(b.resources) || !b.resources.length || cfg.priceBand == null) return null;
    if (!(Number(market.credits) >= cfg.creditFloor)) return null;
    const led = ledger();
    const left = cfg.dailyBuyCredits - led.buyCredits;
    if (!(left > 0)) return null;
    const rooms = (b.rooms || []).map((n) => Game.rooms[n]).filter((r) => r && r.terminal && r.terminal.my !== false && !(r.terminal.cooldown > 0) && !terminalNet.usedThisTick(r.name));
    for (const room of rooms) {
        for (const res of b.resources) {
            const have = Number(room.terminal.store[res] || 0) + Number((room.storage && room.storage.store[res]) || 0);
            const want = Number(b.target || 3000) - have;
            if (want < cfg.minDeal) continue;
            const avg = recentAvgPrice(res, cfg);
            if (avg == null) continue;
            const ceil = avg * (1 + cfg.priceBand);
            countScan();
            let orders = [];
            try { orders = market.getAllOrders({ type: typeof ORDER_SELL !== 'undefined' ? ORDER_SELL : 'sell', resourceType: res }) || []; }
            catch (error) { utils.logErr('market.getAllOrders', error); }
            const energy = Number(room.terminal.store[ENERGY] || 0);
            const best = orders.filter((o) => o && o.resourceType === res && o.amount > 0 && o.price > 0 && o.price <= ceil && o.roomName)
                .sort((a, z) => a.price - z.price)[0];
            if (!best) continue;
            let amount = Math.min(want, best.amount, cfg.maxDeal, Math.floor(Math.min(cfg.maxOrderCredits, left) / best.price));
            const costOf = (n) => (typeof market.calcTransactionCost === 'function' ? market.calcTransactionCost(n, room.name, best.roomName) : Math.ceil(n * 0.1));
            while (amount >= cfg.minDeal && costOf(amount) > energy) amount = Math.floor(amount / 2);
            if (amount < cfg.minDeal) continue;
            if (!buyShareOk(cfg, led, res, amount * best.price)) continue;
            const ret = market.deal(best.id, amount, room.name);
            terminalNet.markUsed(room.name);
            const rec = { at: Game.time, room: room.name, resource: res, amount, price: best.price, ceil: Math.round(ceil * 1000) / 1000, buy: true, result: ret };
            const mem = Memory.market;
            mem.lastBuy = rec;
            if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
                led.bought[res] = (led.bought[res] || 0) + amount;
                led.buyCredits = Math.round(led.buyCredits + amount * best.price);
                noteBuyBy(led, res, amount * best.price);
                led.deals++;
            }
            return rec;
        }
    }
    return null;
}

// ---- 自挂单（2026-10-15 16:01）----
function ownSettings(cfg) { return cfg.ownOrders || null; }

function orderBook() {
    const mem = Memory.market || (Memory.market = {});
    return mem.orders || (mem.orders = {});
}

/** 同步自己的挂单：认领新挂出的单（createOrder 当 tick 拿不到 id）、按成交量记账、到期撤单、退回未成交的预占额度 */
function syncOrders(cfg, market) {
    const book = orderBook();
    const led = ledger();
    const live = market.orders || {};
    const claimed = new Set(Object.values(book).map((o) => o.id).filter(Boolean));
    for (const key of Object.keys(book)) {
        const o = book[key];
        if (!o.id) {
            const found = Object.values(live).find((x) => !claimed.has(x.id) && x.type === o.type && x.resourceType === o.resource && x.roomName === o.room);
            if (found) { o.id = found.id; claimed.add(found.id); }
            else if (Game.time - o.posted > 20) { delete book[key]; continue; }
            else continue;
        }
        const x = live[o.id];
        const left = x ? Number(x.remainingAmount) || 0 : 0;
        const filled = Math.max(0, (o.left != null ? o.left : o.amount) - left);
        if (filled > 0) {
            if (o.type === 'sell') {
                led.sold[o.resource] = (led.sold[o.resource] || 0) + filled;
                led.soldCredits = Math.round(led.soldCredits + filled * o.price);
            } else {
                led.bought[o.resource] = (led.bought[o.resource] || 0) + filled;
            }
            led.filled = (led.filled || 0) + filled;
        }
        o.left = left;
        const expired = Game.time >= o.expires;
        if (!x || left <= 0 || expired) {
            if (x && left > 0 && typeof market.cancelOrder === 'function') market.cancelOrder(o.id);
            if (o.type === 'buy' && left > 0) {
                if (o.resource === ENERGY) {   // 10-17：能量买单走单独额度，退款退回 energyBuyCredits 和 energyBuyByRoom[房]
                    led.energyBuyCredits = Math.max(0, Math.round((Number(led.energyBuyCredits) || 0) - left * o.price));
                    const by = led.energyBuyByRoom || (led.energyBuyByRoom = {});
                    if (by[o.room] != null) by[o.room] = Math.max(0, Math.round((Number(by[o.room]) || 0) - left * o.price));
                } else {
                    led.buyCredits = Math.max(0, Math.round(led.buyCredits - left * o.price));
                    if (o.day === led.day) noteBuyBy(led, o.resource, -left * o.price);
                }
            }
            delete book[key];
        }
    }
}

function postOrder(cfg, market, type, resource, room, price, amount, budget) {
    const own = ownSettings(cfg);
    const key = type + ':' + room + ':' + resource;
    const book = orderBook();
    if (book[key] || !(amount > 0) || !(price > 0)) return null;
    const led = ledger();
    const fee = price * amount * own.fee;
    const credits = Number(market.credits) || 0;
    // 10-17：带 budget 的买单（能量）走单独的 creditFloor / 日额度账本，不占普通 buyCredits/dailyBuyCredits
    const floor = budget ? Number(budget.floor) || cfg.creditFloor : cfg.creditFloor;
    if (credits - fee < floor) return null;
    if (type === 'buy') {
        const commit = price * amount + fee;
        if (budget) {
            const roomSpent = budget.roomKey ? (Number((led[budget.roomKey] || {})[room]) || 0) : 0;
            if (credits - commit < floor || (Number(led[budget.key]) || 0) + commit > Number(budget.cap)
                || (budget.roomCap > 0 && roomSpent + commit > budget.roomCap) || price * amount > cfg.maxOrderCredits) return null;
        } else {
            if (credits - commit < cfg.creditFloor || led.buyCredits + commit > cfg.dailyBuyCredits || price * amount > cfg.maxOrderCredits) return null;
            if (resource !== ENERGY && !buyShareOk(cfg, led, resource, commit)) return null;
        }
    } else if ((led.sellFees || 0) + fee > (Number(own.dailySellFeeCredits) || 0)) return null;
    const ret = market.createOrder({ type, resourceType: resource, price: Math.round(price * 1000) / 1000, totalAmount: amount, roomName: room });
    const rec = { at: Game.time, type, resource, room, price, amount, result: ret };
    Memory.market.lastOrder = rec;
    if (ret !== (typeof OK !== 'undefined' ? OK : 0)) return rec;
    if (type === 'buy') {
        if (budget) {
            led[budget.key] = Math.round((Number(led[budget.key]) || 0) + fee + price * amount);
            if (budget.roomKey) { const by = led[budget.roomKey] || (led[budget.roomKey] = {}); by[room] = Math.round((Number(by[room]) || 0) + fee + price * amount); }
        }
        else { led.buyCredits = Math.round(led.buyCredits + fee + price * amount); noteBuyBy(led, resource, fee + price * amount); }
    }
    else led.sellFees = Math.round((led.sellFees || 0) + fee);
    led.fees = Math.round((led.fees || 0) + fee);
    led.orders = (led.orders || 0) + 1;
    book[key] = { type, resource, room, price, amount, posted: Game.time, expires: Game.time + own.expireTicks, id: null, left: amount, day: led.day };
    return rec;
}

/** 每轮最多挂一张新单（createOrder 也是 CPU 档操作） */
function runOwnOrders(cfg, market) {
    const own = ownSettings(cfg);
    if (!own || !own.enabled || typeof market.createOrder !== 'function') return null;
    syncOrders(cfg, market);
    const book = orderBook();
    const band = cfg.priceBand != null ? cfg.priceBand : 0.15;
    const sold = ledger().sold || {};
    const b = cfg.buy;
    if (own.buyMinerals && b && Array.isArray(b.resources)) {
        for (const roomName of b.rooms || []) {
            const room = Game.rooms[roomName];
            if (!room || !room.terminal) continue;
            // 10-17：lab 被能量闸（labStorageReserve）挡住的房不补原料——只给在跑的 lab 链买
            let labsOk = true;
            try { labsOk = require('industry').labsAllowed(room); } catch (error) { labsOk = true; }
            if (!labsOk) continue;
            for (const res of b.resources) {
                if (book['buy:' + roomName + ':' + res]) continue;
                const have = Number(room.terminal.store[res] || 0) + Number((room.storage && room.storage.store[res]) || 0);
                const avg = recentAvgPrice(res, cfg);
                if (avg == null) continue;
                const amount = Math.min(Number(b.target || 3000) - have, Number(b.orderAmount) || Infinity, Math.floor(cfg.maxOrderCredits / avg));
                // 对方付传送，小单不亏；minDeal 500 × 均价超过单笔上限的资源（X）按上限截量照挂
                if (amount < Math.min(cfg.minDeal, Number(own.minBuyAmount) || cfg.minDeal)) continue;
                const r = postOrder(cfg, market, 'buy', res, roomName, avg, amount);
                if (r) return r;
            }
        }
    }
    const e = own.energy;
    if (e) {
        const eFloor = Number(e.creditFloor) || cfg.creditFloor;
        // 10-17：优先内部发送——preferSenders 里有带 terminal、storage+terminal 仍高于 terminalNetwork.sendAbove 的房时，
        // 本轮不市场买能量（让终端网络先发），等它发到跌破 sendAbove（发完/不够）再买
        const tn = config.terminalNetwork || {};
        const sendAbove = Number(tn.sendAbove) || 0;
        const senderReady = (e.preferSenders || []).some((n) => {
            const rm = Game.rooms[n];
            if (!rm || !rm.terminal || rm.terminal.my === false) return false;
            return energyHave(rm) > sendAbove;
        });
        if (!senderReady && Number(market.credits) >= eFloor) {
            const names = e.rooms === 'priorityReceivers' ? ((config.terminalNetwork || {}).priorityReceivers || []) : (e.rooms || []);
            const cap = Number(e.maxPrice) || 45;
            let price;
            if (e.followHighestBuy) {
                // 10-17：价格 = min(市场最高买价, maxPrice 45, 5 日均价 × (1+band 0.15))
                let buyOrders = [];
                try { buyOrders = market.getAllOrders({ type: BUY(), resourceType: ENERGY }) || []; }
                catch (error) { utils.logErr('market.energyBuy getAllOrders', error); buyOrders = []; }
                const top = buyOrders.reduce((m, o) => (o.amount > 0 && o.price > m ? o.price : m), 0);
                const eAvg = recentAvgPrice(ENERGY, cfg);
                const bandCeil = eAvg != null ? eAvg * (1 + band) : Infinity;
                price = top > 0 ? Math.min(top, cap, bandCeil) : 0;
            } else {
                const avg = recentAvgPrice(ENERGY, cfg);
                price = Math.min(Number(e.price) || 10, cap, avg != null ? avg * (1 + band) : Infinity);
            }
            const budget = { key: 'energyBuyCredits', cap: Number(e.dailyBuyCredits) || 0, floor: eFloor,
                roomKey: 'energyBuyByRoom', roomCap: Number(e.perRoomDailyCredits) || 0 };
            // 10-17：按最缺能优先（energyHave 升序），不再每轮都挑名单第一个房；每房单日上限 perRoomDailyCredits 由 postOrder 把超额房挡掉
            const below = Number(e.below || 10000);
            const candidates = (price > 0 ? names : []).filter((n) => {
                const room = Game.rooms[n];
                return room && room.terminal && !book['buy:' + n + ':' + ENERGY] && energyHave(room) < below;
            }).sort((a, b) => energyHave(Game.rooms[a]) - energyHave(Game.rooms[b]));
            for (const n of candidates) {
                const room = Game.rooms[n];
                const amount = Math.min(Number(e.amount) || 4500, Math.floor(cfg.maxOrderCredits / price), room.terminal.store.getFreeCapacity ? room.terminal.store.getFreeCapacity() : Infinity);
                if (amount < cfg.minDeal) continue;
                const r = postOrder(cfg, market, 'buy', ENERGY, n, price, amount, budget);
                if (r) return r;
            }
        }
    }
    for (const s of own.sell || []) {
        const room = Game.rooms[s.room];
        if (!room || !room.terminal || book['sell:' + s.room + ':' + s.resource]) continue;
        const have = Number(room.terminal.store[s.resource] || 0);
        let amount = have - keepFor(s.resource, cfg);
        const cap = cfg.dailySellUnits && cfg.dailySellUnits[s.resource];
        if (cap != null) amount = Math.min(amount, Number(cap) - Number(sold[s.resource] || 0));
        const avg = recentAvgPrice(s.resource, cfg);
        if (avg == null) continue;
        // 挂单费计入日额度：卖单量受剩余额度 / (价 × 费率) 限制
        amount = Math.min(amount, Math.floor(((Number(own.dailySellFeeCredits) || 0) - (ledger().sellFees || 0)) / (avg * own.fee)));
        if (amount < cfg.minDeal) continue;
        const r = postOrder(cfg, market, 'sell', s.resource, s.room, avg, Math.floor(amount));
        if (r) return r;
    }
    return null;
}

/** 10-17 军事 boost 买入（cfg.militaryBoost，默认关）：买现成 XZH2O/XGHO2/XLHO2 送进指定房 terminal，
 *  每种累计花费封顶 budgetEach，记进 ledger.militaryCredits，不占 dailyBuyCredits。一轮最多一笔。 */
function buyMilitaryBoosts(cfg, market) {
    const mb = cfg.militaryBoost;
    if (!mb || !mb.enabled || !Array.isArray(mb.compounds) || !mb.compounds.length) return null;
    if (!(Number(market.credits) >= cfg.creditFloor)) return null;
    const room = Game.rooms[mb.room];
    if (!room || !room.terminal || room.terminal.my === false || room.terminal.cooldown > 0 || terminalNet.usedThisTick(room.name)) return null;
    const led = ledger();
    const spentBy = led.militaryBy || (led.militaryBy = {});
    const amountEach = Math.max(0, Number(mb.amountEach) || 0);
    const budgetEach = Math.max(0, Number(mb.budgetEach) || 0);
    for (const res of mb.compounds) {
        const have = Number(room.terminal.store[res] || 0) + Number((room.storage && room.storage.store && room.storage.store[res]) || 0);
        if (have >= amountEach) continue;
        if ((spentBy[res] || 0) >= budgetEach) continue;
        let orders = [];
        try { orders = market.getAllOrders({ type: typeof ORDER_SELL !== 'undefined' ? ORDER_SELL : 'sell', resourceType: res }) || []; }
        catch (error) { utils.logErr('market.militaryBoost getAllOrders', error); continue; }
        const avg = recentAvgPrice(res, cfg);
        const ceil = avg != null && cfg.priceBand != null ? avg * (1 + cfg.priceBand) : Infinity;
        const viable = orders.filter((o) => o.amount > 0 && o.price <= ceil).sort((a, b) => a.price - b.price);
        if (!viable.length) continue;
        const o = viable[0];
        const budgetLeft = budgetEach - (spentBy[res] || 0);
        const maxByBudget = Math.floor(budgetLeft / o.price);
        const amount = Math.min(amountEach - have, o.amount, maxByBudget, Math.floor(cfg.maxOrderCredits / o.price));
        if (amount < cfg.minDeal) continue;
        const ret = market.deal(o.id, amount, room.name);
        terminalNet.markUsed(room.name);
        if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
            const cost = Math.round(amount * o.price);
            spentBy[res] = (spentBy[res] || 0) + cost;
            led.militaryCredits = Math.round((led.militaryCredits || 0) + cost);
            const mem = Memory.market || (Memory.market = {});
            mem.lastMilitary = { at: Game.time, resource: res, amount, cost, price: o.price, room: room.name };
        }
        return { result: ret, resource: res, amount };
    }
    return null;
}

function run(shed) {
    const cfg = settings();
    if (!cfg.enabled || !(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    if (!terminalNet.cpuAllows(cfg, shed)) return null;
    // 与 deposit 同一道 CPU 闸（近 10 条均值 ≤ 145、bucket ≥ 3000）
    try { const dep = require('deposit'); if (!dep.cpuOk(dep.settings())) return null; } catch (error) { /* 闸本身出错不挡市场 */ }
    const market = marketApi();
    if (!market || typeof market.deal !== 'function' || typeof market.getAllOrders !== 'function') return null;
    const tickBudget = Number(cfg.tickCpuBudget) || 0;
    const tickT0 = Game.cpu.getUsed();
    const overBudget = () => tickBudget > 0 && (Game.cpu.getUsed() - tickT0) >= tickBudget;
    const ordersBy = {};   // 一轮之内同一资源只查一次
    let scans = 0;
    let hold = null;
    try { hold = terminalNet.mineralHolds(); } catch (error) { utils.logErr('market.mineralHolds', error); hold = null; }
    let mil = null;
    try { mil = buyMilitaryBoosts(cfg, market); } catch (error) { utils.logErr('market.militaryBoost', error); }
    if (mil && mil.result === (typeof OK !== 'undefined' ? OK : 0)) return mil;
    let posted = null;
    try { posted = runOwnOrders(cfg, market); } catch (error) { utils.logErr('market.ownOrders', error); }
    if (posted && posted.result === (typeof OK !== 'undefined' ? OK : 0)) return posted;
    if (overBudget()) return posted;
    const bought = tryBuy(cfg, market, () => scans++);
    if (bought) return bought;
    if (overBudget()) return bought;
    const ownSell = new Set(((ownSettings(cfg) && ownSettings(cfg).enabled && ownSettings(cfg).sell) || []).map((s) => s.room + ':' + s.resource));
    for (const room of sellerRooms(cfg)) {
        for (const entry of sellable(room, cfg, hold)) {
            if (ownSell.has(room.name + ':' + entry.resource)) continue;   // 这份走自挂卖单
            if (room._depositOnly && depositGoods({ [entry.resource]: 1 }).length === 0) continue;
            const avg = recentAvgPrice(entry.resource, cfg);
            if (avg == null) continue;
            if (!ordersBy[entry.resource]) {
                if (scans >= cfg.maxScans || overBudget()) continue;
                scans++;
                try { ordersBy[entry.resource] = market.getAllOrders({ type: BUY(), resourceType: entry.resource }) || []; }
                catch (error) { utils.logErr('market.getAllOrders', error); ordersBy[entry.resource] = []; }
            }
            const pick = pickBuyOrder(ordersBy[entry.resource], room, entry, cfg, sellFloor(avg, cfg));
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
                const led = ledger();
                led.sold[entry.resource] = (led.sold[entry.resource] || 0) + pick.amount;
                led.soldCredits = Math.round(led.soldCredits + pick.amount * pick.order.price);
                led.deals++;
            }
            return record;   // 一轮只做一笔
        }
    }
    return null;
}

module.exports = { run, settings, sellable, pickBuyOrder, recentAvgPrice, sellerRooms, tryBuy, tryBuyEnergy, ledger, keepFor, runOwnOrders, syncOrders, buyMilitaryBoosts };
