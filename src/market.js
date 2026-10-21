'use strict';
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
        maxScans: 3,
        tickCpuBudget: 5,
        priceBand: null,
        keepBy: {},
        dailySellUnits: {},
        creditFloor: 0,
        maxOrderCredits: Infinity,
        dailyBuyCredits: 0,
        buy: null,
        buyEnergy: null,
        ownOrders: null,
        dealBuyMinerals: true,
    }, config.market || {});
}

function ledger() {
    const mem = Memory.market || (Memory.market = {});
    const day = Math.floor(Date.now() / 86400000);
    if (!mem.ledger || mem.ledger.day !== day) {
        if (mem.ledger) { mem.ledgerPrev = mem.ledger; closeSalesDay(mem, mem.ledger); }
        mem.ledger = { day, sold: {}, bought: {}, soldCredits: 0, buyCredits: 0, energyBuyCredits: 0, energyBuyByRoom: {}, deals: 0, mineralGross: 0, energySpent: 0, energyFees: 0 };
    }
    return mem.ledger;
}

function pendingDeals() {
    const mem = Memory.market || (Memory.market = {});
    return Array.isArray(mem.pendingDeals) ? mem.pendingDeals : (mem.pendingDeals = []);
}

function addPending(entry) {
    pendingDeals().push(Object.assign({ at: Game.time }, entry));
}

function pendingSum(kind, res) {
    let sum = 0;
    for (const p of pendingDeals()) {
        if (res != null && p.res !== res) continue;
        if (kind === 'buyCredits' && (p.kind === 'mineral' || (p.kind === 'energy' && !p.outside))) sum += p.amount * p.price;
        else if (kind === 'emergency' && p.kind === 'energy' && p.emergency) sum += p.amount;
        else if (kind === 'sold' && p.kind === 'sell') sum += p.amount;
        else if (kind === 'military' && p.kind === 'military') sum += p.amount * p.price;
    }
    return sum;
}

function applyDeal(led, p, amount) {
    const credits = amount * p.price;
    const mem = Memory.market || (Memory.market = {});
    if (p.kind === 'sell') {
        mem.deals = (Number(mem.deals) || 0) + 1;
        mem.sold = (Number(mem.sold) || 0) + amount;
        led.sold[p.res] = (led.sold[p.res] || 0) + amount;
        led.soldCredits = Math.round(led.soldCredits + credits);
        led.deals++;
        if (p.depth) {
            const rec = dailyBook(p.res);
            rec.sold = (rec.sold || 0) + amount;
            rec.deals = (rec.deals || 0) + 1;
        }
    } else if (p.kind === 'energy') {
        led.bought[p.res] = (led.bought[p.res] || 0) + amount;
        if (!p.outside) led.buyCredits = Math.round(led.buyCredits + credits);
        else led.emergencyCredits = Math.round((Number(led.emergencyCredits) || 0) + credits);
        if (p.emergency) led.boughtEnergyEmergency = (Number(led.boughtEnergyEmergency) || 0) + amount;
        led.deals++;
    } else if (p.kind === 'mineral') {
        led.bought[p.res] = (led.bought[p.res] || 0) + amount;
        led.buyCredits = Math.round(led.buyCredits + credits);
        noteBuyBy(led, p.res, credits);
        led.deals++;
    } else if (p.kind === 'military') {
        const spentBy = led.militaryBy || (led.militaryBy = {});
        const cost = Math.round(credits);
        spentBy[p.res] = (spentBy[p.res] || 0) + cost;
        led.militaryCredits = Math.round((led.militaryCredits || 0) + cost);
        mem.lastMilitary = { at: Game.time, resource: p.res, amount, cost, price: p.price, room: p.room };
    }
}

function confirmDeals(market) {
    const list = pendingDeals();
    if (!list.length) return 0;
    const led = ledger();
    const out = market && Array.isArray(market.outgoingTransactions) ? market.outgoingTransactions : [];
    const inc = market && Array.isArray(market.incomingTransactions) ? market.incomingTransactions : [];
    const used = new Set();
    const ttl = Math.max(1, Number(settings().dealConfirmTicks) || 20);
    const keep = [];
    let confirmed = 0;
    for (const p of list) {
        const txs = p.kind === 'sell' ? out : inc;
        const tx = txs.find((t) => t && !used.has(t.transactionId) && t.order && t.order.id === p.id && t.resourceType === p.res &&
            Number(t.time) >= Number(p.at) && (p.kind === 'sell' ? t.from === p.room : t.to === p.room));
        if (tx) {
            used.add(tx.transactionId);
            applyDeal(led, p, Math.min(Number(tx.amount) || 0, p.amount));
            confirmed++;
            continue;
        }
        if (Game.time - Number(p.at) > ttl) {
            const miss = led.dealUnconfirmed || (led.dealUnconfirmed = { n: 0, credits: 0 });
            miss.n++;
            miss.credits = Math.round(miss.credits + p.amount * p.price);
            miss.last = { at: p.at, kind: p.kind, res: p.res, amount: p.amount, price: p.price, room: p.room, id: p.id };
            continue;
        }
        keep.push(p);
    }
    Memory.market.pendingDeals = keep;
    return confirmed;
}

function utcKey(day) {
    return new Date(Number(day) * 86400000).toISOString().slice(0, 10);
}

function closeSalesDay(mem, led) {
    if (led.mineralGross == null || !(Number(led.day) > 0)) return null;
    const hist = mem.salesNet || (mem.salesNet = {});
    const gross = Math.round(Number(led.mineralGross) || 0);
    const fees = Math.round(Number(led.sellFees) || 0);
    hist[utcKey(led.day)] = { gross, fees, net: gross - fees, src: 'tx' };
    const keys = Object.keys(hist).sort();
    while (keys.length > 14) delete hist[keys.shift()];
    return hist[utcKey(led.day)];
}

function salesAvg(day, n) {
    const hist = (Memory.market && Memory.market.salesNet) || {};
    const days = [];
    let sum = 0;
    for (let i = 1; i <= n; i++) {
        const k = utcKey(Number(day) - i);
        const r = hist[k];
        if (r && Number.isFinite(Number(r.net))) { days.push(k); sum += Number(r.net); }
    }
    return { avg: n > 0 ? Math.round(sum / n) : 0, days };
}

function energyBudget(e) {
    const led = ledger();
    const b = (e && e.budget) || {};
    const n = Number(b.days) || 7;
    let eb = led.energyBudget;
    if (!(eb && eb.day === led.day && eb.div === n && eb.base != null)) {
        const s = salesAvg(led.day, n);
        const from = !(e && e.budget) ? Infinity : b.from ? Math.floor(Date.parse(b.from + 'T00:00:00Z') / 86400000) : 0;
        const legacy = !(led.day >= from);
        const lo = Number(b.min) || 0;
        const hi = Number(b.max) || Infinity;
        const base = legacy ? (Number(e && e.actualStopCredits) || Number(e && e.dailyBuyCredits) || 0) : Math.round(Math.min(hi, Math.max(lo, s.avg)));
        eb = led.energyBudget = { day: led.day, base, budget: base, salesAvg: s.avg, days: s.days, legacy, div: n };
    }
    const sold = Number(led.sold && led.sold.pixel) || 0;
    const credits = sold > 0 && !(e && e.pixelCredits === false) ? Math.round(sold * pixelPrice()) : 0;
    eb.pixels = Number(led.pixels) || 0;
    eb.pixelSold = sold;
    eb.pixelCredits = credits;
    const hi = Number(b.max) || Infinity;
    eb.budget = Math.min(hi, eb.base + credits);
    return eb;
}

function pixelPrice() {
    const mem = Memory.market || (Memory.market = {});
    const c = mem.pixelPx;
    if (c && Game.time - c.at < 1500) return Number(c.price) || 0;
    let price = c ? Number(c.price) || 0 : 0;
    try {
        const h = typeof Game !== 'undefined' && Game.market && typeof Game.market.getHistory === 'function' ? Game.market.getHistory(typeof PIXEL !== 'undefined' ? PIXEL : 'pixel') || [] : [];
        const last = h[h.length - 1];
        if (last && Number(last.avgPrice) > 0) price = Number(last.avgPrice);
    } catch (error) { utils.logErr('market.pixelPrice', error); }
    mem.pixelPx = { at: Game.time, price };
    return price;
}

function notePixel() {
    const led = ledger();
    led.pixels = (Number(led.pixels) || 0) + 1;
    return led.pixels;
}

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

const stockCache = { tick: -1, totals: {} };
function accountStock(resource) {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (stockCache.tick !== tick) { stockCache.tick = tick; stockCache.totals = {}; }
    if (stockCache.totals[resource] != null) return stockCache.totals[resource];
    let total = 0;
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller || !room.controller.my) continue;
        for (const holder of [room.storage, room.terminal]) {
            if (holder && holder.my !== false && holder.store) total += Number(holder.store[resource] || 0);
        }
    }
    stockCache.totals[resource] = total;
    return total;
}

function buyStopped(cfg, resource) {
    const cap = cfg.buy && cfg.buy.stopAbove && cfg.buy.stopAbove[resource];
    return cap != null && accountStock(resource) > Number(cap);
}

function buyCap(cfg, resource) {
    const cap = Number(cfg.buy && cfg.buy.maxPrice && cfg.buy.maxPrice[resource]);
    return cap > 0 ? cap : Infinity;
}

function keepFor(resource, cfg) {
    const k = cfg.keepBy && cfg.keepBy[resource];
    return k != null ? Number(k) : cfg.keep;
}

function roomKeepFor(room, resource, cfg) {
    const by = cfg.keepByRoom && room && cfg.keepByRoom[room.name];
    return by && by[resource] != null ? Number(by[resource]) : null;
}

function salesTrack(cfg, market) {
    const st = cfg.salesTrack;
    if (!st || !st.resource) return null;
    const mem = Memory.market || (Memory.market = {});
    const t = mem.salesTrack || (mem.salesTrack = { resource: st.resource, credits: 0, units: 0, deals: 0, last: 0, ids: [] });
    const txs = market && Array.isArray(market.outgoingTransactions) ? market.outgoingTransactions : [];
    const since = Number(st.since) || 0;
    const seen = new Set(t.ids || []);
    let last = Number(t.last) || 0;
    let ids = (t.ids || []).slice();
    for (const tx of txs) {
        if (!tx || tx.resourceType !== st.resource || !tx.order || !(Number(tx.order.price) > 0) || !(Number(tx.amount) > 0)) continue;
        const time = Number(tx.time) || 0;
        if (time < since || time < (Number(t.last) || 0)) continue;
        if (time === (Number(t.last) || 0) && seen.has(tx.transactionId)) continue;
        t.credits = Math.round(t.credits + Number(tx.amount) * Number(tx.order.price));
        t.units += Number(tx.amount);
        t.deals++;
        if (time > last) { last = time; ids = []; }
        if (time === last) ids.push(tx.transactionId);
    }
    t.last = last;
    t.ids = ids;
    return t;
}

function soldCredits() {
    const t = Memory.market && Memory.market.salesTrack;
    return t ? Number(t.credits) || 0 : 0;
}

function storageTotal() {
    let total = 0;
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller || !room.controller.my) continue;
        for (const holder of [room.storage, room.terminal]) {
            if (holder && holder.my !== false && holder.store) total += Number(holder.store[ENERGY] || 0);
        }
    }
    return total;
}

function trackStorage(every) {
    const mem = Memory.market || (Memory.market = {});
    const list = Array.isArray(mem.storageTrack) ? mem.storageTrack : (mem.storageTrack = []);
    const last = list[list.length - 1];
    if (last && Game.time - last[0] < (Number(every) || 500)) return list;
    const now = Date.now();
    list.push([Game.time, now, storageTotal()]);
    while (list.length && now - list[0][1] > 30 * 3600000) list.shift();
    return list;
}

function storageFalling(hours) {
    const list = (Memory.market && Memory.market.storageTrack) || [];
    if (list.length < 2) return null;
    const span = (Number(hours) || 24) * 3600000;
    const latest = list[list.length - 1];
    let ref = null;
    for (const row of list) { if (latest[1] - row[1] >= span) ref = row; else break; }
    if (!ref) return null;
    return latest[2] < ref[2];
}

function minEffectiveFor(resource, cfg) {
    const v = cfg.minEffective && cfg.minEffective[resource];
    return Number(v) > 0 ? Number(v) : null;
}

function sellFloorFor(resource, avg, cfg) {
    const min = minEffectiveFor(resource, cfg);
    if (min != null) return min;
    const share = cfg.minEffectiveShare && Number(cfg.minEffectiveShare[resource]);
    const abs = cfg.minPrice && Number(cfg.minPrice[resource]);
    let f;
    if (share > 0) f = avg == null ? null : avg * share;
    else f = avg == null ? null : sellFloor(avg, cfg);
    if (abs > 0) f = Math.max(f == null ? 0 : f, abs);
    return f;
}

function dailyVolume(resource, cfg) {
    const market = marketApi();
    if (!market || typeof market.getHistory !== 'function') return null;
    const mem = Memory.market || (Memory.market = {});
    const cache = mem.vol || (mem.vol = {});
    const hit = cache[resource];
    if (hit && Game.time - Number(hit.at || 0) < (Number(cfg.cacheTicks) || 500)) return hit.vol;
    let rows;
    try { rows = market.getHistory(resource); } catch (error) { return null; }
    const today = new Date().toISOString().slice(0, 10);
    const full = (Array.isArray(rows) ? rows : []).filter((r) => r && r.date !== today && Number(r.volume) > 0).slice(-7);
    const vol = full.length ? Math.round(full.reduce((s, r) => s + Number(r.volume), 0) / full.length) : null;
    cache[resource] = { at: Game.time, vol };
    return vol;
}

function energyPriceNow(cfg) {
    const fallback = Number(cfg.energyPrice) > 0 ? Number(cfg.energyPrice) : 44;
    const auto = cfg.energyPriceAuto;
    if (!auto) return fallback;
    const mem = Memory.market || (Memory.market = {});
    const hit = mem.energyPx;
    if (hit && Game.time - Number(hit.at || 0) < (Number(cfg.cacheTicks) || 500)) return Number(hit.price) || fallback;
    const market = marketApi();
    const txs = (market && Array.isArray(market.incomingTransactions)) ? market.incomingTransactions : [];
    const lookback = Number(auto.lookback) || 40000;
    let amount = 0;
    let credits = 0;
    for (const tx of txs) {
        if (!tx || tx.resourceType !== ENERGY || !tx.order || !(Number(tx.order.price) > 0) || !(Number(tx.amount) > 0)) continue;
        if (Game.time - Number(tx.time || 0) > lookback) continue;
        amount += Number(tx.amount);
        credits += Number(tx.amount) * Number(tx.order.price);
    }
    let price = fallback;
    let source = 'fallback';
    if (amount >= (Number(auto.minAmount) || 1000)) {
        const lo = Number(auto.min) || 5;
        const hi = Number(auto.max) || 200;
        price = Math.min(hi, Math.max(lo, credits / amount));
        source = 'tx';
    }
    mem.energyPx = { at: Game.time, price: Math.round(price * 1000) / 1000, amount, source };
    return price;
}

function sellFloor(avg, cfg) {
    return cfg.priceBand != null ? avg * (1 - cfg.priceBand) : avg * cfg.priceFloorShare;
}

function marketApi() {
    return (typeof Game !== 'undefined' && Game.market) || null;
}

function recentAvgPrice(resource, cfg) {
    const market = marketApi();
    if (!market || typeof market.getHistory !== 'function') return null;
    const mem = Memory.market || (Memory.market = {});
    const cache = mem.avg || (mem.avg = {});
    const entry = cache[resource];
    if (entry && Game.time - Number(entry.at || 0) < cfg.cacheTicks) return typeof entry.avg === 'number' ? entry.avg : null;
    let rows;
    try { rows = market.getHistory(resource); } catch (error) { return null; }
    let avg = null;
    if (Array.isArray(rows)) {
        const priced = rows.slice(-Math.max(1, cfg.historyDays)).filter((row) => row && typeof row.avgPrice === 'number' && row.avgPrice > 0);
        if (priced.length) avg = priced.reduce((sum, row) => sum + row.avgPrice, 0) / priced.length;
    }
    cache[resource] = { at: Game.time, avg };
    return avg;
}

function labUsedToday(resource) {
    const use = typeof Memory !== 'undefined' ? Memory.labUse : null;
    if (!use || use.day !== Math.floor(Date.now() / 86400000) || !use.used) return 0;
    return Math.max(0, Number(use.used[resource]) || 0);
}

function sellCapFor(resource, cfg) {
    let base = cfg.dailySellUnits && cfg.dailySellUnits[resource];
    const share = cfg.dailySellShare && Number(cfg.dailySellShare[resource]);
    if (share > 0) {
        const vol = dailyVolume(resource, cfg);
        if (vol != null) base = Math.floor(vol * share);
    }
    if (base == null) return null;
    const minus = Array.isArray(cfg.sellCapMinusLabUse) && cfg.sellCapMinusLabUse.indexOf(resource) >= 0;
    return Math.max(0, Number(base) - (minus ? labUsedToday(resource) : 0));
}

function sellStopped(resource, cfg) {
    const floor = cfg.sellStopAccountBelow && Number(cfg.sellStopAccountBelow[resource]);
    if (!(floor > 0)) return false;
    const total = accountStock(resource);
    const alerts = Memory.strategistAlerts || (Memory.strategistAlerts = {});
    const key = 'sellStop_' + resource;
    if (total < floor) {
        const rec = alerts[key];
        if (!rec || rec.clearedAt != null) alerts[key] = { at: Game.time, resource, total, floor, msg: resource + ' account stock below floor, selling stopped' };
        else rec.total = total;
        return true;
    }
    if (alerts[key] && alerts[key].clearedAt == null) { alerts[key].clearedAt = Game.time; alerts[key].total = total; }
    return false;
}

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
        const roomKeep = roomKeepFor(room, key, cfg);
        if (roomKeep != null) can = Math.min(can, amount + Number((room.storage && room.storage.store && room.storage.store[key]) || 0) - roomKeep);
        const accountKeep = cfg.keepAccount && cfg.keepAccount[key];
        if (accountKeep != null) can = Math.min(can, accountStock(key) - Number(accountKeep));
        if (sellStopped(key, cfg)) continue;
        const cap = sellCapFor(key, cfg);
        if (cap != null) can = Math.min(can, Number(cap) - Number((ledger().sold || {})[key] || 0) - pendingSum('sold', key));
        if (can <= 0) continue;
        out.push({ resource: key, amount: can });
    }
    return out.sort((a, b) => b.amount - a.amount);
}

function pickBuyOrder(orders, room, entry, cfg, floorPrice) {
    const market = marketApi();
    const terminalEnergy = Number((room.terminal.store || {})[ENERGY] || 0);
    let best = null;
    for (const order of orders || []) {
        if (!order || order.type !== BUY() || order.resourceType !== entry.resource) continue;
        if (!(order.amount > 0) || !(order.price > 0) || !order.roomName) continue;
        const amount = Math.min(entry.amount, order.amount, dealCap(entry.resource, cfg));
        if (amount < cfg.minDeal) continue;
        const cost = market && typeof market.calcTransactionCost === 'function'
            ? market.calcTransactionCost(amount, room.name, order.roomName)
            : Math.ceil(amount * 0.1);
        const effective = order.price - (cost / amount) * cfg.energyPrice;
        if (!(effective > 0)) continue;
        if (effective < floorPrice) continue;
        if (cost > terminalEnergy) continue;
        if (!best || effective > best.effective) best = { order, amount, cost, effective };
    }
    return best;
}

function dealCap(resource, cfg) {
    const v = cfg.maxDealBy && Number(cfg.maxDealBy[resource]);
    return v > 0 ? v : cfg.maxDeal;
}

function dayKey() {
    return new Date().toISOString().slice(0, 10);
}

function dailyBook(resource) {
    const mem = Memory.market || (Memory.market = {});
    const daily = mem.daily || (mem.daily = {});
    const key = dayKey();
    const day = daily[key] || (daily[key] = {});
    const keys = Object.keys(daily).sort();
    while (keys.length > 7) delete daily[keys.shift()];
    return day[resource] || (day[resource] = { depthMax: 0, depthLast: 0, best: 0, floor: 0, sold: 0, deals: 0, scans: 0 });
}

function recordDepth(resource, room, orders, floor, cfg) {
    const track = cfg.depthTrack;
    if (!Array.isArray(track) || !track.includes(resource)) return null;
    const market = marketApi();
    let units = 0;
    let best = 0;
    for (const order of orders || []) {
        if (!order || order.type !== BUY() || order.resourceType !== resource || !(order.amount > 0) || !order.roomName) continue;
        const probe = Math.min(order.amount, dealCap(resource, cfg));
        const cost = market && typeof market.calcTransactionCost === 'function' ? market.calcTransactionCost(probe, room.name, order.roomName) : Math.ceil(probe * 0.1);
        const effective = order.price - (cost / probe) * cfg.energyPrice;
        if (effective > best) best = effective;
        if (effective >= floor) units += order.amount;
    }
    const rec = dailyBook(resource);
    rec.depthLast = units;
    rec.depthMax = Math.max(rec.depthMax || 0, units);
    rec.best = Math.round(best * 1000) / 1000;
    rec.floor = Math.round(floor * 1000) / 1000;
    rec.scans = (rec.scans || 0) + 1;
    rec.at = Game.time;
    return rec;
}

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

function energyHave(room) {
    return Number(room.terminal.store[ENERGY] || 0) + Number((room.storage && room.storage.store[ENERGY]) || 0);
}

function spawnStuckEconomy(room, waitTicks) {
    const mem = Memory.rooms && Memory.rooms[room.name];
    const w = mem && mem.spawnWaiting;
    if (!w || !(w.cost > 0) || !w.since) return false;
    if (Game.time - Number(w.since) < waitTicks) return false;
    const role = String(w.role || '');
    return role === 'harvester' || role === 'hauler' || role === 'remoteHarvester' || role === 'remoteHauler';
}

function tryBuyEnergy(cfg, market, countScan) {
    const be = cfg.buyEnergy;
    if (!be) return null;
    const emergencyOn = !!be.spawnStuckEmergency;
    if (!be.enabled && !emergencyOn) return null;
    if (!(Number(market.credits) >= cfg.creditFloor)) return null;
    const led = ledger();
    const left = cfg.dailyBuyCredits - led.buyCredits - pendingSum('buyCredits');
    const emergOutside = !!be.emergencyOutsideDaily;
    if (!(left > 0) && !(emergencyOn && emergOutside)) return null;
    const waitTicks = Number(be.emergencyWaitTicks) || 200;
    const dailyEmerg = Number(be.emergencyDailyEnergy) || 10000;
    const emergBought = (Number(led.boughtEnergyEmergency) || 0) + pendingSum('emergency');
    const emergLeft = Math.max(0, dailyEmerg - emergBought);

    const candidates = [];
    if (be.enabled && left > 0) {
        const order = terminalNet.priorityList();
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
        addPending({ kind: 'energy', id: best.o.id, room: best.room.name, res: ENERGY, amount: best.amount, price: best.o.price,
            emergency: best.mode === 'emergency', outside: best.mode === 'emergency' && emergOutside });
    }
    return rec;
}

function buyRoomOk(b, roomName, res) {
    const only = b && b.onlyRooms && b.onlyRooms[res];
    return !Array.isArray(only) || only.indexOf(roomName) >= 0;
}

function tryBuy(cfg, market, countScan) {
    const e = tryBuyEnergy(cfg, market, countScan);
    if (e) return e;
    const b = cfg.buy;
    if (cfg.dealBuyMinerals === false) return null;
    if (!b || !Array.isArray(b.resources) || !b.resources.length || cfg.priceBand == null) return null;
    if (!(Number(market.credits) >= cfg.creditFloor)) return null;
    const led = ledger();
    const left = cfg.dailyBuyCredits - led.buyCredits - pendingSum('buyCredits');
    if (!(left > 0)) return null;
    const rooms = (b.rooms || []).map((n) => Game.rooms[n]).filter((r) => r && r.terminal && r.terminal.my !== false && !(r.terminal.cooldown > 0) && !terminalNet.usedThisTick(r.name));
    for (const room of rooms) {
        for (const res of b.resources) {
            if (buyStopped(cfg, res) || !buyRoomOk(b, room.name, res)) continue;
            const have = Number(room.terminal.store[res] || 0) + Number((room.storage && room.storage.store[res]) || 0);
            const want = Number(b.target || 3000) - have;
            if (want < cfg.minDeal) continue;
            const avg = recentAvgPrice(res, cfg);
            if (avg == null) continue;
            const ceil = Math.min(avg * (1 + cfg.priceBand), buyCap(cfg, res));
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
                addPending({ kind: 'mineral', id: best.id, room: room.name, res, amount, price: best.price });
            }
            return rec;
        }
    }
    return null;
}

function ownSettings(cfg) { return cfg.ownOrders || null; }

function orderBook() {
    const mem = Memory.market || (Memory.market = {});
    return mem.orders || (mem.orders = {});
}

function energyActual(led, spent, fees) {
    if (spent) led.energySpent = Math.round((Number(led.energySpent) || 0) + spent);
    if (fees) led.energyFees = Math.round((Number(led.energyFees) || 0) + fees);
    return (Number(led.energySpent) || 0) + (Number(led.energyFees) || 0);
}

function scanTx(cursorKey, txs, fn) {
    const mem = Memory.market || (Memory.market = {});
    const st = mem[cursorKey];
    if (!st || !(Number(st.time) > 0)) {
        mem[cursorKey] = { time: Game.time, ids: txs.filter((t) => t && Number(t.time) === Game.time).map((t) => t.transactionId) };
        return;
    }
    const seen = new Set(st.ids || []);
    let top = Number(st.time);
    let topIds = (st.ids || []).slice();
    for (const t of txs) {
        if (!t || Number(t.time) < Number(st.time)) continue;
        if (Number(t.time) === Number(st.time) && seen.has(t.transactionId)) continue;
        if (Number(t.time) > top) { top = Number(t.time); topIds = []; }
        if (Number(t.time) === top) topIds.push(t.transactionId);
        fn(t);
    }
    mem[cursorKey] = { time: top, ids: topIds };
}

function txCredits(t) {
    if (!t || !t.order || !(Number(t.order.price) > 0) || !(Number(t.amount) > 0)) return 0;
    return Number(t.amount) * Number(t.order.price);
}

function scanEnergyTx(led, market) {
    const txs = (market && Array.isArray(market.incomingTransactions)) ? market.incomingTransactions : [];
    let added = 0;
    scanTx('energyTx', txs, (t) => {
        const c = t.resourceType === ENERGY ? txCredits(t) : 0;
        if (!c) return;
        added += c;
        led.energyTxCount = (Number(led.energyTxCount) || 0) + 1;
        if (t.order.type === 'sell') led.energyDealCredits = Math.round((Number(led.energyDealCredits) || 0) + c);
    });
    if (added) { energyActual(led, added, 0); led.energyTxAt = Game.time; }
    return added;
}

function scanSalesTx(led, market) {
    const txs = (market && Array.isArray(market.outgoingTransactions)) ? market.outgoingTransactions : [];
    let added = 0;
    scanTx('salesTx', txs, (t) => {
        const c = t.resourceType !== ENERGY ? txCredits(t) : 0;
        if (c) added += c;
    });
    if (added) led.mineralGross = Math.round((Number(led.mineralGross) || 0) + added);
    return added;
}

function openEnergyBuys(market) {
    return Object.values((market && market.orders) || {}).filter((x) => x && x.type === BUY() && x.resourceType === ENERGY && Number(x.remainingAmount) > 0);
}

function energyStopCheck(e, market) {
    const led = ledger();
    const ok = typeof OK !== 'undefined' ? OK : 0;
    const cancelAll = (open) => { let n = 0; for (const x of open) if (market && typeof market.cancelOrder === 'function' && market.cancelOrder(x.id) === ok) n++; return n; };
    if (led.energyStopped) {
        const left = openEnergyBuys(market);
        if (left.length) led.energyStopped.recancelled = (Number(led.energyStopped.recancelled) || 0) + cancelAll(left);
        return true;
    }
    const stop = Number(energyBudget(e).budget) || 0;
    if (!(stop > 0)) return false;
    const actual = energyActual(led, 0, 0);
    const open = openEnergyBuys(market);
    const biggest = open.reduce((m, x) => Math.max(m, Number(x.remainingAmount) * Number(x.price) || 0), 0);
    const margin = Math.max(Number(e.actualStopMargin) || 0, biggest);
    led.energyStopAt = Math.round(stop - margin);
    if (actual + margin < stop) return false;
    const cancelled = cancelAll(open);
    const rec = { at: Game.time, actual, spent: Number(led.energySpent) || 0, fees: Number(led.energyFees) || 0, stop, margin: Math.round(margin), open: open.length, cancelled };
    led.energyStopped = rec;
    const mem = Memory.market || (Memory.market = {});
    const daily = mem.daily || (mem.daily = {});
    const day = daily[dayKey()] || (daily[dayKey()] = {});
    day.energyStop = rec;
    return true;
}

function guardTick() {
    const cfg = settings();
    const own = ownSettings(cfg);
    const e = own && own.energy;
    const market = marketApi();
    if (market) { try { confirmDeals(market); } catch (error) { utils.logErr('market.confirmDeals', error); } }
    if (!e || !market) return false;
    const led = ledger();
    scanEnergyTx(led, market);
    scanSalesTx(led, market);
    const stopped = energyStopCheck(e, market);
    const b = energyBudget(e);
    const mem = Memory.market || (Memory.market = {});
    const daily = mem.daily || (mem.daily = {});
    const day = daily[dayKey()] || (daily[dayKey()] = {});
    day.energyBudget = { budget: b.budget, actual: energyActual(led, 0, 0), salesAvg7: b.salesAvg, salesDays: b.days, legacy: b.legacy };
    return stopped;
}

function trackOrphanEnergy(led, live, book, claimed) {
    const mem = Memory.market || (Memory.market = {});
    const reg = mem.orphanEnergy || (mem.orphanEnergy = {});
    const pending = new Set(Object.values(book).filter((o) => !o.id && o.type === 'buy' && o.resource === ENERGY).map((o) => o.room));
    const dayStart = Number(led.day) * 86400000;
    const by = led.energyBuyByRoom || (led.energyBuyByRoom = {});
    const charge = (room, credits) => {
        led.energyBuyCredits = Math.max(0, Math.round((Number(led.energyBuyCredits) || 0) + credits));
        by[room] = Math.max(0, Math.round((Number(by[room]) || 0) + credits));
    };
    const seen = new Set();
    for (const x of Object.values(live)) {
        if (!x || claimed.has(x.id) || x.type !== BUY() || x.resourceType !== ENERGY) continue;
        const left = Math.max(0, Number(x.remainingAmount) || 0);
        let r = reg[x.id];
        if (!r) {
            if (left <= 0 || pending.has(x.roomName) || Game.time - Number(x.created) < 50) continue;
            const today = Number(x.createdTimestamp) >= dayStart;
            r = reg[x.id] = { room: x.roomName, price: x.price, left, at: Game.time, day: led.day };
            if (!today) charge(x.roomName, left * x.price);
        } else if (r.day !== led.day) {
            charge(r.room, r.left * r.price);
            if (r.released != null && r.day == null) led.orphanRestored = Math.round((Number(led.orphanRestored) || 0) + r.left * r.price);
            delete r.released;
            r.day = led.day;
        }
        seen.add(x.id);
        const filled = Math.max(0, r.left - left);
        if (filled > 0) {
            led.bought[ENERGY] = (led.bought[ENERGY] || 0) + filled;
            led.orphanFilled = (Number(led.orphanFilled) || 0) + filled;
            led.filled = (led.filled || 0) + filled;
            r.left = left;
        }
    }
    for (const id of Object.keys(reg)) {
        if (seen.has(id)) continue;
        const r = reg[id];
        if (r.day === led.day && r.left > 0 && !live[id]) charge(r.room, -r.left * r.price);
        delete reg[id];
    }
}

function cancelStaleOrphans(e, market, price) {
    const rule = e && e.orphanCancel;
    if (!rule || !(price > 0) || typeof market.cancelOrder !== 'function') return 0;
    const reg = (Memory.market && Memory.market.orphanEnergy) || {};
    const maxAge = (Number(rule.ageHours) || 6) * 3600000;
    const now = Date.now();
    const ok = typeof OK !== 'undefined' ? OK : 0;
    let n = 0;
    for (const id of Object.keys(reg)) {
        const x = (market.orders || {})[id];
        if (!x || !(Number(x.remainingAmount) > 0) || !(Number(x.price) < price)) continue;
        const born = Number(x.createdTimestamp);
        if (!(born > 0) || now - born < maxAge) continue;
        if (market.cancelOrder(id) === ok) n++;
    }
    if (n) {
        const led = ledger();
        led.orphanCancelled = { at: Game.time, n: (Number(led.orphanCancelled && led.orphanCancelled.n) || 0) + n, price };
    }
    return n;
}

function roomEnergyOpen(market, roomName) {
    return Object.values((market && market.orders) || {}).filter((x) => x && x.type === BUY() && x.resourceType === ENERGY &&
        x.roomName === roomName && Number(x.remainingAmount) > 0);
}

function syncOrders(cfg, market) {
    const book = orderBook();
    const led = ledger();
    const live = market.orders || {};
    const claimed = new Set(Object.values(book).map((o) => o.id).filter(Boolean));
    if ((ownSettings(cfg) || {}).energy && (ownSettings(cfg).energy.orphanLedger !== false)) trackOrphanEnergy(led, live, book, claimed);
    if (typeof market.cancelOrder === 'function') {
        let swept = 0;
        for (const x of Object.values(live)) {
            if (swept >= 10) break;
            if (claimed.has(x.id) || Number(x.remainingAmount) > 0) continue;
            market.cancelOrder(x.id);
            swept++;
        }
        if (swept) led.swept = (led.swept || 0) + swept;
    }
    for (const key of Object.keys(book)) {
        const o = book[key];
        if (!o.id) {
            const found = Object.values(live).filter((x) => !claimed.has(x.id) && x.type === o.type && x.resourceType === o.resource && x.roomName === o.room &&
                Number(x.remainingAmount) > 0 && !(Number(x.created) < Number(o.posted)))
                .sort((p, q) => (Number(q.created) || 0) - (Number(p.created) || 0))[0];
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
        const expired = Game.time >= o.expires || (o.type === 'buy' && (buyStopped(cfg, o.resource) || o.price > buyCap(cfg, o.resource)));
        if (!x || left <= 0 || expired) {
            if (x && left > 0 && typeof market.cancelOrder === 'function') market.cancelOrder(o.id);
            if (o.type === 'buy' && left > 0) {
                if (o.resource === ENERGY) {
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
    trackOrphanSell(led, live, book, claimed);
}

function sellListAllowed(cfg, resource, room) {
    if (Array.isArray(cfg.dealOnly) && cfg.dealOnly.includes(resource)) return false;
    const own = ownSettings(cfg) || {};
    return (own.sell || []).some((s) => s && s.resource === resource && s.room === room);
}

function trackOrphanSell(led, live, book, claimed) {
    const mem = Memory.market || (Memory.market = {});
    const reg = mem.orphanSell || (mem.orphanSell = {});
    const pending = new Set(Object.values(book).filter((o) => !o.id && o.type === 'sell').map((o) => o.room + ':' + o.resource));
    const sold = led.sold || (led.sold = {});
    for (const x of Object.values(live)) {
        if (!x || claimed.has(x.id) || x.type !== 'sell' || x.resourceType === ENERGY) continue;
        if (pending.has(x.roomName + ':' + x.resourceType)) continue;
        const left = Math.max(0, Number(x.remainingAmount) || 0);
        const r = reg[x.id];
        if (!r) {
            reg[x.id] = { room: x.roomName, resource: x.resourceType, price: x.price, left, at: Game.time };
            led.orphanSellSeen = { at: Game.time, id: x.id, room: x.roomName, resource: x.resourceType, price: x.price, left };
            continue;
        }
        const filled = Math.max(0, Number(r.left) - left);
        if (filled > 0) {
            sold[r.resource] = (sold[r.resource] || 0) + filled;
            led.soldCredits = Math.round((Number(led.soldCredits) || 0) + filled * Number(x.price));
            led.orphanSold = (Number(led.orphanSold) || 0) + filled;
            led.filled = (led.filled || 0) + filled;
        }
        r.left = left;
        r.price = x.price;
    }
    for (const id of Object.keys(reg)) if (!live[id] || claimed.has(id)) delete reg[id];
}

function postOrder(cfg, market, type, resource, room, price, amount, budget) {
    const own = ownSettings(cfg);
    const key = type + ':' + room + ':' + resource;
    const book = orderBook();
    if (book[key] || !(amount > 0) || !(price > 0)) return null;
    if (type === 'sell' && Array.isArray(cfg.neverSell) && cfg.neverSell.indexOf(resource) >= 0) return null;
    const led = ledger();
    if (type === 'buy' && resource === ENERGY && roomEnergyOpen(market, room).length) {
        led.energyOpenBlocked = { at: Game.time, room, open: roomEnergyOpen(market, room).length };
        return null;
    }
    const fee = price * amount * own.fee;
    const credits = Number(market.credits) || 0;
    const floor = budget ? Number(budget.floor) || cfg.creditFloor : cfg.creditFloor;
    if (credits - fee < floor) return null;
    if (type === 'buy') {
        const commit = price * amount + fee;
        if (budget) {
            const roomSpent = budget.roomKey ? (Number((led[budget.roomKey] || {})[room]) || 0) : 0;
            if (credits - commit < floor || (Number(led[budget.key]) || 0) + commit > Number(budget.cap)
                || (budget.roomCap > 0 && roomSpent + commit > budget.roomCap) || price * amount > (budget.maxCredits != null ? budget.maxCredits : cfg.maxOrderCredits)) return null;
        } else {
            if (credits - commit < cfg.creditFloor || led.buyCredits + commit > cfg.dailyBuyCredits || price * amount > cfg.maxOrderCredits) return null;
            if (resource !== ENERGY && !buyShareOk(cfg, led, resource, commit)) return null;
        }
    } else if (!sellListAllowed(cfg, resource, room)) {
        led.sellBlocked = { at: Game.time, resource, room, amount, price: Math.round(price * 1000) / 1000 };
        return null;
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
    if (type === 'buy' && resource === ENERGY) energyActual(led, 0, fee);
    led.fees = Math.round((led.fees || 0) + fee);
    led.orders = (led.orders || 0) + 1;
    book[key] = { type, resource, room, price, amount, posted: Game.time, expires: Game.time + own.expireTicks, id: null, left: amount, day: led.day };
    return rec;
}

function chargeEnergy(led, budget, roomName, credits) {
    led[budget.key] = Math.max(0, Math.round((Number(led[budget.key]) || 0) + credits));
    if (budget.roomKey) {
        const by = led[budget.roomKey] || (led[budget.roomKey] = {});
        by[roomName] = Math.max(0, Math.round((Number(by[roomName]) || 0) + credits));
    }
}

function dailyEnergyUnits(cfg, market, budget, room, price, fee) {
    const led = ledger();
    const roomSpent = budget.roomKey ? Number((led[budget.roomKey] || {})[room.name]) || 0 : 0;
    const left = Math.min(
        Number(budget.cap) - (Number(led[budget.key]) || 0),
        budget.roomCap > 0 ? budget.roomCap - roomSpent : Infinity,
        (Number(market.credits) || 0) - (Number(budget.floor) || 0));
    const free = room.terminal.store && typeof room.terminal.store.getFreeCapacity === 'function' ? Number(room.terminal.store.getFreeCapacity()) : Infinity;
    if (!(left > 0) || !(price > 0)) return 0;
    return Math.max(0, Math.min(Math.floor(left / (price * (1 + fee))), free));
}

function storageFull(room, e) {
    const max = Number(e && e.storageMax) || 0;
    return max > 0 && !!room.storage && Number(room.storage.store[ENERGY] || 0) > max;
}

function roomCapped(led, budget, roomName) {
    if (!(budget.roomCap > 0) || !budget.roomKey) return false;
    const spent = Number((led[budget.roomKey] || {})[roomName]) || 0;
    if (spent < budget.roomCap) return false;
    const capped = led.energyCapped || (led.energyCapped = {});
    capped[roomName] = { at: Game.time, spent };
    return true;
}

function runDailyEnergy(cfg, market, e, names, price, budget, below, book) {
    const own = ownSettings(cfg);
    const fee = Number(own.fee) || 0.05;
    const led = ledger();
    const okCode = typeof OK !== 'undefined' ? OK : 0;
    const step = Math.max(0.001, Number(e.repriceStep) || 0.01);
    const sizing = Math.max(price, Number(e.maxPrice) || 0);
    let last = null;
    for (const n of names) {
        const room = Game.rooms[n];
        if (!room || !room.terminal) continue;
        const key = 'buy:' + n + ':' + ENERGY;
        const o = book[key];
        if (o) {
            if (!o.id) continue;
            if (!o.daily) { o.daily = true; o.expires = Game.time + 10000000; }
            const left = Math.max(0, Number(o.left) || 0);
            if (o.day !== led.day) { chargeEnergy(led, budget, n, left * o.price); o.day = led.day; }
            if (roomCapped(led, budget, n)) continue;
            if (price > 0 && Math.abs(price - o.price) >= step && typeof market.changeOrderPrice === 'function') {
                const delta = price - o.price;
                const extra = delta * left + Math.max(0, delta) * left * fee;
                const roomSpent = Number((led[budget.roomKey] || {})[n]) || 0;
                const fits = delta < 0 || ((Number(led[budget.key]) || 0) + extra <= Number(budget.cap) &&
                    !(budget.roomCap > 0 && roomSpent + extra > budget.roomCap) && (Number(market.credits) || 0) - extra >= Number(budget.floor));
                if (fits) {
                    const ret = market.changeOrderPrice(o.id, Math.round(price * 1000) / 1000);
                    last = { at: Game.time, type: 'reprice', resource: ENERGY, room: n, from: o.price, price, left, result: ret };
                    Memory.market.lastReprice = last;
                    if (ret === okCode) {
                        chargeEnergy(led, budget, n, extra);
                        if (delta > 0) { led.fees = Math.round((led.fees || 0) + delta * left * fee); energyActual(led, 0, delta * left * fee); }
                        led.reprices = (led.reprices || 0) + 1;
                        o.price = price;
                    }
                }
            }
            if (energyHave(room) < below && !storageFull(room, e) && typeof market.extendOrder === 'function') {
                const want = dailyEnergyUnits(cfg, market, budget, room, sizing, fee);
                if (want >= cfg.minDeal) {
                    const ret = market.extendOrder(o.id, want);
                    last = { at: Game.time, type: 'extend', resource: ENERGY, room: n, price: o.price, amount: want, result: ret };
                    Memory.market.lastExtend = last;
                    if (ret === okCode) {
                        chargeEnergy(led, budget, n, want * o.price * (1 + fee));
                        led.fees = Math.round((led.fees || 0) + want * o.price * fee);
                        energyActual(led, 0, want * o.price * fee);
                        o.amount = (Number(o.amount) || 0) + want;
                        o.left = left + want;
                    }
                }
            }
            continue;
        }
        if (!(price > 0) || energyHave(room) >= below) continue;
        if (storageFull(room, e)) { (led.energyStorageFull || (led.energyStorageFull = {}))[n] = Game.time; continue; }
        if (roomCapped(led, budget, n)) continue;
        const amount = dailyEnergyUnits(cfg, market, budget, room, sizing, fee);
        if (amount < cfg.minDeal) continue;
        const r = postOrder(cfg, market, 'buy', ENERGY, n, price, amount, budget);
        if (r && book[key]) { book[key].daily = true; book[key].expires = Game.time + 10000000; }
        if (r) last = r;
    }
    return last;
}

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
            let labsOk = true;
            try { labsOk = require('industry').labsAllowed(room); } catch (error) { labsOk = true; }
            if (!labsOk) continue;
            for (const res of b.resources) {
                if (book['buy:' + roomName + ':' + res] || buyStopped(cfg, res) || !buyRoomOk(b, roomName, res)) continue;
                const have = Number(room.terminal.store[res] || 0) + Number((room.storage && room.storage.store[res]) || 0);
                const avg = recentAvgPrice(res, cfg);
                if (avg == null) continue;
                const price = Math.min(avg, buyCap(cfg, res));
                const amount = Math.min(Number(b.target || 3000) - have, Number(b.orderAmount) || Infinity, Math.floor(cfg.maxOrderCredits / price));
                if (amount < Math.min(cfg.minDeal, Number(own.minBuyAmount) || cfg.minDeal)) continue;
                const r = postOrder(cfg, market, 'buy', res, roomName, price, amount);
                if (r) return r;
            }
        }
    }
    const e = own.energy;
    const paused = !!(Memory.market && Memory.market.energyPause);
    if (paused) Memory.market.energyPauseSeen = Game.time;
    const stopped = !!e && energyStopCheck(e, market);
    if (e && !paused && !stopped) {
        const eFloor = Number(e.creditFloor) || cfg.creditFloor;
        const tn = config.terminalNetwork || {};
        const sendAbove = Number(tn.sendAbove) || 0;
        const senderReady = (e.preferSenders || []).some((n) => {
            const rm = Game.rooms[n];
            if (!rm || !rm.terminal || rm.terminal.my === false) return false;
            return energyHave(rm) > sendAbove;
        });
        if (!senderReady && Number(market.credits) >= eFloor) {
            const names = e.rooms === 'priorityReceivers' ? terminalNet.priorityList() : (e.rooms || []);
            const cap = Number(e.maxPrice) || 45;
            let price;
            if (e.followHighestBuy) {
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
            cancelStaleOrphans(e, market, price);
            const budget = { key: 'energyBuyCredits', cap: energyBudget(e).budget, floor: eFloor,
                roomKey: 'energyBuyByRoom', roomCap: Number(e.perRoomDailyCredits) || 0 };
            const below = Number(e.below || 10000);
            if (e.dailyOrder) {
                const r = runDailyEnergy(cfg, market, e, names, price, Object.assign(budget, { maxCredits: Infinity }), below, book);
                if (r) return r;
            } else {
                const candidates = (price > 0 ? names : []).filter((n) => {
                    const room = Game.rooms[n];
                    return room && room.terminal && !book['buy:' + n + ':' + ENERGY] && energyHave(room) < below && !storageFull(room, e);
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
    }
    for (const s of own.sell || []) {
        const room = Game.rooms[s.room];
        if (!room || !room.terminal) continue;
        const follow = (own.sellFollow || {})[s.resource];
        const held = book['sell:' + s.room + ':' + s.resource];
        if (held) {
            if (follow && held.id) {
                const r = repriceSell(cfg, market, held, s.resource, follow);
                if (r) return r;
            }
            continue;
        }
        const have = Number(room.terminal.store[s.resource] || 0);
        let amount = have - keepFor(s.resource, cfg);
        if (sellStopped(s.resource, cfg)) continue;
        const cap = sellCapFor(s.resource, cfg);
        if (cap != null) amount = Math.min(amount, Number(cap) - Number(sold[s.resource] || 0));
        const avg = recentAvgPrice(s.resource, cfg);
        if (avg == null) continue;
        const price = follow ? followSellPrice(cfg, market, s.resource, follow, avg) : avg;
        if (!(price > 0)) continue;
        amount = Math.min(amount, Math.floor(((Number(own.dailySellFeeCredits) || 0) - (ledger().sellFees || 0)) / (price * own.fee)));
        if (amount < cfg.minDeal) continue;
        const r = postOrder(cfg, market, 'sell', s.resource, s.room, price, Math.floor(amount));
        if (r) return r;
    }
    return null;
}

function followSellPrice(cfg, market, resource, follow, avg) {
    let orders = [];
    try { orders = market.getAllOrders({ type: BUY(), resourceType: resource }) || []; }
    catch (error) { utils.logErr('market.sellFollow getAllOrders', error); orders = []; }
    const top = orders.reduce((m, o) => (Number(o.amount) > 0 && o.price > m ? o.price : m), 0);
    const base = avg != null ? avg : recentAvgPrice(resource, cfg);
    const floor = base != null ? base * (Number(follow.floorShare) || 0.6) : 0;
    const price = Math.max(top, floor);
    const mem = Memory.market || (Memory.market = {});
    const px = mem.sellFollow || (mem.sellFollow = {});
    px[resource] = { at: Game.time, top, floor: Math.round(floor * 1000) / 1000, price: Math.round(price * 1000) / 1000 };
    return price;
}

function repriceSell(cfg, market, o, resource, follow) {
    if (typeof market.changeOrderPrice !== 'function') return null;
    const every = Math.max(100, Number(follow.everyTicks) || 500);
    if (Game.time - Number(o.repricedAt || o.posted || 0) < every) return null;
    o.repricedAt = Game.time;
    const price = followSellPrice(cfg, market, resource, follow, null);
    if (!(price > 0) || !(o.price > 0)) return null;
    const step = Number(follow.step) || 0.02;
    if (Math.abs(price - o.price) / o.price < step) return null;
    const own = ownSettings(cfg);
    const led = ledger();
    const left = Math.max(0, Number(o.left) || 0);
    const fee = Math.max(0, price - o.price) * left * (Number(own.fee) || 0.05);
    if ((led.sellFees || 0) + fee > (Number(own.dailySellFeeCredits) || 0)) return null;
    const ret = market.changeOrderPrice(o.id, Math.round(price * 1000) / 1000);
    const rec = { at: Game.time, type: 'reprice', resource, room: o.room, from: o.price, price, left, fee: Math.round(fee), result: ret };
    Memory.market.lastReprice = rec;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        o.price = price;
        led.sellFees = Math.round((led.sellFees || 0) + fee);
        led.fees = Math.round((led.fees || 0) + fee);
        led.reprices = (led.reprices || 0) + 1;
    }
    return rec;
}

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
        if ((spentBy[res] || 0) + pendingSum('military', res) >= budgetEach) continue;
        let orders = [];
        try { orders = market.getAllOrders({ type: typeof ORDER_SELL !== 'undefined' ? ORDER_SELL : 'sell', resourceType: res }) || []; }
        catch (error) { utils.logErr('market.militaryBoost getAllOrders', error); continue; }
        const avg = recentAvgPrice(res, cfg);
        const ceil = avg != null && cfg.priceBand != null ? avg * (1 + cfg.priceBand) : Infinity;
        const viable = orders.filter((o) => o.amount > 0 && o.price <= ceil).sort((a, b) => a.price - b.price);
        if (!viable.length) continue;
        const o = viable[0];
        const budgetLeft = budgetEach - (spentBy[res] || 0) - pendingSum('military', res);
        const maxByBudget = Math.floor(budgetLeft / o.price);
        const amount = Math.min(amountEach - have, o.amount, maxByBudget, Math.floor(cfg.maxOrderCredits / o.price));
        if (amount < cfg.minDeal) continue;
        const ret = market.deal(o.id, amount, room.name);
        terminalNet.markUsed(room.name);
        if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
            addPending({ kind: 'military', id: o.id, room: room.name, res, amount, price: o.price });
        }
        return { result: ret, resource: res, amount };
    }
    return null;
}

function sellOnce(cfg, market, room, entry, orders, floor) {
    if (Array.isArray(cfg.neverSell) && cfg.neverSell.indexOf(entry.resource) >= 0) return null;
    const pick = pickBuyOrder(orders, room, entry, cfg, floor);
    if (!pick) return null;
    const ret = market.deal(pick.order.id, pick.amount, room.name);
    terminalNet.markUsed(room.name);
    const record = { at: Game.time, room: room.name, resource: entry.resource, amount: pick.amount, cost: pick.cost,
        price: pick.order.price, effective: Math.round(pick.effective * 1000) / 1000, floor: Math.round(floor * 1000) / 1000, energyPrice: Math.round(cfg.energyPrice * 1000) / 1000, result: ret };
    const mem = Memory.market || (Memory.market = {});
    mem.last = record;
    if (ret === (typeof OK !== 'undefined' ? OK : 0)) {
        addPending({ kind: 'sell', id: pick.order.id, room: room.name, res: entry.resource, amount: pick.amount, price: pick.order.price,
            depth: Array.isArray(cfg.depthTrack) && cfg.depthTrack.includes(entry.resource) });
    }
    return record;
}

function extraDeals(resource, cfg) {
    const per = cfg.dealsPerRound && Number(cfg.dealsPerRound[resource]);
    return per > 1 ? Math.floor(per) - 1 : 0;
}

function extraDepth(resource, cfg) {
    const v = cfg.extraDealDepth && Number(cfg.extraDealDepth[resource]);
    return v > 0 ? v : Infinity;
}

function planFollow(cfg, resource, depth) {
    const mem = Memory.market || (Memory.market = {});
    const left = mem.follow && mem.follow.resource === resource && mem.follow.round === Game.time - (Game.time % cfg.interval)
        ? Number(mem.follow.left) - 1 : extraDeals(resource, cfg);
    if (!(left > 0) || !depth || !(Number(depth.depthLast) >= extraDepth(resource, cfg))) {
        if (mem.follow && mem.follow.resource === resource) delete mem.follow;
        return null;
    }
    const wait = Math.max(1, Number(cfg.followTicks) || 11);
    const round = Game.time - (Game.time % cfg.interval);
    if (Game.time + wait >= round + cfg.interval) { delete mem.follow; return null; }
    mem.follow = { resource, round, due: Game.time + wait, left, depth: depth.depthLast };
    return mem.follow;
}

function runFollow(cfg, shed) {
    const mem = Memory.market;
    const follow = mem && mem.follow;
    if (!follow || Game.time < follow.due) return null;
    if (Game.time >= follow.round + cfg.interval) { delete mem.follow; return null; }
    if (shed && shed.stopped) return null;
    const market = marketApi();
    if (!market || typeof market.deal !== 'function' || typeof market.getAllOrders !== 'function') return null;
    delete mem.follow;
    cfg.energyPrice = energyPriceNow(cfg);
    let hold = null;
    try { hold = terminalNet.mineralHolds(); } catch (error) { hold = null; }
    let orders = null;
    for (const room of sellerRooms(cfg)) {
        const entry = sellable(room, cfg, hold).find((e) => e.resource === follow.resource);
        if (!entry) continue;
        const avg = recentAvgPrice(entry.resource, cfg);
        const floor = sellFloorFor(entry.resource, avg, cfg);
        if (floor == null) return null;
        if (!orders) {
            try { orders = market.getAllOrders({ type: BUY(), resourceType: entry.resource }) || []; }
            catch (error) { utils.logErr('market.getAllOrders', error); return null; }
        }
        const depth = recordDepth(entry.resource, room, orders, floor, cfg);
        if (!depth || !(Number(depth.depthLast) >= extraDepth(entry.resource, cfg))) {
            mem.followSkipped = { at: Game.time, resource: entry.resource, depth: depth ? depth.depthLast : null };
            return null;
        }
        const record = sellOnce(cfg, market, room, entry, orders, floor);
        if (!record) continue;
        record.follow = true;
        if (record.result === (typeof OK !== 'undefined' ? OK : 0) && follow.left > 1) {
            mem.follow = Object.assign({}, follow, { left: follow.left - 1, due: Game.time + Math.max(1, Number(cfg.followTicks) || 11) });
            if (mem.follow.due >= follow.round + cfg.interval) delete mem.follow;
        }
        return record;
    }
    return null;
}

function run(shed) {
    const cfg = settings();
    if (cfg.enabled && cfg.interval > 0 && Game.time % cfg.interval !== 0) return runFollow(cfg, shed);
    if (!cfg.enabled || !(cfg.interval > 0) || Game.time % cfg.interval !== 0) return null;
    if (shed && shed.stopped) return null;
    const market = marketApi();
    if (!market || typeof market.deal !== 'function' || typeof market.getAllOrders !== 'function') return null;
    cfg.energyPrice = energyPriceNow(cfg);
    try { salesTrack(cfg, market); } catch (error) { utils.logErr('market.salesTrack', error); }
    try { trackStorage(500); } catch (error) { utils.logErr('market.trackStorage', error); }
    const tickBudget = Number(cfg.tickCpuBudget) || 0;
    const tickT0 = Game.cpu.getUsed();
    const overBudget = () => tickBudget > 0 && (Game.cpu.getUsed() - tickT0) >= tickBudget;
    const ordersBy = {};
    let scans = 0;
    let hold = null;
    try { hold = terminalNet.mineralHolds(); } catch (error) { utils.logErr('market.mineralHolds', error); hold = null; }
    let mil = null;
    try { mil = buyMilitaryBoosts(cfg, market); } catch (error) { utils.logErr('market.militaryBoost', error); }
    if (mil && mil.result === (typeof OK !== 'undefined' ? OK : 0)) return mil;
    let posted = null;
    try { posted = runOwnOrders(cfg, market); } catch (error) { utils.logErr('market.ownOrders', error); }
    if (overBudget()) return posted;
    const bought = tryBuy(cfg, market, () => scans++);
    if (bought) return bought;
    if (overBudget()) return bought;
    const ownSell = new Set(((ownSettings(cfg) && ownSettings(cfg).enabled && ownSettings(cfg).sell) || []).map((s) => s.room + ':' + s.resource));
    for (const room of sellerRooms(cfg)) {
        for (const entry of sellable(room, cfg, hold)) {
            if (ownSell.has(room.name + ':' + entry.resource)) continue;
            if (room._depositOnly && depositGoods({ [entry.resource]: 1 }).length === 0) continue;
            const avg = recentAvgPrice(entry.resource, cfg);
            const floor = sellFloorFor(entry.resource, avg, cfg);
            if (floor == null) continue;
            if (!ordersBy[entry.resource]) {
                if (scans >= cfg.maxScans || overBudget()) continue;
                scans++;
                try { ordersBy[entry.resource] = market.getAllOrders({ type: BUY(), resourceType: entry.resource }) || []; }
                catch (error) { utils.logErr('market.getAllOrders', error); ordersBy[entry.resource] = []; }
            }
            let depth = null;
            try { depth = recordDepth(entry.resource, room, ordersBy[entry.resource], floor, cfg); } catch (error) { utils.logErr('market.recordDepth', error); }
            const record = sellOnce(cfg, market, room, entry, ordersBy[entry.resource], floor);
            if (!record) continue;
            if (record.result === (typeof OK !== 'undefined' ? OK : 0)) planFollow(cfg, entry.resource, depth);
            return record;
        }
    }
    return null;
}

module.exports = { dailyVolume, pixelPrice, notePixel, labUsedToday, sellCapFor, sellStopped, buyRoomOk, confirmDeals, pendingDeals, pendingSum, accountStock, buyStopped, buyCap, cancelStaleOrphans, run, guardTick, scanEnergyTx, scanSalesTx, closeSalesDay, salesAvg, energyBudget, storageFull, energyActual, energyStopCheck, trackOrphanEnergy, runDailyEnergy, roomEnergyOpen, runFollow, planFollow, sellOnce, recordDepth, dailyBook, dealCap, storageFalling, trackStorage, settings, salesTrack, soldCredits, roomKeepFor, energyPriceNow, sellFloorFor, minEffectiveFor, sellable, pickBuyOrder, recentAvgPrice, sellerRooms, tryBuy, tryBuyEnergy, ledger, keepFor, runOwnOrders, syncOrders, buyMilitaryBoosts, sellListAllowed, trackOrphanSell };
