'use strict';
/**
 * 攻占子系统：夺取相邻玩家的已占房。占玩家房 = 反复 attackController 把控制器降到 0 级（变无主）再 claimController。
 * 由指令 Memory.conquest 驱动，缺省（无指令）时整块**零影响**——getDemands 返回空、run 空转、新角色无 creep 即惰性。
 *
 * 指令结构（由 console / 外部大脑写入）。Memory.conquest 可为**单个指令对象**，或**指令数组**（多目标并行）：
 *   Memory.conquest = {
 *     target: 'W31S4',              // 目标房
 *     sponsors: ['W33S7','W34S7'],  // 出兵的母房（或 'all' = 所有够格己方房）
 *     staging: 'W30S4',             // 房外集结点（中立房）
 *     dismantlers: 22,              // 破防单位总数（跨母房均摊）
 *     guards: 5,                    // 护卫（RANGED_ATTACK+HEAL）总数：对付敌方战斗 creep、护住 downgrader
 *     downgraders: 2,               // 围降接力并发数
 *     avoid: ['W32S4'],             // 去集结点途中额外要绕开的敌方房（目标房总是绕）
 *     phase: 'breach'|'downgrade'|'claim'|'done',  // 由 run() 依目标房视野自动推进
 *     safeMode: <tick|null>,        // run() 观察到的目标开盾到期 tick
 *     hostiles: <n>,                // run() 观察到的目标房内敌方战斗 creep 数（门控围降期 guard）
 *   }
 *
 * 阶段：breach（拆塔+spawn，护卫同波）→ downgrade（attackController 围降，敌方战斗 creep 未清则续派护卫）→ claim（无主后占领）→ done。
 * suppress:true 时无主/预定房走 deny（持续围降预定 + 清工人），不 claim、不 completed，对方再占就回到 breach/downgrade。
 * 详见 docs/analysis/2026-09-06-w31s4-w32s4-conquest.md。
 */
const config = require('config');
const { roomDistance } = require('utils');

function settings() {
    return Object.assign({
        dismantlerBudget: 1800,   // 破防单位理想身体成本（[WORK,MOVE]×12 = 1800）
        downgraderBudget: 1300,   // 围降单位理想身体成本（[CLAIM,MOVE]×2 = 1300）
        guardBudget: 2200,        // 护卫理想身体成本（[RANGED_ATTACK,HEAL,MOVE,MOVE]×n）
        minCapacity: 1300,        // 母房容量低于此不参与出破防单位
        storageFloor: 15000,      // 母房 storage 能量低于此不出破防/护卫（保住本房经济与外矿 reserver）；围降接力不受限（占领必须）
        reformShare: 0.7,         // 进目标房后重新聚合的比例：到齐这么多同波成员才一起推进（过出口是单列，会拉成长蛇）
        reformWait: 60,           // 聚合最多等这么多 tick（有人卡住/阵亡也不至于死等）
        towerAvoidRange: 8,       // 过境避塔半径：非目标房里离敌塔这么多格内的格子加成本，逼寻路贴远缘绕过（塔在此范围内 DPS 高）
        towerAvoidWeight: 6,      // 过境避塔权重：越靠近塔加得越多（(半径-距离+1)×权重），把塔火杀人窗口从必经拉到可绕
        boosts: { dismantler: [], guard: [] },   // 出发前强化的化合物（src/boost.js），默认空 = 关闭
        boostMaxWait: 100,        // 强化最多在家耗这么多 tick，超时放弃整份清单直接出发
        lootBudget: 1600,         // strongholdLoot 搬运兵理想身体成本（[carry,move]）
        lootRetreatBelowHalf: true,   // 拆墙队总血量 < 满血一半 → 全员撤退
    }, config.conquest || {});
}

/** 所有合法指令的数组。Memory.conquest 可为单个指令对象或指令数组（多目标并行）；非法项被过滤。 */
function directives() {
    const raw = Memory.conquest;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((d) => d && typeof d === 'object' && typeof d.target === 'string' &&
        // completed 是终态：房子占下来之后指令就退休了。没有这一条时 phase 每 tick 都从视野重推，
        // 房子一旦易手（被打回去 / 被别人占）就自动从 'done' 翻回 'breach'，在没有人下令的情况下
        // 重新拉起整波拆迁 + 护卫——这是本 bot 能自己启动的最贵的操作。记录留着做复盘，只是不再出兵。
        !d.completed &&
        (d.sponsors === 'all' || (Array.isArray(d.sponsors) && d.sponsors.length)));
}

/** 兼容旧接口：返回第一个合法指令，缺省/全非法返回 null。 */
function directive() {
    const list = directives();
    return list.length ? list[0] : null;
}

/** 实际出兵的母房集合：显式数组，或 'all' 时取所有容量 ≥ minCapacity 的己方房（按房名排序，稳定分摊） */
function sponsorRooms(d) {
    if (Array.isArray(d.sponsors)) return d.sponsors.slice();
    const cap = settings().minCapacity;
    return Object.values(Game.rooms || {})
        .filter((r) => r.controller && r.controller.my && r.find(FIND_MY_SPAWNS).length &&
            r.energyCapacityAvailable >= cap && r.name !== d.target)
        .map((r) => r.name).sort();
}

/** 按 pattern（如 ['work','move']）在预算内重复堆叠，部件总数不超过 50 */
function repeatBody(pattern, budget) {
    const cost = pattern.reduce((s, t) => s + BODY_COST[t], 0);
    const maxByBudget = Math.floor(budget / cost);
    const maxByParts = Math.floor(50 / pattern.length);
    const n = Math.max(1, Math.min(maxByBudget, maxByParts));
    const body = [];
    // 按 pattern 分组堆叠（[work×n, move×n]）：部件损毁从身体末尾回填，分组比交错更可控
    for (const t of pattern) for (let i = 0; i < n; i++) body.push(t);
    return body;
}
const BODY_COST = { move: 50, work: 100, attack: 80, carry: 50, heal: 250, ranged_attack: 150, tough: 10, claim: 600 };

/**
 * 等待位：把**等待中**的攻城 creep 按名字散到锚点周围各自的格子（5×5 网格，可要求离锚点至少 minRange），
 * 而不是全挤同一个锚点。全挤一个锚点时，先到的会被后到者的寻路穿过、被交通解算反复对调，白烧 CPU（线上实测）。
 * 名字哈希 → 稳定偏移：同一只 creep 每 tick 得到同一个格子，到位后就不再调 movement.go。
 */
function holdTile(anchor, name, minRange) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
    const min = Math.max(0, Number(minRange) || 0);
    // 在 5×5 网格里跳过离锚点太近的格子（例如给 downgrader 留出控制器相邻格）
    const cells = [];
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) >= min) cells.push([dx, dy]);
        }
    }
    const [dx, dy] = cells[hash % cells.length];
    const x = Math.max(2, Math.min(47, anchor.x + dx));
    const y = Math.max(2, Math.min(47, anchor.y + dy));
    return new RoomPosition(x, y, anchor.roomName);
}

/**
 * 进场泳道：沿目标房入口边把 creep **横向散开**成各自的进场点。
 * 长蛇不是因为出口窄（很多房出口有几十格宽），而是所有 creep 用同一个目标寻路 → 走同一条最短路 → 排成一列。
 * 给每只不同的进场点 → 并行过境、同时抵达 → 塔"射程内有目标"的总时长（= 杀人数）大幅缩短。
 * alongX：入口在上/下边时沿 x 散开，在左/右边时沿 y 散开。
 */
function laneTile(anchor, name, halfWidth, alongX) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i) + 7) & 0xffff;
    const w = Math.max(1, Number(halfWidth) || 8);
    const base = (hash % (2 * w + 1)) - w;
    const at = (off) => ({
        x: alongX ? Math.max(2, Math.min(47, anchor.x + off)) : anchor.x,
        y: alongX ? anchor.y : Math.max(2, Math.min(47, anchor.y + off)),
    });
    // 地形感知：泳道点若落在墙里，寻路够不到会让 creep 卡住（B0 实测出现过整队没进房）。
    // Room.Terrain 无视野也能取，沿轴向两侧找最近的可走格。
    const terrain = (typeof Game !== 'undefined' && Game.map && typeof Game.map.getRoomTerrain === 'function')
        ? Game.map.getRoomTerrain(anchor.roomName) : null;
    const wallMask = (typeof TERRAIN_MASK_WALL === 'undefined') ? 1 : TERRAIN_MASK_WALL;
    let pick = at(base);
    if (terrain) {
        let found = null;
        for (let d = 0; d <= 2 * w && !found; d++) {
            for (const off of (d === 0 ? [base] : [base - d, base + d])) {
                if (off < -w || off > w) continue;
                const p = at(off);
                if ((terrain.get(p.x, p.y) & wallMask) === 0) { found = p; break; }
            }
        }
        if (found) pick = found;
    }
    return new RoomPosition(pick.x, pick.y, anchor.roomName);
}

/** 攻城 creep 出发前要上的化合物（src/boost.js）：指令的 boosts {dismantler, guard} 整份覆盖 config.conquest.boosts
 *  （config 默认空 = 关闭；部署会把 config 重置回默认，所以打仗时要开就写在指令里，不靠改 config） */
function boostsFor(role, d) {
    const key = role === 'siegeDismantler' ? 'dismantler' : role === 'siegeGuard' ? 'guard' : null;
    if (!key) return [];
    const source = d && d.boosts && typeof d.boosts === 'object' ? d.boosts : (settings().boosts || {});
    const list = source[key];
    return Array.isArray(list) ? list.filter((compound) => typeof compound === 'string' && compound) : [];
}

/** 强化有没有打开：config.conquest.boosts 或任一生效指令的 boosts 里有化合物。
 *  task_broker 只在打开时给 boost lab 补能量——默认关闭时补进去的能量没人用，一直锁在 lab 里（2026-10-14 复审） */
function boostingEnabled() {
    const any = (d) => boostsFor('siegeDismantler', d).length > 0 || boostsFor('siegeGuard', d).length > 0;
    if (any(null)) return true;
    return directives().some((d) => d.boosts && typeof d.boosts === 'object' && any(d));
}

/** 需求项（与 remote/expansion/defense 同结构，cls='conquest'）；d 是指令（攻城角色据此带上 boosts） */
function demand(role, slot, body, memory, lead, priority, d) {
    const boosts = boostsFor(role, d);
    const extra = boosts.length ? { boosts } : {};
    return { role, slot, body, memory: Object.assign({ role, slotKey: slot }, memory, extra), lead, priority, cls: 'conquest' };
}

/** 把指令的过境规避信息拷进 creep memory：avoid（去集结点绕开的房）+ avoidTowers（过境房里已知的敌塔位，
 *  {房名: [[x,y],...]}）。avoidTowers 由操作者按侦察填在指令里——路径在**首次计算**时就能绕塔，不必等进房才发现（那时已贴上）。 */
function attachAvoidance(mem, d) {
    if (Array.isArray(d.avoid) && d.avoid.length) mem.avoid = d.avoid;
    if (d.avoidTowers && typeof d.avoidTowers === 'object') mem.avoidTowers = d.avoidTowers;
    return mem;
}

/** 目标房内敌方（有主、非我方）战斗 creep 数：带 ATTACK/RANGED_ATTACK/HEAL 部件的才算 */
function countHostileCombat(room) {
    const hostiles = (room.find(FIND_HOSTILE_CREEPS) || []);
    let n = 0;
    for (const c of hostiles) {
        const body = c.body || [];
        if (body.some((p) => p.type === ATTACK || p.type === RANGED_ATTACK || p.type === HEAL)) n++;
    }
    return n;
}

/** 敌塔（有主、非我方、有坐标）位置列表。用 FIND_STRUCTURES + owner 过滤（与 runOne 同款，mock 友好）。 */
function hostileTowersOf(room) {
    return (room.find(FIND_STRUCTURES) || [])
        .filter((s) => s.structureType === STRUCTURE_TOWER && s.owner && !s.my
            && s.pos && typeof s.pos.x === 'number' && typeof s.pos.y === 'number');
}

/** 过境避塔：把看到的敌塔位缓存到 Memory.siegeTowers[room]（独立于 brain 情报，避免被合并覆盖）。
 *  只在有视野时更新；有视野且无敌塔则清掉本房旧缓存。每房每 tick 最多记一次。
 *  传入 creep 时，若它在**非目标房**且该房有敌塔，把它到最近敌塔的距离记进 Memory.siegeTransit[room]（取最小，
 *  遥测/生效断言用：避塔生效时这个最小值应远大于塔最佳射程 5）。 */
function recordHostileTowers(room, creep) {
    if (!room || !room.name || !room.controller || typeof room.find !== 'function') return;
    if (typeof Memory === 'undefined') return;
    const store = Memory.siegeTowers || (Memory.siegeTowers = {});
    const prev = store[room.name];
    if (prev && prev.at === Game.time) { noteTransitDist(room, creep, prev.pos); return; }
    const towers = hostileTowersOf(room);
    if (towers.length) {
        const pos = towers.map((t) => [t.pos.x, t.pos.y]);
        store[room.name] = { pos, at: Game.time };
        noteTransitDist(room, creep, pos);
    } else {
        delete store[room.name];
    }
}

function noteTransitDist(room, creep, towerPos) {
    if (!creep || !creep.pos || !creep.memory || room.name === creep.memory.targetRoom) return;
    if (!Array.isArray(towerPos) || !towerPos.length) return;
    let min = Infinity;
    for (const p of towerPos) {
        const d = Math.max(Math.abs(creep.pos.x - p[0]), Math.abs(creep.pos.y - p[1]));
        if (d < min) min = d;
    }
    if (!isFinite(min)) return;
    const t = Memory.siegeTransit || (Memory.siegeTransit = {});
    if (t[room.name] === undefined || min < t[room.name]) t[room.name] = min;
}

const TOWER_CACHE_TTL = 3000;
/** 某房已知敌塔位，合并三个来源（去重）：实时视野 ∪ 未过期缓存 ∪ 指令声明（extra[roomName]，操作者按侦察填）。
 *  指令声明是关键：路径**首次计算**（在集结点、还没进过境房）时就有塔位可绕——否则等进房才发现，早已贴上、且轮子已缓存直穿路径。 */
function knownHostileTowers(roomName, extra) {
    const out = [];
    const seen = new Set();
    const add = (x, y) => { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); out.push({ x, y }); } };
    const room = typeof Game !== 'undefined' && Game.rooms ? Game.rooms[roomName] : null;
    if (room && typeof room.find === 'function') for (const t of hostileTowersOf(room)) add(t.pos.x, t.pos.y);
    const store = typeof Memory !== 'undefined' && Memory.siegeTowers;
    const entry = store && store[roomName];
    if (entry && Array.isArray(entry.pos) && (Game.time - (entry.at || 0)) <= TOWER_CACHE_TTL) {
        for (const p of entry.pos) add(p[0], p[1]);
    }
    if (extra && Array.isArray(extra[roomName])) for (const p of extra[roomName]) add(p[0], p[1]);
    return out;
}

/** 攻城移动的 costCallback：在**非目标房**（过境房）里把敌塔周围格子按距离加成本，逼寻路贴离塔最远的边走完过境
 *  （塔按"射程内有目标的总时长"杀人，绕开=不挨打，也顺带压住一字长蛇）。目标房不避——要贴塔把它拆掉。
 *  extraTowers = creep.memory.avoidTowers（指令声明的过境塔位），让首次寻路即可绕塔，不必等进房才发现。 */
function towerAvoidCallback(targetRoom, extraTowers) {
    const cfg = settings();
    const range = Math.max(1, Number(cfg.towerAvoidRange) || 8);
    const weight = Math.max(1, Number(cfg.towerAvoidWeight) || 6);
    return function (roomName, costMatrix) {
        if (!costMatrix || typeof costMatrix.set !== 'function' || typeof costMatrix.get !== 'function') return costMatrix;
        if (roomName === targetRoom) return costMatrix;
        const towers = knownHostileTowers(roomName, extraTowers);
        if (!towers.length) return costMatrix;
        for (const t of towers) {
            for (let dx = -range; dx <= range; dx++) {
                for (let dy = -range; dy <= range; dy++) {
                    const x = t.x + dx;
                    const y = t.y + dy;
                    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                    const dist = Math.max(Math.abs(dx), Math.abs(dy));
                    if (dist > range) continue;
                    const cur = costMatrix.get(x, y);
                    if (cur >= 255) continue;   // 墙/不可走保持不变
                    costMatrix.set(x, y, Math.min(254, cur + (range - dist + 1) * weight));
                }
            }
        }
        return costMatrix;
    };
}

/** 全局每 tick：对每个指令依目标房视野推进阶段（无视野时保持当前阶段） */
function run() {
    skValidateFuseTick();
    for (const d of directives()) runOne(d);
}
function runOne(d) {
    if (d.type === 'strongholdLoot') return runStrongholdLoot(d);
    const room = Game.rooms[d.target];
    if (!room || !room.controller) return;
    const ctrl = room.controller;
    d.safeMode = ctrl.safeMode && ctrl.safeMode > 0 ? ctrl.safeMode : null;
    d.hostiles = countHostileCombat(room);
    if (ctrl.my) {
        d.phase = 'done';
        if (!d.completed) { d.completed = true; d.completedAt = Game.time; }
        return;
    }
    if (!ctrl.owner) {
        // suppress：打掉后继续占着门口（预定/无主），不交给 claimer，也不把指令标 completed
        d.phase = d.suppress ? 'deny' : 'claim';
        return;
    }
    const towers = room.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_TOWER && s.owner && !s.my);
    const spawns = room.find(FIND_STRUCTURES).filter((s) => s.structureType === STRUCTURE_SPAWN && s.owner && !s.my);
    // suppress + 无塔：继续围降，不因一个 RCL1 spawn 翻成 breach（破防被 storageFloor 挡住后接力 CLAIM 会停，W38S9）
    if (d.suppress && !towers.length) {
        d.phase = 'downgrade';
        return;
    }
    // 攻城遥测：本波存活数，以及**破防那一刻**的存活数。损失只能在破防瞬间量——之后幸存者会把 extension 拆完、
    // 退役离场，事后再数只能数到零星掉队者（这个坑让第一版损失指标完全失效）。
    let alive = 0;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.targetRoom !== d.target) continue;
        if (c.memory.role === 'siegeDismantler' || c.memory.role === 'siegeGuard') alive++;
    }
    d.siegeAlive = alive;
    const breached = !towers.length && !spawns.length;
    if (breached && d.siegeAtBreach == null) d.siegeAtBreach = alive;
    d.phase = breached ? 'downgrade' : 'breach';
}

/** 10-17 战略硬规则：出发前逐只检查 target 的每只 dismantler/guard，conquest.boosts 里的每种化合物都要已装在对应 body 部件上。
 *  任一只没装好 → 整队（含 skReaper/lootHauler）留在家里等待，Memory.conquest[该指令].waitReason 记原因。
 *  指令没写 boosts → 不设门（返回 ready）。 */
/** 需要 lab 预留/装载的军事化合物集合（有 boosts 的 strongholdLoot 指令，默认空 = 零影响） */
function militaryCompounds() {
    const set = [];
    for (const d of directives()) {
        if (d.type !== 'strongholdLoot') continue;
        for (const c of boostsFor('siegeDismantler', d).concat(boostsFor('siegeGuard', d))) if (set.indexOf(c) < 0) set.push(c);
    }
    return set;
}
function directiveFor(targetRoom) {
    for (const d of directives()) if (d.target === targetRoom) return d;
    return null;
}
function appliedCompounds(creep) {
    return new Set((creep.body || []).map((p) => p.boost).filter(Boolean));
}
function squadBoostReady(targetRoom) {
    const d = directiveFor(targetRoom);
    if (!d) return { ready: true };
    const want = { siegeDismantler: boostsFor('siegeDismantler', d), siegeGuard: boostsFor('siegeGuard', d) };
    if (!want.siegeDismantler.length && !want.siegeGuard.length) return { ready: true };
    let units = 0;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.targetRoom !== targetRoom) continue;
        const need = want[c.memory.role];
        if (!need || !need.length) continue;
        units++;
        if (c.spawning) return { ready: false, reason: 'boosting:spawning:' + name };
        const have = appliedCompounds(c);
        for (const compound of need) if (!have.has(compound)) return { ready: false, reason: 'boosting:' + name + ':' + compound };
    }
    // 还没孵够预期的攻击单位：继续等（避免先到的几只提前出发）
    const expect = (Math.max(0, Number(d.dismantlers) || 0) * (want.siegeDismantler.length ? 1 : 0)) +
        (Math.max(0, Number(d.guards) || 0) * (want.siegeGuard.length ? 1 : 0));
    if (expect > 0 && units < expect) return { ready: false, reason: 'boosting:assembling:' + units + '/' + expect };
    return { ready: true };
}
/** 角色用：这个目标的部队是否该因 boost 未装齐而留在家里等待（默认关：无 boosts 指令时恒 false） */
function boostGateHold(targetRoom) {
    const r = squadBoostReady(targetRoom);
    if (!r.ready) {
        const d = directiveFor(targetRoom);
        if (d) d.waitReason = r.reason;
    } else {
        const d = directiveFor(targetRoom);
        if (d && d.waitReason && String(d.waitReason).indexOf('boosting') === 0) delete d.waitReason;
    }
    return !r.ready;
}

/** 10-17 strongholdLoot：战利品容器所在的格子。显式 d.lootTiles（[[x,y],...]）优先；否则按视野里"有非能量资源的容器"自动算。 */
function lootTilesOf(d, room) {
    if (Array.isArray(d.lootTiles) && d.lootTiles.length) return d.lootTiles.map((p) => [p[0], p[1]]);
    if (!room || typeof room.find !== 'function') return [];
    const type = typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER;
    return (room.find(FIND_STRUCTURES) || [])
        .filter((s) => s.structureType === type && s.store && nonEnergyAmount(s.store) > 0)
        .map((s) => [s.pos.x, s.pos.y]);
}
function nonEnergyAmount(store) {
    if (!store) return 0;
    let n = 0;
    for (const k in store) if (k !== (typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY)) n += Number(store[k]) || 0;
    return n;
}
function tileKey(x, y) { return x + ',' + y; }
/** 盖在战利品格子上的敌方 rampart（strongholdLoot 只拆这些，核心和其它 rampart 不碰） */
function lootRampartTargets(room, tiles) {
    if (!room || typeof room.find !== 'function' || !tiles || !tiles.length) return [];
    const set = new Set(tiles.map((p) => tileKey(p[0], p[1])));
    const type = typeof STRUCTURE_RAMPART === 'undefined' ? 'rampart' : STRUCTURE_RAMPART;
    return (room.find(FIND_STRUCTURES) || []).filter((s) => s.structureType === type && s.owner && !s.my && set.has(tileKey(s.pos.x, s.pos.y)));
}
/** 战利品格子上还有东西可取的敌方容器 */
function lootContainersOf(room, tiles) {
    if (!room || typeof room.find !== 'function' || !tiles || !tiles.length) return [];
    const set = new Set(tiles.map((p) => tileKey(p[0], p[1])));
    const type = typeof STRUCTURE_CONTAINER === 'undefined' ? 'container' : STRUCTURE_CONTAINER;
    return (room.find(FIND_STRUCTURES) || []).filter((s) => s.structureType === type && set.has(tileKey(s.pos.x, s.pos.y)) && s.store && nonEnergyAmount(s.store) > 0);
}
/** 本波拆墙队（siegeDismantler）总血量 < 满血一半 → 撤退 */
function squadBelowHalf(targetRoom) {
    let hits = 0, max = 0, n = 0;
    for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (!c.memory || c.memory.targetRoom !== targetRoom || c.memory.role !== 'siegeDismantler' || c.spawning) continue;
        hits += Number(c.hits) || 0; max += Number(c.hitsMax) || 0; n++;
    }
    return n > 0 && max > 0 && hits < max / 2;
}
/** 角色读取：这个目标的 strongholdLoot 指令是否处于撤退态 */
function retreatFor(targetRoom) {
    for (const d of directives()) if (d.type === 'strongholdLoot' && d.target === targetRoom && d.retreat) return true;
    return false;
}
function runStrongholdLoot(d) {
    const room = Game.rooms[d.target];
    const cfg = settings();
    if (cfg.lootRetreatBelowHalf !== false) d.retreat = squadBelowHalf(d.target);
    if (!room || typeof room.find !== 'function') return;   // 无视野：保持当前阶段
    const tiles = lootTilesOf(d, room);
    if (tiles.length) d.lootTiles = tiles;
    const use = (Array.isArray(d.lootTiles) && d.lootTiles.length) ? d.lootTiles : tiles;
    const ramparts = lootRampartTargets(room, use);
    const containers = lootContainersOf(room, use);
    d.rampartsLeft = ramparts.length;
    d.lootLeft = containers.reduce((sum, c) => sum + nonEnergyAmount(c.store), 0);
    if (!use.length || (ramparts.length === 0 && containers.length === 0)) {
        d.phase = 'done';
        if (!d.completed) { d.completed = true; d.completedAt = Game.time; }
        return;
    }
    d.phase = ramparts.length ? 'breach' : 'loot';
}

/** 母房为所有攻占指令产生的孵化需求（跨目标聚合） */
function getDemands(home) {
    if (!home || !home.controller || !home.controller.my) return [];
    const out = [];
    for (const item of skValidateDemands(home)) out.push(item);
    for (const d of directives()) {
        for (const item of demandsFor(d, home)) out.push(item);
    }
    return out;
}

/** 单个指令对某母房的需求 */
function demandsFor(d, home) {
    const sponsors = sponsorRooms(d);
    if (sponsors.indexOf(home.name) < 0) return [];
    if (d.phase === 'done') return [];
    if (d.type === 'strongholdLoot') return strongholdLootDemands(d, home, sponsors);
    const cfg = settings();
    if (home.energyCapacityAvailable < cfg.minCapacity) return [];
    // storageFloor：母房 storage 能量低于底线就不出破防/护卫（保住本房经济与外矿 reserver，防止一波集结把资助战争的经济抽干）
    // 只门控有 storage 的房（真实 RCL4+ sponsor）；无 storage 的房（RCL3）由 minCapacity 兜底，不套 storageFloor
    const storeEnergy = (home.storage && home.storage.store) ? (home.storage.store.energy || 0) : 0;
    // 指令可覆盖 storageFloor（0 = 不门控）。Celr 远端房要出兵时母房 storage 经常低于默认 15000。
    const floor = d.storageFloor != null ? Number(d.storageFloor) : cfg.storageFloor;
    const storageOk = !floor || !home.storage || storeEnergy >= floor;
    const phase = d.phase || 'breach';
    const staging = d.staging || null;
    const nSponsors = sponsors.length || 1;
    const totalDismantlers = Math.max(0, Number(d.dismantlers) || 0);
    const totalGuards = Math.max(0, Number(d.guards) || 0);
    // 本波攻击总人数（破防 + 护卫）：集结阈值 squad，全员到齐再一起进目标房
    const squad = Math.max(1, totalDismantlers + totalGuards);
    const demands = [];

    if (phase === 'breach') {
        if (!storageOk) return demands; // storage 不足底线：本房不出破防/护卫（其它够格母房仍参与）
        const mem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad }, d);
        const dPer = Math.ceil(totalDismantlers / nSponsors);
        const body = repeatBody(['work', 'move'], Math.min(home.energyCapacityAvailable, cfg.dismantlerBudget));
        for (let i = 0; i < dPer; i++) {
            demands.push(demand('siegeDismantler', 'siege:' + d.target + ':' + home.name + ':' + i, body, mem, 80, i, d));
        }
        // 护卫与破防同波集结
        const gPer = Math.ceil(totalGuards / nSponsors);
        if (gPer > 0) {
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) {
                demands.push(demand('siegeGuard', 'guard:' + d.target + ':' + home.name + ':' + i, gbody, mem, 85, i, d));
            }
        }
    } else if (phase === 'downgrade') {
        // 围降由离目标最近的**单个** sponsor 独家出：attackController 每控制器每 1000 tick 只能一次，多只只会抢控制器旁的格子对调，
        // 一只持续在位就吃满上限。提速靠单只 CLAIM 数（每次 −300×CLAIM），由 d.downgraderBudget 放大体型（默认 config 1300 = 2 CLAIM）。
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            const nDg = Math.max(1, Number(d.downgraders) || 1);
            const dgBudget = Math.max(650, Number(d.downgraderBudget) || cfg.downgraderBudget);
            const dgbody = repeatBody(['claim', 'move'], Math.min(home.energyCapacityAvailable, dgBudget));
            const dgmem = { home: home.name, targetRoom: d.target };
            if (d.suppress) dgmem.suppress = true;
            for (let i = 0; i < nDg; i++) {
                demands.push(demand('downgrader', 'downgrade:' + d.target + ':' + home.name + ':' + i, dgbody, dgmem, 60, i));
            }
        }
        // 围降期敌方战斗 creep 未清（kiter 会猎杀无攻的 downgrader）：续派护卫贴身掩护（单独进，不等大队）；storage 不足底线的房不出
        if (totalGuards > 0 && (Number(d.hostiles) || 0) > 0 && storageOk) {
            const gPer = Math.ceil(totalGuards / nSponsors);
            const gmem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad: 1 }, d);
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) {
                demands.push(demand('siegeGuard', 'guard:' + d.target + ':' + home.name + ':' + i, gbody, gmem, 70, i, d));
            }
        }
    } else if (phase === 'deny') {
        // 持续压制：预定/无主房。CLAIM 拆预定（Overmind 看不见纯 CLAIM），可选护卫清矿工/reserver。
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            const nDg = Math.max(1, Number(d.downgraders) || 1);
            const dgBudget = Math.max(650, Number(d.downgraderBudget) || cfg.downgraderBudget);
            const dgbody = repeatBody(['claim', 'move'], Math.min(home.energyCapacityAvailable, dgBudget));
            const dgmem = { home: home.name, targetRoom: d.target, suppress: true };
            for (let i = 0; i < nDg; i++) {
                demands.push(demand('downgrader', 'downgrade:' + d.target + ':' + home.name + ':' + i, dgbody, dgmem, 60, i));
            }
        }
        if (totalGuards > 0 && storageOk) {
            const gPer = Math.ceil(totalGuards / nSponsors);
            const gmem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad: 1, suppress: true }, d);
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) {
                demands.push(demand('siegeGuard', 'guard:' + d.target + ':' + home.name + ':' + i, gbody, gmem, 70, i, d));
            }
        }
    } else if (phase === 'claim') {
        // noClaim：占领交给外部大脑的 claim.queue（母房分配 + pioneer 建 spawn + 守成），conquest 只负责破防+围降，不孵 claimer（避免与大脑 claimer 撞车）
        if (d.noClaim) return demands;
        // 只由离目标最近的 sponsor 出 claimer（避免多房重复孵）
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            demands.push(demand('claimer', 'conquer-claim:' + d.target, ['claim', 'move'],
                { home: home.name, targetRoom: d.target }, 100, 0));
        }
    }
    return demands;
}

/** 10-17 skReaper 单只验证模式（config.sk.validate，默认关）：指定 home 出 1 只 reaper 去 room，验证血量/击杀 */
function skValidateOn(homeName, roomName) {
    const v = (config.sk || {}).validate;
    if (!v || !v.enabled || typeof v.room !== 'string') return false;
    const fuse = typeof Memory !== 'undefined' && Memory ? Memory.skValidateFuse : null;
    if (fuse && fuse.tripped) return false;
    return (homeName === undefined || v.home === homeName) && (roomName === undefined || v.room === roomName);
}

function tripSkValidate(fuse, reason) {
    const v = (config.sk || {}).validate || {};
    fuse.tripped = { at: Game.time, reason, name: fuse.name || null, home: v.home || null, room: v.room || null };
    const msg = '[sk.validate] fuse tripped: ' + reason + ' reaper=' + (fuse.name || '?') + ' ' + (v.home || '?') + '->' + (v.room || '?') + ' tick ' + Game.time + '; validate disabled via Memory.skValidateFuse';
    if (typeof Game !== 'undefined' && typeof Game.notify === 'function') Game.notify(msg);
    require('utils').logErr('sk.validateFuse', new Error(msg));
}

function skValidateFuseTick() {
    if (!skValidateOn()) return null;
    const v = config.sk.validate;
    const fuse = Memory.skValidateFuse || (Memory.skValidateFuse = {});
    if (!fuse.name) {
        const found = Object.values(Game.creeps || {}).find((c) => c && c.memory && c.memory.role === 'skReaper' && c.memory.validate && c.memory.home === v.home);
        if (!found) return fuse;
        fuse.name = found.name;
        fuse.seenAt = Game.time;
    }
    if (fuse.entered) return fuse;
    const creep = Game.creeps[fuse.name];
    if (!creep) { tripSkValidate(fuse, 'diedBeforeEntry'); return fuse; }
    if (creep.spawning) return fuse;
    if (!fuse.born) fuse.born = Game.time - Math.max(0, 1500 - (Number(creep.ticksToLive) || 1500));
    if (creep.pos && creep.pos.roomName === v.room) { fuse.entered = Game.time; return fuse; }
    const window = Math.max(1, Number(v.entryWindow) || 300);
    if (Game.time - fuse.born >= window) tripSkValidate(fuse, 'noEntryWithin' + window);
    return fuse;
}

function skValidateDemands(home) {
    const v = (config.sk || {}).validate;
    if (!skValidateOn(home.name)) return [];
    if (Memory.skValidateFuse && Memory.skValidateFuse.name) return [];
    const n = Math.max(1, Number(v.units) || 9);
    const body = [];
    for (let i = 0; i < n; i++) body.push('ranged_attack');
    for (let i = 0; i < n; i++) body.push('heal');
    for (let i = 0; i < 2 * n; i++) body.push('move');
    if (body.length > 50) body.length = 50;
    return [{ role: 'skReaper', slot: 'skValidate:' + v.room, body,
        memory: { role: 'skReaper', slotKey: 'skValidate:' + v.room, home: home.name, remoteRoom: v.room, validate: true },
        lead: body.length * 3 + 40, priority: 0, cls: 'conquest' }];
}

/** strongholdLoot 的孵化需求：拆墙队（只拆战利品格上的 rampart）+ 护卫 + 搬运兵。撤退态不出新兵。 */
function strongholdLootDemands(d, home, sponsors) {
    const cfg = settings();
    if (home.energyCapacityAvailable < cfg.minCapacity) return [];
    if (d.retreat) return [];   // 撤退：不再孵新兵
    const storeEnergy = (home.storage && home.storage.store) ? (home.storage.store.energy || 0) : 0;
    const floor = d.storageFloor != null ? Number(d.storageFloor) : cfg.storageFloor;
    if (floor && home.storage && storeEnergy < floor) return [];
    const demands = [];
    const nSponsors = sponsors.length || 1;
    const staging = d.staging || null;
    const totalDismantlers = Math.max(0, Number(d.dismantlers) || 0);
    const totalGuards = Math.max(0, Number(d.guards) || 0);
    const totalHaulers = Math.max(0, Number(d.haulers) || 0);
    const squad = Math.max(1, totalDismantlers + totalGuards);
    const lootTiles = Array.isArray(d.lootTiles) ? d.lootTiles : null;
    const phase = d.phase || 'breach';
    // 破防：拆墙队 + 护卫（同波集结）。lootTiles 带进 memory，角色据此只拆战利品格上的 rampart
    if (phase === 'breach') {
        const mem = attachAvoidance({ home: home.name, targetRoom: d.target, staging, squad, lootTiles, strongholdLoot: true }, d);
        const dPer = Math.ceil(totalDismantlers / nSponsors);
        const body = repeatBody(['work', 'move'], Math.min(home.energyCapacityAvailable, cfg.dismantlerBudget));
        for (let i = 0; i < dPer; i++) demands.push(demand('siegeDismantler', 'siegeLoot:' + d.target + ':' + home.name + ':' + i, body, mem, 80, i, d));
        const gPer = Math.ceil(totalGuards / nSponsors);
        if (gPer > 0) {
            const gbody = repeatBody(['ranged_attack', 'heal', 'move', 'move'], Math.min(home.energyCapacityAvailable, cfg.guardBudget));
            for (let i = 0; i < gPer; i++) demands.push(demand('siegeGuard', 'guardLoot:' + d.target + ':' + home.name + ':' + i, gbody, mem, 85, i, d));
        }
    }
    // 搬运兵：破防后（loot 阶段）从离目标最近的 sponsor 出，取货回 home storage
    if ((phase === 'loot' || phase === 'breach') && totalHaulers > 0) {
        const closest = sponsors.slice().sort((a, b) => roomDistance(a, d.target) - roomDistance(b, d.target))[0];
        if (home.name === closest) {
            const hbody = repeatBody(['carry', 'move'], Math.min(home.energyCapacityAvailable, cfg.lootBudget));
            const hmem = attachAvoidance({ home: home.name, targetRoom: d.target, lootTiles, staging }, d);
            for (let i = 0; i < totalHaulers; i++) demands.push(demand('lootHauler', 'loot:' + d.target + ':' + i, hbody, hmem, 90, i, d));
        }
    }
    return demands;
}

module.exports = { run, getDemands, directive, directives, settings, boostsFor, boostingEnabled, repeatBody, holdTile, laneTile, towerAvoidCallback, recordHostileTowers, knownHostileTowers, lootTilesOf, lootRampartTargets, lootContainersOf, squadBelowHalf, retreatFor, nonEnergyAmount, squadBoostReady, boostGateHold, militaryCompounds, skValidateDemands, skValidateOn, skValidateFuseTick };
