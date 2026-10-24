'use strict';
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

function labsAllowed(room) {
    const cfg = industryConfig();
    if (!Array.isArray(cfg.labRooms)) return canSpend(room);
    const boostOnly = boostOnlyRoom(room);
    if (cfg.labRooms.indexOf(room.name) < 0 && !boostOnly) return false;
    if (storageEnergy(room) < Number(cfg.labStorageReserve || 0)) return false;
    if (boostOnly) return true;
    const bypass = Number(cfg.labCpuBucketBypass) || 0;
    if (bypass > 0 && Game.cpu && Game.cpu.bucket >= bypass) return true;
    try { if (bypass > 0 && require('cpu_gate').refilling()) return true; } catch (e) { return true; }
    try { const dep = require('deposit'); const ds = dep.settings(); return dep.statsCpuOk(Number(cfg.labCpuAvgMax) || 145, ds.cpuSamples, ds.minBucket); } catch (e) { return true; }
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

const BASE_MINERALS = ['H', 'O', 'Z', 'K', 'U', 'L', 'X'];

function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function labSettings(room) {
    const cfg = industryConfig();
    const boostTargets = Array.isArray(cfg.boostTargets) ? cfg.boostTargets : [];
    const byRoom = cfg.chainTargetsByRoom || {};
    const own = room && Array.isArray(byRoom[room.name]) ? byRoom[room.name] : null;
    return {
        chainTargets: own || boostTargets,
        minBatch: Math.max(1, num(cfg.labMinBatch, 500)),
        fill: Math.max(1, num(cfg.labFill, 1000)),
        boostTargets: Array.isArray(cfg.boostTargets) ? cfg.boostTargets : [],
        boostLabTargets: room && cfg.boostCompoundsByRoom && Array.isArray(cfg.boostCompoundsByRoom[room.name]) ? cfg.boostCompoundsByRoom[room.name] : boostTargets,
        boostMinLoad: Math.max(1, num(room && cfg.boostMinLoadByRoom && cfg.boostMinLoadByRoom[room.name], num(cfg.labBoostStock, 1000))),
        boostGoal: Math.max(1, num(room && cfg.boostGoalByRoom && cfg.boostGoalByRoom[room.name], num(cfg.boostGoal, 3000))),
        outputKeep: Math.max(0, num(room && makeIn(room) && makeIn(room).keepOutput, 0)),
        boostStock: Math.max(1, num(room && cfg.labBoostStockByRoom && cfg.labBoostStockByRoom[room.name], num(cfg.labBoostStock, 1000))),
        opportunistic: cfg.labOpportunistic !== false,
        noMake: room && cfg.labNoMakeByRoom && Array.isArray(cfg.labNoMakeByRoom[room.name]) ? cfg.labNoMakeByRoom[room.name] : [],
        switchBatch: Math.max(0, num(cfg.labSwitchBatch, 0)),
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

function labTriple(labs) {
    const sorted = labs.slice().sort(byId);
    for (const out of sorted) {
        const near = sorted.filter((lab) => lab !== out && chebyshev(out.pos, lab.pos) <= 2);
        if (near.length >= 2) return { inputs: [near[0].id, near[1].id], outputs: [out.id] };
    }
    return null;
}

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
            out[product] = a <= b ? [a, b] : [b, a];
        }
    }
    reverseCache = out;
    reverseCacheFor = REACTIONS;
    return out;
}

function nextReactionFor(target, stock, minBatch, depth, held) {
    if (!target || (depth || 0) > 6) return null;
    const recipe = reverseReactions()[target];
    if (!recipe) return null;
    const missing = recipe.filter((input) => num(stock[input], 0) < minBatch);
    if (!missing.length) return held && held.has(target) ? null : { a: recipe[0], b: recipe[1], product: target };
    for (const input of missing) {
        if (BASE_MINERALS.indexOf(input) >= 0) continue;
        const deeper = nextReactionFor(input, stock, minBatch, (depth || 0) + 1, held);
        if (deeper) return deeper;
    }
    return null;
}

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

function wantedTarget(stock, cfg) {
    const targets = Array.isArray(cfg.chainTargets) ? cfg.chainTargets : Array.isArray(cfg.boostTargets) ? cfg.boostTargets : [];
    const goal = Math.max(1, num(cfg.boostGoal, 3000));
    for (const target of targets) {
        if (num(stock[target], 0) < goal) return target;
    }
    return null;
}

function stockGoals(room) {
    const all = industryConfig().labStockGoal;
    return room && all && all[room.name] && typeof all[room.name] === 'object' ? all[room.name] : {};
}

function goalReady(g, recipe, stock, need) {
    const keep = (g && g.keep) || {};
    return !!recipe && recipe.every((r) => num(stock[r], 0) >= num(keep[r], 0) + need);
}

function heldProducts(room, mem) {
    const holds = industryConfig().productHold || {};
    const goals = stockGoals(room);
    const out = new Set();
    for (const product of Object.keys(goals)) {
        const st = mineralStock(room);
        if (num(st[product], 0) >= num(goals[product].to, 0)) out.add(product);
    }
    for (const product of Object.keys(holds)) {
        if (goals[product]) continue;
        const amount = room.terminal ? num(room.terminal.store[product], 0) : 0;
        if (amount >= num(holds[product].on, Infinity)) (mem.productHold || (mem.productHold = {}))[product] = Game.time;
        else if (mem.productHold && amount < num(holds[product].off, 0)) delete mem.productHold[product];
        if (mem.productHold && mem.productHold[product]) out.add(product);
    }
    for (const product of Object.keys(industryConfig().productRate || {})) if (rateHeld(product)) out.add(product);
    return out;
}

function rateWindow(product, open) {
    const r = (industryConfig().productRate || {})[product];
    if (!r || !(num(r.amount, 0) >= 0) || !(num(r.ticks, 0) > 0) || typeof Memory === 'undefined') return null;
    const all = Memory.labRate && typeof Memory.labRate === 'object' ? Memory.labRate : (open ? (Memory.labRate = {}) : null);
    if (!all) return null;
    let w = all[product];
    if (!w || typeof w !== 'object' || !(Game.time - num(w.start, 0) < num(r.ticks, 0))) {
        if (!open) return null;
        w = all[product] = { start: Game.time, made: 0 };
    }
    return { w, cap: num(r.amount, 0) };
}

function rateHeld(product) {
    const x = rateWindow(product, false);
    return !!x && num(x.w.made, 0) >= x.cap;
}

function pickPair(stock, minBatch, held) {
    if (typeof REACTIONS === 'undefined' || !REACTIONS) return null;
    const types = Object.keys(stock).filter((type) => stock[type] >= minBatch).sort();
    for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
            const product = REACTIONS[types[i]] && REACTIONS[types[i]][types[j]];
            if (product && !(held && held.has(product))) return { a: types[i], b: types[j], product };
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

function makeIn(room) {
    const by = industryConfig().boostRoomMake;
    return room && by && by[room.name] ? by[room.name] : null;
}

function boostOnlyRoom(room) {
    const list = industryConfig().boostOnlyRooms;
    return !!room && Array.isArray(list) && list.indexOf(room.name) >= 0;
}

function fullOutputRoom(room) {
    const list = industryConfig().labFullOutputs;
    return Array.isArray(list) && list.indexOf(room.name) >= 0;
}

function bestLayout(labs, current, noSpare) {
    const sorted = labs.slice().sort(byId);
    const curIn = current && Array.isArray(current.inputs) ? current.inputs : [];
    const curOut = current && Array.isArray(current.outputs) ? current.outputs : [];
    let best = null;
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            let outs = sorted.filter((lab) => lab !== a && lab !== b && chebyshev(lab.pos, a.pos) <= 2 && chebyshev(lab.pos, b.pos) <= 2);
            if (!outs.length) continue;
            if (!noSpare && outs.length + 2 === sorted.length && sorted.length >= 4) {
                const keep = outs.filter((lab) => curOut.indexOf(lab.id) >= 0);
                const drop = outs.filter((lab) => curOut.indexOf(lab.id) < 0);
                outs = keep.concat(drop).slice(0, outs.length - 1);
            }
            const keepIn = (curIn.indexOf(a.id) >= 0 ? 1 : 0) + (curIn.indexOf(b.id) >= 0 ? 1 : 0);
            const keepOut = outs.filter((lab) => curOut.indexOf(lab.id) >= 0).length;
            const score = [outs.length, keepIn, keepOut];
            const better = !best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])));
            if (better) best = { inputs: [a.id, b.id], outputs: outs.map((lab) => lab.id), score };
        }
    }
    return best;
}

function widenRoles(room, roles, labs, labsById) {
    if (roles.configured || !fullOutputRoom(room)) return false;
    if (roles.full === labs.length) return false;
    roles.full = labs.length;
    const keepBoost = !!(makeIn(room) && roles.boost && labsById[roles.boost]);
    const best = bestLayout(keepBoost ? labs.filter((lab) => lab.id !== roles.boost) : labs, roles, keepBoost);
    if (!best || best.outputs.length <= roles.outputs.length) return true;
    const sameInputs = best.inputs.every((id) => roles.inputs.indexOf(id) >= 0);
    roles.inputs = sameInputs ? roles.inputs.slice() : best.inputs;
    roles.outputs = best.outputs;
    roles.at = Game.time;
    roles.widened = Game.time;
    if (roles.boost && (roles.inputs.indexOf(roles.boost) >= 0 || roles.outputs.indexOf(roles.boost) >= 0)) delete roles.boost;
    return true;
}

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
    if (widenRoles(room, roles, labs, labsById)) fresh = true;
    const used = roles.inputs.concat(roles.outputs);
    if (!roles.boost || !labsById[roles.boost] || used.indexOf(roles.boost) >= 0) {
        const spare = labs.filter((lab) => used.indexOf(lab.id) < 0).sort(byId)[0];
        roles.boost = spare ? spare.id : null;
        fresh = true;
    }
    if (!roles.configured && fresh) mem.labRoles = roles;
    return roles;
}

function carriedStock(room, out) {
    const kind = typeof FIND_MY_CREEPS !== 'undefined' ? FIND_MY_CREEPS : null;
    if (kind == null || typeof room.find !== 'function') return;
    for (const creep of room.find(kind) || []) {
        if (creep && creep.memory && creep.memory.role === 'labTech') addStock(out, creep.store);
    }
}

function chooseReaction(room, mem, roles, labsById, cfg) {
    const holds = heldProducts(room, mem);
    const held = new Set(holds);
    for (const product of cfg.noMake || []) held.add(product);
    const picked = pickReaction(room, mem, roles, labsById, cfg, held);
    if (picked || !holds.size) {
        delete mem.labIdleSince;
        delete mem.labFallback;
        if (picked) delete mem.labIdleReason;
        else mem.labIdleReason = { at: Game.time, reason: 'noStep' };
        return picked;
    }
    if (!mem.labIdleSince) mem.labIdleSince = Game.time;
    if (Game.time - mem.labIdleSince < num(industryConfig().labIdleFallback, 500)) {
        mem.labIdleReason = { at: Game.time, reason: 'waitFallback', held: Array.from(held) };
        return null;
    }
    const fallback = fallbackReaction(room, mem, roles, labsById, cfg, held);
    if (fallback) {
        mem.labFallbackAt = Game.time;
        delete mem.labIdleReason;
    } else {
        delete mem.labFallback;
        mem.labIdleReason = { at: Game.time, reason: 'noFeasible', held: Array.from(held) };
    }
    return fallback;
}

function fallbackReaction(room, mem, roles, labsById, cfg, held) {
    if (typeof REACTIONS === 'undefined' || !REACTIONS) return null;
    const stock = mineralStock(room);
    for (const id of roles.inputs) if (labsById[id]) addStock(stock, labsById[id].store);
    carriedStock(room, stock);
    const reactAmount = typeof LAB_REACTION_AMOUNT !== 'undefined' ? LAB_REACTION_AMOUNT : 5;
    const sticky = mem.labFallback;
    if (sticky && !held.has(sticky.product) && num(stock[sticky.a], 0) >= reactAmount && num(stock[sticky.b], 0) >= reactAmount &&
        REACTIONS[sticky.a] && REACTIONS[sticky.a][sticky.b] === sticky.product && !(stockGoals(room)[sticky.product] && !goalReady(stockGoals(room)[sticky.product], [sticky.a, sticky.b], stock, reactAmount))) {
        return orient(roles, labsById, { a: sticky.a, b: sticky.b, product: sticky.product, target: null, continued: true, stock, fallback: true });
    }
    const types = Object.keys(stock).filter((t) => num(stock[t], 0) >= cfg.minBatch).sort();
    let best = null;
    for (let i = 0; i < types.length; i++) {
        for (let j = i + 1; j < types.length; j++) {
            const product = REACTIONS[types[i]] && REACTIONS[types[i]][types[j]];
            if (!product || held.has(product)) continue;
            if (stockGoals(room)[product] && !goalReady(stockGoals(room)[product], [types[i], types[j]], stock, cfg.minBatch)) continue;
            const chain = inChain(product, cfg.chainTargets || cfg.boostTargets) ? 0 : 1;
            if (chain && (cfg.noMake || []).length) continue;
            const have = num(stock[product], 0);
            if (!best || chain < best.chain || (chain === best.chain && have < best.have)) best = { a: types[i], b: types[j], product, chain, have };
        }
    }
    if (!best) return null;
    mem.labFallback = { a: best.a, b: best.b, product: best.product, at: Game.time };
    return orient(roles, labsById, { a: best.a, b: best.b, product: best.product, target: null, continued: false, stock, fallback: true });
}

function orient(roles, labsById, pick) {
    const ta = labMineral(labsById[roles.inputs[0]]);
    const tb = labMineral(labsById[roles.inputs[1]]);
    if (ta === pick.b || tb === pick.a) return Object.assign({}, pick, { a: pick.b, b: pick.a });
    return pick;
}

function chainStep(stock, roles, labsById, cfg, held) {
    const ts = Object.assign({}, stock);
    const boost = roles.boost && labsById[roles.boost];
    if (boost) addStock(ts, boost.store);
    const goal = Math.max(1, num(cfg.boostGoal, 3000));
    for (const t of (Array.isArray(cfg.chainTargets) ? cfg.chainTargets : [])) {
        if (num(ts[t], 0) >= goal) continue;
        const s2 = nextReactionFor(t, stock, cfg.minBatch, 0, held);
        if (s2) return s2;
    }
    return null;
}

function pickReaction(room, mem, roles, labsById, cfg, held, forced, skipGoal) {
    const inputs = roles.inputs.map((id) => labsById[id]);
    const ta = labMineral(inputs[0]);
    const tb = labMineral(inputs[1]);
    const outTypes = roles.outputs.map((id) => labMineral(labsById[id])).filter(Boolean);
    const saved = mem.labRoles && mem.labRoles.step;
    const stock = mineralStock(room);
    for (const lab of inputs) addStock(stock, lab.store);
    carriedStock(room, stock);
    const reactAmount = typeof LAB_REACTION_AMOUNT !== 'undefined' ? LAB_REACTION_AMOUNT : 5;
    if (ta && tb && ta !== tb && num(stock[ta], 0) >= reactAmount && num(stock[tb], 0) >= reactAmount &&
        typeof REACTIONS !== 'undefined' && REACTIONS && REACTIONS[ta] && REACTIONS[ta][tb]) {
        const product = REACTIONS[ta][tb];
        if (!held.has(product) && outTypes.every((t) => t === product) && (cfg.opportunistic !== false || inChain(product, cfg.chainTargets || cfg.boostTargets))) {
            const cont = { a: ta, b: tb, product, target: saved && saved.product === product ? saved.target || null : null, continued: true, stock };
            const tail = num(stock[ta], 0) < cfg.minBatch || num(stock[tb], 0) < cfg.minBatch;
            if (forced) return cont;
            const gl = stockGoals(room)[product];
            if (gl && (!goalReady(gl, [ta, tb], stock, reactAmount) || ((cs) => cs && cs.product !== product)(chainStep(stock, roles, labsById, cfg, held)))) return pickReaction(room, mem, roles, labsById, cfg, new Set(held).add(product), forced, product);
            const boostLab = roles.boost && labsById[roles.boost];
            const ts = Object.assign({}, stock);
            if (boostLab) addStock(ts, boostLab.store);
            const goal = wantedTarget(ts, cfg);
            const down = goal && cfg.switchBatch > 0 ? nextReactionFor(goal, stock, cfg.switchBatch, 0, held) : null;
            const goDown = !!down && down.product !== product && inChain(product, [down.product]);
            if (goDown) mem.labSwitch = { at: Game.time, from: product, to: down.product };
            if (!tail && !goDown) return cont;
            const next = goal ? nextReactionFor(goal, stock, cfg.minBatch, 0, held) : null;
            if (!goDown && (!next || next.product === product)) return cont;
        }
    }
    const boost = roles.boost && labsById[roles.boost];
    const targetStock = Object.assign({}, stock);
    if (boost) addStock(targetStock, boost.store);
    let target = forced || wantedTarget(targetStock, cfg);
    let step = target ? nextReactionFor(target, stock, cfg.minBatch, 0, held) : null;
    if (!step && !forced) {
        const goal = Math.max(1, num(cfg.boostGoal, 3000));
        for (const t of (Array.isArray(cfg.chainTargets) ? cfg.chainTargets : [])) {
            if (t === target || num(targetStock[t], 0) >= goal) continue;
            const s2 = nextReactionFor(t, stock, cfg.minBatch, 0, held);
            if (s2) { step = s2; target = t; break; }
        }
    }
    let stepTarget = step ? target : null;
    if (!step && !forced) {
        const goals = stockGoals(room);
        const rev = reverseReactions();
        for (const p of Object.keys(goals)) {
            if (p === skipGoal || held.has(p) || num(stock[p], 0) >= num(goals[p].to, 0) || !goalReady(goals[p], rev[p], stock, cfg.minBatch)) continue;
            step = { a: rev[p][0], b: rev[p][1], product: p };
            break;
        }
    }
    if (!step && cfg.opportunistic !== false) step = pickPair(stock, cfg.minBatch, held);
    if (!step) return null;
    let a = step.a;
    let b = step.b;
    if (ta === b || tb === a) { a = step.b; b = step.a; }
    if (!roles.configured && mem.labRoles) mem.labRoles.step = { product: step.product, target: stepTarget, at: Game.time };
    return { a, b, product: step.product, target: stepTarget, continued: false, stock };
}

function storeOf(lab, type) {
    return lab && lab.store ? num(lab.store[type], 0) : 0;
}

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
    let roles = labRoles(room, mem, labs);
    if (!roles) return null;
    const labsById = {};
    for (const lab of labs) labsById[lab.id] = lab;
    if (boostOnlyRoom(room) && !roles.boost) {
        const used0 = roles.inputs.concat(roles.outputs);
        const spare0 = Object.keys(labsById).filter((id) => used0.indexOf(id) < 0)[0];
        if (spare0) roles.boost = spare0;
        else if (roles.outputs.length) {
            roles.boost = roles.outputs.pop();
            roomMem(room).labRoles = roles;
        }
    }
    const cfg = labSettings(room);
    let warBoost = false;
    try { warBoost = require('war').labActive(room); } catch (e) { warBoost = false; }
    if (warBoost && roles.outputs && roles.outputs.length) {
        roles = Object.assign({}, roles, { outputs: [], configured: false });
    }
    const reaction = (boostOnlyRoom(room) && !makeIn(room)) || warBoost ? null : chooseReaction(room, mem, roles, labsById, cfg);
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
        if (have < cfg.minBatch && available > 0) wants.push({ labId: id, mineral: type, amount: cfg.fill - have });
    }
    for (const id of roles.outputs) {
        const lab = labsById[id];
        const held = labMineral(lab);
        if (!held) continue;
        const amount = storeOf(lab, held);
        const keep = cfg.outputKeep > 0 && (!reaction || held === reaction.product) && inChain(held, cfg.chainTargets) ? cfg.outputKeep : 0;
        if (keep > 0) { if (amount >= keep + cfg.minBatch) drains.push({ labId: id, mineral: held, amount: amount - keep, partial: true }); continue; }
        if (amount >= cfg.minBatch || !reaction || held !== reaction.product) drains.push({ labId: id, mineral: held, amount });
    }
    const boostWant = boostLabJob(room, roles, labsById, cfg, reaction, wants, drains);
    const militaryLabs = militaryBoostStaging(room, roles, labsById, cfg, wants, drains);
    const roleIds = roles.inputs.concat(roles.outputs, roles.boost ? [roles.boost] : [], militaryLabs ? Object.values(militaryLabs) : []);
    for (const id of Object.keys(labsById).sort()) {
        if (roleIds.indexOf(id) >= 0) continue;
        const held = labMineral(labsById[id]);
        if (held) drains.push({ labId: id, mineral: held, amount: storeOf(labsById[id], held) });
    }
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
        militaryLabs,
    };
}
function militaryBoostStaging(room, roles, labsById, cfg, wants, drains) {
    let compounds = [];
    try { compounds = require('conquest').militaryCompounds(); } catch (e) { compounds = []; }
    if (!compounds.length) return null;
    const used = roles.inputs.concat(roles.outputs, roles.boost ? [roles.boost] : []);
    const spare = Object.keys(labsById).filter((id) => used.indexOf(id) < 0);
    const stock = (() => { const out = mineralStock(room); carriedStock(room, out); return out; })();
    const map = {};
    const mem = roomMem(room);
    const prev = (mem.militaryLabs && typeof mem.militaryLabs === 'object') ? mem.militaryLabs : {};
    const assigned = new Set();
    for (const compound of compounds) {
        let labId = prev[compound] && labsById[prev[compound]] && spare.indexOf(prev[compound]) >= 0 && !assigned.has(prev[compound]) ? prev[compound] : null;
        if (!labId) { labId = spare.find((id) => !assigned.has(id)); }
        if (!labId) continue;
        assigned.add(labId);
        map[compound] = labId;
        const lab = labsById[labId];
        const held = labMineral(lab);
        if (held && held !== compound) { drains.push({ labId, mineral: held, amount: storeOf(lab, held) }); continue; }
        const have = storeOf(lab, compound);
        if (have < cfg.boostStock && num(stock[compound], 0) > 0) wants.push({ labId, mineral: compound, amount: cfg.boostStock - have, boost: true });
    }
    mem.militaryLabs = map;
    return map;
}

function boostLabJob(room, roles, labsById, cfg, reaction, wants, drains) {
    const lab = roles.boost && labsById[roles.boost];
    if (!lab) return null;
    const stock = reaction ? reaction.stock : (() => { const out = mineralStock(room); carriedStock(room, out); return out; })();
    const held = labMineral(lab);
    const targets = cfg.boostLabTargets || cfg.boostTargets;
    if (held && targets.indexOf(held) < 0) {
        drains.push({ labId: lab.id, mineral: held, amount: storeOf(lab, held) });
        return null;
    }
    let want = null;
    if (held) {
        const have = storeOf(lab, held);
        const minLoad = Math.min(cfg.boostStock, cfg.boostMinLoad);
        const better = targets.slice(0, targets.indexOf(held)).find((type) => num(stock[type], 0) >= minLoad);
        const spent = have < minLoad && have + num(stock[held], 0) < minLoad && targets.some((type) => type !== held && num(stock[type], 0) >= minLoad);
        if ((better && !boostWaiting(room)) || spent) {
            drains.push({ labId: lab.id, mineral: held, amount: have });
            roomMem(room).boostSwitch = { at: Game.time, from: held, to: better || targets.find((type) => type !== held && num(stock[type], 0) >= minLoad), left: have };
            return null;
        }
        let siege = [];
        try { siege = boostOnlyRoom(room) ? require('conquest').siegeCompounds() : []; } catch (e) { siege = []; }
        const refillBelow = siege.indexOf(held) >= 0 ? cfg.boostStock : cfg.boostStock / 2;
        if (have < refillBelow && num(stock[held], 0) > 0) want = { labId: lab.id, mineral: held, amount: cfg.boostStock - have, boost: true };
    } else {
        const compound = targets.find((type) => num(stock[type], 0) >= Math.min(cfg.boostStock, cfg.boostMinLoad));
        if (compound) want = { labId: lab.id, mineral: compound, amount: Math.min(cfg.boostStock, num(stock[compound], 0)), boost: true };
    }
    if (want) wants.push(want);
    return want;
}

function boostWaiting(room) {
    const kind = typeof FIND_MY_CREEPS !== 'undefined' ? FIND_MY_CREEPS : null;
    if (kind == null || typeof room.find !== 'function') return false;
    return (room.find(kind) || []).some((creep) => {
        const m = creep && creep.memory;
        return !!m && Array.isArray(m.boosts) && m.boosts.length > 0 && !m.boostDone && m.boostSince != null;
    });
}

function runLabs(room, mem, state, spendAllowed) {
    const labs = myStructures(room, STRUCTURE_LAB);
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
    const ready = !!plan && !!plan.product && plan.inputs.every((id) => {
        const lab = getById(id);
        return lab && labMineral(lab) === plan.need[id];
    });
    state.labs = {
        present: labs.length,
        configured: ready,
        derived: plan && plan.continued && !plan.configured ? { product: plan.product, output: plan.output } : null,
        target: plan ? plan.target : null,
        product: plan ? plan.product : null,
        wants: plan ? plan.wants.length : 0,
        drains: plan ? plan.drains.length : 0,
        boostLab: plan ? plan.boost : null,
        boostOut: plan && makeIn(room) ? plan.outputs.slice() : null,
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
        if (output.cooldown > 0) { state.labs.cooling = (state.labs.cooling || 0) + 1; state.labs.active = true; continue; }
        const held = labMineral(output);
        if (held && held !== plan.product) continue;
        const ret = output.runReaction(inputA, inputB);
        state.labs.active = true;
        state.labs.lastOutput = output.id;
        state.labs.result = ret;
        if (ret === OK) {
            state.labs.ran = (state.labs.ran || 0) + 1;
            noteLabUse(room.name, plan.need[plan.inputs[0]], plan.need[plan.inputs[1]], plan.product);
        }
    }
}

function labDay() {
    return Math.floor(Date.now() / 86400000);
}

function noteLabUse(roomName, a, b, product) {
    const amount = typeof LAB_REACTION_AMOUNT !== 'undefined' ? LAB_REACTION_AMOUNT : 5;
    const day = labDay();
    let use = Memory.labUse;
    if (!use || typeof use !== 'object') use = Memory.labUse = { day, used: {}, made: {}, first: {} };
    if (use.day !== day) {
        use.prev = { day: use.day, used: use.used || {}, made: use.made || {} };
        use.day = day;
        use.used = {};
        use.made = {};
    }
    const used = use.used || (use.used = {});
    for (const type of [a, b]) if (type) used[type] = (used[type] || 0) + amount;
    const made = use.made || (use.made = {});
    const mine = made[roomName] || (made[roomName] = {});
    if (product) mine[product] = (mine[product] || 0) + amount;
    if (product) { const total = use.total || (use.total = {}); total[product] = (total[product] || 0) + amount; }
    if (product) { const x = rateWindow(product, true); if (x) x.w.made = num(x.w.made, 0) + amount; }
    const first = use.first || (use.first = {});
    const key = roomName + ':' + product;
    if (product && first[key] == null) first[key] = Game.time;
}

function labUsedToday(type) {
    const use = typeof Memory !== 'undefined' ? Memory.labUse : null;
    if (!use || use.day !== labDay() || !use.used) return 0;
    return num(use.used[type], 0);
}

function factorySettings() {
    const f = (config.industry || {}).factory;
    return f && f.enabled ? f : null;
}

const haveCache = { time: -1, totals: {} };

function accountHave(resource) {
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (haveCache.time !== tick) { haveCache.time = tick; haveCache.totals = {}; }
    if (haveCache.totals[resource] != null) return haveCache.totals[resource];
    let total = 0;
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room || !room.controller || !room.controller.my) continue;
        for (const holder of [room.storage, room.terminal]) {
            if (holder && holder.my !== false && holder.store) total += used(holder.store, resource);
        }
        const typ = typeof STRUCTURE_FACTORY !== 'undefined' ? STRUCTURE_FACTORY : 'factory';
        for (const f of myStructures(room, typ)) total += used(f.store, resource);
    }
    haveCache.totals[resource] = total;
    return total;
}

function roomHave(room, resource) {
    let total = 0;
    for (const holder of [room.storage, room.terminal]) {
        if (holder && holder.my !== false && holder.store) total += used(holder.store, resource);
    }
    return total;
}

function factoryOf(room, cfg) {
    if (!room || !cfg || !Array.isArray(cfg.rooms) || cfg.rooms.indexOf(room.name) < 0) return null;
    const typ = typeof STRUCTURE_FACTORY !== 'undefined' ? STRUCTURE_FACTORY : 'factory';
    return myStructures(room, typ)[0] || null;
}

function factoryGate(room, cfg) {
    const batch = Number(cfg.batch) || 500;
    if (storageEnergy(room) < Number(cfg.minStorage || 0)) return { ok: false, why: 'storage' };
    if (accountHave(cfg.input) - batch < Number(cfg.keepAccount || 0)) return { ok: false, why: 'keepAccount' };
    if (accountHave(cfg.product) >= Number(cfg.stopAbove || Infinity)) return { ok: false, why: 'stopAbove' };
    return { ok: true };
}

function batteryHold(room) {
    const h = industryConfig().batteryHold;
    if (!h || !room.storage) return false;
    const m = roomMem(room);
    const e = storageEnergy(room);
    if (e > h.on) { if (!m.batteryHold) m.batteryHold = Game.time; } else if (e < h.off && m.batteryHold) delete m.batteryHold;
    return !!m.batteryHold;
}

function batteryRule(room) {
    const all = (config.industry || {}).batteryRooms;
    return room && all && all[room.name] ? all[room.name] : null;
}

function batteryFactory(room) {
    if (!batteryRule(room)) return null;
    if (factoryOf(room, factorySettings())) return null;
    const typ = typeof STRUCTURE_FACTORY !== 'undefined' ? STRUCTURE_FACTORY : 'factory';
    return myStructures(room, typ)[0] || null;
}

function batteryPlan(room) {
    const factory = batteryFactory(room);
    if (!factory) return null;
    const rule = batteryRule(room);
    const BATTERY = typeof RESOURCE_BATTERY !== 'undefined' ? RESOURCE_BATTERY : 'battery';
    const need = Number(rule.batch) || 50;
    const keep = Math.max(0, Number(rule.keep != null ? rule.keep : 20000));
    const wants = [];
    const drains = [];
    const inB = used(factory.store, BATTERY);
    const spare = roomHave(room, BATTERY) - keep;
    if (inB < need * 2 && spare > 0 && !batteryHold(room)) {
        const amount = Math.min((Number(rule.fill) || 1000) - inB, spare);
        if (amount > 0 && inB + amount >= need) wants.push({ labId: factory.id, mineral: BATTERY, amount });
    }
    const eOut = used(factory.store, RESOURCE_ENERGY);
    if (eOut > (Number(rule.drainEnergy) || 1000)) drains.push({ labId: factory.id, mineral: RESOURCE_ENERGY, amount: eOut });
    return { factory: factory.id, gate: { ok: false, why: 'battery' }, wants, drains, product: null, battery: true };
}

function runBatteryFactory(room, state, factory) {
    const BATTERY = typeof RESOURCE_BATTERY !== 'undefined' ? RESOURCE_BATTERY : 'battery';
    const rule = batteryRule(room);
    const need = Number(rule.batch) || 50;
    state.factory = { present: 1, configured: true, active: false, product: 'energy', gate: 'battery' };
    if (typeof factory.produce !== 'function') return;
    if (factory.cooldown > 0) { state.factory.cooldown = factory.cooldown; return; }
    if (batteryHold(room)) { state.factory.batteryHold = true; return; }
    if (used(factory.store, BATTERY) < need) { state.factory.batteryWait = true; return; }
    const ret = factory.produce(RESOURCE_ENERGY);
    state.factory.active = true;
    state.factory.resource = 'energy';
    state.factory.result = ret;
    state.factory.fromBattery = true;
    if (ret === OK) {
        const log = Memory.factoryLog || (Memory.factoryLog = {});
        const rec = log[room.name] || (log[room.name] = { made: 0, n: 0 });
        rec.battery = (Number(rec.battery) || 0) + need;
        rec.energy = (Number(rec.energy) || 0) + need * 10;
        rec.batteryLast = Game.time;
    }
}

function factoryPlan(room) {
    const cfg = factorySettings();
    const factory = factoryOf(room, cfg);
    if (!factory) return batteryPlan(room);
    const gate = factoryGate(room, cfg);
    const wants = [];
    const drains = [];
    const bars = used(factory.store, cfg.product);
    if (bars > 0 && (bars >= Number(cfg.drainAt || 500) || !gate.ok)) drains.push({ labId: factory.id, mineral: cfg.product, amount: bars });
    if (gate.ok) {
        const batch = Number(cfg.batch) || 500;
        const inF = used(factory.store, cfg.input);
        if (inF < batch) {
            const avail = roomHave(room, cfg.input) - Number(cfg.roomKeep || 0);
            const amount = Math.min(Number(cfg.fill || 2000) - inF, avail);
            if (amount > 0 && inF + amount >= batch) wants.push({ labId: factory.id, mineral: cfg.input, amount });
        }
        const eNeed = Number(cfg.energy) || 200;
        const eF = used(factory.store, RESOURCE_ENERGY);
        if (eF < eNeed) wants.push({ labId: factory.id, mineral: RESOURCE_ENERGY, amount: Number(cfg.energyFill || 1000) - eF });
    } else if ((cfg.battery || {}).enabled !== false) {
        const BATTERY = typeof RESOURCE_BATTERY !== 'undefined' ? RESOURCE_BATTERY : 'battery';
        const need = Number((cfg.battery || {}).batch) || 50;
        const inB = used(factory.store, BATTERY);
        if (inB < need && !batteryHold(room)) {
            const avail = roomHave(room, BATTERY);
            const amount = Math.min(Number((cfg.battery || {}).fill) || 1000, avail, need * 4 - inB);
            if (amount > 0) wants.push({ labId: factory.id, mineral: BATTERY, amount });
        }
        const eOut = used(factory.store, RESOURCE_ENERGY);
        if (eOut > (Number((cfg.battery || {}).drainEnergy) || 500)) drains.push({ labId: factory.id, mineral: RESOURCE_ENERGY, amount: eOut });
    }
    return { factory: factory.id, gate, wants, drains, product: gate.ok ? cfg.product : null };
}

function spillSettings() {
    return Object.assign({ enabled: true, above: 250000, until: 200000, resources: ['battery', 'energy'], storageFree: 50000 }, (config.industry || {}).terminalSpill || {});
}

function terminalSpill(room) {
    const cfg = spillSettings();
    const t = room && room.terminal;
    const s = room && room.storage;
    if (!cfg.enabled || !t || t.my === false || !t.store || typeof t.store.getUsedCapacity !== 'function') return null;
    if (!s || s.my === false || !s.store || typeof s.store.getFreeCapacity !== 'function') return null;
    const rooms = Memory.rooms || (Memory.rooms = {});
    const mem = rooms[room.name] || (rooms[room.name] = {});
    const usedT = Number(t.store.getUsedCapacity()) || 0;
    const on = usedT > cfg.above || (!!mem.terminalSpill && usedT > cfg.until);
    if (!on) { if (mem.terminalSpill) delete mem.terminalSpill; return null; }
    if (!mem.terminalSpill) mem.terminalSpill = { at: Game.time, used: usedT };
    if ((Number(s.store.getFreeCapacity()) || 0) < cfg.storageFree) return null;
    let res = null;
    let n = 0;
    for (const r of cfg.resources || []) {
        const v = Number(t.store[r]) || 0;
        if (v > n) { n = v; res = r; }
    }
    if (!res) return null;
    return { labId: t.id, mineral: res, amount: Math.min(n, usedT - cfg.until), partial: true, toStorage: true, spill: true };
}

function withSpill(plan, room) {
    let sp = null;
    try { sp = terminalSpill(room); } catch (e) { sp = null; }
    if (!sp) return plan;
    if (!plan) return { wants: [], drains: [sp], product: null };
    return Object.assign({}, plan, { drains: (plan.drains || []).concat([sp]) });
}

function techPlan(room) {
    return withSpill(techPlanBase(room), room);
}

function techPlanBase(room) {
    const fp = factoryPlan(room);
    const labRooms = (config.industry || {}).labRooms;
    const labsHere = !fp || !Array.isArray(labRooms) || labRooms.indexOf(room.name) >= 0 || boostOnlyRoom(room);
    let lp = null;
    if (labsHere) { try { lp = labPlan(room); } catch (error) { lp = null; } }
    if (!fp) return lp;
    if (!lp) return fp;
    return Object.assign({}, lp, { wants: (lp.wants || []).concat(fp.wants), drains: (lp.drains || []).concat(fp.drains), product: lp.product || fp.product, factory: fp.factory });
}

function noteFactory(room, cfg, amount) {
    const log = Memory.factoryLog || (Memory.factoryLog = {});
    const rec = log[room.name] || (log[room.name] = { made: 0, n: 0 });
    if (rec.first == null) rec.first = Game.time;
    rec.made += amount;
    rec.n++;
    rec.last = Game.time;
    rec.product = cfg.product;
}

function runOwnFactory(room, state, cfg) {
    const factory = factoryOf(room, cfg);
    const gate = factoryGate(room, cfg);
    state.factory = { present: 1, configured: true, active: false, product: cfg.product, gate: gate.ok ? 'ok' : gate.why };
    if (typeof factory.produce !== 'function') return;
    if (factory.cooldown > 0) { state.factory.cooldown = factory.cooldown; return; }
    if (gate.ok) {
        const batch = Number(cfg.batch) || 500;
        if (used(factory.store, cfg.input) < batch || used(factory.store, RESOURCE_ENERGY) < (Number(cfg.energy) || 200)) { state.factory.waiting = true; return; }
        const ret = factory.produce(cfg.product);
        state.factory.active = true;
        state.factory.resource = cfg.product;
        state.factory.result = ret;
        if (ret === OK) noteFactory(room, cfg, Number(cfg.output) || 100);
        return;
    }
    const bat = cfg.battery || {};
    if (bat.enabled === false) return;
    if (batteryHold(room)) { state.factory.batteryHold = true; return; }
    const BATTERY = typeof RESOURCE_BATTERY !== 'undefined' ? RESOURCE_BATTERY : 'battery';
    const need = Number(bat.batch) || 50;
    if (used(factory.store, BATTERY) < need) {
        const avail = roomHave(room, BATTERY);
        if (avail >= need) { }
        else return;
    }
    if (used(factory.store, BATTERY) < need) { state.factory.batteryWait = true; return; }
    const ret = factory.produce(RESOURCE_ENERGY);
    state.factory.active = true;
    state.factory.resource = 'energy';
    state.factory.result = ret;
    state.factory.fromBattery = true;
}

function runFactory(room, mem, state, spendAllowed) {
    const fcfg = factorySettings();
    if (factoryOf(room, fcfg)) return runOwnFactory(room, state, fcfg);
    const bf = batteryFactory(room);
    if (bf) return runBatteryFactory(room, state, bf);
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

module.exports = { batteryHold, terminalSpill, spillSettings, batteryRule, batteryFactory, batteryPlan, runBatteryFactory, makeIn, factoryPlan, factoryGate, techPlan, accountHave, boostOnlyRoom, labUsedToday, noteLabUse, boostWaiting, run, deriveReaction, canSpend, labsAllowed, labPlan, labRoles, mineralStock, pickPair, nextReactionFor, wantedTarget, reverseReactions, labTriple, BASE_MINERALS, heldProducts, rateHeld, stockGoals };
