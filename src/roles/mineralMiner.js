'use strict';
/** External mineral plan executor. No room scans, body search or pathfinding. */
const brain = require('brain');

function directive(room) {
    const plan = room && brain.get(room.name, 'mineral', null);
    return plan && plan.version === 1 ? plan : null;
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
function ready(room, plan) {
    if (!room || !room.controller || !room.controller.my || room.controller.level < 6 || !plan || !plan.enabled) return false;
    const mineral = object(plan.mineralId);
    const extractor = object(plan.extractorId);
    if (!mineral || mineral.mineralAmount <= 0 || !active(extractor)) return false;
    const sinks = destinations(plan);
    return stock(plan, sinks) < plan.maxStock && sinks.some(({ target }) => target.store.getFreeCapacity() > plan.reserveFree);
}
function move(creep, path, revision) {
    if (creep.fatigue) return;
    const direction = path && path[creep.pos.x + creep.pos.y * 50];
    if (Number.isInteger(direction) && direction >= 1 && direction <= 8) {
        const previous = creep.memory.mineralMove;
        const key = creep.pos.x + creep.pos.y * 50;
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
    } else {
        // The next brain pass includes this creep's actual position in its routes.
        creep.memory.mineralRouteMiss = Game.time;
    }
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
    else move(creep, entry.path, plan.at);
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
    // Do not overflow the creep and strand minerals on a container / the floor.
    if (load && (creep.memory.mineralDelivering || !canMine || ending || creep.store.getFreeCapacity() < work)) {
        creep.memory.mineralDelivering = true;
        const sink = sinks.find(({ target }) => target.store.getFreeCapacity() > 0);
        if (!sink) return; // Preserve cargo while storage is full or being rebuilt.
        const type = Object.keys(creep.store).find((key) => creep.store[key] > 0);
        const before = creep.store[type];
        const code = creep.transfer(sink.target, type);
        if (code === ERR_NOT_IN_RANGE) move(creep, sink.entry.path, plan.at);
        else if (code === OK) creep.memory.mineralIntent = { tick: Game.time, type, before, action: 'transfer' };
        return;
    }
    if (!canMine || !work) return;
    if (!plan.stand || creep.pos.x !== plan.stand.x || creep.pos.y !== plan.stand.y || creep.pos.roomName !== room.name) {
        move(creep, plan.outbound, plan.at);
        return;
    }
    if (!creep.pos.isNearTo(mineral)) return;
    const extractor = object(plan.extractorId);
    if (extractor.cooldown > 0) return;
    const type = plan.mineralType;
    const before = creep.store[type] || 0;
    if (creep.harvest(mineral) === OK) creep.memory.mineralIntent = { tick: Game.time, type, before, action: 'harvest' };
}
module.exports = { run, directive, ready, mineralOf };
