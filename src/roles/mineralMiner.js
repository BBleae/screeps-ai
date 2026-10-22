'use strict';
const movement = require('movement');

const forcedCache = { tick: -1, byRoom: {} };
function forced(room, plan) {
    const force = ((require('config').minerals) || {}).force;
    const mode = force && force[room.name];
    if (mode === false) return plan.enabled || plan.count ? Object.assign({}, plan, { enabled: false, count: 0, reason: 'forcedOff' }) : plan;
    if (mode && typeof mode === 'object' && mode.accountBelow != null) {
        let have = 0;
        try { have = require('market').accountStock(plan.mineralType); } catch (e) { have = 0; }
        if (!(have < Number(mode.accountBelow))) return Object.assign({}, plan, { enabled: false, count: 0, reason: 'accountStock' });
    }
    if (mode === 'drain' && drained(room, plan)) return plan.enabled || plan.count ? Object.assign({}, plan, { enabled: false, count: 0, reason: 'drained' }) : plan;
    if (!mode || plan.enabled) return plan;
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (forcedCache.tick !== tick) { forcedCache.tick = tick; forcedCache.byRoom = {}; }
    const hit = forcedCache.byRoom[room.name];
    if (hit && hit.src === plan) return hit.plan;
    const out = Object.assign({}, plan, { enabled: true, count: 1, reason: 'forced' });
    forcedCache.byRoom[room.name] = { src: plan, plan: out };
    return out;
}
function drained(room, plan) {
    const mem = Memory.mineralDrained || (Memory.mineralDrained = {});
    if (mem[room.name]) return true;
    const mineral = plan && plan.mineralId ? Game.getObjectById(plan.mineralId) : null;
    if (mineral && !(mineral.mineralAmount > 0)) { mem[room.name] = Game.time; return true; }
    return false;
}
const configCache = { tick: -1, byRoom: {} };
function configPlan(room) {
    const rooms = ((require('config').minerals) || {}).rooms;
    const c = room && rooms && rooms[room.name];
    if (!c || !c.mineralId) return null;
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (configCache.tick !== tick) { configCache.tick = tick; configCache.byRoom = {}; }
    if (configCache.byRoom[room.name]) return configCache.byRoom[room.name];
    const plan = {
        version: 1, enabled: false, count: 0, reason: 'config', source: 'config', at: 'config',
        mineralId: c.mineralId, mineralType: c.mineralType, extractorId: c.extractorId,
        pos: c.pos, stand: c.stand, build: c.build !== false,
        sinks: (c.sinks || []).map((id) => ({ id })),
        recycle: c.recycle ? { id: c.recycle } : null,
        body: c.body, returnTicks: c.returnTicks, reserveFree: c.reserveFree, maxStock: c.maxStock,
    };
    configCache.byRoom[room.name] = plan;
    return plan;
}
function frozenPlan(room) {
    const plans = ((require('config').minerals) || {}).plans;
    const plan = room && plans && plans[room.name];
    return plan && plan.version === 1 ? plan : null;
}
const factPlanCache = { tick: -1, by: {} };
function basePlan(room) {
    const plan = configPlan(room) || frozenPlan(room);
    if (!plan || !room) return plan;
    const tick = typeof Game !== 'undefined' ? Game.time : 0;
    if (factPlanCache.tick !== tick) { factPlanCache.tick = tick; factPlanCache.by = {}; }
    const hit = factPlanCache.by[room.name];
    if (hit && hit.src === plan) return hit.plan;
    let out = plan;
    try { out = require('facts').withMineral(room.name, plan); } catch (e) { out = plan; }
    factPlanCache.by[room.name] = { src: plan, plan: out };
    return out;
}
function directive(room) {
    const plan = basePlan(room);
    return plan ? forced(room, plan) : null;
}
function object(id) { return id ? Game.getObjectById(id) : null; }
function active(structure) {
    return structure && structure.my && (!structure.isActive || structure.isActive());
}
function mineralOf(room) {
    const plan = directive(room);
    return object(plan && plan.mineralId);
}
function destinations(plan) {
    return (plan.sinks || []).map((entry) => ({ entry, target: object(entry.id) }))
        .filter(({ target }) => active(target) && target.store);
}
function stock(plan, sinks) {
    return sinks.reduce((sum, item) => sum + (item.target.store[plan.mineralType] || 0), 0);
}
function headroom(room, plan) {
    if (!room || !room.controller || !room.controller.my || room.controller.level < 6 || !plan || !plan.enabled) return null;
    const mineral = object(plan.mineralId);
    const extractor = object(plan.extractorId);
    if (!mineral || mineral.mineralAmount <= 0 || !active(extractor)) return null;
    const sinks = destinations(plan);
    if (!sinks.some(({ target }) => target.store.getFreeCapacity() > plan.reserveFree)) return null;
    const cap = Number((((require('config').minerals) || {}).maxStock || {})[room.name]);
    return { left: (cap > 0 ? cap : plan.maxStock) - stock(plan, sinks), mineral };
}
function finishable(space, plan) {
    return space.mineral.mineralAmount <= lifetimeYield(plan);
}
function ready(room, plan) {
    const space = headroom(room, plan);
    return !!space && (space.left > 0 || finishable(space, plan));
}
function lifetimeYield(plan) {
    const work = (plan.body || []).filter((part) => part === 'work').length;
    const cooldown = typeof EXTRACTOR_COOLDOWN === 'number' ? EXTRACTOR_COOLDOWN : 5;
    const life = typeof CREEP_LIFE_TIME === 'number' ? CREEP_LIFE_TIME : 1500;
    return Math.floor(work * Math.max(0, life - 2 * (Number(plan.returnTicks) || 0)) / (cooldown + 1));
}
function spawnReady(room, plan) {
    const space = headroom(room, plan);
    if (!space) return false;
    if (finishable(space, plan)) return true;
    return space.left >= lifetimeYield(plan);
}
function move(creep, path, revision, target, range) {
    if (creep.fatigue) return;
    const key = creep.pos.x + creep.pos.y * 50;
    const direction = path && path[key];
    if (!Number.isInteger(direction) || direction < 1 || direction > 8) {
        if (path) creep.memory.mineralRouteMiss = Game.time;
        if (target) movement.go(creep, target, { range: range || 0, reusePath: 20 });
        return;
    }
    const previous = creep.memory.mineralMove;
    const attempts = previous && previous.key === key && previous.revision === revision ? previous.attempts + 1 : 1;
    creep.memory.mineralMove = { key, revision, attempts };
    if (attempts > 3) {
        const dx = [0, 0, 1, 1, 1, 0, -1, -1, -1][direction];
        const dy = [0, -1, -1, 0, 1, 1, 1, 0, -1][direction];
        creep.memory.mineralBlocked = { x: creep.pos.x + dx, y: creep.pos.y + dy };
        creep.memory.mineralRouteMiss = Game.time;
        return;
    }
    if (!previous || previous.key !== key) delete creep.memory.mineralBlocked;
    creep.move(direction);
}
function record(creep, key, amount) {
    const mem = Memory.rooms[creep.memory.home];
    const stats = mem.mineralStats || (mem.mineralStats = {});
    stats[key] = (stats[key] || 0) + amount;
}
function settle(creep) {
    const pending = creep.memory.mineralIntent;
    if (!pending || pending.tick >= Game.time) return;
    const amount = creep.store[pending.type] || 0;
    const change = pending.action === 'harvest' ? amount - pending.before : pending.before - amount;
    if (change > 0) record(creep, pending.action === 'harvest' ? 'harvested' : 'delivered', change);
    delete creep.memory.mineralIntent;
}
function recycle(creep, plan) {
    creep.memory.retired = true;
    const entry = plan.recycle;
    const spawn = object(entry && entry.id);
    if (!active(spawn)) return;
    if (creep.pos.isNearTo(spawn)) spawn.recycleCreep(creep);
    else move(creep, entry.path, plan.at, spawn, 1);
}
function run(creep) {
    const room = Game.rooms[creep.memory.home];
    if (!room || creep.pos.roomName !== room.name) return;
    settle(creep);
    const plan = directive(room);
    if (!plan) return;
    const load = creep.store.getUsedCapacity();
    const mineral = object(plan.mineralId);
    const sinks = destinations(plan);
    const canMine = ready(room, plan);
    const ending = creep.memory.retired || (creep.ticksToLive != null && creep.ticksToLive <= (plan.returnTicks || 100));
    if (!load) {
        delete creep.memory.mineralDelivering;
        if (!canMine || ending) { recycle(creep, plan); return; }
    }
    const work = creep.getActiveBodyparts(WORK);
    if (load && (creep.memory.mineralDelivering || !canMine || ending || creep.store.getFreeCapacity() < work)) {
        creep.memory.mineralDelivering = true;
        const sink = sinks.find(({ target }) => target.store.getFreeCapacity() > 0);
        if (!sink) return;
        const type = Object.keys(creep.store).find((key) => creep.store[key] > 0);
        const before = creep.store[type];
        const code = creep.transfer(sink.target, type);
        if (code === ERR_NOT_IN_RANGE) move(creep, sink.entry.path, plan.at, sink.target, 1);
        else if (code === OK) creep.memory.mineralIntent = { tick: Game.time, type, before, action: 'transfer' };
        return;
    }
    if (!canMine || !work) return;
    if (!plan.stand || creep.pos.x !== plan.stand.x || creep.pos.y !== plan.stand.y || creep.pos.roomName !== room.name) {
        move(creep, plan.outbound, plan.at, new RoomPosition(plan.stand.x, plan.stand.y, room.name), 0);
        return;
    }
    if (!creep.pos.isNearTo(mineral)) return;
    const extractor = object(plan.extractorId);
    if (extractor.cooldown > 0) return;
    const type = plan.mineralType;
    const before = creep.store[type] || 0;
    if (creep.harvest(mineral) === OK) creep.memory.mineralIntent = { tick: Game.time, type, before, action: 'harvest' };
}
module.exports = { run, directive, ready, spawnReady, mineralOf, forced, drained, configPlan, frozenPlan, basePlan };
