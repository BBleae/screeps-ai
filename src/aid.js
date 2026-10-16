'use strict';
/**
 * 援建：容量大的母房为邻近的弱房（无 storage、容量 < untilCapacity）直接孵满配 creep，memory.home 指向弱房。
 * 弱房靠 400 容量的小身板要爬很久才能达到"每源 5 WORK、300 tick 采完 3000"的采集上限；
 * 母房一只 5W 静态矿工走过去就立刻到位。需求排在外矿之前（spawn.js 合并顺序），母房核心角色缺编时照旧等待。
 */
const config = require('config');
const utils = require('utils');
const movement = require('movement');

function cfg() {
    return Object.assign({ untilCapacity: 1300, storageBelow: 10000, minHomeCapacity: 800, maxRange: 2, haulerCarry: 12, builderWork: 5, lead: 200,
        couriers: 1, exportAbove: 10000, exportKeep: 5000, courierBudget: 1600, routeCacheTicks: 1000 }, config.aid || {});
}

/** from → to 有没有援建 creep 真走得通的路（movement.safeRouteExists：整房避开 SK/他人房，与援建角色的默认移动同口径）。
 *  findRoute 抛错时放行并记错：别因为地图 API 出岔子把整个 spawn.run 带崩，也别据此退役在途的 creep */
function routeOk(from, to, c) {
    try { return movement.safeRouteExists(from, to, c.routeCacheTicks); }
    catch (e) { utils.logErr('aid.safeRoute ' + from + '>' + to, e); return true; }
}

/** bodyFor(budget)：预算不足满配时按预算缩身的身体（spawn 队列在宽限用完后调用）；不给则只能等满配。
 *  strategic：弱房经济还没起来（某个源没人挖 / 没有 hauler）时为 true——可越过母房等能量的发展档请求；
 *  弱房已能自转、只是身板小时为 false——排在母房自己的 builder/hauler 之后（线上 2026-09-05：W33S7 单 spawn 满负荷，
 *  自己的 builder 1/3 等了十几小时、storage 工地停在 10834/30000，却一直给 spawn 闲着、能量满仓的 W35S7/W33S8 送援建 creep） */
function demand(role, slot, body, memory, lead, priority, bodyFor, strategic) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, bodyFor, strategic: strategic !== false };
}

/** 弱房的某个源一只在岗矿工都没有 → 该源的援建矿工是 strategic */
function sourceManned(creeps, entry, lead) {
    return creeps.some((creep) => creep.memory.role === 'harvester' && alive(creep, lead) &&
        (creep.memory.sourceId ? creep.memory.sourceId === entry.id : creep.memory.sourceIdx === entry.index));
}

/** 弱房没有任何在岗 hauler → 援建 hauler 是 strategic */
function hasHauler(creeps, lead) {
    return creeps.some((creep) => creep.memory.role === 'hauler' && alive(creep, lead) && utils.bodyPartCount(creep.body, 'carry') > 0);
}

/** 弱房是否还缺基本经济：某个源没人挖，或没有 hauler（monitor / 测试用） */
function shortHanded(room, creeps, lead) {
    return roomSources(room).some((entry) => !sourceManned(creeps, entry, lead)) || !hasHauler(creeps, lead);
}

const linearDistance = utils.roomDistance;

function needsAid(home, room) {
    const c = cfg();
    if (!room || !room.controller || !room.controller.my || room.name === home.name) return false;
    // 还没有 spawn 的新房不援：矿工落地采、hauler 没处送、builder 不建 spawn 工地，能量白堆在地上（线上快照 soak：4000 tick 堆了 1.2 万），
    // 开荒归 expansion 的 pioneer
    if (typeof room.find === 'function' && !(room.find(FIND_MY_SPAWNS) || []).length) return false;
    // 有 storage 但里面没多少能量的房（刚建成 storage 的 RCL4）仍算弱房
    if (room.storage && room.storage.store && Number(room.storage.store[RESOURCE_ENERGY] || 0) >= c.storageBelow) return false;
    if (room.energyCapacityAvailable >= c.untilCapacity) return false;
    if (home.energyCapacityAvailable < c.minHomeCapacity) return false;
    if (linearDistance(home.name, room.name) > c.maxRange) return false;
    // 直线距离近不等于走得到：母房到弱房得有一条不穿 SK/他人房的路。没路的援建 creep 在母房原地寻路，还按 home 占着弱房的编制
    // （线上 2026-09-15 W35S7 → W37S5：两个源 18 小时 0 采集——W37S5 自己不补矿工，走得到的 W38S7 也看到"已有 5 WORK"不再援）。
    // 遥测 Memory.rooms[母房].aidNoRoute = 最近一次因此拒援的弱房与 tick
    if (routeOk(home.name, room.name, c)) return true;
    const mem = Memory.rooms && Memory.rooms[home.name];
    if (mem) mem.aidNoRoute = { room: room.name, at: Game.time };
    return false;
}

/** 援建 creep（memory.aid）不在弱房、从当前房已没有到弱房的安全路线（当初派错了，或路上的房被人占了）：标记退役，
 *  由 main.js 紧接着的 spawn.retireReplaced 走回最近的 spawn 回收（编制计数立刻按 isRetiring 排除它，走得到的母房可以接手）。
 *  不然它原地寻路烧 CPU，还按 home 占着弱房的编制。已在弱房的不管（母房那头断路不影响它干活）。
 *  返回本 tick 是否新标记；遥测 Memory.rooms[弱房].aidStranded */
function markStranded(creep) {
    const mem = creep && creep.memory;
    if (!mem || !mem.aid || !mem.home || creep.spawning || utils.isRetiring(mem) || !creep.room || creep.room.name === mem.home) return false;
    if (routeOk(creep.room.name, mem.home, cfg())) return false;
    mem.bodyUpgradeRetiring = true;
    if (Memory.rooms) {
        const target = Memory.rooms[mem.home] || (Memory.rooms[mem.home] = {});
        target.aidStranded = { name: creep.name, role: mem.role, from: creep.room.name, aid: mem.aid, at: Game.time };
    }
    return true;
}

function targets(home) {
    const out = [];
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (needsAid(home, room)) out.push(room);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

function alive(creep, lead) {
    if (creep.spawning) return true;
    return creep.ticksToLive == null || creep.ticksToLive > lead;
}

function roomSources(room) {
    const mem = (Memory.rooms && Memory.rooms[room.name]) || {};
    const ids = Array.isArray(mem.sources) ? mem.sources : [];
    const found = typeof room.find === 'function' ? room.find(FIND_SOURCES) || [] : [];
    if (ids.length) {
        return ids.map((id, index) => ({ id, index, source: found.find((s) => s.id === id) || null }));
    }
    return found.map((source, index) => ({ id: source.id, index, source }));
}

function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const c = cfg();
    const demands = [];
    let priority = 0;
    for (const room of targets(home)) {
        const cap = home.energyCapacityAvailable;
        const creeps = utils.creepsHome(room.name).filter((creep) => !utils.isRetiring(creep.memory));
        // 1) 每个源 5 WORK（该源完全没人挖时 strategic，只是身板小时排在母房自己的发展档之后）
        const minerBody = utils.makeBody('staticHarvester', cap);
        for (const entry of roomSources(room)) {
            const work = creeps
                .filter((creep) => creep.memory.role === 'harvester' && alive(creep, c.lead) &&
                    (creep.memory.sourceId ? creep.memory.sourceId === entry.id : creep.memory.sourceIdx === entry.index))
                .reduce((sum, creep) => sum + utils.bodyPartCount(creep.body, 'work'), 0);
            if (work >= 5) continue;
            demands.push(demand('harvester', 'aid:harvester:' + room.name + ':' + entry.index, minerBody,
                { home: room.name, sourceIdx: entry.index, sourceId: entry.id, staticMiner: true, aid: home.name }, c.lead, priority++,
                (budget) => utils.makeBody('staticHarvester', budget), !sourceManned(creeps, entry, c.lead)));
        }
        // 2) 一只像样的 hauler（一只都没有时 strategic）
        const carry = creeps.filter((creep) => creep.memory.role === 'hauler' && alive(creep, c.lead))
            .reduce((sum, creep) => sum + utils.bodyPartCount(creep.body, 'carry'), 0);
        if (carry < c.haulerCarry) {
            demands.push(demand('hauler', 'aid:hauler:' + room.name, utils.makeBody('hauler', cap), { home: room.name, aid: home.name }, c.lead, priority++,
                (budget) => utils.makeBody('hauler', budget), !hasHauler(creeps, c.lead)));
        }
        // 3) 有工地时一只大 builder（extension 建得越快，弱房自己的容量涨得越快；从不越过母房自己的发展档）
        const sites = typeof room.find === 'function' ? (room.find(FIND_MY_CONSTRUCTION_SITES) || []).length : 0;
        const builderWork = creeps.filter((creep) => creep.memory.role === 'builder' && alive(creep, c.lead))
            .reduce((sum, creep) => sum + utils.bodyPartCount(creep.body, 'work'), 0);
        if (sites > 0 && builderWork < c.builderWork) {
            demands.push(demand('builder', 'aid:builder:' + room.name, utils.makeBody('builder', cap), { home: room.name, aid: home.name }, c.lead, priority++,
                (budget) => utils.makeBody('builder', budget), false));
        }
        // 4) 母房 storage 富余（≥ exportAbove）时派 courier 把能量搬到弱房（弱房要有 spawn 可收）：能量在母房 storage 里闲着，
        //    新房却靠 20/tick 的自产爬 extension；只多付一只 hauler 的 spawn 时间
        const storage = home.storage;
        const levels = utils.aidExportLevels(c, config.upgrading);
        // 10-16 战略：exportAfterTerminal 名单里的母房（W29S3）自己的 terminal 建成前不导出，攒 storage 建 terminal；建成后自动恢复
        const holdExport = (c.exportAfterTerminal || []).indexOf(home.name) >= 0 && !(home.terminal && home.terminal.my !== false);
        const exportable = !holdExport && storage && storage.my !== false && storage.store && Number(storage.store[RESOURCE_ENERGY] || 0) >= levels.above;
        const couriers = creeps.filter((creep) => creep.memory.role === 'courier' && alive(creep, c.lead)).length;
        const weakSpawns = typeof room.find === 'function' ? (room.find(FIND_MY_SPAWNS) || []).length : 0;
        if (exportable && couriers < c.couriers && weakSpawns > 0) {
            const budget = Math.min(cap, c.courierBudget);
            demands.push(demand('courier', 'aid:courier:' + room.name, utils.makeBody('hauler', budget), { home: room.name, from: home.name, aid: home.name }, c.lead, priority++,
                (b) => utils.makeBody('hauler', Math.min(b, c.courierBudget)), false));
        }
    }
    oneShotDemands(home, demands, priority);
    return demands;
}

/** 10-16 战略例外：一次性放行 Memory.aidOneShot = { from, to, amount, withdrawn }。from 房为 to 房孵 courier（memory.oneShot），
 *  无视 needsAid / exportAfterTerminal；courier 每次从 from 的 storage 取货时把取出量记进 withdrawn，取满 amount 后删掉放行标记
 *  （roles/courier.js），之后已取的货送完、空车就回 spawn 回收。孵化成本不计入 amount */
function oneShot() {
    const o = Memory.aidOneShot;
    if (!o || !o.from || !o.to || !(Number(o.amount) > 0)) return null;
    return o;
}
function oneShotRemaining() {
    const o = oneShot();
    return o ? Math.max(0, Number(o.amount) - (Number(o.withdrawn) || 0)) : 0;
}
function oneShotByTerminal(home, o, remaining) {
    const t = home.terminal, dest = Game.rooms[o.to], dt = dest && dest.terminal;
    if (!t || t.my === false || !dt || t.cooldown > 0) return;
    const have = Number(t.store[RESOURCE_ENERGY] || 0);
    let amount = Math.min(remaining, 5000);
    const cost = (a) => (typeof Game.market !== 'undefined' && Game.market.calcTransactionCost ? Game.market.calcTransactionCost(a, home.name, o.to) : 0);
    while (amount > 0 && amount + cost(amount) > have) amount -= 500;
    if (amount <= 0) return;
    if (t.send(RESOURCE_ENERGY, amount, o.to, 'aidOneShot') === OK) {
        o.withdrawn = (Number(o.withdrawn) || 0) + amount;
        (o.trips || (o.trips = [])).push([Game.time, 'terminal', amount]);
        if (o.withdrawn >= Number(o.amount)) { Memory.aidOneShotDone = Object.assign({}, o, { doneAt: Game.time }); delete Memory.aidOneShot; }
    }
}
function oneShotDemands(home, demands, priority) {
    const o = oneShot();
    if (!o || o.from !== home.name) return;
    const remaining = oneShotRemaining();
    if (remaining <= 0) return;
    // 10-16 战略：courier 掉血 → 自动暂停（标记保留，o.paused 写原因）；W29S3 terminal 建成后改用 terminal 送剩余量
    if (o.paused) { oneShotByTerminal(home, o, remaining); return; }
    const c = cfg();
    const maxCouriers = Math.max(1, Number(o.couriers) || 2);
    const budget = Math.min(home.energyCapacityAvailable, Number(o.budget) || 2500);
    const body = utils.makeBody('hauler', budget);
    const perTrip = utils.bodyPartCount(body, 'carry') * 50;
    const live = Object.values(Game.creeps || {}).filter((cr) => cr.memory && cr.memory.oneShot && cr.memory.role === 'courier' && !utils.isRetiring(cr.memory));
    // 已在编的 courier 一趟就能装下剩余量时不再加人
    const want = Math.min(maxCouriers, Math.ceil(remaining / Math.max(1, perTrip)));
    for (let i = 0; i < want; i++) {
        const slot = 'aid:oneshot:' + o.to + ':' + i;
        if (live.some((cr) => cr.memory.slotKey === slot)) continue;
        demands.push(demand('courier', slot, body, { home: o.to, from: o.from, aid: o.from, oneShot: true }, c.lead, priority++,
            (b) => utils.makeBody('hauler', Math.min(b, budget)), true));
    }
}

module.exports = { oneShotRemaining, getDemands, needsAid, linearDistance, shortHanded, markStranded };
