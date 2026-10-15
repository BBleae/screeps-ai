'use strict';
/** 保守后期服务：只在明确配置且储备充足时运行实验室/工厂/Power Spawn，绝不自动交易或发起攻击性行为。 */
const config = require('config');

const DEFAULTS = {
    storageReserve: 200000,
    terminalReserve: 50000,
    powerStorageReserve: 300000,
    statusKey: 'industryState',
};

function roomMem(room) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    return Memory.rooms[room.name];
}

function industryConfig() {
    return (config && config.industry) || {};
}

function reserve(name) {
    const cfg = industryConfig();
    if (typeof cfg[name] === 'number') return cfg[name];
    return DEFAULTS[name];
}

function used(store, resource) {
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') {
        const value = store.getUsedCapacity(resource);
        if (typeof value === 'number') return value;
    }
    return store[resource] || 0;
}

function free(store, resource) {
    if (!store || typeof store.getFreeCapacity !== 'function') return 0;
    const value = store.getFreeCapacity(resource);
    return typeof value === 'number' ? value : 0;
}

function countMy(room, type) {
    return room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === type }).length;
}

function myStructures(room, type) {
    return room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === type });
}

function getById(id) {
    if (!id || !Game.getObjectById) return null;
    return Game.getObjectById(id) || null;
}

function normalizeObserve(cfg) {
    if (!cfg) return null;
    if (typeof cfg === 'string') return [cfg];
    if (Array.isArray(cfg)) return cfg.filter((x) => typeof x === 'string' && x);
    if (typeof cfg.roomName === 'string') return [cfg.roomName];
    if (Array.isArray(cfg.rooms)) return cfg.rooms.filter((x) => typeof x === 'string' && x);
    return null;
}

function normalizeReaction(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    const inputs = Array.isArray(cfg.inputs) ? cfg.inputs : Array.isArray(cfg.sourceLabs) ? cfg.sourceLabs : null;
    const outputs = Array.isArray(cfg.outputs) ? cfg.outputs : Array.isArray(cfg.outputLabs) ? cfg.outputLabs : null;
    if (!inputs || inputs.length < 2 || !outputs || !outputs.length) return null;
    return {
        inputs: inputs.slice(0, 2),
        outputs: outputs.filter(Boolean),
    };
}

function normalizeProduct(cfg) {
    if (!cfg) return null;
    if (typeof cfg === 'string') return { resource: cfg };
    if (typeof cfg !== 'object') return null;
    if (typeof cfg.resource !== 'string' || !cfg.resource) return null;
    return {
        resource: cfg.resource,
        factoryId: cfg.factoryId || cfg.id || null,
    };
}

function storageEnergy(room) {
    return room.storage ? used(room.storage.store, RESOURCE_ENERGY) : 0;
}

function terminalEnergy(room) {
    return room.terminal ? used(room.terminal.store, RESOURCE_ENERGY) : 0;
}

function canSpend(room) {
    const storageOk = storageEnergy(room) >= reserve('storageReserve');
    const terminal = room.terminal;
    const terminalOk = !!terminal && terminalEnergy(room) >= reserve('terminalReserve');
    return storageOk && terminalOk;
}

/** labs 的闸（2026-10-15）：配置了 labRooms 时只在这些房跑、storage 能量 ≥ labStorageReserve、CPU 闸开着；
 *  没配 labRooms 时沿用旧的 canSpend（storage ≥ storageReserve 且 terminal ≥ terminalReserve） */
function labsAllowed(room) {
    const cfg = industryConfig();
    if (!Array.isArray(cfg.labRooms)) return canSpend(room);
    if (cfg.labRooms.indexOf(room.name) < 0) return false;
    if (storageEnergy(room) < Number(cfg.labStorageReserve || 0)) return false;
    try { const dep = require('deposit'); return dep.cpuOk(dep.settings()); } catch (e) { return true; }
}

function canProcessPower(room) {
    return canSpend(room) && storageEnergy(room) >= reserve('powerStorageReserve');
}

function runObserver(room, mem, state) {
    const observer = myStructures(room, STRUCTURE_OBSERVER)[0];
    const targets = normalizeObserve(mem.industry && (mem.industry.observe || mem.industry.observer));
    state.observer = {
        present: !!observer,
        configured: !!(targets && targets.length),
    };
    if (!observer || !targets || !targets.length || typeof observer.observeRoom !== 'function') return;
    const idx = (mem._industryObserveIdx || 0) % targets.length;
    const target = targets[idx];
    const ret = observer.observeRoom(target);
    state.observer.target = target;
    state.observer.result = ret;
    if (ret === OK) mem._industryObserveIdx = (idx + 1) % targets.length;
}

/** lab 里装着的那种矿物（Store 里唯一的非能量资源）；空的返回 null */
function labMineral(lab) {
    const store = lab && lab.store;
    if (!store) return null;
    for (const key of Object.keys(store)) {
        if (key === RESOURCE_ENERGY) continue;
        if (typeof store[key] === 'number' && store[key] > 0) return key;
    }
    return null;
}

function chebyshev(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 按几何关系推导 lab 分工：两个装着不同矿物的输入 lab + 一个与它们**都**在切比雪夫 2 以内的输出 lab
 *  （引擎 processor/intents/labs/run-reaction.js 的硬条件：|dx| > 2 || |dy| > 2 直接拒绝），
 *  且 REACTIONS 里这对矿物有产物。输出 lab 里若已装着别的矿物则不能收，跳过。
 *  没有这条推导时 runLabs 需要人手把三个 lab 的 id 填进 Memory —— 于是 labs 建好了也永远不反应。 */
function deriveReaction(labs) {
    if (typeof REACTIONS === 'undefined' || !REACTIONS) return null;
    const loaded = labs.filter((lab) => labMineral(lab));
    for (const a of loaded) {
        const typeA = labMineral(a);
        for (const b of loaded) {
            if (b === a) continue;
            const typeB = labMineral(b);
            if (!typeB || typeB === typeA) continue;
            const product = REACTIONS[typeA] && REACTIONS[typeA][typeB];
            if (!product) continue;
            for (const out of labs) {
                if (out === a || out === b) continue;
                if (chebyshev(out.pos, a.pos) > 2 || chebyshev(out.pos, b.pos) > 2) continue;
                const outType = labMineral(out);
                if (outType && outType !== product) continue;
                return { inputs: [a.id, b.id], outputs: [out.id], product };
            }
        }
    }
    return null;
}

// ---- 矿物链（移植 overmind-absorb 7f4ab27 / 2d97ab4，重建在当前 main 上）----
// 链条原本断在这一环：矿物（brain 的 mineral 计划挖进 terminal/storage、hauler 打捞进 terminal）躺在库里，
// industry 认得出 lab 分工，但没有任何角色往 lab 里装货——deriveReaction 要求矿物已经在 lab 里，于是 labs 永远不反应。
// 这里给出「哪个 lab 装什么、产物从哪收回」（labPlan），roles/labTech 照着搬；反应选择按目标 boost 化合物自底向上找
// 「现在就做得起的那一步」（Overmind 的 Abathur），做不了才退回库存里能配的一对。
const BASE_MINERALS = ['H', 'O', 'Z', 'K', 'U', 'L', 'X'];

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function labSettings() {
    const cfg = industryConfig();
    return {
        minBatch: Math.max(1, num(cfg.labMinBatch, 500)),
        fill: Math.max(1, num(cfg.labFill, 1000)),
        boostTargets: Array.isArray(cfg.boostTargets) ? cfg.boostTargets : [],
        boostGoal: Math.max(1, num(cfg.boostGoal, 3000)),
        boostStock: Math.max(1, num(cfg.labBoostStock, 1000)),
        opportunistic: cfg.labOpportunistic !== false,
    };
}

function addStock(out, store) {
    if (!store) return;
    for (const key of Object.keys(store)) {
        if (key === RESOURCE_ENERGY) continue;
        const amount = store[key];
        if (typeof amount === 'number' && amount > 0) out[key] = (out[key] || 0) + amount;
    }
}

/** 房里可用的矿物库存（己方 terminal + storage，不含能量） */
function mineralStock(room) {
    const out = {};
    for (const holder of [room.terminal, room.storage]) {
        if (holder && holder.my !== false) addStock(out, holder.store);
    }
    return out;
}

function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 几何上可用的 lab 三连：输出 lab 与两个输入都在切比雪夫 2 以内（引擎 run-reaction.js 的硬条件）；按 id 排序，选择稳定 */
function labTriple(labs) {
    const sorted = labs.slice().sort(byId);
    for (const out of sorted) {
        const near = sorted.filter((lab) => lab !== out && chebyshev(out.pos, lab.pos) <= 2);
        if (near.length >= 2) return { inputs: [near[0].id, near[1].id], outputs: [out.id] };
    }
    return null;
}

/** 产物 → [输入 A, 输入 B]；REACTIONS 是常量表，进程内算一次（认表本身：单测会换掉 global.REACTIONS） */
let reverseCache = null;
let reverseCacheFor = null;
function reverseReactions() {
    if (typeof REACTIONS === 'undefined' || !REACTIONS) return {};
    if (reverseCache && reverseCacheFor === REACTIONS) return reverseCache;
    const out = {};
    for (const a of Object.keys(REACTIONS)) {
        for (const b of Object.keys(REACTIONS[a] || {})) {
            const product = REACTIONS[a][b];
            if (!product || out[product]) continue;
            out[product] = a <= b ? [a, b] : [b, a];   // 定序，选择才稳定
        }
    }
    reverseCache = out;
    reverseCacheFor = REACTIONS;
    return out;
}

/**
 * 为了做出 target，现在这一步该反应什么：自顶向下拆，某个输入库存不够就先去做那个输入；
 * 拆到基础矿还不够就这一支做不了（那是矿脉/终端调剂的事）。返回 {a, b, product}，product 多半是链条上更靠下的中间体。
 */
function nextReactionFor(target, stock, minBatch, depth) {
    if (!target || (depth || 0) > 6) return null;
    const recipe = reverseReactions()[target];
    if (!recipe) return null;                              // 基础矿：没有反应能做出它
    const missing = recipe.filter((input) => num(stock[input], 0) < minBatch);
    if (!missing.length) return { a: recipe[0], b: recipe[1], product: target };
    for (const input of missing) {
        if (BASE_MINERALS.indexOf(input) >= 0) continue;   // 缺基础矿：只能靠矿脉/调剂
        const deeper = nextReactionFor(input, stock, minBatch, (depth || 0) + 1);
        if (deeper) return deeper;
    }
    return null;
}

/** product 是否在 targets 的反应链上（目标本身或其任一层输入） */
function inChain(product, targets) {
    const rev = reverseReactions();
    const seen = new Set();
    const stack = (targets || []).slice();
    while (stack.length) {
        const t = stack.pop();
        if (seen.has(t)) continue;
        seen.add(t);
        if (t === product) return true;
        for (const i of rev[t] || []) stack.push(i);
    }
    return false;
}

/** 还想做的目标化合物：config.industry.boostTargets 里库存不到 boostGoal 的第一个 */
function wantedTarget(stock, cfg) {
    const targets = Array.isArray(cfg.boostTargets) ? cfg.boostTargets : [];
    const goal = Math.max(1, num(cfg.boostGoal, 3000));
    for (const target of targets) {
        if (num(stock[target], 0) < goal) return target;
    }
    return null;
}

/** 机会主义配对：库存里两种各 ≥ minBatch、REACTIONS 有产物的一对（按名字排序，选择稳定） */
function pickPair(stock, minBatch) {
    if (typeof REACTIONS === 'undefined' || !REACTIONS) return null;
    const types = Object.keys(stock).filter((type) => stock[type] >= minBatch).sort();
    for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
            const product = REACTIONS[types[i]] && REACTIONS[types[i]][types[j]];
            if (product) return { a: types[i], b: types[j], product };
        }
    }
    return null;
}

function rolesValid(roles, labsById) {
    if (!roles || !Array.isArray(roles.inputs) || roles.inputs.length !== 2 || !Array.isArray(roles.outputs) || !roles.outputs.length) return false;
    const inputs = roles.inputs.map((id) => labsById[id]);
    if (inputs.some((lab) => !lab) || inputs[0] === inputs[1]) return false;
    return roles.outputs.every((id) => labsById[id] && roles.inputs.indexOf(id) < 0 &&
        inputs.every((input) => chebyshev(input.pos, labsById[id].pos) <= 2));
}

/** lab 分工（输入两个 + 输出 + 一个 boost lab），存进 Memory.rooms[房].labRoles 保持跨 tick 稳定：
 *  每 tick 重新推导时，装货中途（一个输入有货、另一个还空）会让 deriveReaction 换一组输出、取送计划来回翻。
 *  人手配置（Memory.rooms[房].industry.reaction）优先；否则先按 lab 里已有的矿物推导，再退回纯几何三连。 */
function labRoles(room, mem, labs) {
    const labsById = {};
    for (const lab of labs) labsById[lab.id] = lab;
    const configured = normalizeReaction(mem.industry && mem.industry.reaction);
    let roles = null;
    let fresh = false;
    if (configured && rolesValid(configured, labsById)) {
        roles = { inputs: configured.inputs, outputs: configured.outputs, configured: true };
    } else if (mem.labRoles && rolesValid(mem.labRoles, labsById)) {
        roles = mem.labRoles;
    } else {
        const derived = deriveReaction(labs);
        const picked = derived ? { inputs: derived.inputs, outputs: derived.outputs } : labTriple(labs);
        if (!picked) { delete mem.labRoles; return null; }
        roles = { inputs: picked.inputs, outputs: picked.outputs, at: Game.time };
        fresh = true;
    }
    // boost lab：三连之外的一个 lab（按 id 第一个）。src/boost.js 一类的强化逻辑找的是「装着这个化合物的 lab」，
    // 没有专门的 boost lab，做出来的化合物只会被收回 terminal
    const used = roles.inputs.concat(roles.outputs);
    if (!roles.boost || !labsById[roles.boost] || used.indexOf(roles.boost) >= 0) {
        const spare = labs.filter((lab) => used.indexOf(lab.id) < 0).sort(byId)[0];
        roles.boost = spare ? spare.id : null;
        fresh = true;
    }
    if (!roles.configured && fresh) mem.labRoles = roles;
    return roles;
}

/** 本房 labTech 手里正搬着的矿物也算库存：取货那一 tick terminal 少了、lab 还没到，不算会让反应选择来回翻 */
function carriedStock(room, out) {
    const kind = typeof FIND_MY_CREEPS !== 'undefined' ? FIND_MY_CREEPS : null;
    if (kind == null || typeof room.find !== 'function') return;
    for (const creep of room.find(kind) || []) {
        if (creep && creep.memory && creep.memory.role === 'labTech') addStock(out, creep.store);
    }
}

/** 这一批做什么：两个输入都装着能反应的矿物、输出 lab 收得下 ⇒ 接着做（不中途换）；否则按目标化合物的反应链选下一步，
 *  链上这一步做不了时退回机会主义配对。lab 里的货与搬运中的货都算库存。 */
function chooseReaction(room, mem, roles, labsById, cfg) {
    const inputs = roles.inputs.map((id) => labsById[id]);
    const output = labsById[roles.outputs[0]];
    const ta = labMineral(inputs[0]);
    const tb = labMineral(inputs[1]);
    const outType = labMineral(output);
    const saved = mem.labRoles && mem.labRoles.step;
    const stock = mineralStock(room);
    for (const lab of inputs) addStock(stock, lab.store);
    carriedStock(room, stock);
    if (ta && tb && ta !== tb && typeof REACTIONS !== 'undefined' && REACTIONS && REACTIONS[ta] && REACTIONS[ta][tb]) {
        const product = REACTIONS[ta][tb];
        if ((!outType || outType === product) && (cfg.opportunistic !== false || inChain(product, cfg.boostTargets))) {
            return { a: ta, b: tb, product, target: saved && saved.product === product ? saved.target || null : null, continued: true, stock };
        }
    }
    const boost = roles.boost && labsById[roles.boost];
    const targetStock = Object.assign({}, stock);
    if (boost) addStock(targetStock, boost.store);
    const target = wantedTarget(targetStock, cfg);
    let step = target ? nextReactionFor(target, stock, cfg.minBatch, 0) : null;
    let stepTarget = step ? target : null;
    if (!step && cfg.opportunistic !== false) step = pickPair(stock, cfg.minBatch);
    if (!step) return null;
    // 已经装着其中一种的输入 lab 就装那一种：换位置意味着先把它清空
    let a = step.a;
    let b = step.b;
    if (ta === b || tb === a) { a = step.b; b = step.a; }
    if (!roles.configured && mem.labRoles) mem.labRoles.step = { product: step.product, target: stepTarget, at: Game.time };
    return { a, b, product: step.product, target: stepTarget, continued: false, stock };
}

function storeOf(lab, type) {
    return lab && lab.store ? num(lab.store[type], 0) : 0;
}

/** labTech 的取送计划（每房每 tick 只算一次）：
 *  wants  [{labId, mineral, amount}]：从 terminal/storage 取货装进 lab
 *  drains [{labId, mineral, amount}]：从 lab 收回 terminal（产物攒够一批、输入装错了货、输出装着别的产物）
 *  industry 本身不动 creep，roles/labTech 与 spawn.labTechTarget 都读它。 */
const planCache = { time: -1, rooms: {} };
function labPlan(room) {
    if (!room) return null;
    if (planCache.time !== Game.time) { planCache.time = Game.time; planCache.rooms = {}; }
    if (Object.prototype.hasOwnProperty.call(planCache.rooms, room.name)) return planCache.rooms[room.name];
    const plan = computeLabPlan(room);
    planCache.rooms[room.name] = plan;
    return plan;
}

function computeLabPlan(room) {
    const labs = myStructures(room, STRUCTURE_LAB);
    if (labs.length < 3) return null;
    const mem = roomMem(room);
    const roles = labRoles(room, mem, labs);
    if (!roles) return null;
    const labsById = {};
    for (const lab of labs) labsById[lab.id] = lab;
    const cfg = labSettings();
    const reaction = chooseReaction(room, mem, roles, labsById, cfg);
    const wants = [];
    const drains = [];
    const need = {};
    if (reaction) {
        need[roles.inputs[0]] = reaction.a;
        need[roles.inputs[1]] = reaction.b;
    }
    for (const id of roles.inputs) {
        const lab = labsById[id];
        const held = labMineral(lab);
        const type = need[id];
        if (held && held !== type) { drains.push({ labId: id, mineral: held, amount: storeOf(lab, held) }); continue; }
        if (!type) continue;
        const have = storeOf(lab, type);
        const available = num(reaction.stock[type], 0) - have;
        // 降到 minBatch 以下才补、一次补到 fill：每次都补零头会让 labTech 为几十单位来回孵
        if (have < cfg.minBatch && available > 0) wants.push({ labId: id, mineral: type, amount: cfg.fill - have });
    }
    for (const id of roles.outputs) {
        const lab = labsById[id];
        const held = labMineral(lab);
        if (!held) continue;
        const amount = storeOf(lab, held);
        // 产物攒够一批收回（输出满了反应会停）；装着的不是这一批的产物：整个清掉，否则新反应永远开不了工
        if (amount >= cfg.minBatch || !reaction || held !== reaction.product) drains.push({ labId: id, mineral: held, amount });
    }
    const boostWant = boostLabJob(room, roles, labsById, cfg, reaction, wants, drains);
    return {
        product: reaction ? reaction.product : null,
        target: reaction ? reaction.target : null,
        continued: !!(reaction && reaction.continued),
        configured: !!roles.configured,
        inputs: roles.inputs.slice(),
        outputs: roles.outputs.slice(),
        output: roles.outputs[0],
        boost: roles.boost || null,
        boostLab: boostWant,
        need,
        wants,
        drains,
        drain: drains[0] || null,
    };
}

/** boost lab（移植 overmind-absorb 019c5b1）：产物做出来后被收回 terminal，而强化要的是「已经装着这个化合物的 lab」——
 *  没有任何代码往那种 lab 里装货，做出来的化合物只会躺在 terminal 里。目标化合物库存攒够 labBoostStock 就把一份装进
 *  三连之外的 boost lab（plan.wants 多一条，labTech 不用改）；装着别的东西（不在 boostTargets 里）先清掉；用掉一半再补。 */
function boostLabJob(room, roles, labsById, cfg, reaction, wants, drains) {
    const lab = roles.boost && labsById[roles.boost];
    if (!lab) return null;
    const stock = reaction ? reaction.stock : (() => { const out = mineralStock(room); carriedStock(room, out); return out; })();
    const held = labMineral(lab);
    if (held && cfg.boostTargets.indexOf(held) < 0) {
        drains.push({ labId: lab.id, mineral: held, amount: storeOf(lab, held) });
        return null;
    }
    let want = null;
    if (held) {
        const have = storeOf(lab, held);
        if (have < cfg.boostStock / 2 && num(stock[held], 0) > 0) want = { labId: lab.id, mineral: held, amount: cfg.boostStock - have, boost: true };
    } else {
        const compound = cfg.boostTargets.find((type) => num(stock[type], 0) >= cfg.boostStock);
        if (compound) want = { labId: lab.id, mineral: compound, amount: cfg.boostStock, boost: true };
    }
    if (want) wants.push(want);
    return want;
}

function runLabs(room, mem, state, spendAllowed) {
    const labs = myStructures(room, STRUCTURE_LAB);
    // 储备闸关着（线上大多数房 storage≈0）：反应不会跑、labTech 也不会孵，不为它算取送计划（每 5 tick × 每个有 lab 的房）
    // boost lab 的 id 照记（2026-10-13 复审）：task_broker.labEnergyWant 只认 industryState.labs.boostLab，它的补能闸（富余且 ≥ terminalFillStorageAbove）
    // 比储备闸松——storage 5–10 万时储备闸关着、补能闸开着，丢了 id 就没人给已装好化合物的 boost lab 补能量，boostCreep 半路断粮。
    // labRoles 只读/写 Memory 里的分工（分工有效时不扫库存、不选反应），比整份计划便宜得多
    if (!spendAllowed) {
        let boostLab = null;
        if (labs.length >= 3) {
            const roles = labRoles(room, roomMem(room), labs);
            boostLab = roles && roles.boost ? roles.boost : null;
        }
        state.labs = { present: labs.length, configured: false, derived: null, target: null, product: null, active: false, gated: true, boostLab };
        return;
    }
    const plan = labPlan(room);
    // 两个输入都装着这一批的料才算「配置好了」；装货中途、或输入装错了货都不发 runReaction
    const ready = !!plan && !!plan.product && plan.inputs.every((id) => {
        const lab = getById(id);
        return lab && labMineral(lab) === plan.need[id];
    });
    state.labs = {
        present: labs.length,
        configured: ready,
        derived: plan && plan.continued && !plan.configured ? { product: plan.product, output: plan.output } : null,
        // 这一步是在为哪个目标化合物服务（反应链）；机会主义配对没有 target
        target: plan ? plan.target : null,
        product: plan ? plan.product : null,
        wants: plan ? plan.wants.length : 0,
        drains: plan ? plan.drains.length : 0,
        // boost lab 的 id：task_broker 只给它补能量（boostCreep 每部件 20 能量，反应本身不耗能）
        boostLab: plan ? plan.boost : null,
        active: false,
    };
    if (!ready) return;
    const inputA = getById(plan.inputs[0]);
    const inputB = getById(plan.inputs[1]);
    if (!inputA || !inputB || inputA.room !== room || inputB.room !== room) {
        state.labs.error = 'missing-input';
        return;
    }
    for (const id of plan.outputs) {
        const output = getById(id);
        if (!output || output.room !== room || typeof output.runReaction !== 'function') continue;
        if (output.cooldown > 0) continue;
        const held = labMineral(output);
        if (held && held !== plan.product) continue;
        const ret = output.runReaction(inputA, inputB);
        state.labs.active = true;
        state.labs.lastOutput = output.id;
        state.labs.result = ret;
        if (ret === OK) return;
    }
}

function runFactory(room, mem, state, spendAllowed) {
    const factories = myStructures(room, STRUCTURE_FACTORY);
    const product = normalizeProduct(mem.industry && mem.industry.product);
    state.factory = {
        present: factories.length,
        configured: !!product,
        active: false,
    };
    if (!spendAllowed || !product || !factories.length) return;
    const factory = (product.factoryId && getById(product.factoryId)) || factories[0];
    if (!factory || factory.room !== room || typeof factory.produce !== 'function') {
        state.factory.error = 'missing-factory';
        return;
    }
    if (factory.cooldown > 0) {
        state.factory.cooldown = factory.cooldown;
        return;
    }
    const ret = factory.produce(product.resource);
    state.factory.active = true;
    state.factory.resource = product.resource;
    state.factory.result = ret;
}

function runPowerSpawn(room, state, spendAllowed) {
    const powerSpawn = myStructures(room, STRUCTURE_POWER_SPAWN)[0];
    const powerKey = typeof RESOURCE_POWER === 'string' ? RESOURCE_POWER : 'power';
    state.powerSpawn = {
        present: !!powerSpawn,
        active: false,
    };
    if (!spendAllowed || !powerSpawn || typeof powerSpawn.processPower !== 'function') return;
    const energy = used(powerSpawn.store, RESOURCE_ENERGY);
    const power = used(powerSpawn.store, powerKey);
    state.powerSpawn.energy = energy;
    state.powerSpawn.power = power;
    if (energy < 50 || power < 1) return;
    const ret = powerSpawn.processPower();
    state.powerSpawn.active = true;
    state.powerSpawn.result = ret;
}

function sample(room, mem) {
    const extractor = myStructures(room, STRUCTURE_EXTRACTOR)[0];
    const mineral = room.find(FIND_MINERALS)[0] || null;
    const nuker = myStructures(room, STRUCTURE_NUKER)[0];
    const powerKey = typeof RESOURCE_POWER === 'string' ? RESOURCE_POWER : 'power';
    const ghodiumKey = typeof RESOURCE_GHODIUM === 'string' ? RESOURCE_GHODIUM : 'ghodium';
    return {
        at: Game.time,
        rcl: room.controller ? room.controller.level : 0,
        storageEnergy: storageEnergy(room),
        terminalEnergy: terminalEnergy(room),
        storageReserve: reserve('storageReserve'),
        terminalReserve: reserve('terminalReserve'),
        powerStorageReserve: reserve('powerStorageReserve'),
        spendingUnlocked: canSpend(room),
        terminal: room.terminal ? {
            cooldown: room.terminal.cooldown || 0,
            energy: used(room.terminal.store, RESOURCE_ENERGY),
            free: free(room.terminal.store),
        } : null,
        extractor: extractor ? {
            cooldown: extractor.cooldown || 0,
            mineralType: mineral && mineral.mineralType,
            mineralAmount: mineral && mineral.mineralAmount,
        } : null,
        labs: { present: countMy(room, STRUCTURE_LAB) },
        factory: { present: countMy(room, STRUCTURE_FACTORY) },
        observer: { present: countMy(room, STRUCTURE_OBSERVER) },
        powerSpawn: {
            present: countMy(room, STRUCTURE_POWER_SPAWN),
            energy: powerSpawnEnergy(room),
            power: powerSpawnPower(room, powerKey),
        },
        nuker: nuker ? {
            cooldown: nuker.cooldown || 0,
            energy: used(nuker.store, RESOURCE_ENERGY),
            ghodium: used(nuker.store, ghodiumKey),
        } : null,
    };
}

function powerSpawnEnergy(room) {
    const powerSpawn = myStructures(room, STRUCTURE_POWER_SPAWN)[0];
    return powerSpawn ? used(powerSpawn.store, RESOURCE_ENERGY) : 0;
}

function powerSpawnPower(room, powerKey) {
    const powerSpawn = myStructures(room, STRUCTURE_POWER_SPAWN)[0];
    return powerSpawn ? used(powerSpawn.store, powerKey) : 0;
}

function run(room) {
    try {
        if (!room || !room.controller || !room.controller.my || room.controller.level < 6) return;
        const mem = roomMem(room);
        const state = sample(room, mem);
        const spendAllowed = state.spendingUnlocked;
        runObserver(room, mem, state);
        state.labsAllowed = labsAllowed(room);
        runLabs(room, mem, state, state.labsAllowed);
        runFactory(room, mem, state, spendAllowed);
        runPowerSpawn(room, state, canProcessPower(room));
        mem[DEFAULTS.statusKey] = state;
    } catch (e) {
        const mem = room && room.name ? roomMem(room) : null;
        if (mem) {
            mem[DEFAULTS.statusKey] = {
                at: Game.time,
                error: (e && e.message) || String(e),
            };
        }
    }
}

module.exports = { run, deriveReaction, canSpend, labsAllowed, labPlan, labRoles, mineralStock, pickPair, nextReactionFor, wantedTarget, reverseReactions, labTriple, BASE_MINERALS };
