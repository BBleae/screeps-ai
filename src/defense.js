'use strict';
/**
 * 防御执行层（只对 NPC）：
 *   - 母房：塔压得住就交给塔；压不住（无塔/没能量/敌方治疗过高/核心建筑掉血）才要 defender。
 *   - 己方无塔房（开荒中的新房）与外矿：出现武装 Invader 就由最近的有 spawn 的母房出兵；外矿被 InvaderCore 占据则派清核心队。
 *   - 打得过才打：按敌情画像（hostileProfile：血量/伤害/治疗/风筝型/强化/到期 tick）和母房容量找最便宜的能赢的编组（planSquad：
 *     同时交换伤害、对方全部在射程内的悲观模型，我方击杀时间 × winMargin ≤ 对方击杀我方的时间）；风筝型（没有 ATTACK 的远程 Invader
 *     会拉开距离，近战追不上）只用远程组。找不到能赢的编组、或外矿不值这个价（remoteValueShare）就不出兵：外矿停到入侵者到期
 *     （Invader 不能离开房间，寿命 1500），记 defenseLog.skipped。线上 2026-09-05 W33S7 对 W33S6 的两只强化 Invader 连续单送 defender。
 *   - 不盲目续派：defender 阵亡（main.js 清理内存时 noteLoss）后，要再看到比阵亡更新的敌情画像才会再出兵。
 *   - 不可见的房用最近的画像：外矿记录的 threat（远程 creep / defender 观察写入）或外部大脑情报 Memory.map[房].hostileProfile；
 *     外部大脑还可以直接下 defense 指令（brain.get(home, 'defense') = {房: {action: 'fight'|'avoid', squad: {count, body, style}, until}}），
 *     指令在 until 之前优先于游戏内模型。只有情报计数、没有画像时不出兵（等远程 creep 或大脑看到成分）。
 * 需求结构与 remote/expansion 相同，由 spawn.run 合并；己方房的防御是 defense 档，外矿防御是 remoteMaintain 档（不抢母房生存的能量）。
 */
const config = require('config');
const brain = require('brain');
const { bodyCost, repeat, roomDistance } = require('utils');
const tower = require('tower');

const ARMED = ['attack', 'ranged_attack', 'heal', 'work', 'claim'];
const INTEL_FRESH_TICKS = 1500;
const ATTACK_POWER = 30;
const RANGED_ATTACK_POWER = 10;
const HEAL_POWER = 12;
const LIFE = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
// 强化倍率（BOOSTS 常量表；NPC Invader 用 UH/KO/LO/ZH/GO，中心区用 X 级）
const BOOSTS = {
    attack: { UH: 2, UH2O: 3, XUH2O: 4 },
    ranged_attack: { KO: 2, KHO2: 3, XKHO2: 4 },
    heal: { LO: 2, LHO2: 3, XLHO2: 4 },
    tough: { GO: 0.7, GHO2: 0.5, XGHO2: 0.3 },
};

function settings() {
    return Object.assign({ minCapacity: 260, idleTicks: 50, maxDefenders: 3, winMargin: 1.5, squadWait: 300, remoteValueShare: 0.5, maxOwnLosses: 2 },
        config.defense || {});
}

function activeParts(creep, type) {
    if (typeof creep.getActiveBodyparts === 'function') return creep.getActiveBodyparts(type);
    return (creep.body || []).filter((part) => (part.type || part) === type && part.hits !== 0).length;
}

const COMBAT = ['attack', 'ranged_attack', 'heal'];
const NPC_OWNERS = ['Invader', 'Source Keeper'];

/** 己方房里任何带 ARMED 部件的敌人都算（拆墙的 WORK、抢控制器的 CLAIM 都是攻击）；
 *  外矿（strict）里只算 NPC 与带战斗部件的玩家 creep：路过的玩家矿工/reserver 不是要出兵的威胁——
 *  外矿防御放开"最近母房"门之后，旧口径会对邻居（W35S8 的 Alepoldar）路过的 WORK/CLAIM creep 出兵 */
function isArmed(creep, strict) {
    const owner = creep && creep.owner && creep.owner.username;
    const parts = strict && NPC_OWNERS.indexOf(owner) < 0 ? COMBAT : ARMED;
    return parts.some((type) => activeParts(creep, type) > 0);
}

function armedHostiles(room) {
    const own = !!(room && room.controller && room.controller.my);
    return room.find(FIND_HOSTILE_CREEPS).filter((creep) => isArmed(creep, !own));
}

function invaderCore(room) {
    const type = typeof STRUCTURE_INVADER_CORE === 'undefined' ? 'invaderCore' : STRUCTURE_INVADER_CORE;
    return room.find(FIND_STRUCTURES).find((structure) => structure.structureType === type) || null;
}

/** 有 spawn 的己方房里离 roomName 最近的那个负责派兵（多母房时避免重复需求） */
function closestBase(roomName) {
    let best = null;
    let bestDistance = Infinity;
    for (const room of Object.values(Game.rooms || {})) {
        if (!room.controller || !room.controller.my || !room.find(FIND_MY_SPAWNS).length) continue;
        const distance = roomDistance(room.name, roomName);
        if (distance < bestDistance) { best = room.name; bestDistance = distance; }
    }
    return best;
}

// ---- 战力模型 ----

function partList(subject) {
    if (Array.isArray(subject)) return subject.map((part) => (part && part.type ? part : { type: part }));
    return (subject && subject.body) || [];
}

/** 单个 creep（或身体数组）的战力：血量（强化 TOUGH 按减伤折算成更多血）、每 tick 伤害（近战 30/远程 10 × 强化）、每 tick 治疗、
 *  风筝型（有远程无近战且能动：引擎里这种 Invader 会主动拉开到 3 格），是否强化 */
function creepProfile(subject) {
    // 活 creep 用它的 hits（部件血量之和）；身体数组按每部件 100。强化 TOUGH 的减伤折算成额外血量
    const live = !Array.isArray(subject) && subject && subject.hits != null;
    let hits = live ? Number(subject.hits) : 0;
    let dps = 0;
    let heal = 0;
    let attack = 0;
    let ranged = 0;
    let move = 0;
    let boosted = false;
    for (const part of partList(subject)) {
        if (!part || part.hits === 0) continue;
        const type = part.type;
        const mult = (part.boost && BOOSTS[type] && BOOSTS[type][part.boost]) || 1;
        if (part.boost) boosted = true;
        const partHits = part.hits == null ? 100 : part.hits;
        if (!live) hits += partHits;
        if (type === 'tough' && mult < 1) hits += partHits * (1 / mult - 1);
        if (type === 'attack') { dps += ATTACK_POWER * mult; attack++; }
        else if (type === 'ranged_attack') { dps += RANGED_ATTACK_POWER * mult; ranged++; }
        else if (type === 'heal') heal += HEAL_POWER * mult;
        else if (type === 'move') move++;
    }
    return { hits, dps, heal, kiter: ranged > 0 && attack === 0 && move > 0, boosted };
}

/** 一群敌人的画像（写进外矿记录 / 情报，房间不可见时也能评估）：until = 最晚到期的 tick */
function hostileProfile(hostiles) {
    const out = { at: Game.time, count: 0, hits: 0, dps: 0, heal: 0, kiters: false, boosted: false, until: Game.time };
    for (const hostile of hostiles || []) {
        const profile = creepProfile(hostile);
        out.count++;
        out.hits += profile.hits;
        out.dps += profile.dps;
        out.heal += profile.heal;
        if (profile.kiter) out.kiters = true;
        if (profile.boosted) out.boosted = true;
        const ttl = Number(hostile.ticksToLive) > 0 ? Number(hostile.ticksToLive) : LIFE;
        out.until = Math.max(out.until, Game.time + ttl);
    }
    out.hits = Math.round(out.hits);
    out.dps = Math.round(out.dps);
    out.heal = Math.round(out.heal);
    return out;
}

function squadProfile(bodies) {
    const out = { hits: 0, dps: 0, heal: 0 };
    for (const body of bodies || []) {
        const profile = creepProfile(body);
        out.hits += profile.hits;
        out.dps += profile.dps;
        out.heal += profile.heal;
    }
    return out;
}

/** 这组身体能不能赢：双方同时交换伤害、对方全部在射程内。我方净伤害 = 我方 dps − 对方治疗，对方净伤害 = 对方 dps − 我方治疗；
 *  我方击杀时间 × margin ≤ 对方击杀我方的时间（对方打不动我方 = 无穷）。没有敌人算赢。 */
function canBeat(bodies, enemy, margin) {
    if (!enemy || !enemy.count) return true;
    const ours = squadProfile(bodies);
    const factor = margin != null ? Number(margin) : settings().winMargin;
    const enemyNet = ours.dps - enemy.heal;
    if (enemyNet <= 0) return false;
    const killTime = enemy.hits / enemyNet;
    const ourNet = enemy.dps - ours.heal;
    const surviveTime = ourNet <= 0 ? Infinity : ours.hits / ourNet;
    return killTime * factor <= surviveTime;
}

// MOVE 排在最前面：受伤先掉的是机动，攻击/治疗部件留到最后
function meleeBody(attack) {
    return repeat('move', attack).concat(repeat('attack', attack));
}

function rangedBody(ranged, heal) {
    return repeat('move', ranged + heal).concat(repeat('ranged_attack', ranged), repeat('heal', heal));
}

/** 母房容量下所有候选身体（按成本升序）：近战 aA aM、远程 rR hH (r+h)M。style 限定只出近战或只出远程 */
function candidates(capacity, style) {
    const list = [];
    if (style !== 'ranged') {
        for (let attack = 2; attack <= 25; attack++) {
            const body = meleeBody(attack);
            const cost = bodyCost(body);
            if (cost > capacity) break;
            list.push({ style: 'melee', body, cost });
        }
    }
    if (style !== 'melee') {
        for (let ranged = 1; ranged <= 25; ranged++) {
            for (let heal = 0; heal <= Math.min(5, ranged); heal++) {
                const body = rangedBody(ranged, heal);
                if (body.length > 50) continue;
                const cost = bodyCost(body);
                if (cost > capacity) continue;
                list.push({ style: 'ranged', body, cost });
            }
        }
    }
    list.sort((left, right) => left.cost - right.cost || left.body.length - right.body.length);
    return list;
}

/** 最便宜的能赢的编组：1..maxDefenders 只同样的身体；风筝型在场只考虑远程。找不到返回 null */
function planSquad(capacity, enemy, cfg) {
    if (!enemy || !enemy.count) return null;
    const options = cfg || settings();
    const list = candidates(capacity, enemy.kiters ? 'ranged' : null);
    let best = null;
    for (let count = 1; count <= Math.max(1, Number(options.maxDefenders) || 1); count++) {
        for (const candidate of list) {
            const bodies = [];
            for (let index = 0; index < count; index++) bodies.push(candidate.body);
            if (!canBeat(bodies, enemy, options.winMargin)) continue;
            const total = candidate.cost * count;
            if (!best || total < best.total) best = { style: candidate.style, body: candidate.body, cost: candidate.cost, count, total };
            break;
        }
    }
    return best;
}

/** 编组到场要多少 tick：攒够总成本（母房 spawn 收入 EMA，没有就按每源 fallbackIncomePerSource）+ 逐只孵化（3 tick/部件）+ 走路（每房 50） */
function assemblyLead(plan, home, roomName, mem) {
    const sources = typeof home.find === 'function' ? home.find(FIND_SOURCES).length : 2;
    const fallback = (Number(config.spawnQueue && config.spawnQueue.fallbackIncomePerSource) || 5) * Math.max(1, sources);
    const ema = mem && mem.spawnIncome && Number(mem.spawnIncome.ema);
    const income = Math.max(0.5, ema > 0 ? ema : fallback);
    const spawnTicks = plan.count * plan.body.length * 3;
    const travel = Math.max(1, roomDistance(home.name, roomName)) * 50;
    return Math.ceil(plan.total / income + spawnTicks + travel);
}

/** 外矿值不值得打：编组总成本 ≤ 到场后入侵者剩余寿命内的期望产出 × remoteValueShare。
 *  返回 {ok, value, lead}。线上 2026-09-05：按"现在的剩余寿命"算出 fight，一只 1000 的 defender 刚孵出大脑就改成 avoid（攒 3000 要 240 tick） */
function worthFighting(plan, record, profile, cfg, home, roomName, mem) {
    if (!record) return { ok: true, value: Infinity, lead: 0 };
    const sources = Number(record.sourceCount) || (record.sources && record.sources.length) || 1;
    const lead = assemblyLead(plan, home, roomName, mem);
    const remaining = Math.max(0, Number(profile.until || 0) - Game.time - lead);
    const value = Math.round(sources * 10 * remaining * (Number(cfg.remoteValueShare) || 0.5));
    return { ok: plan.total <= value, value, lead };
}

/** 把看到的敌情写进外矿记录（remote.refreshVisible / defender 观察时调用）；没有武装敌人就清掉 */
function recordThreat(record, hostiles) {
    if (!record) return null;
    record.threat = hostiles && hostiles.length ? hostileProfile(hostiles) : null;
    return record.threat;
}

/** 房间不可见时可用的画像：外矿记录的 threat 或外部大脑情报 hostileProfile，取较新且未到期的 */
function storedProfile(roomName, record) {
    const own = record && record.threat && Number(record.threat.until) > Game.time ? record.threat : null;
    const info = Memory.map && Memory.map[roomName];
    const external = info && info.hostileProfile && Number(info.hostileProfile.until) > Game.time &&
        Game.time - Number(info.hostileProfile.at != null ? info.hostileProfile.at : info.at || 0) <= INTEL_FRESH_TICKS ? info.hostileProfile : null;
    if (own && external) return Number(own.at || 0) >= Number(external.at || 0) ? own : external;
    return own || external;
}

/** 某房的威胁：可见就看实体（带画像）；不可见用记录的画像 / 外部情报（近期）/ 外矿记录的停用原因 */
function threatIn(roomName, record) {
    const room = Game.rooms[roomName];
    // SK 外矿（remote.js record.sk，config.sk）：keeper 是常驻 NPC、由 skReaper 处理，不算要出兵的威胁——否则 planSquad 对着 5000 血的 keeper
    // 判"打不过"，把外矿停到它"到期"（keeper 不会到期）。别的敌人照常算
    const keeperRoom = !!(record && record.sk);
    if (room) {
        const hostiles = armedHostiles(room).filter((creep) => !(keeperRoom && creep.owner && creep.owner.username === 'Source Keeper'));
        const profile = hostiles.length ? hostileProfile(hostiles) : null;
        return { visible: true, hostiles, count: hostiles.length, core: !!invaderCore(room), ranged: !!(profile && profile.kiters),
            profile, seenAt: Game.time };
    }
    const info = Memory.map && Memory.map[roomName];
    const fresh = info && Game.time - Number(info.at || 0) <= INTEL_FRESH_TICKS;
    const profile = storedProfile(roomName, record);
    // scout 写的 armedHostiles 不分主人（keeper 也算），SK 外矿只认画像（record.threat 与大脑 intel 的 hostileProfile 都已排除 keeper）
    const count = profile ? Number(profile.count) || 0 : (fresh && !keeperRoom ? Number(info.armedHostiles || 0) : 0);
    const core = (fresh && !!info.invaderCore) || (record && record.suspendReason === 'invaderCore');
    // 停用原因 hostileCreep 只在冷却期（suspendedUntil）内算威胁；过期后不可见的房不再盲目派 defender
    const hostile = count > 0 || (record && record.suspendReason === 'hostileCreep' && Number(record.suspendedUntil || 0) > Game.time);
    return { visible: false, hostiles: [], count: hostile ? Math.max(1, count) : 0, core, ranged: !!(profile && profile.kiters),
        profile, seenAt: profile ? Number(profile.at || 0) : (fresh ? Number(info.at || 0) : 0) };
}

/** 清核心队 / 兜底身体 */
function defenderBody(capacity, style) {
    if (style === 'ranged') {
        const ranged = Math.max(1, Math.min(10, Math.floor(capacity * 0.55 / 200)));
        const heal = Math.max(capacity >= 700 ? 1 : 0, Math.min(5, Math.floor(capacity * 0.25 / 300)));
        const body = rangedBody(ranged, heal);
        return bodyCost(body) <= capacity ? body : rangedBody(1, 0);
    }
    const attack = Math.max(2, Math.min(20, Math.floor(capacity / 130)));
    return meleeBody(attack);
}

function demand(role, slot, body, memory, lead, priority, cls) {
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory), lead, priority, cls: cls || 'defense' };
}

function suspendRecord(record, until, reason) {
    if (!record) return;
    if (record.suspendedUntil === Number.MAX_SAFE_INTEGER) return;
    record.suspendedUntil = Math.max(Number(record.suspendedUntil) || 0, Number(until) || 0);
    record.suspendReason = reason || record.suspendReason || 'hostileCreep';
}

function ownRoom(home, roomName) {
    if (roomName === home.name) return true;
    const room = Game.rooms[roomName];
    return !!(room && room.controller && room.controller.my);
}

/** 对某房的评估（无副作用）：{threat, plan, skip, wait}。plan = {style, body, count, source}；skip = {reason, until} 表示不出兵并可停用外矿；
 *  wait = 只有计数没有成分 / 阵亡后没再看到，等信息。 */
function evaluate(home, roomName, record, cfg, orders, mem) {
    const capacity = home.energyCapacityAvailable;
    const own = ownRoom(home, roomName);
    const threat = threatIn(roomName, record);
    const out = { threat, own, plan: null, skip: null, wait: false };
    if (roomName === home.name && threat.visible) {
        const towers = home.controller.level >= 3
            ? home.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER }) : [];
        if (towers.length && tower.towersCanHold(home, towers, threat.hostiles)) return out;
    }
    if (threat.count <= 0) return out;
    const order = orders && orders[roomName] && typeof orders[roomName] === 'object' && Number(orders[roomName].until || 0) > Game.time
        ? orders[roomName] : null;
    if (order && order.action === 'avoid') {
        out.skip = { reason: 'brain:' + (order.reason || 'avoid'), until: Number(order.until) };
        return out;
    }
    // 上一只在这房阵亡之后没再看到新的敌情：不盲目续派（葫芦娃救爷爷）
    const loss = (mem && mem.defenseLog && mem.defenseLog.lastLoss) || null;
    if (loss && loss.room === roomName && Number(threat.seenAt || 0) <= Number(loss.at || 0)) { out.wait = true; return out; }
    if (order && order.action === 'fight' && order.squad && Array.isArray(order.squad.body) && order.squad.body.length &&
        bodyCost(order.squad.body) <= capacity) {
        const body = order.squad.body.slice();
        out.plan = { style: order.squad.style || (body.includes('attack') ? 'melee' : 'ranged'), body,
            count: Math.max(1, Math.min(Number(cfg.maxDefenders) || 1, Number(order.squad.count) || 1)), source: 'brain' };
        return out;
    }
    // 己方房连续阵亡上限：本房敌人一直可见，上面的"阵亡后没再看到敌情"门永远不闭（2026-09-06 W31S5 连送 7 只 2A2M 阵亡 6 只）。
    // 同一波敌人阵亡 maxOwnLosses 只后停到敌人到期，房间清场后 streak 归零（getDemands）；大脑 fight 指令在上面已越过
    const streak = own ? Number(roomLog(roomName).streak || 0) : 0;
    if (own && streak >= (Number(cfg.maxOwnLosses) || Infinity)) {
        out.skip = { reason: 'losses:' + streak, until: Number(threat.profile && threat.profile.until) || Game.time + CREEP_LIFE_TIME_FALLBACK };
        return out;
    }
    if (!threat.profile) { out.wait = true; return out; }   // 只有计数没有成分：等远程 creep 或大脑看到成分再决定
    const plan = planSquad(capacity, threat.profile, cfg);
    if (!plan) { out.skip = { reason: 'unwinnable', until: Number(threat.profile.until), capacity }; return out; }
    if (!own) {
        const worth = worthFighting(plan, record, threat.profile, cfg, home, roomName, mem);
        if (!worth.ok) {
            out.skip = { reason: 'notWorth:' + plan.total + '>' + worth.value, until: Number(threat.profile.until), lead: worth.lead };
            return out;
        }
    }
    out.plan = Object.assign({ source: 'model' }, plan);
    return out;
}

const CREEP_LIFE_TIME_FALLBACK = 1500;

/** 被防守房自己的 defenseLog（连续阵亡计数 streak 记在被防守房，不管 defender 由哪个母房孵） */
function roomLog(roomName) {
    if (typeof Memory === 'undefined' || !Memory.rooms) return {};
    const mem = Memory.rooms[roomName] || (Memory.rooms[roomName] = {});
    return mem.defenseLog || (mem.defenseLog = { spawned: 0 });
}

function remoteRecordOf(home, roomName) {
    const mem = Memory.rooms && Memory.rooms[home.name];
    return (mem && mem.remotes && mem.remotes[roomName]) || null;
}

/** 现在还想不想为 roomName 出兵（无副作用）：正在家里集结的 defender 用它判断该继续等还是退役 */
function planFor(home, roomName) {
    if (!home || !home.controller || !home.controller.my) return null;
    const cfg = settings();
    if (home.energyCapacityAvailable < cfg.minCapacity) return null;
    const mem = Memory.rooms && Memory.rooms[home.name] || null;
    const result = evaluate(home, roomName, remoteRecordOf(home, roomName), cfg, brain.get(home.name, 'defense', null), mem);
    if (result.plan) return result.plan;
    return !result.threat.count && result.threat.core ? { style: 'melee', count: 1, core: true } : null;
}

/** 母房需要为防御孵化的 creep 需求 */
function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const cfg = settings();
    const capacity = home.energyCapacityAvailable;
    if (capacity < cfg.minCapacity) return [];
    const mem = Memory.rooms && (Memory.rooms[home.name] || (Memory.rooms[home.name] = {}));
    const logOf = () => (mem ? (mem.defenseLog || (mem.defenseLog = { spawned: 0 })) : { spawned: 0 });
    const orders = brain.get(home.name, 'defense', null);
    const demands = [];
    let priority = 0;
    const seen = new Set();
    const consider = (roomName, record) => {
        if (seen.has(roomName)) return;
        seen.add(roomName);
        // 己方无 spawn 的房（没有外矿记录）每个母房都会考虑一遍：只让最近的那个出兵。外矿只由拥有记录的母房考虑，不套这道门——
        // 以前外矿也要"本房是切比雪夫最近的有 spawn 房"，所属母房不是最近的那条外矿就没人防、大脑的 fight 指令也被丢掉
        // （线上 2026-09-11 8/17 条启用外矿无人防守，入侵一次停产 1300–1500 tick）
        if (!record && closestBase(roomName) !== home.name) return;
        // 不在编的外矿（remote.staffRemotes）没人在采，不值得出兵
        if (record && record.enabled && record.staffed === false) return;
        // safe mode 中的己方房：敌人打不了任何东西，defender 赶到也无事可做（2026-09-06 W31S8 开盾 18 tick 后仍孵了 2 只）
        const target = Game.rooms[roomName];
        if (target && target.controller && target.controller.my && target.controller.safeMode > 0) return;
        const result = evaluate(home, roomName, record, cfg, orders, mem);
        const threat = result.threat;
        if (threat.visible && record) recordThreat(record, threat.hostiles);
        // 己方房清场：连续阵亡计数归零（下一波敌人重新计）
        if (result.own && threat.visible && threat.count === 0) {
            const log = roomLog(roomName);
            if (log.streak !== 0) log.streak = 0;
        }
        const cls = result.own ? 'defense' : 'remoteMaintain';
        if (result.skip) {
            logOf().skipped = Object.assign({ room: roomName, at: Game.time, count: threat.count }, result.skip);
            suspendRecord(record, result.skip.until, 'hostileCreep');
            return;
        }
        if (result.plan) {
            for (let index = 0; index < result.plan.count; index++) {
                const slot = index === 0 ? 'defender:' + roomName : 'defender:' + roomName + ':' + index;
                demands.push(demand('defender', slot, result.plan.body,
                    { home: home.name, targetRoom: roomName, style: result.plan.style, squad: result.plan.count }, 50, priority++, cls));
            }
            return;
        }
        // keeper 房里的 invader core 是 stronghold（带塔/rampart），清核心队的近战 defender 打不动，不派（外矿保持 invaderCore 停用）
        if (!threat.count && threat.core && !(record && record.sk)) {
            demands.push(demand('defender', 'core:' + roomName, defenderBody(capacity, 'melee'),
                { home: home.name, targetRoom: roomName, style: 'melee' }, 50, priority++, cls));
        }
    };
    consider(home.name, null);
    for (const room of Object.values(Game.rooms || {})) {
        if (room.controller && room.controller.my && room.name !== home.name) consider(room.name, null);
    }
    const remotes = mem && mem.remotes || {};
    for (const [roomName, record] of Object.entries(remotes)) {
        if (record && (record.enabled || record.suspendReason === 'invaderCore' || record.suspendReason === 'hostileCreep')) consider(roomName, record);
    }
    return demands;
}

/** defender 死亡（不是主动退役）：记进母房 defenseLog，getDemands 据此在再次看到敌情前不续派。main.js 清理死亡 creep 内存时调用 */
function noteLoss(name, memory) {
    if (!memory || memory.role !== 'defender' || memory.retired) return false;
    const home = memory.home;
    if (!home || typeof Memory === 'undefined' || !Memory.rooms) return false;
    const mem = Memory.rooms[home] || (Memory.rooms[home] = {});
    const log = mem.defenseLog || (mem.defenseLog = { spawned: 0 });
    log.losses = (log.losses || 0) + 1;
    log.lastLoss = { at: Game.time, room: memory.targetRoom || home, name, slot: memory.slotKey || null };
    // 被防守房的连续阵亡计数（己方房的阵亡上限 maxOwnLosses 用它；房间清场后归零）
    const defended = roomLog(memory.targetRoom || home);
    defended.streak = (Number(defended.streak) || 0) + 1;
    console.log('[defense] ' + home + ' lost defender ' + name + ' in ' + (memory.targetRoom || home));
    return true;
}

module.exports = { getDemands, planFor, defenderBody, threatIn, armedHostiles, invaderCore, settings, creepProfile, hostileProfile,
    canBeat, planSquad, recordThreat, noteLoss, BOOSTS };
