'use strict';
/** 工具：每 tick 缓存、身体生成、路径规划、位置辅助、维修目标 */
const config = require('config');

// ---- 每 tick 的 find 结果缓存（跨 creep 复用，省 CPU） ----
const cache = global.__screepsCache || (global.__screepsCache = { tick: -1, data: {} });
function tickCache() {
    if (cache.tick !== Game.time) { cache.tick = Game.time; cache.data = {}; }
    return cache.data;
}
function cacheKeyFor(opts) {
    if (!opts) return '';
    // 函数型 filter 会被 JSON.stringify 丢掉，必须把函数源码纳入键，否则同 tick 不同 filter 会撞缓存
    const filter = typeof opts.filter === 'function' ? opts.filter.toString() : '';
    return JSON.stringify(opts) + '|' + filter;
}

// ---- 每 tick 的 creep 倒排索引 ----
// spawn.js 一个房要按角色/需求项数十次遍历 Game.creeps，×10 个房就是每 tick 上万次 creep 访问；
// harvester 的两个 helper 更是在每只 creep 内部扫全表（O(creeps²)）。这里一 tick 建一次索引，
// 之后都是 O(1) 取数组。creep 数变了就重建（私服/单测会在同一 mock tick 内造 creep）。
const EMPTY_CREEPS = [];
function creepIndex() {
    const c = tickCache();
    const size = Game.creeps ? Object.keys(Game.creeps).length : 0;
    let idx = c.__creepIndex;
    if (!idx || idx.size !== size) {
        idx = { size, byHome: {}, byHomeRole: {} };
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            const memory = creep.memory;
            const home = memory && memory.home;
            if (!home) continue;
            (idx.byHome[home] || (idx.byHome[home] = [])).push(creep);
            const key = home + '|' + (memory.role || '');
            (idx.byHomeRole[key] || (idx.byHomeRole[key] = [])).push(creep);
        }
        c.__creepIndex = idx;
    }
    return idx;
}
/** memory.home === home 的 creep（含 spawning / 退役中，过滤交给调用方，语义与原来的全表遍历一致） */
function creepsHome(home) { return (home && creepIndex().byHome[home]) || EMPTY_CREEPS; }
/** memory.home === home 且 memory.role === role 的 creep */
function creepsHomeRole(home, role) { return (home && creepIndex().byHomeRole[home + '|' + role]) || EMPTY_CREEPS; }

function findCached(room, kind, opts) {
    const key = room.name + '|' + kind + '|' + cacheKeyFor(opts);
    const c = tickCache();
    if (!(key in c)) c[key] = room.find(kind, opts);
    return c[key];
}

// ---- 身体生成 ----
const PART_COST = { move: 50, work: 100, carry: 50, claim: 600, attack: 80, ranged_attack: 150, heal: 250, tough: 10 };
function bodyCost(parts) { return parts.reduce((s, p) => s + PART_COST[p.type || p], 0); }
function repeat(part, n) { const a = []; for (let i = 0; i < n; i++) a.push(part); return a; }
function bodyPartCount(parts, type) {
    let n = 0;
    for (const part of parts || []) {
        if ((part.type || part) !== type) continue;
        if (part.hits != null && part.hits <= 0) continue;
        n++;
    }
    return n;
}
function carryCapacity(parts) { return bodyPartCount(parts, 'carry') * 50; }

/** 房名 → 连续坐标（W0 = -1、W1 = -2 …，E0 = 0、E1 = 1；N/S 同理），remote/defense/aid/movement 共用这一份；roomNameAt 是它的逆 */
function roomCoords(name) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name || '');
    if (!match) return null;
    return {
        x: match[1] === 'W' ? -(Number(match[2]) + 1) : Number(match[2]),
        y: match[3] === 'N' ? -(Number(match[4]) + 1) : Number(match[4]),
    };
}
/** 两个房名的线性（切比雪夫）距离；房名非法为 Infinity。remote/defense/aid/retire 共用 */
function roomDistance(a, b) {
    const pa = roomCoords(a);
    const pb = roomCoords(b);
    if (!pa || !pb) return Infinity;
    return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}
/** 正在走向 spawn 回收退役的 creep（defender 的 retired、换代的 bodyUpgradeRetiring、残废的 crippled，见 retire.js）：
 *  编制/运力/槽位/替补预留都不再算它——它不干活了，替换者已经在岗或槽位已空 */
function isRetiring(memory) {
    return !!(memory && (memory.retired || memory.bodyUpgradeRetiring || memory.crippled || memory.stuckRetiring || memory.pocketTrapped));
}
/** 各角色缺了就干不了活的部件：矿工没 WORK、hauler 没 CARRY 或走不动、升级/建造没 WORK+CARRY、占领没 CLAIM。
 *  静态矿工/升级者不列 MOVE（站桩照干）；defender 有自己的 retired 流程不在此列。
 *  线上 2026-09-06 W32S5：Invader 把 remoteMiner 的 5 WORK、两只 remoteHauler 的 14 CARRY 全打成 0 血，三只残废 creep 还有 870 tick 寿命，
 *  照常"上岗"（hauler 守在源旁等货、矿工往 spot 走），编制计数当它们在岗，替补不孵，外矿采集中断到它们老死 */
const ROLE_ESSENTIAL_PARTS = {
    harvester: ['work'], remoteMiner: ['work'],
    hauler: ['carry', 'move'], remoteHauler: ['carry', 'move'], courier: ['carry', 'move'], feeder: ['carry', 'move'], labTech: ['carry', 'move'],
    operator: ['carry'],
    upgrader: ['work', 'carry'], builder: ['work', 'carry', 'move'], pioneer: ['work', 'carry', 'move'],
    reserver: ['claim', 'move'], claimer: ['claim', 'move'],
    scout: ['move'],
    // SK reaper：没 HEAL 就压不住 keeper 的 100/tick，没 RANGED 就杀不动它（config.sk）
    skReaper: ['heal', 'ranged_attack'],
};
/** 残废：角色必需部件里已经一个活的都没有的种类（数组）；健康或角色不适用返回 null。满血 creep 部件全活，跳过遍历 */
function crippledParts(creep) {
    const memory = creep && creep.memory;
    const essential = memory && ROLE_ESSENTIAL_PARTS[memory.role];
    if (!essential || !Array.isArray(creep.body) || !creep.body.length) return null;
    if (!(creep.hits < creep.hitsMax)) return null;
    const lost = essential.filter((type) => bodyPartCount(creep.body, type) === 0);
    return lost.length ? lost : null;
}
/** 恰好得到 work 个 WORK 的最省升级者预算（makeBody 的 upgrader 模板：W×100 + 2C + 1M）；模板改了这里一起改 */
function upgraderBudgetForWork(work) { return Math.max(0, work) * 100 + 150; }
function roomNameAt(x, y) {
    return (x < 0 ? 'W' + (-x - 1) : 'E' + x) + (y < 0 ? 'N' + (-y - 1) : 'S' + y);
}

/**
 * 按能量预算生成身体。规则（成本见 PART_COST）：
 * harvester  静态矿工，5W 打满源（10 能量/tick），1-3C 缓冲；RCL1 预算不足自动降为 [W,C,M] 往返
 * staticHarvester  已有 container 时使用，优先 5W+MOVE，依靠 container 自动接收掉落能量
 * hauler     [C,C,M]×n，道路网络下满速；剩余预算优先补 CARRY+MOVE
 * upgrader   W≤15（CONTROLLER_MAX_UPGRADE_PER_TICK；RCL8 以下 spawn 用 opts.maxWork 放开到 50 部件），C≥2 保证可携带
 * builder    [W,C,M]×n 通用；剩余预算补一组 WORK+MOVE 或 CARRY+MOVE
 * scout      2M 快速探路
 * remoteMiner 5W 静态远矿，1C 建容器，平地满速抵达后站桩
 * remoteHauler [C,C,M]×n，道路/平原满速远程运输
 * reserver   1-2 组 [CLAIM,MOVE]，容量不足 650 时不生成
 */
function makeBody(role, cap, opts) {
    cap = Math.max(200, cap || 200);
    let parts;
    switch (role) {
        case 'harvester': {
            if (cap < 300) {
                parts = ['work', 'carry', 'move'];
            } else if (cap < 450) {
                parts = ['work', 'work', 'carry', 'move'];
            } else if (cap < 550) {
                parts = ['work', 'work', 'work', 'carry', 'move', 'move'];
            } else if (cap < 600) {
                parts = ['work', 'work', 'work', 'work', 'carry', 'move', 'move'];
            } else {
                parts = ['work', 'work', 'work', 'work', 'work', 'carry', 'move'];
            }
            break;
        }
        case 'staticHarvester': {
            // 静态矿工只走一次到工位；MOVE 取 ceil(W/2) 即可在道路满速（每 tick 消 2 疲劳/MOVE，道路每非 MOVE 部件 1 疲劳）
            const work = Math.max(1, Math.min(5, Math.floor((cap - 50) / 100)));
            const move = Math.max(1, Math.min(Math.ceil(work / 2), Math.floor((cap - work * 100) / 50)));
            parts = repeat('work', work).concat(repeat('move', move));
            break;
        }
        case 'hauler': {
            const n = Math.max(1, Math.min(16, Math.floor(cap / 150))); // ≤48 部件
            parts = [];
            for (let i = 0; i < n; i++) parts.push('carry', 'carry', 'move');
            let remainder = cap - bodyCost(parts);
            // 道路上 2×MOVE ≥ 非 MOVE；用成对部件填满 550/1300 等容量档位。
            if (n < 16 && remainder >= 100) {
                parts.push('carry', 'move');
                remainder -= 100;
            }
            if (n < 16 && remainder >= 50 && parts.length < 50) parts.push('move');
            break;
        }
        case 'upgrader': {
            // WORK 默认封顶 15（RCL8 引擎上限）；RCL8 以下由 spawn 传 opts.maxWork 放开。1 MOVE 静止站位，总部件 ≤ 50 时先削 WORK 不削 MOVE
            const maxWork = Math.max(1, Number(opts && opts.maxWork) || 15);
            // 300 容量档：2W1C1M（300）而不是 1W2C1M（250）——升级者站在容器旁同 tick 取能+升级，CARRY 只要够一轮；
            // 线上 W35S7 控制器容器 84% 满、4 只 1 WORK 的升级者只有 4/tick
            if (cap >= 300 && cap < 350 && maxWork >= 2) {
                parts = ['work', 'work', 'carry', 'move'];
                break;
            }
            const w = Math.max(1, Math.min(maxWork, Math.floor((cap - 150) / 100), 47));   // 47 = 50 − 2C − 1M
            const c = Math.max(1, Math.min(Math.max(2, Math.min(6, Math.floor((cap - 150 - w * 100) / 50))), 50 - w - 1));
            parts = repeat('work', w).concat(repeat('carry', c), ['move']);
            break;
        }
        case 'builder': {
            const n = Math.max(1, Math.min(6, Math.floor(cap / 200)));
            parts = [];
            for (let i = 0; i < n; i++) parts.push('work', 'carry', 'move');
            const remainder = cap - bodyCost(parts);
            // 不牺牲道路移动比：150 预算加 WORK+MOVE，100 预算加 CARRY+MOVE。
            if (remainder >= 150 && parts.length + 2 <= 50) parts.push('work', 'move');
            else if (remainder >= 100 && parts.length + 2 <= 50) parts.push('carry', 'move');
            break;
        }
        case 'feeder': {
            // 专职短途搬运工：CARRY 按需求（opts.carry，spawn.feederBody 按 storage↔控制器容器的距离算），MOVE 一半（基地内有路）；预算不够就减 CARRY，最少 2C1M
            let carry = Math.max(2, Math.min(16, Math.floor(Number(opts && opts.carry) || 4)));
            parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2)));
            while (bodyCost(parts) > cap && carry > 2) { carry--; parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2))); }
            break;
        }
        case 'operator': {
            // 枢纽站桩：走到 storage 与 store link 之间后不再移动。1 MOVE 够用；CARRY 按 opts.carry（默认 8）
            let carry = Math.max(1, Math.min(16, Math.floor(Number(opts && opts.carry) || 8)));
            parts = repeat('carry', carry).concat(['move']);
            while (bodyCost(parts) > cap && carry > 1) { carry--; parts = repeat('carry', carry).concat(['move']); }
            break;
        }
        case 'labTech': {
            // 基地内短途搬矿（roles/labTech）：CARRY 按 opts.carry（spawn.labTechBody：一趟装满一个输入 lab），MOVE 一半（有路）；
            // 预算不够就减 CARRY，最少 2C1M
            let carry = Math.max(2, Math.min(32, Math.floor(Number(opts && opts.carry) || 10)));
            parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2)));
            while (bodyCost(parts) > cap && carry > 2) { carry--; parts = repeat('carry', carry).concat(repeat('move', Math.ceil(carry / 2))); }
            break;
        }
        case 'scout':
            parts = ['move', 'move'];
            break;
        case 'remoteMiner': {
            if (cap >= 700) parts = repeat('work', 5).concat(['carry'], repeat('move', 3));
            else if (cap >= 550) parts = repeat('work', 4).concat(['carry'], repeat('move', 2));
            else if (cap >= 500) parts = repeat('work', 3).concat(['carry'], repeat('move', 2));
            else parts = ['work', 'carry', 'move'];
            break;
        }
        case 'remoteHauler': {
            const n = Math.max(1, Math.min(16, Math.floor(cap / 150)));
            parts = [];
            for (let i = 0; i < n; i++) parts.push('carry', 'carry', 'move');
            break;
        }
        case 'reserver': {
            if (cap >= 1300) parts = ['claim', 'claim', 'move', 'move'];
            else if (cap >= 650) parts = ['claim', 'move'];
            else parts = [];
            break;
        }
        default:
            parts = ['work', 'carry', 'move'];
    }
    while (parts.length > 50) parts.pop(); // 部件数硬上限
    if (bodyCost(parts) > cap) parts = ['work', 'carry', 'move'];
    return parts;
}

// ---- 路径规划（布局用，结果压缩存储） ----
function planPath(room, from, to) {
    const ret = PathFinder.search(from, { pos: to, range: 1 }, {
        plainCost: 2, swampCost: 8, maxRooms: 1,
    });
    if (ret.incomplete || !ret.path.length) return null;
    return ret.path.map((p) => p.x + '.' + p.y).join(';');
}
function unpackPath(str) {
    return str.split(';').map((s) => { const [x, y] = s.split('.'); return { x: +x, y: +y }; });
}
function packedPathLength(str) { return str ? str.split(';').length : 0; }
function pathLength(from, to, opts) {
    const key = [
        'pathlen',
        from.roomName || '',
        from.x, from.y,
        to.roomName || from.roomName || '',
        to.x, to.y,
        opts && opts.range != null ? opts.range : 1,
    ].join('|');
    const c = tickCache();
    if (c[key] != null) return c[key];
    const ret = PathFinder.search(from, { pos: to, range: opts && opts.range != null ? opts.range : 1 }, Object.assign({
        plainCost: 2,
        swampCost: 8,
        maxRooms: 1,
    }, opts || {}));
    if (!ret.incomplete && ret.path && ret.path.length) {
        c[key] = ret.path.length;
        return c[key];
    }
    c[key] = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    return c[key];
}

// ---- 地形 / 位置辅助 ----
function isWall(room, x, y) {
    return room.getTerrain().get(x, y) === TERRAIN_MASK_WALL;
}
function occupied(room, x, y) {
    const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
    if (structures.some((structure) => structure.structureType !== STRUCTURE_ROAD &&
        structure.structureType !== STRUCTURE_RAMPART)) return true;
    return room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length > 0;
}
/** 找 near 周围一格内、朝向 base 方向最近的可用平地（用于容器/link 站位） */
function bestAdjacent(near, room, base, taken) {
    let best = null, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = near.x + dx, y = near.y + dy;
        if (x < 1 || x > 48 || y < 1 || y > 48) continue;
        if (isWall(room, x, y) || occupied(room, x, y)) continue;
        if (taken && taken.has(x + '.' + y)) continue;
        const d = base ? (x - base.x) ** 2 + (y - base.y) ** 2 : 0;
        if (d < bestD) { bestD = d; best = { x, y }; }
    }
    return best;
}

/** 角色计数（存活且含孵化中），按 home 房过滤 */
function countRole(room, role) {
    return creepsHomeRole(room.name, role).length;
}

// ---- 维修目标 ----
/** 房的能量预算（每 tick 每房一次）：rampart 的维修目标按它动态定。
 *  取 max(spawn 收入 EMA, storage / storageTicks)——EMA 是"流量"，storage 是"存量"：
 *  spawn/ext 常年满仓的富房 EMA 会衰减到 0（W33S3 有 14 万 storage 而 EMA 接近 0），光看流量会低估；
 *  反过来只看存量会把"正在被抽干的仓"当成收入。storageTicks 表示"仓里的能量可以按这么多 tick 摊着花"。 */
const energyBudgetCache = { time: -1, rooms: {} };
function roomEnergyBudget(room) {
    if (energyBudgetCache.time !== Game.time) { energyBudgetCache.time = Game.time; energyBudgetCache.rooms = {}; }
    if (energyBudgetCache.rooms[room.name] != null) return energyBudgetCache.rooms[room.name];
    const settings = config.ramparts || {};
    const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const flow = Math.max(0, Number(mem && mem.spawnIncome && mem.spawnIncome.ema) || 0);
    const bankTicks = Math.max(1, Number(settings.storageTicks) || 10000);
    const bank = room.storage && room.storage.my !== false && room.storage.store
        ? Math.max(0, Number(room.storage.store[RESOURCE_ENERGY] || 0)) / bankTicks : 0;
    const budget = Math.max(flow, bank);
    energyBudgetCache.rooms[room.name] = budget;
    return budget;
}

/** 本房升级者当前的 WORK 总数（每 tick 每房一次）：升级限流按房间总量算，多只升级者各分一份。
 *  RCL8 引擎上限 15（CONTROLLER_MAX_UPGRADE_PER_TICK），低于 RCL8 不封顶。 */
const upgraderWorkCache = { time: -1, rooms: {} };
function upgraderWork(room) {
    if (upgraderWorkCache.time !== Game.time) { upgraderWorkCache.time = Game.time; upgraderWorkCache.rooms = {}; }
    if (upgraderWorkCache.rooms[room.name] != null) return upgraderWorkCache.rooms[room.name];
    let work = 0;
    for (const creep of creepsHomeRole(room.name, 'upgrader')) {
        if (creep.spawning) continue;
        if (isRetiring(creep.memory)) continue;
        work += bodyPartCount(creep.body, 'work');
    }
    if (room.controller && room.controller.level >= 8) work = Math.min(work, 15);
    upgraderWorkCache.rooms[room.name] = work;
    return work;
}

/** 本地供给（能量/tick）：每口源按 energyCapacity / 再生周期（300）计——3000 的源 10/tick、1500 的源 5/tick。
 *  这是房间**保证**有的收入（外矿不算），link 链、源容器、hauler 搬的都是这一份。每 tick 每房一次 */
const sourceSupplyCache = { time: -1, rooms: {} };
function sourceSupply(room) {
    if (sourceSupplyCache.time !== Game.time) { sourceSupplyCache.time = Game.time; sourceSupplyCache.rooms = {}; }
    if (sourceSupplyCache.rooms[room.name] != null) return sourceSupplyCache.rooms[room.name];
    const regen = Math.max(1, Number((config.harvesting || {}).regenerationTicks) || 300);
    const kind = typeof FIND_SOURCES === 'undefined' ? 'sources' : FIND_SOURCES;
    const sources = typeof room.find === 'function' ? room.find(kind) || [] : [];
    let supply = 0;
    for (const source of sources) {
        const capacity = Number(source && source.energyCapacity);
        supply += capacity > 0 ? capacity / regen : 10;
    }
    sourceSupplyCache.rooms[room.name] = supply;
    return supply;
}

/** 房间能量吃紧（滞回，状态在 mem.upgradeSupply.low）：storage 低于 upgrading.lowBelow 进入、回到 lowExitAbove 才退出。
 *  没有 storage（或 storage 不是自己的）的房不判断——年轻房的身体受容量限制，本来也吃不满本地收入 */
function upgradeBudgetLow(room, mem) {
    const settings = config.upgrading || {};
    if (!mem) return false;   // 没有房 Memory（换代扫描的个别路径）：不判断，也不写滞回状态
    const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
    const storage = room && room.storage;
    if (!storage || storage.my === false || !storage.store) { track.low = false; return false; }
    const energy = Number(storage.store[RESOURCE_ENERGY] || 0);
    const lowBelow = Math.max(0, Number(settings.lowBelow) || 0);
    const exitAbove = Math.max(lowBelow, Number(settings.lowExitAbove) || lowBelow);
    if (track.low) {
        if (energy >= exitAbove) track.low = false;
    } else if (energy < lowBelow) {
        track.low = true;
    }
    return !!track.low;
}

/** 能量吃紧的房里有没有别的地方等着用能量（滞回：最近一次看到需求后 upgrading.competeHoldTicks 内仍算有）：
 *  想建的工地、塔够不着的维修债（够 outOfReachMinDebt）、spawn 在攒能量、spawn/ext 持续 competeUnfullTicks 没补满。
 *  都没有时限流让出来的能量没人要——线上 W34S7/W35S7 两份快照都是 backlog 0、维修债 0、spawn 空闲、能量满，
 *  storage 0/2–3k 在低档停了两万 tick，限流上线后进度 12.3→9.5、13.5→10.9 CP/tick。每 tick 每房可调用多次（写入是幂等的） */
function upgradeCompeting(room, mem) {
    const settings = config.upgrading || {};
    const track = mem.upgradeSupply || (mem.upgradeSupply = { ema: 0, extra: 0, at: -1, changedAt: -1 });
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    const state = mem.state || {};
    const construction = config.construction || {};
    const why = [];
    if (Number(state.builderBacklog) > 0) why.push('backlog');
    if (Number(state.builderRepairDebt) >= Math.max(1, Number(construction.outOfReachMinDebt) || 10000)) why.push('repair');
    if (spawnWaitingFor(room)) why.push('spawn');
    // "没补满"要真缺才算：低于容量的 competeUnfullShare 才开始计时。差几十能量（hauler 一车一车地补、最后一格 extension 晚几 tick）
    // 不是竞争——线上 1789127820665 刚部署时 W34S7 停在 1756/1800、spawn 空闲没有请求，照样被算成 unfull 限流了 185 tick
    const available = Number(room.energyAvailable);
    const capacity = Number(room.energyCapacityAvailable);
    const unfullShare = Math.max(0, Math.min(1, Number(settings.competeUnfullShare) || 0.8));
    if (available < capacity * unfullShare) {
        if (!(Number(track.unfullSince) > 0)) track.unfullSince = now;
        if (now - Number(track.unfullSince) >= Math.max(1, Number(settings.competeUnfullTicks) || 100)) why.push('unfull');
    } else {
        if (track.unfullSince) track.unfullSince = 0;
        if (available < capacity) {
            // 遥测（决策事件）：没满但在份额以上，不算竞争（旧规则只要没满就计时）
            const seen = track.unfullIgnored;
            if (!seen || seen.at !== now) track.unfullIgnored = { at: now, n: (Number(seen && seen.n) || 0) + 1 };
        }
    }
    if (why.length) { track.competeAt = now; track.competeWhy = why.join(','); }
    return track.competeAt != null && now - Number(track.competeAt) < Math.max(1, Number(settings.competeHoldTicks) || 300);
}

/** 升级者总 WORK 上限：房间能量吃紧、且有别的地方等着用能量（upgradeCompeting）时控制器只吃本地供给的 incomeShare，
 *  其余留给搬运/维修/建造；Infinity = 不设限。
 *  依据（线上 W33S7 2026-09-10，link 供能房）：20 WORK 升级者把 20/tick 的本地收入全吃光——storage 13、
 *  源容器 0/10/0、两只 hauler 空手挂机、builder 走 13 格刮 56 能量、24 个路工地 0 进度。
 *  降额后 link 链会堵满，矿工的"link 满了就送容器"兜底生效，房间其余部分才有能量。
 *  遥测 mem.upgradeSupply.capHeld / capFree（{at, n}）：限流生效 / 吃紧但没有竞争需求而放开的 tick 数 */
function upgraderWorkCap(room, mem) {
    if (!upgradeBudgetLow(room, mem)) return Infinity;
    const settings = config.upgrading || {};
    const share = Number(settings.incomeShare);
    if (!Number.isFinite(share) || share <= 0 || share >= 1) return Infinity;
    const track = mem.upgradeSupply;
    const now = typeof Game !== 'undefined' ? Game.time : 0;
    const note = (key) => {
        const entry = track[key];
        if (entry && entry.at === now) return;
        track[key] = { at: now, n: (Number(entry && entry.n) || 0) + 1 };
    };
    if (!upgradeCompeting(room, mem)) { note('capFree'); return Infinity; }
    note('capHeld');
    return Math.max(1, Math.floor(sourceSupply(room) * share));
}

/** 升级者可持续供养的总 WORK（config.upgrading.storageDrainTicks）：本地供给（每口源 capacity/regen = 10/tick）
 *  + storage 超过 lowExitAbove 的部分摊到 storageDrainTicks 里花完；RCL8 封 15（引擎上限）。
 *  null = 不封顶：没有自己 storage 的年轻房，身体本来受容量限制，编制由控制器容器到货的 EMA 管。
 *  与 upgraderWorkCap（瞬时限流，只在吃紧且有竞争需求时生效，一放开就是 Infinity）不同，它只随 storage 缓慢变化，
 *  身体与编制按它定就不会跟着限流的开关来回换代（线上 2026-10-08：限流放开就孵 W47，CP 却被 ctrl link 的 20/tick 卡死） */
function upgraderSupplyWork(room, mem) {
    const storage = room && room.storage;
    if (!storage || storage.my === false || !storage.store) return null;
    const settings = config.upgrading || {};
    const floor = Math.max(0, Number(settings.lowExitAbove) || 0);
    const drainTicks = Math.max(1, Number(settings.storageDrainTicks) || 1500);
    const surplus = Math.max(0, Number(storage.store[RESOURCE_ENERGY] || 0) - floor) / drainTicks;
    let cap = Math.max(1, Math.ceil(sourceSupply(room)) + Math.floor(surplus));
    if (room.controller && room.controller.level >= 8) cap = Math.min(cap, 15);
    return cap;
}

/** 已建 rampart 数（每 tick 每房一次）：外环的维修预算是"摊到每格"的，格子越多每格越薄 */
const rampartCountCache = { time: -1, rooms: {} };
function rampartCount(room) {
    if (rampartCountCache.time !== Game.time) { rampartCountCache.time = Game.time; rampartCountCache.rooms = {}; }
    if (rampartCountCache.rooms[room.name] != null) return rampartCountCache.rooms[room.name];
    const kind = typeof FIND_MY_STRUCTURES === 'undefined' ? 'myStructures' : FIND_MY_STRUCTURES;
    const rampartType = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
    const count = (room.find(kind) || []).filter((s) => s.structureType === rampartType).length;
    rampartCountCache.rooms[room.name] = Math.max(1, count);
    return rampartCountCache.rooms[room.name];
}

/** 结构维修目标 hits：其它结构按 hitsMax；rampart 按房间能量收支**动态**定（不再固定修到 RCL 表）。
 *  外环几十格，RCL6 每格 10 万血 × 84 格 = 840 万血 ≈ 10 万能量（塔 80 血/能量），远超房间收入；
 *  而 rampart 归零只是失去防护、1 能量即可重建——把目标定得修不满，只会让维修队列永远排不完、挤掉道路与容器。
 *  目标 = 能量预算 × 用于 rampart 的份额 × 抬升期 × 每能量维修量 ÷ 已建 rampart 数，
 *  夹在 rampartFloorHits 与 min(hitsMax, rampartRepairCap, RCL 表) 之间：
 *  收入养得起就修到 RCL 表（够用即止），养不起就按比例降低，收入上来再自动抬高。 */
function repairTargetHits(room, structure) {
    if (!structure || structure.hitsMax == null) return 0;
    if (structure.structureType === STRUCTURE_RAMPART) {
        const level = room && room.controller ? Number(room.controller.level) || 0 : 0;
        const table = config.rampartTargetHits || {};
        const byLevel = table[level] == null ? 0 : Number(table[level]) || 0;
        const cap = Math.max(0, Math.min(structure.hitsMax, Number(config.rampartRepairCap) || Infinity, byLevel));
        if (!(cap > 0) || !room || typeof room.find !== 'function') return cap;
        const settings = config.ramparts || {};
        const share = Math.max(0, Number(settings.incomeShare) || 0);
        const raiseTicks = Math.max(0, Number(settings.raiseTicks) || 0);
        const hitsPerEnergy = Math.max(1, Number(settings.hitsPerEnergy) || 80);
        const floorHits = Math.max(0, Number(settings.floorHits) || 0);
        const affordable = roomEnergyBudget(room) * share * raiseTicks * hitsPerEnergy / rampartCount(room);
        return Math.max(0, Math.min(cap, Math.max(floorHits, affordable)));
    }
    return structure.hitsMax;
}
/** 危急水位：方案内的非 rampart 结构掉到维修目标的 criticalRepairShare 以下。
 *  容器/道路烂到 0 就消失了——容器要 5000 能量重建还丢采矿位——而 rampart 归零只是失去防护、随时可重建，
 *  且它的低血量本来就由塔/safe mode 那一套管，所以这里排除 rampart。
 *  spawn.hasBuilderWork 用它越过"有塔就不为维修孵 builder"的守卫（线上 2026-09-07：W35S7 两个源容器 14.3k/25 万 = 5.7%，
 *  塔净回填 2.9 血/tick、填满要约 9.3 万 tick ≈ 4 天，而离归零只剩 1434 tick） */
function criticallyDamaged(room, structure) {
    if (!structure || structure.hits == null) return false;
    if (structure.structureType === STRUCTURE_RAMPART) return false;
    // 墙不衰减、也不在维修范围内（needsRepair 同样排除）：它的维修目标是 hitsMax 3 亿，按比例永远"危急"——
    // 线上 2026-09-11 W34S7 的 builder 停在两面方案外旧墙旁每 tick 灌 2 能量，塔补能也因此被提到 spawn 之前
    if (structure.structureType === STRUCTURE_WALL) return false;
    // 方案外的旧建筑不修（needsRepair 同一判据）：塔的维修池已经过滤，危急目标这边以前漏了——
    // builder 会为一条方案外、注定要衰减掉的旧路走 20 格（线上 2026-09-10 W33S7 的 (26,19) 等 3 条）
    if (!plannedStructure(room, structure)) return false;
    const share = Number(config.criticalRepairShare);
    if (!Number.isFinite(share) || share <= 0) return false;
    const target = repairTargetHits(room, structure);
    return target > 0 && structure.hits < target * share;
}

/** 房里有没有"会消失的"危急结构（每 tick 每房一次，spawn 用它把第一只 builder 提到生存档）。
 *  容器/道路烂到 0 就消失：重建一条路 300–1500 能量、一个容器 5000 能量 + 丢采矿位，而维修 100 血只要 1 能量。
 *  线上 2026-09-09 W33S7：没有 builder 的 45 分钟里 24 个道路工地 0 进度、射程外的路继续归零——
 *  builder 是发展档，永远排在外矿维护（remoteMaintain）后面。 */
const criticalRoomCache = { time: -1, rooms: {} };
function hasCriticalStructure(room) {
    if (criticalRoomCache.time !== Game.time) { criticalRoomCache.time = Game.time; criticalRoomCache.rooms = {}; }
    if (criticalRoomCache.rooms[room.name] != null) return criticalRoomCache.rooms[room.name];
    const kind = typeof FIND_STRUCTURES === 'undefined' ? 'structures' : FIND_STRUCTURES;
    const found = findCached(room, kind).some((s) => criticallyDamaged(room, s));
    criticalRoomCache.rooms[room.name] = found;
    return found;
}

/** 维修目标排序（tower.js 与 roles/builder.js 共用一份定义，两边曾各排各的）：
 *  先按"会不会消失"分组——危急水位的非 rampart 结构排在最前，其余按离维修目标的比例从低到高。
 *  依据（线上 2026-09-07 的自然对照实验，同 RCL、同机制、结果相反，只由谁的比值低决定）：
 *    W35S7 rampart 3.40% < 容器 4.73% ⇒ 塔全修 rampart，715 tick 里 rampart +8600 血、两个容器纯衰减 −10000；
 *    W34S7 容器 17.8% < rampart 18.0% ⇒ 塔修容器，src1 从 27.6k 一路回到 44.6k。
 *  W35S7 升 RCL5 时 rampart 的目标从 3 万跳到 10 万，比值一夜之间掉到容器之下——升级重开了这个竞争窗口。
 *  容器/道路烂到 0 就消失（容器要 5000 能量重建，还丢采矿位），rampart 归零只是失去防护且随时可重建，
 *  所以危急的前者优先。规则有界：容器爬回 criticalRepairShare 之上，rampart 立刻恢复正常竞争。 */
function repairPriority(room, structure) {
    return criticallyDamaged(room, structure) ? 0 : 1;
}

function compareRepairTargets(room, a, b) {
    const byClass = repairPriority(room, a) - repairPriority(room, b);
    if (byClass !== 0) return byClass;
    return (a.hits / Math.max(1, repairTargetHits(room, a))) - (b.hits / Math.max(1, repairTargetHits(room, b)));
}

/** 这个格上是否有己方核心建筑（spawn/塔/storage/terminal）：盖在上面的 rampart 不算方案外，按 RCL 目标维修 */
function rampartProtectsCore(room, x, y) {
    if (!room || typeof room.lookForAt !== 'function') return false;
    const types = [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_TERMINAL];
    return (room.lookForAt(LOOK_STRUCTURES, x, y) || []).some((s) => s && s.my !== false && types.includes(s.structureType));
}

/** 方案里全部道路格的键集合（每 tick 每房一份）：needsRepair 对每条路都要判断"在不在方案里"，
 *  旧写法每次都对每个 packed 串做 (';'+packed+';').includes(...)——一条路 5 个串、每个 1–2 KB。
 *  tower.js 每座塔每 tick 全房过滤一次，broker 的维修池与危急结构扫描也要用，这里摊平成 O(1) 查找。
 *  外矿路网的键 `remote:<外矿>:<源>` 存的是这条路线**在本房里的那一段**（remote.syncHomeRoads 写入
 *  source.routeRoads[本房]），坐标属于本房，照常收进来——2026-09-10 曾把它们当成外矿房坐标过滤掉，
 *  结果全账号约 100 格母房外矿路段没人修、烂到 0 后又被 layout 重新放工地（W32S4 的 W33S4 路线掉到 4%）。 */
const planRoadKeyCache = { time: -1, rooms: {} };
function planRoadKeys(room, plan) {
    if (planRoadKeyCache.time !== Game.time) { planRoadKeyCache.time = Game.time; planRoadKeyCache.rooms = {}; }
    const cacheKey = room.name + '|' + (plan.version || '') + '|' + (plan.made || '');
    if (planRoadKeyCache.rooms[cacheKey]) return planRoadKeyCache.rooms[cacheKey];
    const keys = new Set();
    for (const packed of Object.values(plan.roads || {})) {
        if (typeof packed !== 'string' || !packed) continue;
        for (const point of packed.split(';')) if (point) keys.add(point);
    }
    planRoadKeyCache.rooms[cacheKey] = keys;
    return keys;
}

/** 结构在不在布局方案里（方案外的旧建筑不再花能量修：挡路的由拆迁调度拆掉，其余任其衰减）。
 *  没有轮子方案（旧房 / plan 还没生成）时一律算"在方案里"，保持旧行为。
 *  只判断方案里明确列了位置的那几类（道路/容器/rampart）——spawn 等建筑可能是方案生成前的旧位置
 *  （线上 W33S7 的 spawn 在 (23,21)，plan.spawns 是 (30,24)），对它们做"不在方案里就不修"会冻掉维修。 */
function plannedStructure(room, structure) {
    if (!structure || !structure.pos) return true;
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room && room.name];
    const plan = mem && mem.plan;
    if (!plan || !plan.wheel) return true;
    if (structure.structureType === STRUCTURE_ROAD) {
        return !plan.roads || planRoadKeys(room, plan).has(structure.pos.x + '.' + structure.pos.y);
    }
    if (structure.structureType === STRUCTURE_CONTAINER) {
        if (!plan.containers) return true;
        return Object.values(plan.containers).some((pos) => pos && pos.x === structure.pos.x && pos.y === structure.pos.y);
    }
    if (structure.structureType === STRUCTURE_RAMPART) {
        if (!Array.isArray(plan.ramparts)) return true;
        // 方案外的 rampart 不再维修，任其衰减（拆迁调度不主动拆它）；盖在 spawn/塔/storage/terminal 上的例外
        return plan.ramparts.some((pos) => pos && pos.x === structure.pos.x && pos.y === structure.pos.y) ||
            rampartProtectsCore(room, structure.pos.x, structure.pos.y);
    }
    return true;
}

/** 是否值得维修：wall 不修；rampart 低于 RCL 目标（方案外且不护核心建筑的不修）；其它低于 hitsMax×towerRepairBelow */
function needsRepair(room, structure) {
    if (!structure || structure.hits == null || structure.hitsMax == null) return false;
    if (structure.structureType === STRUCTURE_WALL) return false;
    if (!plannedStructure(room, structure)) return false;
    if (structure.structureType === STRUCTURE_RAMPART) return structure.hits < repairTargetHits(room, structure);
    return structure.hits < structure.hitsMax * config.towerRepairBelow;
}

// ---- 错误记录（写入 Memory.errors，可通过 console API 检查） ----
function logErr(where, e) {
    if (!Memory.errors) Memory.errors = [];
    Memory.errors.unshift({
        t: Game.time, where,
        msg: (e && e.message) || String(e),
        stack: e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : '',
    });
    Memory.errors.length = Math.min(Memory.errors.length, 20);
    console.log(`<span style="color:red">[ERR] ${where}: ${(e && e.message) || e}</span>`);
}

// ---- creep 取名：东方 Project 人物名 ----
// 名字第一眼就要能读出角色：每个 role 固定一位东方人物，同角色的多只靠前缀/后缀组合区分。
// 角色/归属仍然一律从 Memory.creeps[name] 读，没有任何代码从名字里反解析 role——
// 所以 pioneer 中途转 builder 这类情况名字不会跟着变（Screeps 不支持给 creep 改名），以 Memory 为准。
const ROLE_CHARACTERS = {
    harvester: '穣子',      // 秋穣子 · 丰收之神，管产出
    hauler: '荷取',         // 河城荷取 · 名字直译就是"搬运"
    upgrader: '慧音',       // 上白泽慧音 · 教书育人，养 controller
    builder: '霖之助',      // 森近霖之助 · 香霖堂店主，造与修
    pioneer: '魔理沙',      // 雾雨魔理沙 · 到处闯的开拓者
    claimer: '灵梦',        // 博丽灵梦 · 立结界、占地盘
    reserver: '诹访子',     // 洩矢诹访子 · 土地神，圈地但不占领
    scout: '文文',          // 射命丸文 · 幻想乡最快的天狗记者
    defender: '美铃',       // 红美铃 · 红魔馆门番
    remoteMiner: '勇仪',    // 星熊勇仪 · 地底的怪力鬼
    remoteHauler: '阿燐',   // 火焰猫燐 · 推着独轮车来回搬
    courier: '铃仙',        // 铃仙·优昙华院·因幡 · 永远亭的跑腿，替母房把 storage 的能量送去弱房
    feeder: '橙',           // 八云橙 · 跑得快的猫式神，只在 storage 和控制器容器之间来回
    operator: '紫',         // 八云紫 · 站在 storage 与 store link 的隙间倒能
    mineralMiner: '雏田',    // 矿物钻机：只管挖矿脉、自己送去 terminal
    labTech: '帕秋莉',      // 帕秋莉·诺蕾姬 · 图书馆的魔女，管实验室的进出货
    skReaper: '妹红',
    depositMiner: '萃香',   // 伊吹萃香 · 搬山的鬼，去过道把矿堆一点点搬回家
    depositScout: '琪露诺', // 琪露诺 · 到处乱飞的冰精，巡过道房       // 藤原妹红 · 不死之身，站在 keeper 射程边缘打持久战
};

const UNNAMED_ROLE_CHARACTER = '妖精'; // 没登记的角色：交给无名杂鱼妖精兜底

// 前缀刻意避开所有人物名的首字（妖精/灵梦），免得「妖穣子」「灵荷取」看起来像别的角色。
// 两张表都以空串打头，所以每个角色的第一只拿到干净的本名（穣子），人多了才开始挂修饰。
// 15 × 11 = 165 个组合／角色，远超任何时候的同角色在编数。
const NAME_PREFIXES = ['', '小', '幻', '梦', '宵', '绯', '苍', '幽', '隐', '真', '深', '常', '永', '雅', '新'];
const NAME_SUFFIXES = ['', '甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

let nameFallbackSeq = 0;

// 名字根 = 第一个 '.' 之前的部分（'穣子.upgrade' 与 '穣子' 视为同一只，不重发）。
// 每次现算而不缓存：spawnCreep 成功会立刻写 Memory.creeps[name]，同 tick 连续孵化也不会撞名；
// 孵化失败的名字不占坑，下一次调用还能用。
function usedNameStems() {
    const used = new Set();
    if (typeof Game !== 'undefined' && Game.creeps) for (const name in Game.creeps) used.add(name.split('.')[0]);
    if (typeof Memory !== 'undefined' && Memory.creeps) for (const name in Memory.creeps) used.add(name.split('.')[0]);
    return used;
}

/**
 * 按 role 取一个没被占用的东方人物名；tag 为可选后缀（upgrade/elastic/drop 等孵化路径标记）。
 * 取的是第一个空组合而不是随机组合：编制稳定时名字也稳定，死一只之后新的那只会顶回同一个名字。
 */
// ---- 周期性工作的错峰相位 ----
// 曾经用 room.name.charCodeAt(i) 直接当相位。标准房名（W33S7）第 4 位对所有两位坐标的房间恒为
// 'S'/'N'，于是全部房间拿到同一个相位、同 tick 齐发，注释里写的「不同房间不同相位」从未成立。
// 用整名 hash 代替：任何房名长度都能均匀散开，且跨 tick/global reset 稳定。
function roomPhase(name, interval) {
    if (!interval || interval <= 1) return 0;
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
    return hash % interval;
}

// 本 tick 是否轮到该房做这件周期性工作
function isRoomPhaseTick(name, interval) {
    return Game.time % interval === roomPhase(name, interval);
}

function creepName(role, tag) {
    const base = ROLE_CHARACTERS[role] || UNNAMED_ROLE_CHARACTER;
    const used = usedNameStems();
    const suffix = tag ? '.' + tag : '';
    for (let round = 0; round < 100; round++) {
        const extra = round ? String(round + 1) : '';
        for (const prefix of NAME_PREFIXES) {
            for (const tail of NAME_SUFFIXES) {
                const stem = prefix + base + tail + extra;
                if (!used.has(stem)) return stem + suffix;
            }
        }
    }
    // 165 个组合 × 100 轮全撞满才到得了这里。兜底也必须查重：撞名会让 spawnCreep 直接 ERR_NAME_EXISTS，
    // 而 nameFallbackSeq 会在 global reset 时清零，光靠自增序号保证不了唯一。
    // 试 used.size + 1 个互不相同的串，鸽笼原理保证其中至少一个是空的。
    let stem = '';
    for (let attempt = 0; attempt <= used.size; attempt++) {
        stem = base + '_' + Game.time.toString(36) + '_' + (nameFallbackSeq++).toString(36);
        if (!used.has(stem)) break;
    }
    return stem + suffix;
}

/** spawn 正在等能量孵一只买不起的 creep（spawn.js 每 tick 记录 spawnWaiting）：hauler 的"控制器优先"公平规则要让路 */
function spawnWaitingFor(room) {
    const mem = (typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[room.name]) || null;
    const waiting = mem && mem.spawnWaiting;
    if (!waiting || !(waiting.cost > 0)) return false;
    if (typeof Game !== 'undefined' && Game.time - Number(waiting.at || 0) > 5) return false;
    return room.energyAvailable < waiting.cost;
}

/** 塔的补能是否"紧急"（broker 第 1 层、权重压过 spawn/ext；hauler 兜底与 remoteHauler.homeTarget 同一判定）：有敌人，或储备
 *  （towerRepairReserve）被动用。动用后锁存在 Memory.rooms[房].towerUrgent[塔 id]（动用的 tick），补到不缺（缺口 < towerRefillAt）
 *  才解除（记 0）——中途零头到货把塔顶回储备线以上不降级：线上 2026-09-06 W33S8 远程 hauler 的 82 把塔顶到 580，满载的 hauler 走到
 *  塔边掉头空跑，塔烧回 490 又把它叫回去。和平期从"已补满"跌破储备只可能是维修/治疗动了储备（tower.js 已禁止），记 towerBreaches /
 *  towerBreachAt 作遥测与私服生效断言；打仗打掉的不算。 */
function towerUrgent(room, tower, hostile) {
    const store = tower && tower.store;
    if (!store) return !!hostile;
    const energyKey = typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy';
    const energy = Number(store[energyKey]) || 0;
    const reserve = Number(config.towerRepairReserve) || 500;
    const refillAt = Number(config.towerRefillAt) || 300;
    const free = typeof store.getFreeCapacity === 'function' ? Number(store.getFreeCapacity(energyKey)) || 0 : 0;
    const mem = typeof Memory !== 'undefined' && Memory.rooms && room && Memory.rooms[room.name];
    if (!mem) return !!hostile || energy < reserve;
    const latch = mem.towerUrgent || (mem.towerUrgent = {});
    const previous = latch[tower.id];
    if (energy < reserve) {
        if (!(previous > 0)) {
            if (previous === 0 && !hostile) {
                mem.towerBreaches = (Number(mem.towerBreaches) || 0) + 1;
                mem.towerBreachAt = Game.time;
            }
            latch[tower.id] = Game.time;
        }
        return true;
    }
    if (hostile) return true;
    if (previous > 0) {
        if (free < refillAt) { latch[tower.id] = 0; return false; }
        return true;
    }
    return false;
}

/** 房里有闲置能量：某个（非控制器）容器 ≥ containerShare 满，或地上掉落能量 ≥ dropped。无 storage 的房用它判断"能量在等 WORK"：
 *  builder 不再等投递、可自取，builder 上限 +1（config.energySurplus） */
function energySurplus(room, opts) {
    if (!room || typeof room.find !== 'function') return false;
    const settings = Object.assign({ containerShare: 0.75, dropped: 1000 }, config.energySurplus || {}, opts || {});
    const plan = (Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].plan) || {};
    const ctrl = plan.containers && plan.containers.ctrl;
    const containers = room.find(FIND_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.store }) || [];
    for (const container of containers) {
        if (ctrl && container.pos && container.pos.x === ctrl.x && container.pos.y === ctrl.y) continue;
        const capacity = typeof container.store.getCapacity === 'function' ? container.store.getCapacity(RESOURCE_ENERGY) : 2000;
        if (capacity > 0 && (container.store[RESOURCE_ENERGY] || 0) >= capacity * settings.containerShare) return true;
    }
    let dropped = 0;
    for (const drop of room.find(FIND_DROPPED_RESOURCES) || []) {
        if (drop.resourceType === RESOURCE_ENERGY) dropped += Number(drop.amount) || 0;
    }
    return dropped >= settings.dropped;
}


/** 平地上每走一格要几 tick：非 MOVE 部件每个产生 2 疲劳，每个 MOVE 每 tick 消 2；ceil(非 MOVE / MOVE)，没有 MOVE 视为无穷。
 *  静态矿工 5W1C1M = 6，bootstrap 的 2W1C1M = 3（harvester.js / spawn.js 用它判断"这只矿工不该往返送 spawn"） */
function bodyTicksPerTile(body) {
    let move = 0;
    let other = 0;
    for (const part of body || []) {
        const type = part && part.type ? part.type : part;
        if (part && part.hits === 0) continue;
        if (type === 'move') move++; else other++;
    }
    if (!move) return Infinity;
    return Math.max(1, Math.ceil(other / move));
}

/** storage 富余（攒着的能量该花在升级上）的滞回状态：能量 ≥ storageFeedAbove 进入，< storageFeedBelow 才退出，状态记在 mem.storageRich {on, at}。
 *  没有滞回时 storage 在阈值上下抖动，富余规则只花掉超过阈值的增量（2026-09-06 A/B：W33S8/W35S7 的 storage 最后 2 万 tick 停在 19.0–19.2k）。
 *  broker（取货权重/投递层级）、spawn（升级者上限、hauler 编制）与 hauler 兜底共用这一份判定 */
/** 援建导出的水位线：不能压在 storage 富余线之下。
 *  富余状态（storageRichState）是 20000 进、10000 退，而援建导出原本是 10000 就导、只留 5000——
 *  于是有弱房可援的母房永远进不了富余，富余带来的一整套机制（控制器容器投递提到第 1 层、
 *  maxUpgradersRich、feeder、hauler 的 storageFeedRate 项）全部是暗的。线上四个 storage
 *  合计 34,308 能量因此闲置，而 W34S7 距离 RCL5 只差 32,068 CP。
 *  取两者的较大值：只导出富余线以上的部分，并至少留住退出线，母房自己先站在富余带里。 */
function aidExportLevels(aidSettings, upgradingSettings) {
    const aid = aidSettings || {};
    const upgrading = upgradingSettings || {};
    const above = Math.max(Number(aid.exportAbove) || 0, Number(upgrading.storageFeedAbove) || 0);
    const keep = Math.max(Number(aid.exportKeep) || 0, Number(upgrading.storageFeedBelow) || 0);
    return { above, keep: Math.min(keep, above) };
}

function storageRichState(room, mem, settings) {
    const store = room && room.storage && room.storage.my !== false && room.storage.store;
    const energy = store ? Number(store.energy || 0) : 0;
    const above = Number(settings && settings.storageFeedAbove) || 20000;
    const below = Math.min(above, Number(settings && settings.storageFeedBelow) || 10000);
    const state = mem ? (mem.storageRich || (mem.storageRich = { on: false, at: -1 })) : null;
    const was = !!(state && state.on);
    const on = energy >= above || (was && energy >= below);
    if (state && on !== was) { state.on = on; state.at = Game.time; }
    return on;
}

/** 零产出的"奢侈"建筑：当前代码里没有任何逻辑靠 terminal / lab / factory / nuker / powerSpawn 产出能量或 CP
 *  （industry.canSpend 要 storage ≥ 10 万且 terminal 里有 1 万能量才动用它们）。房间 storage 攒到
 *  construction.luxuryStorageAbove 之前：layout 不放新工地、builder 不建已有工地、spawn 不为它们算 builder 编制。
 *  否则升级限流（storage 低时控制器只吃本地收入的 60%）让出来的能量全被 builder 灌进 10 万的 terminal，
 *  storage 永远攒不起来、限流永远解不开（线上 2026-09-11 W33S7：storage 0 时 terminal 工地 +8.9/tick，
 *  控制器只有 6.1/tick；基准 61b4caf 这类建筑共吃掉 200 万能量，期末 8 个房 storage 全是 0、工业从未解锁）。
 *  已有的工地保留进度，门槛过了照常接着建。
 *  terminal 不在此列（2026-10-03）：它是工业解锁（industry.canSpend 要 terminal 里有能量）与后续市场/物流的前提，
 *  线上 12 个 RCL7 房 storage 常年 0–10k、永远过不了 3 万门槛，terminal 因此一座没有；门槛也从 3 万降到 1 万。 */
const LUXURY_TYPES = new Set(['lab', 'factory', 'nuker', 'powerspawn']);
function luxuryStructure(type) {
    // 引擎里是 'terminal' / 'powerSpawn'；兼容 'structure_power_spawn' 这类写法（冒烟 mock 与 constructionBacklog 的归一化同口径）
    const t = String(type || '').toLowerCase().replace(/^structure_/, '').replace(/_/g, '');
    return LUXURY_TYPES.has(t);
}

function luxuryAllowed(room) {
    const threshold = Number((config.construction || {}).luxuryStorageAbove);
    if (!(threshold > 0)) return true;
    const store = room && room.storage && room.storage.my !== false && room.storage.store;
    const energy = store ? Number(store[typeof RESOURCE_ENERGY !== 'undefined' ? RESOURCE_ENERGY : 'energy'] || 0) : 0;
    return energy >= threshold;
}

/** 工地现在该不该有人建（奢侈建筑没过经济门槛时不算） */
function siteWanted(room, site) {
    return !!site && (!luxuryStructure(site.structureType) || luxuryAllowed(room));
}

/** 节能模式（10-16 战略猫）：有 storage 的己方房 storage 能量 < 5000 进入，>= 20000 退出（滞回，状态存 Memory.rooms[n].conserve）。
 *  无 storage 的房不进入：低 RCL 房 energyAvailable 永远 < 5000，按代理值会永久停建。
 *  节能期间：builder 不建不修、把手里能量交回 storage；升级者至多 1 只最小身体，控制器降级计时 > 一半时不取能。 */
const conserveCache = { time: -1, rooms: {} };
function conserving(room) {
    if (!room || !room.controller || !room.controller.my) return false;
    if (conserveCache.time !== Game.time) { conserveCache.time = Game.time; conserveCache.rooms = {}; }
    if (conserveCache.rooms[room.name] !== undefined) return conserveCache.rooms[room.name];
    // 10-16 战略猫修正：storage+terminal < 2000 且 spawn 等能量 >= 300 tick 才进入；>= 10000 退出（状态 Memory.rooms[n].conserve2）
    const mem = Memory.rooms[room.name] || (Memory.rooms[room.name] = {});
    const energy = (room.storage && room.storage.store ? Number(room.storage.store[RESOURCE_ENERGY] || 0) : 0) +
        (room.terminal && room.terminal.my !== false && room.terminal.store ? Number(room.terminal.store[RESOURCE_ENERGY] || 0) : 0);
    let waiting = false;
    try { waiting = !!spawnWaitingFor(room); } catch (e) { waiting = false; }
    if (waiting) { if (!mem.spawnWaitSince) mem.spawnWaitSince = Game.time; }
    else if (mem.spawnWaitSince) delete mem.spawnWaitSince;
    const waited = mem.spawnWaitSince ? Game.time - mem.spawnWaitSince : 0;
    const prev = !!(mem.conserve2 && mem.conserve2.on);
    const on = !!room.storage && (prev ? energy < 10000 : (energy < 2000 && waited >= 300));
    if (on !== prev || !mem.conserve2) mem.conserve2 = { on, at: Game.time, energy };
    if (mem.conserve) delete mem.conserve;
    conserveCache.rooms[room.name] = on;
    return on;
}

/** 节能模式下升级者是否允许取能：控制器降级计时低于该 RCL 满值的一半 */
function conserveUpgradeAllowed(room) {
    const c = room && room.controller;
    if (!c || c.ticksToDowngrade == null) return true;
    const full = (typeof CONTROLLER_DOWNGRADE !== 'undefined' && CONTROLLER_DOWNGRADE[c.level]) || 0;
    return !full || c.ticksToDowngrade < full / 2;
}

/** 高威胁玩家（config.pvp）：非 NPC、在 highThreat 名单里，或带战斗部件的玩家 creep */
const PVP_NPC = ['Invader', 'Source Keeper'];
function pvpHostile(creep) {
    const owner = creep && creep.owner && creep.owner.username;
    if (!owner || PVP_NPC.indexOf(owner) >= 0) return false;
    const cfg = config.pvp || {};
    if ((cfg.highThreat || []).indexOf(owner) >= 0) return true;
    return creep.body && creep.body.some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK || p.type === HEAL));
}
/** 记一次可见房的玩家威胁（己方房不记：那里归防御管）。返回房里的威胁 creep 列表 */
const pvpCache = { time: -1, rooms: {} };
function notePvpThreat(room) {
    if (!room) return [];
    if (pvpCache.time !== Game.time) { pvpCache.time = Game.time; pvpCache.rooms = {}; }
    if (pvpCache.rooms[room.name]) return pvpCache.rooms[room.name];
    const own = !!(room.controller && room.controller.my);
    const list = own ? [] : room.find(FIND_HOSTILE_CREEPS).filter(pvpHostile);
    if (list.length) {
        const m = Memory.pvpThreat || (Memory.pvpThreat = {});
        m[room.name] = { until: Game.time + (Number((config.pvp || {}).armedMemory) || 300), user: list[0].owner.username, n: list.length, at: Game.time };
    }
    pvpCache.rooms[room.name] = list;
    return list;
}
/** 这个房现在要回避：手动 dangerRooms，或 armedMemory 内见过玩家威胁 */
function pvpDangerRoom(name) {
    const cfg = config.pvp || {};
    if ((cfg.dangerRooms || []).indexOf(name) >= 0) return true;
    const rec = Memory.pvpThreat && Memory.pvpThreat[name];
    if (rec && rec.until > Game.time) return true;
    if (rec && Game.time % 100 === 0) delete Memory.pvpThreat[name];
    return false;
}

module.exports = {
    pvpHostile,
    notePvpThreat,
    pvpDangerRoom,
    conserving,
    conserveUpgradeAllowed,
    isRetiring,
    luxuryStructure,
    luxuryAllowed,
    siteWanted,
    crippledParts,
    storageRichState,
    aidExportLevels,
    bodyTicksPerTile,
    energySurplus,
    spawnWaitingFor,
    towerUrgent,
    findCached,
    creepsHome,
    creepsHomeRole,
    makeBody,
    bodyCost,
    bodyPartCount,
    carryCapacity,
    roomCoords,
    roomDistance,
    roomNameAt,
    upgraderBudgetForWork,
    upgraderWork,
    sourceSupply,
    upgradeBudgetLow,
    upgraderWorkCap,
    upgraderSupplyWork,
    planPath,
    unpackPath,
    packedPathLength,
    pathLength,
    isWall,
    occupied,
    bestAdjacent,
    countRole,
    repeat,
    repairTargetHits,
    planRoadKeys,
    plannedStructure,
    needsRepair,
    criticallyDamaged,
    hasCriticalStructure,
    compareRepairTargets,
    rampartProtectsCore,
    creepName,
    roomPhase,
    isRoomPhaseTick,
    logErr,
};
