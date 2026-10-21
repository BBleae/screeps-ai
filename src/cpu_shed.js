'use strict';
const config = require('config');
const utils = require('utils');
const taskBroker = require('task_broker');

const runtimeGlobal = typeof global !== 'undefined' ? global : {};
const runtime = runtimeGlobal.__cpuShedRuntime || (runtimeGlobal.__cpuShedRuntime = {
    streak: {},
    win: null,
});

function settings() {
    return config.cpuShed || {};
}

function emptyWindow() {
    return { ticks: 0, low: 0, crit: 0, forced: 0, skip: 0, roles: {}, hard: 0, cut: 0, hardEnd: 0 };
}

function hardStopLine(cpu, force, time) {
    if (force && Number(force.stopUntil) > time && force.stop !== null && force.stop !== undefined && Number.isFinite(Number(force.stop))) return Number(force.stop);
    const tickLimit = cpu && cpu.tickLimit;
    if (typeof tickLimit !== 'number' || !Number.isFinite(tickLimit)) return null;
    return tickLimit - (Number(settings().endReserve) || 0);
}

function modeFor(cpu, force, time) {
    const cfg = settings();
    if (force && Number(force.until) > time && (force.mode === 'low' || force.mode === 'critical')) return force.mode;
    const bucket = cpu && cpu.bucket;
    if (typeof bucket !== 'number') return 'normal';
    if (bucket < Number(cfg.criticalBucket)) return 'critical';
    if (bucket < Number(cfg.lowBucket)) return 'low';
    return 'normal';
}

function creepCap(cpu, mode, force, time) {
    const cfg = settings();
    const limit = Number(cpu && cpu.limit) || 0;
    if (mode === 'normal') return limit - (Number(config.cpuReserve) || 0);
    if (force && Number(force.until) > time && Number.isFinite(Number(force.cap)) && force.cap !== null) return Number(force.cap);
    return limit - (Number(mode === 'critical' ? cfg.criticalReserve : cfg.lowReserve) || 0);
}

function begin() {
    const cpu = typeof Game !== 'undefined' ? Game.cpu : null;
    const force = typeof Memory !== 'undefined' && Memory ? Memory.cpuShedForce : null;
    const forced = !!(force && Number(force.until) > Game.time);
    if (force && !forced && typeof Memory !== 'undefined') delete Memory.cpuShedForce;
    const mode = modeFor(cpu, forced ? force : null, Game.time);
    const ctx = { mode, active: mode !== 'normal', cap: creepCap(cpu, mode, forced ? force : null, Game.time), rank: {}, haulers: {} };
    ctx.hardStop = hardStopLine(cpu, forced ? force : null, Game.time);
    const used = cpu && typeof cpu.getUsed === 'function' ? Number(cpu.getUsed()) || 0 : 0;
    ctx.armed = ctx.hardStop !== null && ctx.hardStop - used < (Number(settings().hardStopArm) || 0);
    ctx.stopped = false;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.ticks++;
    if (mode === 'low') win.low++;
    if (mode === 'critical') win.crit++;
    if (forced) win.forced++;
    if (Game.time % 100 === 0) {
        for (const name of Object.keys(runtime.streak)) {
            if (!(runtime.streak[name].t >= Game.time - 5)) delete runtime.streak[name];
        }
    }
    return ctx;
}

function storeUsed(creep) {
    const store = creep && creep.store;
    if (!store) return 0;
    if (typeof store.getUsedCapacity === 'function') return Number(store.getUsedCapacity()) || 0;
    return Number(store[typeof RESOURCE_ENERGY === 'undefined' ? 'energy' : RESOURCE_ENERGY]) || 0;
}

function reservationComfortable(creep) {
    const remoteRoom = creep.memory && creep.memory.remoteRoom;
    if (!remoteRoom || !creep.room || creep.room.name !== remoteRoom) return false;
    const reservation = creep.room.controller && creep.room.controller.reservation;
    if (!reservation) return false;
    if (creep.owner && creep.owner.username && reservation.username !== creep.owner.username) return false;
    return Number(reservation.ticksToEnd) >= Number(settings().reserverComfort);
}

function onClaimDuty(creep) {
    const mem = typeof Memory !== 'undefined' && Memory.rooms && Memory.rooms[creep.memory.home];
    const target = mem && mem.expansion && mem.expansion.target;
    return !!target && target === creep.memory.remoteRoom;
}

function shedRank(creep, mode) {
    const memory = creep && creep.memory;
    const role = memory && memory.role;
    if (!role) return null;
    const critical = mode === 'critical';
    if (role === 'warrior') return null;
    switch (role) {
    case 'scout':
        return 0;
    case 'reserver':
        if (onClaimDuty(creep)) return null;
        if (reservationComfortable(creep)) return 0;
        return critical && creep.room && creep.room.name !== memory.remoteRoom ? 2 : null;
    case 'operator':
    case 'mineralMiner':
    case 'labTech':
        return 1;
    case 'remoteHauler':
        if (storeUsed(creep) > 0) return null;
        if (taskBroker.wasIdle(creep)) return 1;
        return critical ? 2 : null;
    case 'hauler':
    case 'builder':
    case 'courier':
    case 'feeder':
        return taskBroker.wasIdle(creep) ? 1 : null;
    default:
        return null;
    }
}

function arrange(queue, ctx) {
    if (!ctx || !ctx.active) return queue;
    const keep = [];
    const tiers = [[], [], []];
    for (const creep of queue || []) {
        const memory = creep && creep.memory;
        if (memory && memory.role === 'hauler' && !creep.spawning && !utils.isRetiring(memory) && memory.home) {
            ctx.haulers[memory.home] = (ctx.haulers[memory.home] || 0) + 1;
        }
        const rank = creep && !creep.spawning ? shedRank(creep, ctx.mode) : null;
        if (rank == null) { keep.push(creep); continue; }
        ctx.rank[creep.name] = rank;
        tiers[rank].push(creep);
    }
    return keep.concat(tiers[2], tiers[1], tiers[0]);
}

function mayShed(creep, ctx) {
    if (!ctx || !ctx.active || !creep || ctx.rank[creep.name] == null) return false;
    const streak = runtime.streak[creep.name];
    const max = Number(settings().maxConsecutive) || 0;
    if (streak && streak.t === Game.time - 1 && streak.n >= max) return false;
    const memory = creep.memory || {};
    if (memory.role === 'hauler' && !((ctx.haulers[memory.home] || 0) > 1)) return false;
    return true;
}

function noteSkip(creep, ctx) {
    const memory = creep.memory || {};
    const streak = runtime.streak[creep.name];
    runtime.streak[creep.name] = { n: streak && streak.t === Game.time - 1 ? streak.n + 1 : 1, t: Game.time };
    if (memory.role === 'hauler' && ctx && memory.home) ctx.haulers[memory.home] = (ctx.haulers[memory.home] || 0) - 1;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.skip++;
    win.roles[memory.role || '?'] = (win.roles[memory.role || '?'] || 0) + 1;
}

function hardStopNow(ctx) {
    if (!ctx || !ctx.armed || ctx.stopped) return !!(ctx && ctx.stopped);
    return Game.cpu.getUsed() > ctx.hardStop;
}

function noteHardStop(ctx, cut) {
    if (!ctx) return;
    ctx.stopped = true;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.hard++;
    win.cut += cut;
    if (typeof Memory !== 'undefined' && Memory) {
        const log = Memory.cpuHardStop || (Memory.cpuHardStop = { n: 0 });
        log.n = (Number(log.n) || 0) + 1;
        log.at = Game.time;
        log.cut = cut;
        log.line = Math.round(ctx.hardStop * 10) / 10;
    }
}

function noteHardStopEnd(ctx) {
    if (!ctx || !ctx.stopped) return;
    const win = runtime.win || (runtime.win = emptyWindow());
    win.hardEnd++;
}

function digest() {
    const win = runtime.win || emptyWindow();
    runtime.win = emptyWindow();
    return { ticks: win.ticks, low: win.low, crit: win.crit, forced: win.forced, skip: win.skip, roles: win.roles,
        hard: win.hard, cut: win.cut, hardEnd: win.hardEnd };
}

module.exports = { begin, arrange, mayShed, noteSkip, digest, shedRank, modeFor, creepCap, hardStopLine, hardStopNow, noteHardStop, noteHardStopEnd };
